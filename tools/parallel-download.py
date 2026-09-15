#!/usr/bin/env python3
"""
多连接分片下载器 —— 专为「音转文」的 540MB 模型准备。

为什么要自己写，不直接用 curl：
    huggingface 的 CDN 对单连接限速在 180~380 KB/s，
    但把连接数提到 6 条，合计能到约 1~1.7 MB/s，快 4 倍以上。
    540MB 按单连接要 50 分钟，多连接 10 分钟左右。
    这种"每连接限速、总量不限"的链路，唯一的办法就是多开连接。

设计上踩过的三个坑，对应的三条措施：

  1) 服务器会忽略 Range。
     HuggingFace 的 CDN 偶尔回 200 + 整份文件。如果先 read() 再检查长度，
     就会老老实实把 369MB 全下完才发现不对 —— 每次重试白烧二十分钟，
     表现为卡在最后一个分片再也不动。
     → 先看状态码，拿到 200 且我们只要其中一片时立刻断开，一个字节都不读。

  2) 不能靠"删分片文件"来收尾。
     早期版本把每片写成 <文件>.part.<序号>，最后逐个删掉。
     但运行环境对批量删除有保护（同一轮里删够一定数量就拦），
     于是清理阶段抛异常，整个下载被判定为失败 —— 文件其实已经下好了。
     → 改成直接按偏移量写进同一个输出文件（每个线程各开一个句柄 seek+write），
       只在旁边维护一个几百字节的 .progress 记录哪些片已完成。
       全程只删一个文件，而且是尽力而为，删不掉也不影响结果。

  3) 体积对得上不代表内容对。
     → 拼装完必须校验 SHA-256，期望值取自 HuggingFace 的 LFS oid。
       不符就把输出文件作废重来，绝不留下"看着像、其实是坏的"文件。

只用标准库（urllib），不依赖任何第三方包。

用法：
    python3 tools/parallel-download.py <URL> <输出路径> <总字节数> [SHA256] [连接数]
"""

import hashlib
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

CHUNK = 16 * 1024 * 1024        # 每个分片 16MB
RETRIES = 6
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) yzw-fetch/1.0'


def log(msg):
    print(msg, flush=True)


def fetch_range(url, start, end, total, timeout=120):
    """取 [start, end] 闭区间的字节。返回 bytes；失败抛异常。

    关键：**先看状态码，再决定要不要读 body。**
    服务器忽略 Range 时回 200，这时如果我们只要其中一片，
    读下去就是白下整份文件，必须立刻断开。
    """
    req = urllib.request.Request(url, headers={
        'Range': f'bytes={start}-{end}',
        'User-Agent': UA,
        'Accept-Encoding': 'identity',     # 必须关掉压缩，否则 Range 语义会被打乱
    })
    want = end - start + 1

    with urllib.request.urlopen(req, timeout=timeout) as resp:
        status = resp.status
        if status == 200:
            # 只有本来就要整份文件时才接受 200
            if want != total:
                raise RuntimeError(
                    f'服务器忽略了 Range（回 200 全量），立刻断开以免白下 {total // 1048576}MB'
                )
        elif status != 206:
            raise RuntimeError(f'HTTP {status}')
        data = resp.read()

    if len(data) != want:
        raise RuntimeError(f'分片长度不符：{len(data)} != {want}')
    return data


def plan_chunks(total):
    parts = []
    i = 0
    s = 0
    while s < total:
        e = min(s + CHUNK - 1, total - 1)
        parts.append((i, s, e))
        s = e + 1
        i += 1
    return parts


def load_progress(path, total):
    """读进度。文件不存在、解析失败、或体积对不上，都当作从头开始。"""
    try:
        with open(path, encoding='utf-8') as f:
            d = json.load(f)
        if d.get('total') == total and os.path.exists(d.get('out', '')):
            return set(d.get('done', []))
    except Exception:                       # noqa: BLE001
        pass
    return None


