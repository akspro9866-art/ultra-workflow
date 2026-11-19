import { promises as fs } from "node:fs";
import path from "node:path";
import { probeReference } from "./probe.js";
import { StylePackSchema, type StylePackT } from "./style-schema.js";
import { stylesRoot } from "./style-pack.js";
import { run } from "./ffmpeg.js";
import { ensureDir, round, writeJsonAtomic } from "./util.js";

export interface RawSilence {
  startSec: number;
  endSec: number;
  durationSec: number;
}

export interface RawKeepSegment {
  startSec: number;
  endSec: number;
  durationSec: number;
}

export interface RawEditPlan {
  generatedAt: string;
  source: string;
  styleSlug: string;
  durationSec: number;
  fps: number;
  silenceThresholdDb: number;
  silenceTrimMs: number;
  silences: RawSilence[];
  removedIntervals: RawSilence[];
  keepSegments: RawKeepSegment[];
  removedDurationSec: number;
  pacing: {
    hookEndSec: number;
    chapterResetsSec: number[];
    targetBodyAslSec: number;
    maxStaticHoldSec: number;
    punchInPoints: { atSec: number; scale: number }[];
    brollCutaways: { atSec: number; durationSec: number }[];
    captionWindows: { startSec: number; endSec: number; maxWords: number }[];
  };
  beatsSec: number[];
}

