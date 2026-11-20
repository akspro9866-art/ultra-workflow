import { promises as fs } from "node:fs";
import path from "node:path";
import { ffprobeJson } from "./ffmpeg.js";
import type { AssetSpecT, UltraProjectT } from "./schema.js";
import { AssetManifest, type AssetTodoT } from "./schema.js";
import { pathExists, resolveInside, round, sha1File, writeJsonAtomic } from "./util.js";
import { SceneGraph } from "../engines/blender/schema.js";
import { inferSynthPreset, lookupSynthOrigin } from "./synth-audio.js";
import { compareAssetToReference } from "./similarity.js";
import { resolveSourceVideoPath } from "./project.js";

export type AssetHost = "auto" | "gemini" | "muse" | "chatgpt";

export interface AssetCheckResult {
  id: string;
  targetPath: string;
  exists: boolean;
  bytes: number;
  sha1: string | null;
  valid: boolean;
  status: string;
  similarity?: {
    sceneId: string;
    startSec: number;
    endSec: number;
    ssimToRefSegment: number | null;
    histogramDistance: number | null;
    edgeDensityRatio: number | null;
    warnings: string[];
  } | null;
  origin?: "synthesised" | "recorded" | "licensed" | "user-supplied";
}

export interface AssetValidation {
  ok: boolean;
  todo: AssetTodoT;
  checks: AssetCheckResult[];
  errors: string[];
  warnings: string[];
}

export function resolveAssetPath(workspace: string, asset: AssetSpecT): string {
  return resolveInside(workspace, asset.targetPath);
}

/** Resolve a sourceClip path relative to the project root (cwd) or the workspace. */
export async function resolveSourceClipPath(workspace: string, p: string): Promise<string> {
  if (path.isAbsolute(p)) {
    if (await pathExists(p)) return p;
    throw new Error(`sourceClip path not found: ${p}`);
  }
  const candidates = [path.resolve(process.cwd(), p), path.resolve(workspace, p)];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  throw new Error(`sourceClip path not found (tried project root and workspace): ${p}`);
}

function isWellFormedXml(text: string): { ok: boolean; reason?: string } {
  const cleaned = text
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const tagRe = /<\s*(\/)?\s*([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/)?\s*>/g;
  const stack: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(cleaned)) !== null) {
    const between = cleaned.slice(lastIndex, match.index);
    if (between.includes("<") || between.includes(">")) {
      return { ok: false, reason: "malformed markup outside tags" };
    }
    lastIndex = tagRe.lastIndex;
    const closing = Boolean(match[1]);
    const name = match[2] ?? "";
    const selfClosing = Boolean(match[4]);
    if (closing) {
      const top = stack.pop();
      if (top !== name) return { ok: false, reason: `unbalanced closing tag </${name}>` };
    } else if (!selfClosing) {
      stack.push(name);
    } else if (stack.length === 0) {
      // self-closing root is suspicious for SVG (needs a root svg tag), fall through
      stack.push(name);
      stack.pop();
    }
  }
  if (cleaned.slice(lastIndex).includes("<") || cleaned.slice(lastIndex).includes(">")) {
    return { ok: false, reason: "malformed markup outside tags" };
  }
  if (stack.length > 0) return { ok: false, reason: `unclosed tag <${stack[stack.length - 1]}>` };
  if (!/^\s*(?:<\?[\s\S]*?\?>\s*)?<svg[\s>]/i.test(cleaned)) {
    return { ok: false, reason: "root element must be <svg>" };
  }
  return { ok: true };
}

async function probeMedia(file: string): Promise<any | null> {
  try {
    return await ffprobeJson(file);
  } catch {
    return null;
  }
}

function pickStream(probe: any, type: "video" | "audio"): any | null {
  const streams: any[] = probe?.streams ?? [];
  return streams.find((s) => s.codec_type === type) ?? null;
}

