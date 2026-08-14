/**
 * 背景音乐播放器（WebAudio 实时合成，零资源文件）
 *
 * 与 SoundKit（音效）同路线：不加载任何音频文件，全部用振荡器 + 滤波 +
 * 混响实时算出。这样 BGM 也保持"零二进制资源、零版权风险、加载零额外请求"。
 *
 * ## 曲目编排
 *  - **关卡内**：轻快组 6 首（晨间咖啡 / 八音盒的午后 / 旋转木马 /
 *    落日漫步 / 柠檬汽水 / 纸飞机），每次进关**随机选一首**无缝循环。
 *  - **选关界面**：舒缓组「微光」（Minecraft OST 风，无鼓、大量留白）。
 *
 * ## 与 SoundKit 的关系
 * 各自持有独立的 AudioContext。理由：
 *  - 生命周期不同——BGM 跨"选关 → 关卡 → 选关"全程响，音效只在关卡内响；
 *  - 音量独立——BGM 总音量比音效低一档，避免盖过碎裂声，两个 master gain 各管各的；
 *  - 互不干扰——BGM 的调度器（setInterval）与音效的一次性 trigger 完全解耦。
 * 现代浏览器允许同时存在多个 AudioContext（上限约 6 个），这里只用 2 个，安全。
 *
 * ## 自动播放策略
 * 浏览器要求 AudioContext 在用户手势里创建/恢复。因此：
 *  - 首次加载停在选关界面时是静音的（没有手势，无法响）；
 *  - 用户第一次 pointerdown 时调用 unlock() 拉起上下文并开播当前场景的 BGM。
 * 见 main.js 里的 onFirstGesture 协调逻辑。
 *
 * ## 无缝循环
 * 按"小节"调度：每小节 4 拍，8 小节为一圈，结尾自然接回开头（和弦进行是
 * 首尾闭合的），所以循环处没有明显的接缝。
 */

const BGM_VOLUME = 0.5;

const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * 曲目结构：
 *   chords : [根音midi, 五度midi, [垫和弦 4 音]]
 *   lead   : 每行一小节，8 个八分音符位（midi 或 null；null = 休止）
 *   calm   : true → 无鼓、慢起 pad、长混响、旋律长音（Minecraft OST 风）
 *   arpSlots: 伴奏琶音落在哪几个八分位（舒缓组只落少数几个，制造留白）
 *   arpVoice: 伴奏琶音用的音色（默认 glock）
 */

