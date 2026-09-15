/* ============================================================
 * VoiceType · 离线识别引擎（Whisper）
 *
 * 为什么需要它：
 *   Web Speech API 的解码在浏览器厂商的云端做（Chrome 走 Google 服务器），
 *   中国大陆网络下连不上，表现为「界面正常但一个字都不出」。
 *   本模块用 Whisper 在**本机**做识别，不联网也能用。
 *
 * 实现要点：
 *   - transformers.js 由 jsDelivr 的 +esm 构建动态载入（它会自动解析自己的
 *     裸依赖 onnxruntime-common / onnxruntime-web，自己托管反而要维护 import map）
 *   - 模型从可配置的源下载（默认 hf-mirror.com，国内可达；也可切回官方）
 *   - 首次下载后由浏览器缓存，之后完全离线
 *   - 有 WebGPU 用 WebGPU，否则回退 WASM；WebGPU 运行时报错时也会自动降级重试
 *
 * 三个踩过的坑，改代码前先看这里：
 *
 *   1) Whisper 永远按 30 秒窗口处理音频。不足 30 秒的部分会被补零，
 *      而模型会在补零区「幻觉」出无限重复（实测连续输出 432 个「于」）。
 *      必须传 no_repeat_ngram_size 才能抑制。附带好处是速度提升约 20 倍。
 *
 *   2) 量化格式在 WebGPU 上的速度差异极大。实测 large-v3-turbo：
 *        q8(int8)  RTF 7.29   ← 慢 40 倍，int8 要跑反量化 kernel
 *        fp16      RTF 0.18
 *        q4f16     RTF 0.18   ← 最终选择，体积只有 fp16 的 1/3
 *      所以大模型一律用 f16 系量化，别用 q8。
 *
 *   3) 不同档位的中文用字习惯不一致：Xenova/whisper-base 输出繁体，
 *      whisper-small 时简时繁，large-v3-turbo 输出简体。
 *      所以简体转换不能省（见 zh-convert.js）。
 * ============================================================ */

