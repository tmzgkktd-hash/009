/* ============================================================
 * VoiceType · 离线模式编排
 *
 * 把三块拼起来：
 *   capture.js  麦克风 → 16kHz PCM → 按停顿切段
 *   whisper.js  PCM → 文字（本机推理）
 *   zh-convert  繁体 → 简体
 *
 * 为什么要排队：
 *   Whisper 的推理不是可重入的，同一时刻只能跑一个。
 *   用户连续说话时会有多段积压，必须串行处理，
 *   否则会同时触发多次推理把内存打爆。
 * ============================================================ */

window.VoiceTypeOffline = (() => {
  'use strict';

  /** 界面语言 → Whisper 语言名。Whisper 要的是全称，不是 zh-CN 这种代码。 */
  const LANG_MAP = {
    'zh-CN': 'chinese', 'zh-HK': 'chinese', 'zh-TW': 'chinese',
    'en-US': 'english', 'en-GB': 'english',
    'ja-JP': 'japanese', 'ko-KR': 'korean',
    'fr-FR': 'french',   'de-DE': 'german',   'es-ES': 'spanish',
    'ru-RU': 'russian',  'pt-BR': 'portuguese', 'it-IT': 'italian',
    'hi-IN': 'hindi',    'ar-SA': 'arabic',
  };

  const CJK = /[\u3400-\u9fff]/;

  let capture = null;
  let queue = [];
  let busy = false;
  let running = false;
  let hooks = {};

  const log = (...a) => { try { hooks.onLog?.(...a); } catch (_) {} };

  /* ------------------------------------------------ 模型 */

  /**
   * 确保模型可用。已就绪则立即返回。
   *
   * 会按顺序尝试两个模型源，前一个失败自动换下一个。
   * 这一点很重要：huggingface.co 在中国大陆不可达，而 hf-mirror.com
   * 在某些网络下也可能连不上（实测有环境里浏览器能通、curl 走代理才通的情况）。
   * 与其让用户自己猜哪个能用，不如自动换。
   *
   * @param {{model:string, host:string, onProgress?:Function, onStatus?:Function}} o
   */
  async function ensureModel(o = {}) {
    const W = window.VoiceTypeWhisper;
    if (!W) throw new Error('离线引擎未加载');

    const target = W.MODELS[o.model] ? o.model : 'base';

    // 已就绪且是同一个模型 → 直接返回。
    //
    // ⚠️ 比的是**档位 key**（'large' / 'base'…），不是 HuggingFace 的仓库 id。
    //    whisper.js 的 model() 返回的就是 key（见 ensureOnce 里的 curModel = modelKey），
    //    而 MODELS[target].id 是 'onnx-community/whisper-large-v3-turbo' 这种仓库名，
    //    两者永远不会相等 —— 之前这么写，等于这个快速返回从来没生效过。
    //    后果不算致命（后面 ensure 内部还有 curKey 比对兜住），但每次都会白走一遍
    //    加载流程、白闪一次进度条，而且「已缓存」的分支形同虚设。
    if (W.ready() && W.model() === target) {
      return { device: W.device(), model: target, cached: true };
    }

    // 用户选的源优先，另一个作为兜底
    const order = o.host === 'hf' ? ['hf', 'mirror'] : ['mirror', 'hf'];
    let lastErr = null;

    for (let i = 0; i < order.length; i++) {
      const host = order[i];
      const unsub = W.subscribe((evt) => {
        if (evt.type === 'progress') o.onProgress?.(evt);
        else if (evt.type === 'status') o.onStatus?.(evt.text);
      });
      try {
        return await W.ensure({ model: target, host });
      } catch (err) {
        lastErr = err;
        console.warn(`[VoiceType] 模型源 ${host} 失败：`, err);
        // 换源前把半成品清掉，否则会带着坏状态重试
        try { W.dispose(); } catch (_) {}
        if (i < order.length - 1) {
          o.onStatus?.(`${W.HOSTS[host].label} 连不上，换源重试…`);
        }
      } finally {
        unsub();
      }
    }

    throw lastErr || new Error('所有模型源都不可用');
  }

  /* ------------------------------------------------ 识别队列 */

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const item = queue.shift();
        hooks.onStatus?.(`识别中…（积压 ${queue.length}）`);
        try {
          const lang = LANG_MAP[item.lang] || null;
          const res = await window.VoiceTypeWhisper.transcribe(item.pcm, {
            lang,
            trim: true,
          });

          let text = res.text || '';
          // 繁 → 简（Whisper 中文输出固定是繁体）
          if (text && CJK.test(text) && item.toSimplified && window.VoiceTypeZh) {
            text = window.VoiceTypeZh.toSimplified(text);
          }

          if (res.suspect) log('疑似幻觉输出，已截断：', text.slice(0, 40));
          if (text) hooks.onText?.(text, item.meta);
        } catch (err) {
          console.error('[VoiceType] 离线识别失败：', err);
          hooks.onError?.(err);
        }
      }
    } finally {
      busy = false;
      if (running) hooks.onStatus?.('正在聆听…');
    }
  }

  function enqueue(pcm, meta, opts) {
    queue.push({ pcm, meta, ...opts });
    pump();
  }

  /* ------------------------------------------------ 启停 */

  /**
   * @param {object} o
   * @param {string} o.lang           界面语言（zh-CN 等）
   * @param {boolean} o.toSimplified  是否繁转简
   * @param {(text:string, meta:object)=>void} o.onText
   * @param {(s:string)=>void} o.onStatus
   * @param {(e:Error)=>void} o.onError
   * @param {(level:number)=>void} o.onLevel
   */
  async function start(o) {
    if (running) return;
    if (!window.VoiceTypeCapture) throw new Error('采集模块未加载');

    hooks = o;
    running = true;
    queue = [];

    const C = window.VoiceTypeCapture.Capture;
    capture = new C({
      onSegment: (pcm, meta) => {
        // 太短的片段直接丢，避免无谓的推理
        if (meta.seconds < 0.35) return;
        enqueue(pcm, meta, { lang: o.lang, toSimplified: o.toSimplified });
      },
      onLevel: (lv) => hooks.onLevel?.(lv),
      onStatus: (s) => hooks.onStatus?.(s),
    });

    await capture.start();
    hooks.onStatus?.('正在聆听…');
  }

  async function stop() {
    if (!running) return;
    running = false;
    try { await capture?.stop(); } catch (_) {}
    capture = null;
    // 队列里剩余的继续跑完，不要把用户刚说的话丢掉
    await pump();
  }

  /* ------------------------------------------------ 对外 */

  return {
    LANG_MAP,
    ensureModel,
    start,
    stop,

    /** 立刻把当前缓存的音频切出来识别（用户主动「立即识别」时用） */
    flush() {
      try { capture?._flush?.(); } catch (_) {}
    },

    isRunning: () => running,
    pending: () => queue.length + (busy ? 1 : 0),
  };
})();
