import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureDir, pathExists, readJson } from "./util.js";
import type { AssetTodoT } from "./schema.js";

/**
 * Zero-dependency procedural broadcast audio synthesizer.
 *
 * 48 kHz / 16-bit / stereo WAV generation with clean DSP: seeded noise, pink
 * noise (Paul Kellet), one-pole filters, exponential frequency sweeps, FM/sub
 * punches, stereo widening, soft-clip limiting — deterministic for a given
 * preset + seed, no native modules, no network, no AI APIs.
 */

const SAMPLE_RATE = 48_000;
const TWO_PI = Math.PI * 2;

export type SynthMood = "dark" | "upbeat" | "tech" | "minimal";

export interface SynthRequest {
  preset: string;
  out: string;
  durationSec?: number;
  bpm?: number;
  mood?: SynthMood;
  seed?: number;
}

interface SynthResult {
  preset: string;
  out: string;
  durationSec: number;
  bytes: number;
  peakDb: number;
  rmsDb: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Stereo {
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly length: number;

  constructor(public readonly sampleRate: number, durationSec: number) {
    this.length = Math.max(1, Math.round(sampleRate * durationSec));
    this.left = new Float32Array(this.length);
    this.right = new Float32Array(this.length);
  }

  add(index: number, value: number, pan = 0): void {
    if (index < 0 || index >= this.length) return;
    const p = Math.max(-1, Math.min(1, pan));
    const l = Math.cos(((p + 1) * Math.PI) / 4);
    const r = Math.sin(((p + 1) * Math.PI) / 4);
    this.left[index] = (this.left[index] as number) + value * l;
    this.right[index] = (this.right[index] as number) + value * r;
  }

  addMono(index: number, value: number): void {
    if (index < 0 || index >= this.length) return;
    this.left[index] = (this.left[index] as number) + value;
    this.right[index] = (this.right[index] as number) + value;
  }
}

function env(t: number, attack: number, decay: number): number {
  if (t < 0) return 0;
  if (t < attack) return t / Math.max(1e-6, attack);
  const p = (t - attack) / Math.max(1e-6, decay);
  return p >= 1 ? 0 : Math.exp(-4 * p) * (1 - p);
}

function softClip(x: number, drive = 1.15): number {
  return Math.tanh(x * drive);
}

interface PinkState {
  b0: number;
  b1: number;
  b2: number;
  b3: number;
  b4: number;
  b5: number;
  b6: number;
}

function makePink(): { next: (white: number) => number; state: PinkState } {
  const state: PinkState = { b0: 0, b1: 0, b2: 0, b3: 0, b4: 0, b5: 0, b6: 0 };
  return {
    state,
    next(white: number): number {
      state.b0 = 0.99886 * state.b0 + white * 0.0555179;
      state.b1 = 0.99332 * state.b1 + white * 0.0750759;
      state.b2 = 0.969 * state.b2 + white * 0.153852;
      state.b3 = 0.8665 * state.b3 + white * 0.3104856;
      state.b4 = 0.55 * state.b4 + white * 0.5329522;
      state.b5 = -0.7616 * state.b5 - white * 0.016898;
      const pink = state.b0 + state.b1 + state.b2 + state.b3 + state.b4 + state.b5 + state.b6 + white * 0.5362;
      state.b6 = white * 0.115926;
      return pink * 0.11;
    },
  };
}

function onePoleLP(alpha: number): (x: number) => number {
  let y = 0;
  return (x: number) => {
    y += alpha * (x - y);
    return y;
  };
}

function onePoleHP(alpha: number): (x: number) => number {
  const lp = onePoleLP(alpha);
  return (x: number) => x - lp(x);
}

function midSideWidth(buf: Stereo, width: number): void {
  for (let i = 0; i < buf.length; i += 1) {
    const l = buf.left[i] as number;
    const r = buf.right[i] as number;
    const mid = (l + r) * 0.5;
    const side = (l - r) * 0.5 * width;
    buf.left[i] = mid + side;
    buf.right[i] = mid - side;
  }
}

function fadeEdges(buf: Stereo, fadeSec = 0.01): void {
  const n = Math.max(1, Math.round(fadeSec * buf.sampleRate));
  for (let i = 0; i < n; i += 1) {
    const g = i / n;
    buf.left[i] = (buf.left[i] as number) * g;
    buf.right[i] = (buf.right[i] as number) * g;
    const j = buf.length - 1 - i;
    buf.left[j] = (buf.left[j] as number) * g;
    buf.right[j] = (buf.right[j] as number) * g;
  }
}

function finalize(buf: Stereo, width = 1.1): { peakDb: number; rmsDb: number } {
  midSideWidth(buf, width);
  let peak = 1e-9;
  let sum = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const l = softClip(buf.left[i] as number);
    const r = softClip(buf.right[i] as number);
    buf.left[i] = l;
    buf.right[i] = r;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    sum += l * l + r * r;
  }
  const target = 0.82;
  const gain = target / peak;
  for (let i = 0; i < buf.length; i += 1) {
    buf.left[i] = (buf.left[i] as number) * gain;
    buf.right[i] = (buf.right[i] as number) * gain;
    sum += 0;
  }
  const rms = Math.sqrt(sum / (buf.length * 2)) * gain;
  return { peakDb: 20 * Math.log10(Math.max(1e-9, peak * gain)), rmsDb: 20 * Math.log10(Math.max(1e-9, rms)) };
}

