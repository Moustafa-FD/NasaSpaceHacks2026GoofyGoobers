"""
Footprint Atlas - sound design for the 30 s intro film (synthesized, frame-synced).

    python scripts/film_audio.py [--music path/to/track.mp3] [--out DIR]

Writes footprint_atlas_sfx.wav (effects only) and footprint_atlas_mix.wav (effects + music,
music ducked under the hits) next to the rendered frames. cloudshadow_cine.stitch() muxes
the mix (or the effects alone) into footprint_atlas.mp4.

Timings come from the film (30 fps): space 0-5.5 s, meadow 5.5-10 s, the hall falls at frame 324
and lands at 348, real campus 13 s, POWER 16 s, WATER 19 s, AIR 22 s, title 26 s. The lightning
crackles replay the same random sequence as cloudshadow_cine._key_bolts (seed 33), so every
crackle lands on a strike.
"""
import argparse
import os
import random

import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 48000
FPS = 30
DUR = 30.0
N = int(SR * DUR)
rng = np.random.default_rng(2026)


# ------------------------------------------------------------------ building blocks
def t_(sec):
    return np.arange(int(sec * SR)) / SR


def noise(sec):
    return rng.standard_normal(int(sec * SR))


def band(x, lo=None, hi=None, order=4):
    if lo and hi:
        sos = signal.butter(order, [lo, hi], "bandpass", fs=SR, output="sos")
    elif lo:
        sos = signal.butter(order, lo, "highpass", fs=SR, output="sos")
    else:
        sos = signal.butter(order, hi, "lowpass", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def fade(x, a=0.05, b=0.05):
    n = len(x)
    env = np.ones(n)
    na, nb = int(a * SR), int(b * SR)
    if na:
        env[:na] = np.linspace(0, 1, na) ** 2
    if nb:
        env[-nb:] *= np.linspace(1, 0, nb) ** 2
    return x * env


def norm(x, peak=1.0):
    m = np.max(np.abs(x)) or 1.0
    return x / m * peak


def reverb(x, seconds=2.4, wet=0.35, damp=3000):
    ir = band(noise(seconds), hi=damp) * np.exp(-t_(seconds) * (6.9 / seconds))
    ir /= np.sqrt(np.sum(ir ** 2))
    y = signal.fftconvolve(x, ir)[: len(x)]
    return x * (1 - wet) + norm(y, np.max(np.abs(x))) * wet


class Track:
    def __init__(self):
        self.L = np.zeros(N)
        self.R = np.zeros(N)

    def add(self, x, at, gain=1.0, pan=0.0):
        i = int(at * SR)
        x = x[: max(0, N - i)]
        gl, gr = gain * np.sqrt((1 - pan) / 2) * np.sqrt(2), gain * np.sqrt((1 + pan) / 2) * np.sqrt(2)
        self.L[i:i + len(x)] += x * gl
        self.R[i:i + len(x)] += x * gr


# ------------------------------------------------------------------ the effects
def space_pad(sec=6.5):
    t = t_(sec)
    chord = [55.0, 82.41, 110.0, 138.59, 164.81, 220.0]
    x = sum(np.sin(2 * np.pi * f * t * (1 + 0.002 * np.sin(2 * np.pi * 0.13 * t + k)))
            / (1 + k * 0.6) for k, f in enumerate(chord))
    x = band(x + 0.05 * band(noise(sec), lo=200, hi=900), hi=1400)
    return fade(norm(x, 0.5), 2.0, 1.5)


def whoosh(sec, f0, f1, peak_at=0.85):
    t = t_(sec)
    x = noise(sec)
    out = np.zeros_like(x)
    steps = 24
    for s in range(steps):                                       # sweeping band-pass
        a, b = int(s * len(x) / steps), int((s + 1) * len(x) / steps)
        fc = f0 * (f1 / f0) ** (s / steps)
        out[a:b] = band(x, lo=fc * 0.6, hi=min(fc * 1.6, SR / 2 - 100), order=2)[a:b]
    env = np.clip(t / (sec * peak_at), 0, 1) ** 2.2 * np.clip((sec - t) / (sec * (1 - peak_at) + 1e-3), 0, 1) ** 0.5
    return norm(out * env, 0.8)


def meadow(sec=5.6):
    t = t_(sec)
    wind = band(noise(sec), lo=80, hi=700) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.21 * t) ** 2)
    birds = np.zeros_like(t)
    r = random.Random(7)
    for _ in range(14):                                          # chirps: fast FM sweeps
        at, ln = r.uniform(0.3, sec - 0.4), r.uniform(0.05, 0.12)
        tt = t_(ln)
        f = r.uniform(3000, 4800) + r.uniform(-1500, 1500) * tt / ln
        ch = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * tt / ln) ** 2
        for rep in range(r.randint(1, 3)):
            i = int((at + rep * (ln + 0.04)) * SR)
            birds[i:i + len(ch)] += ch[: len(birds) - i]
    return fade(norm(wind, 0.35) + norm(birds, 0.18), 0.4, 0.6)