def save_progress(path, out, total, done):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump({'out': out, 'total': total, 'done': sorted(done)}, f)
    os.replace(tmp, path)


def download(url, out, total, expect_sha=None, workers=6):
    parts = plan_chunks(total)
    prog_path = out + '.progress'

    done = load_progress(prog_path, total)
    if done is None:
        # 从头来：建一个正好 total 字节的空文件
        os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
        with open(out, 'wb') as f:
            f.truncate(total)
        done = set()
    else:
        log(f'  续传：已有 {len(done)}/{len(parts)} 片')

    lock = threading.Lock()
    failed = []

    def work(item):
        idx, s, e = item
        if idx in done:
            return
        want = e - s + 1
        last_err = None

        for attempt in range(1, RETRIES + 1):
            try:
                data = fetch_range(url, s, e, total)
                # 每个线程各开自己的句柄，seek 到偏移量再写。
                # 不同分片写不同区间，互不干扰。
                with open(out, 'r+b') as f:
                    f.seek(s)
                    f.write(data)
                with lock:
                    done.add(idx)
                    save_progress(prog_path, out, total, done)
                    got = len(done) * CHUNK
                    pct = min(100.0, got * 100.0 / total)
                    log(f'  [{pct:5.1f}%] {len(done):>3}/{len(parts)} 片  '
                        f'≈{min(got, total) / 1048576:7.1f} / {total / 1048576:.1f} MB')
                return
            except Exception as ex:          # noqa: BLE001 —— 网络异常种类太多，统一重试
                last_err = ex
                if attempt < RETRIES:
                    log(f'    第 {idx} 片第 {attempt} 次失败：{ex}')
                    time.sleep(min(2 ** attempt, 15))

        with lock:
            failed.append((idx, last_err))

    queue = list(parts)
    qlock = threading.Lock()

    def worker():
        while True:
            with qlock:
                if not queue:
                    return
                item = queue.pop(0)
            work(item)

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    if failed:
        raise RuntimeError(f'{len(failed)} 个分片下载失败，例如第 {failed[0][0]} 片：{failed[0][1]}')

    got = os.path.getsize(out)
    if got != total:
        raise RuntimeError(f'体积不符：{got} != {total}')

    if expect_sha:
        log('  校验 SHA-256…')
        h = hashlib.sha256()
        with open(out, 'rb') as f:
            for block in iter(lambda: f.read(8 * 1024 * 1024), b''):
                h.update(block)
        actual = h.hexdigest()
        if actual != expect_sha:
            # 内容不对就整份作废，别让坏文件流到后面去
            try:
                os.remove(out)
            except Exception:
                pass
            raise RuntimeError(f'SHA-256 不符\n    期望 {expect_sha}\n    实际 {actual}')
        log('  SHA-256 通过')

    # 收尾：只删一个几百字节的进度文件。
    #
    # ⚠️ 这里必须 catch Exception 而不是 OSError。
    # 某些受管环境会把 os.remove 换成带删除配额保护的实现，超限时抛的是
    # 自定义异常（形如 SAFE_DELETE_BULK_CONFIRM_REQUIRED），不是 OSError。
    # 只写 OSError 的话，一个**已经完全下载并校验通过**的文件会被误报成失败，
    # 而且异常发生在校验之后，看起来像是内容有问题，非常难查。
    # 进度文件删不掉没有任何后果：它只有几百字节，而且同步脚本会把它排除掉。
    try:
        os.remove(prog_path)
    except Exception:
        pass


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(2)
    url = sys.argv[1]
    out = sys.argv[2]
    total = int(sys.argv[3])
    sha = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] not in ('', '-') else None
    workers = int(sys.argv[5]) if len(sys.argv) > 5 else 6

    log(f'下载 {os.path.basename(out)}（{total / 1048576:.1f} MB）')
    download(url, out, total, sha, workers)
    log(f'  ✓ 完成 {os.path.basename(out)}')


if __name__ == '__main__':
    main()
