/**
 * SonicMind AudioEngine (Enhanced Accuracy - Full Mix Tuned Defaults)
 *
 * DSP stack:
 * - AnalyserNode FFT bins -> spectral whitening -> chroma
 * - Key-invariant chroma smoothing:
 *    (1) circular pitch-class smoothing (shift-invariant)
 *    (2) peak sharpening
 *    (3) temporal EMA (time constant)
 * - Chord detection via cosine similarity templates + hysteresis
 * - Bass stability via HPS on low-passed spectrum + stability window (slash chords)
 * - BPM via energy-based onset detection
 *
 * Constraints:
 * - Pure DSP only. No external AI/ML libs.
 */

export class AudioEngine {
  constructor({
    fftSize = 4096,
    smoothingTimeConstant = 0.0,

    // Golden Settings (Full Mix - YouTube Pop/Rock)
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

    this.ctx = null;
    this.sourceNode = null;

    this.analyser = null;
    this.bassAnalyser = null;

    this.focusFilter = null;
    this.bassFilter = null;

    this.freqData = null;
    this.bassFreqData = null;
    this.timeData = null;

    // Float spectra for DSP
    this._spec = null; // whitened main spectrum (Float32Array)
    this._bassSpec = null; // whitened bass spectrum (Float32Array)

    // Chroma state
    this._chromaRaw = new Float32Array(12);
    this._chromaSmoothed = new Float32Array(12);
    this._chromaEMA = new Float32Array(12);
    this._lastChromaTs = 0;

    // Bass note state
    this._bassPc = null;
    this._bassCandidate = null;
    this._bassCandidateSince = 0;

    // Chord hysteresis
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

    // Audio element
    this.mediaEl = null;
    this.mediaSource = null;

    // Music constants
    this.PC = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    this.A4 = 440;

    // Templates
    this.templates = this._buildChordTemplates();

    // Whitening params (Golden Settings)
    this._whitenWindow = 25; // bins (local envelope half-window)
    this._whitenEps = 1e-6;

    // Chroma frequency band (Full mix)
    this._fMin = 55; // A1
    this._fMax = 5500;

    // Bass/HPS params (Golden Settings)
    this._bassMaxHz = 280;
    this._bassMinHz = 30;
    this._hpsHarmonics = 4; // tuned for full mixes

    // Scratch buffers
    this._scratchPrefix = null;
    this._scratchHPS = null;
  }

  /* -------------------------- Lifecycle -------------------------- */

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

    this.mediaEl = new Audio();
    this.mediaEl.crossOrigin = "anonymous";
    this.mediaEl.preload = "auto";

    // Best-effort pitch preserve; browser-dependent.
    this.mediaEl.preservesPitch = true;
    this.mediaEl.webkitPreservesPitch = true;
  }

  async setSourceFromFile(file) {
    await this.init();
    const url = URL.createObjectURL(file);
    await this._setMediaSource(url);
  }

  async setSourceFromStream(proxyUrl) {
    await this.init();
    await this._setMediaSource(proxyUrl);
  }

  async _setMediaSource(url) {
    this.stop();

    this.mediaEl.src = url;
    await this.mediaEl.load?.();

    if (this.mediaSource) {
      try {
        this.mediaSource.disconnect();
      } catch (_) {}
    }

    this.mediaSource = this.ctx.createMediaElementSource(this.mediaEl);
    this.sourceNode = this.mediaSource;

    // Graph:
    // Source -> FocusFilter -> Analyser -> Destination
    // Source -> BassFilter -> BassAnalyser
    this.sourceNode.connect(this.focusFilter);
    this.focusFilter.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this.sourceNode.connect(this.bassFilter);
    this.bassFilter.connect(this.bassAnalyser);

    // Reset state
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
    this._lastChromaTs = performance.now();
  }

  play() {
    if (!this.ctx || !this.mediaEl) return;
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.mediaEl.play();
  }