export async function checkAsset(workspace: string, asset: AssetSpecT): Promise<AssetCheckResult> {
  const targetPath = resolveAssetPath(workspace, asset);
  const exists = await pathExists(targetPath);
  if (!exists) {
    return { id: asset.id, targetPath, exists: false, bytes: 0, sha1: null, valid: false, status: "missing file" };
  }
  const stat = await fs.stat(targetPath);
  const bytes = stat.size;
  if (bytes === 0) {
    return { id: asset.id, targetPath, exists: true, bytes, sha1: null, valid: false, status: "file is empty" };
  }
  const digest = await sha1File(targetPath);
  const base = { id: asset.id, targetPath, exists: true, bytes, sha1: digest };

  switch (asset.type) {
    case "svg": {
      const text = await fs.readFile(targetPath, "utf8");
      const xml = isWellFormedXml(text);
      return { ...base, valid: xml.ok, status: xml.ok ? "valid svg" : `invalid svg: ${xml.reason}` };
    }
    case "3d_graph": {
      try {
        const raw = JSON.parse(await fs.readFile(targetPath, "utf8"));
        const parsed = SceneGraph.safeParse(raw);
        return {
          ...base,
          valid: parsed.success,
          status: parsed.success
            ? "valid scene graph"
            : `invalid scene graph: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).slice(0, 3).join("; ")}`,
        };
      } catch (err) {
        return { ...base, valid: false, status: `invalid JSON: ${(err as Error).message}` };
      }
    }
    case "sfx":
    case "music":
    case "voice": {
      const probe = await probeMedia(targetPath);
      const audio = pickStream(probe, "audio");
      if (!audio) return { ...base, valid: false, status: "no audio stream found" };
      const duration = round(Number(probe?.format?.duration ?? audio.duration ?? 0), 3);
      if (asset.durationSec && duration > 0 && duration + 0.3 < asset.durationSec) {
        return { ...base, valid: false, status: `audio too short (${duration}s < ${asset.durationSec}s)` };
      }
      return { ...base, valid: true, status: `valid audio (${duration}s)` };
    }
    case "video": {
      const probe = await probeMedia(targetPath);
      const video = pickStream(probe, "video");
      if (!video) return { ...base, valid: false, status: "no video stream found" };
      if (asset.width && Number(video.width) !== asset.width) {
        return { ...base, valid: false, status: `width ${video.width} != declared ${asset.width}` };
      }
      if (asset.height && Number(video.height) !== asset.height) {
        return { ...base, valid: false, status: `height ${video.height} != declared ${asset.height}` };
      }
      const duration = Number(probe?.format?.duration ?? video.duration ?? 0);
      if (asset.durationSec && duration > 0 && duration + 0.3 < asset.durationSec) {
        return { ...base, valid: false, status: `video too short (${round(duration, 2)}s < ${asset.durationSec}s)` };
      }
      return { ...base, valid: true, status: `valid video (${round(duration, 2)}s)` };
    }
    case "image":
    case "illustration":
    case "png_alpha": {
      const probe = await probeMedia(targetPath);
      const video = pickStream(probe, "video");
      if (!video) return { ...base, valid: false, status: "not a readable image" };
      if (asset.width && Math.abs(Number(video.width) - asset.width) > 1) {
        return { ...base, valid: false, status: `width ${video.width} != declared ${asset.width}` };
      }
      if (asset.height && Math.abs(Number(video.height) - asset.height) > 1) {
        return { ...base, valid: false, status: `height ${video.height} != declared ${asset.height}` };
      }
      if (asset.type === "png_alpha" || asset.requireAlpha) {
        const pixFmt = String(video.pix_fmt ?? "");
        if (!/[ar]gba|ya\d|yuva|argb|abgr/i.test(pixFmt)) {
          return { ...base, valid: false, status: `alpha channel required but pix_fmt is "${pixFmt}"` };
        }
      }
      return { ...base, valid: true, status: `valid image (${video.width}x${video.height}, ${video.pix_fmt})` };
    }
    default: {
      return { ...base, valid: false, status: `unknown asset type ${String((asset as AssetSpecT).type)}` };
    }
  }
}

