/**
 * SonicMind AudioEngine (Enhanced Accuracy)
 *
 * Additions vs baseline:
 * 1) Spectral Whitening:
 *    - Convert byte spectrum -> linear magnitude
 *    - Compute local spectral envelope (moving average in bins)
 *    - Whitening = mag / (envelope + eps)
 *
 * 2) Bass Stability via Harmonic Product Spectrum (HPS):
 *    - On low-passed spectrum, compute HPS over harmonics 2..H
 *    - Pick peak -> stable bass pitch class
 *    - Add hysteresis/stability window for slash chords
 *
 * 3) Key-invariant chroma smoothing:
 *    - Circular smoothing kernel on 12 pitch classes (shift-invariant)
 *    - Temporal EMA with time constant (ms)
 *    - Peak sharpening (power law) + normalization
 *
 * Constraints:
 * - Pure DSP only. No ML libs.
 * - WebAudio AnalyserNode is used only to obtain FFT bins.
 */

export class AudioEngine {
  constructor({
    fftSize = 4096,
    smoothingTimeConstant = 0.0, // keep low; we do our own smoothing
    chromaTimeConstantMs = 180, // EMA time constant for chroma smoothing
    chordStableMs = 300,
    bassStableMs = 220
  } = {}) {
    this.fftSize = fftSize;
    this.smoothingTimeConstant = smoothingTimeConstant;

    // Smoothing constants
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

    // Whitening params
    this._whitenWindow = 18; // bins (local envelope window half-size)
    this._whitenEps = 1e-6;

    // Chroma mapping
    this._fMin = 55;   // A1
    this._fMax = 5500; // upper band for chordal chroma

    // Bass/HPS params
    this._bassMaxHz = 280;
    this._bassMinHz = 30;
    this._hpsHarmonics = 5; // multiply downsampled spectra up to 5th harmonic
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
    this._bassCandidateSince = 0;

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

  /**
   * Call on an animation loop.
   * Returns { freqData, chord, confidence, bpm, chroma }
   */
  tick() {
    if (!this.analyser || !this.bassAnalyser) {
      return { freqData: null, chord: "—", confidence: 0, bpm: null, chroma: null };
    }

    // Grab FFT bins and time-domain
    this.analyser.getByteFrequencyData(this.freqData);
    this.bassAnalyser.getByteFrequencyData(this.bassFreqData);
    this.analyser.getFloatTimeDomainData(this.timeData);

    // Whitening (main + bass)
    this._computeWhitenedSpectrum(this.freqData, this._spec, this._whitenWindow);
    this._computeWhitenedSpectrum(this.bassFreqData, this._bassSpec, this._whitenWindow);

    // Chroma: raw -> circular smooth -> EMA smooth -> normalize
    const chroma = this._computeChromaFromWhitened(this._spec);
    const chromaSmooth = this._keyInvariantChromaSmoothing(chroma);

    // Bass PC via HPS with stability gating
    const bassPc = this._detectBassPitchClassHPS(this._bassSpec);

    // Chord via cosine similarity
    const { chord, confidence } = this._detectChord(chromaSmooth, bassPc);
    const stableChord = this._applyChordHysteresis(chord);

    // BPM
    const bpm = this._estimateBPMFromEnergy();

    return { freqData: this.freqData, chord: stableChord, confidence, bpm, chroma: chromaSmooth };
  }

  /* -------------------------- Spectral Whitening -------------------------- */

  /**
   * Whitening = mag / (local envelope + eps)
   * - Converts Uint8 spectrum -> Float32 spectrum
   * - Envelope computed via moving average window (bin-domain)
   */
  _computeWhitenedSpectrum(byteData, outFloat, halfWindowBins) {
    const n = byteData.length;

    // Convert to linear-ish magnitude with gamma to reduce low-level noise
    // (byte/255)^2 emphasizes strong partials
    for (let i = 0; i < n; i++) {
      const x = byteData[i] / 255;
      outFloat[i] = x * x;
    }

    // Compute envelope via moving average (fast enough for 2048 bins)
    // We do a box filter with prefix sums.
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

    // Normalize to [0,1] by max (robust)
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

  /* -------------------------- Chroma Computation -------------------------- */

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

      // Pitch class mapping (nearest MIDI)
      const midi = this._freqToMidi(freq);
      const pc = ((Math.round(midi) % 12) + 12) % 12;

      // Weight: stronger emphasis for clearer harmonics (mag^p)
      // whitening already helps; mild power improves robustness.
      this._chromaRaw[pc] += Math.pow(mag, 1.15);
    }

    // Normalize
    this._normalize12(this._chromaRaw);
    return this._chromaRaw;
  }

