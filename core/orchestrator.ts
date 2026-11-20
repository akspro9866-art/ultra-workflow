import { promises as fs } from "node:fs";
import path from "node:path";
import type { LintDefectT, SceneSpecT, UltraProjectT } from "./schema.js";
import type { EngineKey, SceneEngine } from "../engines/types.js";
import { hyperframesEngine } from "../engines/hyperframes/index.js";
import { remotionEngine } from "../engines/remotion/index.js";
import { revideoEngine } from "../engines/revideo/index.js";
import { blenderEngine } from "../engines/blender/index.js";
import { pyCanvasEngine } from "../engines/py-canvas/index.js";
import { ffmpegOnlyEngine } from "../engines/ffmpeg-only/index.js";
import { detectRenderTier, type RenderTier } from "./env.js";
import { sceneRenderDuration } from "./project.js";
import { stitchTimeline, type StitchClip, type StitchResult } from "./stitcher.js";
import { resolveAssetPath } from "./assets.js";
import { ensureDir, pathExists, readJson, rmrf, round, sha1, sha1File, writeJsonAtomic } from "./util.js";
import { ffmpegOk } from "./ffmpeg.js";
import { renderDraftContactSheet } from "./contact-sheet.js";

export const CACHE_VERSION = 5;

export const ENGINES: Record<EngineKey, SceneEngine> = {
  hyperframes: hyperframesEngine,
  remotion: remotionEngine,
  revideo: revideoEngine,
  blender: blenderEngine,
  "py-canvas": pyCanvasEngine,
  "ffmpeg-only": ffmpegOnlyEngine,
};

export interface EngineChoice {
  engine: SceneEngine;
  fallback: boolean;
  reason?: string;
  browserless?: boolean;
  tierFallback?: "browserless-py" | "ffmpeg-only";
}

/**
 * Route a scene by host tier:
 *  - full-cdp      → normal CDP engines (HyperFrames/Remotion/Revideo/Blender)
 *  - browserless-py→ py-canvas (Pillow → raw frames → FFmpeg)
 *  - ffmpeg-only   → pure FFmpeg drawtext/drawbox/zoompan renderer
 */
export async function routeScene(scene: SceneSpecT, strictEngine: boolean, tier: RenderTier): Promise<EngineChoice> {
  if (tier === "browserless-py" || tier === "ffmpeg-only") {
    if (scene.customHtmlFile || scene.customCode) {
      throw new Error(
        `Scene "${scene.id}" uses custom HTML/code which requires a Chromium browser (full-cdp). ` +
          "Remove the custom scene or run where Chromium/Chrome/Edge is available.",
      );
    }
    if (tier === "ffmpeg-only") {
      return {
        engine: ffmpegOnlyEngine,
        fallback: true,
        tierFallback: "ffmpeg-only",
        reason: `ffmpeg-only · ${scene.engine} rendered by the pure FFmpeg fallback`,
      };
    }
    return {
      engine: pyCanvasEngine,
      fallback: true,
      browserless: true,
      tierFallback: "browserless-py",
      reason: `browserless-py · ${scene.engine} rendered by py-canvas`,
    };
  }
  return chooseEngine(scene, strictEngine);
}

