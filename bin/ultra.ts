#!/usr/bin/env node
import { Command } from "commander";
import { promises as fs } from "node:fs";
import path from "node:path";
import { detectEnvironment } from "../core/env.js";
import { probeReference } from "../core/probe.js";
import { loadProject, ProjectValidationError, validateProjectSemantics } from "../core/project.js";
import { validateAssets } from "../core/assets.js";
import { buildProject, lintProject, type BuildManifest } from "../core/orchestrator.js";
import { stitchTimeline } from "../core/stitcher.js";
import { ProbeResult, VerifyReport, type VerifyReportT, type ProbeResultT } from "../core/schema.js";
import { DESIGN_TEMPLATE, MOTION_TEMPLATE, starterProject } from "../core/templates.js";
import { ensureDir, pathExists, readJson, writeJsonAtomic } from "../core/util.js";
import { auditDraft } from "../verifier/metrics.js";
import { buildVisualPairs } from "../verifier/visual-diff.js";
import { createRubric } from "../verifier/rubric.js";
import { applyPatch } from "../verifier/patcher.js";
import { shutdownBrowser } from "../core/browser.js";

class CliError extends Error {}

const program = new Command();
program
  .name("ultra")
  .description("Ultra Workflow — zero-API deterministic video compiler (agent-as-brain, ultra-as-engine)")
  .version("1.0.0")
  .option("-w, --workspace <dir>", "workspace directory (holds ultra.json, assets, probe)", "workspace");

interface CliPaths {
  root: string;
  workspace: string;
  buildDir: string;
}

function paths(): CliPaths {
  const root = process.cwd();
  const workspaceOpt = (program.opts().workspace as string | undefined) ?? "workspace";
  return {
    root,
    workspace: path.resolve(root, workspaceOpt),
    buildDir: path.join(root, "build"),
  };
}

async function loadValidatedProject(workspace: string) {
  const projectFile = path.join(workspace, "ultra.json");
  if (!(await pathExists(projectFile))) {
    throw new CliError(`No project found at ${projectFile}. Run \`ultra init\` first.`);
  }
  let project;
  try {
    project = await loadProject(workspace);
  } catch (err) {
    if (err instanceof ProjectValidationError) {
      throw new CliError(`ultra.json failed schema validation:\n- ${err.errors.join("\n- ")}`);
    }
    throw err;
  }
  const semanticErrors = validateProjectSemantics(project);
  if (semanticErrors.length > 0) {
    throw new CliError(`ultra.json failed semantic validation:\n- ${semanticErrors.join("\n- ")}`);
  }
  return project;
}

program
  .command("doctor")
  .description("Detect OS, GPU, FFmpeg, browser, Remotion, Revideo, Blender")
  .option("--json", "machine-readable JSON only")
  .action(async (options: { json?: boolean }) => {
    const report = await detectEnvironment();
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`ultra doctor`);
      console.log(`  os        ${report.os.platform} ${report.os.arch} · ${report.os.cpus} cpus`);
      console.log(`  node      ${report.node}`);
      console.log(`  python    ${report.python ?? "not found"}`);
      console.log(`  ffmpeg    ${report.ffmpeg.version ?? "not found"}`);
      console.log(`  ffprobe   ${report.ffprobe.version ?? "not found"}`);
      console.log(`  browser   ${report.browser.kind ?? "not found"}${report.browser.executablePath ? ` (${report.browser.executablePath})` : ""}`);
      console.log(`  remotion  ${report.remotion.installed ? "installed" : "optional — not installed"}`);
      console.log(`  revideo   ${report.revideo.installed ? "installed" : "optional — not installed"}`);
      console.log(`  blender   ${report.blender.version ?? "not found (Three.js fallback active)"}`);
      console.log(`  gpu       ${report.gpu.name ?? "not detected"}`);
      for (const warning of report.warnings) console.log(`  warning   ${warning}`);
    }
    if (!report.ok) process.exitCode = 1;
  });