def falling(sec=0.8):
    t = t_(sec)
    f = 1900 * (320 / 1900) ** (t / sec)
    tone = np.sin(2 * np.pi * np.cumsum(f) / SR) * (t / sec) ** 1.5
    return norm(tone * 0.6 + whoosh(sec, 400, 3000, 0.98) * 0.7, 0.9)


def impact(sec=3.2):
    t = t_(sec)
    sub = np.sin(2 * np.pi * np.cumsum(46 * (28 / 46) ** (t / 1.2)) / SR) * np.exp(-t / 0.9)
    body = band(noise(sec), hi=380) * np.exp(-t / 0.45)
    crack = band(noise(sec), lo=1800) * np.exp(-t / 0.03)
    rumble = band(noise(sec), hi=160) * np.exp(-t / 1.6) * 0.8
    debris = band(noise(sec), lo=900, hi=4000) * np.exp(-t / 0.9) * (rng.random(len(t)) < 0.02) * 6
    x = norm(sub, 1.0) + norm(body, 0.9) + norm(crack, 0.7) + norm(rumble, 0.7) + norm(debris, 0.25)
    return reverb(norm(x, 1.0), 2.8, 0.3, 1800)


def hum(sec):
    t = t_(sec)
    x = sum(np.sin(2 * np.pi * f * t) / k for k, f in enumerate((60, 120, 180, 240), 1))
    fans = band(noise(sec), lo=200, hi=2600) * 0.5
    return fade(norm(x, 0.35) + norm(fans, 0.18), 0.8, 0.6)


def crackle(sec=0.12, big=False):
    t = t_(sec)
    x = band(noise(sec), lo=1500) * (rng.random(len(t)) < 0.18) * np.exp(-t / (sec * 0.5))
    x = norm(x, 0.9)
    if big:                                                      # a short thunder-ish thump under strong strikes
        x = np.concatenate([x, np.zeros(int(0.5 * SR))])
        tt = np.arange(len(x)) / SR
        x += norm(band(rng.standard_normal(len(x)), hi=200) * np.exp(-tt / 0.25), 0.6)
    return x


def buzz(sec):
    t = t_(sec)
    saw = signal.sawtooth(2 * np.pi * 120 * t) * 0.5 + signal.sawtooth(2 * np.pi * 240.7 * t) * 0.25
    return fade(norm(band(saw, hi=2500), 0.3), 0.3, 0.3)


def steam(sec):
    t = t_(sec)
    hiss = band(noise(sec), lo=2200, hi=9000) * (0.7 + 0.3 * np.sin(2 * np.pi * 0.4 * t))
    flow = band(noise(sec), lo=250, hi=900) * (0.5 + 0.5 * np.abs(np.sin(2 * np.pi * 3.1 * t + np.sin(2 * np.pi * 0.7 * t))))
    return fade(norm(hiss, 0.45) + norm(flow, 0.3), 0.6, 0.6)


