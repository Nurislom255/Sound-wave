'use strict';

/* ===============================================================
   diaphragm.js — what the microphone itself is doing.

   The waveform panel shows the signal *after* the microphone. This
   module shows the mechanical step that produced it, and it is built
   on one idea that most "animated microphone" graphics get wrong:

     A DIAPHRAGM DOES NOT FOLLOW THE WAVEFORM.

   It is a mass on a spring with a damper — a driven second-order
   oscillator:

       m·ẍ + c·ẋ + k·x = A·p(t)

   which means it lags the pressure, rings at its own resonance, and
   rolls off above it at 12 dB/octave. Where a designer *puts* that
   resonance is the single biggest decision in a microphone, and it is
   why a condenser, a dynamic and a ribbon sound different:

     condenser  resonance ABOVE the band  -> stiffness-controlled,
                displacement tracks pressure across the audio range
     dynamic    resonance INSIDE the band -> heavily damped, and the
                coil senses velocity, which is flattest at resonance
     ribbon     resonance BELOW the band  -> mass-controlled; the
                floppy foil's velocity comes out flat

   The second thing usually got wrong: the amplitude. At conversational
   level a condenser diaphragm moves about a NANOMETRE — a few atoms
   wide, far less than a wavelength of visible light. The readouts here
   are in real units so you can see that for yourself.

   Normalised, the equation of motion becomes

       ẍ + (ω₀/Q)·ẋ + ω₀²·x = ω₀²·p(t)

   whose transfer function H(s) = ω₀²/(s² + (ω₀/Q)s + ω₀²) is exactly a
   second-order lowpass. So rather than integrate the ODE step by step
   (which goes unstable when ω₀·dt approaches 1 — at 14 kHz and a
   44.1 kHz sample rate, ω₀·dt is already 2.0), we use the bilinear
   transform of that same transfer function: a biquad. Unconditionally
   stable, two multiplies and two adds per sample, and mathematically
   the same system.
   =============================================================== */

/* --------------------------------------------------------------
   Physical constants and the calibration assumption
   -------------------------------------------------------------- */

export const EPS0 = 8.8541878128e-12;   // vacuum permittivity, F/m
export const P_REF = 20e-6;             // 0 dB SPL reference, pascals
export const SOUND_SPEED = 343;         // m/s at 20 °C

/* Digital full scale has no inherent loudness — it depends on the
   capsule, the preamp gain and the converter. We have to assume one to
   print real units at all, so we assume 0 dBFS = 120 dB SPL and say so
   in the UI. Everything in pascals and metres scales with this number. */
export const FS_SPL_DB = 120;
export const P_FULLSCALE = P_REF * Math.pow(10, FS_SPL_DB / 20);   // 20 Pa

/* --------------------------------------------------------------
   The three capsules

   massPerArea is the real areal mass of the moving part (thickness ×
   density, plus the voice coil where there is one). With the resonant
   frequency it fixes the stiffness, k = m''·ω₀², and therefore how far
   the thing actually moves: x = p/k below resonance.
   -------------------------------------------------------------- */