async function writeWav(file: string, buf: Stereo): Promise<number> {
  const bytesPerSample = 2;
  const dataSize = buf.length * 2 * bytesPerSample;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(2, 22); // stereo
  header.writeUInt32LE(buf.sampleRate, 24);
  header.writeUInt32LE(buf.sampleRate * 2 * bytesPerSample, 28);
  header.writeUInt16LE(2 * bytesPerSample, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  const data = Buffer.alloc(dataSize);
  const rng = mulberry32(0x5eed);
  let offset = 0;
  for (let i = 0; i < buf.length; i += 1) {
    for (const value of [buf.left[i] as number, buf.right[i] as number]) {
      const dither = (rng() - rng()) / 32768;
      const clamped = Math.max(-1, Math.min(1, value + dither * 0.4));
      data.writeInt16LE(Math.round(clamped * 32767), offset);
      offset += 2;
    }
  }
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, Buffer.concat([header, data]));
  return 44 + dataSize;
}

/* ============================================================================
 * Presets
 * ========================================================================== */

export const SYNTH_PRESETS = {
  sfx: ["whoosh", "whoosh-fast", "sub-hit", "riser", "pop", "ui-click", "glitch-zap", "shutter", "swoosh-reverse", "chime"],
  music: ["beat-pulse", "ambient-tech", "minimal-tension"],
} as const;

const SFX_DURATION: Record<string, number> = {
  whoosh: 0.7,
  "whoosh-fast": 0.4,
  "sub-hit": 0.55,
  riser: 1.1,
  pop: 0.16,
  "ui-click": 0.08,
  "glitch-zap": 0.3,
  shutter: 0.2,
  "swoosh-reverse": 0.7,
  chime: 1.0,
};

const MUSIC_DURATION: Record<string, number> = {
  "beat-pulse": 4,
  "ambient-tech": 8,
  "minimal-tension": 8,
};

export function isSynthPreset(preset: string): boolean {
  return (SYNTH_PRESETS.sfx as readonly string[]).includes(preset) || (SYNTH_PRESETS.music as readonly string[]).includes(preset);
}

export function defaultSynthDuration(preset: string): number {
  return SFX_DURATION[preset] ?? MUSIC_DURATION[preset] ?? 1;
}

function sweep(buf: Stereo, opts: { fromHz: number; toHz: number; durationSec: number; gain: number; wave?: "sine" | "saw"; attack?: number; decay?: number }): void {
  const n = Math.round(opts.durationSec * buf.sampleRate);
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / buf.sampleRate;
    const p = i / Math.max(1, n - 1);
    const hz = opts.fromHz * Math.pow(opts.toHz / opts.fromHz, p);
    phase += (TWO_PI * hz) / buf.sampleRate;
    const wave = opts.wave === "saw" ? 2 * ((phase / TWO_PI) % 1) - 1 : Math.sin(phase);
    buf.addMono(i, wave * opts.gain * env(t, opts.attack ?? 0.005, opts.decay ?? opts.durationSec));
  }
}

