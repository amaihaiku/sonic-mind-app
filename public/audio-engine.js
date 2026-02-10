/**
 * SonicMind AudioEngine — FINAL (Full Mix / Pop-Rock tuned)
 *
 * Must-haves implemented:
 * - Spectral Whitening (_whitenWindow = 25)
 * - HPS bass stability (_hpsHarmonics = 4, bassStableMs = 280ms)
 * - Harmonic/Percussive Separation Bias (transient downweighting) for drum-heavy mixes
 * - Key-invariant chroma smoothing (circular PC smoothing + peak sharpening + EMA, chromaTimeConstantMs = 220ms)
 * - Chord hysteresis (chordStableMs = 320ms)
 * - Local file offline decoding (decodeAudioData) + buffer playback
 * - Stream playback via HTMLMediaElement (YouTube proxy)
 *
 * Note:
 * - We use AnalyserNode for FFT bins. That’s native DSP, not ML.
 * - For local files we decode to AudioBuffer and play via AudioBufferSourceNode.
 */

export class AudioEngine {
  constructor({
    fftSize = 4096,
    smoothingTimeConstant = 0.0,

    // Golden Settings (Full Mix: YouTube Pop/Rock)
    chromaTimeConstantMs = 220,
    chordStableMs = 320,
    bassStableMs = 280
  } = {}) {
    this.fftSize = fftSize;
    this.smoothingTimeConstant = smoothingTimeConstant;

    // Golden Settings
    this._chromaTC = chromaTimeConstantMs;
    this._stableMs = chordStableMs;
    this._bassStableMs = bassStableMs;

    // Core nodes
    this.ctx = null;
    this.analyser = null;
    this.bassAnalyser = null;
    this.focusFilter = null;
    this.bassFilter = null;

    // For stream mode (media element)
    this.mediaEl = null;
    this.mediaSource = null;

    // For buffer mode (local decoded audio)
    this.buffer = null;
    this.bufferSource = null;
    this._bufferStartCtxTime = 0;
    this._bufferOffsetSec = 0;
    this._bufferPlaying = false;
    this._bufferPlaybackRate = 1.0;

    // Shared graph input node (either MediaElementSource or BufferSource)
    this.sourceNode = null;

    // FFT buffers
    this.freqData = null;
    this.bassFreqData = null;
    this.timeData = null;

    // Float spectra (whitened)
    this._spec = null;
    this._bassSpec = null;

    // Whitening
    this._whitenWindow = 25; // bins half-window (Golden Setting)
    this._whitenEps = 1e-6;

    // Chroma
    this.PC = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    this.A4 = 440;
    this._fMin = 55;
    this._fMax = 5500;

    this._chromaRaw = new Float32Array(12);
    this._chromaSmoothed = new Float32Array(12);
    this._chromaEMA = new Float32Array(12);
    this._lastChromaTs = 0;

    // HPSS bias (transient downweighting)
    // Maintain a per-bin EMA "harmonic estimate" and compute "percussive residual"
    // Then weight bins by harmonicRatio = H / (H + P).
    this._harmonicSpecEMA = null;
    this._lastSpecTs = 0;
    this._harmonicTC = 110; // ms (tuned for full mix; slower than percussive transients)
    this._hpssEps = 1e-6;

    // Bass via HPS
    this._bassMinHz = 30;
    this._bassMaxHz = 280;
    this._hpsHarmonics = 4; // Golden Setting

    // Bass stability state
    this._bassPc = null;
    this._bassCandidate = null;
    this._bassCandidateSince = 0;

    // Chord templates + hysteresis
    this.templates = this._buildChordTemplates();
    this.lastChord = "—";
    this._candidateChord = "—";
    this._candidateSince = 0;

    // Timeline events
    this.events = []; // {t, chord, conf, overridden?, userChord?}

    // BPM detector
    this._energyHistory = [];
    this._energyHistorySize = 90;
    this._onsets = [];
    this._lastOnsetTime = -999;

    // Scratch
    this._scratchPrefix = null;
    this._scratchHPS = null;
  }

  /* -------------------------- Init / Graph -------------------------- */

