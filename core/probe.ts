import { promises as fs } from "node:fs";
import path from "node:path";
import { ffmpeg, ffmpegOk, ffprobeJson, parseRational, runBinary } from "./ffmpeg.js";
import { renderHtmlToPng } from "./browser.js";
import { AudioEnvelope, ProbeResult, type ProbeResultT } from "./schema.js";
import { ensureDir, formatTimestamp, pathExists, round, writeJsonAtomic } from "./util.js";
import { probeGeometry } from "./geometry.js";
import { contactSheetHtml } from "./contact-sheet.js";

interface AstatsSample {
  atSec: number;
  rmsDb: number;
}

interface Segment {
  index: number;
  startSec: number;
  endSec: number;
}

export interface ScenePaletteInfo {
  index: number;
  startSec: number;
  endSec: number;
  colors: { hex: string; share: number }[];
  avgLuminance: number;
  contrast: number;
  motionScore: number;
}

export interface ProbeOptions {
  /** Optional display cap for palette segments (default: all). Truncation is warned. */
  maxSegments?: number;
  /** [6] Also write workspace/geometry.json (lines/rects/text regions). */
  geometry?: boolean;
}

function extractPtsTimes(stderr: string): number[] {
  const times: number[] = [];
  const re = /pts_time:\s*([0-9]+(?:\.[0-9]+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stderr)) !== null) {
    const t = Number(match[1]);
    if (Number.isFinite(t)) times.push(t);
  }
  return times;
}

function dedupeTimes(times: number[], minGap = 0.12): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (last === undefined || t - last > minGap) out.push(round(t, 3));
  }
  return out;
}

function parseAstats(stderr: string): AstatsSample[] {
  const samples: AstatsSample[] = [];
  const re = /pts_time:\s*([0-9]+(?:\.[0-9]+)?)[\s\S]{0,300}?RMS_level=(-?[0-9]+(?:\.[0-9]+)?|-?inf)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stderr)) !== null) {
    const t = Number(match[1]);
    if (!Number.isFinite(t)) continue;
    const raw = match[2] ?? "-120";
    const rms = raw.includes("inf") ? -120 : Number(raw);
    if (Number.isFinite(rms)) samples.push({ atSec: t, rmsDb: rms });
  }
  return samples;
}

/** Deterministic audio onset detection: energy peaks rising clearly above the recent baseline. */
function detectOnsets(samples: AstatsSample[]): number[] {
  if (samples.length < 6) return [];
  const onsets: number[] = [];
  const window = 24;
  let lastOnset = -Infinity;
  for (let i = 3; i < samples.length - 2; i += 1) {
    const s = samples[i];
    if (!s || s.rmsDb < -34) continue;
    const prev = samples.slice(Math.max(0, i - window), i);
    if (prev.length < 6) continue;
    const baseline = prev.reduce((acc, v) => acc + v.rmsDb, 0) / prev.length;
    const neighbors = [samples[i - 1], samples[i + 1], samples[i - 2], samples[i + 2]]
      .filter((v): v is AstatsSample => Boolean(v))
      .map((v) => v.rmsDb);
    const isPeak = neighbors.every((n) => s.rmsDb >= n - 0.75);
    const isRise = s.rmsDb - baseline > 6;
    if (isPeak && isRise && s.atSec - lastOnset > 0.3) {
      onsets.push(round(s.atSec, 3));
      lastOnset = s.atSec;
    }
    if (onsets.length >= 64) break;
  }
  return onsets;
}

/** Extract a single frame at time t, scaled to the given width (height auto, even). */
export async function extractFrameAt(
  video: string,
  atSec: number,
  outPath: string,
  scaledWidth = 960,
): Promise<void> {
  await ensureDir(path.dirname(outPath));
  await ffmpegOk([
    "-ss",
    atSec.toFixed(3),
    "-i",
    video,
    "-frames:v",
    "1",
    "-vf",
    `scale=${scaledWidth}:-2:flags=lanczos`,
    "-pix_fmt",
    "rgb24",
    outPath,
  ]);
}

export interface StreamDurations {
  videoSec: number | null;
  audioSec: number | null;
  containerSec: number | null;
}

/**
 * Measure per-stream durations with ffprobe. Container (`format.duration`) is
 * the MAX of all streams — on real films it is usually the AUDIO length, which
 * is not frame-safe for video timelines. Timeline math must use videoSec.
 */
