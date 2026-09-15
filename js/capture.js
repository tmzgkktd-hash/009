/* ============================================================
 * VoiceType · 音频采集与分段
 *
 * 职责：把麦克风变成「一段一段的 16kHz 单声道 Float32」，
 *       每凑够一个自然停顿就交出去给识别引擎。
 *
 * 为什么要自己采集而不是用 MediaRecorder：
 *   MediaRecorder 产出的是 webm/opus，要识别得先整段解码。
 *   长录音下反复解码「到目前为止的全部音频」是 O(n²)，
 *   而且拿不到精确的采样边界。直接采 PCM 就没这些问题。
 *
 * 为什么要分段：
 *   Whisper 是 30 秒窗口的模型。按自然停顿切段，既能实时出字，
 *   又能避免把长静音喂进去导致幻觉。
 * ============================================================ */

window.VoiceTypeCapture = (() => {
  'use strict';

  const TARGET_RATE = 16000;   // Whisper 要求 16kHz

  /* AudioWorklet 处理器。用 Blob URL 注入，
     这样单文件版 HTML 也能用，不需要额外的 worklet 文件。 */
  const WORKLET_SRC = `
    class PCMCapture extends AudioWorkletProcessor {
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch && ch.length) {
          // 必须复制：这块内存会被复用
          this.port.postMessage(new Float32Array(ch));
        }
        return true;
      }
    }
    registerProcessor('voicetype-pcm', PCMCapture);
  `;

  /** 线性插值重采样。只在浏览器没按 16kHz 给数据时才用到。 */
  function resample(f32, fromRate, toRate) {
    if (fromRate === toRate) return f32;
    const ratio = fromRate / toRate;
    const outLen = Math.floor(f32.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, f32.length - 1);
      const t = pos - i0;
      out[i] = f32[i0] * (1 - t) + f32[i1] * t;
    }
    return out;
  }

  class Capture {
    /**
     * @param {object} o
     * @param {(pcm:Float32Array, meta:object)=>void} o.onSegment  一段话结束
     * @param {(level:number)=>void} o.onLevel                     音量（0~1，给电平表用）
     * @param {(text:string)=>void}   o.onStatus                   状态文案
     * @param {object} o.tuning                                    VAD 参数覆盖
     */
    constructor(o = {}) {
      this.onSegment = o.onSegment || (() => {});
      this.onLevel = o.onLevel || (() => {});
      this.onStatus = o.onStatus || (() => {});

      const t = o.tuning || {};
      this.silenceMs   = t.silenceMs   ?? 800;    // 停顿多久算一句说完
      this.minSegMs    = t.minSegMs    ?? 600;    // 太短的片段丢掉
      this.maxSegMs    = t.maxSegMs    ?? 25000;  // 上限，别超 Whisper 的 30s 窗口
      this.speechRms   = t.speechRms   ?? 0.012;  // 判定「有人在说话」的阈值下限

      this.ctx = null;
      this.stream = null;
      this.node = null;
      this.source = null;
      this.sink = null;
      this.running = false;

      this.buf = [];            // 当前段落累积的 Float32Array
      this.bufLen = 0;          // 当前段落采样点数
      this.totalSamples = 0;    // 整个会话的采样点数（用于时间轴）
      this.hasSpeech = false;
      this.lastVoiceSample = 0; // 最近一次「有语音」的会话采样位置
      this.startedAt = 0;
      this.noiseFloor = 0;      // 自适应噪声底（RMS）
      this.segStartSample = 0;  // 当前段落起点（会话内采样偏移）
    }

    get sampleRate() { return this.ctx ? this.ctx.sampleRate : TARGET_RATE; }

    async start() {
      if (this.running) return;
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('浏览器不支持麦克风采集');

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // 尽量让浏览器直接给 16kHz；不行就后面重采样
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ sampleRate: TARGET_RATE });
      if (this.ctx.state === 'suspended') await this.ctx.resume();

      this.source = this.ctx.createMediaStreamSource(this.stream);

      let ok = false;
      if (this.ctx.audioWorklet) {
        try {
          const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
          await this.ctx.audioWorklet.addModule(url);
          URL.revokeObjectURL(url);
          this.node = new AudioWorkletNode(this.ctx, 'voicetype-pcm');
          this.node.port.onmessage = (e) => this._feed(e.data);
          ok = true;
        } catch (err) {
          console.warn('[VoiceType] AudioWorklet 不可用，回退 ScriptProcessor：', err);
        }
      }

      if (!ok) {
        // ScriptProcessor 已废弃但兼容性最广，作为兜底
        this.node = this.ctx.createScriptProcessor(4096, 1, 1);
        this.node.onaudioprocess = (e) => this._feed(new Float32Array(e.inputBuffer.getChannelData(0)));
      }

      // 采集节点必须连到出口才会被驱动；用 0 增益避免把麦克风声音放出来
      this.sink = this.ctx.createGain();
      this.sink.gain.value = 0;
      this.source.connect(this.node);
      this.node.connect(this.sink);
      this.sink.connect(this.ctx.destination);

      this.running = true;
      this.startedAt = Date.now();
      this.noiseFloor = 0;
      this.lastVoiceSample = 0;
      this.onStatus(this.ctx.sampleRate === TARGET_RATE ? '正在聆听…' : `正在聆听…（重采样 ${this.ctx.sampleRate}→16000）`);
    }

    _feed(frame) {
      if (!this.running) return;

      const pcm = this.ctx.sampleRate === TARGET_RATE
        ? frame
        : resample(frame, this.ctx.sampleRate, TARGET_RATE);
      const n = pcm.length;

      // --- 电平 ---
      let sum = 0;
      for (let i = 0; i < n; i++) sum += pcm[i] * pcm[i];
      const rms = Math.sqrt(sum / n);
      this.onLevel(Math.min(1, rms * 12));

      // 阈值取「固定下限」和「噪声底的若干倍」中的较大者，
      // 这样在嘈杂环境下也不会把底噪当成说话。
      const thresh = Math.max(this.speechRms, this.noiseFloor * 3);

      // 先累计，再判定——这样 lastVoiceSample 记录的是「帧尾」位置
      this.buf.push(pcm);
      this.bufLen += n;
      this.totalSamples += n;

      if (rms > thresh) {
        if (!this.hasSpeech) {
          this.hasSpeech = true;
          this.segStartSample = this.totalSamples - n;   // 段落从真正开口处算起
        }
        this.lastVoiceSample = this.totalSamples;
      } else {
        // 噪声底只在「非语音」帧跟进，并且加一个上限。
        //
        // 早先的写法是无条件跟进，连续说话时噪声底会一路爬升到人声电平
        // （时间常数约 1.6s），阈值随之变成人声的 3 倍，VAD 直接「聋掉」。
        // 症状：11 秒的音频只切出前 2 秒。上限 speechRms*4 保证再吵也不会
        // 把阈值抬到人声量级以上。
        this.noiseFloor = Math.min(this.noiseFloor * 0.99 + rms * 0.01, this.speechRms * 4);
      }

      const segMs = (this.bufLen / TARGET_RATE) * 1000;
      // 静音时长也用采样计数算，不用 wall-clock：
      // 后台标签页会被节流，Date.now() 会跑在采样前面，导致误切段。
      const silentMs = ((this.totalSamples - this.lastVoiceSample) / TARGET_RATE) * 1000;

      // 说完一句（有停顿且够长）或撞到上限，就切段
      if ((this.hasSpeech && silentMs >= this.silenceMs && segMs >= this.minSegMs) ||
          (segMs >= this.maxSegMs)) {
        this._flush();
      }
    }

    /** 把当前累积的段落交出去 */
    _flush() {
      if (!this.hasSpeech || this.bufLen === 0) {
        this.buf = []; this.bufLen = 0; this.hasSpeech = false;
        return;
      }

      const pcm = new Float32Array(this.bufLen);
      let off = 0;
      for (const b of this.buf) { pcm.set(b, off); off += b.length; }

      const meta = {
        startMs: (this.segStartSample / TARGET_RATE) * 1000,
        endMs:   (this.totalSamples / TARGET_RATE) * 1000,
        seconds: this.bufLen / TARGET_RATE,
      };

      this.buf = [];
      this.bufLen = 0;
      this.hasSpeech = false;
      this.segStartSample = this.totalSamples;
      this.lastVoiceSample = this.totalSamples;

      this.onSegment(pcm, meta);
    }

    /** 停止采集；若还有没交出去的音频，先交出去 */
    async stop() {
      if (!this.running) return;
      this.running = false;
      try { this._flush(); } catch (_) {}

      try { this.node?.disconnect(); } catch (_) {}
      try { this.sink?.disconnect(); } catch (_) {}
      try { this.source?.disconnect(); } catch (_) {}
      try { this.stream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
      try { await this.ctx?.close(); } catch (_) {}

      this.node = this.source = this.sink = this.ctx = this.stream = null;
      this.buf = []; this.bufLen = 0; this.hasSpeech = false;
      this.noiseFloor = 0;
      this.lastVoiceSample = 0;
    }

    /** 会话已进行的毫秒数 */
    elapsedMs() { return this.startedAt ? Date.now() - this.startedAt : 0; }
  }

  return { Capture, TARGET_RATE, resample };
})();
