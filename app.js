'use strict';

/* ===============================================================
   Sound Wave — a live microphone visualiser.

   The whole thing is one small audio graph plus one draw loop:

     MediaStreamSource --> GainNode --> AnalyserNode
       (the microphone)    (our dial)   (the measuring tap)

   Nothing is connected to ctx.destination on purpose: if we piped
   the mic back to the speakers you would get an ear-splitting
   feedback howl. An AnalyserNode still receives audio without an
   output, because it is fed by a live source.

   Each animation frame we ask the analyser for two snapshots of
   the *same* moment:

     getFloatTimeDomainData() -> fftSize samples, each -1..+1
                                 (the raw pressure curve = the wave)
     getFloatFrequencyData()  -> fftSize/2 bins, each in decibels
                                 (the FFT = which pitches are present)

   =============================================================== */

/* --------------------------------------------------------------
   0. Tunables and tiny helpers
   -------------------------------------------------------------- */

const CEIL_DB   = -22;   // top of the spectrum / spectrogram scale
const PEAK_FALL = 0.45;  // dB-ish decay per frame for the peak marker

const $ = (sel) => document.querySelector(sel);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Linear amplitude (0..1) -> decibels relative to full scale. */
const toDb = (amp) => 20 * Math.log10(Math.max(amp, 1e-7));

const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F',
               'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/** Frequency in Hz -> nearest note name plus the error in cents. */
function noteName(hz) {
  if (!(hz > 0)) return '—';
  const exact = 12 * Math.log2(hz / 440) + 69;      // fractional MIDI number
  const midi  = Math.round(exact);
  const cents = Math.round((exact - midi) * 100);
  const name  = NOTES[((midi % 12) + 12) % 12];
  const octv  = Math.floor(midi / 12) - 1;
  return `${name}${octv} ${cents >= 0 ? '+' : '−'}${Math.abs(cents)}¢`;
}

/* --------------------------------------------------------------
   1. DOM handles
   -------------------------------------------------------------- */

const els = {
  startBtn: $('#startBtn'), pauseBtn: $('#pauseBtn'), themeBtn: $('#themeBtn'),
  banner: $('#banner'),
  device: $('#device'), gain: $('#gain'), gainOut: $('#gainOut'),
  zoom: $('#zoom'), zoomOut: $('#zoomOut'),
  fftSize: $('#fftSize'), smoothing: $('#smoothing'), smoothOut: $('#smoothOut'),
  floor: $('#floor'), floorOut: $('#floorOut'),
  trigger: $('#trigger'), logFreq: $('#logFreq'),
  rmsVal: $('#rmsVal'), peakVal: $('#peakVal'),
  meterRms: $('#meterRms'), meterPeak: $('#meterPeak'),
  pitchHz: $('#pitchHz'), pitchNote: $('#pitchNote'), sgAxis: $('#sgAxis'),
  statSr: $('#statSr'), statBin: $('#statBin'),
  statWin: $('#statWin'), statFps: $('#statFps'),
};

/* --------------------------------------------------------------
   2. Canvas plumbing

   A CSS pixel is not a device pixel. On a 2x display a canvas left
   at its default size is stretched and looks blurry, so we size the
   backing store to width * devicePixelRatio and then draw in device
   pixels throughout (no ctx.scale), multiplying line widths by dpr.
   -------------------------------------------------------------- */

function surface(id) {
  const el = $('#' + id);
  return { el, ctx: el.getContext('2d', { alpha: false }), w: 0, h: 0, dpr: 1 };
}

const scope  = surface('scope');
const spec   = surface('spectrum');
const sgram  = surface('spectrogram');

/** Resize the backing store if needed. Returns true when it changed. */
function fit(s) {
  const dpr  = Math.min(window.devicePixelRatio || 1, 2);
  const rect = s.el.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width  * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (w === s.w && h === s.h && dpr === s.dpr) return false;
  s.el.width = w; s.el.height = h;
  s.w = w; s.h = h; s.dpr = dpr;
  return true;
}