function noiseBand(buf: Stereo, opts: { durationSec: number; gain: number; fromHz: number; toHz: number; q?: number; attack?: number; decay?: number; seed?: number }): void {
  const rng = mulberry32(opts.seed ?? 1);
  const hp = onePoleHP(0.12);
  const lpRatio = (hz: number) => Math.min(0.99, Math.max(0.005, (TWO_PI * hz) / buf.sampleRate));
  let lp = onePoleLP(lpRatio(opts.fromHz));
  const n = Math.round(opts.durationSec * buf.sampleRate);
  for (let i = 0; i < n; i += 1) {
    const t = i / buf.sampleRate;
    const p = i / Math.max(1, n - 1);
    const hz = opts.fromHz * Math.pow(opts.toHz / opts.fromHz, p);
    lp = onePoleLP(lpRatio(hz));
    const white = rng() * 2 - 1;
    const shaped = lp(hp(white)) * (opts.q ?? 1.4);
    buf.addMono(i, shaped * opts.gain * env(t, opts.attack ?? 0.01, opts.decay ?? opts.durationSec));
  }
}

function noiseBurst(buf: Stereo, startSec: number, opts: { durationSec: number; gain: number; highpassHz?: number; seed?: number }): void {
  const rng = mulberry32(opts.seed ?? 7);
  const alpha = Math.min(0.9, Math.max(0.01, (TWO_PI * (opts.highpassHz ?? 2000)) / buf.sampleRate));
  const hp = onePoleHP(alpha);
  const start = Math.round(startSec * buf.sampleRate);
  const n = Math.round(opts.durationSec * buf.sampleRate);
  for (let i = 0; i < n; i += 1) {
    const t = i / buf.sampleRate;
    buf.addMono(start + i, hp(rng() * 2 - 1) * opts.gain * env(t, 0.001, opts.durationSec));
  }
}

function kick(buf: Stereo, startSec: number, gain: number): void {
  const start = Math.round(startSec * buf.sampleRate);
  const dur = 0.28;
  const n = Math.round(dur * buf.sampleRate);
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / buf.sampleRate;
    const p = i / n;
    const hz = 118 * Math.pow(42 / 118, Math.min(1, p * 3)) + 6;
    phase += (TWO_PI * hz) / buf.sampleRate;
    const body = Math.sin(phase) * Math.exp(-6.5 * p);
    const click = i < 60 ? (1 - i / 60) * 0.5 : 0;
    buf.addMono(start + i, (body + click) * gain);
  }
}

function hat(buf: Stereo, startSec: number, gain: number, seed: number): void {
  noiseBurst(buf, startSec, { durationSec: 0.045, gain, highpassHz: 7000, seed });
}

function note(buf: Stereo, startSec: number, durationSec: number, hz: number, gain: number, type: "sine" | "saw" = "sine"): void {
  const start = Math.round(startSec * buf.sampleRate);
  const n = Math.round(durationSec * buf.sampleRate);
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / buf.sampleRate;
    phase += (TWO_PI * hz) / buf.sampleRate;
    const wave = type === "saw" ? 2 * ((phase / TWO_PI) % 1) - 1 : Math.sin(phase);
    buf.addMono(start + i, wave * gain * env(t, 0.008, durationSec));
  }
}

function moodRoot(mood: SynthMood): number {
  return mood === "dark" ? 55 : mood === "upbeat" ? 65.41 : mood === "tech" ? 49 : 43.65;
}

function moodScale(mood: SynthMood): number[] {
  const minor = [0, 3, 5, 7, 10];
  const major = [0, 2, 4, 7, 9];
  const rootRatio = (semis: number) => Math.pow(2, semis / 12);
  const scale = mood === "upbeat" ? major : minor;
  return scale.map(rootRatio);
}

