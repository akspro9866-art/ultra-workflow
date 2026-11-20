import { promises as fs } from "node:fs";
import path from "node:path";
import type { UltraProjectT, VerifyReportT } from "../core/schema.js";
import { discoverFonts } from "../core/env.js";
import { runBinary } from "../core/ffmpeg.js";
import { pathExists, round } from "../core/util.js";

/**
 * [27] Honest verify sections: asset similarity + font availability are scored
 * and reported; easing curve error is measured per scene; everything the gate
 * did NOT verify is listed in `notChecked` (report + CLI).
 */

export type AssetSimilaritySection = NonNullable<VerifyReportT["assetSimilarity"]>;
export type FontCheckSection = NonNullable<VerifyReportT["fontCheck"]>;
export type EasingSection = NonNullable<VerifyReportT["easing"]>;

export async function buildAssetSimilaritySection(project: UltraProjectT, workspace: string): Promise<AssetSimilaritySection | undefined> {
  const manifestFile = path.join(workspace, "assets.manifest.json");
  if (!(await pathExists(manifestFile))) return undefined;
  try {
    const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8")) as {
      assets?: Record<string, { similarity?: { sceneId?: string; ssimToRefSegment?: number | null; histogramDistance?: number | null; edgeDensityRatio?: number | null; warnings?: string[] } | null }>;
    };
    const section: AssetSimilaritySection = [];
    for (const [assetId, check] of Object.entries(manifest.assets ?? {})) {
      const similarity = check.similarity;
      if (!similarity) continue;
      const ssim = similarity.ssimToRefSegment ?? null;
      const histogram = similarity.histogramDistance ?? null;
      const edge = similarity.edgeDensityRatio ?? null;
      const edgeCloseness = edge === null ? 0.5 : Math.max(0, 1 - Math.min(1, Math.abs(1 - edge) / 0.5));
      const score =
        ssim === null && histogram === null
          ? null
          : round(Math.max(0, Math.min(100, (ssim ?? 0.5) * 60 + (1 - (histogram ?? 0.5)) * 25 + edgeCloseness * 15)), 1);
      section.push({
        assetId,
        sceneId: similarity.sceneId ?? null,
        ssim,
        histogramDistance: histogram,
        edgeDensityRatio: edge,
        warnings: similarity.warnings ?? [],
        score,
      });
    }
    return section;
  } catch {
    return undefined;
  }
}

/** [27a]/[14] Font availability score: every font a text element resolves to must be discoverable. */
export async function buildFontCheckSection(project: UltraProjectT, workspace: string): Promise<FontCheckSection> {
  const used = new Set<string>();
  for (const scene of project.scenes) {
    for (const text of scene.textElements) {
      const font = text.font as unknown;
      if (typeof font === "string") {
        const mapped = (project.designTokens.fonts as Record<string, string>)[font] ?? font;
        used.add(mapped);
      } else if (font && typeof font === "object" && typeof (font as { family?: string }).family === "string") {
        used.add((font as { family: string }).family);
      }
    }
    if (scene.customHtmlFile || scene.customCode) {
      // Custom scenes inline their own font-family declarations; only note the tokens.
      used.add(project.designTokens.fonts.heading);
    }
  }
  const fonts = await discoverFonts(workspace).catch(() => null);
  const available = new Set<string>();
  if (fonts) {
    for (const bundled of fonts.bundled) available.add(bundled.family.toLowerCase());
    for (const file of [fonts.regular, fonts.bold, fonts.mono]) {
      if (!file) continue;
      available.add(path.basename(file).replace(/\.(ttf|otf)$/i, "").toLowerCase());
    }
    available.add("ultra display");
    available.add("ultra sans");
    available.add("ultra mono");
    for (const font of [project.designTokens.fonts.heading, project.designTokens.fonts.body, project.designTokens.fonts.mono]) {
      available.add(font.toLowerCase());
    }
    const workspaceFonts = path.join(workspace, "assets", "fonts");
    try {
      for (const entry of await fs.readdir(workspaceFonts)) {
        if (/\.(ttf|otf)$/i.test(entry)) available.add(entry.replace(/\.(ttf|otf)$/i, "").toLowerCase());
      }
    } catch {
      // no workspace overrides
    }
  }
  const fontsUsed = [...used];
  const unavailableFonts = fontsUsed.filter((font) => !available.has(font.toLowerCase()));
  const score = fontsUsed.length === 0 ? 100 : round((100 * (fontsUsed.length - unavailableFonts.length)) / fontsUsed.length, 1);
  return { fontsUsed, unavailableFonts, score };
}