export const MICS = {
  condenser: {
    label: 'Condenser (½″ capsule)',
    f0: 14000, Q: 1.1,
    massPerArea: 6e-6 * 1390,     // 6 µm mylar, 1390 kg/m³
    radiusM: 6.35e-3,
    gapM: 25e-6,                  // diaphragm to backplate
    biasV: 48,                    // polarising voltage
    senses: 'displacement',
    gradient: false,
    geometry: 'disc',
    law: 'C = ε₀A/d  →  V = Q/C',
    blurb: 'Resonance sits above the audio band, so across it the diaphragm is '
         + 'stiffness-controlled and displacement tracks pressure.',
  },
  dynamic: {
    label: 'Dynamic (moving coil)',
    f0: 1500, Q: 0.9,
    massPerArea: 0.10,            // mylar diaphragm plus the voice coil
    radiusM: 13.5e-3,
    fluxT: 1.0,                   // magnet gap flux density, tesla
    coilLenM: 1.8,                // length of wire sitting in that gap
    senses: 'velocity',
    gradient: false,
    geometry: 'dome',
    law: 'EMF = B·L·v',
    blurb: 'Resonance sits inside the audio band and is heavily damped. The coil '
         + 'senses velocity, which is flattest right at resonance.',
  },
  ribbon: {
    label: 'Ribbon (corrugated foil)',
    f0: 30, Q: 0.5,
    massPerArea: 2e-6 * 2700,     // 2 µm aluminium, 2700 kg/m³
    lengthM: 50e-3, widthM: 4e-3,
    pathM: 20e-3,                 // front-to-back path around the baffle
    fluxT: 0.55, ribbonLenM: 50e-3,
    senses: 'velocity',
    gradient: true,
    geometry: 'strip',
    law: 'EMF = B·L·v',
    blurb: 'Resonance sits below the audio band, so the foil is mass-controlled. '
         + 'It is open at the back, so it responds to the pressure gradient, '
         + 'which rises with frequency and cancels the mass roll-off.',
  },
};

/* --------------------------------------------------------------
   Biquad — the bilinear transform of the oscillator above
   -------------------------------------------------------------- */

export class Biquad {
  constructor() { this.reset(); this.b0 = 1; this.b1 = this.b2 = this.a1 = this.a2 = 0; }

  /** Displacement response of a mass–spring–damper: a 2nd-order lowpass.
      Unity gain at DC, |H| = Q at f₀, −12 dB/octave above it. */
  lowpass(f0, Q, fs) {
    const w = 2 * Math.PI * Math.min(f0, fs * 0.45) / fs;
    const cw = Math.cos(w), alpha = Math.sin(w) / (2 * Q);
    const a0 = 1 + alpha;
    this.b0 = ((1 - cw) / 2) / a0;
    this.b1 = (1 - cw) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
    return this;
  }

  /** Transposed direct form II: two state variables, and it keeps its
      precision better than the naive form at low frequencies. */
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  /** |H(f)| — used by the self-test to confirm the discretisation. */
  magnitudeAt(f, fs) {
    const w = 2 * Math.PI * f / fs;
    const cw = Math.cos(w), sw = Math.sin(w);
    const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = this.b0 + this.b1 * cw + this.b2 * c2;
    const ni = -(this.b1 * sw + this.b2 * s2);
    const dr = 1 + this.a1 * cw + this.a2 * c2;
    const di = -(this.a1 * sw + this.a2 * s2);
    return Math.hypot(nr, ni) / Math.hypot(dr, di);
  }

  reset() { this.z1 = 0; this.z2 = 0; }
}

/* --------------------------------------------------------------
   Mode shapes

   A membrane clamped at its rim does not move as a rigid piston. Its
   fundamental mode is a Bessel profile, J₀(2.405·r/R): maximum at the
   centre, pinned to zero at the rim. Above resonance higher modes join
   in and the surface "breaks up" — the second radial mode, J₀(5.520·r/R),
   has a ring that moves the opposite way to the centre.

   J₀ from its series, which converges quickly over the range we need:
     J₀(x) = Σ (−1)^k (x/2)^{2k} / (k!)²
   -------------------------------------------------------------- */

export function besselJ0(x) {
  let term = 1, sum = 1;
  for (let k = 1; k < 24; k++) {
    term *= -(x * x) / (4 * k * k);
    sum += term;
    if (Math.abs(term) < 1e-15) break;
  }
  return sum;
}

const J0_ZERO_1 = 2.404825557695773;
const J0_ZERO_2 = 5.520078110286311;
const SHAPE_N = 160;

/** Lookup tables over r/R ∈ [0,1], normalised to 1 at the centre. */
const MODE_1 = Float32Array.from({ length: SHAPE_N },
  (_, i) => besselJ0(J0_ZERO_1 * i / (SHAPE_N - 1)));
