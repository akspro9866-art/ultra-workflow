import { promises as fs } from "node:fs";
import path from "node:path";
import { UltraProject, type UltraProjectT, type SceneSpecT } from "./schema.js";

export class ProjectValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Project validation failed:\n- ${errors.join("\n- ")}`);
    this.name = "ProjectValidationError";
  }
}

export async function loadProjectFile(file: string): Promise<UltraProjectT> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read project file ${file}: ${(err as Error).message}`);
  }
  const parsed = UltraProject.safeParse(raw);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`);
    throw new ProjectValidationError(errors);
  }
  return parsed.data;
}

export async function loadProject(workspace: string): Promise<UltraProjectT> {
  return loadProjectFile(path.join(workspace, "ultra.json"));
}

/** Semantic validation beyond per-field Zod checks. Returns a list of human-readable errors. */
export function validateProjectSemantics(project: UltraProjectT): string[] {
  const errors: string[] = [];
  const sceneIds = new Set<string>();
  for (const scene of project.scenes) {
    if (sceneIds.has(scene.id)) errors.push(`duplicate scene id "${scene.id}"`);
    sceneIds.add(scene.id);
  }
  const assetIds = new Set<string>();
  for (const asset of project.assets) {
    if (assetIds.has(asset.id)) errors.push(`duplicate asset id "${asset.id}"`);
    assetIds.add(asset.id);
  }
  if (Object.keys(project.designTokens.palette).length === 0) {
    errors.push("designTokens.palette must define at least one color");
  }
  if (project.designTokens.antiSlopRules.length === 0) {
    errors.push("designTokens.antiSlopRules must contain at least one explicit anti-slop rule");
  }

  const mainScenes = project.scenes.filter((s) => !s.overlayOfSceneId).sort((a, b) => a.startSec - b.startSec);
  if (mainScenes.length === 0) {
    errors.push("project must contain at least one non-overlay scene");
  } else {
    const first = mainScenes[0] as SceneSpecT;
    const last = mainScenes[mainScenes.length - 1] as SceneSpecT;
    if (Math.abs(first.startSec) > 0.05) {
      errors.push(`timeline must start at 0s; first scene "${first.id}" starts at ${first.startSec}s`);
    }
    for (let i = 1; i < mainScenes.length; i += 1) {
      const prev = mainScenes[i - 1] as SceneSpecT;
      const cur = mainScenes[i] as SceneSpecT;
      if (Math.abs(cur.startSec - prev.endSec) > 0.06) {
        errors.push(
          `timeline gap/overlap between "${prev.id}" (ends ${prev.endSec}s) and "${cur.id}" (starts ${cur.startSec}s)`,
        );
      }
    }
    if (Math.abs(last.endSec - project.meta.durationSec) > 0.06) {
      errors.push(
        `last scene "${last.id}" ends at ${last.endSec}s but meta.durationSec is ${project.meta.durationSec}s`,
      );
    }
  }

  for (const scene of project.scenes) {
    const layerIds = new Set(scene.layers.map((l) => l.id));
    const textIds = new Set(scene.textElements.map((t) => t.id));
    for (const track of scene.keyframes) {
      if (!layerIds.has(track.target) && !textIds.has(track.target)) {
        errors.push(`scene "${scene.id}": keyframe target "${track.target}" does not match any layer or text element`);
      }
      for (const kf of track.keyframes) {
        if (kf.atSec > scene.endSec - scene.startSec + 0.001) {
          errors.push(
            `scene "${scene.id}": keyframe for "${track.target}.${track.property}" at ${kf.atSec}s exceeds scene length`,
          );
        }
      }
    }
    for (const layer of scene.layers) {
      if (layer.assetId && !assetIds.has(layer.assetId)) {
        errors.push(`scene "${scene.id}": layer "${layer.id}" references unknown asset "${layer.assetId}"`);
      }
    }
    if (scene.overlayOfSceneId) {
      const host = project.scenes.find((s) => s.id === scene.overlayOfSceneId);
      if (!host) {
        errors.push(`scene "${scene.id}": overlayOfSceneId "${scene.overlayOfSceneId}" does not exist`);
      } else if (host.overlayOfSceneId) {
        errors.push(`scene "${scene.id}": overlays must target a base scene, but "${host.id}" is itself an overlay`);
      }
      if (scene.transitionIn.type !== "none" && scene.transitionIn.durationSec > 0) {
        errors.push(`scene "${scene.id}": overlay scenes cannot declare a transitionIn`);
      }
    }
    if (scene.transitionIn.type !== "none") {
      const prev = [...mainScenes].reverse().find((s) => s.endSec <= scene.startSec + 0.001 && s.id !== scene.id);
      if (prev) {
        const prevLen = prev.endSec - prev.startSec;
        const curLen = scene.endSec - scene.startSec;
        if (scene.transitionIn.durationSec >= Math.min(prevLen, curLen)) {
          errors.push(
            `scene "${scene.id}": transition duration ${scene.transitionIn.durationSec}s must be shorter than both adjacent scenes`,
          );
        }
      }
    }
    if (scene.engine === "blender") {
      const payload = scene.enginePayload as Record<string, unknown>;
      const graphAssetId = payload["sceneGraphAssetId"];
      if (typeof graphAssetId !== "string") {
        errors.push(`scene "${scene.id}": blender scenes require enginePayload.sceneGraphAssetId`);
      } else {
        const asset = project.assets.find((a) => a.id === graphAssetId);
        if (!asset) errors.push(`scene "${scene.id}": unknown sceneGraphAssetId "${graphAssetId}"`);
        else if (asset.type !== "3d_graph") {
          errors.push(`scene "${scene.id}": sceneGraphAssetId "${graphAssetId}" must reference a 3d_graph asset`);
        }
      }
    }
    if (scene.engine === "remotion" || scene.engine === "revideo") {
      const payload = scene.enginePayload as Record<string, unknown>;
      if (typeof payload["sceneType"] !== "string") {
        errors.push(`scene "${scene.id}": ${scene.engine} scenes require enginePayload.sceneType`);
      }
    }
  }

  if (project.audio.musicAssetId && !assetIds.has(project.audio.musicAssetId)) {
    errors.push(`audio.musicAssetId "${project.audio.musicAssetId}" does not exist`);
  }
  if (project.audio.voiceAssetId && !assetIds.has(project.audio.voiceAssetId)) {
    errors.push(`audio.voiceAssetId "${project.audio.voiceAssetId}" does not exist`);
  }
  for (const cue of project.audio.sfxCues) {
    if (!assetIds.has(cue.assetId)) errors.push(`audio.sfxCues references unknown asset "${cue.assetId}"`);
  }

  return errors;
}

export function sceneDuration(scene: SceneSpecT): number {
  return scene.endSec - scene.startSec;
}

/** Duration a scene must be rendered at, including the tail consumed by the next transition. */
export function sceneRenderDuration(project: UltraProjectT, scene: SceneSpecT): number {
  const main = project.scenes.filter((s) => !s.overlayOfSceneId).sort((a, b) => a.startSec - b.startSec);
  const index = main.findIndex((s) => s.id === scene.id);
  if (index === -1) return sceneDuration(scene);
  const next = main[index + 1];
  const tail = next ? next.transitionIn.durationSec : 0;
  return sceneDuration(scene) + tail;
}
