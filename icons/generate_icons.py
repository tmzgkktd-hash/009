#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VoiceType 图标生成器（零依赖）

不依赖 Pillow / cairosvg，自己用 zlib + struct 写 PNG。
用 2 倍超采样 + SDF（有向距离场）做抗锯齿，效果接近矢量渲染。

输出：
  icon-192.png            PWA 标准图标
  icon-512.png            PWA 大图标 / 商店素材
  icon-180.png            iOS apple-touch-icon
  icon-maskable-512.png   Android 自适应图标（内容缩到安全区）
"""

import math
import os
import struct
import zlib

OUT = os.path.dirname(os.path.abspath(__file__))

# 主题渐变：#4F46E5 → #9333EA
C0 = (0x4F, 0x46, 0xE5)
C1 = (0x93, 0x33, 0xEA)
WHITE = (255, 255, 255)


# ---------------------------------------------------------------- PNG 编码
def write_png(path: str, w: int, h: int, buf: bytearray) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)                                  # filter type 0
        raw += buf[y * stride:(y + 1) * stride]

    out = b"\x89PNG\r\n\x1a\n"
    out += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    out += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    out += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(out)


# ---------------------------------------------------------------- 渲染
def render(size: int, ss: int = 2, maskable: bool = False) -> bytearray:
    W = size * ss
    buf = bytearray(W * W * 4)

    # --- 背景：圆角方块，铺满整个画布 ---
    # maskable 版本用直角（由系统套遮罩），普通版本用大圆角
    radius = 0.0 if maskable else 0.2226 * W
    r_in = max(radius - 1.0, 0.0)

    for y in range(W):
        row = y * W * 4
        for x in range(W):
            # 圆角判定（角落才需要真的算 SDF）
            inside = True
            if radius > 0:
                dx = abs(x + 0.5 - W / 2) - (W / 2 - r_in)
                dy = abs(y + 0.5 - W / 2) - (W / 2 - r_in)
                if dx > 0 and dy > 0:
                    inside = math.hypot(dx, dy) <= r_in

            i = row + x * 4
            if not inside:
                continue                                # 保持全透明

            t = (x + y) / (2.0 * W)
            buf[i]     = int(C0[0] + (C1[0] - C0[0]) * t)
            buf[i + 1] = int(C0[1] + (C1[1] - C0[1]) * t)
            buf[i + 2] = int(C0[2] + (C1[2] - C0[2]) * t)
            buf[i + 3] = 255

    # --- 前景：白色麦克风 ---
    k = 0.70 if maskable else 1.0                      # maskable 内容缩小进安全区
    GS = 1.16                                          # 整组放大系数
    kk = k * GS

    def S(v: float) -> float:                          # 归一化坐标 → 像素
        return ((v - 0.5) * kk + 0.5) * W

    # 话筒头：竖向胶囊
    cap_cx, cap_cy = S(0.5), S(0.405)
    cap_hw, cap_hh = 0.0775 * W * kk, 0.150 * W * kk
    cap_b = cap_hh - cap_hw

    # 下方圆弧：以 (0.5, 0.50) 为心，R = 0.155，线宽 0.033
    arc_cx, arc_cy = S(0.5), S(0.500)
    arc_R, arc_t = 0.155 * W * kk, 0.0165 * W * kk

    # 支柱
    st_cx = S(0.5)
    st_y0, st_y1 = S(0.655), S(0.755)
    st_hw = 0.0165 * W * kk

    # 只遍历麦克风外接盒，省掉 90% 的像素
    x0 = max(0, int(S(0.5) - 0.24 * W * kk) - 2)
    x1 = min(W, int(S(0.5) + 0.24 * W * kk) + 2)
    y0 = max(0, int(S(0.405) - 0.22 * W * kk) - 2)
    y1 = min(W, int(S(0.755)) + 4)

    hypot = math.hypot
    for y in range(y0, y1):
        row = y * W * 4
        py = y + 0.5
        for x in range(x0, x1):
            px = x + 0.5
            hit = False

            # 胶囊（标准圆角盒 SDF，半径取半宽 → 两端为半圆）
            if not hit:
                qx = abs(px - cap_cx)
                qy = abs(py - cap_cy) - cap_b
                ox = qx if qx > 0.0 else 0.0
                oy = qy if qy > 0.0 else 0.0
                m = qx if qx > qy else qy
                d = hypot(ox, oy) + (m if m < 0.0 else 0.0) - cap_hw
                if d <= 0:
                    hit = True

            # 圆弧（只保留下半部分）
            if not hit and py >= arc_cy:
                d = abs(hypot(px - arc_cx, py - arc_cy) - arc_R) - arc_t
                if d <= 0:
                    hit = True

            # 支柱
            if not hit and st_y0 - st_hw <= py <= st_y1 + st_hw:
                if abs(px - st_cx) <= st_hw:
                    hit = True

            if hit:
                i = row + x * 4
                buf[i]     = WHITE[0]
                buf[i + 1] = WHITE[1]
                buf[i + 2] = WHITE[2]
                buf[i + 3] = 255

    # --- 超采样降采样 ---
    if ss == 1:
        return buf

    OW = size
    out = bytearray(OW * OW * 4)
    inv = 1.0 / (ss * ss)
    for oy in range(OW):
        orow = oy * OW * 4
        for ox in range(OW):
            r = g = b = a = 0
            for sy in range(ss):
                srow = ((oy * ss + sy) * W + ox * ss) * 4
                for sx in range(ss):
                    j = srow + sx * 4
                    av = buf[j + 3]
                    r += buf[j] * av
                    g += buf[j + 1] * av
                    b += buf[j + 2] * av
                    a += av
            oi = orow + ox * 4
            if a == 0:
                continue
            out[oi]     = min(255, int(r / a))
            out[oi + 1] = min(255, int(g / a))
            out[oi + 2] = min(255, int(b / a))
            out[oi + 3] = int(a * inv)
    return out


def main() -> None:
    jobs = [
        ("icon-192.png", 192, 2, False),
        ("icon-512.png", 512, 2, False),
        ("icon-180.png", 180, 2, False),
        ("icon-maskable-512.png", 512, 2, True),
        # 1024 是桌面端打包（Tauri icon / macOS .icns / Windows .ico）的源图。
        # 之前最大只有 512，Tauri 会把 512 放大到 1024 去填 .icns 的大尺寸槽位，
        # 在 Retina 的 Dock 和 Finder 预览里能看出边缘发虚。
        # 这里直接用矢量级渲染出真 1024，就没有放大的问题。
        ("icon-1024.png", 1024, 2, False),
    ]
    for name, size, ss, maskable in jobs:
        path = os.path.join(OUT, name)
        buf = render(size, ss, maskable)
        write_png(path, size, size, buf)
        print(f"  ✓ {name:26s} {size}x{size}  {os.path.getsize(path):>7,d} bytes")


if __name__ == "__main__":
    print("生成 音转文 图标…")
    main()
    print("完成。")