/* --------------------------------------------------------------
   3. Theme: read the CSS variables so canvas colours follow the page
   -------------------------------------------------------------- */

let theme = {};

function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const get = (name) => cs.getPropertyValue(name).trim();
  theme = {
    bg: get('--canvas-bg'), grid: get('--grid'), gridStrong: get('--grid-strong'),
    axis: get('--axis-text'), wave: get('--wave'), glow: get('--wave-glow'),
    bar: get('--bar'), barTop: get('--bar-top'),
  };
}

/* A perceptual colour ramp for the spectrogram (the "inferno" family).
   Built once into a 256-entry lookup table: per-pixel colour maths in
   the hot loop would be wasteful. */
const SG_LUT = (() => {
  const stops = [
    [0.00,   0,   0,   4], [0.15,  27,  12,  65], [0.30,  74,  12, 107],
    [0.45, 120,  28, 109], [0.60, 165,  44,  96], [0.75, 207,  68,  70],
    [0.86, 237, 105,  37], [0.95, 251, 155,   6], [1.00, 252, 255, 164],
  ];
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, r0, g0, b0] = stops[k];
    const [t1, r1, g1, b1] = stops[k + 1];
    const f = (t - t0) / (t1 - t0 || 1);
    lut[i * 4 + 0] = r0 + (r1 - r0) * f;
    lut[i * 4 + 1] = g0 + (g1 - g0) * f;
    lut[i * 4 + 2] = b0 + (b1 - b0) * f;
    lut[i * 4 + 3] = 255;
  }
  return lut;
})();

/* --------------------------------------------------------------
   4. Audio state
   -------------------------------------------------------------- */

const A = {
  ctx: null, stream: null, source: null, gainNode: null, analyser: null,
  time: null,        // Float32Array, fftSize samples, -1..+1
  freq: null,        // Float32Array, fftSize/2 bins, in dB
  running: false, frozen: false, raf: 0,
  peakHoldDb: -120, dominantHz: 0,
  lastFrame: 0, fps: 0,
};

function note(msg, isError) {
  els.banner.hidden = !msg;
  els.banner.textContent = msg || '';
  els.banner.style.borderColor = isError ? '' : 'var(--panel-edge)';
}

/** Allocate the analysis buffers to match the current fftSize. */
function allocate() {
  A.time = new Float32Array(A.analyser.fftSize);
  A.freq = new Float32Array(A.analyser.frequencyBinCount);
}

async function start() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    note('This browser has no getUserMedia. Microphone capture needs a modern browser.', true);
    return;
  }
  if (!window.isSecureContext) {
    note('Microphone access needs a secure context. Serve this folder over http://localhost '
       + '(for example: python3 -m http.server 8000) or over https — opening the file directly will not work.', true);
    return;
  }

  els.startBtn.disabled = true;
  els.startBtn.textContent = 'Starting…';

  try {
    const id = els.device.value;
    A.stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        deviceId: id ? { exact: id } : undefined,
        // We want the raw signal. Left on, the browser's voice-call
        // processing would gate out quiet passages and flatten the
        // dynamics we are trying to look at.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (err) {
    els.startBtn.disabled = false;
    els.startBtn.textContent = 'Start mic';
    const why = {
      NotAllowedError: 'Microphone permission was denied. Allow it in the browser’s site settings and try again.',
      NotFoundError: 'No microphone was found on this device.',
      NotReadableError: 'The microphone is busy — another app may be holding it.',
      OverconstrainedError: 'That input device is not available. Pick another one.',
    }[err.name];
    note(why || `Could not open the microphone: ${err.name} — ${err.message}`, true);
    return;
  }

  // An AudioContext may only start from a user gesture, which the
  // click on Start gives us.
  A.ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (A.ctx.state === 'suspended') await A.ctx.resume();

  A.source   = A.ctx.createMediaStreamSource(A.stream);
  A.gainNode = A.ctx.createGain();
  A.analyser = A.ctx.createAnalyser();

  A.analyser.fftSize = Number(els.fftSize.value);
  A.analyser.smoothingTimeConstant = Number(els.smoothing.value);
  A.analyser.minDecibels = Number(els.floor.value);
  A.analyser.maxDecibels = CEIL_DB;
  A.gainNode.gain.value = Number(els.gain.value);

  A.source.connect(A.gainNode).connect(A.analyser);   // no .connect(destination)
  allocate();

  // If the device is unplugged mid-session the track ends; stop cleanly.
  A.stream.getAudioTracks().forEach((t) => { t.onended = () => stop(); });

  A.running = true;
  A.frozen = false;
  els.startBtn.disabled = false;
  els.startBtn.textContent = 'Stop';
  els.pauseBtn.disabled = false;
  els.pauseBtn.textContent = 'Freeze';
  note('');
  await listDevices();                 // labels are only revealed after permission
  updateStats();
  clearSpectrogram();
  A.lastFrame = performance.now();
  A.raf = requestAnimationFrame(loop);
}

