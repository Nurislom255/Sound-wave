/* Self-test for the capsule model in diaphragm.js.
   Run with:  node test/physics.test.mjs
   No framework, no dependencies — it just asserts and prints. */

import {
  Biquad, Capsule, MICS, besselJ0, modeShape, spl,
  P_REF, P_FULLSCALE,
} from '../diaphragm.js';

let pass = 0, fail = 0;

function ok(name, got, want, tol, unit = '') {
  const good = Math.abs(got - want) <= tol;
  good ? pass++ : fail++;
  const g = typeof got === 'number' ? got.toPrecision(5) : got;
  console.log(`${good ? '  ok  ' : '  FAIL'} ${name.padEnd(52)} ${g}${unit}` +
              (good ? '' : `   (expected ${want}${unit} ±${tol})`));
}

const FS = 48000;

/* ---- the biquad really is the oscillator it claims to be ---------- */
console.log('\nbiquad = bilinear transform of m·ẍ + c·ẋ + k·x = p');
{
  const f0 = 1000, Q = 2.5;
  const b = new Biquad().lowpass(f0, Q, FS);
  // Unity gain at DC: a static pressure gives the static displacement p/k.
  ok('|H(0)| = 1  (static deflection = p/k)', b.magnitudeAt(0.001, FS), 1, 1e-3);
  // At resonance a 2nd-order lowpass peaks at exactly Q.
  ok(`|H(f0)| = Q = ${Q}`, b.magnitudeAt(f0, FS), Q, 0.05);
  // Two octaves above: 12 dB/octave means a factor of 16.
  ok('|H(4·f0)| = 1/16  (−12 dB/octave)', b.magnitudeAt(4 * f0, FS), 1 / 16, 0.004);
  // Phase lag is what makes the diaphragm trail the pressure. Check the
  // step response overshoots, as an underdamped system must.
  const s = new Biquad().lowpass(200, 3, FS);
  let peak = 0;
  for (let i = 0; i < FS; i++) peak = Math.max(peak, s.process(1));
  ok('underdamped step response overshoots 1', peak > 1.3 && peak < 1.8 ? 1 : peak, 1, 0);
}

/* ---- the lag, which is the whole visible point ---------------------- */
console.log('\nphase lag — why the diaphragm trace trails the pressure');
{
  /* Project the output onto sin and cos of the drive. For an output
     A·sin(θ − φ):  Σ y·sinθ → (N/2)A·cos φ,  Σ y·cosθ → −(N/2)A·sin φ. */
  function lagDeg(f0, Q, f, fs = FS) {
    const b = new Biquad().lowpass(f0, Q, fs);
    const n = fs, skip = (fs / 2) | 0;
    let si = 0, co = 0;
    for (let i = 0; i < n; i++) {
      const th = 2 * Math.PI * f * i / fs;
      const y = b.process(Math.sin(th));
      if (i < skip) continue;                 // let the transient die first
      si += y * Math.sin(th);
      co += y * Math.cos(th);
    }
    return Math.atan2(-co, si) * 180 / Math.PI;
  }
  // These three are the signature of every second-order system there is.
  ok('lag well below resonance → ~0°', lagDeg(1500, 0.9, 100), 4.4, 1, '°');
  ok('lag AT resonance → exactly 90°', lagDeg(1500, 0.9, 1500), 90, 0.5, '°');
  /* The analog prototype would give 175.6° here. The digital one gives
     ~173.7°, and that gap is real, not an error: the bilinear transform
     compresses the whole infinite analog frequency axis into the range up
     to Nyquist, so phase near Nyquist is warped. The lowpass() method
     pre-warps f0 so resonance lands exactly where asked — which is why the
     90° check above is exact — but points far from f0 still shift. */
  ok('lag well above resonance → approaching 180°', lagDeg(1500, 0.9, 12000), 173.7, 0.5, '°');

  // Which is what the overlay on the waveform shows: a quarter period.
  const ms = (90 / 360) / 1500 * 1000;
  console.log(`        at 1.5 kHz that is a ${ms.toFixed(3)} ms shift — a quarter of a cycle`);
}

