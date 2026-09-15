// 把 transformers.js 运行时与 onnxruntime 的 WASM 收集成可离线加载的本地文件。
//
// 产出（voicetype/vendor/）：
//   transformers.js         @huggingface/transformers 的浏览器构建，已把
//                           onnxruntime-common / onnxruntime-web 等裸依赖打平
//   ort/*.wasm  ort/*.mjs   onnxruntime 的 wasm 内核与加载器
//
// 为什么要自己打：
//   官方 dist/transformers.web.min.js 里留着裸模块说明符（onnxruntime-common、
//   onnxruntime-web/webgpu），浏览器直接 import 会报「无法解析模块」。
//   jsDelivr 的 +esm 构建能跑，但它把依赖重写成了 jsDelivr 的绝对 URL ——
//   也就是仍然要联网。要做到真正离线，必须自己打一份。
//
// 为什么 wasm 要单独下：
//   npm 包 onnxruntime-web@1.26.0-dev 的 dist/ 里没有 .wasm（只有加载器 .mjs），
//   wasm 内核在运行时才取。所以要显式拉下来放进 vendor/ort/。

import { build } from 'esbuild';
import { copyFile, mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '..', 'vendor');
const ORT_OUT = join(OUT, 'ort');

// 必须与 js/whisper.js 里的 ORT_VERSION 保持一致，否则加载器与内核版本错配
const ORT_VERSION = '1.26.0-dev.20260416-b7804b056c';
const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist`;

// 要随包带的 wasm 变体。
//
// ⚠️ 这里的命名很有迷惑性，别按字面猜：
//   在这个 onnxruntime-web 版本里，带 WebGPU 能力的是 **asyncify** 变体，
//   不是 jsep。实测（grep 计数）：
//     ort-wasm-simd-threaded.asyncify.mjs   webgpu 出现 14 次，含 webgpuInit ✓
//     ort-wasm-simd-threaded.jsep.mjs        webgpu 出现  1 次，无 webgpuInit ✗
//   指定 jsep 的后果是能加载、但一初始化 WebGPU 就报
//   "webgpuInit is not a function"。
//
// 这也正好解释了 onnxruntime 自己的默认值：非 Safari 用 asyncify，
// Safari 用普通版（Safari 没有 WebGPU，走 CPU，普通版更小更快）。
// 我们照抄这个策略，所以两个变体都要带。
const ORT_FILES = [
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
];

const MB = (n) => (n / 1048576).toFixed(2) + ' MB';

async function step1_bundleTransformers() {
  await mkdir(OUT, { recursive: true });
  const outfile = join(OUT, 'transformers.js');

  await build({
    stdin: {
      contents: `export * from '@huggingface/transformers';`,
      resolveDir: here,
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    outfile,
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    // 关键：onnxruntime-web 的 ./webgpu 子路径导出带一个自定义条件
    //   "onnxruntime-web-use-extern-wasm" → dist/ort.webgpu.min.mjs   （外部 wasm）
    //   "default"                        → dist/ort.webgpu.bundle.min.mjs（内嵌 wasm）
    // esbuild 默认不认识那个条件，会直接报「Could not resolve onnxruntime-web/webgpu」。
    // 显式声明它才能选到「使用外部 wasm」的构建 —— 我们要自己托管 wasm，
    // 内嵌版本会把 37MB 的 wasm 以 base64 塞进 JS，体积和加载都更差。
    conditions: ['onnxruntime-web-use-extern-wasm', 'browser', 'import', 'default'],
    logLevel: 'warning',
  });

  const { size } = await stat(outfile);
  console.log(`  transformers.js  ${MB(size)}`);
  return size;
}

async function step2_fetchOrt() {
  await mkdir(ORT_OUT, { recursive: true });
  let total = 0;

  // 本地已经装好的 onnxruntime-web 里就有这些文件，优先直接复制。
  // 一来省一次网络往返，二来保证用的是和打包时同一份副本。
  const localDist = join(here, 'node_modules', 'onnxruntime-web', 'dist');

  for (const name of ORT_FILES) {
    const dest = join(ORT_OUT, name);
    if (existsSync(dest)) {
      const { size } = await stat(dest);
      if (size > 1024) {
        console.log(`  ort/${name}  ${MB(size)}（已存在）`);
        total += size;
        continue;
      }
    }

    const local = join(localDist, name);
    if (existsSync(local)) {
      const { size } = await stat(local);
      if (size > 1024) {
        await copyFile(local, dest);
        console.log(`  ort/${name}  ${MB(size)}（取自本地 node_modules）`);
        total += size;
        continue;
      }
    }

    const url = `${ORT_CDN}/${name}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败 ${name}：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) throw new Error(`${name} 体积异常：${buf.length} 字节`);
    await writeFile(dest, buf);
    console.log(`  ort/${name}  ${MB(buf.length)}`);
    total += buf.length;
  }

  return total;
}

console.log('构建离线运行时…');
const a = await step1_bundleTransformers();
const b = await step2_fetchOrt();
console.log(`\n合计 ${MB(a + b)} → ${OUT}`);