/** 轻快组：关卡内随机循环 */
const LEVEL_SONGS = [
  {
    id: "morning", voice: "glock", bpm: 88,
    chords: [[41,48,[53,57,60,64]],[40,47,[52,55,59,62]],[38,45,[50,53,57,60]],[36,43,[48,52,55,59]],
             [33,40,[57,60,64,67]],[38,45,[50,53,57,60]],[31,38,[55,59,62,65]],[36,43,[60,64,67,71]]],
    lead: [[69,72,69,67,69,72,null,76],[71,67,64,62,64,67,null,74],[69,65,62,60,62,65,null,72],
           [67,64,60,59,60,64,null,71],[72,69,64,60,64,69,72,null],[74,72,69,65,69,72,74,null],
           [71,67,65,62,65,67,71,null],[72,null,67,null,64,null,60,null]],
  },
  {
    id: "afternoon", voice: "musicbox", bpm: 76,
    chords: [[43,50,[59,62,66,69]],[40,47,[52,55,59,62]],[38,45,[50,53,57,60]],[43,50,[59,62,66,69]],
             [36,43,[52,55,59,62]],[38,45,[50,53,57,60]],[45,52,[56,60,62,66]],[43,50,[59,62,66,69]]],
    lead: [[74,71,67,62,66,67,71,null],[71,67,64,59,62,64,67,null],[69,65,62,57,60,62,65,null],
           [74,71,67,62,66,67,71,null],[74,72,69,65,67,69,72,null],[69,65,62,57,60,62,65,null],
           [72,68,65,60,62,65,68,null],[74,null,71,null,67,null,62,null]],
  },
  {
    id: "carousel", voice: "mellowSquare", bpm: 96,
    chords: [[41,48,[53,57,60,64]],[38,45,[50,53,57,60]],[36,43,[48,52,55,59]],[41,48,[53,57,60,64]],
             [43,50,[55,59,62,65]],[41,48,[53,57,60,64]],[31,38,[55,59,62,65]],[41,48,[53,57,60,64]]],
    lead: [[65,null,69,72,76,72,69,72],[69,72,69,65,69,null,72,null],[72,69,65,60,65,69,72,null],
           [65,null,69,72,76,72,69,72],[74,72,69,65,67,69,72,null],[65,null,69,72,76,72,69,72],
           [74,72,71,72,69,65,62,null],[65,null,null,null,null,null,null,null]],
  },
  {
    id: "sunset", voice: "marimba", bpm: 80,
    chords: [[40,47,[52,56,59,64]],[37,44,[49,52,56,59]],[45,52,[57,61,64,68]],[35,42,[51,56,59,63]],
             [40,47,[52,56,59,64]],[37,44,[49,52,56,59]],[45,52,[57,61,64,68]],[40,47,[52,56,59,64]]],
    lead: [[71,68,66,68,71,73,71,68],[69,66,64,66,69,71,69,66],[68,66,64,66,68,69,68,64],
           [66,68,71,73,75,73,71,68],[71,68,66,68,71,73,71,68],[69,66,64,66,69,71,69,66],
           [73,71,69,71,73,75,76,75],[76,null,71,null,68,null,null,null]],
  },
  {
    id: "soda", voice: "vibraphone", bpm: 94,
    chords: [[45,52,[49,52,57,61]],[38,45,[54,57,62,66]],[35,42,[50,54,57,62]],[40,47,[52,56,59,63]],
             [45,52,[49,52,57,61]],[38,45,[54,57,62,66]],[35,42,[50,54,57,62]],[45,52,[49,52,57,61]]],
    lead: [[69,null,68,69,72,null,73,72],[69,null,66,69,71,null,69,66],[67,null,66,67,71,null,69,67],
           [68,69,71,73,75,73,71,69],[69,null,68,69,72,null,73,72],[69,null,66,69,71,null,69,66],
           [71,73,75,76,75,73,71,69],[72,null,69,null,68,null,null,null]],
  },
  {
    id: "paperplane", voice: "musicbox", bpm: 84,
    chords: [[38,45,[50,54,57,62]],[35,42,[50,54,59,62]],[43,50,[55,59,62,67]],[45,52,[57,61,64,69]],
             [38,45,[50,54,57,62]],[35,42,[50,54,59,62]],[43,50,[55,59,62,67]],[38,45,[50,54,57,62]]],
    lead: [[74,69,66,69,74,78,74,69],[74,71,67,71,74,78,74,71],[76,71,67,71,76,79,76,71],
           [74,71,69,71,74,76,74,71],[74,69,66,69,74,78,74,69],[74,71,67,71,74,78,74,71],
           [76,74,73,74,76,78,79,78],[81,null,78,null,74,null,null,null]],
  },
];

/** 舒缓组：选关界面（「微光」） */
const SELECT_SONG = {
  id: "glimmer", voice: "softPiano", bpm: 66, calm: true,
  arpSlots: [0, 4], arpVoice: "softPiano",
  chords: [[36,43,[48,52,55,62]],[41,48,[53,57,60,67]],[33,40,[45,52,55,60]],[31,38,[43,47,50,57]],
           [36,43,[48,52,55,62]],[41,48,[53,57,60,67]],[38,45,[50,53,57,60]],[36,43,[48,52,55,62]]],
  lead: [[67,null,null,null,64,null,null,null],[65,null,null,67,69,null,null,null],
         [67,null,null,null,64,null,62,null],[59,null,null,62,null,null,null,null],
         [67,null,null,null,72,null,null,null],[71,null,69,null,67,null,null,null],
         [65,null,null,null,62,null,65,null],[64,null,null,null,null,null,null,null]],
};