function stop() {
  cancelAnimationFrame(A.raf);
  A.running = false;
  A.frozen = false;
  if (A.stream) A.stream.getTracks().forEach((t) => t.stop());
  if (A.ctx) A.ctx.close();
  A.ctx = A.stream = A.source = A.gainNode = A.analyser = null;
  A.peakHoldDb = -120;
  els.startBtn.textContent = 'Start mic';
  els.pauseBtn.disabled = true;
  els.rmsVal.textContent = els.peakVal.textContent = '—';
  els.pitchHz.textContent = els.pitchNote.textContent = '—';
  els.meterRms.style.width = '0%';
  els.meterPeak.style.left = '0%';
  els.statFps.textContent = '—';
  drawIdle();
}

/* --------------------------------------------------------------
   5. Measurements
   -------------------------------------------------------------- */

/** Root mean square: the "average loudness" of a block of samples.
    Squaring makes every sample positive and weights the big ones,
    which is why rms tracks perceived level far better than a plain
    average (whose answer for any symmetric wave is roughly zero). */
function rmsOf(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

function peakOf(buf) {
  let p = 0;
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > p) p = a; }
  return p;
}

/** Index of the first rising crossing of `level`, so consecutive
    frames start at the same phase and the trace stops sliding.
    This is exactly the trigger knob on a hardware oscilloscope. */
function findTrigger(buf, level, limit) {
  for (let i = 1; i < limit; i++) {
    if (buf[i - 1] < level && buf[i] >= level) return i;
  }
  return 0;
}

/** Strongest FFT bin, refined by fitting a parabola through its two
    neighbours — the true peak rarely lands exactly on a bin centre.
    This is the loudest partial, which for most voices and instruments
    is the fundamental, but it is not a real pitch tracker. */
function dominantFreq(freq, binHz) {
  const lo = Math.max(1, Math.floor(50 / binHz));
  const hi = Math.min(freq.length - 2, Math.ceil(5000 / binHz));
  let k = -1, best = -Infinity;
  for (let i = lo; i <= hi; i++) if (freq[i] > best) { best = freq[i]; k = i; }
  if (k < 1 || best < A.analyser.minDecibels + 18) return 0;
  const a = freq[k - 1], b = freq[k], c = freq[k + 1];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? 0.5 * (a - c) / denom : 0;
  return (k + clamp(shift, -0.5, 0.5)) * binHz;
}

/* --------------------------------------------------------------
   6. Drawing
   -------------------------------------------------------------- */

function label(s, text, x, y, align) {
  s.ctx.fillStyle = theme.axis;
  s.ctx.font = `${Math.round(10 * s.dpr)}px ui-monospace, monospace`;
  s.ctx.textAlign = align || 'left';
  s.ctx.textBaseline = 'middle';
  s.ctx.fillText(text, x, y);
}

