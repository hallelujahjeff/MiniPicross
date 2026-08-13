/**
 * 音效（WebAudio 实时合成，零资源文件）
 *
 * ## 为什么合成而不是加载 wav
 *  - 不引入二进制资源，仓库干净、加载没有额外请求；
 *  - 每次触发都能做**微小随机化**（音高/带宽/衰减），连续敲十几下不会变成
 *    机关枪一样的复读，这对"敲方块"这种高频操作的手感至关重要；
 *  - "清脆"的物理直觉可以直接翻译成参数：极短的攻击（4ms）、
 *    带通到 3kHz 的噪声冲击（脆裂的"咔"）、外加一个快速下滑的正弦（碎块的"叮"）。
 *
 * ## 浏览器自动播放策略
 * AudioContext 必须在用户手势里创建/恢复，否则处于 suspended。
 * 因此这里惰性创建，并在每次播放前尝试 resume()；调用方也可以在
 * 第一次 pointerdown 时主动调 unlock()。
 */

/** 主音量（0..1） */
const DEFAULT_VOLUME = 0.55;

export class SoundKit {
  constructor({ volume = DEFAULT_VOLUME, muted = false } = {}) {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    this.volume = volume;
    this.muted = muted;
    this.supported =
      typeof window !== "undefined" &&
      Boolean(window.AudioContext || window.webkitAudioContext);
    this._lastSliceAt = 0;
  }

  /** 在用户手势里调用，尽早把音频上下文拉起来 */
  unlock() {
    const ctx = this._ensure();
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    return Boolean(ctx);
  }

  setMuted(flag) {
    this.muted = Boolean(flag);
    if (this.master) {
      this.master.gain.value = this.muted ? 0 : this.volume;
    }
    return this.muted;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && !this.muted) this.master.gain.value = this.volume;
  }

  /** 正确凿除：清脆的碎裂声 */
  playBreak() {
    const ctx = this._ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const rand = Math.random();

    // 主体：带通噪声冲击 —— "咔"
    this._noiseBurst(ctx, t, {
      filter: "bandpass",
      frequency: 2600 + rand * 1600,
      Q: 0.9 + rand * 0.6,
      peak: 0.9,
      attack: 0.004,
      decay: 0.085 + rand * 0.02,
    });

    // 泛音：快速下滑的三角波 —— 碎块的"叮"
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(1450 + rand * 500, t);
    osc.frequency.exponentialRampToValueAtTime(620 + rand * 160, t + 0.075);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.3, t + 0.005);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    osc.connect(og).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.12);
  }

  /** 敲错：低沉的闷响 + 一点粗糙感 */
  playMistake() {
    const ctx = this._ready();
    if (!ctx) return;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(210, t);
    osc.frequency.exponentialRampToValueAtTime(78, t + 0.2);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(320, t + 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.45, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    osc.connect(lp).connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.3);

    this._noiseBurst(ctx, t, {
      filter: "bandpass",
      frequency: 480,
      Q: 0.7,
      peak: 0.28,
      attack: 0.005,
      decay: 0.1,
    });
  }

  /** 标记：轻快上扬的小提示音 */
  playPaint() {
    this._blip(880, 1240, 0.075, 0.2);
  }

  /** 取消标记：下行 */
  playUnpaint() {
    this._blip(760, 520, 0.07, 0.16);
  }

  /** 敲到受保护方块：短促的木质"哒" */
  playBlocked() {
    const ctx = this._ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(330, t);
    osc.frequency.exponentialRampToValueAtTime(240, t + 0.05);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    osc.connect(lp).connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.08);
  }

  /**
   * 截面拖动：极轻的"沙"声
   * 拖动会每帧触发，内部按 45ms 节流，避免叠成噪音墙。
   */
  playSlice() {
    const ctx = this._ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    if (t - this._lastSliceAt < 0.045) return;
    this._lastSliceAt = t;

    this._noiseBurst(ctx, t, {
      filter: "highpass",
      frequency: 2200 + Math.random() * 900,
      peak: 0.075,
      attack: 0.004,
      decay: 0.05,
    });
  }

  /**
   * 整行完成：明亮的上行三音
   *
   * 和"通关琶音"故意用同一套音阶但更短、更高，形成"小成就 → 大成就"的递进；
   * 连锁完成多行时把起始音一并推高，连着响不会糊成一团。
   * @param {number} [chain] 本次同时完成了几行
   */
  playLineClear(chain = 1) {
    const ctx = this._ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    // 连锁越多，整体音高越高（半音 × 2 一档，最多推 4 档）
    const shift = 2 ** ((Math.min(4, chain - 1) * 2) / 12);
    [783.99, 987.77, 1318.51].forEach((freq, i) => {
      const at = t + i * 0.055;
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = freq * shift;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.17, at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
      osc.connect(g).connect(this.master);
      osc.start(at);
      osc.stop(at + 0.24);
    });
  }

  /** 通关：小三音琶音 */
  playWin() {
    const ctx = this._ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      const at = t + i * 0.095;
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.24, at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);
      osc.connect(g).connect(this.master);
      osc.start(at);
      osc.stop(at + 0.38);
    });
  }

  dispose() {
    this.ctx?.close?.().catch?.(() => {});
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
  }

  /** 简单的两点滑音正弦提示音 */
  _blip(from, to, duration, peak) {
    const ctx = this._ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration + 0.02);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  /** 惰性创建音频上下文与主总线 */
  _ensure() {
    if (this.ctx) return this.ctx;
    if (!this.supported) return null;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctor();

      // 限幅器：连续快速敲击时避免叠加削波
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.knee.value = 6;
      limiter.ratio.value = 8;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.12;

      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : this.volume;
      master.connect(limiter).connect(ctx.destination);

      this.ctx = ctx;
      this.master = master;
      return ctx;
    } catch (err) {
      console.warn("[SoundKit] 无法创建 AudioContext，音效已禁用", err);
      this.supported = false;
      return null;
    }
  }

  /** 播放前的统一准备：上下文可用且未静音 */
  _ready() {
    if (this.muted) return null;
    const ctx = this._ensure();
    if (!ctx) return null;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }

  /**
   * 一次滤波噪声冲击（"咔 / 沙 / 闷" 三类音色的共同骨架）
   *
   * 复用同一份白噪声缓冲，靠 start(when, offset) 的随机偏移取不同噪声段，
   * 这样既不必每次生成随机数组，听起来也不会有复读感。
   *
   * @param {AudioContext} ctx
   * @param {number} t 起始时刻
   * @param {{filter:BiquadFilterType, frequency:number, Q?:number,
   *          peak:number, attack:number, decay:number}} spec
   */
  _noiseBurst(ctx, t, spec) {
    if (!this.noiseBuffer) {
      const length = Math.floor(ctx.sampleRate * 0.5);
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buffer;
    }

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = spec.filter;
    filter.frequency.value = spec.frequency;
    if (spec.Q !== undefined) filter.Q.value = spec.Q;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(spec.peak, t + spec.attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + spec.decay);

    src.connect(filter).connect(gain).connect(this.master);
    // 缓冲 0.5s、随机偏移最多 0.3s，剩余 0.2s 足以覆盖最长的一次冲击
    src.start(t, Math.random() * 0.3);
    src.stop(t + spec.decay + 0.03);
    return gain;
  }
}
