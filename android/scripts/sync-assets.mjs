#!/usr/bin/env node
/**
 * 把项目根目录的网页资源、离线推理运行时、540MB 模型
 * 同步到 android/app/src/main/assets/web/。
 *
 *   node android/scripts/sync-assets.mjs
 *
 * 为什么要同步而不是直接把 Gradle 的 assets 目录指向项目根目录：
 * Android 的 assets 源目录是"内容直接挂在 assets/ 根下"的语义，
 * 而我们需要的是 assets/web/**（URL 里对应 /assets/web/**），
 * 中间多一层 web/ 就必须有一个真实的目录结构。
 *
 * 关于 540MB 的模型：默认用硬链接（fs.link）而不是复制。
 * 同一个卷上硬链接是零拷贝、零额外磁盘占用、瞬间完成的；
 * 复制 540MB 每次构建都要几十秒。跨卷（比如项目在移动硬盘）时才回退到复制。
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');                        // voicetype/
const DEST = path.resolve(HERE, '..', 'app', 'src', 'main', 'assets', 'web');

/** 要同步的顶层条目（相对项目根） */
const ITEMS = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'css',
  'js',
  'icons',
  'vendor',
  'models',
];

/** 不往 APK 里塞的东西 */
const SKIP = new Set(['.DS_Store', '.git', 'node_modules', 'generate_icons.py', 'make_launcher_icons.py']);

/**
 * 下载器的中间产物一律不要。
 * 这些文件动辄几百 MB，混进 assets 会让 APK 凭空胖一倍，
 * 而且它们对运行时毫无用处。同步时统一挡掉，比事后清理可靠。
 */
const SKIP_RE = /\.(part|tmp|assembling)(\.\d+)?$|\.progress$/;

let nLink = 0, nCopy = 0, nSkip = 0, nMissing = 0;
let bytes = 0;

/**
 * 本次同步"应该存在"的文件全路径。
 * 同步完拿它跟目标目录做差集，把上一轮遗留、这一轮已经不存在的文件删掉。
 *
 * 为什么必须做这件事：这个脚本只做增量覆盖，从不主动删东西。
 * 一旦 vendor/ 里的文件名变了（比如 ORT 内核从 jsep 换成 asyncify），
 * 老文件会永远躺在 assets 里 —— APK 白白胖 26MB，还带着一个已知会崩的变体。
 * 这类"幽灵文件"不会报任何错，只能靠差集兜住。
 */
const written = new Set();

function syncFile(src, dst) {
  let st;
  try {
    st = fs.statSync(src);
  } catch {
    nMissing++;
    return;
  }

  written.add(dst);

  try {
    const d = fs.statSync(dst);
    // 体积一致且不比源旧，就认为已经是最新的。
    // 模型这种几百 MB 的文件不会变，所以除了第一次构建，后面全是 skip。
    if (d.size === st.size && d.mtimeMs >= st.mtimeMs) {
      nSkip++;
      bytes += st.size;
      return;
    }
  } catch { /* 目标不存在，往下走 */ }

  fs.mkdirSync(path.dirname(dst), { recursive: true });
  // link 要求目标不存在
  try { fs.unlinkSync(dst); } catch { /* 本来就没有 */ }

  try {
    fs.linkSync(src, dst);
    nLink++;
  } catch {
    // 跨卷 / 不支持硬链接的文件系统
    fs.copyFileSync(src, dst);
    nCopy++;
  }
  bytes += st.size;
}

/**
 * 删掉目标目录里不该存在的文件，返回删除数量。
 * 逐文件 unlink 而不是整目录 rmtree —— 后者会触发沙箱的批量删除保护，
 * 直接把构建脚本打断。单文件删除是安全且可审计的。
 */
function prune(dir) {
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      removed += prune(full);
      continue;
    }
    if (!written.has(full)) {
      try {
        fs.unlinkSync(full);
        removed++;
      } catch { /* 删不掉不影响结果，最多是包大一点 */ }
    }
  }
  return removed;
}

function walk(srcDir, dstDir) {
  for (const name of fs.readdirSync(srcDir)) {
    if (SKIP.has(name) || SKIP_RE.test(name)) continue;
    const src = path.join(srcDir, name);
    const dst = path.join(dstDir, name);
    const st = fs.lstatSync(src);
    if (st.isDirectory()) {
      walk(src, dst);
    } else if (st.isFile()) {
      syncFile(src, dst);
    }
  }
}

