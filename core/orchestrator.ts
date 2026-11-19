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
import { ensureDir, pathExists, round, sha1, sha1File, writeJsonAtomic } from "./util.js";

export const CACHE_VERSION = 4;

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

  const payload = {
    version: CACHE_VERSION,
    resolvedEngine,
    scene,
    designTokens: project.designTokens,
    colorGrade: project.colorGrade,
    meta: { fps: project.meta.fps, width: project.meta.width, height: project.meta.height },
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
}

export function cacheDir(): string {
  return path.join(process.cwd(), ".ultra-cache", "renders");
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

  for (const scene of ordered) {
    const durationSec = round(sceneRenderDuration(project, scene), 6);
    const choice = await routeScene(scene, Boolean(options.strictEngine), tier);
    const resolvedKey: EngineKey = choice.fallback ? (choice.engine.key as EngineKey) : (choice.engine.key as EngineKey);
    const key = await cacheKeyForScene(project, scene, workspace, resolvedKey);
    const ext = scene.alpha ? ".mov" : ".mp4";
    const cacheFile = path.join(cache, `${key}${ext}`);
    const notes: string[] = choice.reason ? [choice.reason] : [];
    let engineUsed: EngineKey = resolvedKey;
    let fallback = choice.fallback;
    const cached = await pathExists(cacheFile);
    let sceneFile = cacheFile;

    if (cached) {
      hits += 1;
    } else {
      misses += 1;
      const ctx = {
        project,
        scene,
        workspace,
        buildDir,
        outFile: cacheFile,
        durationSec,
        fps: project.meta.fps,
        width: project.meta.width,
        height: project.meta.height,
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
        const fallbackKey = await cacheKeyForScene(project, scene, workspace, "hyperframes");
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

    built.push({
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
      notes,
    });
  }

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
    width: project.meta.width,
    height: project.meta.height,
    durationSec: project.meta.durationSec,
    draftFile,
    scenes: built,
    stitch,
    cache: { hits, misses },
  };
  await writeJsonAtomic(path.join(buildDir, "build-manifest.json"), manifest);
  return manifest;
}

export interface LintSceneResult {
  sceneId: string;
  defects: LintDefectT[];
  pass: boolean;
}

export async function lintProject(options: BuildOptions): Promise<{
  scenes: LintSceneResult[];
  defectCount: number;
  criticalDefectCount: number;
  pass: boolean;
}> {
  const { project, workspace, buildDir } = options;
  const results: LintSceneResult[] = [];
  const tierInfo = await detectRenderTier();
  const tier = tierInfo.tier;
  for (const scene of [...project.scenes].sort((a, b) => a.startSec - b.startSec)) {
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
