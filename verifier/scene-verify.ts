import { promises as fs } from "node:fs";
import path from "node:path";
import type { UltraProjectT, VerifyReportT } from "../core/schema.js";
import { VerifyReport } from "../core/schema.js";
import { safeSceneId, lintProject } from "../core/orchestrator.js";
import { auditDraft } from "./metrics.js";
import { buildScenePairs, type VisualPair } from "./visual-diff.js";
import { createRubric } from "./rubric.js";
import { ensureDir, pathExists, rmrf, round, writeJsonAtomic } from "../core/util.js";
import { ffmpegOk } from "../core/ffmpeg.js";

/**
 * [21] verify --scene: metrics + visual-diff + lint for ONE scene only.
 * Compares the rendered scene clip (scene-local time) against the reference
 * segment (global time) and writes build/verify-report-<sceneId>.json.
 */
export async function verifyScene(opts: {
  project: UltraProjectT;
  sceneId: string;
  reference: string;
  workspace: string;
  buildDir: string;
  draftDir?: string;
}): Promise<{ report: VerifyReportT; reportFile: string; pairs: VisualPair[] }> {
  const { project, sceneId, reference, workspace, buildDir } = opts;
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`verify --scene: unknown scene "${sceneId}"`);
  const sceneFile = path.join(opts.draftDir ?? path.join(buildDir, "scenes"), `${safeSceneId(scene.id)}${scene.alpha ? ".mov" : ".mp4"}`);
  if (!(await pathExists(sceneFile))) {
    throw new Error(`verify --scene: no rendered clip at ${sceneFile} — run \`ultra build --scene ${scene.id}\` first`);
  }
  const durationSec = round(scene.endSec - scene.startSec, 3);
  const tmp = path.join(buildDir, "tmp", `verify-${safeSceneId(scene.id)}`);
  await rmrf(tmp);
  await ensureDir(tmp);
  const trimmed = path.join(tmp, "scene.mp4");
  await ffmpegOk(
    [
      "-i",
      sceneFile,
      "-t",
      String(durationSec),
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
      trimmed,
    ],
    { timeoutMs: 10 * 60_000 },
  );

  const metrics = await auditDraft({
    draftFile: trimmed,
    referenceFile: reference,
    expectedDurationSec: durationSec,
    expectedFps: project.meta.fps,
    targetLufs: project.audio.targetLufs,
  });
  const lint = await lintProject({ project, workspace, buildDir, onlySceneIds: [scene.id] });
  const pairs = await buildScenePairs({
    reference,
    draft: trimmed,
    project,
    scene,
    outDir: path.join(buildDir, "audit-frames", `scene-${safeSceneId(scene.id)}`),
  });
  await rmrf(tmp);

  const report: VerifyReportT = {
    version: 1,
    createdAt: new Date().toISOString(),
    reference,
    draft: trimmed,
    projectDurationSec: durationSec,
    quantitative: {
      durationDeltaSec: metrics.durationDeltaSec,
      durationOk: metrics.durationOk,
      fpsExpected: metrics.fpsExpected,
      fpsActual: metrics.fpsActual,
      fpsOk: metrics.fpsOk,
      cfr: metrics.cfr,
      cfrOk: metrics.cfrOk,
      duplicateRatio: metrics.duplicateRatio,
      staticHoldFrames: metrics.staticHoldFrames,
      staticHoldRatio: metrics.staticHoldRatio,
      stutterEvents: metrics.stutterEvents,
      stutterFrames: metrics.stutterFrames,
      jitterRatio: metrics.jitterRatio,
      maxStaticHoldSec: metrics.maxStaticHoldSec,
      jitterOk: metrics.jitterOk,
      blackDetections: metrics.blackDetections,
      blackOk: metrics.blackOk,
      loudness: metrics.loudness,
      pass: metrics.pass,
    },
    lint: {
      scenes: lint.scenes,
      defectCount: lint.defectCount,
      criticalDefectCount: lint.criticalDefectCount,
      pass: lint.pass,
    },
    visualPairs: pairs,
    sceneSimilarity: pairs.map((pair) => ({
      index: pair.index,
      timestampSec: pair.timestampSec,
      sceneId: pair.sceneId,
      ssim: pair.ssim,
      mae: null,
    })),
    rubric: createRubric(),
    pass: metrics.pass && lint.pass,
  };
  VerifyReport.parse(report);
  const reportFile = path.join(buildDir, `verify-report-${safeSceneId(scene.id)}.json`);
  await writeJsonAtomic(reportFile, report);
  return { report, reportFile, pairs };
}