/** Decode a video slice to tiny grayscale frames (96x54) for motion curve analysis. */
async function motionCurves(file: string, startSec: number, durationSec: number, fps: number): Promise<{ points: { x: number; y: number }[]; energy: number } | null> {
  const w = 96;
  const h = 54;
  try {
    const result = await runBinary("ffmpeg", [
      "-v",
      "error",
      "-ss",
      Math.max(0, startSec).toFixed(3),
      "-t",
      Math.max(0.1, durationSec).toFixed(3),
      "-i",
      file,
      "-vf",
      `fps=${fps},scale=${w}:${h}:flags=area,format=gray`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ]);
    const frameBytes = w * h;
    const frameCount = Math.floor(result.stdout.length / frameBytes);
    if (frameCount < 3) return null;
    const points: { x: number; y: number }[] = [];
    let totalEnergy = 0;
    for (let f = 1; f < frameCount; f += 1) {
      let sum = 0;
      let sx = 0;
      let sy = 0;
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const index = f * frameBytes + y * w + x;
          const diff = Math.abs((result.stdout[index] as number) - (result.stdout[index - frameBytes] as number));
          if (diff < 6) continue;
          sum += diff;
          sx += diff * x;
          sy += diff * y;
        }
      }
      totalEnergy += sum;
      points.push(sum > 0 ? { x: sx / sum, y: sy / sum } : { x: NaN, y: NaN });
    }
    if (totalEnergy / Math.max(1, frameCount) < 40) return null;
    return { points, energy: totalEnergy };
  } catch {
    return null;
  }
}

/**
 * [27b] Compare draft vs reference per-frame motion centroids (scene-local).
 * curveError = mean absolute position error in pixels of the dominant moving
 * element. If <3 comparable moving frames exist, the scene is reported as
 * unmeasurable instead of pretending.
 */
export async function measureEasingCurves(
  reference: string,
  draft: string,
  project: UltraProjectT,
): Promise<EasingSection> {
  const section: EasingSection = [];
  const fps = project.meta.fps;
  const scenes = project.scenes.filter((s) => !s.overlayOfSceneId).sort((a, b) => a.startSec - b.startSec);
  for (const scene of scenes) {
    const durationSec = scene.endSec - scene.startSec;
    if (durationSec < 0.4) {
      section.push({ sceneId: scene.id, curveError: null, samples: 0, note: "scene shorter than 0.4s" });
      continue;
    }
    const refCurve = await motionCurves(reference, scene.startSec, durationSec, fps);
    const draftCurve = await motionCurves(draft, scene.startSec, durationSec, fps);
    if (!refCurve || !draftCurve) {
      section.push({ sceneId: scene.id, curveError: null, samples: 0, note: "no measurable dominant motion" });
      continue;
    }
    const count = Math.min(refCurve.points.length, draftCurve.points.length);
    let sum = 0;
    let samples = 0;
    for (let i = 0; i < count; i += 1) {
      const r = refCurve.points[i] as { x: number; y: number };
      const d = draftCurve.points[i] as { x: number; y: number };
      if (!Number.isFinite(r.x) || !Number.isFinite(d.x)) continue;
      const dx = (r.x - d.x) * (project.meta.width / 96);
      const dy = (r.y - d.y) * (project.meta.height / 54);
      sum += Math.sqrt(dx * dx + dy * dy);
      samples += 1;
    }
    section.push({
      sceneId: scene.id,
      curveError: samples >= 3 ? round(sum / samples, 2) : null,
      samples,
      ...(samples < 3 ? { note: "fewer than 3 comparable moving frames" } : {}),
    });
  }
  return section;
}

/** [27c] Everything this gate did NOT verify. */
export function buildNotCheckedList(opts: {
  hasAudio: boolean;
  hasFullAudit: boolean;
  hasReference: boolean;
  fontMatched: boolean;
}): string[] {
  const list = [
    "photo/composition semantics beyond SSIM + colour histogram + edge density",
    "font identity beyond availability (run `ultra font-match <image.png>` for candidates)",
    "easing feel beyond measurable motion-curve error (unmeasurable scenes are listed null)",
    "SFX timbre and recording-vs-synthesis similarity",
    "subjective taste and originality (the 100-pt rubric is agent/human judgment)",
    "plate-replay crops beyond SHA-1 + 8x8 aHash comparison (guard)",
  ];
  if (!opts.hasFullAudit) list.push("per-frame SSIM (run `ultra verify --full` to claim a match)");
  if (!opts.hasAudio) list.push("audio sync (draft has no audio stream)");
  if (!opts.hasReference) list.push("reference comparison (style verification has no reference video)");
  if (!opts.fontMatched) list.push("font candidate ranking (no font-match run for this project)");
  return list;
}