export async function chooseEngine(scene: SceneSpecT, strictEngine: boolean): Promise<EngineChoice> {
  const engine = ENGINES[scene.engine];
  if (await engine.isAvailable()) return { engine, fallback: false };
  if (scene.engine === "hyperframes") {
    throw new Error("HyperFrames requires a Chromium-compatible browser; run `ultra doctor` for details.");
  }
  if (strictEngine) {
    throw new Error(`--strict-engine: engine "${scene.engine}" is unavailable in this environment`);
  }
  return {
    engine: hyperframesEngine,
    fallback: true,
    reason: `${scene.engine} engine unavailable in this environment — scene compiled with HyperFrames fallback`,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function safeSceneId(id: string): string {
  return id.replace(/[^\w.-]/g, "_");
}

/** SHA-1 cache key covering scene JSON, design tokens, grade, fps/size and referenced asset bytes. */
export async function cacheKeyForScene(
  project: UltraProjectT,
  scene: SceneSpecT,
  workspace: string,
  resolvedEngine: string,
  renderDims?: { width: number; height: number },
): Promise<string> {
  const assetIds = new Set<string>();
  for (const layer of scene.layers) if (layer.assetId) assetIds.add(layer.assetId);
  const graphId = scene.enginePayload["sceneGraphAssetId"];
  if (typeof graphId === "string") assetIds.add(graphId);

  const assetHashes: Record<string, string> = {};
  for (const id of [...assetIds].sort()) {
    const asset = project.assets.find((a) => a.id === id);
    if (!asset) {
      assetHashes[id] = "missing";
      continue;
    }
    const file = resolveAssetPath(workspace, asset);
    assetHashes[id] = (await pathExists(file)) ? await sha1File(file) : "missing";
  }

  // Custom scene HTML lives outside ultra.json: hash the file contents so an
  // edit without a JSON change still invalidates this scene (and only this one).
  let customHtmlFileSha1 = "none";
  if (scene.customHtmlFile) {
    const file = path.resolve(workspace, "scenes", scene.customHtmlFile);
    customHtmlFileSha1 = (await pathExists(file)) ? await sha1File(file) : "missing";
  }

  const payload = {
    version: CACHE_VERSION,
    resolvedEngine,
    scene,
    customHtmlFileSha1,
    designTokens: project.designTokens,
    colorGrade: project.colorGrade,
    meta: {
      fps: project.meta.fps,
      width: project.meta.width,
      height: project.meta.height,
      renderWidth: renderDims?.width ?? project.meta.width,
      renderHeight: renderDims?.height ?? project.meta.height,
    },
    renderDuration: round(sceneRenderDuration(project, scene), 6),
    assets: assetHashes,
  };
  return sha1(stableStringify(payload));
}

export interface BuiltScene extends StitchClip {
  alpha: boolean;
  overlayOfSceneId?: string;
  requestedEngine: EngineKey;
  engineUsed: EngineKey;
  fallback: boolean;
  fallbackReason?: string;
  browserless?: boolean;
  cached: boolean;
  notes: string[];
}

export interface BuildManifest {
  builtAt: string;
  version: number;
  fps: number;
  width: number;
  height: number;
  durationSec: number;
  draftFile: string;
  scenes: BuiltScene[];
  stitch: StitchResult;
  cache: { hits: number; misses: number };
}

export interface BuildOptions {
  project: UltraProjectT;
  workspace: string;
  buildDir: string;
  strictEngine?: boolean;
  renderWidth?: number;
  renderHeight?: number;
}

export function cacheDir(): string {
  return path.join(process.cwd(), ".ultra-cache", "renders");
}

/** Render/cache exactly one scene (shared by build, build --scene and preview). */
export async function renderSceneClip(
  options: BuildOptions,
  scene: SceneSpecT,
  tier: RenderTier,
  renderWidth: number,
  renderHeight: number,
  counters: { hits: number; misses: number },
): Promise<BuiltScene> {
  const { project, workspace, buildDir } = options;
  const cache = cacheDir();
  await ensureDir(cache);
  await ensureDir(path.join(buildDir, "scenes"));
  const durationSec = round(sceneRenderDuration(project, scene), 6);
  const choice = await routeScene(scene, Boolean(options.strictEngine), tier);
  const resolvedKey: EngineKey = choice.engine.key as EngineKey;
  const key = await cacheKeyForScene(project, scene, workspace, resolvedKey, { width: renderWidth, height: renderHeight });
  const ext = scene.alpha ? ".mov" : ".mp4";
  const cacheFile = path.join(cache, `${key}${ext}`);
  const notes: string[] = choice.reason ? [choice.reason] : [];
  let engineUsed: EngineKey = resolvedKey;
  let fallback = choice.fallback;
  const cached = await pathExists(cacheFile);
  let sceneFile = cacheFile;

  if (cached) {
    counters.hits += 1;
  } else {
    counters.misses += 1;
    const ctx = {
      project,
      scene,
      workspace,
      buildDir,
      outFile: cacheFile,
      durationSec,
      fps: project.meta.fps,
      width: renderWidth,
      height: renderHeight,
      alpha: scene.alpha,
    };
    try {
      const outcome = await choice.engine.renderScene(ctx);
      engineUsed = outcome.engineUsed;
      notes.push(...outcome.notes);
    } catch (err) {
      if (options.strictEngine || resolvedKey === "hyperframes" || resolvedKey === "py-canvas" || resolvedKey === "ffmpeg-only") {
        throw err;
      }
      // Render-time failure: store under the HyperFrames key so a later working
      // native engine is not masked by a stale fallback entry.
      const fallbackKey = await cacheKeyForScene(project, scene, workspace, "hyperframes", { width: renderWidth, height: renderHeight });
      const fallbackFile = path.join(cache, `${fallbackKey}${ext}`);
      notes.push(`${resolvedKey} render failed (${(err as Error).message.split("\n")[0]}); using HyperFrames fallback`);
      const outcome = await hyperframesEngine.renderScene({ ...ctx, outFile: fallbackFile });
      engineUsed = outcome.engineUsed;
      fallback = true;
      sceneFile = fallbackFile;
      notes.push(...outcome.notes);
    }
  }

  const sceneCopy = path.join(buildDir, "scenes", `${safeSceneId(scene.id)}${ext}`);
  await fs.copyFile(sceneFile, sceneCopy);

  // [11] Honest motion-blur warning using the probe's measured motion energy.
  const notesExtra: string[] = [];
  if ((scene.motionBlurSamples ?? 1) === 1) {
    try {
      const probe = await readJson<{ scenes?: { startSec?: number; motionScore?: number }[] }>(path.join(workspace, "probe.json"));
      const match = (probe.scenes ?? []).find((entry) => Math.abs(Number(entry.startSec ?? -99) - scene.startSec) < 0.2);
      if (match && Number(match.motionScore ?? 0) > 2.5) {
        const warning = `build: scene "${scene.id}" has fast motion (probe motionScore ${match.motionScore}) rendered without motion blur — raise motionBlurSamples`;
        console.warn(warning);
        notesExtra.push(warning);
      }
    } catch {
      // no probe measurement available
    }
  }
  if (resolvedKey === "ffmpeg-only") {
    if ((scene.guides ?? []).length > 0 || scene.layers.some((layer) => layer.anchor) || scene.textElements.some((text) => text.anchor)) {
      notesExtra.push("ffmpeg-only ignores guides/anchors (logged warning)");
    }
    if (scene.layers.some((layer) => layer.mask) || scene.textElements.some((text) => text.mask) || scene.clipReveal?.mask) {
      notesExtra.push("ffmpeg-only does not support masks (rect/circle without feather are also unsupported in this tier)");
    }
  }

  return {
    sceneId: scene.id,
    file: sceneFile,
    startSec: scene.startSec,
    endSec: scene.endSec,
    durationSec,
    alpha: scene.alpha,
    ...(scene.overlayOfSceneId ? { overlayOfSceneId: scene.overlayOfSceneId } : {}),
    requestedEngine: scene.engine,
    engineUsed,
    fallback,
    ...(choice.tierFallback
      ? { fallbackReason: choice.tierFallback, browserless: choice.tierFallback === "browserless-py" }
      : {}),
    cached,
    notes: [...notes, ...notesExtra],
  };
}

export async function buildProject(options: BuildOptions): Promise<BuildManifest> {
  const { project, workspace, buildDir } = options;
  const cache = cacheDir();
  await ensureDir(cache);
  await ensureDir(path.join(buildDir, "scenes"));

  const ordered = [...project.scenes].sort((a, b) => {
    const aOverlay = a.overlayOfSceneId ? 1 : 0;
    const bOverlay = b.overlayOfSceneId ? 1 : 0;
    if (aOverlay !== bOverlay) return aOverlay - bOverlay;
    return a.startSec - b.startSec;
  });

  const built: BuiltScene[] = [];
  let hits = 0;
  let misses = 0;
  const tierInfo = await detectRenderTier();
  const tier = tierInfo.tier;
  const renderWidth = options.renderWidth ?? project.meta.width;
  const renderHeight = options.renderHeight ?? project.meta.height;
  const counters = { hits: 0, misses: 0 };

  for (const scene of ordered) {
    built.push(await renderSceneClip(options, scene, tier, renderWidth, renderHeight, counters));
  }
  hits += counters.hits;
  misses += counters.misses;

  const draftFile = path.join(buildDir, "draft.mp4");
  const stitch = await stitchTimeline({
    project,
    workspace,
    buildDir,
    clips: built.map((b) => ({
      sceneId: b.sceneId,
      file: b.file,
      startSec: b.startSec,
      endSec: b.endSec,
      durationSec: b.durationSec,
    })),
    outFile: draftFile,
  });

  const manifest: BuildManifest = {
    builtAt: new Date().toISOString(),
    version: CACHE_VERSION,
    fps: project.meta.fps,
    width: renderWidth,
    height: renderHeight,
    durationSec: project.meta.durationSec,
    draftFile,
    scenes: built,
    stitch,
    cache: { hits, misses },
  };
  await writeJsonAtomic(path.join(buildDir, "build-manifest.json"), manifest);
  // [22] Always-on contact sheet: every build regenerates it from the draft.
  try {
    await renderDraftContactSheet({
      video: draftFile,
      outFile: path.join(buildDir, "contact-sheet.png"),
      title: "ULTRA · draft contact sheet",
      durationSec: project.meta.durationSec,
    });
  } catch (err) {
    console.warn(`build: contact sheet generation failed (${(err as Error).message.split("\n")[0]})`);
  }
  return manifest;
}

/* ============================================================================
 * [21] Single-scene build: render ONE scene (+ cache) and stitch a preview MP4
 * with 1s handles either side taken from the existing full draft when present.
 * ========================================================================== */

export interface ScenePreviewResult {
  sceneId: string;
  previewFile: string;
  manifestFile: string;
  clip: BuiltScene;
  cache: { hits: number; misses: number };
}

export async function buildScenePreview(options: BuildOptions & { sceneId: string }): Promise<ScenePreviewResult> {
  const { project, buildDir } = options;
  const scene = project.scenes.find((s) => s.id === options.sceneId);
  if (!scene) throw new Error(`build --scene: unknown scene "${options.sceneId}"`);
  const tier = (await detectRenderTier()).tier;
  const renderWidth = options.renderWidth ?? project.meta.width;
  const renderHeight = options.renderHeight ?? project.meta.height;
  const counters = { hits: 0, misses: 0 };
  const clip = await renderSceneClip(options, scene, tier, renderWidth, renderHeight, counters);

  const sceneDur = round(scene.endSec - scene.startSec, 3);
  const draft = path.join(buildDir, "draft.mp4");
  const hasDraft = await pathExists(draft);
  const parts: { file: string; ss: number; duration: number; label: string }[] = [];
  if (hasDraft && scene.startSec > 0.05) {
    const start = Math.max(0, scene.startSec - 1);
    parts.push({ file: draft, ss: start, duration: round(scene.startSec - start, 3), label: "before" });
  }
  parts.push({ file: clip.file, ss: 0, duration: sceneDur, label: "scene" });
  if (hasDraft && scene.endSec < project.meta.durationSec - 0.05) {
    const duration = round(Math.min(1, project.meta.durationSec - scene.endSec), 3);
    if (duration > 0.02) parts.push({ file: draft, ss: scene.endSec, duration, label: "after" });
  }

  const tmp = path.join(buildDir, "tmp", `preview-${safeSceneId(scene.id)}`);
  await rmrf(tmp);
  await ensureDir(tmp);
  const normalized: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] as { file: string; ss: number; duration: number; label: string };
    const out = path.join(tmp, `part_${i}.mp4`);
    await ffmpegOk(
      [
        "-ss",
        part.ss.toFixed(3),
        "-i",
        part.file,
        "-t",
        Math.max(0.02, part.duration).toFixed(3),
        "-r",
        String(project.meta.fps),
        "-fps_mode",
        "cfr",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "16",
        "-pix_fmt",
        "yuv420p",
        out,
      ],
      { timeoutMs: 15 * 60_000 },
    );
    normalized.push(out);
  }
  const listFile = path.join(tmp, "list.txt");
  await fs.writeFile(listFile, normalized.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
  const previewFile = path.join(buildDir, `scene-${safeSceneId(scene.id)}-preview.mp4`);
  await ffmpegOk(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", previewFile], {
    timeoutMs: 15 * 60_000,
  });
  await rmrf(tmp);

  // [19]-style per-scene manifest: proves the other scenes were NOT rendered.
  const manifestFile = path.join(buildDir, `scene-${safeSceneId(scene.id)}-manifest.json`);
  const totalDuration = round(parts.reduce((acc, part) => acc + part.duration, 0), 3);
  await writeJsonAtomic(manifestFile, {
    builtAt: new Date().toISOString(),
    sceneId: scene.id,
    renderedScenes: [scene.id],
    previewFile,
    durationSec: totalDuration,
    handles: parts.filter((p) => p.label !== "scene").map((p) => ({ side: p.label, durationSec: p.duration })),
    scene: clip,
    cache: counters,
  });

  try {
    await renderDraftContactSheet({
      video: previewFile,
      outFile: path.join(buildDir, "contact-sheet.png"),
      title: `ULTRA · scene ${scene.id}`,
      durationSec: totalDuration,
    });
  } catch (err) {
    console.warn(`build --scene: contact sheet generation failed (${(err as Error).message.split("\n")[0]})`);
  }

  return { sceneId: scene.id, previewFile, manifestFile, clip, cache: counters };
}