function synthSfx(preset: string, duration: number, rngSeed: number): Stereo {
  const buf = new Stereo(SAMPLE_RATE, duration);
  switch (preset) {
    case "whoosh":
      noiseBand(buf, { durationSec: duration, gain: 0.85, fromHz: 300, toHz: 3200, attack: 0.12, decay: duration * 0.8, seed: rngSeed });
      noiseBand(buf, { durationSec: duration * 0.8, gain: 0.35, fromHz: 1600, toHz: 500, attack: 0.08, decay: duration * 0.6, seed: rngSeed + 1 });
      break;
    case "whoosh-fast":
      noiseBand(buf, { durationSec: duration, gain: 0.9, fromHz: 500, toHz: 5200, attack: 0.05, decay: duration * 0.7, seed: rngSeed });
      break;
    case "sub-hit":
      sweep(buf, { fromHz: 120, toHz: 38, durationSec: duration, gain: 0.95, attack: 0.002, decay: duration * 0.9 });
      noiseBurst(buf, 0, { durationSec: 0.02, gain: 0.25, highpassHz: 2500, seed: rngSeed });
      break;
    case "riser":
      sweep(buf, { fromHz: 180, toHz: 2800, durationSec: duration, gain: 0.35, wave: "saw", attack: duration * 0.05, decay: duration * 1.1 });
      noiseBand(buf, { durationSec: duration, gain: 0.55, fromHz: 500, toHz: 6000, attack: duration * 0.1, decay: duration, seed: rngSeed });
      break;
    case "pop":
      sweep(buf, { fromHz: 760, toHz: 240, durationSec: duration, gain: 0.85, attack: 0.002, decay: duration });
      noiseBurst(buf, 0, { durationSec: 0.012, gain: 0.2, highpassHz: 3000, seed: rngSeed });
      break;
    case "ui-click":
      noiseBurst(buf, 0, { durationSec: duration, gain: 0.5, highpassHz: 4200, seed: rngSeed });
      sweep(buf, { fromHz: 1600, toHz: 900, durationSec: duration, gain: 0.4, attack: 0.001, decay: duration });
      break;
    case "glitch-zap": {
      const rng = mulberry32(rngSeed);
      const steps = 18;
      for (let s = 0; s < steps; s += 1) {
        const start = (s / steps) * duration;
        const len = duration / steps;
        const hz = 700 + Math.floor(rng() * 2400);
        const gain = 0.3 + rng() * 0.5;
        const square = (x: number) => (Math.sin(x) >= 0 ? 1 : -1);
        const n = Math.round(len * SAMPLE_RATE);
        let phase = 0;
        for (let i = 0; i < n; i += 1) {
          phase += (TWO_PI * hz) / SAMPLE_RATE;
          buf.addMono(Math.round(start * SAMPLE_RATE) + i, square(phase) * gain * 0.4 * env(i / SAMPLE_RATE, 0.001, len));
        }
      }
      noiseBurst(buf, 0, { durationSec: duration, gain: 0.25, highpassHz: 1200, seed: rngSeed + 3 });
      break;
    }
    case "shutter":
      noiseBurst(buf, 0, { durationSec: 0.03, gain: 0.5, highpassHz: 1800, seed: rngSeed });
      noiseBurst(buf, duration * 0.45, { durationSec: 0.04, gain: 0.6, highpassHz: 2400, seed: rngSeed + 1 });
      break;
    case "swoosh-reverse": {
      const tmp = new Stereo(SAMPLE_RATE, duration);
      noiseBand(tmp, { durationSec: duration, gain: 0.8, fromHz: 380, toHz: 3600, attack: duration * 0.75, decay: duration * 0.3, seed: rngSeed });
      for (let i = 0; i < duration * SAMPLE_RATE - 1; i += 1) {
        const src = Math.round(duration * SAMPLE_RATE) - 1 - i;
        if (src >= 0) {
          buf.left[i] = tmp.left[src] as number;
          buf.right[i] = tmp.right[src] as number;
        }
      }
      break;
    }
    case "chime": {
      const partials = [880, 1320, 1760, 2217.5];
      partials.forEach((hz, index) => {
        const n = Math.round(duration * SAMPLE_RATE);
        for (let i = 0; i < n; i += 1) {
          const t = i / SAMPLE_RATE;
          const decay = Math.exp(-(3 + index) * t);
          buf.addMono(i, Math.sin(TWO_PI * hz * t) * decay * (0.32 / (index + 1)));
        }
      });
      break;
    }
    default:
      noiseBand(buf, { durationSec: duration, gain: 0.5, fromHz: 400, toHz: 2000, seed: rngSeed });
  }
  return buf;
}

