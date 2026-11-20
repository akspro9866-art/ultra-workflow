import { ffmpeg, ffprobeJson, parseRational } from "../core/ffmpeg.js";
import { measureJitter, type JitterAnalysis, type JitterRun } from "../core/jitter.js";
import { round } from "../core/util.js";

export interface LoudnessAudit {
  inputI: number | null;
  inputTp: number | null;
  targetLufs: number;
  ok: boolean;
}

export interface JitterEvent {
  startFrame: number;
  length: number;
  atSec: number;
}

/** Compact report summary for a raw jitter analysis. */
export function jitterSummary(analysis: JitterAnalysis | null): {
  stutterEvents: number;
  stutterFrames: number;
  staticHoldFrames: number;
  maxStaticHoldSec: number;
} | undefined {
  if (!analysis) return undefined;
  return {
    stutterEvents: analysis.stutterEvents,
    stutterFrames: analysis.stutterFrames,
    staticHoldFrames: analysis.staticHoldFrames,
    maxStaticHoldSec: analysis.maxStaticHoldSec,
  };
}

/**
 * [23] A draft stutter run that coincides with a reference hold / stutter-like
 * run within ±3 frames is NOT a defect — the reference itself holds there.
 */
export function reconcileJitter(draft: JitterAnalysis, reference: JitterAnalysis | null, fps: number): JitterEvent[] {
  const tolerance = 3;
  return draft.stutterRuns
    .filter((run) => {
      if (!reference) return true;
      const draftStart = run.start;
      const draftEnd = run.start + run.length - 1;
      return !reference.runs.some((ref: JitterRun) => {
        const refStart = ref.start;
        const refEnd = ref.start + ref.length - 1;
        return draftStart <= refEnd + tolerance && draftEnd >= refStart - tolerance;
      });
    })
    .map((run) => ({ startFrame: run.start, length: run.length, atSec: round(run.start / fps, 3) }));
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
  maxStaticHoldSec: number;
  jitterOk: boolean;
  blackDetections: { startSec: number; endSec: number }[];
  blackOk: boolean;
  loudness: LoudnessAudit | null;
  jitterDraft: JitterAnalysis | null;
  jitterReference: JitterAnalysis | null;
  jitterUnmatchedEvents: JitterEvent[];
  pass: boolean;
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
  let maxStaticHoldSec = 0;
  let jitterDraft: JitterAnalysis | null = null;
  let jitterReference: JitterAnalysis | null = null;
  let jitterUnmatchedEvents: JitterEvent[] = [];
  try {
    const analysis = await measureJitter(opts.draftFile, opts.expectedFps, totalFrames);
    jitterDraft = analysis;
    if (analysis.frameDiffs.length > 0 && totalFrames > 0) {
      duplicateRatio = round(analysis.duplicateFrames / totalFrames, 4);
      staticHoldFrames = analysis.staticHoldFrames;
      staticHoldRatio = round(staticHoldFrames / totalFrames, 4);
      stutterEvents = analysis.stutterEvents;
      stutterFrames = analysis.stutterFrames;
      jitterRatio = round(stutterFrames / totalFrames, 4);
      maxStaticHoldSec = analysis.maxStaticHoldSec;
    }
    // [23] Measure the reference too — its own holds are not our defects.
    try {
      const refProbe = await ffprobeJson(opts.referenceFile);
      const refVideo = (refProbe.streams ?? []).find((stream: any) => stream.codec_type === "video");
      const refFrames = Number(refVideo?.nb_frames) > 0 ? Number(refVideo.nb_frames) : Math.round(Number(refProbe.format?.duration ?? 0) * opts.expectedFps);
      if (refFrames > 1) {
        jitterReference = await measureJitter(opts.referenceFile, opts.expectedFps, refFrames);
        jitterUnmatchedEvents = reconcileJitter(analysis, jitterReference, opts.expectedFps);
        stutterEvents = jitterUnmatchedEvents.length;
        stutterFrames = jitterUnmatchedEvents.reduce((acc, event) => acc + event.length, 0);
        jitterRatio = totalFrames > 0 ? round(stutterFrames / totalFrames, 4) : 0;
      }
    } catch {
      jitterReference = null;
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
    maxStaticHoldSec,
    jitterOk,
    blackDetections,
    blackOk,
    loudness,
    jitterDraft,
    jitterReference,
    jitterUnmatchedEvents,
    pass,
  };
}
