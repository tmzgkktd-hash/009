/* ============================================================
 * VoiceType · 声音转文字
 * 纯前端实现，零后端、零上传，所有数据保存在本机
 * 识别引擎：Web Speech API（Chrome / Edge / Safari 原生支持）
 * ============================================================ */

(() => {
  'use strict';

  /* ---------------------------------------------------------
   * 0. 工具函数
   * ------------------------------------------------------- */
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const pad = (n, w = 2) => String(n).padStart(w, '0');

  /** 毫秒 → mm:ss */
  const fmtClock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  };

  /** 毫秒 → 00:00:00,000 （SRT 用） */
  const fmtSrt = (ms) => {
    ms = Math.max(0, Math.round(ms));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const t = ms % 1000;
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(t, 3)}`;
  };

  /** 毫秒 → 00:00:00.000 （VTT 用） */
  const fmtVtt = (ms) => fmtSrt(ms).replace(',', '.');

  /** 时间戳 → 2026-09-13 15:22 */
  const fmtDate = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const download = (filename, content, mime = 'text/plain;charset=utf-8') => {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  const stamp = () => {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  };

  /* ---------------------------------------------------------
   * 1. DOM 引用
   * ------------------------------------------------------- */
  const el = {
    recBtn:      $('#recBtn'),
    statusText:  $('#statusText'),
    statusDot:   $('#statusDot'),
    timer:       $('#timer'),
    wave:        $('#wave'),
    langSelect:  $('#langSelect'),
    transcript:  $('#transcript'),
    emptyState:  $('#emptyState'),
    wordCount:   $('#wordCount'),
    btnCopy:     $('#btnCopy'),
    btnExport:   $('#btnExport'),
    exportMenu:  $('#exportMenu'),
    btnClear:    $('#btnClear'),
    historyList: $('#historyList'),
    historyEmpty:$('#historyEmpty'),
    btnClearAll: $('#btnClearAll'),
    btnTheme:    $('#btnTheme'),
    btnSettings: $('#btnSettings'),
    btnInstall:  $('#btnInstall'),
    drawer:      $('#drawer'),
    drawerMask:  $('#drawerMask'),
    btnCloseDrawer: $('#btnCloseDrawer'),
    engineBody:  $('#engineBody'),
    toast:       $('#toast'),
    audioPanel:  $('#audioPanel'),
    audioPlayer: $('#audioPlayer'),
    audioDownload: $('#audioDownload'),
    // 设置
    setFont:     $('#setFont'),
    setFontVal:  $('#setFontVal'),
    setAutoPunct:$('#setAutoPunct'),
    setCapture:  $('#setCapture'),
    setAutoSave: $('#setAutoSave'),
    setKeepAwake:$('#setKeepAwake'),
    // 识别引擎
    engineSeg:   $('#engineSeg'),
    engineHint:  $('#engineHint'),
    offlineBox:  $('#offlineBox'),
    setModel:    $('#setModel'),
    setHost:     $('#setHost'),
    setToSimp:   $('#setToSimp'),
    btnLoadModel:$('#btnLoadModel'),
    modelProg:   $('#modelProg'),
    modelBar:    $('#modelBar'),
    modelProgText: $('#modelProgText'),
    btnResetAll: $('#btnResetAll'),
  };

  /* ---------------------------------------------------------
   * 2. 状态
   * ------------------------------------------------------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  const PREF_KEY = 'voicetype.prefs.v1';
  const HIST_KEY = 'voicetype.history.v1';
  const MAX_HISTORY = 60;

  /**
   * 偏好结构版本。
   *
   * 只要改动「默认值」的含义就要 +1 —— 老用户存下来的旧默认值会被纠正一次。
   * v2：打包版默认档位从「没有 WebGPU 就退到 base」改成「一律 large + 离线」。
   *     base 没有随包，旧默认会让离线版第一次用就联网下载。
   */
  const PREFS_VERSION = 2;

  const state = {
    recording: false,
    supported: !!SR,
    rec: null,
    segments: [],          // { id, text, start, end }
    interim: '',
    pendingStart: 0,       // 当前这句的起始时刻（相对 sessionStart）
    sessionStart: 0,
    elapsed: 0,
    tickTimer: null,
    restartTimer: null,
    restartDelay: 300,
    stopping: false,
    nodeMap: new Map(),    // segment id -> DOM 节点
    interimNode: null,
    autoScroll: true,
    wakeLock: null,
    recorder: null,
    chunks: [],
    stream: null,
    audioUrl: null,
    activeSessionId: null,
    sessions: [],
    installEvent: null,
    // 离线模式
    offlineReady: false,     // 模型是否已加载好
    offlineDevice: '',       // webgpu / wasm
    offlineBundled: null,    // 模型是否来自随包目录（null = 还没加载过，不知道）
  };

  const prefs = {
    lang: 'zh-CN',
    theme: 'light',
    fontSize: 17,
    autoPunct: true,
    capture: false,
    autoSave: true,
    keepAwake: true,
    // 识别引擎：cloud = Web Speech API（走云端）；offline = Whisper（本机推理）
    // 没有 Web Speech API 的环境（安卓 WebView、Firefox 等）直接默认离线。
    // 否则用户点下录音只会收到「不支持语音识别」，等于装完就是坏的。
    engine: SR ? 'cloud' : 'offline',
    // 默认取质量最好的档位。large 用 fp16 系量化，没有 WebGPU 跑不了，
    // 所以按设备能力选：有 WebGPU 上 Large，没有就退到 Base。
    whisperModel: ('gpu' in navigator) ? 'large' : 'base',   // tiny | base | small | large
    whisperHost: 'mirror',    // mirror（国内）| hf（官方）
    toSimplified: true,       // Whisper 中文输出是繁体，转成简体
  };

  /* ---------------------------------------------------------
   * 3. 偏好设置持久化
   * ------------------------------------------------------- */
  function loadPrefs() {
    let saved = null;
    try {
      const raw = localStorage.getItem(PREF_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch (_) { /* 忽略损坏数据 */ }
    if (saved) Object.assign(prefs, saved);

    // 跟随系统主题（首次使用）
    if (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      prefs.theme = 'dark';
    }

    // 兜底：存过的偏好可能是「云端」，但当前环境没有 Web Speech API
    // （比如换到安卓 WebView 里打开）。云端在这个环境里永远不可能成功，
    // 直接纠正成离线，省得用户以为是坏了。
    if (!SR) prefs.engine = 'offline';

    /* ---- 打包版的默认档位 ---- *
     *
     * 打包版（APK / DMG / EXE / IPA）内置的模型就是 large，而且 large 现在是
     * q4（int4 + fp32），**WebGPU 和纯 CPU 都能跑**。所以打包版一律默认
     * large + 离线。
     *
     * 为什么必须显式纠正：下面 prefs 字面量里的默认值是给纯网页版写的 ——
     * 「有 WebGPU 上 large，没有就退到 base」。在打包版里这会把用户带到一个
     * **根本没有随包**的档位，第一次录音就联网去下 78MB。国内网络下这一步
     * 大概率直接失败，用户看到的就是「离线版一装就是坏的」。
     * 同理，macOS 的 WKWebView 是带 Web Speech API 的，默认引擎会落到 cloud，
     * 一样要联网、一样在国内连不上。
     *
     * 已经存过偏好的老版本用的是旧默认值，靠 PREFS_VERSION 迁一次。
     * 用户自己动过模型下拉框的，尊重用户的选择（见下面的 saved?.whisperModel）。
     */
    const migrated = !saved || (saved.v || 1) < PREFS_VERSION;
    if (packaged) {
      if (migrated || !saved?.whisperModel) prefs.whisperModel = 'large';
      if (migrated || !saved?.engine) prefs.engine = 'offline';
    }
    prefs.v = PREFS_VERSION;

    el.langSelect.value = prefs.lang;
    el.setFont.value = prefs.fontSize;
    el.setFontVal.textContent = prefs.fontSize + 'px';
    el.setAutoPunct.checked = prefs.autoPunct;
    el.setCapture.checked = prefs.capture;
    el.setAutoSave.checked = prefs.autoSave;
    el.setKeepAwake.checked = prefs.keepAwake;
    el.setModel.value = prefs.whisperModel;
    el.setHost.value = prefs.whisperHost;
    el.setToSimp.checked = prefs.toSimplified;
    document.documentElement.style.setProperty('--fs-transcript', prefs.fontSize + 'px');
    syncEngineUI();
    // 迁移结果落盘，免得每次启动都重算一遍（结果一样，只是没必要）
    if (migrated) savePrefs();
  }

  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (_) {}
  }

  function applyTheme() {
    document.documentElement.dataset.theme = prefs.theme;
  }

  /* ---------------------------------------------------------
   * 4. 轻提示
   * ------------------------------------------------------- */
  let toastTimer = null;
  function toast(msg, ms = 2200) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
  }

  function setStatus(text, kind = '') {
    el.statusText.textContent = text;
    el.statusDot.className = 'dot' + (kind ? ' ' + kind : '');
  }

  /* ---------------------------------------------------------
   * 5. 波形装饰条
   * ------------------------------------------------------- */
  function buildWave() {
    const n = 30;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const bar = document.createElement('i');
      bar.style.animationDelay = (i * 0.055).toFixed(3) + 's';
      bar.style.animationDuration = (0.7 + Math.random() * 0.65).toFixed(2) + 's';
      frag.appendChild(bar);
    }
    el.wave.appendChild(frag);
  }

  /* ---------------------------------------------------------
   * 6. 计时器
   * ------------------------------------------------------- */
  function startTimer() {
    state.sessionStart = Date.now();
    state.elapsed = 0;
    el.timer.textContent = '00:00';
    clearInterval(state.tickTimer);
    state.tickTimer = setInterval(() => {
      state.elapsed = Date.now() - state.sessionStart;
      el.timer.textContent = fmtClock(state.elapsed);
    }, 200);
  }

  function stopTimer() {
    clearInterval(state.tickTimer);
    state.tickTimer = null;
    if (state.sessionStart) state.elapsed = Date.now() - state.sessionStart;
  }

  const now = () => Date.now() - state.sessionStart;

  /* ---------------------------------------------------------
   * 7. 屏幕常亮
   * ------------------------------------------------------- */
  async function acquireWakeLock() {
    if (!prefs.keepAwake || !('wakeLock' in navigator)) return;
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    } catch (_) { /* 用户拒绝或系统不允许，忽略 */ }
  }

  function releaseWakeLock() {
    try { state.wakeLock?.release(); } catch (_) {}
    state.wakeLock = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.recording) acquireWakeLock();
  });

  /* ---------------------------------------------------------
   * 8. 音频录制（可选）
   * ------------------------------------------------------- */
  async function startAudioCapture() {
    if (!prefs.capture || !navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.stream = stream;
      state.chunks = [];
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
      state.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      state.recorder.ondataavailable = (e) => { if (e.data.size > 0) state.chunks.push(e.data); };
      state.recorder.onstop = () => {
        if (!state.chunks.length) return;
        const blob = new Blob(state.chunks, { type: state.recorder.mimeType || 'audio/webm' });
        if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
        state.audioUrl = URL.createObjectURL(blob);
        el.audioPlayer.src = state.audioUrl;
        el.audioDownload.href = state.audioUrl;
        el.audioDownload.download = `voicetype-audio-${stamp()}.webm`;
        el.audioPanel.hidden = false;
      };
      state.recorder.start(1000);
    } catch (err) {
      console.warn('[VoiceType] 音频录制启动失败：', err);
      toast('音频录制未启动，仅做文字转写');
    }
  }

  function stopAudioCapture() {
    try { if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop(); } catch (_) {}
    try { state.stream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
    state.recorder = null;
    state.stream = null;
  }

  /* ---------------------------------------------------------
   * 9. 转写区渲染
   * ------------------------------------------------------- */
  function updateCounts() {
    const text = state.segments.map((s) => s.text).join('');
    const cn = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const en = (text.match(/[A-Za-z0-9]+/g) || []).length;
    el.wordCount.textContent = `${text.length} 字 · ${cn + en} 词`;
  }

  function syncEmptyState() {
    const has = state.segments.length > 0 || !!state.interim;
    el.emptyState.style.display = has ? 'none' : 'flex';
  }

  function scrollToEnd() {
    if (!state.autoScroll) return;
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }

  function makeSegmentNode(seg) {
    const div = document.createElement('div');
    div.className = 'seg';
    div.dataset.id = seg.id;
    div.innerHTML = `<span class="seg-time">${fmtClock(seg.start)}</span><span class="seg-text"></span>`;
    div.querySelector('.seg-text').textContent = seg.text;
    div.title = '点击可编辑这一段';

    div.addEventListener('click', () => {
      if (div.isContentEditable) return;
      beginEdit(div, seg);
    });

    return div;
  }

  function beginEdit(div, seg) {
    div.contentEditable = 'true';
    div.focus();
    // 光标放到末尾
    const r = document.createRange();
    r.selectNodeContents(div.querySelector('.seg-text'));
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);

    const commit = () => {
      div.contentEditable = 'false';
      const txt = div.querySelector('.seg-text').textContent.trim();
      seg.text = txt;
      if (!txt) {
        // 空段落直接删除
        state.segments = state.segments.filter((s) => s.id !== seg.id);
        div.remove();
        state.nodeMap.delete(seg.id);
      }
      updateCounts();
      syncEmptyState();
      persistActiveSession();
    };

    div.addEventListener('blur', commit, { once: true });
    div.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); div.blur(); }
      if (e.key === 'Escape') {
        div.querySelector('.seg-text').textContent = seg.text;
        div.blur();
      }
    });
  }

  /**
   * 后处理：繁转简 + 补标点。
   * Whisper 的中文输出固定是繁体，所以这一步对离线模式是必需的；
   * 云端引擎返回的本就是简体，转换是幂等的，不会误伤。
   */
  function postProcess(raw) {
    let t = String(raw || '');
    if (prefs.toSimplified && /[\u3400-\u9fff]/.test(t) && window.VoiceTypeZh) {
      t = window.VoiceTypeZh.toSimplified(t);
    }
    return normalizeText(t);
  }

  /**
   * 追加一段最终结果。
   * @param {string} text
   * @param {{startMs:number,endMs:number}} [timing]
   *        离线模式传实际音频区间；不传则用当前时刻（云端模式）。
   */
  function appendFinalSegment(text, timing) {
    const clean = postProcess(text);
    if (!clean) return;

    const start = timing ? timing.startMs : (state.pendingStart || now());
    const end   = timing ? timing.endMs   : now();
    const seg = { id: uid(), text: clean, start, end };
    state.segments.push(seg);

    const node = makeSegmentNode(seg);
    el.transcript.appendChild(node);
    state.nodeMap.set(seg.id, node);

    // 清掉 interim 节点
    clearInterim();
    state.pendingStart = 0;

    updateCounts();
    syncEmptyState();
    scrollToEnd();
    persistActiveSession();
  }

  function updateInterim(text) {
    if (!state.pendingStart) state.pendingStart = now();
    if (!state.interimNode) {
      state.interimNode = document.createElement('div');
      state.interimNode.className = 'seg interim';
      state.interimNode.innerHTML = '<span class="seg-text"></span>';
      el.transcript.appendChild(state.interimNode);
    }
    state.interimNode.querySelector('.seg-text').textContent = text;
    syncEmptyState();
    scrollToEnd();
  }

  function clearInterim() {
    if (state.interimNode) {
      state.interimNode.remove();
      state.interimNode = null;
    }
    state.interim = '';
  }

  /** 智能标点：句末没有标点时补上 */
  function normalizeText(raw) {
    let t = String(raw || '').trim();
    if (!t) return '';
    if (prefs.autoPunct) {
      const isCjk = /[\u4e00-\u9fa5]/.test(t);
      const last = t.slice(-1);
      const puncts = '。！？；，.!?;,、…）)】」』';
      if (!puncts.includes(last)) t += isCjk ? '。' : '.';
    }
    return t;
  }

  function renderAll() {
    el.transcript.innerHTML = '';
    state.nodeMap.clear();
    state.interimNode = null;
    state.segments.forEach((seg) => {
      const node = makeSegmentNode(seg);
      el.transcript.appendChild(node);
      state.nodeMap.set(seg.id, node);
    });
    updateCounts();
    syncEmptyState();
    scrollToEnd();
  }

  // 用户手动上滑时暂停自动滚动
  el.transcript.addEventListener('scroll', () => {
    const gap = el.transcript.scrollHeight - el.transcript.scrollTop - el.transcript.clientHeight;
    state.autoScroll = gap < 80;
  });

  /* ---------------------------------------------------------
   * 10. 识别引擎
   * ------------------------------------------------------- */
  function buildRecognition() {
    const rec = new SR();
    rec.lang = prefs.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      state.restartDelay = 300;
      setStatus('正在聆听…', '');
      el.statusDot.classList.add('err');
    };

    rec.onresult = (event) => {
      let interimBuf = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const txt = res[0]?.transcript || '';
        if (res.isFinal) {
          appendFinalSegment(txt);
        } else {
          interimBuf += txt;
        }
      }
      if (interimBuf) {
        state.interim = interimBuf;
        updateInterim(interimBuf);
      }
    };

    rec.onerror = (e) => {
      const code = e.error;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        setStatus('麦克风权限被拒绝', 'err');
        toast('请在浏览器设置中允许使用麦克风');
        stopRecording(true);
        return;
      }
      if (code === 'audio-capture') {
        setStatus('找不到麦克风设备', 'err');
        toast('未检测到可用的麦克风');
        stopRecording(true);
        return;
      }
      if (code === 'network') {
        setStatus('网络异常，识别中断', 'warn');
        return;
      }
      // no-speech / aborted 属于正常情况，交给 onend 重启
      if (code === 'no-speech') setStatus('等待说话…', 'warn');
    };

    rec.onend = () => {
      if (!state.recording || state.stopping) return;
      // 自动重启，保证长时间连续听写
      clearTimeout(state.restartTimer);
      state.restartTimer = setTimeout(() => {
        if (!state.recording || state.stopping) return;
        try { rec.start(); } catch (_) { /* 已启动则忽略 */ }
      }, state.restartDelay);
      state.restartDelay = Math.min(state.restartDelay * 1.5, 3000);
    };

    return rec;
  }

  /* ---------------------------------------------------------
   * 11. 开始 / 停止
   * ------------------------------------------------------- */
  async function startRecording() {
    if (state.recording) return;

    // 离线模式走完全不同的链路：自采 PCM → Whisper 本机推理
    if (prefs.engine === 'offline') return startOfflineRecording();

    if (!state.supported) {
      toast('当前浏览器不支持语音识别，请改用 Chrome / Edge / Safari');
      return;
    }

    // 请求麦克风权限（同时给用户明确反馈）
    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        probe.getTracks().forEach((t) => t.stop());
      } catch (_) {
        setStatus('麦克风权限被拒绝', 'err');
        toast('需要麦克风权限才能转写，请在浏览器地址栏允许');
        return;
      }
    }

    state.recording = true;
    state.stopping = false;
    state.autoScroll = true;
    document.body.classList.add('recording');
    el.recBtn.setAttribute('aria-label', '停止录音');

    // 新会话
    if (state.segments.length === 0 && !state.interim) {
      state.activeSessionId = uid();
    }

    startTimer();
    acquireWakeLock();
    startAudioCapture();

    state.rec = buildRecognition();
    try { state.rec.start(); } catch (_) {
      setStatus('启动失败，请重试', 'err');
      stopRecording(true);
      return;
    }
    setStatus('正在聆听…', 'err');
  }

  function stopRecording(silent = false) {
    if (!state.recording) return;
    state.recording = false;
    state.stopping = true;

    clearTimeout(state.restartTimer);
    clearInterim();

    // 离线模式：stop() 是异步的，它要把缓冲区里最后一段音频也识别出来，
    // 所以必须等它跑完再做收尾，否则用户最后说的话会丢。
    if (prefs.engine === 'offline' && window.VoiceTypeOffline) {
      // ⚠️ silent 时必须**不动**状态文案。
      //
      // silent 的调用方都是出错分支，它们已经先 setStatus 报了错
      // （例如「麦克风启动失败」）。这里如果无条件改写，
      // 顺序就变成：报错 → 被覆盖成「正在处理最后一段…」；
      // 而下面的 finishStop(silent) 又只在非 silent 时才设状态，
      // 于是最终界面**永远停在「正在处理最后一段…」**，计时器停在 00:00，
      // 用户完全看不出刚才失败了 —— 实测在模拟器上就是这个表现。
      if (!silent) setStatus('正在处理最后一段…');
      window.VoiceTypeOffline.stop()
        .catch((e) => console.warn('[VoiceType] 收尾失败：', e))
        .then(() => finishStop(silent));
      return;
    }

    try { state.rec?.stop(); } catch (_) {}
    state.rec = null;
    finishStop(silent);
  }

  /** 停止后的收尾。云端 / 离线两条路都会走到这里。 */
  function finishStop(silent) {
    stopTimer();
    releaseWakeLock();
    stopAudioCapture();

    document.body.classList.remove('recording');
    el.recBtn.setAttribute('aria-label', '开始录音');

    if (!silent) {
      const n = state.segments.length;
      setStatus(n ? `已结束 · 共 ${n} 段` : '准备就绪', n ? 'ok' : '');
    }

    if (prefs.autoSave && state.segments.length) saveSession();
    state.stopping = false;
  }

  el.recBtn.addEventListener('click', () => {
    state.recording ? stopRecording() : startRecording();
  });

  /* ---------------------------------------------------------
   * 11b. 离线模式（Whisper 本机推理）
   * ------------------------------------------------------- */

  function showModelProgress(show, percent, text) {
    el.modelProg.hidden = !show;
    if (!show) return;
    if (typeof percent === 'number' && isFinite(percent)) {
      el.modelBar.style.width = Math.max(0, Math.min(100, percent)) + '%';
    }
    if (text) el.modelProgText.textContent = text;
  }

  /**
   * 加载离线模型（带进度条）。
   * @param {boolean} silent 静默模式：不弹 toast
   * @returns {Promise<boolean>} 是否就绪
   */
  async function loadOfflineModel(silent = false) {
    if (!window.VoiceTypeOffline || !window.VoiceTypeWhisper) {
      if (!silent) toast('离线模块未加载');
      return false;
    }
    if (state.offlineReady) return true;

    const info = window.VoiceTypeWhisper.MODELS[prefs.whisperModel];
    el.btnLoadModel.disabled = true;
    showModelProgress(true, 0, `准备加载 ${info.label}（约 ${info.mb} MB）…`);

    try {
      const r = await window.VoiceTypeOffline.ensureModel({
        model: prefs.whisperModel,
        host: prefs.whisperHost,
        onProgress: (e) => {
          const mb = (n) => (n / 1048576).toFixed(1);
          showModelProgress(true, e.percent,
            `${e.file.split('/').pop()} · ${e.percent.toFixed(0)}% (${mb(e.loaded)}/${mb(e.total)} MB)`);
        },
        onStatus: (s) => showModelProgress(true, undefined, s),
      });

      state.offlineReady = true;
      state.offlineDevice = r.device;
      state.offlineBundled = !!r.bundled;
      const dev = r.device === 'webgpu' ? 'WebGPU 加速' : 'WASM（无 GPU 加速）';
      showModelProgress(true, 100, `已就绪 · ${dev}`);
      syncEngineUI();
      if (!silent) toast(`模型已就绪 · ${dev}`);
      setTimeout(() => { if (state.offlineReady) showModelProgress(false); }, 2600);
      return true;
    } catch (err) {
      console.error('[VoiceType] 模型加载失败：', err);
      showModelProgress(true, 0, '加载失败：' + (err?.message || err));
      toast('模型加载失败。可换一个下载源再试。', 4200);
      return false;
    } finally {
      el.btnLoadModel.disabled = false;
    }
  }

  async function startOfflineRecording() {
    // 模型没准备好就先加载，加载失败就不要开始录
    if (!state.offlineReady) {
      const ok = await loadOfflineModel();
      if (!ok) { setStatus('模型未就绪', 'err'); return; }
    }

    state.recording = true;
    state.stopping = false;
    state.autoScroll = true;
    document.body.classList.add('recording');
    el.recBtn.setAttribute('aria-label', '停止录音');

    if (state.segments.length === 0 && !state.interim) state.activeSessionId = uid();

    startTimer();
    acquireWakeLock();

    try {
      await window.VoiceTypeOffline.start({
        lang: prefs.lang,
        toSimplified: prefs.toSimplified,
        onText: (text, meta) => appendFinalSegment(text, meta),
        onStatus: (s) => setStatus(s, state.recording ? 'err' : ''),
        onError: (e) => toast('识别出错：' + (e?.message || e)),
      });
    } catch (err) {
      console.error('[VoiceType] 离线录音启动失败：', err);
      setStatus('麦克风启动失败', 'err');
      toast(err?.message || '无法启动麦克风');
      stopRecording(true);
    }
  }

  /** 引擎相关的界面同步：分段按钮选中态、离线设置区显隐、提示文案 */
  function syncEngineUI() {
    const offline = prefs.engine === 'offline';

    $$('#engineSeg button').forEach((b) => {
      b.classList.toggle('on', b.dataset.engine === prefs.engine);
    });
    el.offlineBox.hidden = !offline;

    if (!offline) {
      const cloudOk = state.supported && window.isSecureContext;
      el.engineHint.innerHTML = cloudOk
        ? '走浏览器自带的语音识别，<b>需要联网</b>，且解码在厂商云端完成 —— 中国大陆网络下连不上 Google 语音服务，会一个字都识别不出。<b>建议改用「离线」。</b>'
        : '当前浏览器不支持 Web Speech API。可改用<b>离线</b>引擎。';
      return;
    }

    if (state.offlineReady) {
      const dev = state.offlineDevice === 'webgpu' ? 'WebGPU' : 'WASM';
      el.engineHint.innerHTML =
        `<b>模型已就绪</b> · ${dev}${cpuNote()} · 完全在本机推理，不联网、不上传。`;
    } else {
      // 把当前档位的体积与特点直接写出来，省得用户去猜该选哪个
      const spec = window.VoiceTypeWhisper?.MODELS?.[prefs.whisperModel];
      // 打包版一定随包了模型（构建脚本会校验，缺了直接构建失败），
      // 所以文案要区别对待 —— 跟打包版说「首次需下载模型」会让人以为要联网。
      const bundled = state.offlineBundled ?? packaged;
      // 打包版不显示体积：spec.mb 是**联网下载量**，随包版并不下载，
      // 写出来只会让人以为还要联网拉 537MB。
      const size = spec && !bundled ? `（约 ${spec.mb} MB）` : '';
      const tip = spec ? `<b>${spec.label}</b>${size} · ${spec.note}。<br>` : '';
      const tail = bundled
        ? '模型已随包，<b>装完就能用，不需要联网下载</b>。'
        : '首次需下载模型，之后由浏览器缓存。';
      el.engineHint.innerHTML =
        tip + '在本机推理，<b>不联网也能用</b>，不受国内网络限制。' + tail + capNote();
    }
  }

  /**
   * CPU 路径的能力说明。只在 WASM 后端有意义 —— WebGPU 走 GPU，线程数无关。
   *
   * 写出来是为了让「慢」有解释：没拿到跨源隔离时 10 核只用 1 核，
   * 一分钟录音要等四分钟，用户会以为程序卡死了。
   */
  function cpuNote() {
    const ri = window.VoiceTypeWhisper?.runtimeInfo?.();
    if (!ri || state.offlineDevice === 'webgpu') return '';
    return ` · ${ri.threads} 线程`;
  }

  /** 未加载模型时显示的本机能力摘要，同样是为了让性能可解释 */
  function capNote() {
    const ri = window.VoiceTypeWhisper?.runtimeInfo?.();
    if (!ri) return '';
    const accel = ri.webgpu ? '可用 WebGPU' : '无 WebGPU，走 CPU';
    return `<br>本机：${ri.cores} 核 · ${accel} · ${ri.threads} 线程`;
  }

  /* --- 引擎设置的交互 --- */

  el.engineSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-engine]');
    if (!btn || btn.dataset.engine === prefs.engine) return;
    if (state.recording) { toast('请先停止录音，再切换引擎'); return; }

    prefs.engine = btn.dataset.engine;
    savePrefs();
    syncEngineUI();
    setStatus('准备就绪');
    toast(prefs.engine === 'offline' ? '已切到离线识别' : '已切到云端识别');
  });

  el.setModel.addEventListener('change', () => {
    prefs.whisperModel = el.setModel.value;
    // 换模型要重新加载。旧 pipeline 先释放，避免两个模型同时占内存。
    state.offlineReady = false;
    try { window.VoiceTypeWhisper?.dispose(); } catch (_) {}
    showModelProgress(false);
    savePrefs();
    syncEngineUI();
  });

  el.setHost.addEventListener('change', () => {
    prefs.whisperHost = el.setHost.value;
    savePrefs();
  });

  el.setToSimp.addEventListener('change', () => {
    prefs.toSimplified = el.setToSimp.checked;
    savePrefs();
  });

  el.btnLoadModel.addEventListener('click', () => loadOfflineModel());

  // 空格键快速开始/停止（不在输入状态时）
  document.addEventListener('keydown', (e) => {
    const tag = (document.activeElement?.tagName || '').toLowerCase();
    const editing = document.activeElement?.isContentEditable;
    if (e.code === 'Space' && !editing && tag !== 'input' && tag !== 'select' && tag !== 'textarea') {
      e.preventDefault();
      state.recording ? stopRecording() : startRecording();
    }
    if (e.key === 'Escape') {
      el.exportMenu.hidden = true;
      closeDrawer();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.recording) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ---------------------------------------------------------
   * 12. 导出
   * ------------------------------------------------------- */
  function plainText() {
    return state.segments.map((s) => s.text).join('\n');
  }

  /** 把当前内容序列化成指定格式的字符串（不触发下载） */
  function serialize(fmt) {
    const text = plainText();

    if (fmt === 'txt') return text;

    // 自包含的单文件网页：样式内联，双击就能在任意浏览器里打开，
    // 也能直接发给别人。深色模式下自动跟随系统。
    if (fmt === 'html') {
      const now = Date.now();
      const lang = el.langSelect.selectedOptions[0]?.textContent || prefs.lang;
      const rows = state.segments.map((s) => {
        const end = s.end > s.start ? s.end : s.start + 2000;
        return `      <li>
        <span class="t">${fmtClock(s.start)} – ${fmtClock(end)}</span>
        <p class="x">${escapeHtml(s.text)}</p>
      </li>`;
      }).join('\n');

      return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>音转文 转写记录 · ${escapeHtml(fmtDate(now))}</title>
<style>
  :root { --bg:#f4f5f9; --card:#fff; --tx:#1c1f2b; --tx2:#6b7183; --bd:#e4e6ef; --ac:#4f46e5; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1117; --card:#161922; --tx:#e8eaf2; --tx2:#9aa0b4; --bd:#262b38; --ac:#8b86f5; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 16px; background:var(--bg); color:var(--tx);
         font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
         line-height:1.75; -webkit-font-smoothing:antialiased; }
  main { max-width:760px; margin:0 auto; background:var(--card); border:1px solid var(--bd);
         border-radius:14px; padding:28px 30px 34px; }
  h1 { font-size:20px; font-weight:600; margin:0 0 6px; }
  .meta { color:var(--tx2); font-size:13px; margin:0 0 22px; }
  .meta b { color:var(--tx); font-weight:500; }
  hr { border:0; border-top:1px solid var(--bd); margin:0 0 22px; }
  ol { list-style:none; margin:0; padding:0; }
  li { padding:12px 0; border-bottom:1px solid var(--bd); }
  li:last-child { border-bottom:0; }
  .t { display:inline-block; font-size:12px; color:var(--ac); font-variant-numeric:tabular-nums;
       background:color-mix(in srgb, var(--ac) 10%, transparent); border-radius:5px; padding:1px 7px; margin-bottom:5px; }
  .x { margin:0; white-space:pre-wrap; word-break:break-word; }
  footer { margin-top:26px; padding-top:14px; border-top:1px solid var(--bd);
           color:var(--tx2); font-size:12px; text-align:center; }
  @media print { body { background:#fff; padding:0; } main { border:0; } }
</style>
</head>
<body>
<main>
  <h1>音转文 转写记录</h1>
  <p class="meta">
    <b>时间</b> ${escapeHtml(fmtDate(now))} ·
    <b>时长</b> ${fmtClock(state.elapsed)} ·
    <b>语言</b> ${escapeHtml(lang)} ·
    <b>字数</b> ${text.length} ·
    <b>段数</b> ${state.segments.length}
  </p>
  <hr />
  <ol>
${rows}
  </ol>
  <footer>由「音转文」生成 · 全部内容在本机处理，未上传</footer>
</main>
</body>
</html>`;
    }

    if (fmt === 'md') {
      const lines = [
        `# 音转文 转写记录`,
        ``,
        `- 时间：${fmtDate(Date.now())}`,
        `- 时长：${fmtClock(state.elapsed)}`,
        `- 语言：${el.langSelect.selectedOptions[0]?.textContent || prefs.lang}`,
        `- 字数：${text.length}`,
        ``,
        `---`,
        ``,
      ];
      state.segments.forEach((s) => {
        lines.push(`**\`${fmtClock(s.start)}\`** ${s.text}`, '');
      });
      return lines.join('\n');
    }

    if (fmt === 'srt') {
      return state.segments.map((s, i) => {
        const end = s.end > s.start ? s.end : s.start + 2000;
        return `${i + 1}\n${fmtSrt(s.start)} --> ${fmtSrt(end)}\n${s.text}\n`;
      }).join('\n');
    }

    if (fmt === 'vtt') {
      return ['WEBVTT', ''].concat(state.segments.map((s, i) => {
        const end = s.end > s.start ? s.end : s.start + 2000;
        return `${i + 1}\n${fmtVtt(s.start)} --> ${fmtVtt(end)}\n${s.text}\n`;
      })).join('\n');
    }

    if (fmt === 'json') {
      return JSON.stringify({
        app: '音转文',
        version: '2.0.0',
        exportedAt: new Date().toISOString(),
        language: prefs.lang,
        durationMs: state.elapsed,
        charCount: text.length,
        segments: state.segments.map((s, i) => ({
          index: i + 1, startMs: s.start, endMs: s.end,
          start: fmtClock(s.start), text: s.text,
        })),
        text,
      }, null, 2);
    }

    return text;
  }

  const MIME = {
    txt: 'text/plain;charset=utf-8',
    html: 'text/html;charset=utf-8',
    md: 'text/markdown;charset=utf-8',
    srt: 'application/x-subrip;charset=utf-8',
    vtt: 'text/vtt;charset=utf-8',
    json: 'application/json;charset=utf-8',
  };

  // 三种运行环境，三种落盘通道：
  //   桌面 App / iOS App（Tauri）→ 原生「另存为」对话框，用户自己挑位置
  //   安卓 App（WebView）        → window.__yzwSave 这个 @JavascriptInterface 桥，
  //                                直接写进系统「下载/音转文」
  //   纯浏览器（PWA / 单文件 HTML）→ blob + <a download>
  //
  // 为什么安卓不能走 <a download>：WebView 对 blob: URL 的下载请求
  // 根本不会走到 DownloadListener，点了没反应，且没有任何报错。
  // 这是安卓壳里必须补的一环，否则「保存为 txt/html」在手机上等于不存在。
  const inTauri = () => typeof window.__TAURI__ !== 'undefined';

  // 安卓侧 addJavascriptInterface 注入的是对象 window.__yzwSave.save(...)，
  // 但也接受直接注入函数的写法，两种都认。
  const androidBridge = () => {
    const b = window.__yzwSave;
    if (!b) return null;
    if (typeof b === 'function') return b;
    return typeof b.save === 'function' ? b.save.bind(b) : null;
  };

  /**
   * 保存到本地。
   * @returns {Promise<string>} 落盘位置（供提示用）；用户主动取消时返回空串。
   * @throws 写入失败时抛出，由 exportAs 转成用户可读的提示。
   */
  async function saveToLocal(filename, content, mime) {
    // 桌面 / iOS（Tauri）：调 Rust 侧的 save_text_file —— 它负责弹原生
    // 「另存为」对话框，并把文本写到用户选的位置。
    //
    // 为什么不用 dialog / fs 插件的 JS API（window.__TAURI__.dialog.save +
    // fs.writeTextFile）：页面现在由本机 http://127.0.0.1 提供（原因见
    // desktop/src-tauri/src/lib.rs 顶部），在 Tauri 看来属于「远程来源」。
    // 插件命令要过 ACL 的按来源授权，实测直接报
    //   Command plugin:dialog|save not allowed by ACL
    // 要放行就得写 capability 并把 fs 的 scope 开到 **，权限反而更宽。
    //
    // ⚠️ 别以为换成「应用自己的命令」就绕过了 ACL —— 不会。页面既然是远程来源，
    //    应用命令照样要过那道闸，实测报
    //      Command save_text_file not allowed by ACL
    //    （曾经这里写着「自定义命令不受 ACL 约束」，是错的。）
    //    放行要配**两处**，缺一不可：
    //      src-tauri/permissions/voice-type.toml  —— 声明命令可被授予
    //      src-tauri/capabilities/default.json    —— 声明哪个来源可以拿到
    //    好在这样放行的范围仍然很窄：只有这两个命令，没有 fs scope。
    //    而且写盘边界天然就是「用户在对话框里选了什么就写什么」，更收敛。
    const invoke = window.__TAURI__?.core?.invoke;
    if (typeof invoke === 'function') {
      const path = await invoke('save_text_file', {
        defaultName: filename,
        contents: content,
      });
      return path || '';               // 空串 = 用户取消，不算失败
    }

    const bridge = androidBridge();
    if (bridge) {
      // 桥是同步的：返回写入后的路径，失败返回空串
      const saved = bridge(filename, content, mime);
      if (!saved) throw new Error('写入「下载」目录失败');
      return String(saved);
    }

    download(filename, content, mime);
    return filename;
  }

  async function exportAs(fmt) {
    if (!state.segments.length) { toast('还没有内容可以导出'); return false; }
    const name = `音转文-${stamp()}.${fmt}`;
    let where = '';
    try {
      where = await saveToLocal(name, serialize(fmt), MIME[fmt] || MIME.txt);
    } catch (err) {
      console.error('[export]', err);
      toast('保存失败：' + (err?.message || err));
      return false;
    }
    // 原生通道下把落盘位置报出来——安卓上文件躺在「下载/音转文」，用户得找得到
    if (where && where !== name) toast('已保存到 ' + where);
    else toast('已导出 ' + fmt.toUpperCase());
    return true;
  }

  el.btnExport.addEventListener('click', (e) => {
    e.stopPropagation();
    el.exportMenu.hidden = !el.exportMenu.hidden;
  });

  el.exportMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-fmt]');
    if (!btn) return;
    el.exportMenu.hidden = true;
    // 先收起菜单再导出：原生「另存为」对话框会阻塞，菜单留在屏幕上会闪
    exportAs(btn.dataset.fmt).catch((err) => console.error('[export]', err));
  });

  document.addEventListener('click', () => { el.exportMenu.hidden = true; });

  el.btnCopy.addEventListener('click', async () => {
    const text = plainText();
    if (!text) { toast('还没有内容'); return; }
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板');
    } catch (_) {
      // 降级方案
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('已复制到剪贴板');
    }
  });

  el.btnClear.addEventListener('click', () => {
    if (!state.segments.length && !state.interim) return;
    if (!confirm('确定清空当前转写内容吗？')) return;
    state.segments = [];
    state.activeSessionId = null;
    state.elapsed = 0;
    el.timer.textContent = '00:00';
    el.audioPanel.hidden = true;
    renderAll();
    setStatus('准备就绪');
    toast('已清空');
  });

  /* ---------------------------------------------------------
   * 13. 历史记录
   * ------------------------------------------------------- */
  function loadHistory() {
    try {
      const raw = localStorage.getItem(HIST_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      // 防御：数据可能被外部改坏，或来自旧版本，必须是数组且不超过上限
      const clean = Array.isArray(parsed)
        ? parsed.filter((s) => s && typeof s === 'object' && s.id).slice(0, MAX_HISTORY)
        : [];
      const trimmed = Array.isArray(parsed) && parsed.length > clean.length;
      state.sessions = clean;
      // 被截断过就写回，保持内存与存储一致
      if (trimmed) persistHistory();
    } catch (_) {
      state.sessions = [];
    }
  }

  function persistHistory() {
    state.sessions = state.sessions.slice(0, MAX_HISTORY);
    try {
      localStorage.setItem(HIST_KEY, JSON.stringify(state.sessions));
    } catch (err) {
      // 超出配额时砍掉一半再试，并同步内存，避免两边不一致
      state.sessions = state.sessions.slice(0, Math.floor(MAX_HISTORY / 2));
      try {
        localStorage.setItem(HIST_KEY, JSON.stringify(state.sessions));
      } catch (_) {
        state.sessions = [];
        try { localStorage.removeItem(HIST_KEY); } catch (__) {}
      }
    }
  }

  function saveSession() {
    if (!state.segments.length) return null;
    const text = plainText();
    const id = state.activeSessionId || uid();
    state.activeSessionId = id;

    const title = text.slice(0, 42).replace(/\s+/g, ' ') || '未命名记录';
    const existing = state.sessions.find((s) => s.id === id);
    const record = {
      id,
      title,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
      durationMs: state.elapsed,
      lang: prefs.lang,
      segments: state.segments.map((s) => ({ ...s })),
      text,
    };

    state.sessions = [record, ...state.sessions.filter((s) => s.id !== id)].slice(0, MAX_HISTORY);
    persistHistory();
    renderHistory();
    return record;
  }

  function persistActiveSession() {
    if (!prefs.autoSave || !state.segments.length) return;
    // 录音过程中节流保存，避免频繁写盘
    clearTimeout(persistActiveSession._t);
    persistActiveSession._t = setTimeout(saveSession, 1500);
  }

  function renderHistory() {
    const list = state.sessions;
    el.historyEmpty.style.display = list.length ? 'none' : 'flex';
    el.historyList.innerHTML = '';

    list.forEach((s) => {
      const item = document.createElement('div');
      item.className = 'history-item' + (s.id === state.activeSessionId ? ' active' : '');
      item.innerHTML = `
        <div class="h-title">${escapeHtml(s.title)}</div>
        <div class="h-meta">
          <span>${fmtDate(s.updatedAt)}</span>
          <span>${fmtClock(s.durationMs || 0)}</span>
          <span>${(s.text || '').length} 字</span>
        </div>
        <button class="h-del" title="删除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M6 6l12 12M18 6 6 18"/>
          </svg>
        </button>`;

      item.addEventListener('click', (e) => {
        if (e.target.closest('.h-del')) return;
        if (state.recording) { toast('请先停止录音'); return; }
        loadSession(s.id);
      });

      item.querySelector('.h-del').addEventListener('click', (e) => {
        e.stopPropagation();
        state.sessions = state.sessions.filter((x) => x.id !== s.id);
        persistHistory();
        if (state.activeSessionId === s.id) state.activeSessionId = null;
        renderHistory();
        toast('已删除该记录');
      });

      el.historyList.appendChild(item);
    });
  }

  function loadSession(id) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return;
    state.segments = (s.segments || []).map((x) => ({ ...x }));
    state.activeSessionId = id;
    state.elapsed = s.durationMs || 0;
    el.timer.textContent = fmtClock(state.elapsed);
    el.audioPanel.hidden = true;
    renderAll();
    renderHistory();
    setStatus(`已载入 · ${state.segments.length} 段`, 'ok');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  el.btnClearAll.addEventListener('click', () => {
    if (!state.sessions.length) return;
    if (!confirm('确定删除全部历史记录吗？此操作不可撤销。')) return;
    state.sessions = [];
    persistHistory();
    renderHistory();
    toast('历史记录已清空');
  });

  /* ---------------------------------------------------------
   * 14. 设置抽屉
   * ------------------------------------------------------- */
  function openDrawer() {
    el.drawer.hidden = false;
    el.drawerMask.hidden = false;
  }
  function closeDrawer() {
    el.drawer.hidden = true;
    el.drawerMask.hidden = true;
  }

  el.btnSettings.addEventListener('click', openDrawer);
  el.btnCloseDrawer.addEventListener('click', closeDrawer);
  el.drawerMask.addEventListener('click', closeDrawer);

  el.setFont.addEventListener('input', () => {
    prefs.fontSize = +el.setFont.value;
    el.setFontVal.textContent = prefs.fontSize + 'px';
    document.documentElement.style.setProperty('--fs-transcript', prefs.fontSize + 'px');
    savePrefs();
  });

  el.setAutoPunct.addEventListener('change', () => { prefs.autoPunct = el.setAutoPunct.checked; savePrefs(); });
  el.setAutoSave.addEventListener('change', () => { prefs.autoSave = el.setAutoSave.checked; savePrefs(); });
  el.setKeepAwake.addEventListener('change', () => {
    prefs.keepAwake = el.setKeepAwake.checked;
    savePrefs();
    prefs.keepAwake && state.recording ? acquireWakeLock() : releaseWakeLock();
  });
  el.setCapture.addEventListener('change', () => {
    prefs.capture = el.setCapture.checked;
    savePrefs();
    toast(prefs.capture ? '将在下次录音时同时保存音频' : '已关闭音频录制');
  });

  el.btnResetAll.addEventListener('click', () => {
    if (!confirm('将清空所有历史记录与设置，确定继续吗？')) return;
    localStorage.removeItem(PREF_KEY);
    localStorage.removeItem(HIST_KEY);
    location.reload();
  });

  /* ---------------------------------------------------------
   * 15. 主题 & 语言
   * ------------------------------------------------------- */
  el.btnTheme.addEventListener('click', () => {
    prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    savePrefs();
  });

  el.langSelect.addEventListener('change', () => {
    prefs.lang = el.langSelect.value;
    savePrefs();
    if (state.recording) {
      // 热切换语言
      try { state.rec?.stop(); } catch (_) {}
      setTimeout(() => {
        if (!state.recording) return;
        state.rec = buildRecognition();
        try { state.rec.start(); } catch (_) {}
      }, 220);
    }
    toast('识别语言已切换');
  });

  /* ---------------------------------------------------------
   * 16. 安装提示（PWA）
   * ------------------------------------------------------- */
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installEvent = e;
    el.btnInstall.hidden = false;
  });

  el.btnInstall.addEventListener('click', async () => {
    if (state.installEvent) {
      state.installEvent.prompt();
      const { outcome } = await state.installEvent.userChoice;
      if (outcome === 'accepted') {
        el.btnInstall.hidden = true;
        toast('已安装到本机');
      }
      state.installEvent = null;
      return;
    }
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua)) {
      toast('点底部「分享」按钮 → 添加到主屏幕', 4200);
    } else if (/Android/.test(ua)) {
      toast('点右上角菜单 → 安装应用 / 添加到主屏幕', 4200);
    } else {
      toast('在浏览器菜单中找到「安装 VoiceType」', 4200);
    }
  });

  // iOS 无 beforeinstallprompt，独立显示入口
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (isIOS && !standalone) el.btnInstall.hidden = false;
  if (standalone) el.btnInstall.hidden = true;

  /* ---------------------------------------------------------
   * 17. 引擎状态检测
   * ------------------------------------------------------- */
  function checkEngine() {
    const secure = window.isSecureContext;
    const offline = prefs.engine === 'offline';

    // 离线模式不依赖 Web Speech API，只要浏览器支持 WASM 和麦克风就能用，
    // 所以「浏览器不支持语音识别」这条判断在离线模式下不成立。
    const usable = offline
      ? (window.VoiceTypeWhisper?.supported() !== false)
      : state.supported;

    const lines = [];

    if (!usable) {
      lines.push('<i>当前浏览器不支持语音识别。</i><br>请使用 <b>Chrome / Edge / Safari</b> 打开本页面。');
      setStatus('浏览器不支持语音识别', 'err');
      el.recBtn.disabled = true;
      el.recBtn.style.opacity = '.45';
      el.recBtn.style.cursor = 'not-allowed';
    } else if (!secure) {
      lines.push('<i>当前不是安全上下文（HTTPS / localhost）。</i><br>麦克风将被浏览器拦截，请通过 https 访问。');
      setStatus('需要 HTTPS 环境', 'warn');
      el.recBtn.disabled = false;
      el.recBtn.style.opacity = '';
      el.recBtn.style.cursor = '';
    } else {
      el.recBtn.disabled = false;
      el.recBtn.style.opacity = '';
      el.recBtn.style.cursor = '';
      if (offline) {
        lines.push('识别引擎：<b>Whisper（本机推理）</b>');
        lines.push(`运行环境：<b>${secure ? '安全上下文 ✓' : '非安全上下文'}</b>`);
        lines.push('数据流向：音频不离开本机，完全离线');
      } else {
        lines.push('识别引擎：<b>Web Speech API（云端）</b>');
        lines.push(`运行环境：<b>${secure ? '安全上下文 ✓' : '非安全上下文'}</b>`);
        lines.push('数据流向：音频由浏览器送到厂商云端解码');
      }
    }

    el.engineBody.innerHTML = lines.join('<br>');
    syncEngineUI();
  }

  /* ---------------------------------------------------------
   * 18. Service Worker（离线外壳）
   *
   * 只在纯浏览器 / PWA 场景注册。打包进 App 的版本不注册，原因有二：
   *   1. 资源本来就在本地（APK 的 assets / Tauri 的 frontendDist），
   *      SW 缓存一层纯属多余；
   *   2. SW 缓存是"装上去就不会自己更新"的，App 升级后用户可能还在跑旧代码，
   *      排查起来极其费劲。
   * ------------------------------------------------------- */
  const packaged = inTauri() || !!androidBridge();

  if (!packaged && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  /* ---------------------------------------------------------
   * 19. 启动
   * ------------------------------------------------------- */
  function init() {
    loadPrefs();
    applyTheme();
    buildWave();
    loadHistory();
    renderHistory();
    renderAll();
    checkEngine();

    // 恢复上次未保存的会话（页面被刷新时）
    if (!state.segments.length) setStatus(state.supported ? '准备就绪' : '浏览器不支持语音识别');
  }

  /* ---------------------------------------------------------
   * 20. 对外接口
   * 方便脚本调用、自动化测试，或从其他页面把文字塞进来
   * ------------------------------------------------------- */
  window.VoiceType = {
    version: '1.0.0',

    /** 开始 / 停止录音 */
    start: startRecording,
    stop: stopRecording,
    toggle: () => (state.recording ? stopRecording() : startRecording()),

    /** 手动插入一段文字（不经过麦克风） */
    insert(text, startMs) {
      const start = typeof startMs === 'number' ? startMs : (state.segments.length ? state.segments[state.segments.length - 1].end + 400 : 0);
      const seg = { id: uid(), text: normalizeText(text), start, end: start + Math.max(1200, String(text).length * 180) };
      state.segments.push(seg);
      const node = makeSegmentNode(seg);
      el.transcript.appendChild(node);
      state.nodeMap.set(seg.id, node);
      if (!state.sessionStart) state.sessionStart = Date.now() - seg.end;
      state.elapsed = Math.max(state.elapsed, seg.end);
      el.timer.textContent = fmtClock(state.elapsed);
      updateCounts();
      syncEmptyState();
      scrollToEnd();
      return seg;
    },

    /** 取当前全部文字 */
    getText: plainText,
    /** 生成指定格式的字符串（不下载） */
    serialize,
    /** 导出（txt / md / srt / vtt / json） */
    export: exportAs,
    /** 保存到历史 */
    save: saveSession,
    /** 清空 */
    clear() {
      state.segments = [];
      state.activeSessionId = null;
      renderAll();
    },
    /** 切换识别引擎：'cloud' | 'offline' */
    setEngine(name) {
      if (name !== 'cloud' && name !== 'offline') throw new Error('引擎只能是 cloud 或 offline');
      if (state.recording) throw new Error('请先停止录音');
      prefs.engine = name;
      savePrefs();
      checkEngine();
      setStatus('准备就绪');
      return name;
    },

    /** 预加载离线模型（不录音也能先下好） */
    loadModel: () => loadOfflineModel(),

    /** 繁体转简体（独立可用，方便外部脚本复用） */
    toSimplified: (t) => (window.VoiceTypeZh ? window.VoiceTypeZh.toSimplified(t) : t),

    /** 只读状态快照 */
    info: () => ({
      supported: state.supported,
      recording: state.recording,
      segments: state.segments.length,
      chars: plainText().length,
      language: prefs.lang,
      elapsedMs: state.elapsed,
      engine: prefs.engine,
      offlineReady: state.offlineReady,
      offlineDevice: state.offlineDevice,
      whisperModel: prefs.whisperModel,
    }),
  };

  init();
})();

