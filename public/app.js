import { AudioEngine } from "./audio-engine.js";

/* -------------------------- DOM -------------------------- */
const el = (id) => document.getElementById(id);

const fileInput = el("fileInput");
const fileBtn = el("fileBtn");
const fileName = el("fileName");

const dropZone = el("dropZone");
const dropHint = el("dropHint");

const ytUrl = el("ytUrl");
const loadStreamBtn = el("loadStreamBtn");

const playBtn = el("playBtn");
const pauseBtn = el("pauseBtn");
const stopBtn = el("stopBtn");

const speed = el("speed");
const speedVal = el("speedVal");

const capo = el("capo");
const capoVal = el("capoVal");

const eqFull = el("eqFull");
const eqBass = el("eqBass");
const eqMid = el("eqMid");

const chordReadout = el("chordReadout");
const bpmReadout = el("bpmReadout");
const tsReadout = el("tsReadout");

const audioDot = el("audioDot");
const audioStatus = el("audioStatus");
const timeReadout = el("timeReadout");

const specCanvas = el("spec");
const specCtx = specCanvas.getContext("2d", { alpha: false });

const timeline = el("timeline");

// Overlay
const overlay = el("loadingOverlay");
const loadingText = el("loadingText");
const loadingBar = el("loadingBar");

/* -------------------------- Engine (updated stability settings) -------------------------- */
const engine = new AudioEngine({
  fftSize: 4096,
  smoothingTimeConstant: 0.0,

  // Increased stability per request
  chromaTimeConstantMs: 250,
  chordStableMs: 500
  // bassStableMs remains default from engine unless you also changed it in audio-engine.js
});

let rafId = null;
let capoSemis = 0;

