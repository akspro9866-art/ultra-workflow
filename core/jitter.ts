import { ffmpeg } from "./ffmpeg.js";
import { round } from "./util.js";

export interface JitterRun {
  start: number;
  length: number;
}

export interface JitterAnalysis {
  frameDiffs: number[];
  duplicateFrames: number;
  staticHoldFrames: number;
  stutterEvents: number;
  stutterFrames: number;
  maxStaticHoldFrames: number;
  maxStaticHoldSec: number;
  runs: JitterRun[];
  /** Runs actually classified as stutter (isolated 2–3 duplicates amid motion). */
  stutterRuns: JitterRun[];
}

/**
 * Shared smart jitter analysis (used by verifier/metrics and style-probe).
 *
 * Frame differences are measured exactly with
 * `format=gray,tblend=all_mode=difference,signalstats,metadata=print` (YAVG per
 * frame pair). A pair with YAVG <= 0.12 is a duplicate frame (epsilon sits above
 * H.264 quantization noise, typically 0.003–0.03 across frame types). Consecutive
 * duplicate runs >= round(fps * 0.25) are intentional STATIC HOLDS; isolated 2–3
 * duplicate frames surrounded by motion are STUTTER. A lone duplicated frame is
 * a micro-hold (smooth easing apexes pause for one frame — imperceptible).
 * Single-frame noise gaps (diff < 0.25) are bridged.
 */
export function classifyFrameDifferences(diffs: number[], totalFrames: number, fps: number): JitterAnalysis {
  const holdThreshold = Math.max(2, Math.round(fps * 0.25));
  const EPSILON = 0.12;
  const duplicate = diffs.map((d) => d <= EPSILON);

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

  const runs: JitterRun[] = [];
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
  let maxStaticHoldFrames = 0;
  const stutterRuns: JitterRun[] = [];
  const duplicateFrames = runs.reduce((acc, run) => acc + run.length, 0);

  for (const run of runs) {
    maxStaticHoldFrames = Math.max(maxStaticHoldFrames, run.length);
    const endsAtStart = run.start === 1;
    const endsAtEnd = run.start + run.length >= totalFrames - 1;
    if (run.length >= holdThreshold) staticHoldFrames += run.length;
    else if (run.length >= 2 && run.length <= 3 && !endsAtStart && !endsAtEnd) {
      stutterEvents += 1;
      stutterFrames += run.length;
      stutterRuns.push(run);
    } else {
      // long holds, boundary holds and single-frame micro-holds
      staticHoldFrames += run.length;
    }
  }

  return {
    frameDiffs: diffs,
    duplicateFrames,
    staticHoldFrames,
    stutterEvents,
    stutterFrames,
    maxStaticHoldFrames,
    maxStaticHoldSec: round(maxStaticHoldFrames / fps, 3),
    runs,
    stutterRuns,
  };
}

export async function measureJitter(file: string, fps: number, totalFrames: number): Promise<JitterAnalysis> {
  const run = await ffmpeg(
    [
      "-i",
      file,
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
  while ((m = re.exec(run.stderr)) !== null) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) diffs.push(v);
  }
  return classifyFrameDifferences(diffs, totalFrames, fps);
}
