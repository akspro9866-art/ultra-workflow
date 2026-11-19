import { ffmpeg, ffprobeJson, parseRational } from "../core/ffmpeg.js";
import { round } from "../core/util.js";

export interface LoudnessAudit {
  inputI: number | null;
  inputTp: number | null;
  targetLufs: number;
  ok: boolean;
}

export interface QuantitativeMetrics {
  durationDeltaSec: number;
  durationOk: boolean;
  fpsExpected: number;
  fpsActual: number | null;
  fpsOk: boolean;
  cfr: boolean;
  cfrOk: boolean;
  duplicateRatio: number | null;
  staticHoldFrames: number;
  staticHoldRatio: number;
  stutterEvents: number;
  stutterFrames: number;
  jitterRatio: number;
  jitterOk: boolean;
  blackDetections: { startSec: number; endSec: number }[];
  blackOk: boolean;
  loudness: LoudnessAudit | null;
  pass: boolean;
}

function lastMatch(text: string, re: RegExp): RegExpExecArray | null {
  let last: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  while ((match = global.exec(text)) !== null) last = match;
  return last;
}

function parseLoudnorm(text: string): { inputI: number | null; inputTp: number | null } {
  const blocks = text.match(/\{[^{}]*"input_i"[\s\S]*?\}/g) ?? [];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(blocks[i] as string) as Record<string, unknown>;
      const inputI = Number(parsed["input_i"]);
      const inputTp = Number(parsed["input_tp"]);
      return {
        inputI: Number.isFinite(inputI) ? inputI : null,
        inputTp: Number.isFinite(inputTp) ? inputTp : null,
      };
    } catch {
      // try earlier block
    }
  }
  return { inputI: null, inputTp: null };
}

/**
 * Smart duplicate-run classification.
 *
 * Frame differences are measured exactly with
 * `format=gray,tblend=all_mode=difference,signalstats,metadata=print` (YAVG per
 * frame pair). A pair with YAVG <= 0.12 is a duplicate frame (the epsilon sits
 * safely above H.264 quantization noise across frame types — identical frames
 * typically decode with YAVG 0.003–0.03). Consecutive duplicate runs
 * >= round(fps * 0.25) are intentional STATIC HOLDS; isolated 2–3 duplicate
 * frames surrounded by motion are STUTTER (real jitter). A lone duplicated
 * frame is a micro-hold: smooth easing curves (sine/easeOutBack apexes) pause
 * for exactly one frame at their turning points, which is imperceptible and not
 * a defect. Single-frame noise gaps (diff < 0.25) are bridged so encoder noise
 * cannot fabricate stutter.
 */