program
  .command("init")
  .description("Scaffold workspace/ultra.json + DESIGN.md + Motion.md + assets/")
  .option("--force", "overwrite an existing workspace")
  .action(async (options: { force?: boolean }) => {
    const { workspace } = paths();
    const projectFile = path.join(workspace, "ultra.json");
    if ((await pathExists(projectFile)) && !options.force) {
      throw new CliError(`${projectFile} already exists (use --force to overwrite)`);
    }
    await ensureDir(path.join(workspace, "assets"));
    await writeJsonAtomic(projectFile, starterProject());
    await fs.writeFile(path.join(workspace, "DESIGN.md"), DESIGN_TEMPLATE, "utf8");
    await fs.writeFile(path.join(workspace, "Motion.md"), MOTION_TEMPLATE, "utf8");
    console.log(`Initialized ${workspace}`);
    console.log(`  ultra.json  starter 4s 1280x720@30 project (validate with: ultra validate-spec)`);
    console.log(`  DESIGN.md   fill after inspecting probe frames`);
    console.log(`  Motion.md   shot-by-shot contract`);
    console.log(`Next: drop your reference video somewhere and run \`ultra probe <ref.mp4>\`.`);
  });

program
  .command("probe <reference>")
  .description("Rule 1: ffprobe metadata + scene cuts + audio onsets + labeled contact sheets")
  .option("--json", "machine-readable JSON only")
  .action(async (reference: string, options: { json?: boolean }) => {
    const { workspace } = paths();
    await ensureDir(workspace);
    const ref = path.resolve(reference);
    const result = await probeReference(ref, workspace);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`probe → ${path.join(workspace, "probe.json")}`);
      console.log(`  video      ${result.width}x${result.height} @ ${result.fps.numeric}fps (${result.fps.rational}) · ${result.durationSec}s · ${result.pixelFormat}`);
      console.log(`  audio      ${result.audio ? `${result.audio.codec} ${result.audio.sampleRate}Hz ${result.audio.channels}ch` : "none"}`);
      console.log(`  cuts       ${result.cutsSec.length} ${JSON.stringify(result.cutsSec)}`);
      console.log(`  onsets     ${result.onsetsSec.length} ${JSON.stringify(result.onsetsSec.slice(0, 12))}`);
      console.log(`  frames     ${result.frames.length} in probe-frames/`);
      console.log(`  sheets     ${result.contactSheets.join(", ")}`);
    }
  });

program
  .command("validate-spec")
  .description("Strict Zod + semantic validation of workspace/ultra.json")
  .action(async () => {
    const { workspace } = paths();
    const project = await loadValidatedProject(workspace);
    const mainScenes = project.scenes.filter((s) => !s.overlayOfSceneId).length;
    const overlays = project.scenes.length - mainScenes;
    console.log(`ultra.json OK · ${project.scenes.length} scenes (${mainScenes} timeline, ${overlays} overlays) · ${project.assets.length} assets · ${project.meta.durationSec}s @ ${project.meta.fps}fps`);
  });

program
  .command("asset-plan")
  .description("Rule 2: write workspace/assets-todo.json listing only missing/invalid assets")
  .action(async () => {
    const { workspace } = paths();
    const project = await loadValidatedProject(workspace);
    const result = await validateAssets(project, workspace);
    const todoFile = path.join(workspace, "assets-todo.json");
    console.log(`asset-plan → ${todoFile}`);
    if (result.ok) {
      console.log(`  all ${project.assets.length} assets valid`);
    } else {
      console.log(`  ${result.todo.missing.length} asset(s) to generate:`);
      for (const item of result.todo.missing) {
        console.log(`  - ${item.id} (${item.type}) → ${item.targetPath}`);
      }
    }
  });

program
  .command("validate-assets")
  .description("Verify every declared asset exists, is non-empty and matches type rules")
  .action(async () => {
    const { workspace } = paths();
    const project = await loadValidatedProject(workspace);
    const result = await validateAssets(project, workspace);
    if (!result.ok) {
      console.error(JSON.stringify({ ok: false, errors: result.errors }, null, 2));
      throw new CliError(`validate-assets: ${result.errors.length} asset(s) invalid (see JSON above)`);
    }
    console.log(`validate-assets OK · ${result.checks.length} asset(s) verified (manifest: workspace/assets.manifest.json)`);
  });

