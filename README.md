# Sound Wave

A live microphone visualiser that runs entirely in the browser. No build step, no
dependencies, no server beyond a static file host. Three views of the same signal:

| View | What it shows |
| --- | --- |
| **Waveform** | Air pressure over time — an oscilloscope, with trigger lock so the trace holds still |
| **Spectrum** | How much energy sits at each frequency, right now, on a log or linear axis |
| **Capsule** | The diaphragm itself: how far it moves, in nanometres, and when |
| **Spectrogram** | The spectrum scrolling through time, so you can watch sounds evolve |

Plus an RMS/peak meter in dBFS and a dominant-frequency readout with the nearest
note name.

## Run it

The browser only grants microphone access in a **secure context**, which means
`https://` or `localhost`. Double-clicking `index.html` gives you a `file://` URL,
which is *not* secure — the page will tell you so and refuse. Serve the folder:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static server works (`npx serve`, `php -S localhost:8000`, a VS Code Live
Server extension). Then press **Start mic** and allow the permission prompt.

Audio is analysed in the page and never leaves your machine. Nothing is recorded
or uploaded.

### Keys

- <kbd>S</kbd> — start / stop
- <kbd>Space</kbd> — freeze the display (audio keeps flowing)

## Files

```
index.html              markup and controls
styles.css              design tokens, light/dark themes, layout
app.js                  the audio graph, the measurements, and the draw loop
diaphragm.js            the capsule model and its two drawings
test/physics.test.mjs   checks the model against published figures
```

Run the physics self-test with no server and no dependencies:

```bash
node test/physics.test.mjs
```

It asserts the things the capsule panel claims: that the discretised
oscillator has unity gain at DC, peaks at exactly Q at resonance, rolls off at
12 dB/octave, lags by exactly 90° at resonance, that the Bessel mode shape is
pinned at the rim, that a condenser diaphragm moves 15.5 nm at 94 dB SPL with a
44.9 pF capsule and 30 mV/Pa sensitivity, and that a ribbon's velocity response
comes out flat within 1 dB from 200 Hz to 5 kHz.

## How it works

### The audio graph

```
MediaStreamSource ──▶ GainNode ──▶ AnalyserNode
   (microphone)       (our dial)   (the measuring tap)
```

Nothing connects to `ctx.destination` on purpose. Routing the microphone back to
the speakers would create an acoustic feedback loop — the howl you get when
someone walks a live mic past a PA. An `AnalyserNode` still receives audio
without an output, because a live source drives the graph.

`getUserMedia` is asked for `echoCancellation`, `noiseSuppression` and
`autoGainControl` all **off**. Those are tuned for voice calls: they gate out
quiet passages and squash dynamics, which is exactly the information we want to
look at.

### Two views of the same instant

Every animation frame the analyser is asked for two snapshots:

```js
analyser.getFloatTimeDomainData(time);  // fftSize samples, each -1..+1
analyser.getFloatFrequencyData(freq);   // fftSize/2 bins, each in decibels
```

The first is the raw pressure curve. The second is its Fourier transform: the
same chunk of sound re-described as "how much of each frequency is in here".
Same data, two coordinate systems — that is the whole idea behind the FFT.

### The resolution trade-off

`fftSize` is the one knob that decides everything downstream:

| fftSize | Window at 48 kHz | Bin width | Feels like |
| --- | --- | --- | --- |
| 512 | 10.7 ms | 93.8 Hz | fast and twitchy, blurry pitch |
| 2048 | 42.7 ms | 23.4 Hz | a good default |
| 16384 | 341 ms | 2.9 Hz | razor-sharp pitch, sluggish |

Bin width is `sampleRate / fftSize`, window length is `fftSize / sampleRate`.
Multiply the two and you get 1 — you cannot improve frequency resolution and
time resolution at the same time. That is not an implementation limit; it is the
time–frequency uncertainty principle, and every spectrum analyser ever built
lives with it. The sidebar prints both numbers so you can watch the trade happen.

### Trigger lock