const PC = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/* -------------------------- UX Helpers -------------------------- */
function fmtTime(s) {
  if (!isFinite(s)) return "00:00";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function setStatus(isOn, text) {
  audioDot.classList.toggle("on", isOn);
  audioStatus.textContent = text;
}

function setActiveToggle(activeId) {
  for (const btn of [eqFull, eqBass, eqMid]) btn.classList.remove("active");
  el(activeId).classList.add("active");
}

function showOverlay(text, progress01 = null) {
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  loadingText.textContent = text;
  if (progress01 == null) {
    // Indeterminate feel: bounce between 20-75%
    loadingBar.style.width = "45%";
  } else {
    loadingBar.style.width = `${Math.max(0, Math.min(1, progress01)) * 100}%`;
  }
}

function hideOverlay() {
  overlay.classList.add("hidden");
  overlay.setAttribute("aria-hidden", "true");
  loadingBar.style.width = "0%";
}

function transposeChordText(chord, semis) {
  if (!chord || chord === "—") return chord;
  if (semis === 0) return chord;

  const [main, slash] = chord.split("/");
  const m = main.match(/^([A-G])(#?)(.*)$/);
  if (!m) return chord;

  const rootName = `${m[1]}${m[2] || ""}`;
  const rest = m[3] || "";

  const rootIdx = PC.indexOf(rootName);
  if (rootIdx < 0) return chord;

  const newRoot = PC[(rootIdx + semis + 1200) % 12];

  let out = `${newRoot}${rest}`;
  if (slash) {
    const bassIdx = PC.indexOf(slash.trim());
    out += bassIdx >= 0 ? `/${PC[(bassIdx + semis + 1200) % 12]}` : `/${slash.trim()}`;
  }
  return out;
}

/* -------------------------- Timeline: Merge + Min Duration -------------------------- */
/**
 * Requirements:
 * - Merge identical consecutive chords into one block with duration
 * - Ignore any chord that lasts < 400ms
 * - Grid layout handled by CSS (2 rows, fixed height)
 */
const timelineEvents = []; // {start, end, chord, overridden, userChord}
const MIN_CHORD_DUR_S = 0.4;

function finalizeLastEvent(endTime) {
  const last = timelineEvents[timelineEvents.length - 1];
  if (!last || last.end != null) return;

  last.end = endTime;

  const dur = Math.max(0, last.end - last.start);
  if (dur < MIN_CHORD_DUR_S) {
    timelineEvents.pop(); // drop too-short chords
  }
}

function pushOrMergeChord(chord, t) {
  // If no previous, start one
  const last = timelineEvents[timelineEvents.length - 1];

  // If last is open and same chord (and not overridden), just keep running
  if (last && last.end == null) {
    const lastChord = last.overridden ? last.userChord : last.chord;
    if (!last.overridden && lastChord === chord) {
      // Merge by doing nothing; it continues
      return;
    }

    // Close previous at change time
    finalizeLastEvent(t);
  }

  // After finalizing, check again if last closed equals new chord -> merge by reopening (rare)
  const prev = timelineEvents[timelineEvents.length - 1];
  if (prev && prev.end != null && !prev.overridden) {
    const prevChord = prev.chord;
    if (prevChord === chord && (prev.end - prev.start) >= MIN_CHORD_DUR_S) {
      // Extend previous by reopening it: make it active again
      prev.end = null;
      return;
    }
  }

  // Start new event
  timelineEvents.push({
    start: t,
    end: null,
    chord,
    overridden: false,
    userChord: null
  });
}

function renderTimeline() {
  timeline.innerHTML = "";

  const now = engine.currentTime;
  // Render all events; for the currently open one, compute end as "now"
  timelineEvents.forEach((ev, idx) => {
    const end = ev.end == null ? now : ev.end;
    const dur = Math.max(0, end - ev.start);

    // Don’t render ultra-short open events yet (prevents visual overload)
    if (ev.end == null && dur < MIN_CHORD_DUR_S) return;

    const chord = ev.overridden ? ev.userChord : ev.chord;
    const shown = transposeChordText(chord, capoSemis);

    const block = document.createElement("div");
    block.className = "block" + (ev.overridden ? " overridden" : "");

    const chordEl = document.createElement("div");
    chordEl.className = "chord";
    chordEl.textContent = shown;

    const meta = document.createElement("div");
    meta.className = "meta mono";
    meta.textContent = `${fmtTime(ev.start)} · ${dur.toFixed(1)}s`;

    block.appendChild(chordEl);
    block.appendChild(meta);

    block.addEventListener("click", () => {
      const current = ev.overridden ? ev.userChord : ev.chord;
      const user = prompt("Override chord:", current);
      if (user && user.trim()) {
        ev.overridden = true;
        ev.userChord = user.trim();
        renderTimeline();
      }
    });

    timeline.appendChild(block);
  });
}

/* -------------------------- Spectrogram -------------------------- */
function drawSpectrogram(byteFreqData) {
  if (!byteFreqData) return;

  const w = specCanvas.width;
  const h = specCanvas.height;

  // Shift left by 1 px
  const imageData = specCtx.getImageData(1, 0, w - 1, h);
  specCtx.putImageData(imageData, 0, 0);

  const x = w - 1;
  specCtx.fillStyle = "#0d0d0d";
  specCtx.fillRect(x, 0, 1, h);

  const bins = byteFreqData.length;
  for (let y = 0; y < h; y++) {
    const ny = 1 - y / h;
    const idx = Math.floor(Math.pow(ny, 2.2) * (bins - 1));
    const v = byteFreqData[idx] / 255;

    const b = Math.floor(60 + 195 * v);
    const g = Math.floor(10 + 245 * Math.pow(v, 1.7));
    const r = Math.floor(8 + 80 * Math.pow(v, 2.2));

    specCtx.fillStyle = `rgb(${r},${g},${b})`;
    specCtx.fillRect(x, y, 1, 1);
  }
}

/* -------------------------- Time Signature Estimation -------------------------- */
/**
 * Basic 3/4 vs 4/4 heuristic using engine._onsets (internal array) + bpm beat grid.
 * - Build beat-synchronous indicator vector (last ~24 beats)
 * - Compare autocorrelation at lag 3 vs lag 4
 * Default: 4/4 if uncertain.
 */
function estimateTimeSignature(bpm) {
  try {
    const onsets = engine._onsets; // internal but accessible in JS
    if (!onsets || !Array.isArray(onsets) || onsets.length < 8) return "4/4";
    if (!bpm || !isFinite(bpm) || bpm < 60 || bpm > 220) return "4/4";

    const beat = 60 / bpm;
    const now = engine.currentTime;

    // Consider last 24 beats window
    const beatsN = 24;
    const startT = Math.max(0, now - beatsN * beat);

    // Build beat bins
    const x = new Array(beatsN).fill(0);
    for (const t of onsets) {
      if (t < startT || t > now) continue;
      const k = Math.round((t - startT) / beat);
      if (k >= 0 && k < beatsN) x[k] = 1;
    }

    function corr(lag) {
      let s = 0;
      let c = 0;
      for (let i = lag; i < beatsN; i++) {
        s += x[i] * x[i - lag];
        c++;
      }
      return c ? s / c : 0;
    }

    const c3 = corr(3);
    const c4 = corr(4);

    // Confidence margin; if too close, default 4/4
    if (c3 > c4 + 0.06) return "3/4";
    return "4/4";
  } catch {
    return "4/4";
  }
}

/* -------------------------- Main Loop -------------------------- */
let lastStableChord = "—";
let rhythmWarmupUntil = 0; // overlay gating for “Analyzing Rhythms…”

function loop() {
  const { freqData, chord, bpm } = engine.tick();

  // If a chord changes (stable chord coming out of engine), build merged timeline
  if (chord && chord !== "—" && chord !== lastStableChord) {
    const t = engine.currentTime;
    pushOrMergeChord(chord, t);
    lastStableChord = chord;
  }

  // Keep the open event’s duration updating; render periodically
  renderTimeline();

  // Readouts
  chordReadout.textContent = transposeChordText(chord || "—", capoSemis);
  bpmReadout.textContent = bpm ? String(bpm) : "—";
  tsReadout.textContent = bpm ? estimateTimeSignature(bpm) : "4/4";
  timeReadout.textContent = fmtTime(engine.currentTime);

  drawSpectrogram(freqData);
  setStatus(engine.isPlaying, engine.isPlaying ? "Analyzing" : "Paused");

  // Hide rhythm overlay after warmup window
  if (overlay && !overlay.classList.contains("hidden") && performance.now() > rhythmWarmupUntil) {
    hideOverlay();
  }

  rafId = requestAnimationFrame(loop);
}

/* -------------------------- Loading / Input -------------------------- */
async function loadLocalFile(file) {
  if (!file) return;
  showOverlay("Decoding Audio…", 0.15);

  try {
    fileName.textContent = file.name;
    dropHint.textContent = `Loading: ${file.name}`;

    const arrayBuffer = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("FileReader error"));
      reader.onprogress = (e) => {
        if (e.lengthComputable) showOverlay("Decoding Audio…", Math.min(0.85, e.loaded / e.total));
      };
      reader.onload = () => resolve(reader.result);
      reader.readAsArrayBuffer(file);
    });

    showOverlay("Decoding Audio…", 0.9);
    await engine.loadFromFileArrayBuffer(arrayBuffer);

    // Reset timeline state
    timelineEvents.length = 0;
    lastStableChord = "—";

    setStatus(false, "Loaded local file");
    dropHint.textContent = `Ready: ${file.name}`;
    hideOverlay();
  } catch (err) {
    console.error(err);
    dropHint.textContent = "Drop MP3/WAV/OGG here";
    fileName.textContent = "No file selected";
    hideOverlay();
    alert("Failed to decode audio. Try another file/format.");
  }
}