export interface LintSceneResult {
  sceneId: string;
  defects: LintDefectT[];
  pass: boolean;
}

export async function lintProject(options: BuildOptions & { onlySceneIds?: string[] }): Promise<{
  scenes: LintSceneResult[];
  defectCount: number;
  criticalDefectCount: number;
  pass: boolean;
}> {
  const { project, workspace, buildDir } = options;
  const results: LintSceneResult[] = [];
  const tierInfo = await detectRenderTier();
  const tier = tierInfo.tier;
  const only = options.onlySceneIds ? new Set(options.onlySceneIds) : null;
  const scenes = [...project.scenes]
    .filter((scene) => !only || only.has(scene.id))
    .sort((a, b) => a.startSec - b.startSec);
  for (const scene of scenes) {
    const choice = await routeScene(scene, Boolean(options.strictEngine), tier);
    const lint = await choice.engine.lint({
      project,
      scene,
      workspace,
      buildDir,
      fps: project.meta.fps,
      width: project.meta.width,
      height: project.meta.height,
    });
    results.push({ sceneId: scene.id, defects: lint.defects, pass: lint.pass });
  }
  const defects = results.flatMap((r) => r.defects);
  const criticalDefectCount = defects.filter((d) => d.critical).length;
  return {
    scenes: results,
    defectCount: defects.length,
    criticalDefectCount,
    pass: criticalDefectCount === 0,
  };
}