const MODE_2 = (() => {
  const m = Float32Array.from({ length: SHAPE_N },
    (_, i) => besselJ0(J0_ZERO_2 * i / (SHAPE_N - 1)));
  return m;
})();

/** A clamped strip (the ribbon) has a simple half-sine fundamental. */
const STRIP_1 = Float32Array.from({ length: SHAPE_N },
  (_, i) => Math.sin(Math.PI * i / (SHAPE_N - 1)));
const STRIP_2 = Float32Array.from({ length: SHAPE_N },
  (_, i) => Math.sin(2 * Math.PI * i / (SHAPE_N - 1)));

/**
 * Normalised deflection profile across the diaphragm.
 * @param {number} t      0 at the centre (or one end of a ribbon), 1 at the rim
 * @param {number} mix    0..1, how much of the second mode is mixed in
 * @param {boolean} strip true for a ribbon, false for a circular membrane
 */
export function modeShape(t, mix, strip) {
  const i = Math.min(SHAPE_N - 1, Math.max(0, Math.round(t * (SHAPE_N - 1))));
  const a = strip ? STRIP_1[i] : MODE_1[i];
  const b = strip ? STRIP_2[i] : MODE_2[i];
  return a * (1 - mix) + b * mix;
}

/* --------------------------------------------------------------
   The capsule model
   -------------------------------------------------------------- */

export class Capsule {
  constructor(key, sampleRate) {
    this.spec = MICS[key];
    this.key = key;
    this.fs = sampleRate;
    this.lpf = new Biquad().lowpass(this.spec.f0, this.spec.Q, sampleRate);
    this.stiffness = this.spec.massPerArea * Math.pow(2 * Math.PI * this.spec.f0, 2);
    this.prevP = 0;
    this.prevX = 0;
    this.disp = new Float32Array(0);   // metres
    this.press = new Float32Array(0);  // pascals
    this.peakM = 0;
  }

  /**
   * Push one buffer of microphone samples through the capsule.
   * Fills this.disp with displacement in metres and this.press with the
   * driving pressure in pascals.
   *
   * The filter state carries across frames, which is right, but the
   * analyser hands us overlapping snapshots rather than a continuous
   * stream, so there is a small seam at each frame boundary. Removing it
   * entirely would mean an AudioWorklet running on the audio thread.
   */
  process(samples) {
    const n = samples.length;
    if (this.disp.length !== n) {
      this.disp = new Float32Array(n);
      this.press = new Float32Array(n);
    }
    const { gradient, pathM } = this.spec;
    // A pressure-gradient capsule is driven by the difference in pressure
    // between its two faces, Δp ≈ p·ωd/c — a differentiator, which in
    // discrete time is a first difference scaled by fs·d/c.
    const gScale = gradient ? this.fs * pathM / SOUND_SPEED : 0;
    const invK = 1 / this.stiffness;
    let peak = 0;

    for (let i = 0; i < n; i++) {
      const p = samples[i] * P_FULLSCALE;
      const drive = gradient ? (p - this.prevP) * gScale : p;
      this.prevP = p;
      const x = this.lpf.process(drive) * invK;
      this.press[i] = p;
      this.disp[i] = x;
      const a = Math.abs(x);
      if (a > peak) peak = a;
    }
    this.peakM = peak;
    return this;
  }

  /** Instantaneous readings at a (possibly fractional) sample index. */
  readAt(index) {
    const n = this.disp.length;
    if (!n) return { x: 0, v: 0, p: 0 };
    const i = Math.min(n - 1, Math.max(0, index));
    const i0 = Math.floor(i), i1 = Math.min(n - 1, i0 + 1), f = i - i0;
    const x = this.disp[i0] * (1 - f) + this.disp[i1] * f;
    const p = this.press[i0] * (1 - f) + this.press[i1] * f;
    // velocity = dx/dt, taken straight from the displacement series
    const v = (this.disp[i1] - this.disp[i0]) * this.fs;
    return { x, v, p };
  }