function classifyDuplicateRuns(
  diffs: number[],
  totalFrames: number,
  fps: number,
): { staticHoldFrames: number; stutterEvents: number; stutterFrames: number; duplicateFrames: number } {
  const holdThreshold = Math.max(2, Math.round(fps * 0.25));
  const EPSILON = 0.12;
  const duplicate = diffs.map((d) => d <= EPSILON);

  // Bridge short noise gaps between duplicate runs (encoder QP noise).
  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false;
    for (let i = 1; i < duplicate.length - 1; i += 1) {
      if (duplicate[i]) continue;
      const prevDup = duplicate[i - 1] === true;
      const nextDup = duplicate[i + 1] === true;
      if (prevDup && nextDup && (diffs[i] as number) < 0.25) {
        duplicate[i] = true;
        changed = true;
        continue;
      }
      if (
        prevDup &&
        i + 2 < duplicate.length &&
        duplicate[i + 1] === false &&
        duplicate[i + 2] === true &&
        (diffs[i] as number) < 0.25 &&
        (diffs[i + 1] as number) < 0.25
      ) {
        duplicate[i] = true;
        duplicate[i + 1] = true;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const runs: { start: number; length: number }[] = [];
  let i = 0;
  while (i < duplicate.length) {
    if (!duplicate[i]) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < duplicate.length && duplicate[j]) j += 1;
    // diffs[k] corresponds to frame k+1 being a duplicate of frame k
    runs.push({ start: i + 1, length: j - i });
    i = j;
  }

  let staticHoldFrames = 0;
  let stutterEvents = 0;
  let stutterFrames = 0;
  const duplicateFrames = runs.reduce((acc, run) => acc + run.length, 0);

  for (const run of runs) {
    const endsAtStart = run.start === 1;
    const endsAtEnd = run.start + run.length >= totalFrames - 1;
    if (run.length >= holdThreshold) staticHoldFrames += run.length;
    else if (run.length >= 2 && run.length <= 3 && !endsAtStart && !endsAtEnd) {
      stutterEvents += 1;
      stutterFrames += run.length;
    } else {
      // long holds, boundary holds and single-frame micro-holds
      staticHoldFrames += run.length;
    }
  }

  return { staticHoldFrames, stutterEvents, stutterFrames, duplicateFrames };
}

export async function auditDraft(opts: {
  draftFile: string;
  referenceFile: string;
  expectedDurationSec: number;
  expectedFps: number;
  targetLufs: number;
}): Promise<QuantitativeMetrics> {
  const draftProbe = await ffprobeJson(opts.draftFile);
  const streams: any[] = draftProbe.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");

  const durationSec = Number(draftProbe.format?.duration ?? video?.duration ?? 0);
  const durationDeltaSec = round(durationSec - opts.expectedDurationSec, 3);
  const durationOk = Math.abs(durationDeltaSec) <= 0.05;

  const fpsActualRaw = parseRational(video?.avg_frame_rate);
  const fpsR = parseRational(video?.r_frame_rate);
  const fpsActual = fpsActualRaw !== null ? round(fpsActualRaw, 4) : null;
  const fpsOk = fpsActual !== null && Math.abs(fpsActual - opts.expectedFps) <= 0.01;

  const nbFrames = Number(video?.nb_frames ?? 0);
  const expectedFrames = Math.round(opts.expectedDurationSec * opts.expectedFps);
  const rationalStable = fpsR !== null && fpsActualRaw !== null && Math.abs(fpsR - fpsActualRaw) <= 0.0005;
  const cfr = rationalStable && nbFrames > 0 && Math.abs(nbFrames - expectedFrames) <= 2;

  const totalFrames = nbFrames > 0 ? nbFrames : expectedFrames;
  let duplicateRatio: number | null = null;
  let staticHoldFrames = 0;
  let staticHoldRatio = 0;
  let stutterEvents = 0;
  let stutterFrames = 0;
  let jitterRatio = 0;
  try {
    const dup = await ffmpeg(
      [
        "-i",
        opts.draftFile,
        "-vf",
        "format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
        "-an",
        "-f",
        "null",
        "-",
      ],
      { timeoutMs: 10 * 60_000 },
    );
    const diffs: number[] = [];
    const re = /lavfi\.signalstats\.YAVG=([0-9]+(?:\.[0-9]+)?)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(dup.stderr)) !== null) {
      const v = Number(m[1]);
      if (Number.isFinite(v)) diffs.push(v);
    }
    if (totalFrames > 0 && diffs.length > 0) {
      const classified = classifyDuplicateRuns(diffs, totalFrames, opts.expectedFps);
      duplicateRatio = round(classified.duplicateFrames / totalFrames, 4);
      staticHoldFrames = classified.staticHoldFrames;
      staticHoldRatio = round(staticHoldFrames / totalFrames, 4);
      stutterEvents = classified.stutterEvents;
      stutterFrames = classified.stutterFrames;
      jitterRatio = round(stutterFrames / totalFrames, 4);
    }
  } catch {
    duplicateRatio = null;
  }
  const jitterOk = stutterEvents === 0;

  const blackDetections: { startSec: number; endSec: number }[] = [];
  try {
    const black = await ffmpeg(
      ["-i", opts.draftFile, "-vf", "blackdetect=d=0.15:pix_th=0.04", "-an", "-f", "null", "-"],
      { timeoutMs: 10 * 60_000 },
    );
    const re = /black_start:([\d.]+)\s+black_end:([\d.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(black.stderr)) !== null) {
      blackDetections.push({ startSec: round(Number(m[1]), 3), endSec: round(Number(m[2]), 3) });
    }
  } catch {
    // treat parse failure as no detections
  }
  const blackOk = blackDetections.every((b) => b.endSec - b.startSec < 0.25);

  let loudness: LoudnessAudit | null = null;
  if (audio) {
    let inputI: number | null = null;
    let inputTp: number | null = null;
    try {
      const run = await ffmpeg(
        ["-i", opts.draftFile, "-af", "loudnorm=print_format=json", "-f", "null", "-"],
        { timeoutMs: 10 * 60_000 },
      );
      const parsed = parseLoudnorm(run.stderr);
      inputI = parsed.inputI;
      inputTp = parsed.inputTp;
    } catch {
      // leave nulls
    }
    const ok = inputI !== null && Math.abs(inputI - opts.targetLufs) <= 2 && (inputTp === null || inputTp <= 0.5);
    loudness = { inputI, inputTp, targetLufs: opts.targetLufs, ok };
  }

  const pass = durationOk && fpsOk && cfr && jitterOk && blackOk && (loudness === null ? true : loudness.ok);

  return {
    durationDeltaSec,
    durationOk,
    fpsExpected: opts.expectedFps,
    fpsActual,
    fpsOk,
    cfr,
    cfrOk: cfr,
    duplicateRatio,
    staticHoldFrames,
    staticHoldRatio,
    stutterEvents,
    stutterFrames,
    jitterRatio,
    jitterOk,
    blackDetections,
    blackOk,
    loudness,
    pass,
  };
}
