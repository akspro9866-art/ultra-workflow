import { promises as fs } from "node:fs";
import path from "node:path";
import { ffmpegOk, ffprobeJson, parseRational, runBinary } from "./ffmpeg.js";
import { renderHtmlToPng } from "./browser.js";
import { AudioEnvelope, ProbeResult, type ProbeResultT } from "./schema.js";
import { ensureDir, formatTimestamp, pathExists, round, writeJsonAtomic } from "./util.js";

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

function channelLuminance(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
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

function contactSheetHtml(
  frames: {
    dataUri: string;
    label: string;
    index: number;
    cutIndex: number | null;
    sceneIndex: number;
    swatches: string[];
  }[],
  sheetIndex: number,
  title: string,
): string {
  const cells = frames
    .map(
      (f) => `
      <div class="cell">
        <div class="frame-wrap"><img src="${f.dataUri}" alt="frame ${f.index}" /></div>
        <div class="label">
          <div class="left"><span class="idx">#${String(f.index).padStart(3, "0")}</span>${
            f.cutIndex !== null ? `<span class="cut">CUT #${f.cutIndex}</span>` : ""
          }<span class="scene">S${f.sceneIndex + 1}</span><span class="sw">${f.swatches
            .map((hex) => `<i style="background:${hex}"></i>`)
            .join("")}</span></div>
          <span class="ts">${f.label}</span>
        </div>
      </div>`,
    )
    .join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<style>
  html,body { margin:0; padding:0; background:#0b0d10; color:#e8eaed;
    font-family:"Segoe UI","Inter","Helvetica Neue",Arial,sans-serif; width:1600px; height:1100px; overflow:hidden; }
  .head { display:flex; justify-content:space-between; align-items:baseline; padding:22px 28px 12px; }
  .title { font-size:22px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; }
  .sub { font-size:13px; color:#9aa0a6; letter-spacing:0.08em; }
  .grid { display:grid; grid-template-columns:repeat(3, 1fr); grid-template-rows:repeat(3, 1fr);
    gap:14px; padding:0 28px 24px; box-sizing:border-box; height:1010px; }
  .cell { background:#14171c; border:1px solid #23272e; border-radius:8px; display:flex; flex-direction:column; overflow:hidden; }
  .frame-wrap { flex:1; display:flex; align-items:center; justify-content:center; background:#000; min-height:0; }
  .frame-wrap img { max-width:100%; max-height:100%; object-fit:contain; display:block; }
  .label { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; font-size:15px; border-top:1px solid #23272e; background:#101318; gap:10px; }
  .left { display:flex; align-items:center; gap:8px; min-width:0; }
  .idx { color:#8ab4f8; font-weight:600; }
  .cut { color:#ffd166; font-size:12px; font-weight:700; letter-spacing:0.06em; border:1px solid #4b3c16; border-radius:4px; padding:1px 5px; }
  .scene { color:#9aa0a6; font-size:12px; letter-spacing:0.06em; }
  .sw { display:inline-flex; gap:3px; }
  .sw i { width:12px; height:12px; border-radius:3px; display:inline-block; border:1px solid rgba(255,255,255,0.2); }
  .ts { font-family:"Cascadia Mono","Consolas",monospace; color:#e8eaed; white-space:nowrap; }
</style></head>
<body>
  <div class="head">
    <div class="title">${title}</div>
    <div class="sub">CONTACT SHEET ${String(sheetIndex).padStart(2, "0")}</div>
  </div>
  <div class="grid">${cells}</div>
</body></html>`;
}

export async function probeReference(refPath: string, workspaceDir: string): Promise<ProbeResultT> {
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

  // Per-scene dominant palettes + luminance/contrast estimates.
  const segments = buildSegments(durationSec, cutsSec).slice(0, 24);
  const scenes: ScenePaletteInfo[] = [];
  for (const segment of segments) {
    scenes.push(await analyzeSegmentPalette(refPath, segment));
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
  };

  ProbeResult.parse(result);
  await writeJsonAtomic(path.join(workspaceDir, "probe.json"), result);
  return result;
}