  pause() {
    this.mediaEl?.pause();
  }

  stop() {
    if (!this.mediaEl) return;

    this.mediaEl.pause();
    this.mediaEl.currentTime = 0;

    try {
      this.mediaSource?.disconnect();
      this.focusFilter?.disconnect();
      this.analyser?.disconnect();
      this.bassFilter?.disconnect();
      this.bassAnalyser?.disconnect();
    } catch (_) {}

    this.sourceNode = null;
  }

  setPlaybackRate(rate) {
    if (!this.mediaEl) return;
    this.mediaEl.playbackRate = rate;
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

  get currentTime() {
    return this.mediaEl?.currentTime ?? 0;
  }

  get duration() {
    return this.mediaEl?.duration ?? 0;
  }

  get isPlaying() {
    return this.mediaEl && !this.mediaEl.paused && !this.mediaEl.ended;
  }

  /* -------------------------- Analysis Tick -------------------------- */

  tick() {
    if (!this.analyser || !this.bassAnalyser) {
      return { freqData: null, chord: "—", confidence: 0, bpm: null, chroma: null };
    }

    // FFT + time-domain
    this.analyser.getByteFrequencyData(this.freqData);
    this.bassAnalyser.getByteFrequencyData(this.bassFreqData);
    this.analyser.getFloatTimeDomainData(this.timeData);

    // Whitening (main + bass)
    this._computeWhitenedSpectrum(this.freqData, this._spec, this._whitenWindow);
    this._computeWhitenedSpectrum(this.bassFreqData, this._bassSpec, this._whitenWindow);

    // Chroma: whitened -> raw -> key-invariant smoothing
    const chromaRaw = this._computeChromaFromWhitened(this._spec);
    const chroma = this._keyInvariantChromaSmoothing(chromaRaw);

    // Bass PC via HPS (stable)
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

    // Convert to magnitude with gamma (suppress noise)
    for (let i = 0; i < n; i++) {
      const x = byteData[i] / 255;
      outFloat[i] = x * x;
    }

    // Prefix sum for fast moving average envelope
    const prefix = this._getScratchPrefix(n + 1);
    prefix[0] = 0;
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + outFloat[i];

    const eps = this._whitenEps;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - halfWindowBins);
      const b = Math.min(n - 1, i + halfWindowBins);
      const sum = prefix[b + 1] - prefix[a];
      const env = sum / (b - a + 1);

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

  /* -------------------------- Chroma -------------------------- */

  _computeChromaFromWhitened(whitenedSpec) {
    this._chromaRaw.fill(0);

    const sr = this.ctx.sampleRate;
    const nFFT = this.analyser.fftSize;
    const binCount = whitenedSpec.length;

    for (let i = 1; i < binCount; i++) {
      const mag = whitenedSpec[i];
      if (mag < 0.02) continue;

      const freq = (i * sr) / nFFT;
      if (freq < this._fMin || freq > this._fMax) continue;

      const midi = this._freqToMidi(freq);
      const pc = ((Math.round(midi) % 12) + 12) % 12;

      // Emphasize strong/consistent partials
      this._chromaRaw[pc] += Math.pow(mag, 1.15);
    }

    this._normalize12(this._chromaRaw);
    return this._chromaRaw;
  }

  _keyInvariantChromaSmoothing(chromaIn) {
    // Circular smoothing (shift-invariant across pitch classes)
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

    // Temporal EMA with time constant
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
    const binMax = Math.min(
      whitenedBassSpec.length - 1,
      Math.floor((this._bassMaxHz * nFFT) / sr)
    );

    if (binMax <= binMin + 8) return null;

    const len = binMax + 1;
    const hps = this._getScratchHPS(len);

    for (let i = 0; i < len; i++) hps[i] = whitenedBassSpec[i];

    const H = this._hpsHarmonics;
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

    // Threshold tuned for whit