  async init() {
    if (this.ctx) return;

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    this.analyser.smoothingTimeConstant = this.smoothingTimeConstant;

    this.bassAnalyser = this.ctx.createAnalyser();
    this.bassAnalyser.fftSize = this.fftSize;
    this.bassAnalyser.smoothingTimeConstant = 0.0;

    this.focusFilter = this.ctx.createBiquadFilter();
    this.focusFilter.type = "allpass";
    this.focusFilter.frequency.value = 1000;

    this.bassFilter = this.ctx.createBiquadFilter();
    this.bassFilter.type = "lowpass";
    this.bassFilter.frequency.value = 250;
    this.bassFilter.Q.value = 0.707;

    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.bassFreqData = new Uint8Array(this.bassAnalyser.frequencyBinCount);
    this.timeData = new Float32Array(this.analyser.fftSize);

    this._spec = new Float32Array(this.analyser.frequencyBinCount);
    this._bassSpec = new Float32Array(this.bassAnalyser.frequencyBinCount);

    this._harmonicSpecEMA = new Float32Array(this.analyser.frequencyBinCount);

    // Stream player (media element)
    this.mediaEl = new Audio();
    this.mediaEl.crossOrigin = "anonymous";
    this.mediaEl.preload = "auto";
    this.mediaEl.preservesPitch = true;
    this.mediaEl.webkitPreservesPitch = true;
  }

  _disconnectGraph() {
    try {
      this.sourceNode?.disconnect();
      this.focusFilter?.disconnect();
      this.analyser?.disconnect();
      this.bassFilter?.disconnect();
      this.bassAnalyser?.disconnect();
    } catch (_) {}
    this.sourceNode = null;
  }

  _connectGraphFromSource(sourceNode) {
    // Graph:
    // Source -> FocusFilter -> Analyser -> Destination
    // Source -> BassFilter -> BassAnalyser
    this._disconnectGraph();

    this.sourceNode = sourceNode;

    this.sourceNode.connect(this.focusFilter);
    this.focusFilter.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this.sourceNode.connect(this.bassFilter);
    this.bassFilter.connect(this.bassAnalyser);
  }

  _resetAnalysisState() {
    this.lastChord = "—";
    this._candidateChord = "—";
    this._candidateSince = 0;

    this._bassPc = null;
    this._bassCandidate = null;
    this._bassCandidateSince = performance.now();

    this.events = [];
    this._energyHistory = [];
    this._onsets = [];
    this._lastOnsetTime = -999;

    this._chromaEMA.fill(0);
    this._chromaSmoothed.fill(0);
    this._chromaRaw.fill(0);

    this._harmonicSpecEMA.fill(0);
    this._lastChromaTs = performance.now();
    this._lastSpecTs = performance.now();
  }

  /* -------------------------- Source Loading -------------------------- */

  async setSourceFromStream(proxyUrl) {
    await this.init();
    this.stop();

    // Stream mode active
    this.buffer = null;
    this._bufferOffsetSec = 0;
    this._bufferPlaying = false;

    // Create/replace MediaElementSource
    this.mediaEl.src = proxyUrl;
    await this.mediaEl.load?.();

    if (this.mediaSource) {
      try {
        this.mediaSource.disconnect();
      } catch (_) {}
      this.mediaSource = null;
    }

    this.mediaSource = this.ctx.createMediaElementSource(this.mediaEl);
    this._connectGraphFromSource(this.mediaSource);
    this._resetAnalysisState();
  }

  /**
   * Local file mode: decodeAudioData from an ArrayBuffer (offline-ready).
   * app.js should use FileReader.readAsArrayBuffer and pass the result here.
   */
  async loadFromFileArrayBuffer(arrayBuffer) {
    await this.init();
    this.stop();

    // Buffer mode active
    this.mediaEl.src = "";
    this.mediaEl.load?.();
    this.mediaSource = null;

    // decodeAudioData: copy buffer to avoid neutering in some browsers
    const ab = arrayBuffer.slice(0);
    const audioBuffer = await new Promise((resolve, reject) => {
      this.ctx.decodeAudioData(
        ab,
        (buf) => resolve(buf),
        (err) => reject(err)
      );
    });

    this.buffer = audioBuffer;
    this._bufferOffsetSec = 0;
    this._bufferPlaying = false;

    this._resetAnalysisState();

    // Build a dummy source on play()
    // (We connect graph each time we create a BufferSource)
  }

  /* -------------------------- Playback -------------------------- */