def turbine(sec):
    t = t_(sec)
    whine = sum(np.sin(2 * np.pi * f * t * (1 + 0.003 * np.sin(2 * np.pi * 0.5 * t))) / k
                for k, f in enumerate((870, 1740, 2610), 1))
    roar = band(noise(sec), lo=60, hi=1400)
    return fade(norm(whine, 0.18) + norm(roar, 0.5), 1.2, 0.8)


def riser(sec=1.2):
    t = t_(sec)
    return norm(band(noise(sec), lo=1200, hi=9000) * (t / sec) ** 3, 0.5)


def title_hit(sec=4.2):
    t = t_(sec)
    boom = np.sin(2 * np.pi * np.cumsum(55 * (32 / 55) ** (t / 1.5)) / SR) * np.exp(-t / 1.4)
    pad = space_pad(sec) * np.clip(t / 0.4, 0, 1)
    return reverb(norm(boom, 1.0) * 0.9 + pad * 0.8, 3.5, 0.4, 2400)


def bolt_frames(seed=33, lines=3, variants=6, f0=480, f1=570, step=2):
    """Replays cloudshadow_cine._key_bolts: the frames where a bolt is lit (any line)."""
    r = random.Random(seed)
    lit = set()
    for _ in range(lines):
        for f in range(f0, f1, step):
            if r.random() < 0.82:
                r.randrange(variants)
                lit.add(f)
    return sorted(lit)


# ------------------------------------------------------------------ synthesized score (used when no --music file)
def _note(f, sec, bright=0.3):
    t = t_(sec)
    x = sum(np.sin(2 * np.pi * f * h * t * (1 + 0.0015 * np.sin(2 * np.pi * 0.2 * t + h))) / h ** (1.6 - bright)
            for h in (1, 2, 3, 4))
    return x


def score():
    """30 s cinematic bed: A-minor pad (Am F C G), pulse that builds into the drop at 11.6 s,
    a lighter arpeggio over the impact acts, a swell into the title. Mostly < 2 kHz so SFX stay clear."""
    out = np.zeros(N)
    prog = [(220.0, 261.63, 329.63), (174.61, 220.0, 261.63), (130.81, 196.0, 261.63), (196.0, 246.94, 293.66)]
    bar = 2.4
    for i in range(int(DUR / bar) + 1):                      # pad
        ch = prog[i % 4]
        seg = sum(_note(f, bar + 0.6, 0.1) for f in ch) + 0.6 * _note(ch[0] / 2, bar + 0.6, 0.0)
        seg = fade(band(seg, hi=1800), 0.5, 0.6)
        a = int(i * bar * SR)
        out[a:a + len(seg)] += seg[: max(0, N - a)] * 0.16
    pulse_t = np.arange(N) / SR                                # low pulse, 8ths, rising 5.5 -> 11.6 s, again 13 -> 26 s
    env = np.clip((pulse_t - 5.5) / 6.0, 0, 1) * (pulse_t < 11.6) + np.clip((pulse_t - 13.0) / 3.0, 0, 1) * 0.8 * (pulse_t < 26.0)
    gate = (np.sin(2 * np.pi * 4.0 * pulse_t) > 0.2) * np.exp(-((pulse_t * 4.0) % 1.0) * 4)
    out += np.sin(2 * np.pi * 55 * pulse_t) * gate * env * 0.35
    arp = [440.0, 523.25, 659.25, 880.0, 659.25, 523.25]       # arpeggio over POWER/WATER/AIR
    for k, at in enumerate(np.arange(13.0, 26.0, 0.25)):
        f = arp[k % len(arp)] * (0.8909 if (int(at / bar) % 4) == 1 else 1.0)
        n = _note(f, 0.3, 0.5) * np.exp(-t_(0.3) / 0.09)
        a = int(at * SR)
        out[a:a + len(n)] += n * 0.05
    sw = pulse_t - 24.5                                        # swell into the title, then the final chord rings
    out += band(rng.standard_normal(N), lo=300, hi=3000) * np.clip(sw / 1.5, 0, 1) * (sw < 1.5) * 0.08
    fin = sum(_note(f, 4.0, 0.2) for f in (110.0, 220.0, 261.63, 329.63, 440.0)) * np.exp(-t_(4.0) / 2.2)
    out[int(26 * SR):int(26 * SR) + len(fin)] += fin[: N - int(26 * SR)] * 0.14
    out[int(11.4 * SR):int(11.6 * SR)] *= np.linspace(1, 0, int(0.2 * SR))   # silence beat before the impact
    out[int(11.6 * SR):int(12.0 * SR)] *= 0.0
    return reverb(fade(out, 1.5, 2.0), 3.0, 0.35, 2600)


