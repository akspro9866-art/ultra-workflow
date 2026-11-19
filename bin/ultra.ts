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
import { runStyleVerify } from "../verifier/style-verify.js";
import { styleProbe } from "../core/style-probe.js";
import { styleExport, styleImport, styleList, validateStylePack } from "../core/style-pack.js";
import { rawProbe } from "../core/raw-probe.js";
import {
  SYNTH_PRESETS,
  defaultSynthDuration,
  isSynthPreset,
  synthFromAssets,
  synthesizeToWav,
  type SynthMood,
} from "../core/synth-audio.js";
import { shutdownBrowser } from "../core/browser.js";

class CliError extends Error {}

function quantitativeFrom(metrics: Awaited<ReturnType<typeof auditDraft>>) {
  return {
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
  };
}

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
  .description("Detect OS, GPU, FFmpeg, browser tier, Python modules, fonts, engines")
  .option("--json", "machine-readable JSON only")
  .option("--host <host>", "auto|gemini|muse|chatgpt", "auto")
  .action(async (options: { json?: boolean; host: string }) => {
    const host = options.host === "gemini" || options.host === "muse" || options.host === "chatgpt" ? options.host : "auto";
    const report = await detectEnvironment(host);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`ultra doctor`);
      console.log(`  renderTier  ${report.renderTier}${report.host ? ` · host=${report.host}` : ""}`);
      console.log(`  os          ${report.os.platform} ${report.os.arch} · ${report.os.cpus} cpus`);
      console.log(`  node        ${report.node}`);
      console.log(`  python      ${report.python ?? "not found"} · PIL ${report.pythonModules.pil ? "yes" : "no"} · numpy ${report.pythonModules.numpy ? "yes" : "no"} · cairosvg ${report.pythonModules.cairosvg ? "yes" : "no"}`);
      console.log(`  fonts       ${report.fonts.count} files · regular ${report.fonts.regular ?? "—"} · bold ${report.fonts.bold ?? "—"} · mono ${report.fonts.mono ?? "—"}`);
      console.log(`  ffmpeg      ${report.ffmpeg.version ?? "not found"}`);
      console.log(`  ffprobe     ${report.ffprobe.version ?? "not found"}`);
      console.log(`  browser     ${report.browser.kind ?? "not found"}${report.browser.executablePath ? ` (${report.browser.executablePath})` : ""}`);
      console.log(`  remotion    ${report.remotion.installed ? "installed" : "optional — not installed"}`);
      console.log(`  revideo     ${report.revideo.installed ? "installed" : "optional — not installed"}`);
      console.log(`  blender     ${report.blender.version ?? "not found (py-canvas/Three.js fallback)"}`);
      console.log(`  gpu         ${report.gpu.name ?? "not detected"}`);
      for (const warning of report.warnings) console.log(`  warning     ${warning}`);
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
  .option("--host <host>", "auto|gemini|muse|chatgpt (adapts instructions to native capabilities)", "auto")
  .action(async (options: { host: string }) => {
    const { workspace } = paths();
    const host = options.host === "gemini" || options.host === "muse" || options.host === "chatgpt" ? options.host : "auto";
    const project = await loadValidatedProject(workspace);
    const result = await validateAssets(project, workspace, { host });
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
  .command("verify [reference]")
  .description("Rule 5: 2A `verify <ref.mp4>` (1:1 clone) · 2B `verify --style <slug>` (edit in style)")
  .option("--draft <path>", "draft video to audit", "build/draft.mp4")
  .option("--style <slug>", "Process 2B: verify against an installed Style Pack")
  .action(async (reference: string | undefined, options: { draft: string; style?: string }) => {
    const { workspace, buildDir } = paths();
    const project = await loadValidatedProject(workspace);
    const draft = path.resolve(options.draft);
    if (!(await pathExists(draft))) throw new CliError(`Draft not found: ${draft}. Run \`ultra build\` first.`);
    const reportFile = path.join(buildDir, "verify-report.json");

    if (options.style) {
      const result = await runStyleVerify({
        project,
        slug: options.style,
        draftFile: draft,
        workspace,
        buildDir,
      });
      const metrics = result.metrics;
      const lint = result.lint;
      const compliance = result.compliance;
      const report: VerifyReportT = {
        version: 1,
        createdAt: new Date().toISOString(),
        reference: `style:${options.style}`,
        draft,
        projectDurationSec: project.meta.durationSec,
        quantitative: quantitativeFrom(metrics),
        lint: {
          scenes: lint.scenes,
          defectCount: lint.defectCount,
          criticalDefectCount: lint.criticalDefectCount,
          pass: lint.pass,
        },
        visualPairs: [],
        sceneSimilarity: [],
        rubric: createRubric(),
        style: { slug: options.style, compliance, matchSheet: result.matchSheet },
        pass: result.pass,
      };
      VerifyReport.parse(report);
      await writeJsonAtomic(reportFile, report);

      console.log(`verify (style ${options.style}) → ${reportFile}`);
      console.log(
        `  duration  Δ${metrics.durationDeltaSec >= 0 ? "+" : ""}${metrics.durationDeltaSec}s ${metrics.durationOk ? "OK" : "FAIL"} · fps ${metrics.fpsActual ?? "?"} ${metrics.fpsOk ? "OK" : "FAIL"} · cfr ${metrics.cfr ? "OK" : "FAIL"}`,
      );
      console.log(
        `  motion    stutterEvents ${metrics.stutterEvents} (${metrics.jitterOk ? "OK" : "FAIL"}) · longest static hold ${metrics.maxStaticHoldSec}s · black frames ${metrics.blackDetections.length} ${metrics.blackOk ? "OK" : "FAIL"}`,
      );
      console.log(
        `  audio     ${metrics.loudness ? `${metrics.loudness.inputI ?? "?"} LUFS (style target ${result.style.soundDesign.targetLufs} ±1.5)` : "no audio stream"}`,
      );
      console.log(`  lint      ${lint.defectCount} defects (${lint.criticalDefectCount} critical) ${lint.pass ? "OK" : "FAIL"}`);
      console.log(
        `  style     asl ${compliance.aslOk ? "OK" : "FAIL"} · holds ${compliance.staticHoldOk ? "OK" : "FAIL"} · transitions ${compliance.transitionsOk ? "OK" : "FAIL"} · palette ${compliance.paletteOk ? "OK" : "FAIL"} (Δ${compliance.paletteDistanceAvg}) · loudness ${compliance.loudnessOk ? "OK" : "FAIL"}`,
      );
      for (const detail of compliance.details.slice(0, 12)) console.log(`    - ${detail}`);
      console.log(`  match     ${result.matchSheet ?? "not generated"} (STYLE EXEMPLAR vs YOUR EDIT)`);
      if (!report.pass) {
        console.log(`  RESULT    FAIL — patch weak scenes, then rerun \`ultra build && ultra verify --style ${options.style}\``);
        process.exitCode = 1;
      } else {
        console.log(`  RESULT    PASS — run \`ultra render\` for the final broadcast MP4`);
      }
      return;
    }

    if (!reference) {
      throw new CliError("A reference video is required for 1:1 clone verification (or pass --style <slug>).");
    }
    const ref = path.resolve(reference);
    if (!(await pathExists(ref))) throw new CliError(`Reference video not found: ${ref}`);

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
      quantitative: quantitativeFrom(metrics),
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
  .command("style-probe <videos...>")
  .description("Process 1 · Rule 1: batch-probe 1–10 reference videos into workspace/style-probe")
  .option("--out <dir>", "output directory", "workspace/style-probe")
  .option("--hook-window <sec>", "hook window seconds", "5")
  .action(async (videos: string[], options: { out: string; hookWindow: string }) => {
    const result = await styleProbe(videos, path.resolve(options.out), Number(options.hookWindow));
    const aggregate = result.aggregate;
    console.log(`style-probe → ${path.join(result.outputDir, "aggregate.json")}`);
    console.log(`  references ${aggregate.videos.length} · candidates ${aggregate.candidates.length} · overview ${path.join(result.outputDir, aggregate.overviewPng)}`);
    console.log(
      `  hook ASL  min ${aggregate.sections.hook.min ?? "—"} / med ${aggregate.sections.hook.median ?? "—"} / max ${aggregate.sections.hook.max ?? "—"}`,
    );
    console.log(
      `  body ASL  min ${aggregate.sections.body.min ?? "—"} / med ${aggregate.sections.body.median ?? "—"} / max ${aggregate.sections.body.max ?? "—"}`,
    );
    console.log(
      `  pacing    max hold ${aggregate.pacing.maxStaticHoldSec}s · beat-snap ${aggregate.pacing.beatSnapRatio} · silence trim ${aggregate.pacing.silenceTrimMsSuggested}ms`,
    );
    console.log(
      `  colour    palette ${aggregate.palette.map((c) => c.hex).slice(0, 5).join(" ")} · lum ${aggregate.avgLuminance} · contrast ${aggregate.avgContrast} · sat ${aggregate.avgSaturation}`,
    );
  });

program
  .command("style-list")
  .description("List installed Style Packs in styles/")
  .option("--json", "machine-readable JSON")
  .action(async (options: { json?: boolean }) => {
    const entries = await styleList();
    if (options.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }
    if (entries.length === 0) {
      console.log("No Style Packs installed. Run `ultra style-import <zipOrDir>` first.");
      return;
    }
    for (const entry of entries) {
      console.log(
        `${entry.slug}  ${entry.name}  v${entry.version}  refs ${entry.referenceCount}  motifs ${entry.motifs}  exemplars ${entry.exemplars}`,
      );
    }
  });

program
  .command("style-validate <styleDir>")
  .description("Strictly validate a Style Pack (style.json, STYLE.md, exemplars, motifs, LUT, secrets)")
  .option("--json", "machine-readable JSON")
  .action(async (styleDir: string, options: { json?: boolean }) => {
    const result = await validateStylePack(styleDir);
    if (options.json) {
      console.log(
        JSON.stringify(
          { ok: result.ok, errors: result.errors, counts: result.counts, dir: result.dir, slug: result.style?.meta.slug ?? null },
          null,
          2,
        ),
      );
    } else if (result.ok) {
      console.log(
        `style-validate OK · ${result.style?.meta.slug} · motifs ${result.counts.motifs} · exemplars ${result.counts.exemplars}${result.counts.hasLut ? " · lut" : ""}`,
      );
    } else {
      for (const error of result.errors) console.log(`  - ${error}`);
      console.log(`style-validate FAILED (${result.errors.length} issue${result.errors.length === 1 ? "" : "s"})`);
    }
    if (!result.ok) process.exitCode = 1;
  });

program
  .command("style-export <styleDir>")
  .description("Package a validated Style Pack into <slug>-style-pack.zip")
  .option("--out <path>", "zip output path")
  .action(async (styleDir: string, options: { out?: string }) => {
    const result = await styleExport(styleDir, options.out ? path.resolve(options.out) : undefined);
    console.log(`style-export → ${result.zipPath}`);
    console.log(`  slug ${result.slug} · ${result.files} files · ${(result.bytes / 1024).toFixed(1)} KiB`);
    console.log(`  deliver this zip to the user; they import it in Qoder with prompts/QODER_IMPORT_STYLE_TO_REPO.txt`);
  });

program
  .command("style-import <zipOrDir>")
  .description("Validate a Style Pack zip/folder, install to styles/<slug>/, update registry")
  .option("--repack", "run `npm run pack:cloud` so dist/ bundles the new style (dev repo mode)")
  .action(async (zipOrDir: string, options: { repack?: boolean }) => {
    const result = await styleImport(zipOrDir, Boolean(options.repack));
    console.log(`style-import OK → ${result.installedDir}`);
    console.log(`  files ${result.files} · registry ${result.registryFile}`);
    if (result.repackRequested) {
      console.log(
        result.repacked
          ? `  repacked dist/ultra-workflow-cloud.zip (npm run pack:cloud)`
          : `  warning: repack did not complete (${result.repackExit ?? "not a dev repo"})`,
      );
    } else {
      console.log(`  next: run \`npm run pack:cloud\` in the repo to bundle the style into dist/ultra-workflow-cloud.zip`);
    }
  });

program
  .command("raw-probe <video>")
  .description("Process 2B · Rule 1: probe MY footage and emit workspace/raw-probe/raw-edit-plan.json")
  .requiredOption("--style <slug>", "installed Style Pack slug")
  .option("--out <dir>", "output directory", "workspace/raw-probe")
  .action(async (video: string, options: { style: string; out: string }) => {
    const result = await rawProbe(video, options.style, options.out);
    console.log(`raw-probe → ${path.join(result.outputDir, "raw-edit-plan.json")}`);
    console.log(`  source ${result.plan.durationSec}s @ ${result.plan.fps}fps · style ${options.style}`);
    console.log(
      `  silence   ${result.plan.silences.length} interval(s) · removed ${result.plan.removedDurationSec}s after ${result.plan.silenceTrimMs}ms trim`,
    );
    console.log(`  keeps     ${result.plan.keepSegments.length} segment(s)`);
    for (const segment of result.plan.keepSegments.slice(0, 8)) {
      console.log(`    - ${segment.startSec}s → ${segment.endSec}s (${segment.durationSec}s)`);
    }
    console.log(
      `  pacing    hook ends ${result.plan.pacing.hookEndSec}s · body ASL ${result.plan.pacing.targetBodyAslSec}s · max hold ${result.plan.pacing.maxStaticHoldSec}s · punch-ins ${result.plan.pacing.punchInPoints.length} · B-roll ${result.plan.pacing.brollCutaways.length}`,
    );
  });

program
  .command("synth-audio")
  .description("Offline 48kHz stereo WAV synthesizer (SFX + music presets, zero external APIs)")
  .option("--preset <name>", "preset name (see preset list)")
  .option("--out <path>", "output .wav path")
  .option("--duration <sec>", "duration seconds")
  .option("--bpm <num>", "music tempo", "120")
  .option("--mood <mood>", "dark|upbeat|tech|minimal", "tech")
  .option("--spec <jsonPath>", "JSON overrides {preset,durationSec,bpm,mood}")
  .option("--from-assets [path]", "generate every pending sfx/music asset from assets-todo.json")
  .action(async (options: {
    preset?: string;
    out?: string;
    duration?: string;
    bpm: string;
    mood: string;
    spec?: string;
    fromAssets?: string | boolean;
  }) => {
    if (options.fromAssets !== undefined) {
      const todoPath = typeof options.fromAssets === "string" ? path.resolve(options.fromAssets) : undefined;
      const result = await synthFromAssets(todoPath);
      console.log(`synth-audio --from-assets → ${result.generated.length} generated, ${result.skipped.length} skipped`);
      for (const item of result.generated) {
        console.log(`  ${item.preset.padEnd(14)} ${item.durationSec}s · ${(item.bytes / 1024).toFixed(1)} KiB · ${item.out}`);
      }
      for (const item of result.skipped) console.log(`  skip ${item.id}: ${item.reason}`);
      return;
    }
    let spec: Record<string, unknown> = {};
    if (options.spec) {
      try {
        spec = JSON.parse(await fs.readFile(path.resolve(options.spec), "utf8")) as Record<string, unknown>;
      } catch (err) {
        throw new CliError(`cannot read --spec ${options.spec}: ${(err as Error).message}`);
      }
    }
    const preset = options.preset ?? (typeof spec["preset"] === "string" ? spec["preset"] : undefined);
    const out = options.out ?? (typeof spec["out"] === "string" ? spec["out"] : undefined);
    if (!preset || !out) {
      throw new CliError(
        `synth-audio needs --preset and --out (or --spec). SFX presets: ${SYNTH_PRESETS.sfx.join(", ")} · music: ${SYNTH_PRESETS.music.join(", ")}`,
      );
    }
    if (!isSynthPreset(preset)) {
      throw new CliError(`unknown preset "${preset}". SFX: ${SYNTH_PRESETS.sfx.join(", ")} · music: ${SYNTH_PRESETS.music.join(", ")}`);
    }
    const mood = (["dark", "upbeat", "tech", "minimal"] as SynthMood[]).includes(options.mood as SynthMood)
      ? (options.mood as SynthMood)
      : (typeof spec["mood"] === "string" ? (spec["mood"] as SynthMood) : "tech");
    const durationSec = options.duration !== undefined
      ? Number(options.duration)
      : typeof spec["durationSec"] === "number"
        ? (spec["durationSec"] as number)
        : defaultSynthDuration(preset);
    const bpm = Number(options.bpm) || (typeof spec["bpm"] === "number" ? Number(spec["bpm"]) : 120);
    const result = await synthesizeToWav({ preset, out: path.resolve(out), durationSec, bpm, mood });
    console.log(`synth-audio → ${result.out}`);
    console.log(
      `  preset ${result.preset} · ${result.durationSec}s · 48kHz stereo · ${(result.bytes / 1024).toFixed(1)} KiB · peak ${result.peakDb.toFixed(1)} dBFS · rms ${result.rmsDb.toFixed(1)} dBFS`,
    );
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