  async play() {
    if (!this.ctx) return;
    if (this.ctx.state === "suspended") await this.ctx.resume();

    // Buffer mode
    if (this.buffer) {
      if (this._bufferPlaying) return;

      // Create fresh BufferSource (one-shot)
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffer;
      src.playbackRate.value = this._bufferPlaybackRate;

      // When finished naturally
      src.onended = () => {
        // If it ended because stop() was called, we’ll have already set flags.
        if (this._bufferPlaying) {
          this._bufferPlaying = false;
          // Snap offset to end
          this._bufferOffsetSec = Math.min(this.duration, this._bufferOffsetSec + 0.0001);
        }
      };

      this.bufferSource = src;
      this._connectGraphFromSource(src);

      this._bufferStartCtxTime = this.ctx.currentTime;
      this._bufferPlaying = true;

      // Start at current offset
      const offset = Math.max(0, Math.min(this._bufferOffsetSec, this.duration));
      src.start(0, offset);

      return;
    }

    // Stream mode
    if (this.mediaEl?.src) {
      return this.mediaEl.play();
    }
  }

  pause() {
    // Buffer mode
    if (this.buffer && this._bufferPlaying) {
      // Compute elapsed in buffer time: dt * playbackRate
      const dt = this.ctx.currentTime - this._bufferStartCtxTime;
      this._bufferOffsetSec += dt * this._bufferPlaybackRate;

      this._bufferPlaying = false;
      try {
        this.bufferSource?.stop();
      } catch (_) {}
      this.bufferSource = null;
      this._disconnectGraph();
      return;
    }

    // Stream mode
    this.mediaEl?.pause();
  }

  stop() {
    // Stop buffer mode
    if (this.buffer) {
      try {
        this.bufferSource?.stop();
      } catch (_) {}
      this.bufferSource = null;
      this._bufferPlaying = false;
      this._bufferOffsetSec = 0;
      this._disconnectGraph();
      return;
    }

    // Stop stream mode
    if (this.mediaEl) {
      this.mediaEl.pause();
      try {
        this.mediaEl.currentTime = 0;
      } catch (_) {}
    }
    this._disconnectGraph();
  }

  setPlaybackRate(rate) {
    const r = Math.max(0.5, Math.min(1.0, Number(rate) || 1.0));

    // Buffer mode
    if (this.buffer) {
      // If currently playing, pause -> update -> play to apply cleanly
      const wasPlaying = this._bufferPlaying;
      if (wasPlaying) this.pause();
      this._bufferPlaybackRate = r;
      if (wasPlaying) this.play();
      return;
    }

    // Stream mode
    if (this.mediaEl) this.mediaEl.playbackRate = r;
  }

  setFocusEQ(mode) {
    if (!this.focusFilter) return;

    if (mode === "bass") {
      this.focusFilter.type = "lowpass";
      this.focusFilter.frequency.value = 350;
      this.focusFilter.Q.value = 0.707;
    } else if (mode === "mid") {
      this.focusFilter.type = "bandpass";
      this.focusFilter.frequency.value = 1200;
      this.focusFilter.Q.value = 0.95;
    } else {
      this.focusFilter.type = "allpass";
      this.focusFilter.frequency.value = 1000;
      this.focusFilter.Q.value = 0.707;
    }
  }

  get isPlaying() {
    if (this.buffer) return this._bufferPlaying;
    return this.mediaEl && !this.mediaEl.paused && !this.mediaEl.ended;
  }

  get currentTime() {
    if (this.buffer) {
      if (!this._bufferPlaying) return this._bufferOffsetSec;
      const dt = this.ctx.currentTime - this._bufferStartCtxTime;
      return this._bufferOffsetSec + dt * this._bufferPlaybackRate;
    }
    return this.mediaEl?.currentTime ?? 0;
  }

  get duration() {
    if (this.buffer) return this.buffer.duration || 0;
    return this.mediaEl?.duration ?? 0;
  }

  /* -------------------------- Main Tick -------------------------- */

  tick() {
    if (!this.analyser || !this.bassAnalyser) {
      return { freqData: null, chord: "—", confidence: 0, bpm: null, chroma: null };
    }

    // If nothing is connected/playing, still allow UI to render spectrogram background
    this.analyser.getByteFrequencyData(this.freqData);
    this.bassAnalyser.getByteFrequencyData(this.bassFreqData);
    this.analyser.getFloatTimeDomainData(this.timeData);

    // Whitening
    this._computeWhitenedSpectrum(this.freqData, this._spec, this._whitenWindow);
    this._computeWhitenedSpectrum(this.bassFreqData, this._bassSpec, this._whitenWindow);

    // HPSS bias: update harmonic EMA and compute harmonic ratio per bin
    const harmonicRatio = this._updateHPSSAndGetHarmonicRatio(this._spec);

    // Chroma from (whitened spec * harmonicRatio) -> key-invariant smoothing
    const chromaRaw = this._computeChromaFromWhitened(this._spec, harmonicRatio);
    const chroma = this._keyInvariantChromaSmoothing(chromaRaw);

    // Bass via HPS (stable)
    const bassPc = this._detectBassPitchClassHPS(this._bassSpec);

    // Chord detect + hysteresis
    const { chord, confidence } = this._detectChord(chroma, bassPc);
    const stableChord = this._applyChordHysteresis(chord);

    // BPM
    const bpm = this._estimateBPMFromEnergy();

    return { freqData: this.freqData, chord: stableChord, confidence, bpm, chroma };
  }