  /** What the capsule sends down the cable, in volts. */
  emf(x, v) {
    const s = this.spec;
    if (s.senses === 'displacement') return s.biasV * x / s.gapM;
    return s.fluxT * (s.coilLenM ?? s.ribbonLenM) * v;
  }

  /** Capacitance of a condenser capsule at displacement x, in farads. */
  capacitance(x) {
    const s = this.spec;
    if (s.senses !== 'displacement') return 0;
    const area = Math.PI * s.radiusM * s.radiusM;
    return EPS0 * area / Math.max(s.gapM - x, 1e-9);
  }
}

/* --------------------------------------------------------------
   Formatting
   -------------------------------------------------------------- */

export function metres(x) {
  const a = Math.abs(x);
  if (a < 1e-13) return '0';
  if (a < 1e-9) return `${(x * 1e12).toFixed(0)} pm`;
  if (a < 1e-6) return `${(x * 1e9).toFixed(a < 1e-8 ? 2 : 1)} nm`;
  if (a < 1e-3) return `${(x * 1e6).toFixed(2)} µm`;
  return `${(x * 1e3).toFixed(2)} mm`;
}

export function volts(v) {
  const a = Math.abs(v);
  if (a < 1e-9) return '0';
  if (a < 1e-6) return `${(v * 1e9).toFixed(0)} nV`;
  if (a < 1e-3) return `${(v * 1e6).toFixed(1)} µV`;
  if (a < 1) return `${(v * 1e3).toFixed(2)} mV`;
  return `${v.toFixed(3)} V`;
}

export function magnification(n) {
  if (!isFinite(n) || n <= 0) return '—';
  if (n >= 1e9) return `×${(n / 1e9).toFixed(1)} billion`;
  if (n >= 1e6) return `×${(n / 1e6).toFixed(1)} million`;
  if (n >= 1e3) return `×${(n / 1e3).toFixed(0)} thousand`;
  return `×${n.toFixed(0)}`;
}

/** SPL in dB from a pressure in pascals. */
export function spl(pPa) {
  return 20 * Math.log10(Math.max(Math.abs(pPa), 1e-12) / P_REF);
}

/* ===============================================================
   Drawing the capsule

   Two views side by side: a cross-section with the sound arriving from
   the left, and a face-on view of the membrane.

   Everything is drawn in device pixels, same as the rest of the app.
   =============================================================== */

/* Deep enough to read on white, bright enough to read on black — these
   are drawn over both themes' canvas backgrounds. */
const WARM = [233, 115, 45];    // compression — pushed in
const COOL = [48, 132, 232];    // rarefaction — pulled out

const rgba = (c, a) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

let PAL = { axis: '#888' };   // set at the top of every drawCapsule()

/**
 * Colour for a signed deflection, −1..+1.
 * `floor` keeps a line visible when the deflection is small: fading all the
 * way to transparent works against black and disappears against white.
 * The pressure bands pass floor 0, because there "nothing" should show as
 * nothing.
 */
function deflectColour(u, alpha = 1, floor = 0) {
  const m = Math.min(1, Math.abs(u));
  return rgba(u >= 0 ? WARM : COOL, (floor + (1 - floor) * m) * alpha);
}

/**
 * @param {{ctx:CanvasRenderingContext2D,w:number,h:number,dpr:number}} s
 * @param {object} o
 *   o.capsule   Capsule
 *   o.deflect   normalised deflection now, −1..+1
 *   o.mix       break-up mix, 0..1
 *   o.air       Float32Array of pressure in pascals, index 0 = at the
 *               diaphragm now, later indices = still travelling in
 *   o.airPeak   pascals that maps to full colour
 *   o.theme     palette read from the CSS custom properties
 *   o.running   false → draw the resting capsule
 */