# ------------------------------------------------------------------ the mix
def build_sfx():
    fx = Track()
    s = lambda frame: frame / FPS
    fx.add(space_pad(), 0.0, 0.7)
    fx.add(whoosh(2.4, 250, 2600), 3.3, 0.8)                      # the dive
    fx.add(meadow(), s(165), 0.9)
    fx.add(falling(), s(324), 0.85, pan=0.2)
    fx.add(impact(), s(348), 1.0)
    fx.add(hum(3.3), s(390), 0.55)
    fx.add(buzz(3.0), s(480), 0.4)
    r = random.Random(5)
    for f in bolt_frames():
        fx.add(crackle(r.uniform(0.07, 0.14), big=r.random() < 0.18), s(f), r.uniform(1.1, 1.6), pan=r.uniform(-0.6, 0.6))
    fx.add(hum(3.0), s(570), 0.3)
    fx.add(steam(3.0), s(570), 0.7)
    fx.add(turbine(4.0), s(660), 0.65)
    fx.add(riser(1.0), s(780) - 1.0, 0.6)
    fx.add(title_hit(), s(780), 0.95)
    return fx


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--out", default=os.path.join(here, "..", "clients", "unreal", "CloudShadow", "Saved", "Cine"))
    ap.add_argument("--music", default=None, help="optional music file (any format ffmpeg reads)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    fx = build_sfx()
    st = np.stack([fx.L, fx.R], 1)
    st = st / (np.max(np.abs(st)) or 1) * 0.89
    sfx_path = os.path.join(a.out, "footprint_atlas_sfx.wav")
    wavfile.write(sfx_path, SR, (st * 32767).astype(np.int16))
    print("effects ->", sfx_path)
    m = score()                                                # synthesized score under the effects
    duck = np.convolve(np.abs(fx.L + fx.R), np.ones(4800) / 4800, "same")
    m = m / (np.max(np.abs(m)) or 1) * 0.5 / (1 + 3.0 * duck / (np.max(duck) or 1))
    mix = np.stack([fx.L + m, fx.R + m], 1)
    mix = mix / (np.max(np.abs(mix)) or 1) * 0.89
    wavfile.write(os.path.join(a.out, "footprint_atlas_mix.wav"), SR, (mix * 32767).astype(np.int16))
    raw = os.path.join(a.out, "footprint_atlas_mix.wav")
    tmp = os.path.join(a.out, "_mix_raw.wav")
    os.replace(raw, tmp)                                       # loudness: -14 LUFS, -1 dBTP (web/video standard)
    os.system('ffmpeg -y -loglevel error -i "%s" -af loudnorm=I=-14:TP=-1.0:LRA=11 -ar 48000 "%s"' % (tmp, raw))
    os.remove(tmp)
    print("mix (synth score) ->", raw)
    if a.music:
        mix = os.path.join(a.out, "footprint_atlas_mix.wav")
        # music bed: 30 s, fades, ducked by the effects (sidechain), then the two summed and loudness-normalized
        cmd = ('ffmpeg -y -loglevel error -i "%s" -i "%s" -filter_complex '
               '"[1:a]atrim=0:30,asetpts=N/SR/TB,afade=t=in:d=1.5,afade=t=out:st=27.5:d=2.5,volume=0.55[m];'
               '[0:a]asplit=2[fx][key];[m][key]sidechaincompress=threshold=0.08:ratio=6:attack=20:release=400[duck];'
               '[duck][fx]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.0" -ar 48000 "%s"' % (sfx_path, a.music, mix))
        if os.system(cmd) == 0:
            print("mix ->", mix)


if __name__ == "__main__":
    main()