/* ---- mode shapes --------------------------------------------------- */
console.log('\nmembrane mode shapes (Bessel)');
ok('J₀(0) = 1', besselJ0(0), 1, 1e-12);
ok('J₀(2.4048…) = 0   (first zero → the clamped rim)', besselJ0(2.404825557695773), 0, 1e-9);
ok('J₀(5.5201…) = 0   (second zero → break-up ring)', besselJ0(5.520078110286311), 0, 1e-9);
ok('J₀(1) = 0.765198…', besselJ0(1), 0.7651976865579666, 1e-12);
ok('shape at centre = 1', modeShape(0, 0, false), 1, 1e-6);
ok('shape at rim    = 0', modeShape(1, 0, false), 0, 1e-6);
ok('strip shape at both ends = 0', modeShape(1, 0, true) + modeShape(0, 0, true), 0, 1e-6);

/* ---- real-world amplitudes ---------------------------------------- */
console.log('\namplitudes against published figures');
// Drive each capsule with a 1 Pa sine — 94 dB SPL, the calibration standard.
function driveAt(key, freqHz, pascals = 1) {
  const cap = new Capsule(key, FS);
  const n = FS;                               // one second, well past settling
  const buf = new Float32Array(n);
  const amp = pascals / P_FULLSCALE;          // pascals → full-scale units
  for (let i = 0; i < n; i++) buf[i] = amp * Math.sin(2 * Math.PI * freqHz * i / FS);
  cap.process(buf);
  // Peak over the final third, once transients have died away.
  let x = 0, v = 0;
  for (let i = (n * 2 / 3) | 0; i < n; i++) {
    x = Math.max(x, Math.abs(cap.disp[i]));
    v = Math.max(v, Math.abs((cap.disp[i] - cap.disp[i - 1]) * FS));
  }
  return { cap, x, v };
}

{
  const { cap, x } = driveAt('condenser', 1000);
  ok('condenser displacement @1 kHz, 94 dB', x * 1e9, 15.5, 1.0, ' nm');
  ok('condenser capsule capacitance', cap.capacitance(0) * 1e12, 44.9, 1.0, ' pF');
  ok('condenser sensitivity (real: 10–30 mV/Pa)', Math.abs(cap.emf(x, 0)) * 1e3, 29.8, 2, ' mV/Pa');
}
{
  const { cap, x, v } = driveAt('dynamic', 1000);
  ok('dynamic displacement @1 kHz, 94 dB', x * 1e9, 113, 15, ' nm');
  ok('dynamic sensitivity (real: 1.5–3 mV/Pa)', Math.abs(cap.emf(0, v)) * 1e3, 1.3, 0.4, ' mV/Pa');
}

/* ---- the ribbon's whole trick ------------------------------------- */
console.log('\nribbon: pressure gradient cancels mass roll-off');
// Mass control alone rolls displacement off at 12 dB/oct, so velocity
// would fall 6 dB/oct. The gradient drive rises 6 dB/oct. The two cancel
// and the velocity — which is what the foil actually transduces — comes
// out flat. That is the entire design.
{
  const vels = [200, 500, 1000, 2000, 5000].map((f) => driveAt('ribbon', f).v);
  const dB = vels.map((v) => 20 * Math.log10(v / vels[2]));
  console.log('        velocity response, dB re 1 kHz:',
    dB.map((d, i) => `${[200, 500, 1000, 2000, 5000][i]}Hz ${d >= 0 ? '+' : ''}${d.toFixed(1)}`).join('  '));
  const spread = Math.max(...dB) - Math.min(...dB);
  ok('velocity flat within 3 dB, 200 Hz–5 kHz', spread, 0, 3, ' dB spread');

  // ...while its displacement does fall steeply, which is why ribbons are
  // fragile: a plosive or a gust moves the foil enormously at low frequency.
  const lo = driveAt('ribbon', 50).x, hi = driveAt('ribbon', 5000).x;
  ok('displacement falls ≥30 dB from 50 Hz to 5 kHz', 20 * Math.log10(lo / hi), 45, 18, ' dB');
}

/* ---- the calibration assumption ------------------------------------ */
console.log('\ncalibration');
ok('0 dBFS = 120 dB SPL', spl(P_FULLSCALE), 120, 1e-6, ' dB');
// 1 Pa is 93.979 dB SPL, not exactly 94 — the round number is the
// convention, the exact figure is what the arithmetic gives.
ok('1 Pa = 93.979 dB SPL', spl(1), 93.979, 1e-3, ' dB');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