export function drawCapsule(s, o) {
  const { ctx, w, h, dpr } = s;
  PAL = o.theme;
  ctx.fillStyle = o.theme.bg;
  ctx.fillRect(0, 0, w, h);

  let box;
  if (w > 520 * dpr) {                       // side by side
    const split = Math.round(w * 0.64);
    box = drawSection(s, o, 0, split, 0, h);
    drawFace(s, o, split, w - split, 0, h);
  } else {                                   // stacked, for narrow screens
    const splitY = Math.round(h * 0.63);
    box = drawSection(s, o, 0, w, 0, splitY);
    drawFace(s, o, 0, w, splitY, h - splitY);
  }

  /* How much the drawing exaggerates the real motion.
     A deflection of 1.0 is drawn as `swing` pixels and corresponds to
     `visPeak` metres. Drawn honestly to the same scale as the diaphragm
     itself, that many metres would be only `visPeak · pxPerMetre` pixels. */
  const spec = o.capsule.spec;
  const realSpan = spec.geometry === 'strip' ? spec.lengthM : spec.radiusM * 2;
  const pxPerMetre = box.span / realSpan;
  return { magnification: box.swing / Math.max(o.visPeak * pxPerMetre, 1e-30) };
}

/* ---------------- cross-section ---------------- */