window.VoiceTypeWhisper = (() => {
  'use strict';

  /* ------------------------------------------------ 常量 */

  const TRANSFORMERS_CDN =
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm';

  // onnxruntime 的 wasm 必须与 transformers.js 内部依赖的版本一致。
  // 注意：onnxruntime-common 与 onnxruntime-web 版本号体系不同，
  // 这个 dev 版本只存在于 web 包，common 包没有，别照抄到 common 上。
  const ORT_VERSION = '1.26.0-dev.20260416-b7804b056c';
  const ORT_WASM_BASE =
    `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

  /* ---------------- 随包离线资源 ----------------
   * 打包成 APK / DMG / EXE / iOS App 时，会把这些东西放在应用里：
   *   vendor/transformers.js   打平的 transformers.js 运行时（无裸依赖）
   *   vendor/ort/*.wasm        onnxruntime 的 wasm 内核
   *   models/<name>/...        离线模型
   * 三者都在时，整个识别过程一次网络都不需要。
   * 纯浏览器环境（PWA、双击单文件 HTML）没有这些目录，会自动回退到 CDN + 联网下载。
   *
   * ⚠️ 这里必须用绝对地址，不能写成 './vendor/...'。
   *
   * 原因是相对路径在不同 API 里的解析基准不一样：
   *     fetch('./vendor/transformers.js')   → 按【文档地址】解析 → /vendor/transformers.js
   *     import('./vendor/transformers.js')  → 按【脚本自身地址】解析
   * 而本文件在 js/ 目录下，所以 import 会去请求 /js/vendor/transformers.js，
   * 也就是 404。更阴的是探测阶段用的是 fetch（能过），加载阶段用的是 import（必挂），
   * 表现就是「明明探测到本地运行时可用了，一加载就报
   * Failed to fetch dynamically imported module」，而且指向一个根本不存在的路径。
   *
   * 统一用 document.baseURI 转成绝对地址，两个 API 看到的就是同一个 URL。
   * 这样本地服务、Tauri、安卓虚拟源三种宿主都对：
   *   http://127.0.0.1:8899/vendor/...
   *   tauri://localhost/vendor/...
   *   https://appassets.androidplatform.net/assets/web/vendor/...
   */
  const abs = (p) => new URL(p, document.baseURI).href;

  const VENDOR_RUNTIME = abs('./vendor/transformers.js');
  const VENDOR_ORT = abs('./vendor/ort/');

  /** 随包模型所在目录名（与 models/ 下的子目录同名） */
  const BUNDLED_MODEL_DIR = 'whisper-large-v3-turbo';

  /**
   * 随包模型的量化格式：q4（int4 权重 + fp32 激活）。
   *
   * 为什么不用更小的 q4f16（537MB）：**q4f16 只有 WebGPU 能跑**。
   * 实测在没有 WebGPU 的环境里，ORT 连 session 都建不起来：
   *   Can't create a session ... SimplifiedLayerNormFusion ...
   *   Attempting to get index by a name which does not exist:
   *   InsertedPrecisionFreeCast_/layers.31/self_attn_layer_norm/...
   * 关掉图优化也没用（同样报错）—— 这是 CPU EP 不支持 fp16 算子导致的，
   * 不是配置问题。
   *
   * 后果很严重：内置了模型却用不了，程序会退回联网下载 q8（约 1GB），
   * 「离线版」就名不副实了。macOS 15 的 WKWebView（Safari 18）
   * 默认没有 WebGPU，正好踩中。
   *
   * q4 代价是体积从 537MB 涨到 724MB，换来的是**任何设备都真离线**。
   * 联网下载的那条路径仍然用 q4f16（有 WebGPU 时更快、体积更小）。
   */
  const BUNDLED_DTYPE = 'q4';

  // 本地资源探测结果缓存，避免每次加载都探一遍
  let localRuntime = null;   // true/false/null(未探测)
  let localModelBase = null; // 形如 'http://127.0.0.1:52341/' 或 './models/'
  let localModelProbed = false;

  /**
   * 模型档位。
   * mb = encoder + decoder 的实际下载量（实测）。
   * 标了 gpuOnly 的档位用了 fp16 系量化，只有 WebGPU 能跑；
   * 在 WASM 上会自动降级成 q8，否则模型直接加载失败。
   */
  const MODELS = {
    tiny: {
      id: 'Xenova/whisper-tiny', label: 'Tiny', mb: 43,
      note: '最快，中文准确率一般',
    },
    base: {
      id: 'Xenova/whisper-base', label: 'Base', mb: 78,
      note: '轻量、能实时，中文偶有错字（输出繁体）',
    },
    small: {
      id: 'Xenova/whisper-small', label: 'Small', mb: 237,
      note: '中文比 Base 准，但用字与标点不够稳定',
    },
    large: {
      id: 'onnx-community/whisper-large-v3-turbo', label: 'Large v3 Turbo', mb: 537,
      note: '准确率最高（实测零错字）。随包版 CPU 也能跑；联网下载版需 WebGPU',
      dtype: 'q4f16', gpuOnly: true,
    },
  };

  /** 模型源。国内 huggingface.co 不可达，必须能切到镜像。 */
  const HOSTS = {
    mirror: { url: 'https://hf-mirror.com',  label: '国内镜像（hf-mirror.com）' },
    hf:     { url: 'https://huggingface.co', label: 'HuggingFace 官方' },
  };

  /** 识别时的生成参数。no_repeat_ngram_size 是必须的，见文件头说明。 */
  const GEN_DEFAULTS = {
    no_repeat_ngram_size: 3,
    repetition_penalty: 1.1,
  };

  /* ------------------------------------------------ 内部状态 */

  let tf = null;              // transformers.js 模块
  let pipe = null;            // 当前 pipeline
  let curKey = '';            // 当前 pipeline 对应的 model|dtype|device
  let curDevice = 'wasm';     // 实际使用的后端
  let curModel = 'base';      // 当前模型 key
  let lastCfg = {};           // 最近一次 ensure 的参数，WebGPU 降级重试要用
  let loading = null;         // 进行中的加载 Promise（避免并发重复加载）
  let webgpuProbe = null;     // 'webgpu' | 'wasm'，detectDevice() 探到就缓存

  /**
   * 清掉已加载的 pipeline，释放显存/内存。
   *
   * ⚠️ 必须是**模块作用域**的函数，不能只写成返回对象上的方法。
   * 之前只有对象上的 `dispose()`，而 transcribe() 里的降级重试写的是裸调用
   * `dispose()` —— 在模块作用域里根本找不到这个名字，会抛
   *   ReferenceError: dispose is not defined
   * 于是那段「WebGPU 出错就回退 WASM 重试」**从来没有生效过**，
   * 一旦 WebGPU 真出问题，用户看到的就是直接失败。
   * 现在对象上的 dispose 只是转发到这里，两条路共用一个实现。
   */
  function dispose() {
    try { pipe?.dispose?.(); } catch (_) {}
    pipe = null;
    curKey = '';
  }

  const listeners = new Set();
  const emit = (evt) => listeners.forEach((fn) => { try { fn(evt); } catch (_) {} });

  /* ------------------------------------------------ 工具 */

  /**
   * 真正探测后端能力，探测一次就缓存。
   *
   * ⚠️ 必须**真的去要一个 adapter**，不能只看 `'gpu' in navigator`。
   * 属性存在只说明浏览器暴露了这个 API，不代表拿得到设备。以下都会命中：
   *   · 模拟器（GPU 是软件渲染，拿不到 adapter）
   *   · GPU 被 blocklist 的机型
   *   · 企业策略 / 命令行关掉 WebGPU 的桌面 Chrome
   *   · 任何「API 在，但 requestAdapter() 返回 null」的情况
   *
   * 实测（Android 模拟器 API 36）：`navigator.gpu` 存在、`requestAdapter()`
   * 返回 null。旧代码因此选了 webgpu，建 session 直接报
   *   no available backend found. ERR: [webgpu] Failed to get GPU adapter
   * 而加载路径没有任何兜底，结果是**离线模型完全加载不出来** ——
   * 对一个卖点就是「装完就能断网用」的应用，这是致命的。
   */
  async function detectDevice() {
    if (webgpuProbe) return webgpuProbe;
    if (!('gpu' in navigator) || !navigator.gpu) {
      webgpuProbe = 'wasm';
      return webgpuProbe;
    }
    try {
      const adapter = await navigator.gpu.requestAdapter();
      webgpuProbe = adapter ? 'webgpu' : 'wasm';
    } catch (_) {
      // requestAdapter 本身抛错（权限策略、驱动异常）同样按不可用处理
      webgpuProbe = 'wasm';
    }
    return webgpuProbe;
  }

  /**
   * 是否具备**可用**的 WebGPU（给界面显示用）。
   * 探测过就用真实结果；还没探测过时只按 API 存在与否给个初值 ——
   * 真正的判断以 detectDevice() 为准，别在这里下结论。
   */
  function hasWebGPU() {
    if (webgpuProbe) return webgpuProbe === 'webgpu';
    return 'gpu' in navigator;
  }

  /** fp16 系量化只支持 WebGPU。 */
  function isF16Dtype(dtype) {
    return dtype === 'fp16' || dtype.endsWith('f16');
  }

  /** 高级覆盖用的 localStorage 键（见 resolveThreads）。 */
  const THREADS_KEY = 'yzw-threads';

  /**
   * 决定 ORT 用几个线程。
   *
   * 前提是 **跨源隔离** 成立：只有 COOP: same-origin + COEP: require-corp
   * 同时到位，`crossOriginIsolated` 才是 true，SharedArrayBuffer 才存在，
   * ORT 的多线程 WASM 才真的起得来。没有 SAB 时设 numThreads > 1 毫无意义 ——
   * 起不了 pthread 池，只会退回单线程，白白多出一堆报错。
   * （实测：未隔离时 19.93 秒音频要 77.7 秒；隔离后 21.4 秒，快 3.6 倍。）
   *
   * 上限定在 4：这是实测出来的平台期，不是拍脑袋。
   * 同一段 19.93 秒音频、同一台 10 核机器上实测：
   *     1 线程 77.7 秒   →   4 线程 21.5 秒   →   8 线程 21.4 秒
   * 4 之后再往上加没有任何收益 —— q4 权重有 726MB，推理时要把权重流式过一遍
   * 内存，瓶颈在内存带宽而不是算力，再多线程也只是互相抢带宽。
   * 既然 4 就够了，就别占着更多核：留出核心给录音和界面（否则录进来的
   * 音频会丢帧，转出来的字就残缺），手机上也少一份发热降频的风险。
   *
   * 留了个后门：`localStorage.setItem('yzw-threads','2')` 可以强制线程数。
   * 给排障用（某些机器多线程反而更慢，或者手机发热降频）。
   */
  function resolveThreads() {
    const cores = navigator.hardwareConcurrency || 4;
    let override = 0;
    try { override = parseInt(localStorage.getItem(THREADS_KEY), 10) || 0; } catch (_) {}
    if (override > 0) return Math.max(1, Math.min(cores, override));

    const sab = typeof SharedArrayBuffer === 'function' && self.crossOriginIsolated === true;
    if (!sab) return 1;
    return Math.max(1, Math.min(4, cores - 1));
  }

  /**
   * 运行环境快照。
   *
   * 界面显示「几个线程」、以及排障时判断「为什么这么慢」，都靠它，
   * 免得各处各写一份探测逻辑、还写得不一样。
   */
  function runtimeInfo() {
    return {
      webgpu: hasWebGPU(),
      isolated: self.crossOriginIsolated === true,
      sab: typeof SharedArrayBuffer === 'function',
      cores: navigator.hardwareConcurrency || 0,
      threads: resolveThreads(),
    };
  }

  /** 裁掉首尾静音。Whisper 对静音区敏感，裁掉能显著减少幻觉。 */
  function trimSilence(f32, thresh = 0.012, padSec = 0.15) {
    let s = 0, e = f32.length - 1;
    while (s < f32.length && Math.abs(f32[s]) < thresh) s++;
    while (e > s && Math.abs(f32[e]) < thresh) e--;
    if (e <= s) return f32;                       // 全是静音，原样返回
    const p = Math.floor(padSec * 16000);
    s = Math.max(0, s - p);
    e = Math.min(f32.length - 1, e + p);
    return f32.slice(s, e + 1);
  }

  /** 最长连续重复字符数。用于识别幻觉输出，超过 6 基本可以判定异常。 */
  function maxRepeatRun(text) {
    let max = 1, run = 1;
    for (let i = 1; i < text.length; i++) {
      if (text[i] === text[i - 1]) { run++; if (run > max) max = run; }
      else run = 1;
    }
    return max;
  }

  /**
   * 兜底清理：万一还是出现了长重复，在重复开始处截断。
   * 正常情况下 no_repeat_ngram_size 已经挡住了，这里是最后一道防线。
   */
  function stripRepeatTail(text, limit = 6) {
    let run = 1;
    for (let i = 1; i < text.length; i++) {
      if (text[i] === text[i - 1]) {
        run++;
        if (run >= limit) return text.slice(0, i - run + 1);
      } else run = 1;
    }
    return text;
  }

  /** WebGPU 的运行时故障：设备丢失、buffer 竞态等，值得降级重试 */
  function isWebGPUError(err) {
    return /webgpu|GPUBuffer|GPUMapMode|device.*lost|OrtRun/i.test(String(err && (err.message || err)));
  }

  /* ------------------------------------------------ 加载 */

  /**
   * 探测随包的 transformers.js 运行时。
   * 不能只看 HTTP 状态码：静态托管对不存在的路径常常返回 200 + 首页 HTML，
   * 直接 import 会报「Unexpected token '<'」。所以还要看内容像不像 JS。
   */
  async function probeLocalRuntime() {
    if (localRuntime !== null) return localRuntime;
    try {
      const res = await fetch(VENDOR_RUNTIME, { method: 'GET' });
      if (!res.ok) { localRuntime = false; return false; }
      const text = await res.text();
      // 打包产物是 ESM，至少应该有 export 关键字，且不以 < 开头
      const looksJs = text.length > 1024 && !text.trimStart().startsWith('<')
        && /\bexport\b/.test(text);
      localRuntime = looksJs;
    } catch (_) {
      localRuntime = false;
    }
    return localRuntime;
  }

  /** 探测随包模型。桌面端问 Rust 要本地服务地址，浏览器端用相对目录。 */
  async function probeLocalModel() {
    if (localModelProbed) return localModelBase;
    localModelProbed = true;

    const candidates = [];

    // 桌面 App：Rust 侧起了一个只监听 127.0.0.1 的静态服务
    try {
      if (window.__TAURI__?.core?.invoke) {
        const base = await window.__TAURI__.core.invoke('model_base_url');
        if (base) candidates.push(base);
      }
    } catch (_) { /* 不是 Tauri 环境，继续 */ }

    // 浏览器 / 本地服务：模型就在网页旁边。
    // 同样要用绝对地址 —— 这个值最终会赋给 transformers.js 的 env.remoteHost，
    // 库内部可能用 new URL() 或 Worker 去拼，相对路径在那些地方没有文档基准可依。
    candidates.push(abs('./models/'));

    for (const base of candidates) {
      const url = base + BUNDLED_MODEL_DIR + '/config.json';
      try {
        const res = await fetch(url, { method: 'GET' });
        if (!res.ok) continue;
        const text = await res.text();
        // 同样防「404 返回首页 HTML」
        if (!text.trimStart().startsWith('{')) continue;
        const cfg = JSON.parse(text);
        if (cfg && cfg.model_type) {
          localModelBase = base;
          return localModelBase;
        }
      } catch (_) { /* 试下一个 */ }
    }

    localModelBase = null;
    return null;
  }

  async function loadTransformers() {
    if (tf) return tf;
    emit({ type: 'status', text: '正在载入识别运行时…' });

    const useLocal = await probeLocalRuntime();
    const url = useLocal ? VENDOR_RUNTIME : TRANSFORMERS_CDN;
    const m = await import(/* @vite-ignore */ url);
    const env = m.env;

    env.allowLocalModels = false;   // 模型路径我们自己拼，不交给库去猜
    env.useBrowserCache = true;     // 联网下载的模型由浏览器缓存，二次使用不再联网
    // 随包运行时用随包的 wasm；CDN 运行时用 CDN 的 wasm（版本必须对得上）。
    //
    // ⚠️ wasmPaths 有两种形态，差别很大：
    //   字符串  → onnxruntime 把它当【目录前缀】，再拼上一个写死的文件名
    //   对象    → 精确指定 { mjs, wasm } 两个文件，不猜
    // 走 CDN 时字符串形态碰巧能用（jsDelivr 的 dist/ 里所有变体都在），
    // 但随包目录只放了我们挑的那几个，拼错名字就是
    // 「no available backend found」+ 一句看不出所以然的 .mjs 加载失败。
    // 所以随包一律用对象形态。
    //
    // ⚠️ 另一个反直觉的点：带 WebGPU 能力的是 **asyncify** 变体，不是 jsep。
    // （实测 asyncify.mjs 里 webgpu 出现 14 次且有 webgpuInit；jsep.mjs 只有 1 次且没有。
    //  给 jsep 会报 "webgpuInit is not a function"。）
    // onnxruntime 自己的默认也是这个策略：非 Safari 用 asyncify，Safari 用普通版
    // （Safari 没有 WebGPU，走 CPU，普通版更小更快）。这里照抄。
    const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);

    env.backends.onnx.wasm.wasmPaths = !useLocal
      ? ORT_WASM_BASE
      : isSafari
        ? { mjs: VENDOR_ORT + 'ort-wasm-simd-threaded.mjs',
            wasm: VENDOR_ORT + 'ort-wasm-simd-threaded.wasm' }
        : { mjs: VENDOR_ORT + 'ort-wasm-simd-threaded.asyncify.mjs',
            wasm: VENDOR_ORT + 'ort-wasm-simd-threaded.asyncify.wasm' };

    tf = m;
    return tf;
  }

  /**
   * 确保指定模型就绪。
   * @param {{model?:string, host?:string, device?:string}} cfg
   *        device 一般不用传；传 'wasm' 可强制走 WASM（WebGPU 降级重试用）
   * @returns {Promise<{device:string, model:string, dtype:string, downgraded:boolean}>}
   */
  async function ensureOnce(cfg = {}) {
    const modelKey = MODELS[cfg.model] ? cfg.model : 'base';
    const spec = MODELS[modelKey];
    const device = cfg.device || await detectDevice();

    // 随包模型是 q4，WebGPU 和纯 CPU 都能跑，所以内置路径不走降级逻辑。
    // 只有「联网下载」那条路径才需要 gpuOnly 降级（见 BUNDLED_DTYPE 注释）。
    const base = await probeLocalModel();
    const useBundled = !!base && modelKey === 'large';

    const wantDtype = useBundled ? BUNDLED_DTYPE : (spec.dtype || 'q8');
    const downgraded =
      !useBundled && !!spec.gpuOnly && device !== 'webgpu' && isF16Dtype(wantDtype);
    const dtype = downgraded ? 'q8' : wantDtype;

    const modelId = useBundled ? BUNDLED_MODEL_DIR : spec.id;

    const key = `${modelId}|${dtype}|${device}`;

    lastCfg = { model: modelKey, host: cfg.host };

    if (pipe && curKey === key) {
      return { device: curDevice, model: curModel, dtype, downgraded, bundled: useBundled };
    }

    // 并发调用时共用同一次加载
    if (loading && loading.key === key) return loading.promise;

    const promise = (async () => {
      const m = await loadTransformers();

      // 切换模型源。remotePathTemplate 决定 URL 拼法，必须显式给。
      if (useBundled) {
        // 走随包目录。去掉 resolve/{revision} 两段 —— 随包目录是扁平的
        // models/<name>/...，不是 HuggingFace 的仓库布局。
        m.env.remoteHost = base;
        m.env.remotePathTemplate = '{model}/';
        // 文件本来就在本机，再往 Cache API 存一份等于白占 540MB。
        // WebView 自己的 HTTP 缓存已能避免重复读盘（见 Rust 侧 Cache-Control）。
        m.env.useBrowserCache = false;
      } else {
        const host = HOSTS[cfg.host] ? HOSTS[cfg.host].url : HOSTS.mirror.url;
        m.env.remoteHost = host;
        m.env.remotePathTemplate = '{model}/resolve/{revision}/';
        m.env.useBrowserCache = true;
      }

      if (downgraded) {
        emit({ type: 'status', text: '当前设备没有 WebGPU，已改用 q8 量化（体积更大、速度更慢）…' });
      }
      emit({
        type: 'status',
        text: useBundled
          ? `正在从本机载入模型（${spec.label}）…`
          : `正在准备模型（${spec.label}，约 ${spec.mb} MB）…`,
      });

      // 线程数在这里设、而不是在 loadTransformers 里设一次：
      // 每次真正建 session 前都重新判断，换模型/换后端时不会残留旧值。
      // 必须赶在 m.pipeline() 之前 —— transformers.js 是在建 session 时
      // 才去读这个值的，建完再改就没有任何效果了。
      m.env.backends.onnx.wasm.numThreads = resolveThreads();

      const filePct = new Map();
      const p = await m.pipeline('automatic-speech-recognition', modelId, {
        dtype: { encoder_model: dtype, decoder_model_merged: dtype },
        device,
        progress_callback: (info) => {
          if (!info || info.status !== 'progress' || !info.file || !info.total) return;
          filePct.set(info.file, info.progress || 0);
          let sum = 0;
          filePct.forEach((v) => { sum += v; });
          emit({
            type: 'progress',
            file: info.file,
            percent: Math.min(100, sum / filePct.size),
            loaded: info.loaded,
            total: info.total,
          });
        },
      });

      pipe = p;
      curKey = key;
      curDevice = device;
      curModel = modelKey;
      emit({ type: 'ready', device, model: modelKey, bundled: useBundled });
      return { device, model: modelKey, dtype, downgraded, bundled: useBundled };
    })();

    loading = { key, promise };
    try {
      return await promise;
    } finally {
      if (loading && loading.key === key) loading = null;
    }
  }

  /**
   * 加载模型（对外入口）。带一层 WebGPU 兜底。
   *
   * 为什么加载阶段也要兜底：detectDevice() 已经会真去要 adapter，但
   * 「拿到 adapter」不等于「一定建得起 session」—— 驱动抽风、显存不够、
   * 设备在加载途中丢失，都会在 pipeline() 这一步才炸。
   * 这些情况以前没有兜底：直接抛到界面上就是一句「模型加载失败」，
   * 用户除了换设备没有别的办法。而同一份模型在 WASM 上明明跑得起来。
   *
   * 只在**调用方没有显式指定 device** 时才降级，避免覆盖用户的强制选择
   * （比如排障时特意指定 wasm）。
   */
  async function ensure(cfg = {}) {
    try {
      return await ensureOnce(cfg);
    } catch (err) {
      if (cfg.device || !isWebGPUError(err)) throw err;

      // 记住这台机器不行，别每次重试都把同一个坑再踩一遍
      webgpuProbe = 'wasm';
      console.warn('[VoiceType] WebGPU 加载失败，降级到 WASM 重试：', err);
      emit({ type: 'status', text: 'WebGPU 不可用，正在回退到 CPU（WASM）…' });
      dispose();
      return await ensureOnce({ ...cfg, device: 'wasm' });
    }
  }

  /* ------------------------------------------------ 识别 */

  async function runOnce(f32, opts) {
    const audio = opts.trim === false ? f32 : trimSilence(f32);
    if (audio.length < 1600) return { text: '', seconds: 0, suspect: false }; // 不足 0.1s，忽略

    const t0 = performance.now();
    const out = await pipe(audio, {
      language: opts.lang || 'chinese',
      task: 'transcribe',
      return_timestamps: false,
      ...GEN_DEFAULTS,
    });
    const seconds = (performance.now() - t0) / 1000;

    const raw = (out && out.text) || '';
    const text = stripRepeatTail(raw.trim());
    const suspect = maxRepeatRun(raw) >= 6 || /[\u4e00-\u9fa5]{1}\1{5,}/.test(raw);

    return { text, seconds, suspect, raw };
  }

  /**
   * 识别一段 16kHz 单声道音频。
   * @param {Float32Array} f32
   * @param {{lang?:string, trim?:boolean}} opts
   * @returns {Promise<{text:string, seconds:number, suspect:boolean}>}
   */
  async function transcribe(f32, opts = {}) {
    if (!pipe) throw new Error('模型尚未就绪，请先调用 ensure()');

    try {
      return await runOnce(f32, opts);
    } catch (err) {
      // WebGPU 偶发设备丢失 / buffer 竞态（实测过一次 OrtRun buffer unmapped）。
      // 这种时候把后端降级到 WASM 重试一次，总比直接给用户报错强。
      if (curDevice !== 'webgpu' || !isWebGPUError(err)) throw err;

      console.warn('[VoiceType] WebGPU 推理失败，降级到 WASM 重试：', err);
      emit({ type: 'status', text: 'WebGPU 出错，正在回退到 WASM…' });
      dispose();
      await ensure({ ...lastCfg, device: 'wasm' });
      return await runOnce(f32, opts);
    }
  }

  /* ------------------------------------------------ 对外 */

  return {
    MODELS,
    HOSTS,
    GEN_DEFAULTS,

    ensure,
    transcribe,
    trimSilence,
    maxRepeatRun,
    hasWebGPU,
    /** 运行环境快照：webgpu / isolated / sab / cores / threads */
    runtimeInfo,

    /**
     * 随包是否带了这个档位的模型。界面用它把「内置、开箱即用」和
     * 「需要联网下载」区分开，免得用户以为点了没反应。
     */
    async isBundled(key) {
      if (key !== 'large') return false;
      return !!(await probeLocalModel());
    },
    /** 随包运行时是否可用（决定「完全离线」还是「要联网」） */
    async hasLocalRuntime() {
      return await probeLocalRuntime();
    },
    /** 本机模型目录基址，没内置时为 null */
    localModelBase: () => localModelBase,

    /** 当前后端（webgpu / wasm） */
    device: () => curDevice,
    /** 是否已就绪 */
    ready: () => !!pipe,
    /** 当前模型 key */
    model: () => (curModel || null),
    /** 是否具备运行条件（只是探测能力，不代表模型已下载） */
    supported: () => typeof WebAssembly === 'object',

    /** 订阅状态事件：status / progress / ready */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /**
     * 清掉已加载的 pipeline，释放显存/内存。
     * 转发到模块作用域的同名函数 —— 见上面 dispose() 的注释：
     * 这个逻辑必须模块内可达，transcribe() 的降级重试要用。
     */
    dispose,
  };
})();