/** A translucent strip of background, so axis text stays readable
    where the trace or the bars would otherwise run underneath it. */
function scrim(s, y, height) {
  s.ctx.save();
  s.ctx.globalAlpha = 0.75;
  s.ctx.fillStyle = theme.bg;
  s.ctx.fillRect(0, y, s.w, height);
  s.ctx.restore();
}

function drawScope() {
  const { ctx, w, h, dpr } = scope;
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, w, h);

  // Grid: 8 columns, 4 rows, with a brighter line on zero.
  ctx.lineWidth = 1 * dpr;
  ctx.strokeStyle = theme.grid;
  ctx.beginPath();
  for (let i = 1; i < 8; i++) { const x = Math.round(w * i / 8) + .5; ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let i = 1; i < 4; i++) { const y = Math.round(h * i / 4) + .5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();
  ctx.strokeStyle = theme.gridStrong;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(h / 2) + .5); ctx.lineTo(w, Math.round(h / 2) + .5);
  ctx.stroke();

  if (!A.running) { label(scope, 'press \u201CStart mic\u201D', w / 2, h / 2 - 14 * dpr, 'center'); return; }

  const buf  = A.time;
  // How many samples to show. Half the buffer is reserved as headroom
  // for the trigger search, so the window can always slide forward.
  const span = Math.max(32, Math.round((buf.length / 2) * Number(els.zoom.value)));
  const start = els.trigger.checked ? findTrigger(buf, 0, buf.length - span) : 0;

  const mid = h / 2;
  const amp = h / 2 * 0.92;

  ctx.save();
  ctx.shadowColor = theme.glow;
  ctx.shadowBlur = 10 * dpr;
  ctx.strokeStyle = theme.wave;
  ctx.lineWidth = 1.8 * dpr;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();

  if (span > w * 1.5) {
    // Many samples per pixel: a naive polyline would alias into noise.
    // Draw the min..max envelope of each pixel column instead, which is
    // what audio editors do when you zoom out.
    for (let x = 0; x < w; x++) {
      const i0 = start + Math.floor(x * span / w);
      const i1 = Math.min(start + span, start + Math.floor((x + 1) * span / w) + 1);
      let lo = Infinity, hi = -Infinity;
      for (let i = i0; i < i1; i++) { const v = buf[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (lo === Infinity) continue;
      ctx.moveTo(x + .5, mid - clamp(hi, -1, 1) * amp);
      ctx.lineTo(x + .5, mid - clamp(lo, -1, 1) * amp);
    }
  } else {
    for (let i = 0; i < span; i++) {
      const x = i * (w - 1) / (span - 1);
      const y = mid - clamp(buf[start + i], -1, 1) * amp;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
  }
  ctx.stroke();
  ctx.restore();

  const ms = (span / A.ctx.sampleRate) * 1000;
  scrim(scope, 0, 20 * dpr);
  label(scope, `${ms.toFixed(ms < 10 ? 2 : 1)} ms window`, 8 * dpr, 11 * dpr);
  label(scope, '+1.0', w - 8 * dpr, 11 * dpr, 'right');
  scrim(scope, h - 20 * dpr, 20 * dpr);
  label(scope, '−1.0', w - 8 * dpr, h - 11 * dpr, 'right');
}

/* The analyser's bins are evenly spaced in Hz, but we hear pitch
   logarithmically: 100->200 Hz is the same musical step as
   1000->2000 Hz. These two helpers map a pixel position to a bin
   either way, taking the max over every bin a pixel covers so narrow
   peaks never vanish when many bins share one pixel. */
function binRangeForPixel(p, n, bins, nyquist, logScale) {
  const FMIN = 25;
  const fmax = Math.min(nyquist, 20000);
  let f0, f1;
  if (logScale) {
    const r = Math.log(fmax / FMIN);
    f0 = FMIN * Math.exp(r * (p / n));
    f1 = FMIN * Math.exp(r * ((p + 1) / n));
  } else {
    f0 = fmax * p / n;
    f1 = fmax * (p + 1) / n;
  }
  const b0 = clamp(Math.floor(f0 / nyquist * bins), 0, bins - 1);
  const b1 = clamp(Math.ceil(f1 / nyquist * bins), b0 + 1, bins);
  return [b0, b1];
}

function peakDbIn(freq, b0, b1) {
  let m = -Infinity;
  for (let b = b0; b < b1; b++) if (freq[b] > m) m = freq[b];
  return m;
}

function drawSpectrum() {
  const { ctx, w, h, dpr } = spec;
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, w, h);

  if (!A.running) { label(spec, 'idle', 8 * dpr, 12 * dpr); return; }

  const floorDb = A.analyser.minDecibels;
  const bins    = A.freq.length;
  const nyq     = A.ctx.sampleRate / 2;
  const logX    = els.logFreq.checked;

  // Horizontal dB rules every 20 dB.
  ctx.lineWidth = 1 * dpr;
  ctx.strokeStyle = theme.grid;
  ctx.beginPath();
  for (let db = Math.ceil(floorDb / 20) * 20; db < CEIL_DB; db += 20) {
    const y = Math.round(h * (1 - (db - floorDb) / (CEIL_DB - floorDb))) + .5;
    ctx.moveTo(0, y); ctx.lineTo(w, y);
  }
  ctx.stroke();
  for (let db = Math.ceil(floorDb / 20) * 20; db < CEIL_DB; db += 20) {
    const y = h * (1 - (db - floorDb) / (CEIL_DB - floorDb));
    label(spec, `${db}`, 4 * dpr, y - 7 * dpr);
  }

  // The spectrum itself, one filled column per pixel.
  const grad = ctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, theme.bar);
  grad.addColorStop(1, theme.barTop);
  ctx.fillStyle = grad;
  for (let x = 0; x < w; x++) {
    const [b0, b1] = binRangeForPixel(x, w, bins, nyq, logX);
    const db = peakDbIn(A.freq, b0, b1);
    if (db <= floorDb) continue;
    const t = clamp((db - floorDb) / (CEIL_DB - floorDb), 0, 1);
    const bh = Math.max(1, t * h);
    ctx.fillRect(x, h - bh, 1, bh);
  }

  // Frequency ticks.
  scrim(spec, h - 26 * dpr, 26 * dpr);
  const ticks = logX ? [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
                     : [2000, 4000, 6000, 8000, 10000, 12000, 16000, 20000];
  const FMIN = 25, fmax = Math.min(nyq, 20000);
  const logR = Math.log(fmax / FMIN);
  ctx.strokeStyle = theme.grid;
  for (const f of ticks) {
    if (f > fmax) continue;
    const x = logX ? w * Math.log(f / FMIN) / logR : w * f / fmax;
    if (x < 14 * dpr || x > w - 8 * dpr) continue;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + .5, h - 13 * dpr);
    ctx.lineTo(Math.round(x) + .5, h);
    ctx.stroke();
    label(spec, f >= 1000 ? `${f / 1000}k` : `${f}`, x, h - 20 * dpr, 'center');
  }

  // Mark the dominant partial.
  if (A.dominantHz > 0) {
    const x = logX ? w * Math.log(A.dominantHz / FMIN) / logR : w * A.dominantHz / fmax;
    if (x > 0 && x < w) {
      ctx.strokeStyle = theme.wave;
      ctx.lineWidth = 1 * dpr;
      ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + .5, 0); ctx.lineTo(Math.round(x) + .5, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

let sgColumn = null;    // reused 1-px-wide ImageData

function clearSpectrogram() {
  const { ctx, w, h } = sgram;
  ctx.fillStyle = `rgb(${SG_LUT[0]}, ${SG_LUT[1]}, ${SG_LUT[2]})`;
  ctx.fillRect(0, 0, w, h);
  sgColumn = null;
  els.sgAxis.textContent = els.logFreq.checked ? 'log Hz \u2191' : 'linear Hz \u2191';
}

function drawSpectrogram() {
  const { ctx, w, h, dpr } = sgram;
  if (!A.running) return;

  // Scroll everything one device pixel to the left by drawing the
  // canvas onto itself, then paint the newest column on the right.
  ctx.drawImage(sgram.el, -1, 0);

  if (!sgColumn || sgColumn.height !== h) sgColumn = ctx.createImageData(1, h);
  const px = sgColumn.data;

  const floorDb = A.analyser.minDecibels;
  const bins = A.freq.length;
  const nyq  = A.ctx.sampleRate / 2;
  const logY = els.logFreq.checked;

  for (let y = 0; y < h; y++) {
    const p = h - 1 - y;                       // low frequencies at the bottom
    const [b0, b1] = binRangeForPixel(p, h, bins, nyq, logY);
    const db = peakDbIn(A.freq, b0, b1);
    const t  = clamp((db - floorDb) / (CEIL_DB - floorDb), 0, 1);
    const k  = (t * 255) | 0;
    px[y * 4 + 0] = SG_LUT[k * 4 + 0];
    px[y * 4 + 1] = SG_LUT[k * 4 + 1];
    px[y * 4 + 2] = SG_LUT[k * 4 + 2];
    px[y * 4 + 3] = 255;
  }
  ctx.putImageData(sgColumn, w - 1, 0);
}

function drawIdle() {
  readTheme();
  [scope, spec, sgram].forEach(fit);
  drawScope();
  drawSpectrum();
  clearSpectrogram();
}

/* --------------------------------------------------------------
   7. The frame loop
   -------------------------------------------------------------- */

function loop(now) {
  A.raf = requestAnimationFrame(loop);

  const resized = [fit(scope), fit(spec), fit(sgram)].some(Boolean);
  if (resized) clearSpectrogram();

  const dt = now - A.lastFrame;
  A.lastFrame = now;
  if (A.frozen) return;   // keep showing the last frame, but keep the clock honest

  A.fps = A.fps ? A.fps * 0.9 + (1000 / Math.max(dt, 1)) * 0.1 : 1000 / Math.max(dt, 1);

  A.analyser.getFloatTimeDomainData(A.time);
  A.analyser.getFloatFrequencyData(A.freq);

  const binHz = A.ctx.sampleRate / A.analyser.fftSize;
  A.dominantHz = dominantFreq(A.freq, binHz);

  const rmsDb  = toDb(rmsOf(A.time));
  const peakDb = toDb(peakOf(A.time));
  A.peakHoldDb = peakDb > A.peakHoldDb ? peakDb : A.peakHoldDb - PEAK_FALL;

  // Map -60..0 dBFS onto the meter's width.
  const pct = (db) => `${clamp((db + 60) / 60, 0, 1) * 100}%`;
  els.rmsVal.textContent  = rmsDb  > -99 ? rmsDb.toFixed(1)  : '−∞';
  els.peakVal.textContent = peakDb > -99 ? peakDb.toFixed(1) : '−∞';
  els.meterRms.style.width = pct(rmsDb);
  els.meterPeak.style.left = pct(A.peakHoldDb);
  els.pitchHz.textContent   = A.dominantHz ? `${A.dominantHz.toFixed(1)} Hz` : '—';
  els.pitchNote.textContent = A.dominantHz ? noteName(A.dominantHz) : '—';
  els.statFps.textContent   = `${A.fps.toFixed(0)} fps`;

  drawScope();
  drawSpectrum();
  drawSpectrogram();
}

/* --------------------------------------------------------------
   8. Controls
   -------------------------------------------------------------- */

function updateStats() {
  if (!A.ctx) { els.statSr.textContent = els.statBin.textContent = els.statWin.textContent = '—'; return; }
  const sr = A.ctx.sampleRate;
  const n  = A.analyser.fftSize;
  els.statSr.textContent  = `${(sr / 1000).toFixed(1)} kHz`;
  els.statBin.textContent = `${(sr / n).toFixed(1)} Hz`;
  els.statWin.textContent = `${(n / sr * 1000).toFixed(1)} ms`;
}

async function listDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  const keep = els.device.value;
  const devices = (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === 'audioinput');
  els.device.innerHTML = '<option value="">Default microphone</option>';
  devices.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `Microphone ${i + 1}`;   // blank until permission is granted
    els.device.append(o);
  });
  if (keep && devices.some((d) => d.deviceId === keep)) els.device.value = keep;
}