  /* -------------------------- Spectral Whitening -------------------------- */

  _computeWhitenedSpectrum(byteData, outFloat, halfWindowBins) {
    const n = byteData.length;

    // Convert to mag w/ gamma (noise suppression)
    for (let i = 0; i < n; i++) {
      const x = byteData[i] / 255;
      outFloat[i] = x * x;
    }

    // Prefix sums for moving avg envelope
    const prefix = this._getScratchPrefix(n + 1);
    prefix[0] = 0;
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + outFloat[i];

    const eps = this._whitenEps;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - halfWindowBins);
      const b = Math.min(n - 1, i + halfWindowBins);
      const env = (prefix[b + 1] - prefix[a]) / (b - a + 1);
      outFloat[i] = outFloat[i] / (env + eps);
    }

    // Normalize by max
    let max = 0;
    for (let i = 0; i < n; i++) if (outFloat[i] > max) max = outFloat[i];
    if (max > 0) {
      const inv = 1 / max;
      for (let i = 0; i < n; i++) outFloat[i] *= inv;
    }
  }

  _getScratchPrefix(len) {
    if (!this._scratchPrefix || this._scratchPrefix.length < len) {
      this._scratchPrefix = new Float32Array(len);
    }
    return this._scratchPrefix;
  }

  /* -------------------------- HPSS Bias (Transient Downweighting) -------------------------- */

  /**
   * Returns a Float32Array harmonicRatio per bin in [0..1].
   * harmonicRatio ~ 1 => stable/harmonic content
   * harmonicRatio ~ 0 => transient/percussive content
   */
  _updateHPSSAndGetHarmonicRatio(whitenedSpec) {
    const now = performance.now();
    const dt = Math.max(1, now - (this._lastSpecTs || now));
    this._lastSpecTs = now;

    // EMA alpha for harmonic estimate
    const tau = Math.max(20, this._harmonicTC); // ms
    const alpha = 1 - Math.exp(-dt / tau);

    const H = this._harmonicSpecEMA;
    const n = whitenedSpec.length;

    // Allocate harmonicRatio scratch
    if (!this._harmonicRatioScratch || this._harmonicRatioScratch.length !== n) {
      this._harmonicRatioScratch = new Float32Array(n);
    }
    const R = this._harmonicRatioScratch;

    const eps = this._hpssEps;

    for (let i = 0; i < n; i++) {
      const x = whitenedSpec[i];

      // Update harmonic EMA (stable component)
      H[i] = (1 - alpha) * H[i] + alpha * x;

      // Percussive residual (transient-ish): only positive spikes beyond harmonic baseline
      const p = Math.max(0, x - H[i]);

      // Harmonic ratio (soft mask)
      // If p dominates => ratio small. If H dominates => ratio near 1.
      const ratio = H[i] / (H[i] + p + eps);

      // Extra transient suppression curve (aggressive for drums)
      // ratio^gamma -> pushes small ratios closer to 0
      R[i] = Math.pow(ratio, 1.8);
    }

    return R;
  }

  /* -------------------------- Chroma -------------------------- */

  _computeChromaFromWhitened(whitenedSpec, harmonicRatio /* Float32Array */) {
    this._chromaRaw.fill(0);

    const sr = this.ctx.sampleRate;
    const nFFT = this.analyser.fftSize;
    const binCount = whitenedSpec.length;

    for (let i = 1; i < binCount; i++) {
      // Weight down transients: harmonicRatio[i] in [0..1]
      const mag = whitenedSpec[i] * (harmonicRatio ? harmonicRatio[i] : 1.0);
      if (mag < 0.02) continue;

      const freq = (i * sr) / nFFT;
      if (freq < this._fMin || freq > this._fMax) continue;

      const midi = this._freqToMidi(freq);
      const pc = ((Math.round(midi) % 12) + 12) % 12;

      // Emphasize strong/consistent partials
      this._chromaRaw[pc] += Math.pow(mag, 1.25);
    }

    this._normalize12(this._chromaRaw);
    return this._chromaRaw;
  }

  _keyInvariantChromaSmoothing(chromaIn) {
    // Circular smoothing (shift-invariant)
    const tmp = this._chromaSmoothed;
    for (let k = 0; k < 12; k++) {
      const km2 = (k + 10) % 12;
      const kp2 = (k + 2) % 12;
      const km1 = (k + 11) % 12;
      const kp1 = (k + 1) % 12;

      tmp[k] =
        0.56 * chromaIn[k] +
        0.12 * (chromaIn[km1] + chromaIn[kp1]) +
        0.10 * (chromaIn[km2] + chromaIn[kp2]);
    }

    // Peak sharpening
    for (let k = 0; k < 12; k++) tmp[k] = Math.pow(Math.max(0, tmp[k]), 1.35);

    this._normalize12(tmp);

    // Temporal EMA with time constant (Golden Setting: 220ms)
    const now = performance.now();
    const dt = Math.max(1, now - (this._lastChromaTs || now));
    this._lastChromaTs = now;

    const tau = Math.max(10, this._chromaTC);
    const alpha = 1 - Math.exp(-dt / tau);

    for (let k = 0; k < 12; k++) {
      this._chromaEMA[k] = (1 - alpha) * this._chromaEMA[k] + alpha * tmp[k];
    }

    this._normalize12(this._chromaEMA);
    return this._chromaEMA;
  }

  _normalize12(v) {
    let s = 0;
    for (let i = 0; i < 12; i++) s += v[i] * v[i];
    const n = Math.sqrt(s);
    if (n > 0) {
      const inv = 1 / n;
      for (let i = 0; i < 12; i++) v[i] *= inv;
    }
  }

  _freqToMidi(freq) {
    return 69 + 12 * Math.log2(freq / this.A4);
  }

  /* -------------------------- Bass via HPS -------------------------- */

  _detectBassPitchClassHPS(whitenedBassSpec) {
    const sr = this.ctx.sampleRate;
    const nFFT = this.bassAnalyser.fftSize;

    const binMin = Math.max(1, Math.floor((this._bassMinHz * nFFT) / sr));
    const binMax = Math.min(whitenedBassSpec.length - 1, Math.floor((this._bassMaxHz * nFFT) / sr));
    if (binMax <= binMin + 8) return this._applyBassStability(null);

    const len = binMax + 1;
    const hps = this._getScratchHPS(len);
    for (let i = 0; i < len; i++) hps[i] = whitenedBassSpec[i];

    const H = this._hpsHarmonics; // Golden Setting: 4
    for (let h = 2; h <= H; h++) {
      for (let i = binMin; i <= binMax; i++) {
        const j = i * h;
        if (j > binMax) break;
        hps[i] *= Math.max(whitenedBassSpec[j], 1e-3);
      }
    }

    let bestI = -1;
    let bestV = 0;
    for (let i = binMin; i <= binMax; i++) {
      const v = hps[i];
      if (v > bestV) {
        bestV = v;
        bestI = i;
      }
    }

    if (bestI < 0 || bestV < 0.02) {
      return this._applyBassStability(null);
    }

    const freq = (bestI * sr) / nFFT;
    const midi = this._freqToMidi(freq);
    const pc = ((Math.round(midi) % 12) + 12) % 12;

    return this._applyBassStability(pc);
  }

  _getScratchHPS(len) {
    if (!this._scratchHPS || this._scratchHPS.length < len) {
      this._scratchHPS = new Float32Array(len);
    }
    return this._scratchHPS;
  }

  _applyBassStability(pc) {
    const now = performance.now();

    // If detection missing, release slowly
    if (pc === null) {
      if (this._bassPc !== null && now - this._bassCandidateSince > 900) {
        this._bassPc = null;
      }
      return this._bassPc;
    }

    if (pc === this._bassPc) {
      this._bassCandidate = pc;
      this._bassCandidateSince = now;
      return this._bassPc;
    }

    if (pc !== this._bassCandidate) {
      this._bassCandidate = pc;
      this._bassCandidateSince = now;
      return this._bassPc;
    }

    // Golden Setting: 280ms
    if (now - this._bassCandidateSince >= this._bassStableMs) {
      this._bassPc = this._bassCandidate;
    }
    return this._bassPc;
  }

  /* -------------------------- Chord Detection -------------------------- */

  _buildChordTemplates() {
    const shapes = {
      maj: [0, 4, 7],
      min: [0, 3, 7],
      maj7: [0, 4, 7, 11],
      min7: [0, 3, 7, 10],
      dom7: [0, 4, 7, 10],
      dim: [0, 3, 6]
    };

    const templates = [];
    for (let root = 0; root < 12; root++) {
      for (const [quality, intervals] of Object.entries(shapes)) {
        const v = new Float32Array(12);
        for (const itv of intervals) v[(root + itv) % 12] = 1;

        // Normalize
        let s = 0;
        for (let i = 0; i < 12; i++) s += v[i] * v[i];
        const n = Math.sqrt(s);
        for (let i = 0; i < 12; i++) v[i] = v[i] / n;

        templates.push({ root, quality, vec: v });
      }
    }
    return templates;
  }

  _detectChord(chroma, bassPc) {
    let best = { score: -1, root: 0, quality: "maj" };

    for (const t of this.templates) {
      const score = this._dot12(chroma, t.vec);
      if (score > best.score) best = { score, root: t.root, quality: t.quality };
    }

    const confidence = this._clamp01((best.score - 0.20) / 0.80);
    let name = this._formatChord(best.root, best.quality);

    if (bassPc !== null && bassPc !== best.root) {
      name = `${name}/${this.PC[bassPc]}`;
    }

    return { chord: name, confidence };
  }

  _formatChord(rootPc, quality) {
    const root = this.PC[rootPc];
    switch (quality) {
      case "maj":
        return root;
      case "min":
        return `${root}m`;
      case "maj7":
        return `${root}maj7`;
      case "min7":
        return `${root}m7`;
      case "dom7":
        return `${root}7`;
      case "dim":
        return `${root}dim`;
      default:
        return root;
    }
  }

  _applyChordHysteresis(chordName) {
    const now = performance.now();

    if (chordName === this.lastChord) {
      this._candidateChord = chordName;
      this._candidateSince = now;
      return this.lastChord;
    }

    if (chordName !== this._candidateChord) {
      this._candidateChord = chordName;
      this._candidateSince = now;
      return this.lastChord;
    }

    // Golden Setting: 320ms
    if (now - this._candidateSince >= this._stableMs) {
      this.lastChord = this._candidateChord;

      const t = this.currentTime;
      const prev = this.events[this.events.length - 1]?.chord;
      if (prev !== this.lastChord) {
        this.events.push({ t, chord: this.lastChord, conf: 1, overridden: false });
      }
    }

    return this.lastChord;
  }

  /* -------------------------- BPM (Energy Onset) -------------------------- */

  _estimateBPMFromEnergy() {
    let energy = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const x = this.timeData[i];
      energy += x * x;
    }
    energy /= this.timeData.length;

    this._energyHistory.push(energy);
    if (this._energyHistory.length > this._energyHistorySize) this._energyHistory.shift();
    if (this._energyHistory.length < 20) return null;

    const mean = this._energyHistory.reduce((a, b) => a + b, 0) / this._energyHistory.length;
    const variance =
      this._energyHistory.reduce((a, b) => a + (b - mean) * (b - mean), 0) / this._energyHistory.length;
    const std = Math.sqrt(variance);

    const threshold = mean + 2.0 * std;

    const nowS = this.currentTime;
    const isOnset = energy > threshold;

    if (isOnset && nowS - this._lastOnsetTime > 0.12) {
      this._lastOnsetTime = nowS;
      this._onsets.push(nowS);
      while (this._onsets.length && nowS - this._onsets[0] > 8) this._onsets.shift();
    }

    if (this._onsets.length < 4) return null;

    const intervals = [];
    for (let i = 1; i < this._onsets.length; i++) {
      const dt = this._onsets[i] - this._onsets[i - 1];
      if (dt > 0.20 && dt < 2.0) intervals.push(dt);
    }
    if (intervals.length < 3) return null;

    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];
    let bpm = 60 / median;

    while (bpm < 70) bpm *= 2;
    while (bpm > 180) bpm /= 2;

    return Math.round(bpm);
  }

  /* -------------------------- Timeline Editing -------------------------- */

  overrideEventAtIndex(index, chordText) {
    const ev = this.events[index];
    if (!ev) return;
    ev.overridden = true;
    ev.userChord = chordText;
  }

  /* -------------------------- Utils -------------------------- */

  _dot12(a, b) {
    let s = 0;
    for (let i = 0; i < 12; i++) s += a[i] * b[i];
    return s;
  }

  _clamp01(x) {
    return Math.max(0, Math.min(1, x));
  }
}