function drawSection(s, o, x0, width, y0, hh) {
  const { ctx, dpr } = s;
  const t = o.theme;
  const spec = o.capsule.spec;
  const kind = spec.geometry;

  const X = (f) => x0 + width * f;
  const grille = X(0.035);
  const airL = X(0.075), airR = X(0.40);
  const rest = X(0.50);                       // diaphragm at rest
  const plate = X(0.575), plateW = 7 * dpr;   // backplate / coil former
  const cavL = X(0.635), cavR = X(0.89);
  const top = y0 + hh * 0.21, bot = y0 + hh * 0.79;
  const swing = Math.min(width * 0.065, (bot - top) * 0.17);

  /* --- the air in front: pressure on its way to the diaphragm --- */
  const boxT = top - 6 * dpr, boxB = bot + 6 * dpr;
  if (o.air && o.air.length > 1) {
    const n = o.air.length;
    for (let x = airL; x < airR; x += dpr) {
      // Right edge = reaching the diaphragm now. Left = still travelling.
      const f = 1 - (x - airL) / (airR - airL);
      const p = o.air[Math.min(n - 1, Math.round(f * (n - 1)))];
      const u = Math.max(-1, Math.min(1, p / o.airPeak));
      if (Math.abs(u) < 0.02) continue;
      ctx.fillStyle = deflectColour(u, 0.6);
      ctx.fillRect(x, boxT, Math.ceil(dpr), boxB - boxT);
    }
  }
  ctx.strokeStyle = t.grid;
  ctx.lineWidth = dpr;
  ctx.strokeRect(airL + .5, boxT + .5, airR - airL, boxB - boxT);
  labelAt(s, 'incoming pressure', airL, boxT - 9 * dpr);
  arrow(s, (airL + airR) / 2, boxB + 11 * dpr, 26 * dpr, t.axis);

  /* --- grille --- */
  ctx.fillStyle = t.gridStrong;
  for (let y = top; y <= bot; y += 10 * dpr) {
    ctx.beginPath();
    ctx.arc(grille, y, 1.4 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }

  /* --- what sits behind the diaphragm --- */
  if (kind !== 'strip') {
    // The sealed back cavity is a spring in its own right: the trapped air
    // stiffens the diaphragm. The capillary vent bleeds off slow pressure
    // changes — weather, altitude, a door closing — which would otherwise
    // push the diaphragm hard against one side.
    ctx.strokeStyle = t.gridStrong;
    ctx.lineWidth = dpr;
    ctx.strokeRect(cavL + .5, top + .5, cavR - cavL, bot - top);
    ctx.save();
    ctx.beginPath();
    ctx.rect(cavL, top, cavR - cavL, bot - top);
    ctx.clip();
    ctx.strokeStyle = t.grid;
    for (let d = -(bot - top); d < cavR - cavL; d += 9 * dpr) {
      ctx.beginPath();
      ctx.moveTo(cavL + d, bot);
      ctx.lineTo(cavL + d + (bot - top), top);
      ctx.stroke();
    }
    ctx.restore();
    labelAt(s, 'back cavity', cavL + 7 * dpr, bot - 10 * dpr);

    ctx.fillStyle = t.axis;
    ctx.fillRect(cavR, (top + bot) / 2 - 1.5 * dpr, 12 * dpr, 3 * dpr);
    labelAt(s, 'vent', cavR + 1 * dpr, (top + bot) / 2 - 10 * dpr);
  }

  if (spec.senses === 'displacement') {
    // Perforated backplate: the other plate of the capacitor. Its holes
    // let the trapped air escape, and that escaping air is most of the
    // damping that stops the diaphragm ringing.
    ctx.fillStyle = t.axis;
    ctx.fillRect(plate, top, plateW, bot - top);
    ctx.fillStyle = t.bg;
    for (let y = top + 8 * dpr; y < bot - 5 * dpr; y += 14 * dpr) {
      ctx.fillRect(plate + 1 * dpr, y, plateW - 2 * dpr, 5 * dpr);
    }
    labelVert(s, 'perforated backplate', plate + plateW + 9 * dpr, bot - 4 * dpr);
    // The gap the whole thing measures — and how little of it is used.
    gapMark(s, rest, plate + plateW, bot + 17 * dpr, t,
            `${(spec.gapM * 1e6).toFixed(0)} µm`);
  } else if (kind === 'dome') {
    /* The coil is glued to the back of the diaphragm and travels with it,
       between two stationary pole faces. Drawing the gap as a fixed box
       would show the coil sliding out of its own magnet. */
    const cy = (top + bot) / 2, ch = (bot - top) * 0.22;
    const dx = swing * o.deflect;
    const former = swing + 12 * dpr;             // keeps the coil behind the
    const coilX = rest + former + dx;            // diaphragm at every position
    ctx.fillStyle = t.grid;                      // stationary pole faces
    ctx.fillRect(rest + 8 * dpr, cy - ch - 11 * dpr, 2 * swing + 18 * dpr, 8 * dpr);
    ctx.fillRect(rest + 8 * dpr, cy + ch + 3 * dpr, 2 * swing + 18 * dpr, 8 * dpr);
    ctx.strokeStyle = t.axis;                    // former, joining coil to centre
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(rest + dx, cy); ctx.lineTo(coilX, cy);
    ctx.stroke();
    ctx.fillStyle = t.axis;                      // the coil itself
    ctx.fillRect(coilX - 2.5 * dpr, cy - ch, 5 * dpr, ch * 2);
    labelAt(s, 'coil in magnet gap', rest + 10 * dpr, bot + 18 * dpr);
  } else {
    // Ribbon: poles above and below, nothing behind — it is open on both
    // faces, which is what makes it a pressure-gradient device.
    ctx.fillStyle = t.grid;
    ctx.fillRect(rest - 26 * dpr, top - 15 * dpr, 56 * dpr, 12 * dpr);
    ctx.fillRect(rest - 26 * dpr, bot + 4 * dpr, 56 * dpr, 12 * dpr);
    labelAt(s, 'N', rest - 22 * dpr, top - 9 * dpr);
    labelAt(s, 'S', rest - 22 * dpr, bot + 10 * dpr);
    labelAt(s, 'open at the back —', cavL, top + 11 * dpr);
    labelAt(s, 'both faces see the sound', cavL, top + 23 * dpr);
  }

  /* --- the diaphragm, in its mode shape --- */
  const steps = 72;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;                        // 0 = top rim, 1 = bottom rim
    const shape = kind === 'strip'
      ? Math.sin(Math.PI * u) * (1 - o.mix) + Math.sin(2 * Math.PI * u) * o.mix
      : modeShape(Math.abs(u * 2 - 1), o.mix, false);
    ctx.lineTo(rest + swing * o.deflect * shape, top + (bot - top) * u);
  }
  ctx.strokeStyle = o.running ? deflectColour(o.deflect, 1, 0.5) : t.axis;
  ctx.lineWidth = 2.4 * dpr;
  ctx.lineJoin = 'round';
  ctx.shadowColor = o.running ? deflectColour(o.deflect, 0.55, 0.3) : 'transparent';
  ctx.shadowBlur = 9 * dpr;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Rest position, so a deflection reads as a deflection.
  ctx.strokeStyle = t.grid;
  ctx.lineWidth = dpr;
  ctx.setLineDash([2 * dpr, 3 * dpr]);
  ctx.beginPath();
  ctx.moveTo(rest + .5, top); ctx.lineTo(rest + .5, bot);
  ctx.stroke();
  ctx.setLineDash([]);

  if (kind !== 'strip') {                       // clamped rims
    ctx.fillStyle = t.axis;
    ctx.fillRect(rest - 4 * dpr, top - 7 * dpr, 9 * dpr, 8 * dpr);
    ctx.fillRect(rest - 4 * dpr, bot - 1 * dpr, 9 * dpr, 8 * dpr);
  }

  labelAt(s, kind === 'strip' ? 'ribbon' : 'diaphragm',
          rest - 24 * dpr, kind === 'strip' ? top - 25 * dpr : boxT - 9 * dpr);
  labelAt(s, spec.law, x0 + 8 * dpr, y0 + hh - 9 * dpr);
  if (o.extra) labelAt(s, o.extra, x0 + 8 * dpr, y0 + hh - 21 * dpr);
  return { swing, span: bot - top };
}