function synthMusic(preset: string, duration: number, bpm: number, mood: SynthMood, rngSeed: number): Stereo {
  const buf = new Stereo(SAMPLE_RATE, duration);
  const beat = 60 / bpm;
  const root = moodRoot(mood);
  const scale = moodScale(mood);
  const rng = mulberry32(rngSeed);

  if (preset === "beat-pulse") {
    const beats = Math.floor(duration / beat);
    for (let i = 0; i < beats; i += 1) {
      const t = i * beat;
      kick(buf, t, i % 4 === 0 ? 0.9 : 0.7);
      hat(buf, t + beat * 0.5, 0.22, rngSeed + i);
      if (i % 2 === 1) hat(buf, t + beat * 0.75, 0.12, rngSeed + 100 + i);
      const degree = scale[i % scale.length] as number;
      note(buf, t + beat * 0.25, beat * 0.42, root * degree, 0.28, "saw");
      if (i % 4 === 0) {
        note(buf, t, beat * 3.6, root * 0.5, 0.18);
        note(buf, t, beat * 3.6, root * 0.75, 0.12);
      }
    }
    note(buf, 0, duration, root * 2, 0.08, "saw");
  } else if (preset === "ambient-tech") {
    const chord = [1, 1.5, 2, 2.996, 4.02];
    chord.forEach((ratio, index) => {
      const n = buf.length;
      let phase = 0;
      for (let i = 0; i < n; i += 1) {
        const t = i / SAMPLE_RATE;
        const lfo = 0.55 + 0.45 * Math.sin(TWO_PI * (0.06 + index * 0.013) * t + index);
        phase += (TWO_PI * root * ratio) / SAMPLE_RATE;
        const wave = Math.sin(phase) * 0.6 + Math.sin(phase * 2.002) * 0.15;
        buf.addMono(i, wave * lfo * (0.16 / (index * 0.6 + 1)));
      }
    });
    const pulseRate = beat * 2;
    for (let t = 0; t + pulseRate < duration; t += pulseRate) {
      kick(buf, t, 0.35);
    }
    const rng2 = mulberry32(rngSeed + 9);
    const hp = onePoleHP(0.08);
    for (let i = 0; i < buf.length; i += 1) {
      const t = i / SAMPLE_RATE;
      buf.addMono(i, hp(rng2() * 2 - 1) * 0.05 * (0.5 + 0.5 * Math.sin(TWO_PI * 0.09 * t)));
    }
  } else if (preset === "minimal-tension") {
    const pulseRate = beat * 2;
    for (let t = 0; t + pulseRate < duration; t += pulseRate) {
      note(buf, t, 0.5, root * 0.5, 0.35);
      note(buf, t, 0.5, root * 0.5 * 1.006, 0.18);
    }
    const rng2 = mulberry32(rngSeed + 13);
    const hp = onePoleHP(0.12);
    const lp = onePoleLP(0.05);
    let shimmerPhase = 0;
    for (let i = 0; i < buf.length; i += 1) {
      const t = i / SAMPLE_RATE;
      const air = lp(hp(rng2() * 2 - 1)) * 0.12;
      shimmerPhase += (TWO_PI * root * 3.01) / SAMPLE_RATE;
      const drone = Math.sin(shimmerPhase) * 0.03 * (0.6 + 0.4 * Math.sin(TWO_PI * 0.05 * t));
      buf.addMono(i, air + drone);
    }
  } else {
    // unknown music preset: gentle beat-pulse
    return synthMusic("beat-pulse", duration, bpm, mood, rngSeed);
  }
  void rng;
  return buf;
}

