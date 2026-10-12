# Sound Wave

A live microphone visualiser that runs entirely in the browser. No build step, no
dependencies, no server beyond a static file host. Three views of the same signal:

| View | What it shows |
| --- | --- |
| **Waveform** | Air pressure over time — an oscilloscope, with trigger lock so the trace holds still |
| **Spectrum** | How much energy sits at each frequency, right now, on a log or linear axis |
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
index.html   markup and controls
styles.css   design tokens, light/dark themes, layout
app.js       the audio graph, the measurements, and the draw loop
```

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