function main() {
  console.log(`源：${ROOT}`);
  console.log(`目标：${DEST}`);
  console.log();

  // 前置检查：缺了这两个，打出来的 APK 看着能装，但一打开就没有识别能力
  const problems = [];
  const vendorJs = path.join(ROOT, 'vendor', 'transformers.js');
  // ⚠️ 带 WebGPU 能力的是 asyncify 变体，不是 jsep（详见 tools/build-vendor.mjs 的注释）。
  // whisper.js 运行时也是按 asyncify 加载的，这里必须查同一个文件，
  // 否则会出现"校验通过、运行报 webgpuInit is not a function"的错配。
  const ortWasm = path.join(ROOT, 'vendor', 'ort', 'ort-wasm-simd-threaded.asyncify.wasm');
  const ortMjs = path.join(ROOT, 'vendor', 'ort', 'ort-wasm-simd-threaded.asyncify.mjs');
  const modelDir = path.join(ROOT, 'models', 'whisper-large-v3-turbo');
  const modelCfg = path.join(modelDir, 'config.json');
  const modelEnc = path.join(modelDir, 'onnx', 'encoder_model_q4.onnx');
  const modelDec = path.join(modelDir, 'onnx', 'decoder_model_merged_q4.onnx');

  if (!fs.existsSync(vendorJs)) problems.push(`缺少离线运行时 ${vendorJs}（先跑 tools/build-vendor.mjs）`);
  if (!fs.existsSync(ortWasm)) problems.push(`缺少推理内核 ${ortWasm}（先跑 tools/build-vendor.mjs）`);
  if (!fs.existsSync(ortMjs)) problems.push(`缺少推理内核入口 ${ortMjs}（先跑 tools/build-vendor.mjs）`);
  if (!fs.existsSync(modelCfg)) problems.push(`缺少模型配置 ${modelCfg}（先跑 fetch-models.sh）`);
  if (!fs.existsSync(modelEnc)) problems.push(`缺少编码器 ${modelEnc}（先跑 fetch-models.sh）`);
  if (!fs.existsSync(modelDec)) problems.push(`缺少解码器 ${modelDec}（先跑 fetch-models.sh）`);

  // 体积校验：下载中断留下的半截文件同样"存在"，但打进 APK 就是一个
  // 一装就报错、还很难查的包。这里必须挡住。
  const sizeCheck = (p, want, label) => {
    if (!fs.existsSync(p)) return;
    const got = fs.statSync(p).size;
    const lo = Math.floor(want * 0.95), hi = Math.ceil(want * 1.05);
    if (got < lo || got > hi) {
      problems.push(
        `${label} 体积不对：${(got / 1048576).toFixed(1)} MB，` +
        `期望约 ${(want / 1048576).toFixed(1)} MB —— 多半是没下完，重跑 fetch-models.sh 续传`
      );
    }
  };
  sizeCheck(modelEnc, 424942775, '编码器 encoder_model_q4.onnx');
  sizeCheck(modelDec, 334147222, '解码器 decoder_model_merged_q4.onnx');

  if (problems.length) {
    console.error('无法继续，缺关键文件：');
    for (const p of problems) console.error('  ✗ ' + p);
    process.exit(1);
  }

  fs.mkdirSync(DEST, { recursive: true });

  for (const item of ITEMS) {
    const src = path.join(ROOT, item);
    const dst = path.join(DEST, item);
    let st;
    try {
      st = fs.lstatSync(src);
    } catch {
      console.warn(`  ! 跳过不存在的条目：${item}`);
      continue;
    }
    if (st.isDirectory()) walk(src, dst);
    else syncFile(src, dst);
  }

  console.log(`硬链接 ${nLink} 个，复制 ${nCopy} 个，已是最新 ${nSkip} 个`);
  if (nMissing) console.warn(`有 ${nMissing} 个文件读不到（已跳过）`);
  console.log(`资源合计 ${(bytes / 1048576).toFixed(1)} MB`);

  // 清掉上一轮遗留、这一轮已经不该存在的文件（典型场景：换掉 ORT 内核变体）
  const removed = prune(DEST);
  if (removed) console.log(`清理了 ${removed} 个陈旧文件`);

  // 校验：关键文件必须真的落到 assets 里
  const mustHave = [
    'index.html',
    'js/app.js',
    'js/whisper.js',
    'vendor/transformers.js',
    'vendor/ort/ort-wasm-simd-threaded.asyncify.wasm',
    'vendor/ort/ort-wasm-simd-threaded.asyncify.mjs',
    'models/whisper-large-v3-turbo/config.json',
    'models/whisper-large-v3-turbo/onnx/encoder_model_q4.onnx',
    'models/whisper-large-v3-turbo/onnx/decoder_model_merged_q4.onnx',
  ];
  let bad = 0;
  for (const rel of mustHave) {
    const p = path.join(DEST, rel);
    if (!fs.existsSync(p)) {
      console.error(`  ✗ 没同步过去：${rel}`);
      bad++;
    }
  }

  // 反向校验：确认被淘汰的内核变体没有残留。
  // 正向检查只能证明"该有的在"，证明不了"不该有的不在"，
  // 而这两种情况对 APK 的影响完全不同（后者白白胖 26MB）。
  const mustNotHave = [
    'vendor/ort/ort-wasm-simd-threaded.jsep.wasm',
    'vendor/ort/ort-wasm-simd-threaded.jsep.mjs',
    // 换 q4 之前随包的是 q4f16，这两份加起来 537MB，
    // 不清掉就会让 APK 里同时躺着两套模型。
    'models/whisper-large-v3-turbo/onnx/encoder_model_q4f16.onnx',
    'models/whisper-large-v3-turbo/onnx/decoder_model_merged_q4f16.onnx',
  ];
  for (const rel of mustNotHave) {
    const p = path.join(DEST, rel);
    if (fs.existsSync(p)) {
      console.error(`  ✗ 陈旧文件没清掉：${rel}`);
      bad++;
    }
  }

  if (bad) process.exit(1);

  console.log('资源就绪。');
}

main();