/** A dimension line between two x positions. */
function gapMark(s, xa, xb, y, t, text) {
  const { ctx, dpr } = s;
  ctx.strokeStyle = t.axis;
  ctx.lineWidth = dpr;
  ctx.beginPath();
  ctx.moveTo(xa, y - 4 * dpr); ctx.lineTo(xa, y + 4 * dpr);
  ctx.moveTo(xb, y - 4 * dpr); ctx.lineTo(xb, y + 4 * dpr);
  ctx.moveTo(xa, y); ctx.lineTo(xb, y);
  ctx.stroke();
  labelAt(s, text, xa - 2 * dpr, y + 13 * dpr);
}

/* ---------------- the membrane, three-quarter view ---------------- */

function drawFace(s, o, x0, width, y0, hh) {
  const { ctx, dpr } = s;
  const t = o.theme;
  const cx = x0 + width / 2, cy = y0 + hh * 0.52;

  if (o.capsule.spec.geometry === 'strip') {
    // A ribbon is a strip clamped top and bottom, so its fundamental is a
    // half sine. The corrugations are what let flat foil stretch at all.
    const ribW = Math.min(width * 0.32, 58 * dpr), ribH = hh * 0.6;
    const maxPush = Math.min(width * 0.13, 28 * dpr);
    // The rest frame, so the sideways travel has something to read against.
    ctx.strokeStyle = t.gridStrong;
    ctx.lineWidth = dpr;
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.strokeRect(cx - ribW / 2 - .5, cy - ribH / 2 - .5, ribW + 1, ribH + 1);
    ctx.setLineDash([]);
    for (let i = 0; i <= 16; i++) {
      const u = i / 16;
      const d = Math.sin(Math.PI * u) * (1 - o.mix) + Math.sin(2 * Math.PI * u) * o.mix;
      const y = cy - ribH / 2 + ribH * u;
      const push = o.deflect * d * maxPush;
      ctx.fillStyle = t.gridStrong;
      ctx.fillRect(cx - ribW / 2 + push, y - 2 * dpr, ribW, 4 * dpr);
      if (o.running && Math.abs(o.deflect * d) > 0.015) {
        ctx.fillStyle = deflectColour(o.deflect * d, 0.95, 0.2);
        ctx.fillRect(cx - ribW / 2 + push, y - 2 * dpr, ribW, 4 * dpr);
      }
    }
    labelAt(s, 'corrugated ribbon', cx - ribW, cy + ribH / 2 + 15 * dpr);
    return;
  }

  /* A drum head seen from three-quarters on. Rings of constant radius are
     drawn as ellipses, each lifted by how far that radius moves — so the
     Bessel profile becomes a visible dome, and the pinned rim stays put. */
  const R = Math.min(width * 0.43, hh * 0.40);
  const SQUASH = 0.36;
  const lift = Math.min(hh * 0.15, R * 0.42);
  const RINGS = 13, SPOKES = 16;

  ctx.lineWidth = dpr;
  for (let a = 0; a < SPOKES; a++) {
    const th = (a / SPOKES) * Math.PI * 2;
    const ca = Math.cos(th), sa = Math.sin(th);
    ctx.beginPath();
    for (let i = 0; i <= RINGS; i++) {
      const u = i / RINGS, r = R * u;
      const d = modeShape(u, o.mix, false);
      ctx.lineTo(cx + r * ca, cy + r * SQUASH * sa - o.deflect * d * lift);
    }
    ctx.strokeStyle = t.gridStrong;
    ctx.stroke();
  }
  for (let i = RINGS; i >= 1; i--) {
    const u = i / RINGS, r = R * u;
    const d = modeShape(u, o.mix, false);
    ctx.beginPath();
    ctx.ellipse(cx, cy - o.deflect * d * lift, r, r * SQUASH, 0, 0, Math.PI * 2);
    const moved = o.running && Math.abs(o.deflect * d) > 0.015;
    ctx.strokeStyle = moved ? deflectColour(o.deflect * d, 0.95, 0.22) : t.gridStrong;
    ctx.lineWidth = (i === RINGS ? 1.8 : 1.2) * dpr;
    ctx.stroke();
  }
  // Centre marker: the point that moves furthest.
  ctx.beginPath();
  ctx.arc(cx, cy - o.deflect * lift, 2.4 * dpr, 0, Math.PI * 2);
  ctx.fillStyle = o.running ? deflectColour(o.deflect, 1, 0.5) : t.axis;
  ctx.fill();

  if (o.mix > 0.05) {
    const node = findZero(o.mix);
    if (node > 0) {
      ctx.strokeStyle = t.axis;
      ctx.lineWidth = dpr;
      ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.beginPath();
      ctx.ellipse(cx, cy, R * node, R * node * SQUASH, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  labelAt(s, o.mix > 0.05 ? 'breaking up — ring moves against centre' : 'membrane, 3/4 view',
          cx - R, cy + R * SQUASH + lift * 0.5 + 16 * dpr);
}

/** Radius (0..1) where the blended mode shape crosses zero, if it does. */
function findZero(mix) {
  let prev = modeShape(0, mix, false);
  for (let i = 1; i <= 80; i++) {
    const t = i / 80;
    const v = modeShape(t, mix, false);
    if ((prev < 0) !== (v < 0)) return t;
    prev = v;
  }
  return 0;
}

/* ---------------- small primitives ---------------- */

function labelAt(s, text, x, y) {
  s.ctx.fillStyle = PAL.axis;
  s.ctx.font = `${Math.round(9.5 * s.dpr)}px ui-monospace, monospace`;
  s.ctx.textAlign = 'left';
  s.ctx.textBaseline = 'middle';
  s.ctx.fillText(text, x, y);
}

function labelVert(s, text, x, y) {
  const { ctx } = s;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-Math.PI / 2);
  labelAt(s, text, 0, 0);
  ctx.restore();
}

function arrow(s, x, y, len, colour) {
  const { ctx, dpr } = s;
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = dpr;
  ctx.beginPath();
  ctx.moveTo(x - len / 2, y); ctx.lineTo(x + len / 2, y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + len / 2, y);
  ctx.lineTo(x + len / 2 - 4 * dpr, y - 3 * dpr);
  ctx.lineTo(x + len / 2 - 4 * dpr, y + 3 * dpr);
  ctx.closePath();
  ctx.fill();
}