async function loadYouTube(url) {
  if (!url) return;
  showOverlay("Fetching from YouTube…", 0.2);

  try {
    const proxy = `/api/stream?url=${encodeURIComponent(url)}`;
    await engine.setSourceFromStream(proxy);

    // Reset timeline state
    timelineEvents.length = 0;
    lastStableChord = "—";

    setStatus(false, "Stream loaded");
    hideOverlay();
  } catch (err) {
    console.error(err);
    hideOverlay();
    alert("Failed to load stream.");
  }
}

/* -------------------------- Wiring -------------------------- */

// Custom file button
fileBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  await loadLocalFile(file);
});

// Drag & Drop
function setDropActive(active) {
  dropZone.classList.toggle("active", active);
}

["dragenter", "dragover"].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDropActive(true);
    dropHint.textContent = "Release to load file";
  });
});

["dragleave", "dragend"].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDropActive(false);
    dropHint.textContent = "Drop MP3/WAV/OGG here";
  });
});

dropZone.addEventListener("drop", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  setDropActive(false);
  dropHint.textContent = "Drop MP3/WAV/OGG here";
  const file = e.dataTransfer?.files?.[0];
  await loadLocalFile(file);
});

// YouTube fetch
loadStreamBtn.addEventListener("click", async () => {
  const url = ytUrl.value.trim();
  if (!url) return alert("Paste a YouTube URL first.");
  await loadYouTube(url);
});

// Playback
playBtn.addEventListener("click", async () => {
  try {
    // Rhythm warmup overlay
    showOverlay("Analyzing Rhythms…", 0.35);
    rhythmWarmupUntil = performance.now() + 1800;

    await engine.play();

    if (!rafId) rafId = requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    hideOverlay();
    alert("Playback failed (autoplay restrictions?). Click somewhere then try again.");
  }
});

pauseBtn.addEventListener("click", () => {
  engine.pause();
  // Close the open block cleanly on pause (duration becomes meaningful)
  finalizeLastEvent(engine.currentTime);
  renderTimeline();
});

stopBtn.addEventListener("click", () => {
  engine.stop();
  finalizeLastEvent(engine.currentTime);
  chordReadout.textContent = "—";
  bpmReadout.textContent = "—";
  tsReadout.textContent = "4/4";
  renderTimeline();
});

// Speed / Capo / EQ
speed.addEventListener("input", () => {
  const r = Number(speed.value);
  speedVal.textContent = `${r.toFixed(2)}×`;
  engine.setPlaybackRate(r);
});

capo.addEventListener("input", () => {
  capoSemis = Number(capo.value);
  capoVal.textContent = String(capoSemis);
  chordReadout.textContent = transposeChordText(engine.lastChord, capoSemis);
  renderTimeline();
});

for (const btn of [eqFull, eqBass, eqMid]) {
  btn.addEventListener("click", () => {
    engine.setFocusEQ(btn.dataset.eq);
    setActiveToggle(btn.id);
  });
}

/* -------------------------- Boot -------------------------- */
setStatus(false, "Idle");
setActiveToggle("eqFull");
speedVal.textContent = `${Number(speed.value).toFixed(2)}×`;
capoVal.textContent = "0";
dropHint.textContent = "Drop MP3/WAV/OGG here";
tsReadout.textContent = "4/4";

// Start rendering loop immediately (idle spectrogram + UI)
rafId = requestAnimationFrame(loop);