export async function measureStreamDurations(file: string): Promise<StreamDurations> {
  const meta = await ffprobeJson(file);
  const streams: any[] = meta.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const positive = (value: unknown): number | null => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  let videoSec = positive(video?.duration);
  if (videoSec === null && video) {
    const frames = Number(video.nb_frames);
    const fps = parseRational(video.avg_frame_rate ?? video.r_frame_rate);
    if (Number.isFinite(frames) && frames > 0 && fps) videoSec = frames / fps;
  }
  if (videoSec === null) videoSec = positive(meta.format?.duration);
  return {
    videoSec,
    audioSec: positive(audio?.duration),
    containerSec: positive(meta.format?.duration),
  };
}

function buildSegments(durationSec: number, cuts: number[]): Segment[] {
  const boundaries = [0, ...cuts.filter((t) => t > 0.1 && t < durationSec - 0.1), durationSec];
  const unique: number[] = [];
  for (const b of boundaries.sort((a, b) => a - b)) {
    const last = unique[unique.length - 1];
    if (last === undefined || b - last > 0.15) unique.push(b);
  }
  if ((unique[unique.length - 1] ?? 0) < durationSec - 0.01) unique.push(durationSec);
  const segments: Segment[] = [];
  for (let i = 0; i < unique.length - 1; i += 1) {
    const startSec = unique[i] as number;
    const endSec = unique[i + 1] as number;
    if (endSec - startSec < 0.1) continue;
    segments.push({ index: segments.length, startSec: round(startSec, 3), endSec: round(endSec, 3) });
  }
  return segments;
}

/**
 * [5]/[11] Per-frame YAVG differences via the same tblend pipeline jitter.ts
 * uses. Drives the second (soft cut) pass and per-scene motion scores.
 * diffs[k] corresponds to frame k+1 vs frame k.
 */
async function measureFrameDiffs(refPath: string): Promise<number[]> {
  try {
    const run = await ffmpeg(
      [
        "-i",
        refPath,
        "-vf",
        "format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
        "-an",
        "-f",
        "null",
        "-",
      ],
      { timeoutMs: 10 * 60_000, maxBuffer: 128 * 1024 * 1024 },
    );
    const values: number[] = [];
    const re = /lavfi\.signalstats\.YAVG=([0-9]+(?:\.[0-9]+)?)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(run.stderr)) !== null) {
      const v = Number(match[1]);
      if (Number.isFinite(v)) values.push(v);
    }
    return values;
  } catch {
    return [];
  }
}