export async function synthesizeToWav(request: SynthRequest): Promise<SynthResult> {
  if (!isSynthPreset(request.preset)) {
    throw new Error(`unknown synth preset "${request.preset}" (sfx: ${SYNTH_PRESETS.sfx.join(", ")}; music: ${SYNTH_PRESETS.music.join(", ")})`);
  }
  const duration = Math.max(0.05, request.durationSec ?? defaultSynthDuration(request.preset));
  const bpm = request.bpm ?? 120;
  const mood = request.mood ?? "tech";
  const seed = request.seed ?? 1337;
  const isMusic = (SYNTH_PRESETS.music as readonly string[]).includes(request.preset);
  const buf = isMusic ? synthMusic(request.preset, duration, bpm, mood, seed) : synthSfx(request.preset, duration, seed);
  fadeEdges(buf, isMusic ? 0.02 : Math.min(0.01, duration / 10));
  const levels = finalize(buf, isMusic ? 1.12 : 1.05);
  const bytes = await writeWav(request.out, buf);
  return { preset: request.preset, out: request.out, durationSec: duration, bytes, ...levels };
}

/* ============================================================================
 * Batch mode — generate every pending sfx/music asset
 * ========================================================================== */

export function inferSynthPreset(id: string, type: string, description: string): { preset: string; bpm?: number; mood?: SynthMood } {
  const text = `${id} ${description}`.toLowerCase();
  if (type === "music") {
    if (/ambient|pad|atmos|drone/.test(text)) return { preset: "ambient-tech", bpm: 110, mood: "minimal" };
    if (/tension|dark|cinema|suspense/.test(text)) return { preset: "minimal-tension", bpm: 100, mood: "dark" };
    return { preset: "beat-pulse", bpm: 120, mood: "tech" };
  }
  const sfx: [RegExp, string][] = [
    [/whoosh-fast|fast whoosh|swipe/, "whoosh-fast"],
    [/reverse|rewind/, "swoosh-reverse"],
    [/whoosh|swoosh|wind/, "whoosh"],
    [/sub[- ]?hit|impact|thud|boom/, "sub-hit"],
    [/riser|rise|build/, "riser"],
    [/click|tap|tick/, "ui-click"],
    [/glitch|zap|digital|error/, "glitch-zap"],
    [/shutter|camera snap|photo/, "shutter"],
    [/chime|bell|notify|ding/, "chime"],
    [/pop|blip|pluck/, "pop"],
  ];
  for (const [pattern, preset] of sfx) if (pattern.test(text)) return { preset };
  return { preset: "whoosh" };
}

export interface SynthBatchResult {
  generated: SynthResult[];
  skipped: { id: string; reason: string }[];
}

export async function synthFromAssets(todoPathInput?: string): Promise<SynthBatchResult> {
  const todoPath = path.resolve(todoPathInput ?? path.join(process.cwd(), "workspace", "assets-todo.json"));
  if (!(await pathExists(todoPath))) {
    throw new Error(`assets-todo.json not found: ${todoPath} (run \`ultra asset-plan\` first)`);
  }
  const todo = await readJson<AssetTodoT>(todoPath);
  const workspaceRoot = path.dirname(todoPath);
  const generated: SynthResult[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const entry of todo.missing) {
    if (entry.type !== "sfx" && entry.type !== "music") {
      skipped.push({ id: entry.id, reason: `type ${entry.type} is not synth-audio` });
      continue;
    }
    const inferred = entry.synthPreset?.preset ? { preset: entry.synthPreset.preset, bpm: entry.synthPreset.bpm, mood: entry.synthPreset.mood } : inferSynthPreset(entry.id, entry.type, entry.description);
    const target = path.isAbsolute(entry.targetPath) ? entry.targetPath : path.resolve(workspaceRoot, entry.targetPath);
    const requestedDuration = entry.synthPreset?.durationSec ?? entry.durationSec ?? defaultSynthDuration(inferred.preset);
    const duration = Math.max(defaultSynthDuration(inferred.preset) * 0.5, requestedDuration + 0.15);
    generated.push(
      await synthesizeToWav({
        preset: inferred.preset,
        out: target,
        durationSec: duration,
        bpm: inferred.bpm,
        mood: inferred.mood,
      }),
    );
  }
  return { generated, skipped };
}