function instructionFor(asset: AssetSpecT, host: AssetHost = "auto"): string {
  const dims = asset.width && asset.height ? ` at exactly ${asset.width}x${asset.height}` : "";
  if (host === "chatgpt") {
    switch (asset.type) {
      case "image":
        return `Generate this image${dims} with ChatGPT's built-in Image Generation tool (or author it with a clean Python/Pillow or SVG script). No baked-in text. Save it to the target path.`;
      case "illustration":
        return `Generate a bespoke illustration${dims} with ChatGPT's built-in Image Generation tool (avoid template looks). Save it to the target path.`;
      case "png_alpha":
        return `Generate the subject${dims} with ChatGPT's Image Generation tool and cut it out to a fully transparent PNG (alpha channel preserved), or author it with Python/Pillow RGBA. Save it to the target path.`;
      case "video":
        return `ChatGPT cannot call external video APIs. Generate ONE crisp high-resolution keyframe image (16:9, no text) with Image Generation and save it as this video's poster source, then flag it for Ultra's deterministic 2.5D rig: set chatgptStrategy="native-image-plus-2.5d-rig" and animate zoom/pan/parallax with the engine (zero external video APIs).`;
      case "sfx":
      case "music": {
        const preset = inferSynthPreset(asset.id, asset.type, `${asset.description} ${asset.prompt}`);
        return `Synthesize offline with Ultra Workflow: \`ultra synth-audio --preset ${preset.preset} --out ${asset.targetPath} --duration ${asset.durationSec ?? 2}${
          asset.type === "music" ? ` --bpm ${preset.bpm ?? 120} --mood ${preset.mood ?? "tech"}` : ""
        }\` (or batch with \`ultra synth-audio --from-assets\`). 48 kHz stereo WAV, zero external APIs.`;
      }
      case "voice":
        return `Use ChatGPT's native voice/TTS to render this line, save 48 kHz stereo WAV to the target path.`;
      case "svg":
        return `Hand-author a clean SVG (viewBox ${asset.width ?? 1920}x${asset.height ?? 1080}, no external references) or generate it with Python. Validate XML before saving.`;
      case "3d_graph":
        return `Author the JSON scene graph (engines/blender/schema.ts); in browserless ChatGPT containers Ultra renders it with the py-canvas wireframe/shaded polyhedron fallback deterministically.`;
      default:
        return "Generate the asset and save it to the target path.";
    }
  }
  switch (asset.type) {
    case "image":
      return `Generate an image${dims} with your native image generation tool. No text baked into the image. Save it to the target path.`;
    case "illustration":
      return `Generate a bespoke illustration${dims} with your native image generation tool. Avoid stock-photo framing, generic gradients and template looks. Save it to the target path.`;
    case "png_alpha":
      return `Generate or cut out a subject${dims} on a fully transparent background (PNG with alpha channel) using your native image tools. Verify the alpha channel survives. Save it to the target path.`;
    case "svg":
      return `Hand-author a clean SVG (viewBox sized for ${asset.width ?? 1920}x${asset.height ?? 1080}, no external references, no embedded rasters). Validate it parses as XML before saving.`;
    case "video":
      return `Generate a video clip of ${asset.durationSec ?? "the declared"}s${dims} with your native video generation tool. Save exactly to the target path.`;
    case "sfx":
      return `Generate a short sound effect (${asset.durationSec ?? 1}s) with your native audio tool. No music bed, no voice. Save to the target path.`;
    case "music":
      return `Generate a music track of at least ${asset.durationSec ?? "the declared"}s with your native audio tool. Save to the target path.`;
    case "voice":
      return `Generate a voiceover of at least ${asset.durationSec ?? "the declared"}s with your native voice tool, matching the language and tone in the description. Save to the target path.`;
    case "3d_graph":
      return `Author a JSON scene graph conforming to engines/blender/schema.ts (camera, lights, materials, primitive meshes with keyframes, backgroundAlpha=true). Save to the target path.`;
    default:
      return "Generate the asset and save it to the target path.";
  }
}

interface AssetBinding {
  sceneId: string;
  startSec: number;
  endSec: number;
}

/** First timeline scene that uses each asset (sorted by startSec). */
function assetBindings(project: UltraProjectT): Map<string, AssetBinding> {
  const map = new Map<string, AssetBinding>();
  for (const scene of [...project.scenes].sort((a, b) => a.startSec - b.startSec)) {
    for (const layer of scene.layers) {
      if (layer.assetId && !map.has(layer.assetId)) {
        map.set(layer.assetId, { sceneId: scene.id, startSec: scene.startSec, endSec: scene.endSec });
      }
    }
  }
  return map;
}

const IMAGE_ASSET_TYPES = new Set(["image", "illustration", "png_alpha"]);
const AUDIO_ASSET_TYPES = new Set(["sfx", "music", "voice"]);