Each frame grabs a fresh buffer at an arbitrary phase, so a steady tone would
slide across the screen like a badly tuned TV. Hardware oscilloscopes solve this
with a *trigger*: start drawing at the first rising crossing of zero. Fourteen
lines of code, and the wave snaps still:

```js
function findTrigger(buf, level, limit) {
  for (let i = 1; i < limit; i++) {
    if (buf[i - 1] < level && buf[i] >= level) return i;
  }
  return 0;
}
```

This is why only half the buffer is ever displayed — the other half is headroom
for the trigger search.

### Drawing many samples into few pixels

When the window holds more samples than the canvas has pixels, a plain polyline
aliases into visual noise: it happens to sample some peaks and miss others.
Audio editors solve it by drawing the **min–max envelope** of each pixel column
instead — one vertical line from the lowest to the highest sample that column
covers. `drawScope()` switches to that automatically past 1.5 samples per pixel.

### Finding the peak between the bins

A 440 Hz tone analysed with 23.4 Hz bins lands between bin 18 (421 Hz) and bin 19
(445 Hz). Reporting the loudest bin would be wrong by up to half a bin. Fitting a
parabola through the peak bin and its two neighbours recovers the true position:

```js
const shift = 0.5 * (a - c) / (a - 2 * b + c);   // a, b, c = dB of bins k-1, k, k+1
return (k + shift) * binHz;
```

With this, the 440 Hz test tone reads back as 440.1 Hz.

### Why the frequency axis is logarithmic

The analyser's bins are evenly spaced in Hz, but pitch is perceived
logarithmically: 100 → 200 Hz and 1000 → 2000 Hz are both one octave. On a linear
axis the bottom four octaves — nearly all of music and speech — are crushed into
the leftmost sliver. The log axis maps pixel `x` to
`f = 25 · (20000/25)^(x/width)` and takes the **maximum** dB over every bin that
pixel covers, so narrow peaks never vanish when many bins share a pixel.

## What the diaphragm is actually doing

The waveform panel shows the signal *after* the microphone. The capsule panel
shows the mechanical step that produced it, and it is built around one fact that
most animated-microphone graphics get wrong.

### A diaphragm does not follow the waveform

It is a mass on a spring with a damper — a driven second-order oscillator:

```
m·ẍ + c·ẋ + k·x = A·p(t)
```

so it **lags** the pressure, **rings** at its own resonance, and **rolls off**
above it at 12 dB/octave. Turn on *Diaphragm trace on waveform* and you see the
lag directly: a second trace that trails the pressure driving it. Pick the
dynamic capsule and feed it something near 1.5 kHz, and the lag is exactly a
quarter of a cycle — 90°, which is what every second-order system does at its
own resonance, whatever its Q.

Normalised, that equation becomes

```
ẍ + (ω₀/Q)·ẋ + ω₀²·x = ω₀²·p(t)
```

whose transfer function `H(s) = ω₀²/(s² + (ω₀/Q)s + ω₀²)` is exactly a
second-order lowpass. So rather than integrate the differential equation step by
step — which goes unstable once ω₀·dt approaches 1, and at 14 kHz on a 44.1 kHz
stream ω₀·dt is already 2.0 — the code uses the bilinear transform of that same
transfer function: a biquad. Unconditionally stable, two multiplies per sample,
and mathematically the same system.

### Where you put the resonance is the whole design

This is why the three capsule types sound different, and the panel lets you
switch between them:

| | Resonance | Senses | Moves (94 dB SPL) | Output |
| --- | --- | --- | --- | --- |
| **Condenser** | 14 kHz — *above* the band | displacement | 15.5 nm | ~30 mV/Pa |
| **Dynamic** | 1.5 kHz — *inside* it | velocity | 113 nm | ~1.3 mV/Pa |
| **Ribbon** | 30 Hz — *below* it | velocity | microns | ~0.5 mV/Pa |