program
  .command("build")
  .description("Rule 3/4: render scenes (engine routing + SHA-1 cache) and stitch build/draft.mp4")
  .option("--strict-engine", "fail instead of falling back to HyperFrames")
  .action(async (options: { strictEngine?: boolean }) => {
    const { workspace, buildDir } = paths();
    const project = await loadValidatedProject(workspace);
    const manifest = await buildProject({ project, workspace, buildDir, strictEngine: options.strictEngine });
    console.log(`build → ${manifest.draftFile} (${manifest.durationSec}s @ ${manifest.fps}fps)`);
    for (const scene of manifest.scenes) {
      console.log(
        `  ${scene.sceneId.padEnd(18)} ${scene.engineUsed.padEnd(12)} ${scene.cached ? "cache" : "rendered"} ${scene.fallback ? "· fallback" : ""} ${scene.notes.length ? `· ${scene.notes[0]}` : ""}`,
      );
    }
    console.log(`  transitions ${manifest.stitch.transitionCount} · overlays ${manifest.stitch.overlayCount} · cache ${manifest.cache.hits}h/${manifest.cache.misses}m`);
  });

program
  .command("verify <reference>")
  .description("Rule 5: quantitative audit + DOM lint + labeled side-by-side pairs → build/verify-report.json")
  .option("--draft <path>", "draft video to audit", "build/draft.mp4")
  .action(async (reference: string, options: { draft: string }) => {
    const { workspace, buildDir } = paths();
    const project = await loadValidatedProject(workspace);
    const ref = path.resolve(reference);
    if (!(await pathExists(ref))) throw new CliError(`Reference video not found: ${ref}`);
    const draft = path.resolve(options.draft);
    if (!(await pathExists(draft))) throw new CliError(`Draft not found: ${draft}. Run \`ultra build\` first.`);

    const metrics = await auditDraft({
      draftFile: draft,
      referenceFile: ref,
      expectedDurationSec: project.meta.durationSec,
      expectedFps: project.meta.fps,
      targetLufs: project.audio.targetLufs,
    });
    const lint = await lintProject({ project, workspace, buildDir });

    let probe: ProbeResultT | null = null;
    try {
      probe = ProbeResult.parse(await readJson(path.join(workspace, "probe.json")));
    } catch {
      probe = null;
    }
    const pairs = await buildVisualPairs({
      reference: ref,
      draft,
      project,
      outDir: path.join(buildDir, "audit-frames"),
      probe,
    });

    const report: VerifyReportT = {
      version: 1,
      createdAt: new Date().toISOString(),
      reference: ref,
      draft,
      projectDurationSec: project.meta.durationSec,
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
      sceneSimilarity: pairs.map((p) => ({
        index: p.index,
        timestampSec: p.timestampSec,
        sceneId: p.sceneId,
        ssim: p.ssim,
        mae: null,
      })),
      rubric: createRubric(),
      pass: metrics.pass && lint.pass,
    };
    VerifyReport.parse(report);
    const reportFile = path.join(buildDir, "verify-report.json");
    await writeJsonAtomic(reportFile, report);

    console.log(`verify → ${reportFile}`);
    console.log(
      `  duration  Δ${metrics.durationDeltaSec >= 0 ? "+" : ""}${metrics.durationDeltaSec}s ${metrics.durationOk ? "OK" : "FAIL"} · fps ${metrics.fpsActual ?? "?"} ${metrics.fpsOk ? "OK" : "FAIL"} · cfr ${metrics.cfr ? "OK" : "FAIL"}`,
    );
    console.log(
      `  motion    stutterEvents ${metrics.stutterEvents} (${metrics.jitterOk ? "OK" : "FAIL"}) · static holds ${metrics.staticHoldFrames}f (${(metrics.staticHoldRatio * 100).toFixed(1)}%) · black frames ${metrics.blackDetections.length} ${metrics.blackOk ? "OK" : "FAIL"}`,
    );
    console.log(
      `  audio     ${metrics.loudness ? `${metrics.loudness.inputI ?? "?"} LUFS ${metrics.loudness.ok ? "OK" : "FAIL"}` : "no audio stream"}`,
    );
    console.log(`  lint      ${lint.defectCount} defects (${lint.criticalDefectCount} critical) ${lint.pass ? "OK" : "FAIL"}`);
    const defects = lint.scenes.flatMap((s) => s.defects);
    for (const defect of defects.slice(0, 12)) {
      console.log(`    - [${defect.critical ? "critical" : "warning"}] ${defect.sceneId} (${defect.category}): ${defect.detail}`);
    }
    console.log(`  pairs     ${pairs.length} → build/audit-frames/pair_*.png (Left: ORIGINAL · Right: DRAFT)`);
    console.log(`  rubric    5×20 pts template ready for the agent (pass threshold 90)`);
    if (!report.pass) {
      console.log(`  RESULT    FAIL — patch failing scenes, then rerun \`ultra build && ultra verify\``);
      process.exitCode = 1;
    } else {
      console.log(`  RESULT    PASS — run \`ultra render\` for the final broadcast MP4`);
    }
  });