export async function validateAssets(
  project: UltraProjectT,
  workspace: string,
  options: { host?: AssetHost } = {},
): Promise<AssetValidation> {
  const host = options.host ?? "auto";
  const checks: AssetCheckResult[] = [];
  for (const asset of project.assets) {
    checks.push(await checkAsset(workspace, asset));
  }
  const warnings: string[] = [];

  // [30] Audio provenance: synth-audio outputs are labelled automatically.
  for (const asset of project.assets) {
    if (!AUDIO_ASSET_TYPES.has(asset.type)) continue;
    const check = checks.find((c) => c.id === asset.id);
    if (!check) continue;
    const file = resolveAssetPath(workspace, asset);
    check.origin = asset.origin ?? ((await lookupSynthOrigin(file)) ? "synthesised" : "user-supplied");
  }

  // [18] Content similarity vs the reference segment the asset replaces.
  const bindings = assetBindings(project);
  const threshold = project.assetSimilarity;
  const reference = await resolveSourceVideoPath(workspace, project.meta.sourceVideoPath);
  let warnedNoReference = false;
  for (const asset of project.assets) {
    if (!IMAGE_ASSET_TYPES.has(asset.type)) continue;
    const check = checks.find((c) => c.id === asset.id);
    const binding = bindings.get(asset.id) ?? (asset.refSegment ? { sceneId: "refSegment", startSec: asset.refSegment.startSec, endSec: asset.refSegment.endSec } : null);
    if (!check || !check.valid || !binding) continue;
    if (!reference) {
      check.similarity = {
        ...binding,
        sceneId: binding.sceneId,
        ssimToRefSegment: null,
        histogramDistance: null,
        edgeDensityRatio: null,
        warnings: ["reference video not found — similarity not measured"],
      };
      if (!warnedNoReference) {
        warnings.push(`asset similarity not measured for image assets: reference "${project.meta.sourceVideoPath}" not found`);
        warnedNoReference = true;
      }
      continue;
    }
    const atSec = (binding.startSec + binding.endSec) / 2;
    const scores = await compareAssetToReference(resolveAssetPath(workspace, asset), reference, atSec);
    const assetWarnings: string[] = [];
    if (scores.ssimToRefSegment !== null && scores.ssimToRefSegment < threshold.minSsim) {
      assetWarnings.push(
        `asset "${asset.id}" SSIM ${scores.ssimToRefSegment} < ${threshold.minSsim} vs scene "${binding.sceneId}" [${binding.startSec.toFixed(2)}s..${binding.endSec.toFixed(2)}s]`,
      );
    }
    if (scores.histogramDistance !== null && scores.histogramDistance > threshold.maxHistogramDistance) {
      assetWarnings.push(
        `asset "${asset.id}" colour histogram distance ${scores.histogramDistance} > ${threshold.maxHistogramDistance} vs scene "${binding.sceneId}"`,
      );
    }
    if (
      scores.edgeDensityRatio !== null &&
      (scores.edgeDensityRatio < 1 - threshold.edgeRatioTolerance || scores.edgeDensityRatio > 1 + threshold.edgeRatioTolerance)
    ) {
      assetWarnings.push(
        `asset "${asset.id}" edge-density ratio ${scores.edgeDensityRatio} outside ${threshold.edgeRatioTolerance} of the reference segment`,
      );
    }
    check.similarity = { ...binding, ...scores, warnings: assetWarnings };
    warnings.push(...assetWarnings);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    assets: Object.fromEntries(checks.map((c) => [c.id, c])),
  };
  AssetManifest.parse(manifest);
  await writeJsonAtomic(path.join(workspace, "assets.manifest.json"), manifest);

  const missing = project.assets.filter((asset) => {
    const check = checks.find((c) => c.id === asset.id);
    return !check || !check.valid;
  });

  const todo: AssetTodoT = {
    generatedAt: new Date().toISOString(),
    complete: missing.length === 0,
    missing: missing.map((asset) => {
      const check = checks.find((c) => c.id === asset.id);
      const chatgpt = host === "chatgpt";
      const strategy: "native-image" | "native-image-plus-2.5d-rig" | "ultra-synth-audio" | "python-authored" | undefined = chatgpt
        ? asset.type === "video"
          ? "native-image-plus-2.5d-rig"
          : asset.type === "sfx" || asset.type === "music"
            ? "ultra-synth-audio"
            : ["image", "illustration", "png_alpha", "voice"].includes(asset.type)
              ? "native-image"
              : "python-authored"
        : undefined;
      const synthPreset =
        chatgpt && (asset.type === "sfx" || asset.type === "music")
          ? {
              ...inferSynthPreset(asset.id, asset.type, `${asset.description} ${asset.prompt}`),
              durationSec: asset.durationSec ?? undefined,
            }
          : undefined;
      const binding = bindings.get(asset.id);
      return {
        id: asset.id,
        type: asset.type,
        description: asset.description,
        prompt: asset.prompt,
        ...(asset.negativePrompt ? { negativePrompt: asset.negativePrompt } : {}),
        ...(asset.width ? { width: asset.width } : {}),
        ...(asset.height ? { height: asset.height } : {}),
        ...(asset.durationSec ? { durationSec: asset.durationSec } : {}),
        ...(asset.requireAlpha ? { requireAlpha: asset.requireAlpha } : {}),
        targetPath: asset.targetPath,
        instruction: `${instructionFor(asset, host)}${check && check.exists ? ` Current problem: ${check.status}.` : ""}`,
        ...(AUDIO_ASSET_TYPES.has(asset.type) ? { origin: check?.origin ?? asset.origin ?? "user-supplied" } : {}),
        ...(binding && IMAGE_ASSET_TYPES.has(asset.type) ? { similarityTarget: binding } : {}),
        ...(strategy ? { chatgptStrategy: strategy } : {}),
        ...(synthPreset ? { synthPreset } : {}),
      };
    }),
  };
  await writeJsonAtomic(path.join(workspace, "assets-todo.json"), todo);

  const errors = project.assets
    .map((asset) => {
      const check = checks.find((c) => c.id === asset.id);
      if (check?.valid) return null;
      return `asset "${asset.id}" (${asset.targetPath}): ${check?.status ?? "missing"}`;
    })
    .filter((v): v is string => v !== null);

  return { ok: errors.length === 0, todo, checks, errors, warnings };
}