A condenser puts resonance above the audio band, so across the band it is
stiffness-controlled and displacement tracks pressure. A dynamic puts it inside
the band and damps it hard, because the coil senses *velocity*, and velocity is
flattest right at resonance. A ribbon puts it below the band, so the foil is
mass-controlled — and because it is open at the back it responds to the pressure
*gradient*, which rises at 6 dB/octave and exactly cancels the mass roll-off.
That cancellation is why ribbons are flat, and the test suite checks it: 0.9 dB
of variation from 200 Hz to 5 kHz.

It also explains why ribbons are fragile. Their *displacement* falls 38 dB from
50 Hz to 5 kHz, which is another way of saying the foil moves enormously at low
frequencies. A plosive or a gust of wind can stretch it permanently.

### It moves a few nanometres

At conversational level a condenser diaphragm moves about **one nanometre** —
a few atoms wide, far smaller than a wavelength of visible light. At 94 dB SPL,
15.5 nm: 0.06% of the 25 µm gap it sits in. The panel prints the real figure in
nanometres and, separately, the factor the drawing is exaggerated by, so you can
see both the truth and the picture.

Those numbers come from real material properties — 6 µm mylar at 1390 kg/m³
gives the areal mass, which with the resonant frequency fixes the stiffness
`k = m''·ω₀²` and therefore `x = p/k`. They land where published figures do: a
44.9 pF capsule (real ones are 20–60 pF) at ~30 mV/Pa (real ones 10–30).

### It does not move as a flat piston

A membrane clamped at its rim moves in a *mode shape*. The fundamental is a
Bessel profile, `J₀(2.405·r/R)`: maximum at the centre, pinned to zero at the
rim. That is what the ¾ view draws — a drum head, with rings lifted by how far
each radius actually travels.

Drive it above resonance and higher modes join in: the second radial mode,
`J₀(5.520·r/R)`, has a ring that moves *against* the centre. The panel blends
this in and marks the node circle. That is break-up, and it is real — though
what is drawn is indicative, not a modal simulation of any particular capsule.

### Why slow motion

A diaphragm at 440 Hz swings back and forth 440 times a second. Sampled by a
60 fps display, that aliases into nonsense — you would see a slow random wobble
with no relationship to the real motion.

So the panel does what a high-speed camera does: it captures a real slice of
motion — one analyser buffer, about 46 ms of genuinely measured displacement —
and replays it over a second or more. **Everything you see moving really
happened. Only the clock is changed.** Set the slider to *real time* and you get
the honest, useless, aliased version.

### Things the capsule panel is not

- The 0 dBFS = 120 dB SPL calibration is an *assumption*. Real sensitivity
  depends on your microphone and preamp gain. Read the figures as the right
  order of magnitude, not a measurement of your hardware.
- Your actual microphone is almost certainly none of these three idealisations.
- Break-up is indicative, not a finite-element model.
- The filter state carries across animation frames, but the analyser hands over
  overlapping snapshots rather than a continuous stream, so there is a small
  seam at each frame boundary. Removing it would mean an AudioWorklet running on
  the audio thread.

### RMS, not average

```js
Math.sqrt(sum_of(sample * sample) / n)
```

Squaring makes every sample positive and weights the loud ones. A plain average
of any symmetric wave is roughly zero no matter how loud it is, which is why RMS
is what meters actually show.

## Things to try

- Whistle, and watch the dominant-frequency readout track your pitch.
- Say "sss" then "shhh" — on the spectrogram, broadband noise that shifts down.
- Hum a steady note and raise **FFT size** to 16384: the harmonic stack separates
  into a neat ladder. Drop to 512 and the ladder smears into a blob.
- Set **Smoothing** to 0 and watch the spectrum get jumpy. That slider is an
  exponential moving average over frames, nothing more.
- Clap once with **Smoothing** at 0 — a vertical stripe across every frequency.
  An impulse contains all of them.
- Switch the capsule to **Dynamic** and whistle around 1.5 kHz. The diaphragm
  trace falls a quarter cycle behind the pressure — that is resonance.
- Switch to **Ribbon** and say a hard "p". Watch the peak swing jump into the
  tens of microns. Now you know why ribbon mics live behind pop shields.
- Compare **magnified** across the three types. The ribbon needs almost no
  exaggeration to be visible; the condenser needs about ten thousand times.