/** Adaptive-threshold local maxima that are NOT near a hard cut. */
function detectSoftCuts(diffs: number[], fps: number, hardCuts: number[]): { atSec: number; frame: number }[] {
  if (diffs.length < 8) return [];
  const sorted = [...diffs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  const deviation = [...diffs].map((d) => Math.abs(d - median)).sort((a, b) => a - b);
  const mad = deviation[Math.floor(deviation.length / 2)] as number;
  const threshold = Math.max(1.0, median + Math.max(4 * mad, 0.8));
  const minGapFrames = Math.max(2, Math.round(fps * 0.5));
  const nearHardCut = Math.max(2, Math.round(fps * 0.4));
  const events: { atSec: number; frame: number }[] = [];
  let lastIndex = -Infinity;
  for (let i = 2; i < diffs.length - 2; i += 1) {
    const value = diffs[i] as number;
    if (value < threshold) continue;
    if (value < (diffs[i - 1] as number) || value < (diffs[i + 1] as number)) continue;
    if (i - lastIndex < minGapFrames) continue;
    const atSec = (i + 1) / fps;
    if (atSec < 0.3) continue;
    if (hardCuts.some((cut) => Math.abs(cut - atSec) * fps <= nearHardCut)) continue;
    events.push({ atSec: round(atSec, 3), frame: i + 1 });
    lastIndex = i;
  }
  return events.slice(0, 64);
}

function meanMotionScore(diffs: number[], startSec: number, endSec: number, fps: number): number {
  const from = Math.max(0, Math.round(startSec * fps));
  const to = Math.min(diffs.length, Math.round(endSec * fps));
  if (to - from < 2) return 0;
  // Trim the first/last frame (cut spikes) before averaging.
  const slice = diffs.slice(from + 1, Math.max(from + 2, to - 1));
  return round(slice.reduce((a, b) => a + b, 0) / slice.length, 4);
}

function channelLuminance(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Mean Sobel edge magnitude of one mid-video frame, normalized 0..1 (sharpness proxy). */
async function measureSharpness(refPath: string, atSec: number): Promise<number> {
  try {
    const result = await ffmpegOk(
      [
        "-ss",
        atSec.toFixed(3),
        "-i",
        refPath,
        "-frames:v",
        "1",
        "-vf",
        "scale=480:-2:flags=area,edgedetect=low=0.06:high=0.18,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
        "-an",
        "-f",
        "null",
        "-",
      ],
      { timeoutMs: 60_000 },
    );
    const values = [...result.stderr.matchAll(/lavfi\.signalstats\.YAVG=([0-9]+(?:\.[0-9]+)?)/g)].map((m) => Number(m[1]));
    const mean = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    return round(mean / 255, 5);
  } catch {
    return 0;
  }
}

/**
 * [8] Honest quality floor. A 736x414 @ 0.38 Mbps reference has already
 * destroyed small text, HUD labels, feather edges and texture — exact cloning
 * of fine detail is impossible regardless of how well the layout matches.
 */
async function computeCloneFeasibility(
  refPath: string,
  videoStream: any,
  meta: any,
  width: number,
  height: number,
  fps: number,
  durationSec: number,
): Promise<{
  score: number;
  bitratePerPixel: number;
  textLegibility: "ok" | "poor" | "destroyed";
  sharpnessEstimate: number;
  warnings: string[];
}> {
  const streamBitrate = Number(videoStream?.bit_rate);
  const formatBitrate = Number(meta?.format?.bit_rate);
  const sizeBitrate = Number(meta?.format?.size) > 0 && durationSec > 0 ? (Number(meta.format.size) * 8) / durationSec : 0;
  const bitrate = streamBitrate > 0 ? streamBitrate : formatBitrate > 0 ? formatBitrate : sizeBitrate;
  const bitratePerPixel = round(bitrate > 0 ? bitrate / (width * height * fps) : 0, 5);
  const sharpnessEstimate = round(await measureSharpness(refPath, durationSec / 2), 5);
  const bppScore = Math.min(1, bitratePerPixel / 0.18) * 65;
  const sharpScore = Math.min(1, sharpnessEstimate / 0.15) * 35;
  const score = round(Math.min(100, bppScore + sharpScore), 1);
  const textLegibility = bitratePerPixel < 0.06 ? "destroyed" : bitratePerPixel < 0.11 ? "poor" : "ok";
  const warnings: string[] = [];
  if (bitratePerPixel > 0 && bitratePerPixel < 0.1) {
    warnings.push(
      `low bitrate ${bitratePerPixel.toFixed(3)} bits/pixel/frame (< 0.1) — fine text, HUD labels and feather edges are already destroyed`,
    );
  }
  if (width * height < 800 * 450) {
    warnings.push(`low resolution ${width}x${height} (< 800x450) — fine detail cannot be re-measured reliably`);
  }
  if (sharpnessEstimate < 0.04) {
    warnings.push(`soft reference (edge score ${sharpnessEstimate}) — text legibility and texture are approximations`);
  }
  if (score < 55) {
    warnings.push("This reference cannot support exact cloning of fine detail — expect a native approximation, not a copy.");
  }
  return { score, bitratePerPixel, textLegibility, sharpnessEstimate, warnings };
}

/**
 * [30] containsRealRecording heuristic: mean spectral flatness of the audio.
 * Recorded/natural material (birdsong, foley, voice) is broadband and
 * less tonal than synthesized SFX/music beds. Documented limit: a noisy synth
 * pad can look "real"; this is a warning label, never a gate.
 */
async function detectRealRecording(refPath: string): Promise<boolean> {
  try {
    const result = await ffmpegOk(
      [
        "-i",
        refPath,
        "-vn",
        "-af",
        "aspectralstats=measure=flatness,ametadata=print:key=lavfi.aspectralstats.1.flatness",
        "-f",
        "null",
        "-",
      ],
      { timeoutMs: 120_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const values = [...result.stderr.matchAll(/lavfi\.aspectralstats\.1\.flatness=([0-9]+(?:\.[0-9]+)?)/g)].map((m) => Number(m[1]));
    if (values.length === 0) return false;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return round(mean, 4) > 0.18;
  } catch {
    return false;
  }
}

/** Read low-res RGB frames for a segment (rawvideo) and compute dominant palette + luminance stats. */
async function analyzeSegmentPalette(refPath: string, segment: Segment): Promise<ScenePaletteInfo> {
  const width = 64;
  const height = 36;
  const duration = segment.endSec - segment.startSec;
  const sampleFps = duration > 1.5 ? 4 : Math.max(2, Math.round(duration * 4));
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  try {
    const result = await runBinary("ffmpeg", [
      "-v",
      "error",
      "-ss",
      segment.startSec.toFixed(3),
      "-t",
      duration.toFixed(3),
      "-i",
      refPath,
      "-vf",
      `fps=${sampleFps},scale=${width}:${height}:flags=area`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ]);
    if (result.code === 0) buffer = result.stdout;
  } catch {
    // fall through with an empty buffer
  }

  const frameBytes = width * height * 3;
  const frameCount = Math.floor(buffer.length / frameBytes);
  const counts = new Map<number, number>();
  const lums: number[] = [];
  let total = 0;
  for (let f = 0; f < frameCount; f += 1) {
    const base = f * frameBytes;
    for (let p = 0; p < width * height; p += 1) {
      const offset = base + p * 3;
      const r = buffer[offset] as number;
      const g = buffer[offset + 1] as number;
      const b = buffer[offset + 2] as number;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      lums.push(0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b));
      total += 1;
    }
  }

  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const colors = top.map(([key, count]) => {
    const ri = ((key >> 8) & 0xf) * 16 + 8;
    const gi = ((key >> 4) & 0xf) * 16 + 8;
    const bi = (key & 0xf) * 16 + 8;
    const hex = `#${[ri, gi, bi].map((v) => Math.min(255, v).toString(16).padStart(2, "0")).join("")}`;
    return { hex, share: total > 0 ? round(count / total, 4) : 0 };
  });

  let avgLuminance = 0;
  let contrast = 0;
  if (lums.length > 0) {
    avgLuminance = lums.reduce((a, b) => a + b, 0) / lums.length;
    const variance = lums.reduce((a, b) => a + (b - avgLuminance) ** 2, 0) / lums.length;
    contrast = Math.min(1, Math.sqrt(variance) * 2);
  }

  return {
    index: segment.index,
    startSec: segment.startSec,
    endSec: segment.endSec,
    colors,
    avgLuminance: round(avgLuminance, 4),
    contrast: round(contrast, 4),
    motionScore: 0,
  };
}

interface EnvelopeResult {
  envelope: { fps: number; durationSec: number; frames: number[]; beatsSec: number[] };
}

/** Frame-accurate RMS envelope (normalized) + beat peaks, decoded as 8 kHz mono PCM. */
async function computeAudioEnvelope(refPath: string, durationSec: number, fps: number): Promise<EnvelopeResult | null> {
  let pcm: Buffer<ArrayBufferLike>;
  try {
    const result = await runBinary("ffmpeg", [
      "-v",
      "error",
      "-i",
      refPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "8000",
      "-f",
      "s16le",
      "-",
    ]);
    if (result.code !== 0 || result.stdout.length === 0) return null;
    pcm = result.stdout;
  } catch {
    return null;
  }
  const sampleRate = 8000;
  const sampleCount = Math.floor(pcm.length / 2);
  const frameCount = Math.max(1, Math.round(durationSec * fps));
  const rmsValues: number[] = [];
  for (let i = 0; i < frameCount; i += 1) {
    const startSample = Math.floor((i / fps) * sampleRate);
    const endSample = Math.min(sampleCount, Math.floor(((i + 1) / fps) * sampleRate));
    let sum = 0;
    let n = 0;
    for (let s = startSample; s < endSample; s += 1) {
      const v = (pcm.readInt16LE(s * 2) ?? 0) / 32768;
      sum += v * v;
      n += 1;
    }
    rmsValues.push(n > 0 ? Math.sqrt(sum / n) : 0);
  }
  const maxRms = Math.max(1e-9, ...rmsValues);
  const frames = rmsValues.map((v) => round(Math.min(1, v / maxRms), 4));
  const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
  const variance = frames.reduce((a, b) => a + (b - mean) ** 2, 0) / frames.length;
  const threshold = Math.max(0.35, mean + Math.sqrt(variance) * 0.8);
  const beatsSec: number[] = [];
  let lastBeat = -Infinity;
  for (let i = 2; i < frames.length - 2; i += 1) {
    const v = frames[i] as number;
    const isPeak = v >= (frames[i - 1] as number) && v >= (frames[i + 1] as number) && v >= (frames[i - 2] as number) && v >= (frames[i + 2] as number);
    if (isPeak && v >= threshold && i / fps - lastBeat > 0.25) {
      beatsSec.push(round(i / fps, 3));
      lastBeat = i / fps;
    }
    if (beatsSec.length >= 128) break;
  }
  return { envelope: { fps, durationSec: round(durationSec, 3), frames, beatsSec } };
}

export async function probeReference(
  refPath: string,
  workspaceDir: string,
  options: ProbeOptions = {},
): Promise<ProbeResultT> {
  if (!(await pathExists(refPath))) {
    throw new Error(`Reference video not found: ${refPath}`);
  }
  const meta = await ffprobeJson(refPath);
  const videoStream = (meta.streams ?? []).find((s: any) => s.codec_type === "video");
  if (!videoStream) throw new Error(`No video stream found in ${refPath}`);
  const audioStream = (meta.streams ?? []).find((s: any) => s.codec_type === "audio");

  const rational = String(videoStream.avg_frame_rate ?? videoStream.r_frame_rate ?? "30/1");
  const fpsNumeric = parseRational(rational) ?? 30;
  const durationSec = Number(meta.format?.duration ?? videoStream.duration ?? 0);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`Could not determine duration for ${refPath}`);
  }

  // [8] quality floor + [30] recording heuristic (measured, never guessed).
  const cloneFeasibility = await computeCloneFeasibility(
    refPath,
    videoStream,
    meta,
    Number(videoStream.width),
    Number(videoStream.height),
    fpsNumeric,
    durationSec,
  ).catch(() => undefined);
  const containsRealRecording = audioStream ? await detectRealRecording(refPath) : false;

  // Scene cuts via ffmpeg scene detection.
  let cutsSec: number[] = [];
  try {
    const cutRun = await ffmpegOk(
      ["-i", refPath, "-filter:v", "select='gt(scene,0.3)',showinfo", "-an", "-f", "null", "-"],
      { timeoutMs: 180_000 },
    );
    cutsSec = dedupeTimes(extractPtsTimes(cutRun.stderr), 0.3);
  } catch {
    cutsSec = [];
  }

  // Audio onsets via astats RMS energy peaks.
  let onsetsSec: number[] = [];
  if (audioStream) {
    try {
      const astatsRun = await ffmpegOk(
        [
          "-i",
          refPath,
          "-vn",
          "-af",
          "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
          "-f",
          "null",
          "-",
        ],
        { timeoutMs: 180_000, maxBuffer: 256 * 1024 * 1024 },
      );
      onsetsSec = detectOnsets(parseAstats(astatsRun.stderr));
    } catch {
      onsetsSec = [];
    }
  }

  // [5] Second pass: per-frame diffs → soft/graphic reconfigurations (no hard cut).
  const frameDiffs = await measureFrameDiffs(refPath);
  const softCuts = detectSoftCuts(frameDiffs, fpsNumeric, cutsSec);
  const softCutsSec = softCuts.map((event) => event.atSec);

  // Per-scene dominant palettes + luminance/contrast + motion energy estimates.
  let segments = buildSegments(durationSec, cutsSec);
  if (options.maxSegments !== undefined && options.maxSegments > 0 && segments.length > options.maxSegments) {
    console.warn(
      `probe: ${segments.length} segments found, truncating to --max-segments ${options.maxSegments} (pass a larger value to keep all)`,
    );
    segments = segments.slice(0, options.maxSegments);
  }
  const scenes: ScenePaletteInfo[] = [];
  for (const segment of segments) {
    const palette = await analyzeSegmentPalette(refPath, segment);
    palette.motionScore = meanMotionScore(frameDiffs, segment.startSec, segment.endSec, fpsNumeric);
    scenes.push(palette);
  }

  // [6] Geometry probe (explicit --geometry).
  if (options.geometry) {
    const geometry = await probeGeometry(refPath, segments, Number(videoStream.width), Number(videoStream.height));
    await writeJsonAtomic(path.join(workspaceDir, "geometry.json"), geometry);
  }

  // Frame-accurate audio envelope + beats (drives audio-reactive custom scenes).
  let envelopePath: string | null = null;
  if (audioStream) {
    const envelope = await computeAudioEnvelope(refPath, durationSec, fpsNumeric);
    if (envelope) {
      AudioEnvelope.parse(envelope.envelope);
      await writeJsonAtomic(path.join(workspaceDir, "audio-envelope.json"), envelope.envelope);
      envelopePath = "audio-envelope.json";
    }
  }

  const sceneIndexFor = (t: number): number => {
    for (const scene of scenes) if (t >= scene.startSec - 0.001 && t < scene.endSec - 0.001) return scene.index;
    return scenes.length > 0 ? scenes.length - 1 : 0;
  };

  // Frame timestamps: start + every 1s + every cut (cap to keep sheets readable).
  const times = new Set<number>();
  times.add(0);
  for (let t = 1; t < durationSec - 0.05; t += 1) times.add(round(t, 3));
  for (const t of cutsSec) if (t < durationSec - 0.05) times.add(t);
  for (const t of softCutsSec) if (t < durationSec - 0.05) times.add(t);
  const ordered = dedupeTimes([...times], 0.05).slice(0, 72);

  const framesDir = path.join(workspaceDir, "probe-frames");
  await ensureDir(framesDir);
  const frames: {
    path: string;
    atSec: number;
    label: string;
    dataUri: string;
    cutIndex: number | null;
    sceneIndex: number;
    swatches: string[];
  }[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const at = ordered[i] as number;
    const label = formatTimestamp(at);
    const file = path.join(framesDir, `frame_${String(i + 1).padStart(4, "0")}_${at.toFixed(3).replace(".", "_")}s.png`);
    await extractFrameAt(refPath, at, file, 960);
    const buf = await fs.readFile(file);
    const sceneIndex = sceneIndexFor(at);
    const cutIndex = cutsSec.findIndex((cut) => Math.abs(cut - at) <= 0.06);
    const scene = scenes[sceneIndex];
    frames.push({
      path: file,
      atSec: at,
      label,
      dataUri: `data:image/png;base64,${buf.toString("base64")}`,
      cutIndex: cutIndex >= 0 ? cutIndex + 1 : null,
      sceneIndex,
      swatches: scene ? scene.colors.map((c) => c.hex) : [],
    });
  }

  // 3x3 labeled contact sheets with cut numbers + palette swatches.
  const contactSheets: string[] = [];
  const perSheet = 9;
  const sheetCount = Math.ceil(frames.length / perSheet);
  for (let s = 0; s < sheetCount; s += 1) {
    const slice = frames.slice(s * perSheet, (s + 1) * perSheet);
    const html = contactSheetHtml(
      slice.map((f, idx) => ({
        dataUri: f.dataUri,
        label: f.label,
        index: s * perSheet + idx + 1,
        cutIndex: f.cutIndex,
        sceneIndex: f.sceneIndex,
        swatches: f.swatches,
      })),
      s + 1,
      "ULTRA · reference probe",
    );
    const out = path.join(workspaceDir, `contact-sheet-${String(s + 1).padStart(2, "0")}.png`);
    await renderHtmlToPng(html, 1600, 1100, out);
    contactSheets.push(out);
  }

  const result: ProbeResultT = {
    sourcePath: path.resolve(refPath),
    width: Number(videoStream.width),
    height: Number(videoStream.height),
    fps: { rational, numeric: round(fpsNumeric, 6) },
    durationSec: round(durationSec, 6),
    pixelFormat: String(videoStream.pix_fmt ?? "unknown"),
    audio: audioStream
      ? {
          codec: String(audioStream.codec_name ?? "unknown"),
          sampleRate: Number(audioStream.sample_rate ?? 48000),
          channels: Number(audioStream.channels ?? 2),
        }
      : null,
    cutsSec,
    softCutsSec,
    softCutFrames: softCuts.map((event) => ({ atSec: event.atSec, frame: event.frame })),
    onsetsSec,
    frames: frames.map((f) => ({
      path: path.relative(workspaceDir, f.path),
      atSec: f.atSec,
      label: f.label,
      cutIndex: f.cutIndex,
      sceneIndex: f.sceneIndex,
      swatches: f.swatches,
    })),
    contactSheets: contactSheets.map((p) => path.relative(workspaceDir, p)),
    scenes,
    audioEnvelopePath: envelopePath,
    ...(cloneFeasibility ? { cloneFeasibility } : {}),
    containsRealRecording,
  };

  ProbeResult.parse(result);
  await writeJsonAtomic(path.join(workspaceDir, "probe.json"), result);
  return result;
}