program
  .command("patch <patchFile>")
  .description("Apply a surgical JSON patch to failing scene(s) and invalidate only their cache")
  .action(async (patchFile: string) => {
    const { workspace } = paths();
    const projectFile = path.join(workspace, "ultra.json");
    const resolvedPatch = path.resolve(patchFile);
    if (!(await pathExists(resolvedPatch))) throw new CliError(`Patch file not found: ${resolvedPatch}`);
    const result = await applyPatch(projectFile, resolvedPatch, workspace);
    console.log(`patch applied → ${projectFile}`);
    for (const entry of result.applied) {
      console.log(`  ${entry.sceneId}: invalidated ${entry.invalidated.length} cache entr${entry.invalidated.length === 1 ? "y" : "ies"}`);
    }
    for (const warning of result.warnings) console.log(`  warning: ${warning}`);
    console.log(`Next: ${result.nextCommand}`);
  });

program
  .command("render")
  .description("Rule 6: stitch verified scenes into the final broadcast MP4")
  .option("--out <path>", "output file", "build/ultra-final.mp4")
  .option("--force", "render even if verify-report.json is missing or failing")
  .option("--crf <number>", "x264 CRF", "16")
  .action(async (options: { out: string; force?: boolean; crf: string }) => {
    const { workspace, buildDir } = paths();
    const project = await loadValidatedProject(workspace);
    const manifestFile = path.join(buildDir, "build-manifest.json");
    if (!(await pathExists(manifestFile))) throw new CliError("No build manifest. Run `ultra build` first.");
    const manifest = (await readJson(manifestFile)) as BuildManifest;

    const reportFile = path.join(buildDir, "verify-report.json");
    if (!options.force) {
      if (!(await pathExists(reportFile))) {
        throw new CliError("verify-report.json missing — run `ultra verify <ref.mp4>` before rendering (or pass --force)");
      }
      let report: VerifyReportT;
      try {
        report = VerifyReport.parse(await readJson(reportFile));
      } catch (err) {
        throw new CliError(`verify-report.json is invalid: ${(err as Error).message}`);
      }
      if (!report.pass) {
        throw new CliError(
          `verify-report.json is FAILING (${report.lint.criticalDefectCount} critical defects). Patch and re-verify, or pass --force.`,
        );
      }
    }

    const outFile = path.resolve(options.out);
    const result = await stitchTimeline({
      project,
      workspace,
      buildDir,
      clips: manifest.scenes.map((s) => ({
        sceneId: s.sceneId,
        file: s.file,
        startSec: s.startSec,
        endSec: s.endSec,
        durationSec: s.durationSec,
      })),
      outFile,
      crf: Number(options.crf),
      preset: "slow",
    });
    await writeJsonAtomic(path.join(buildDir, "render-manifest.json"), {
      renderedAt: new Date().toISOString(),
      outFile,
      crf: Number(options.crf),
      result,
    });
    console.log(`render → ${outFile}`);
    console.log(`  ${result.durationSec}s · ${manifest.fps}fps · ${result.transitionCount} transitions · ${result.overlayCount} alpha overlays · audio ${result.hasAudio ? "mixed + loudnorm" : "none"}`);
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof CliError) {
    console.error(`[ultra] ${err.message}`);
  } else {
    console.error(`[ultra] error: ${(err as Error).message}`);
  }
  process.exitCode = 1;
} finally {
  await shutdownBrowser();
}