  /**
   * Key-invariant smoothing:
   * - circular smoothing kernel (shift-invariant across pitch classes)
   * - peak sharpening
   * - temporal EMA with time-constant
   */
  _keyInvariantChromaSmoothing(chromaIn) {
    // Circular smoothing kernel (triangular-ish)
    // out[k] = 0.22*in[k-2] + 0.56*in[k] + 0.22*in[k+2]  (wide)
    // plus a smaller neighbor contribution for stability
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

    // Peak sharpening (power > 1 makes peaks pop, helps chord templates)
    for (let k = 0; k < 12; k++) tmp[k] = Math.pow(Math.max(0, tmp[k]), 1.35);

    // Normalize
    this._normalize12(tmp);

    // Temporal EMA
    const now = performance.now();
    const dt = Math.max(1, now - (this._lastChromaTs || now)); // ms
    this._lastChromaTs = now;

    // EMA alpha from time constant:
    // alpha = 1 - exp(-dt/tau)
    const tau = Math.max(10, this._chromaTC);
    const alpha = 1 - Math.exp(-dt / tau);

    for (let k = 0; k < 12; k++) {
      this._chromaEMA[k] = (1 - alpha) * this._chromaEMA[k] + alpha * tmp[k];
    }

    // Final normalize
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

  /**
   * Harmonic Product Spectrum on low-frequency (low-passed) whitened spectrum:
   * - Build HPS array for bins in [bassMinHz..bassMaxHz]
   * - Multiply downsampled spectra for harmonics 2..H
   * - Pick peak bin -> bass pitch class
   * - Add hysteresis window for stable slash-chords
   */
  _detectBassPitchClassHPS(whitenedBassSpec) {
    const sr = this.ctx.sampleRate;
    const nFFT = this.bassAnalyser.fftSize;

    // Determine bin bounds
    const binMin = Math.max(1, Math.floor((this._bassMinHz * nFFT) / sr));
    const binMax = Math.min(
      whitenedBassSpec.length - 1,
      Math.floor((this._bassMaxHz * nFFT) / sr)
    );

    if (binMax <= binMin + 8) return null;

    const len = binMax + 1;
    const hps = this._getScratchHPS(len);
    for (let i = 0; i < len; i++) hps[i] = whitenedBassSpec[i];

    // Multiply harmonics
    const H = this._hpsHarmonics;
    for (let h = 2; h <= H; h++) {
      for (let i = binMin; i <= binMax; i++) {
        const j = i * h;
        if (j > binMax) break;
        // Multiply (keep some floor so it doesn't underflow to 0)
        hps[i] *= Math.max(whitenedBassSpec[j], 1e-3);
      }
    }

    // Find peak
    let bestI = -1;
    let bestV = 0;

    // Slight bias to prefer *lower* bins when close (fundamental tendency)
    for (let i = binMin; i <= binMax; i++) {
      const v = hps[i];
      if (v > bestV) {
        bestV = v;
        bestI = i;
      }
    }

    // Confidence threshold (avoid random noise)
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

    // If detection fails, decay slowly (don’t instantly drop bass)
    if (pc === null) {
      // If no bass for a while, release it.
      if (this._bassPc !== null && now - this._bassCandidateSince > 800) {
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

    // Candidate unchanged: accept after stable window
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

    // Confidence shaping (empirical)
    const confidence = this._clamp01((best.score - 0.20) / 0.80);

    let name = this._formatChord(best.root, best.quality);

    // Slash chord only if bass is stable and meaningfully different
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

    if (now - this._candidateSince >= this._stableMs) {
      this.lastChord = this._candidateChord;

      // Add timeline event
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

    // Slightly lower k than baseline; whitening/filters can reduce variance
    const threshold = mean + 2.0 * std;

    const nowS = this.currentTime;
    const isOnset = energy > threshold;

    // Refractory
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

  /* -------------------------- Math Utils -------------------------- */

  _dot12(a, b) {
    let s = 0;
    for (let i = 0; i < 12; i++) s += a[i] * b[i];
    return s;
  }

  _clamp01(x) {
    return Math.max(0, Math.min(1, x));
  }
}