function mergeIntervals(intervals: { startSec: number; endSec: number }[]): { startSec: number; endSec: number }[] {
  const sorted = [...intervals].filter((i) => i.endSec > i.startSec).sort((a, b) => a.startSec - b.startSec);
  const merged: { startSec: number; endSec: number }[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.startSec <= last.endSec + 0.001) {
      last.endSec = Math.max(last.endSec, interval.endSec);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function medianOfPair([min, max]: [number, number]): number {
  return round((min + max) / 2, 3);
}

async function detectSilences(file: string, minDurSec: number): Promise<RawSilence[]> {
  const result = await run(
    "ffmpeg",
    ["-hide_banner", "-y", "-i", file, "-vn", "-af", `silencedetect=noise=-35dB:d=${minDurSec}`, "-f", "null", "-"],
    { timeoutMs: 180_000 },
  );
  const starts = [...result.stderr.matchAll(/silence_start:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  const ends = [...result.stderr.matchAll(/silence_end:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  const silences: RawSilence[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i] as number;
    const end = ends[i];
    if (end !== undefined && Number.isFinite(end) && end > start) {
      silences.push({ startSec: round(start, 3), endSec: round(end, 3), durationSec: round(end - start, 3) });
    }
  }
  return silences;
}

export async function loadStylePack(slug: string): Promise<{ style: StylePackT; dir: string }> {
  const dir = path.join(stylesRoot(), slug);
  const styleFile = path.join(dir, "style.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(styleFile, "utf8"));
  } catch {
    throw new Error(`style pack "${slug}" not found in ${stylesRoot()} (run ultra style-import first)`);
  }
  const parsed = StylePackSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `style pack "${slug}" is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).slice(0, 5).join("; ")}`,
    );
  }
  return { style: parsed.data, dir };
}

export interface RawProbeResult {
  outputDir: string;
  plan: RawEditPlan;
  style: StylePackT;
}

/** Process 2B · Rule 1 — probe the user's own footage and derive an edit plan. */
export async function rawProbe(videoInput: string, slug: string, outDirInput: string): Promise<RawProbeResult> {
  const video = path.resolve(videoInput);
  await fs.access(video).catch(() => {
    throw new Error(`raw video not found: ${video}`);
  });
  const { style } = await loadStylePack(slug);
  const outDir = path.resolve(outDirInput);
  await fs.rm(outDir, { recursive: true, force: true });
  await ensureDir(outDir);

  const probe = await probeReference(video, outDir);
  const silenceMinDur = Math.max(0.08, style.pacing.silenceTrimMs / 1000);
  const silences = await detectSilences(video, silenceMinDur);

  const trimSec = style.pacing.silenceTrimMs / 1000;
  const removedIntervals = mergeIntervals(
    silences.map((s) => ({
      startSec: Math.max(0, s.startSec - trimSec),
      endSec: Math.min(probe.durationSec, s.endSec + trimSec),
    })),
  );

  const keepRaw: { startSec: number; endSec: number }[] = [];
  let cursor = 0;
  for (const interval of removedIntervals) {
    if (interval.startSec > cursor) keepRaw.push({ startSec: cursor, endSec: interval.startSec });
    cursor = Math.max(cursor, interval.endSec);
  }
  if (cursor < probe.durationSec) keepRaw.push({ startSec: cursor, endSec: probe.durationSec });
  const keepSegments: RawKeepSegment[] = keepRaw
    .filter((segment) => segment.endSec - segment.startSec >= 0.25)
    .map((segment) => ({
      startSec: round(segment.startSec, 3),
      endSec: round(segment.endSec, 3),
      durationSec: round(segment.endSec - segment.startSec, 3),
    }));

  const bodyAslTarget = medianOfPair(style.pacing.bodyAslSec as [number, number]);
  const maxHold = style.pacing.maxStaticHoldSec;

  // Punch-ins whenever a keep segment would otherwise hold longer than the style allows.
  const punchInPoints: { atSec: number; scale: number }[] = [];
  const punchScale = round((style.motion.punchInScaleRange[0] as number) + 0.02, 3);
  for (const segment of keepSegments) {
    if (segment.startSec < style.pacing.hookWindowSec) continue;
    let at = segment.startSec + Math.min(0.4, segment.durationSec / 3);
    while (at < segment.endSec - 0.2) {
      punchInPoints.push({ atSec: round(at, 3), scale: Math.min(style.motion.punchInScaleRange[1] as number, punchScale + 0.01) });
      at += maxHold * 0.9;
    }
  }

  const brollCutaways: { atSec: number; durationSec: number }[] = [];
  for (const segment of keepSegments) {
    if (segment.durationSec > Math.max(2.4, (style.pacing.bodyAslSec[1] as number) * 2.2)) {
      brollCutaways.push({ atSec: round(segment.startSec + segment.durationSec / 2, 3), durationSec: bodyAslTarget });
    }
  }

  const captionWindows: { startSec: number; endSec: number; maxWords: number }[] = [];
  const captionStep = Math.max(0.6, bodyAslTarget);
  for (const segment of keepSegments) {
    let at = segment.startSec;
    while (at < segment.endSec - 0.15) {
      const end = Math.min(segment.endSec, at + captionStep);
      captionWindows.push({
        startSec: round(at, 3),
        endSec: round(end, 3),
        maxWords: style.typography.captionChunkWords[1] as number,
      });
      at = end;
    }
  }

  const chapterResetsSec: number[] = [];
  for (let t = style.narrative.chapterResetIntervalSec; t < probe.durationSec; t += style.narrative.chapterResetIntervalSec) {
    chapterResetsSec.push(round(t, 3));
  }

  const plan: RawEditPlan = {
    generatedAt: new Date().toISOString(),
    source: video,
    styleSlug: slug,
    durationSec: probe.durationSec,
    fps: probe.fps.numeric,
    silenceThresholdDb: -35,
    silenceTrimMs: style.pacing.silenceTrimMs,
    silences,
    removedIntervals: removedIntervals.map((i) => ({
      startSec: round(i.startSec, 3),
      endSec: round(i.endSec, 3),
      durationSec: round(i.endSec - i.startSec, 3),
    })),
    keepSegments,
    removedDurationSec: round(removedIntervals.reduce((acc, i) => acc + (i.endSec - i.startSec), 0), 3),
    pacing: {
      hookEndSec: Math.min(probe.durationSec, style.pacing.hookWindowSec),
      chapterResetsSec,
      targetBodyAslSec: bodyAslTarget,
      maxStaticHoldSec: maxHold,
      punchInPoints,
      brollCutaways,
      captionWindows,
    },
    beatsSec: probe.onsetsSec,
  };

  await writeJsonAtomic(path.join(outDir, "raw-edit-plan.json"), plan);
  return { outputDir: outDir, plan, style };
}
