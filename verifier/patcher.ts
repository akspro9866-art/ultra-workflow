import { promises as fs } from "node:fs";
import path from "node:path";
import { PatchSpec, SceneSpec, type SceneSpecT } from "../core/schema.js";
import { loadProjectFile, validateProjectSemantics } from "../core/project.js";
import { cacheDir, cacheKeyForScene, chooseEngine } from "../core/orchestrator.js";
import { detectRenderTier } from "../core/env.js";
import { pathExists, readJson, writeJsonAtomic } from "../core/util.js";

export interface PatchApplyResult {
  applied: { sceneId: string; invalidated: string[] }[];
  warnings: string[];
  nextCommand: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Surgical JSON patch: merges into specific scenes, re-validates the merged
 * scene, invalidates ONLY that scene's cache entries, and reports the exact
 * next command to run.
 */
export async function applyPatch(
  projectFile: string,
  patchFile: string,
  workspace: string,
): Promise<PatchApplyResult> {
  const project = await loadProjectFile(projectFile);
  const patch = PatchSpec.parse(await readJson(patchFile));
  const warnings: string[] = [];
  const applied: { sceneId: string; invalidated: string[] }[] = [];
  const tierInfo = await detectRenderTier();

  for (const entry of patch.patches) {
    const index = project.scenes.findIndex((s) => s.id === entry.sceneId);
    if (index === -1) throw new Error(`patch targets unknown scene "${entry.sceneId}"`);
    const scene = project.scenes[index] as SceneSpecT;
    if (entry.changes["id"] !== undefined && entry.changes["id"] !== scene.id) {
      throw new Error(`patch for "${scene.id}" cannot rename the scene id`);
    }

    let resolvedEngine = tierInfo.tier !== "full-cdp" ? "py-canvas" : "hyperframes";
    if (tierInfo.tier === "full-cdp") {
      try {
        const choice = await chooseEngine(scene, false);
        resolvedEngine = choice.fallback ? "hyperframes" : choice.engine.key;
      } catch (err) {
        warnings.push(`could not resolve engine for cache invalidation: ${(err as Error).message}`);
      }
    }
    const oldKey = await cacheKeyForScene(project, scene, workspace, resolvedEngine);
    const invalidated: string[] = [];
    for (const ext of [".mp4", ".mov"]) {
      const cacheFile = path.join(cacheDir(), `${oldKey}${ext}`);
      if (await pathExists(cacheFile)) {
        await fs.rm(cacheFile, { force: true });
        invalidated.push(cacheFile);
      }
    }

    const merged: Record<string, unknown> = { ...scene };
    for (const [key, value] of Object.entries(entry.changes)) {
      if (key === "id") continue;
      const current = merged[key];
      if (isPlainObject(value) && isPlainObject(current)) {
        merged[key] = { ...current, ...value };
      } else {
        merged[key] = value;
      }
    }
    const parsed = SceneSpec.safeParse(merged);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(scene)"}: ${i.message}`);
      throw new Error(`patch for "${scene.id}" produces an invalid scene:\n- ${issues.join("\n- ")}`);
    }
    project.scenes[index] = parsed.data;
    applied.push({ sceneId: entry.sceneId, invalidated });
  }

  const semanticErrors = validateProjectSemantics(project);
  if (semanticErrors.length > 0) {
    throw new Error(`patched project fails validation:\n- ${semanticErrors.join("\n- ")}`);
  }

  await writeJsonAtomic(projectFile, project);
  return {
    applied,
    warnings,
    nextCommand: `ultra build && ultra verify "${project.meta.sourceVideoPath}"`,
  };
}
