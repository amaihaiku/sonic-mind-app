import { AudioEngine } from "./audio-engine.js";

/* -------------------------- DOM -------------------------- */
const el = (id) => document.getElementById(id);

const fileInput = el("fileInput");
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

const audioDot = el("audioDot");
const audioStatus = el("audioStatus");

const timeReadout = el("timeReadout");

const specCanvas = el("spec");
const specCtx = specCanvas.getContext("2d", { alpha: false });
const timeline = el("timeline");

/* -------------------------- Engine -------------------------- */
const engine = new AudioEngine({
  fftSize: 4096,
  smoothingTimeConstant: 0.0 // we do our own smoothing (chroma EMA + whitening), so keep analyser smoothing low
});
let rafId = null;

// Capo transpose (display-only)
let capoSemis = 0;

const PC = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

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

/**
 * Transpose chord text by semitones (display only).
 * Supports:
 * - Root qualities: C, Cm, Cmaj7, Cm7, C7, Cdim
 * - Optional slash bass: C/G
 */
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
    if (bassIdx >= 0) out += `/${PC[(bassIdx + semis + 1200) % 12]}`;
    else out += `/${slash.trim()}`;
  }
  return out;
}

function renderTimeline() {
  timeline.innerHTML = "";

  engine.events.forEach((ev, idx) => {
    const div = document.createElement("div");
    div.className = "block" + (ev.overridden ? " overridden" : "");
    div.dataset.index = String(idx);

    const chord = ev.overridden ? ev.userChord : ev.chord;
    const shown = transposeChordText(chord, capoSemis);

    const chordEl = document.createElement("div");
    chordEl.className = "chord";
    chordEl.textContent = shown;

    const meta = document.createElement("div");
    meta.className = "meta mono";
    meta.textContent = `${fmtTime(ev.t)}`;

    div.appendChild(chordEl);
    div.appendChild(meta);

    div.addEventListener("click", () => {
      const current = ev.overridden ? ev.userChord : ev.chord;
      const user = prompt("Override chord:", current);
      if (user && user.trim()) {
        engine.overrideEventAtIndex(idx, user.trim());
        renderTimeline();
      }
    });

    timeline.appendChild(div);
  });
}

/* -------------------------- Spectrogram -------------------------- */
const specW = specCanvas.width;
const specH = specCanvas.height;

function drawSpectrogram(byteFreqData) {
  if (!byteFreqData) return;

  // Shift left by 1 px
  const imageData = specCtx.getImageData(1, 0, specW - 1, specH);
  specCtx.putImageData(imageData, 0, 0);

  // New column
  const x = specW - 1;
  specCtx.fillStyle = "#0d0d0d";
  specCtx.fillRect(x, 0, 1, specH);

  // Log-ish mapping for better low-frequency visibility
  const bins = byteFreqData.length;
  for (let y = 0; y < specH; y++) {
    const ny = 1 - y / specH;
    const idx = Math.floor(Math.pow(ny, 2.2) * (bins - 1));
    const v = byteFreqData[idx] / 255;

    // Blue->Lime heat
    const b = Math.floor(60 + 195 * v);
    const g = Math.floor(10 + 245 * Math.pow(v, 1.7));
    const r = Math.floor(8 + 80 * Math.pow(v, 2.2));

    specCtx.fillStyle = `rgb(${r},${g},${b})`;
    specCtx.fillRect(x, y, 1, 1);
  }
}

/* -------------------------- Animation Loop -------------------------- */
function loop() {
  const { freqData, chord, bpm } = engine.tick();

  chordReadout.textContent = transposeChordText(chord, capoSemis);
  bpmReadout.textContent = bpm ? String(bpm) : "—";
  timeReadout.textContent = fmtTime(engine.currentTime);

  if (loop._lastEventCount !== engine.events.length) {
    loop._lastEventCount = engine.events.length;
    renderTimeline();
  }

  drawSpectrogram(freqData);
  setStatus(engine.isPlaying, engine.isPlaying ? "Analyzing" : "Paused");

  rafId = requestAnimationFrame(loop);
}
loop._lastEventCount = 0;

/* -------------------------- Wiring -------------------------- */
fileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    await engine.setSourceFromFile(file);
    setStatus(false, "Loaded file");
  } catch (err) {
    console.error(err);
    alert("Failed to load file.");
  }
});

loadStreamBtn.addEventListener("click", async () => {
  const url = ytUrl.value.trim();
  if (!url) return alert("Paste a YouTube URL first.");

  try {
    const proxy = `/api/stream?url=${encodeURIComponent(url)}`;
    await engine.setSourceFromStream(proxy);
    setStatus(false, "Loaded stream");
  } catch (err) {
    console.error(err);
    alert("Failed to load stream.");
  }
});

playBtn.addEventListener("click", async () => {
  try {
    await engine.play();
    if (!rafId) rafId = requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    alert("Playback failed (autoplay restrictions?). Click somewhere then try again.");
  }
});

pauseBtn.addEventListener("click", () => engine.pause());

stopBtn.addEventListener("click", () => {
  engine.stop();
  chordReadout.textContent = "—";
  bpmReadout.textContent = "—";
  renderTimeline();
});

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
    const mode = btn.dataset.eq;
    engine.setFocusEQ(mode);
    setActiveToggle(btn.id);
  });
}

setStatus(false, "Idle");
setActiveToggle("eqFull");
speedVal.textContent = `${Number(speed.value).toFixed(2)}×`;
capoVal.textContent = "0";

rafId = requestAnimationFrame(loop);
