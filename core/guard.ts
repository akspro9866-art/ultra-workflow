import { promises as fs } from "node:fs";
import path from "node:path";
import type { UltraProjectT } from "./schema.js";
import { loadProject, resolveSourceVideoPath } from "./project.js";
import { resolveAssetPath, resolveSourceClipPath } from "./assets.js";
import { checkApprovalGate, loadPlan } from "./preprod.js";
import { resolveProcessMode } from "./state.js";
import { resolveAspectProfile } from "./safe-zones.js";
import { stylesRoot } from "./style-pack.js";
import { installRoot, ultraTmpDir } from "./env.js";
import { ffprobeJson } from "./ffmpeg.js";
import { extractFrameAt } from "./probe.js";
import { hammingDistance, perceptualHash } from "./similarity.js";
import { extractZip } from "./zip.js";
import { pathExists, readJson, sha1File } from "./util.js";
import { promises as fsPromises } from "node:fs";

export type GuardStage = "plan" | "build" | "verify" | "delivery";

export interface GuardIssue {
  check: string;
  detail: string;
  path?: string;
}

export interface GuardReport {
  ok: boolean;
  stage: GuardStage;
  errors: GuardIssue[];
  warnings: GuardIssue[];
  checkedAt: string;
}

const PLACEHOLDER = [/\blorem ipsum\b/i, /\bTBD\b/, /\bINSERT TEXT\b/i, /\[YOUR\s/i, /\bTODO\b/];

function isPlaceholder(text: string): boolean {
  return PLACEHOLDER.some((pattern) => pattern.test(text));
}

export async function runGuard(workspace: string, buildDir: string, stage: GuardStage): Promise<GuardReport> {
  const errors: GuardIssue[] = [];
  const warnings: GuardIssue[] = [];
  let project: UltraProjectT | null = null;
  try {
    project = await loadProject(workspace);
  } catch (err) {
    errors.push({ check: "project", detail: `ultra.json missing or invalid: ${(err as Error).message.split("\n")[0]}` });
  }
  let plan = null;
  try {
    plan = await loadPlan(workspace);
  } catch (err) {
    errors.push({ check: "plan", detail: `plan.json invalid: ${(err as Error).message.split("\n")[0]}` });
  }

  if (project) {
    const { zones } = resolveAspectProfile(project.meta);
    void zones;
    for (const scene of project.scenes) {
      if (scene.startSec < 0 || scene.endSec > project.meta.durationSec + 0.001) {
        errors.push({
          check: "timeline",
          detail: `scene "${scene.id}" is outside 0..${project.meta.durationSec}s (${scene.startSec}–${scene.endSec})`,
        });
      }
      if (scene.sourceClip) {
        const source = await resolveSourceClipPath(workspace, scene.sourceClip.path).catch(() => null);
        if (!source) errors.push({ check: "sourceClip", detail: `scene "${scene.id}" sourceClip not found: ${scene.sourceClip.path}` });
      }
      if (scene.captionsFile) {
        const captions = path.resolve(workspace, scene.captionsFile);
        if (!(await pathExists(captions))) errors.push({ check: "captions", detail: `scene "${scene.id}" captionsFile missing: ${scene.captionsFile}` });
        else {
          try {
            const doc = JSON.parse(await fs.readFile(captions, "utf8")) as { chunks?: { text?: string }[] };
            for (const chunk of doc.chunks ?? []) {
              if (chunk.text && isPlaceholder(chunk.text)) {
                errors.push({ check: "placeholder", detail: `caption contains placeholder text: "${chunk.text}"` });
              }
            }
          } catch {
            warnings.push({ check: "captions", detail: `captionsFile is not valid JSON: ${scene.captionsFile}` });
          }
        }
      }
      for (const text of scene.textElements) {
        if (isPlaceholder(text.text)) errors.push({ check: "placeholder", detail: `scene "${scene.id}" text "${text.id}" contains placeholder text` });
      }
      if (scene.customHtmlFile) {
        const file = path.join(workspace, "scenes", scene.customHtmlFile);
        if (!(await pathExists(file))) {
          errors.push({ check: "customScene", detail: `scene "${scene.id}" customHtmlFile missing: ${scene.customHtmlFile}` });
        } else {
          const html = await fs.readFile(file, "utf8").catch(() => "");
          if (isPlaceholder(html)) errors.push({ check: "placeholder", detail: `scene "${scene.id}" custom HTML contains placeholder text` });
        }
      }
    }
    for (const asset of project.assets) {
      const file = resolveAssetPath(workspace, asset);
      if (!(await pathExists(file))) {
        errors.push({ check: "asset", detail: `asset "${asset.id}" is missing on disk: ${asset.targetPath}` });
      }
    }

    // [7] Honesty annotations: list every guessed scene (timings included).
    for (const scene of project.scenes) {
      const source = scene.source ?? "guessed";
      if (source === "guessed") {
        warnings.push({
          check: "source",
          detail: `scene "${scene.id}" timing/layout is GUESSED (default) — annotate source:"measured" with evidence when probe-measured`,
        });
      }
    }
    const measurementsFile = path.join(workspace, "measurements.json");
    if (await pathExists(measurementsFile)) {
      try {
        const measurements = JSON.parse(await fs.readFile(measurementsFile, "utf8")) as unknown;
        const count = Array.isArray(measurements) ? measurements.length : typeof measurements === "object" && measurements ? Object.keys(measurements as object).length : 0;
        warnings.push({ check: "measurements", detail: `workspace/measurements.json supported (${count} entries)` });
      } catch {
        warnings.push({ check: "measurements", detail: "workspace/measurements.json is not valid JSON — ignored" });
      }
    }

    // [26] Method provenance: "native" must not reuse reference frames as assets.
    const method = project.meta.method;
    if (method === undefined) {
      warnings.push({
        check: "method",
        detail: 'meta.method absent — treated as "native" (declare "method": "native"|"plate-replay"|"mixed" for new projects)',
      });
    }
    if ((method ?? "native") === "native") {
      warnings.push({
        check: "method",
        detail: "native method: plate detection is limited to SHA-1 equality + 8x8 aHash (arbitrary small crops are not reliably caught)",
      });
      const reference = await resolveSourceVideoPath(workspace, project.meta.sourceVideoPath).catch(() => null);
      if (reference) {
        const referenceSha1 = await sha1File(reference).catch(() => null);
        // Reference frames: the probe's extracted frames when available, else scene midpoints.
        const frameFiles: string[] = [];
        const probeFramesDir = path.join(workspace, "probe-frames");
        try {
          const entries = (await fs.readdir(probeFramesDir)).filter((name) => /\.(png|jpg|jpeg|webp)$/i.test(name)).sort();
          for (let i = 0; i < entries.length && frameFiles.length < 12; i += Math.max(1, Math.floor(entries.length / 12))) {
            frameFiles.push(path.join(probeFramesDir, entries[i] as string));
          }
        } catch {
          // no probe frames
        }
        if (frameFiles.length === 0) {
          const scratch = path.join(ultraTmpDir(), `ultra-guard-frames-${process.pid}-${Date.now()}`);
          const scenes = project.scenes.filter((scene) => !scene.overlayOfSceneId).slice(0, 6);
          for (let i = 0; i < scenes.length; i += 1) {
            const scene = scenes[i] as (typeof scenes)[number];
            const out = path.join(scratch, `frame_${i}.png`);
            try {
              await extractFrameAt(reference, (scene.startSec + scene.endSec) / 2, out, 640);
              frameFiles.push(out);
            } catch {
              // skip
            }
          }
        }
        const frameHashes: { file: string; hash: number[] }[] = [];
        for (const file of frameFiles) {
          const hash = await perceptualHash(file);
          if (hash) frameHashes.push({ file, hash });
        }
        for (const asset of project.assets) {
          if (!["image", "illustration", "png_alpha"].includes(asset.type)) continue;
          const file = resolveAssetPath(workspace, asset);
          if (!(await pathExists(file))) continue;
          const digest = await sha1File(file).catch(() => null);
          if (digest && referenceSha1 && digest === referenceSha1) {
            errors.push({
              check: "method",
              detail: `asset "${asset.id}" is the reference file itself (same SHA-1) but meta.method declares "native"`,
            });
            continue;
          }
          const assetHash = await perceptualHash(file);
          if (!assetHash) continue;
          const match = frameHashes.find((frame) => hammingDistance(assetHash, frame.hash) <= 6);
          if (match) {
            errors.push({
              check: "method",
              detail: `asset "${asset.id}" matches a reference frame (aHash distance ≤ 6, ${path.basename(match.file)}) but meta.method declares "native" — reference frames may only be used for measurement`,
            });
          }
        }
      } else {
        warnings.push({ check: "method", detail: "native method: reference video not found — plate detection skipped" });
      }
    }
  }

  if (plan) {
    for (const shot of plan.shots) {
      if (shot.startSec < 0 || shot.endSec > plan.meta.durationSec + 0.001) {
        errors.push({ check: "planTimeline", detail: `shot "${shot.id}" is outside 0..${plan.meta.durationSec}s` });
      }
      if (isPlaceholder(`${shot.visual} ${shot.caption}`)) {
        errors.push({ check: "placeholder", detail: `shot "${shot.id}" contains placeholder text` });
      }
    }
    if (plan.meta.styleSlug) {
      const inCwd = path.join(stylesRoot(), plan.meta.styleSlug, "style.json");
      const inRepo = path.join(installRoot(), "styles", plan.meta.styleSlug, "style.json");
      if (!(await pathExists(inCwd)) && !(await pathExists(inRepo))) {
        errors.push({ check: "style", detail: `style slug "${plan.meta.styleSlug}" is not installed` });
      }
    }
  }

  if (stage === "verify" || stage === "delivery") {
    const verifyFile = path.join(buildDir, "verify-report.json");
    if (!(await pathExists(verifyFile))) {
      errors.push({ check: "evidence", detail: "build/verify-report.json is missing — run `ultra verify`" });
    } else {
      try {
        const report = (await readJson(verifyFile)) as Record<string, any>;
        if (report["pass"] !== true) errors.push({ check: "evidence", detail: "verify-report.json is not passing" });
        const stutter = report?.["quantitative"]?.["stutterEvents"];
        if (typeof stutter === "number" && stutter !== 0) {
          errors.push({ check: "evidence", detail: `verify-report stutterEvents is ${stutter} (must be 0)` });
        }
        if (report?.["lint"]?.["pass"] !== true) errors.push({ check: "evidence", detail: "verify-report lint did not pass" });
      } catch {
        errors.push({ check: "evidence", detail: "verify-report.json is not valid JSON" });
      }
    }
  }

  if (stage === "delivery") {
    const mode = await resolveProcessMode(workspace, project);
    if (mode === "edit-in-style") {
      const gate = await checkApprovalGate(workspace, { mode, buildDir, requireArtifacts: false });
      if (!gate.ok) {
        errors.push({ check: "approval", detail: `Process 2B requires a verified approval.json: ${gate.message}` });
      }
    }
    const deliveryFile = path.join(buildDir, "delivery-manifest.json");
    if (!(await pathExists(deliveryFile))) {
      errors.push({ check: "delivery", detail: "build/delivery-manifest.json missing — run `ultra render --4k`" });
    } else {
      try {
        const delivery = (await readJson(deliveryFile)) as Record<string, any>;
        const master = delivery?.["files"]?.["master"];
        if (typeof master !== "string" || !(await pathExists(master))) {
          errors.push({ check: "delivery", detail: "delivery-manifest master file is missing" });
        } else {
          const probe = await ffprobeJson(master);
          const video = probe.streams.find((stream: { codec_type?: string }) => stream.codec_type === "video") as
            | { width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; pix_fmt?: string }
            | undefined;
          const audio = probe.streams.find((stream: { codec_type?: string }) => stream.codec_type === "audio");
          const target = delivery?.["target"] ?? {};
          if (video?.width !== target.width || video?.height !== target.height) {
            errors.push({
              check: "delivery",
              detail: `master is ${video?.width}x${video?.height} but manifest target is ${target.width}x${target.height}`,
            });
          }
          if (video?.pix_fmt !== "yuv420p") errors.push({ check: "delivery", detail: `master pix_fmt is ${video?.pix_fmt} (must be yuv420p)` });
          if (video?.r_frame_rate !== video?.avg_frame_rate) errors.push({ check: "delivery", detail: "master is not CFR" });
          if (!audio) errors.push({ check: "delivery", detail: "master has no audio stream" });
          if (Number(probe.format?.duration ?? 0) <= 0) errors.push({ check: "delivery", detail: "master duration is zero" });
        }
        if (delivery?.["pass"] !== true) errors.push({ check: "delivery", detail: "delivery-manifest pass is false" });
        const editableZip = delivery?.["files"]?.["editableZip"];
        if (typeof editableZip === "string" && !(await pathExists(editableZip))) {
          errors.push({ check: "delivery", detail: "editable project zip listed but missing" });
        }
      } catch (err) {
        errors.push({ check: "delivery", detail: `delivery-manifest invalid: ${(err as Error).message.split("\n")[0]}` });
      }
    }
    const exportDir = path.join(buildDir, "editable-project");
    for (const required of ["timeline.fcpxml", "timeline.otio", "project.ultra.json", "index.html"]) {
      if (!(await pathExists(path.join(exportDir, required)))) {
        errors.push({ check: "editable", detail: `editable-project/${required} is missing — run \`ultra export-project\`` });
      }
    }
    const editableZip = path.join(buildDir, "editable-project.zip");
    if (!(await pathExists(editableZip))) {
      errors.push({ check: "editable", detail: "build/editable-project.zip is missing" });
    } else {
      const stat = await fs.stat(editableZip);
      if (stat.size === 0) errors.push({ check: "editable", detail: "editable-project.zip is empty" });
      else {
        const tmp = await fsPromises.mkdtemp(path.join(ultraTmpDir(), "ultra-guard-zip-"));
        try {
          const { entries } = await extractZip(editableZip, tmp);
          if (entries.some((entry) => !entry.crcOk)) errors.push({ check: "editable", detail: "editable-project.zip CRC verification failed" });
        } catch (err) {
          errors.push({ check: "editable", detail: `editable-project.zip is not readable: ${(err as Error).message}` });
        } finally {
          await fsPromises.rm(tmp, { recursive: true, force: true });
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    stage,
    errors,
    warnings,
    checkedAt: new Date().toISOString(),
  };
}
