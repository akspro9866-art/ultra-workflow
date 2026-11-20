import { promises as fs } from "node:fs";
import path from "node:path";
import type { UltraProjectT } from "./schema.js";
import { runBinary } from "./ffmpeg.js";
import { resolveSfxCueTimes } from "./stitcher.js";
import { pathExists, round } from "./util.js";
import type { ProbeResultT } from "./schema.js";

/**
 * [29] Audio-to-picture sync: cross-correlate draft vs reference RMS envelopes
 * (10 ms windows) and report audioSyncOffsetMs. Also flags SFX cues that land
 * > 80 ms away from the nearest probe onset/cut (warning, never a hard fail).
 */

const SAMPLE_RATE = 8000;
const WINDOW_SEC = 0.01;

/** RMS envelope at 10 ms resolution (normalized 0..1). */
export async function rmsEnvelope(file: string): Promise<number[] | null> {
  try {
    const result = await runBinary("ffmpeg", ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"]);
    if (result.code !== 0 || result.stdout.length < SAMPLE_RATE * 2 * 0.05) return null;
    const samples = Math.floor(result.stdout.length / 2);
    const windows: number[] = [];
    const perWindow = Math.round(SAMPLE_RATE * WINDOW_SEC);
    for (let start = 0; start + perWindow <= samples; start += perWindow) {
      let sum = 0;
      for (let s = start; s < start + perWindow; s += 1) {
        const value = (result.stdout.readInt16LE(s * 2) ?? 0) / 32768;
        sum += value * value;
      }
      windows.push(Math.sqrt(sum / perWindow));
    }
    const max = Math.max(1e-9, ...windows);
    return windows.map((v) => v / max);
  } catch {
    return null;
  }
}

export interface AudioSyncResult {
  offsetMs: number;
  correlation: number;
}

/**
 * Positive offsetMs = the draft audio is LATE by that many ms.
 * Coarse 10 ms windows; test tolerance ±40 ms.
 */
export async function measureAudioSync(
  referenceFile: string,
  draftFile: string,
  maxOffsetMs = 600,
): Promise<AudioSyncResult | null> {
  const ref = await rmsEnvelope(referenceFile);
  const draft = await rmsEnvelope(draftFile);
  if (!ref || !draft || ref.length < 20 || draft.length < 20) return null;
  const count = Math.min(ref.length, draft.length);
  const a = ref.slice(0, count);
  const b = draft.slice(0, count);
  const meanA = a.reduce((x, y) => x + y, 0) / a.length;
  const meanB = b.reduce((x, y) => x + y, 0) / b.length;
  const centeredA = a.map((v) => v - meanA);
  const centeredB = b.map((v) => v - meanB);
  const maxLag = Math.min(Math.round(maxOffsetMs / (WINDOW_SEC * 1000)), Math.floor(count / 3));
  let bestLag = 0;
  let best = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    let energyA = 0;
    let energyB = 0;
    for (let i = 0; i < count; i += 1) {
      const j = i + lag;
      if (j < 0 || j >= count) continue;
      const av = centeredA[i] as number;
      const bv = centeredB[j] as number;
      sum += av * bv;
      energyA += av * av;
      energyB += bv * bv;
    }
    const denom = Math.sqrt(energyA * energyB);
    const score = denom > 1e-9 ? sum / denom : -1;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  return { offsetMs: round(bestLag * WINDOW_SEC * 1000, 1), correlation: round(best, 4) };
}

export interface SfxWarning {
  assetId: string;
  atSec: number;
  nearestSec: number | null;
  distanceMs: number;
}

/** [29] Cue sanity vs measured probe onsets/cuts (>80 ms away = warning). */
export async function sfxSyncWarnings(project: UltraProjectT, workspace: string): Promise<SfxWarning[]> {
  const probeFile = path.join(workspace, "probe.json");
  if (!(await pathExists(probeFile))) return [];
  let anchors: number[] = [];
  try {
    const probe = JSON.parse(await fs.readFile(probeFile, "utf8")) as ProbeResultT;
    anchors = [...probe.onsetsSec, ...probe.cutsSec, ...(probe.softCutsSec ?? [])].sort((a, b) => a - b);
  } catch {
    return [];
  }
  if (anchors.length === 0) return [];
  const warnings: SfxWarning[] = [];
  for (const { cue, atSec } of resolveSfxCueTimes(project)) {
    let nearest: number | null = null;
    let distance = Infinity;
    for (const anchor of anchors) {
      const d = Math.abs(anchor - atSec);
      if (d < distance) {
        distance = d;
        nearest = anchor;
      }
    }
    if (nearest !== null && distance * 1000 > 80) {
      warnings.push({ assetId: cue.assetId, atSec, nearestSec: round(nearest, 3), distanceMs: round(distance * 1000, 1) });
    }
  }
  return warnings;
}