const ARP_PATTERNS = [
  [0,1,2,3,2,1,0,2],[3,2,1,0,1,2,3,1],
  [0,2,1,3,2,0,1,3],[3,1,2,0,1,2,3,0],
];

const LOOKAHEAD = 0.4;

export class BgmPlayer {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.reverb = null;
    this.wet = null;
    this.noiseBuf = null;
    this.muted = false;
    this.running = false;
    this.timer = null;
    this.song = null;
    this.barIndex = 0;
    this.nextBarTime = 0;
  }

  /** 在用户手势里调用：创建/恢复上下文（首次开播前必须） */
  unlock() {
    this._ensure();
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    return Boolean(this.ctx);
  }

  setMuted(flag) {
    this.muted = Boolean(flag);
    if (this.master) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(
        this.muted ? 0 : BGM_VOLUME,
        this.ctx.currentTime,
        0.05,
      );
    }
    return this.muted;
  }

  /** 播放选关界面 BGM（微光） */
  playSelect() {
    this._playSong(SELECT_SONG);
  }

  /** 播放关卡内 BGM（轻快组随机一首） */
  playLevel() {
    const song = LEVEL_SONGS[Math.floor(Math.random() * LEVEL_SONGS.length)];
    this._playSong(song);
  }

  /** 停止（淡出后停调度器，保留上下文供复用） */
  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.song = null;
  }

  dispose() {
    this.stop();
    this.ctx?.close?.().catch?.(() => {});
    this.ctx = null;
    this.master = null;
    this.reverb = null;
    this.wet = null;
    this.noiseBuf = null;
  }

  /* ===================== 内部：音频图 ===================== */

  _ensure() {
    if (this.ctx) return this.ctx;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctor();
      this.ctx = ctx;

      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : BGM_VOLUME;

      // 长混响：撑起咖啡馆/空灵的空间感
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = this._makeImpulse(3.4, 2.4);
      this.wet = ctx.createGain();
      this.wet.gain.value = 0.4;
      this.reverb.connect(this.wet).connect(this.master);

      this.master.connect(ctx.destination);
      return ctx;
    } catch (err) {
      console.warn("[BgmPlayer] 无法创建 AudioContext，BGM 已禁用", err);
      this.ctx = null;
      return null;
    }
  }

  _makeImpulse(duration, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * duration);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  _makeNoise() {
    if (this.noiseBuf) return this.noiseBuf;
    this.noiseBuf = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * 0.1), this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return this.noiseBuf;
  }

  /** 音色输出总线：干声 + 混响 send */
  _bus(vol) {
    const g = this.ctx.createGain();
    g.gain.value = vol;
    const send = this.ctx.createGain();
    send.gain.value = 1;
    g.connect(send).connect(this.reverb);
    g.connect(this.master);
    return g;
  }

  /* -------- 音色 -------- */

  _glock(t, freq, dur, vol) {
    const g = this._bus(vol), lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 5000; lp.connect(g);
    [[1,1],[2,0.4],[3,0.16],[4,0.07]].forEach(([m,a]) => {
      const s = this.ctx.createOscillator(); s.type = "sine"; s.frequency.value = freq * m;
      const sg = this.ctx.createGain(); sg.gain.value = a;
      s.connect(sg).connect(lp); s.start(t); s.stop(t + dur + 0.15);
    });
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.6);
  }

  _musicbox(t, freq, dur, vol) {
    const g = this._bus(vol), lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 3800; lp.connect(g);
    [[1,1],[2,0.5],[3,0.22]].forEach(([m,a]) => {
      const s = this.ctx.createOscillator(); s.type = "sine"; s.frequency.value = freq * m;
      const sg = this.ctx.createGain(); sg.gain.value = a;
      s.connect(sg).connect(lp); s.start(t); s.stop(t + dur + 0.1);
    });
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 2.2);
  }

  _mellowSquare(t, freq, dur, vol) {
    const g = this._bus(vol), lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 1600; lp.connect(g);
    const s = this.ctx.createOscillator(); s.type = "square"; s.frequency.value = freq;
    const sg = this.ctx.createGain(); sg.gain.value = 0.5;
    s.connect(sg).connect(lp); s.start(t); s.stop(t + dur + 0.1);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  _marimba(t, freq, dur, vol) {
    const g = this._bus(vol), lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 4200; lp.connect(g);
    [[1,1],[2,0.35],[3,0.14]].forEach(([m,a]) => {
      const s = this.ctx.createOscillator(); s.type = "sine"; s.frequency.value = freq * m;
      const sg = this.ctx.createGain(); sg.gain.value = a;
      s.connect(sg).connect(lp); s.start(t); s.stop(t + dur + 0.1);
    });
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.5);
  }

  _vibraphone(t, freq, dur, vol) {
    const g = this._bus(vol);
    const trem = this.ctx.createGain(); trem.gain.value = 0;
    const lp = this.ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3800;
    lp.connect(trem).connect(g);
    [[1,1],[2,0.3],[4,0.12]].forEach(([m,a]) => {
      const s = this.ctx.createOscillator(); s.type = "sine"; s.frequency.value = freq * m;
      const sg = this.ctx.createGain(); sg.gain.value = a;
      s.connect(sg).connect(lp); s.start(t); s.stop(t + dur + 0.1);
    });
    const lfo = this.ctx.createOscillator(); lfo.frequency.value = 5.5;
    const depth = this.ctx.createGain(); depth.gain.value = 0.45;
    const dc = this.ctx.createConstantSource(); dc.offset.value = 0.55;
    lfo.connect(depth).connect(trem.gain); dc.connect(trem.gain);
    lfo.start(t); dc.start(t); lfo.stop(t + dur + 0.15); dc.stop(t + dur + 0.15);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.setValueAtTime(vol, t + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.8);
  }

  /** 柔钢琴：两个轻微失谐的三角波叠加，产生温暖朦胧的相位拍频（C418 质感） */
  _softPiano(t, freq, dur, vol) {
    const g = this._bus(vol), lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 2600; lp.connect(g);
    [[1,0.55,0],[1,0.45,7],[2,0.16,-5],[3,0.05,4]].forEach(([m,a,cents]) => {
      const s = this.ctx.createOscillator(); s.type = "triangle"; s.frequency.value = freq * m; s.detune.value = cents;
      const sg = this.ctx.createGain(); sg.gain.value = a;
      s.connect(sg).connect(lp); s.start(t); s.stop(t + dur + 0.5);
    });
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.9);
  }

  _glassBell(t, freq, dur, vol) {
    const g = this._bus(vol), lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 6500; lp.connect(g);
    [[1,1],[2.76,0.28],[5.4,0.1]].forEach(([m,a]) => {
      const s = this.ctx.createOscillator(); s.type = "sine"; s.frequency.value = freq * m;
      const sg = this.ctx.createGain(); sg.gain.value = a;
      s.connect(sg).connect(lp); s.start(t); s.stop(t + dur + 0.6);
    });
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 2.4);
  }

  _voice(name) {
    switch (name) {
      case "glock": return this._glock.bind(this);
      case "musicbox": return this._musicbox.bind(this);
      case "mellowSquare": return this._mellowSquare.bind(this);
      case "marimba": return this._marimba.bind(this);
      case "vibraphone": return this._vibraphone.bind(this);
      case "softPiano": return this._softPiano.bind(this);
      case "glassBell": return this._glassBell.bind(this);
      default: return this._glock.bind(this);
    }
  }

  _pad(t, freqs, dur, vol, soft) {
    const g = this._bus(vol), lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = soft ? 620 : 850; lp.connect(g);
    freqs.forEach((f, i) => {
      const s = this.ctx.createOscillator(); s.type = "triangle"; s.frequency.value = f;
      if (soft) s.detune.value = i % 2 ? 6 : -6;
      const sg = this.ctx.createGain(); sg.gain.value = 1 / freqs.length;
      s.connect(sg).connect(lp); s.start(t); s.stop(t + dur + 0.3);
    });
    const att = soft ? 0.9 : 0.35, rel = soft ? 0.8 : 0.3;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + att);
    g.gain.setValueAtTime(vol, t + dur - rel);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
  }

  _bass(t, freq, dur, vol) {
    const g = this._bus(vol);
    [[1,0.9],[2,0.15]].forEach(([m,a]) => {
      const s = this.ctx.createOscillator(); s.type = "sine"; s.frequency.value = freq * m;
      const sg = this.ctx.createGain(); sg.gain.value = a;
      s.connect(sg).connect(g); s.start(t); s.stop(t + dur + 0.2);
    });
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.02);
    g.gain.setValueAtTime(vol, t + dur - 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  _hat(t, vol) {
    const g = this._bus(vol), hp = this.ctx.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 7200; hp.connect(g);
    const n = this.ctx.createBufferSource(); n.buffer = this._makeNoise();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    n.connect(hp); n.start(t); n.stop(t + 0.08);
  }

  _kick(t, vol) {
    const g = this._bus(vol), o = this.ctx.createOscillator(); o.type = "sine";
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.12);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g); o.start(t); o.stop(t + 0.2);
  }

  /* ===================== 内部：调度 ===================== */

  _playSong(song) {
    if (!this._ensure()) return;
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});

    this.song = song;
    this.barIndex = 0;
    this.nextBarTime = this.ctx.currentTime + 0.12;
    this._tick();
    if (!this.timer) this.timer = setInterval(() => this._tick(), 100);
    this.running = true;
  }

  _tick() {
    while (this.nextBarTime < this.ctx.currentTime + LOOKAHEAD) {
      this._scheduleBar();
    }
  }

  _scheduleBar() {
    const song = this.song;
    const BEAT = 60 / song.bpm;
    const BAR = BEAT * 4;
    const t = this.nextBarTime;
    const chord = song.chords[this.barIndex];
    const leadRow = song.lead[this.barIndex];
    const leadFn = this._voice(song.voice);
    const calm = Boolean(song.calm);

    // 混响湿度：舒缓组更湿，空间更大
    if (this.wet) this.wet.gain.value = calm ? 0.62 : 0.4;

    // 和弦垫
    this._pad(t, chord[2].map(midiToFreq), BAR * 0.99, calm ? 0.085 : 0.07, calm);

    // 贝斯：舒缓组只在第 1 拍给一个长根音，轻快组走根音 + 五度
    if (calm) {
      this._bass(t, midiToFreq(chord[0]), BAR * 0.9, 0.15);
    } else {
      this._bass(t, midiToFreq(chord[0]), BEAT * 1.85, 0.18);
      this._bass(t + BEAT * 2, midiToFreq(chord[1]), BEAT * 1.6, 0.13);
    }

    // 伴奏琶音
    const arp = ARP_PATTERNS[this.barIndex % ARP_PATTERNS.length];
    const arpFn = this._voice(song.arpVoice ?? "glock");
    const slots = song.arpSlots ?? [0,1,2,3,4,5,6,7];
    slots.forEach((i) => {
      const dur = calm ? BEAT * 2.2 : BEAT * 0.9;
      arpFn(t + i * BEAT * 0.5, midiToFreq(chord[2][arp[i]]), dur, calm ? 0.055 : 0.05);
    });

    // 主旋律：时长取到下一个音为止，稀疏旋律自然变成长音
    for (let i = 0; i < 8; i++) {
      const m = leadRow[i];
      if (m == null) continue;
      let next = i + 1;
      while (next < 8 && leadRow[next] == null) next++;
      const span = next - i;
      const dur = BEAT * 0.5 * span * (calm ? 1.35 : 1.0);
      leadFn(t + i * BEAT * 0.5, midiToFreq(m), dur, calm ? 0.155 : 0.16);
    }

    // 鼓：舒缓组完全不用（Minecraft 平静曲目的关键特征）
    if (!calm) {
      this._hat(t + BEAT, 0.028);
      this._hat(t + BEAT * 3, 0.028);
      this._kick(t, 0.1);
    }

    this.barIndex = (this.barIndex + 1) % song.lead.length;
    this.nextBarTime += BAR;
  }
}