els.startBtn.addEventListener('click', () => (A.running ? stop() : start()));

els.pauseBtn.addEventListener('click', () => {
  A.frozen = !A.frozen;
  els.pauseBtn.textContent = A.frozen ? 'Resume' : 'Freeze';
});

/** Dark when explicitly set to dark, or when unset and the OS says dark. */
function isDark() {
  const set = document.documentElement.dataset.theme;
  if (set === 'dark' || set === 'light') return set === 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

els.themeBtn.addEventListener('click', () => {
  document.documentElement.dataset.theme = isDark() ? 'light' : 'dark';
  els.themeBtn.setAttribute('aria-label', isDark() ? 'Switch to light theme' : 'Switch to dark theme');
  readTheme();
  clearSpectrogram();
  if (!A.running) drawIdle();
});

els.gain.addEventListener('input', () => {
  els.gainOut.textContent = `${Number(els.gain.value).toFixed(1)}×`;
  if (A.gainNode) A.gainNode.gain.value = Number(els.gain.value);
});

els.zoom.addEventListener('input', () => {
  if (!A.analyser) { els.zoomOut.textContent = '—'; return; }
  const span = Math.round((A.analyser.fftSize / 2) * Number(els.zoom.value));
  els.zoomOut.textContent = `${span} samples`;
});

els.smoothing.addEventListener('input', () => {
  els.smoothOut.textContent = Number(els.smoothing.value).toFixed(2);
  if (A.analyser) A.analyser.smoothingTimeConstant = Number(els.smoothing.value);
});

els.floor.addEventListener('input', () => {
  els.floorOut.textContent = `${els.floor.value} dB`;
  if (A.analyser) A.analyser.minDecibels = Number(els.floor.value);
});

els.fftSize.addEventListener('change', () => {
  if (!A.analyser) return;
  A.analyser.fftSize = Number(els.fftSize.value);
  allocate();
  updateStats();
  els.zoom.dispatchEvent(new Event('input'));
  clearSpectrogram();
});

els.logFreq.addEventListener('change', clearSpectrogram);

els.device.addEventListener('change', async () => {
  if (A.running) { stop(); await start(); }
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, button, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); if (!els.pauseBtn.disabled) els.pauseBtn.click(); }
  if (e.key === 's' || e.key === 'S') els.startBtn.click();
});

window.addEventListener('resize', () => { if (!A.running) drawIdle(); });

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  readTheme();
  clearSpectrogram();
  if (!A.running) drawIdle();
});

/* --------------------------------------------------------------
   9. Boot
   -------------------------------------------------------------- */

els.gain.dispatchEvent(new Event('input'));
els.smoothing.dispatchEvent(new Event('input'));
els.floor.dispatchEvent(new Event('input'));
els.zoomOut.textContent = '—';
listDevices();
drawIdle();

if (!window.isSecureContext) {
  note('This page is not a secure context, so the browser will block microphone access. '
     + 'Serve the folder over http://localhost (python3 -m http.server 8000) or over https.', true);
}
