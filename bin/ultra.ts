#!/usr/bin/env node
import { Command } from "commander";
import { promises as fs } from "node:fs";
import path from "node:path";
import { detectEnvironment } from "../core/env.js";
import { probeReference } from "../core/probe.js";
import { loadProject, ProjectValidationError, resolveSourceVideoPath, validateProjectSemantics } from "../core/project.js";
import { measureStreamDurations } from "../core/probe.js";
import { validateAssets } from "../core/assets.js";
import { buildProject, buildScenePreview, lintProject, type BuildManifest } from "../core/orchestrator.js";
import { stitchTimeline } from "../core/stitcher.js";
import { ProbeResult, VerifyReport, type VerifyReportT, type ProbeResultT } from "../core/schema.js";
import { DESIGN_TEMPLATE, MOTION_TEMPLATE, starterProject } from "../core/templates.js";
import { ensureDir, pathExists, readJson, writeJsonAtomic } from "../core/util.js";
import { auditDraft, jitterSummary } from "../verifier/metrics.js";
import { buildVisualPairs } from "../verifier/visual-diff.js";
import { createRubric } from "../verifier/rubric.js";
import { applyPatch } from "../verifier/patcher.js";
import { runStyleVerify } from "../verifier/style-verify.js";
import { verifyScene } from "../verifier/scene-verify.js";
import { previewFrame, previewRange } from "../core/preview.js";
import { buildAssetSimilaritySection, buildFontCheckSection, buildNotCheckedList, measureEasingCurves } from "../verifier/honesty.js";
import { colourRoundTrip } from "../verifier/colour.js";
import { fullFrameAudit } from "../verifier/full-audit.js";
import { measureAudioSync, sfxSyncWarnings } from "../core/audio-sync.js";
import { styleProbe } from "../core/style-probe.js";
import { styleExport, styleImport, styleList, validateStylePack } from "../core/style-pack.js";
import { loadStylePack, rawProbe } from "../core/raw-probe.js";
import {
  DEFAULT_CAPTION_TYPOGRAPHY,
  buildCaptionsDoc,
  forceAlignScript,
  parseSrt,
  parseVtt,
  parseWordJson,
  wordsFromCues,
  type AudioEnvelopeLike,
  type CaptionTypography,
} from "../core/captions.js";
import { isAspectProfile, safeZonesFor } from "../core/safe-zones.js";
import { buildStatus } from "../core/status.js";
import {
  SYNTH_PRESETS,
  defaultSynthDuration,
  isSynthPreset,
  synthFromAssets,
  synthesizeToWav,
  type SynthMood,
} from "../core/synth-audio.js";
import { shutdownBrowser } from "../core/browser.js";
import {
  approvalErrorMessage,
  approvePlan,
  aspectFromDims,
  checkApprovalGate,
  initPlan,
  loadPlan,
  planDimensions,
  renderPreprod,
  revokeApproval,
} from "../core/preprod.js";
import { ffmpegOk, ffprobeJson } from "../core/ffmpeg.js";
import { exportProject } from "../core/project-export.js";
import { runGuard, type GuardStage } from "../core/guard.js";
import { loadRagIndex, queryRag } from "../core/rag.js";
import { buildContextPack, type ContextStage } from "../core/context-pack.js";
import { getRoleStatus } from "../core/orchestrator-roles.js";
import { autoFixRalph, initRalph, readRalphState } from "../core/ralph.js";
import { patchState, readBrowserPathSync, resolveProcessMode, setProcessMode } from "../core/state.js";
import { doctorSelectBrowser } from "../core/cdp-browser.js";
import { assertBuildMemoryFits, MemoryPreflightError } from "../core/env.js";

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

// [1] Reuse the browser path `ultra doctor` persisted to workspace/state.json —
// no ULTRA_BROWSER_PATH env var needed in later invocations.
program.hook("preAction", () => {
  if (process.env.ULTRA_BROWSER_PATH || process.env.HYPERFRAMES_BROWSER_PATH) return;
  const persisted = readBrowserPathSync(paths().workspace);
  if (persisted) process.env.ULTRA_BROWSER_PATH = persisted;
});

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
    // [1] Test-launch the discovered browser(s) and persist the working path.
    if (process.env.ULTRA_NO_BROWSER !== "1" && (!report.forcedTier || report.forcedTier === "full-cdp")) {
      const selection = await doctorSelectBrowser();
      if (selection.browser) {
        report.browser = {
          available: true,
          kind: selection.browser.kind,
          executablePath: selection.browser.executablePath,
        };
        await patchState(paths().workspace, { browserPath: selection.browser.executablePath });
        if (!report.forcedTier && report.renderTier !== "full-cdp") {
          report.renderTier = "full-cdp";
          report.warnings = report.warnings.filter((warning) => !warning.startsWith("No browser"));
        }
      } else if (selection.attempts.length > 0) {
        report.browser = { available: false, kind: null, executablePath: null };
        report.warnings.push(
          `Browser candidates found but none launched:\n- ${selection.attempts
            .map((attempt) => `${attempt.executablePath} (${attempt.error.split("\n")[0]})`)
            .join("\n- ")}`,
        );
        if (!report.forcedTier) report.renderTier = report.pythonModules.pil ? "browserless-py" : "ffmpeg-only";
      }
    }
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`ultra doctor`);
      console.log(`  renderTier  ${report.renderTier}${report.host ? ` · host=${report.host}` : ""}`);
      console.log(`  os          ${report.os.platform} ${report.os.arch} · ${report.os.cpus} cpus`);
      console.log(`  node        ${report.node}`);
      console.log(`  python      ${report.python ?? "not found"} · PIL ${report.pythonModules.pil ? "yes" : "no"} · numpy ${report.pythonModules.numpy ? "yes" : "no"} · cairosvg ${report.pythonModules.cairosvg ? "yes" : "no"}`);
      console.log(`  fonts       ${report.fonts.count} files · regular ${report.fonts.regular ?? "—"} · bold ${report.fonts.bold ?? "—"} · mono ${report.fonts.mono ?? "—"}`);
      console.log(
        `  bundled     ${report.fonts.bundledFonts.length} offline TTFs${report.fonts.bundledFonts.length ? ` · ${report.fonts.bundledFonts.map((f) => f.file).join(", ")}` : ""}${report.forcedTier ? ` · forcedTier=${report.forcedTier}` : ""}`,
      );
      console.log(`  ffmpeg      ${report.ffmpeg.version ?? "not found"}`);
      console.log(`  ffprobe     ${report.ffprobe.version ?? "not found"}`);
      console.log(`  browser     ${report.browser.kind ?? "not found"}${report.browser.executablePath ? ` (${report.browser.executablePath})` : ""}`);
      console.log(`  disk        tmp ${report.disk.tmpFreeMb ?? "?"} MB free (${report.disk.tmpPath}) · workspace ${report.disk.workspaceFreeMb ?? "?"} MB free`);
      console.log(`  fs          home ${report.fs.homeWritable ? "writable" : "NOT writable"} · .ultra-cache ${report.fs.cacheWritable ? "writable" : "NOT writable"}`);
      console.log(`  memory      ${report.memory.totalMb} MB total · ~${report.memory.estimatedPeakMbForProject} MB estimated peak for this project`);
      console.log(`  remotion    ${report.remotion.installed ? "installed" : "optional — not installed"}`);
      console.log(`  revideo     ${report.revideo.installed ? "installed" : "optional — not installed"}`);
      console.log(`  blender     ${report.blender.version ?? "not found (py-canvas/Three.js fallback)"}`);
      console.log(`  gpu         ${report.gpu.name ?? "not detected"}`);
      for (const warning of report.warnings) console.log(`  warning     ${warning}`);
    }
    if (!report.ok) process.exitCode = 1;
  });

program
  .command("status")
  .description("Agent state tracker: detected process, completed stages, missing prerequisites, exact next command")
  .option("--json", "machine-readable JSON only")
  .action(async (options: { json?: boolean }) => {
    const { workspace, buildDir } = paths();
    const report = await buildStatus({ workspace, buildDir });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`ultra status · ${report.process}`);
    console.log(`  workspace   ${report.workspace}`);
    for (const stage of report.stages) {
      console.log(`  ${stage.done ? "done" : "todo"}  ${stage.name}${stage.note ? ` · ${stage.note}` : ""}`);
    }
    console.log(`  next        ${report.nextCommand}`);
    for (const note of report.notes) console.log(`  note        ${note}`);
  });

program
  .command("plan-init")
  .description("Stage 1: scaffold workspace/plan.json + PLAN.md (concept, palette, typography, storyboard)")
  .option("--mode <mode>", "clone|edit-in-style", "clone")
  .option("--style <slug>", "installed Style Pack for edit-in-style")
  .option("--aspect <aspect>", "16:9|9:16|1:1", "16:9")
  .option("--resolution <resolution>", "4k|1080p", "1080p")
  .option("--force", "overwrite an existing plan.json")
  .action(async (options: { mode: string; style?: string; aspect: string; resolution: string; force?: boolean }) => {
    const { workspace } = paths();
    const mode = options.mode === "edit-in-style" ? "edit-in-style" : "clone";
    if (!isAspectProfile(options.aspect)) throw new CliError("--aspect must be 16:9, 9:16 or 1:1");
    const resolution = options.resolution === "4k" ? "4k" : "1080p";
    const result = await initPlan({
      workspace,
      mode,
      styleSlug: options.style ?? null,
      aspect: options.aspect,
      resolution,
      force: options.force,
    });
    console.log(`plan-init → ${result.planFile}`);
    console.log(`  ${result.plan.meta.aspect} · ${resolution} · ${result.plan.meta.durationSec}s · ${result.plan.shots.length} shots`);
    console.log(`  plan doc → ${result.planMd}`);
    console.log(`  Next: ultra preprod-render  → show build/preprod/moodboard.png + storyboard*.png → WAIT for user approval`);
  });

program
  .command("preprod-render")
  .description("Stage 1: render build/preprod/moodboard.png + storyboard pages with FFmpeg (all render tiers)")
  .action(async () => {
    const { workspace, buildDir } = paths();
    const plan = await loadPlan(workspace);
    if (!plan) throw new CliError("plan.json not found — run `ultra plan-init` first");
    const result = await renderPreprod(workspace, buildDir);
    console.log(`preprod-render → ${result.moodboard}`);
    console.log(`  ${result.width}x${result.height} target · ${plan.shots.length} shots`);
    for (const page of result.storyboards) console.log(`  storyboard → ${page}`);
    console.log(`  Next: show BOTH images to the user, WAIT for explicit approval, then \`ultra approve --by user\``);
  });

program
  .command("approve")
  .description("Stage 1 gate: approve plan.json + ultra.json hash (or --revoke)")
  .option("--by <by>", "user|ci")
  .option("--notes <notes>", "approval notes", "")
  .option("--revoke", "revoke the current approval")
  .action(async (options: { by?: string; notes: string; revoke?: boolean }) => {
    const { workspace } = paths();
    if (options.revoke) {
      const approval = await revokeApproval(workspace, options.by ?? "user", options.notes);
      console.log(`approve --revoke → ${path.join(workspace, "approval.json")} (approved ${approval.approved})`);
      return;
    }
    if (!options.by) throw new CliError("`ultra approve` needs --by user|ci");
    const approval = await approvePlan(workspace, options.by, options.notes);
    console.log(`approve → ${path.join(workspace, "approval.json")}`);
    console.log(`  approved by ${approval.approvedBy} · planHash ${approval.planHash}`);
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
  .description("Rule 1: ffprobe metadata + scene cuts (hard + soft) + onsets + labeled contact sheets [+ geometry]")
  .option("--json", "machine-readable JSON only")
  .option("--geometry", "[6] also write workspace/geometry.json (lines / rects / text regions per segment)")
  .option("--max-segments <n>", "cap palette segments (default: all; truncation is warned)")
  .action(async (reference: string, options: { json?: boolean; geometry?: boolean; maxSegments?: string }) => {
    const { workspace } = paths();
    await ensureDir(workspace);
    const ref = path.resolve(reference);
    const result = await probeReference(ref, workspace, {
      geometry: Boolean(options.geometry),
      ...(options.maxSegments !== undefined ? { maxSegments: Number(options.maxSegments) } : {}),
    });
    await setProcessMode(workspace, "clone-reference");
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`probe → ${path.join(workspace, "probe.json")}`);
      console.log(`  video      ${result.width}x${result.height} @ ${result.fps.numeric}fps (${result.fps.rational}) · ${result.durationSec}s · ${result.pixelFormat}`);
      console.log(`  audio      ${result.audio ? `${result.audio.codec} ${result.audio.sampleRate}Hz ${result.audio.channels}ch` : "none"}`);
      console.log(`  cuts       ${result.cutsSec.length} hard ${JSON.stringify(result.cutsSec)}`);
      if (result.softCutsSec.length > 0) {
        console.log(
          `  soft cuts  ${result.softCutsSec.length} ${JSON.stringify(result.softCutsSec)} (frames ${result.softCutFrames.map((f) => f.frame).join(", ")})`,
        );
      }
      console.log(`  onsets     ${result.onsetsSec.length} ${JSON.stringify(result.onsetsSec.slice(0, 12))}`);
      console.log(`  frames     ${result.frames.length} in probe-frames/`);
      console.log(`  sheets     ${result.contactSheets.join(", ")}`);
      if (options.geometry) console.log(`  geometry   ${path.join(workspace, "geometry.json")}`);
      if (typeof result.containsRealRecording === "boolean") {
        console.log(`  audioSrc   containsRealRecording ${result.containsRealRecording} (heuristic)`);
      }
      if (result.cloneFeasibility) {
        const f = result.cloneFeasibility;
        console.log(
          `  clone      score ${f.score}/100 · ${f.bitratePerPixel.toFixed(3)} bits/px/frame · text ${f.textLegibility} · sharpness ${f.sharpnessEstimate}`,
        );
        for (const warning of f.warnings) console.log(`  warning    ${warning}`);
      }
    }
  });

program
  .command("validate-spec")
  .description("Strict Zod + semantic validation of workspace/ultra.json (incl. ffprobe video-stream duration check)")
  .action(async () => {
    const { workspace } = paths();
    const project = await loadValidatedProject(workspace);
    const mainScenes = project.scenes.filter((s) => !s.overlayOfSceneId).length;
    const overlays = project.scenes.length - mainScenes;

    // [24] meta.durationSec must come from the VIDEO stream, not container/audio
    // length. One frame of mismatch makes verify sample a non-existent frame.
    const source = await resolveSourceVideoPath(workspace, project.meta.sourceVideoPath);
    if (!source) {
      console.log(
        `  warning   meta.sourceVideoPath "${project.meta.sourceVideoPath}" not found (checked cwd + workspace) — duration not measured`,
      );
    } else {
      const streams = await measureStreamDurations(source);
      const videoSec = streams.videoSec;
      if (videoSec !== null) {
        const tolerance = 1 / project.meta.fps + 0.0005;
        const delta = Math.abs(project.meta.durationSec - videoSec);
        if (delta > tolerance) {
          const audioNote = streams.audioSec !== null ? ` · audio stream ${streams.audioSec.toFixed(3)}s` : "";
          throw new CliError(
            `meta.durationSec ${project.meta.durationSec}s does not match the reference VIDEO stream ` +
              `${videoSec.toFixed(3)}s (ffprobe ${path.basename(source)}${audioNote}). ` +
              `Difference ${delta.toFixed(3)}s > 1 frame (${(1 / project.meta.fps).toFixed(4)}s). ` +
              `Set meta.durationSec to the video stream duration — container/audio length samples a non-existent frame.`,
          );
        }
        console.log(
          `  duration  meta ${project.meta.durationSec}s · video stream ${videoSec.toFixed(3)}s (ffprobe ${path.basename(source)}) OK`,
        );
      }
    }
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
        console.log(
          `  - ${item.id} (${item.type}) → ${item.targetPath}${item.similarityTarget ? ` · similarity target ${item.similarityTarget.sceneId} [${item.similarityTarget.startSec}s..${item.similarityTarget.endSec}s]` : ""}`,
        );
      }
    }
    for (const warning of result.warnings) console.log(`  WARNING   ${warning}`);
  });

program
  .command("validate-assets")
  .description("Verify every declared asset exists, is non-empty and matches type rules")
  .action(async () => {
    const { workspace } = paths();
    const project = await loadValidatedProject(workspace);
    const result = await validateAssets(project, workspace);
    for (const warning of result.warnings) console.log(`WARNING ${warning}`);
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
  .option("--proxy", "fast proxy render (max 1280px) with exact aspect for cloud iteration")
  .option("--resolution <resolution>", "proxy|1080p|4k render size override")
  .option("--scene <id>", "[21] render ONLY this scene + 1s handles → build/scene-<id>-preview.mp4")
  .option("--skip-approval", "test-only: bypass the pre-production approval gate")
  .option("--require-approval", "force the Process 2B approval gate even outside edit-in-style")
  .action(async (options: { strictEngine?: boolean; proxy?: boolean; resolution?: string; scene?: string; skipApproval?: boolean; requireApproval?: boolean }) => {
    const { workspace, buildDir } = paths();
    const project = await loadValidatedProject(workspace);
    // [4] Fail before frame 0, not at frame 300/508: RAM preflight.
    try {
      assertBuildMemoryFits(project);
    } catch (err) {
      if (err instanceof MemoryPreflightError) {
        throw new CliError(`[preflight] ${err.message} (run \`ultra doctor --json\` for disk/fs/memory)`);
      }
      throw err;
    }
    const mode = await resolveProcessMode(workspace, project);
    const gate = await checkApprovalGate(workspace, {
      skip: options.skipApproval,
      require: options.requireApproval,
      mode,
      buildDir,
    });
    if (!gate.ok) throw new CliError(approvalErrorMessage(gate));
    const aspect = project.meta.aspectProfile ?? aspectFromDims(project.meta.width, project.meta.height);
    const resolution = options.proxy ? "proxy" : options.resolution;
    const dims =
      resolution === "proxy" || resolution === "1080p" || resolution === "4k"
        ? planDimensions(aspect, resolution)
        : { width: project.meta.width, height: project.meta.height };
    if (options.scene) {
      const preview = await buildScenePreview({
        project,
        workspace,
        buildDir,
        sceneId: options.scene,
        strictEngine: options.strictEngine,
        renderWidth: dims.width,
        renderHeight: dims.height,
      });
      console.log(`build --scene ${preview.sceneId} → ${preview.previewFile}`);
      console.log(
        `  ${preview.clip.engineUsed} ${preview.clip.cached ? "cache" : "rendered"} · cache ${preview.cache.hits}h/${preview.cache.misses}m · other scenes not rendered`,
      );
      console.log(`  manifest ${preview.manifestFile} · contact sheet ${path.join(buildDir, "contact-sheet.png")}`);
      console.log(`Next: ultra verify --scene ${preview.sceneId} "${project.meta.sourceVideoPath}"`);
      return;
    }
    const manifest = await buildProject({
      project,
      workspace,
      buildDir,
      strictEngine: options.strictEngine,
      renderWidth: dims.width,
      renderHeight: dims.height,
    });
    console.log(`build → ${manifest.draftFile} (${manifest.width}x${manifest.height} · ${manifest.durationSec}s @ ${manifest.fps}fps)`);
    for (const scene of manifest.scenes) {
      console.log(
        `  ${scene.sceneId.padEnd(18)} ${scene.engineUsed.padEnd(12)} ${scene.cached ? "cache" : "rendered"} ${scene.fallback ? "· fallback" : ""} ${scene.notes.length ? `· ${scene.notes[0]}` : ""}`,
      );
    }
    console.log(`  transitions ${manifest.stitch.transitionCount} · overlays ${manifest.stitch.overlayCount} · cache ${manifest.cache.hits}h/${manifest.cache.misses}m`);
    console.log(`  contact sheet ${path.join(buildDir, "contact-sheet.png")}`);
  });

program
  .command("preview")
  .description("[20] render ONE frame or a frame range without a full build (full-cdp)")
  .option("--frame <n>", "frame index to preview (side-by-side + diff vs the reference)")
  .option("--from <f>", "first frame of a range")
  .option("--to <t>", "last frame of a range (inclusive)")
  .option("--ref <file>", "reference video override (default meta.sourceVideoPath)")
  .option("--proxy", "use the proxy resolution", false)
  .action(async (options: { frame?: string; from?: string; to?: string; ref?: string; proxy?: boolean }) => {
    const { workspace, buildDir } = paths();
    const project = await loadValidatedProject(workspace);
    const aspect = project.meta.aspectProfile ?? aspectFromDims(project.meta.width, project.meta.height);
    const dims = options.proxy ? planDimensions(aspect, "proxy") : { width: project.meta.width, height: project.meta.height };
    const ctx = {
      project,
      workspace,
      buildDir,
      width: dims.width,
      height: dims.height,
      ...(options.ref ? { referenceFile: path.resolve(options.ref) } : {}),
    };
    if (options.frame !== undefined) {
      const frame = Number(options.frame);
      if (!Number.isFinite(frame) || frame < 0 || Math.floor(frame) !== frame) throw new CliError("--frame must be a non-negative integer");
      const result = await previewFrame(ctx, frame);
      console.log(`preview --frame ${frame} → ${result.frameFile}`);
      if (result.diffFile) console.log(`  diff → ${result.diffFile}`);
      console.log(`  scene ${result.sceneId} · t ${result.timestampSec}s · no full build performed`);
      return;
    }
    if (options.from !== undefined && options.to !== undefined) {
      const from = Number(options.from);
      const to = Number(options.to);
      if (!Number.isFinite(from) || !Number.isFinite(to)) throw new CliError("--from/--to must be integers");
      const result = await previewRange(ctx, from, to);
      console.log(`preview --from ${from} --to ${to} → ${result.rangeFile}`);
      console.log(`  ${result.frames} frames · scenes ${result.scenes.join(", ")} · contact sheet ${path.join(buildDir, "contact-sheet.png")}`);
      return;
    }
    throw new CliError("preview needs --frame <n> or --from <f> --to <t>");
  });

program
  .command("verify [reference]")
  .description("Rule 5: 2A `verify <ref.mp4>` (1:1 clone) · 2B `verify --style <slug>` (edit in style)")
  .option("--draft <path>", "draft video to audit", "build/draft.mp4")
  .option("--style <slug>", "Process 2B: verify against an installed Style Pack")
  .option("--scene <id>", "[21] verify ONE scene only (metrics + visual-diff + lint)")
  .option("--full", "[25] SSIM for EVERY frame (required to claim 'matches reference')")
  .action(async (reference: string | undefined, options: { draft: string; style?: string; scene?: string; full?: boolean }) => {
    const { workspace, buildDir } = paths();
    const project = await loadValidatedProject(workspace);
    if (options.scene) {
      if (options.style) throw new CliError("--scene and --style cannot be combined");
      if (!reference) throw new CliError("verify --scene needs a reference video: ultra verify --scene <id> <ref.mp4>");
      const sceneRef = path.resolve(reference);
      if (!(await pathExists(sceneRef))) throw new CliError(`Reference video not found: ${sceneRef}`);
      const result = await verifyScene({ project, sceneId: options.scene, reference: sceneRef, workspace, buildDir });
      const metrics = result.report.quantitative;
      console.log(`verify --scene ${options.scene} → ${result.reportFile}`);
      console.log(
        `  duration  Δ${metrics.durationDeltaSec >= 0 ? "+" : ""}${metrics.durationDeltaSec}s ${metrics.durationOk ? "OK" : "FAIL"} · fps ${metrics.fpsActual ?? "?"} ${metrics.fpsOk ? "OK" : "FAIL"} · cfr ${metrics.cfr ? "OK" : "FAIL"}`,
      );
      console.log(
        `  motion    stutterEvents ${metrics.stutterEvents} (${metrics.jitterOk ? "OK" : "FAIL"}) · black frames ${metrics.blackDetections.length} ${metrics.blackOk ? "OK" : "FAIL"}`,
      );
      console.log(
        `  lint      ${result.report.lint.defectCount} defects (${result.report.lint.criticalDefectCount} critical) ${result.report.lint.pass ? "OK" : "FAIL"}`,
      );
      console.log(`  pairs     ${result.pairs.length} → ${path.join(buildDir, "audit-frames", `scene-${options.scene}`, "pair_*.png")}`);
      if (!result.report.pass) {
        console.log(`  RESULT    FAIL — patch the scene, then ultra build --scene ${options.scene} && ultra verify --scene ${options.scene}`);
        process.exitCode = 1;
      } else {
        console.log(`  RESULT    PASS (scene only) — run \`ultra build\` + full \`ultra verify\` before render`);
      }
      return;
    }
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
      const method = project.meta.method ?? "native";
      const fontCheck = await buildFontCheckSection(project, workspace);
      const notChecked = buildNotCheckedList({
        hasAudio: metrics.loudness !== null,
        hasFullAudit: false,
        hasReference: false,
        fontMatched: false,
      });
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
        rubric: createRubric(method),
        method,
        ...(jitterSummary(metrics.jitterDraft) ? { jitterDraft: jitterSummary(metrics.jitterDraft) } : {}),
        jitterUnmatchedEvents: metrics.jitterUnmatchedEvents,
        fontCheck,
        style: { slug: options.style, compliance, matchSheet: result.matchSheet },
        notChecked,
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
      for (const defect of lint.scenes.flatMap((scene) => scene.defects).slice(0, 12)) {
        console.log(`    - [${defect.critical ? "critical" : "warning"}] ${defect.sceneId} (${defect.category}): ${defect.detail}`);
      }
      console.log(
        `  style     asl ${compliance.aslOk ? "OK" : "FAIL"} · holds ${compliance.staticHoldOk ? "OK" : "FAIL"} · transitions ${compliance.transitionsOk ? "OK" : "FAIL"} · palette ${compliance.paletteOk ? "OK" : "FAIL"} (Δ${compliance.paletteDistanceAvg}) · loudness ${compliance.loudnessOk ? "OK" : "FAIL"}`,
      );
      for (const detail of compliance.details.slice(0, 12)) console.log(`    - ${detail}`);
      console.log(`  match     ${result.matchSheet ?? "not generated"} (STYLE EXEMPLAR vs YOUR EDIT)`);
      console.log(`  method    ${method} · fonts ${fontCheck.score}/100${fontCheck.unavailableFonts.length ? ` (unavailable: ${fontCheck.unavailableFonts.join(", ")})` : ""}`);
      if (!report.pass) {
        console.log(`  RESULT    FAIL — patch weak scenes, then rerun \`ultra build && ultra verify --style ${options.style}\``);
        process.exitCode = 1;
      } else {
        console.log(`  RESULT    PASS — run \`ultra render\` for the final broadcast MP4`);
      }
      console.log(`  notChecked: ${JSON.stringify(notChecked)}`);
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

    // [23]/[25]/[26]/[27]/[29]/[16] honesty + measurement sections.
    const method = project.meta.method ?? "native";
    const assetSimilarity = await buildAssetSimilaritySection(project, workspace);
    const fontCheck = await buildFontCheckSection(project, workspace);
    const easing = await measureEasingCurves(ref, draft, project);
    const colour = await colourRoundTrip(project, workspace, buildDir);
    const audioSync = await measureAudioSync(ref, draft);
    const sfxWarnings = await sfxSyncWarnings(project, workspace);
    let fullAudit: VerifyReportT["fullAudit"];
    if (options.full) {
      const full = await fullFrameAudit({ reference: ref, draft, fps: project.meta.fps, outDir: path.join(buildDir, "audit-frames") });
      fullAudit = { frameCount: full.frameCount, mean: full.mean, p10: full.p10, worst20: full.worst20 };
    }
    const notChecked = buildNotCheckedList({
      hasAudio: metrics.loudness !== null,
      hasFullAudit: Boolean(fullAudit),
      hasReference: true,
      fontMatched: false,
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
      rubric: createRubric(method),
      method,
      ...(jitterSummary(metrics.jitterDraft) ? { jitterDraft: jitterSummary(metrics.jitterDraft) } : {}),
      ...(jitterSummary(metrics.jitterReference) ? { jitterReference: jitterSummary(metrics.jitterReference) } : {}),
      jitterUnmatchedEvents: metrics.jitterUnmatchedEvents,
      ...(assetSimilarity ? { assetSimilarity } : {}),
      fontCheck,
      easing,
      ...(colour ? { colour } : {}),
      audioSyncOffsetMs: audioSync?.offsetMs ?? null,
      ...(sfxWarnings.length > 0 ? { sfxWarnings } : {}),
      ...(fullAudit ? { fullAudit } : {}),
      notChecked,
      pass: metrics.pass && lint.pass,
    };
    VerifyReport.parse(report);
    await writeJsonAtomic(reportFile, report);

    console.log(`verify → ${reportFile}`);
    console.log(`  method    ${method} · reference for measurement only (native bans reference frames as assets)`);
    console.log(
      `  duration  Δ${metrics.durationDeltaSec >= 0 ? "+" : ""}${metrics.durationDeltaSec}s ${metrics.durationOk ? "OK" : "FAIL"} · fps ${metrics.fpsActual ?? "?"} ${metrics.fpsOk ? "OK" : "FAIL"} · cfr ${metrics.cfr ? "OK" : "FAIL"}`,
    );
    console.log(
      `  motion    stutterEvents ${metrics.stutterEvents} NEW (${metrics.jitterOk ? "OK" : "FAIL"}) · reference holds ${jitterSummary(metrics.jitterReference)?.staticHoldFrames ?? "n/a"}f · static holds ${metrics.staticHoldFrames}f (${(metrics.staticHoldRatio * 100).toFixed(1)}%) · black frames ${metrics.blackDetections.length} ${metrics.blackOk ? "OK" : "FAIL"}`,
    );
    for (const event of metrics.jitterUnmatchedEvents.slice(0, 6)) {
      console.log(`    - NEW stutter at ${event.atSec}s (frames ${event.startFrame}..+${event.length}) not present in the reference`);
    }
    console.log(
      `  audio     ${metrics.loudness ? `${metrics.loudness.inputI ?? "?"} LUFS ${metrics.loudness.ok ? "OK" : "FAIL"}` : "no audio stream"}${audioSync ? ` · sync offset ${audioSync.offsetMs} ms (corr ${audioSync.correlation})` : ""}`,
    );
    for (const warning of sfxWarnings.slice(0, 6)) {
      console.log(`    - SFX "${warning.assetId}" at ${warning.atSec}s is ${warning.distanceMs} ms from the nearest onset/cut (${warning.nearestSec ?? "?"}s)`);
    }
    console.log(`  lint      ${lint.defectCount} defects (${lint.criticalDefectCount} critical) ${lint.pass ? "OK" : "FAIL"}`);
    const defects = lint.scenes.flatMap((s) => s.defects);
    for (const defect of defects.slice(0, 12)) {
      console.log(`    - [${defect.critical ? "critical" : "warning"}] ${defect.sceneId} (${defect.category}): ${defect.detail}`);
    }
    console.log(`  pairs     ${pairs.length} → build/audit-frames/pair_*.png (Left: ORIGINAL · Right: DRAFT)`);
    if (assetSimilarity && assetSimilarity.length > 0) {
      console.log(`  assets    ${assetSimilarity.length} compared to reference segments · fonts ${fontCheck.score}/100${fontCheck.unavailableFonts.length ? ` (unavailable: ${fontCheck.unavailableFonts.join(", ")})` : ""}`);
      for (const item of assetSimilarity.filter((entry) => entry.warnings.length > 0)) {
        console.log(`    - asset "${item.assetId}" score ${item.score ?? "?"} (ssim ${item.ssim ?? "?"}, histogram ${item.histogramDistance ?? "?"}, edge ${item.edgeDensityRatio ?? "?"}): ${item.warnings[0]}`);
      }
    } else {
      console.log(`  assets    not measured (run \`ultra validate-assets\` to write workspace/assets.manifest.json) · fonts ${fontCheck.score}/100`);
    }
    const measuredEasing = easing.filter((entry) => entry.curveError !== null);
    console.log(
      `  easing    ${measuredEasing.length}/${easing.length} scenes measurable${measuredEasing.length ? ` · worst ${Math.max(...measuredEasing.map((entry) => entry.curveError as number)).toFixed(1)} px` : ""}`,
    );
    for (const entry of measuredEasing.filter((item) => (item.curveError as number) > 12).slice(0, 6)) {
      console.log(`    - scene ${entry.sceneId} motion curve error ${entry.curveError} px (${entry.samples} frames)`);
    }
    if (colour) {
      const drifted = colour.filter((entry) => entry.deltaE > 3);
      console.log(`  colour    ${colour.length} palette colours round-tripped · ${drifted.length} over ΔE 3 (CIE76)`);
      for (const entry of drifted) console.log(`    - ${entry.name} ${entry.intendedHex} → ${entry.measuredHex} ΔE ${entry.deltaE}`);
    }
    if (fullAudit) {
      const worst = fullAudit.worst20[0];
      console.log(
        `  full      ${fullAudit.frameCount} frames · mean SSIM ${fullAudit.mean} · p10 ${fullAudit.p10} · worst ${worst ? `${worst.ssim} @ frame ${worst.frame}` : "n/a"} → build/audit-frames/worst_*.png`,
      );
    }
    console.log(`  rubric    5×20 pts template ready for the agent (pass threshold 90, method ${method})`);
    if (!report.pass) {
      console.log(`  RESULT    FAIL — patch failing scenes, then rerun \`ultra build && ultra verify\``);
      process.exitCode = 1;
    } else {
      console.log(`  RESULT    PASS — run \`ultra render\` for the final broadcast MP4`);
    }
    console.log(`  notChecked: ${JSON.stringify(notChecked)}`);
  });

program
  .command("style-probe <videos...>")
  .description("Process 1 · Rule 1: batch-probe 1–10 reference videos into workspace/style-probe")
  .option("--out <dir>", "output directory", "workspace/style-probe")
  .option("--hook-window <sec>", "hook window seconds", "5")
  .action(async (videos: string[], options: { out: string; hookWindow: string }) => {
    const result = await styleProbe(videos, path.resolve(options.out), Number(options.hookWindow));
    await setProcessMode(paths().workspace, "extract-style");
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
  .option("--aspect <aspect>", "9:16|16:9|1:1 platform safe zones", "16:9")
  .action(async (video: string, options: { style: string; out: string; aspect: string }) => {
    if (!isAspectProfile(options.aspect)) throw new CliError(`--aspect must be 9:16, 16:9 or 1:1 (got "${options.aspect}")`);
    const result = await rawProbe(video, options.style, options.out, options.aspect);
    await setProcessMode(paths().workspace, "edit-in-style");
    console.log(`raw-probe → ${path.join(result.outputDir, "raw-edit-plan.json")}`);
    console.log(`  source ${result.plan.durationSec}s @ ${result.plan.fps}fps · style ${options.style} · aspect ${result.plan.aspect}`);
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
  .command("captions-align")
  .description("Word-level caption alignment: SRT/VTT/word-JSON or script+audio-envelope forced alignment → workspace/captions.json")
  .option("--out <path>", "output captions JSON", "workspace/captions.json")
  .option("--srt <file>", "SubRip .srt captions")
  .option("--vtt <file>", "WebVTT .vtt captions")
  .option("--words <file>", "word-level timestamp JSON")
  .option("--script <file>", "plain script text (requires --envelope)")
  .option("--envelope <file>", "audio envelope JSON for forced alignment", "workspace/raw-probe/audio-envelope.json")
  .option("--style <slug>", "Style Pack for caption chunking / highlight typography")
  .option("--aspect <aspect>", "9:16|16:9|1:1 platform safe zones", "9:16")
  .action(async (options: {
    out: string;
    srt?: string;
    vtt?: string;
    words?: string;
    script?: string;
    envelope: string;
    style?: string;
    aspect: string;
  }) => {
    if (!isAspectProfile(options.aspect)) throw new CliError(`--aspect must be 9:16, 16:9 or 1:1 (got "${options.aspect}")`);
    const inputs = [options.srt, options.vtt, options.words, options.script].filter((v): v is string => Boolean(v));
    if (inputs.length !== 1) {
      throw new CliError("captions-align needs exactly ONE input: --srt <file>, --vtt <file>, --words <file> or --script <file>");
    }

    let typography: CaptionTypography = { ...DEFAULT_CAPTION_TYPOGRAPHY };
    let minWords = 2;
    let maxWords = 4;
    if (options.style) {
      try {
        const { style } = await loadStylePack(options.style);
        typography = {
          captionFont: style.typography.captionFont,
          casing: style.typography.casing,
          activeWordHighlight: style.typography.activeWordHighlight,
          strokePx: style.typography.strokePx,
        };
        minWords = style.typography.captionChunkWords[0] as number;
        maxWords = style.typography.captionChunkWords[1] as number;
      } catch (err) {
        throw new CliError(`--style ${options.style}: ${(err as Error).message}`);
      }
    }

    let words;
    let sourceKind: "srt" | "vtt" | "words" | "script-forced";
    let sourceInput: string;
    if (options.srt) {
      sourceKind = "srt";
      sourceInput = path.resolve(options.srt);
      words = wordsFromCues(parseSrt(await fs.readFile(sourceInput, "utf8").catch(() => {
        throw new CliError(`cannot read --srt ${sourceInput}`);
      })));
    } else if (options.vtt) {
      sourceKind = "vtt";
      sourceInput = path.resolve(options.vtt);
      words = wordsFromCues(parseVtt(await fs.readFile(sourceInput, "utf8").catch(() => {
        throw new CliError(`cannot read --vtt ${sourceInput}`);
      })));
    } else if (options.words) {
      sourceKind = "words";
      sourceInput = path.resolve(options.words);
      const raw = JSON.parse(await fs.readFile(sourceInput, "utf8").catch(() => {
        throw new CliError(`cannot read --words ${sourceInput}`);
      })) as unknown;
      words = parseWordJson(raw);
    } else {
      sourceKind = "script-forced";
      sourceInput = path.resolve(options.script as string);
      const script = await fs.readFile(sourceInput, "utf8").catch(() => {
        throw new CliError(`cannot read --script ${sourceInput}`);
      });
      const envelopePath = path.resolve(options.envelope);
      let envelopeRaw: unknown;
      try {
        envelopeRaw = JSON.parse(await fs.readFile(envelopePath, "utf8"));
      } catch {
        throw new CliError(
          `--script forced alignment needs an audio envelope at ${envelopePath}. Run \`ultra probe\` / \`ultra raw-probe\` first or pass --envelope <audio-envelope.json>.`,
        );
      }
      const candidate = (envelopeRaw as Record<string, unknown>)?.["envelope"] ?? envelopeRaw;
      const envelope = candidate as AudioEnvelopeLike;
      if (!envelope || !Array.isArray(envelope.frames) || envelope.frames.length === 0) {
        throw new CliError(`envelope ${envelopePath} has no frames[] — regenerate it with ultra probe / raw-probe`);
      }
      const aligned = forceAlignScript(script, envelope);
      words = aligned.words;
    }

    const doc = buildCaptionsDoc(words, {
      aspect: options.aspect,
      source: { kind: sourceKind, input: sourceInput },
      style: options.style ?? null,
      typography,
      minWords,
      maxWords,
    });
    const out = path.resolve(options.out);
    await ensureDir(path.dirname(out));
    await writeJsonAtomic(out, doc);
    const zones = safeZonesFor(options.aspect);
    console.log(`captions-align → ${out}`);
    console.log(
      `  ${doc.stats.words} words · ${doc.stats.chunks} chunks · ${doc.stats.activeSpeechSec}s active speech · aspect ${doc.aspect} · style ${doc.style ?? "none"}`,
    );
    console.log(
      `  safeBox   x ${zones.captionBand.x * 100}% · y ${zones.captionBand.y * 100}% · w ${zones.captionBand.width * 100}% · h ${zones.captionBand.height * 100}% (fully inside safeRect)`,
    );
    const first = doc.chunks[0];
    if (first) console.log(`  chunk 1   ${first.startSec}s→${first.endSec}s "${first.text}"${first.emphasis ? " · emphasis" : ""}`);
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
  .option("--4k", "master at exact 4K dimensions (hybrid upscale by default)")
  .option("--resolution <resolution>", "1080p|4k delivery override")
  .option("--4k-strategy <strategy>", "hybrid|native", "hybrid")
  .option("--skip-approval", "test-only: bypass the pre-production approval gate")
  .option("--require-approval", "force the Process 2B approval gate even outside edit-in-style")
  .action(async (options: {
    out: string;
    force?: boolean;
    crf: string;
    "4k"?: boolean;
    resolution?: string;
    "4kStrategy": string;
    skipApproval?: boolean;
    requireApproval?: boolean;
  }) => {
    const { workspace, buildDir } = paths();
    const project = await loadValidatedProject(workspace);
    const mode = await resolveProcessMode(workspace, project);
    const gate = await checkApprovalGate(workspace, {
      skip: options.skipApproval,
      require: options.requireApproval,
      mode,
      buildDir,
    });
    if (!gate.ok) throw new CliError(approvalErrorMessage(gate));
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
    const aspect = project.meta.aspectProfile ?? aspectFromDims(manifest.width, manifest.height);
    const wants4k =
      options["4k"] === true ||
      options.resolution === "4k" ||
      (options.resolution === undefined && project.meta.deliveryResolution === "4k");
    const target = wants4k ? planDimensions(aspect, "4k") : { width: manifest.width, height: manifest.height };
    const strategy = options["4kStrategy"] === "native" ? "native" : "hybrid";
    if (wants4k && strategy === "native" && (manifest.width !== target.width || manifest.height !== target.height)) {
      throw new CliError(
        `--4k-strategy native needs a 4K build first (manifest is ${manifest.width}x${manifest.height}). Run \`ultra build --resolution 4k\` or use --4k-strategy hybrid.`,
      );
    }

    const masterSource = wants4k ? path.join(buildDir, "tmp", "master-source.mp4") : outFile;
    await ensureDir(path.dirname(masterSource));
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
      outFile: masterSource,
      crf: Number(options.crf),
      preset: "slow",
    });

    let finalWidth = manifest.width;
    let finalHeight = manifest.height;
    const deliveryStrategy = wants4k ? (strategy === "native" ? "native-rerender" : "hybrid-upscale") : "direct";
    if (wants4k) {
      finalWidth = target.width;
      finalHeight = target.height;
      const upscale = manifest.width !== target.width || manifest.height !== target.height;
      const videoFilters = [
        ...(upscale
          ? [`scale=${target.width}:${target.height}:flags=lanczos+accurate_rnd+full_chroma_int`, "unsharp=5:5:0.35:5:5:0.0"]
          : []),
        "scale=out_range=tv",
        "format=yuv420p",
      ].join(",");
      await ffmpegOk(
        [
          "-hide_banner",
          "-y",
          "-i",
          masterSource,
          "-vf",
          videoFilters,
          "-c:v",
          "libx264",
          "-profile:v",
          "high",
          "-level:v",
          "5.1",
          "-preset",
          "slow",
          "-crf",
          "16",
          "-pix_fmt",
          "yuv420p",
          "-color_range",
          "tv",
          "-colorspace",
          "bt709",
          "-color_primaries",
          "bt709",
          "-color_trc",
          "bt709",
          "-r",
          String(manifest.fps),
          "-fps_mode",
          "cfr",
          ...(result.hasAudio ? ["-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-ac", "2"] : []),
          "-movflags",
          "+faststart",
          outFile,
        ],
        { timeoutMs: 45 * 60_000 },
      );
      await fs.rm(masterSource, { force: true });
    }

    const probe = await ffprobeJson(outFile);
    const video = probe.streams.find((stream: { codec_type?: string }) => stream.codec_type === "video") as
      | { codec_name?: string; width?: number; height?: number; pix_fmt?: string; r_frame_rate?: string; avg_frame_rate?: string }
      | undefined;
    const audio = probe.streams.find((stream: { codec_type?: string }) => stream.codec_type === "audio") as
      | { codec_name?: string; sample_rate?: string; channels?: number }
      | undefined;
    const checks = {
      widthOk: video?.width === finalWidth,
      heightOk: video?.height === finalHeight,
      pixFmtOk: video?.pix_fmt === "yuv420p",
      fpsOk: video?.r_frame_rate === video?.avg_frame_rate,
      audioOk: !result.hasAudio || Boolean(audio),
      durationOk: Math.abs(Number(probe.format?.duration) - project.meta.durationSec) <= 0.15,
    };
    const deliveryManifest = {
      generatedAt: new Date().toISOString(),
      resolution: wants4k ? "4k" : "1080p",
      aspect,
      target: { width: finalWidth, height: finalHeight },
      strategy: deliveryStrategy,
      source: { width: manifest.width, height: manifest.height, draft: manifest.draftFile },
      fps: manifest.fps,
      video: { codec: video?.codec_name ?? null, pixFmt: video?.pix_fmt ?? null, rFrameRate: video?.r_frame_rate ?? null },
      audio: audio
        ? { codec: audio.codec_name ?? null, sampleRate: audio.sample_rate ?? null, channels: audio.channels ?? null, bitrate: "320k" }
        : null,
      audioOrigins: [] as { assetId: string; origin: string }[],
      durationSec: Number(probe.format?.duration ?? 0),
      files: { master: outFile },
      checks,
      pass: Object.values(checks).every(Boolean),
    };
    // [30] Carry audio provenance labels through the delivery manifest.
    try {
      const manifestFile = path.join(workspace, "assets.manifest.json");
      if (await pathExists(manifestFile)) {
        const assetsManifest = (await readJson(manifestFile)) as { assets?: Record<string, { origin?: string }> };
        deliveryManifest.audioOrigins = Object.entries(assetsManifest.assets ?? {})
          .filter(([, check]) => typeof check.origin === "string")
          .map(([assetId, check]) => ({ assetId, origin: check.origin as string }));
      }
    } catch {
      // provenance labels are best-effort, never block delivery
    }
    await writeJsonAtomic(path.join(buildDir, "delivery-manifest.json"), deliveryManifest);
    await writeJsonAtomic(path.join(buildDir, "render-manifest.json"), {
      renderedAt: new Date().toISOString(),
      outFile,
      crf: Number(options.crf),
      result,
      delivery: deliveryManifest,
    });
    if (!deliveryManifest.pass) {
      throw new CliError(`delivery assertions failed: ${JSON.stringify(checks)}\n${JSON.stringify(deliveryManifest, null, 2)}`);
    }
    console.log(`render → ${outFile}`);
    console.log(
      `  ${result.durationSec}s · ${manifest.fps}fps · ${finalWidth}x${finalHeight} · strategy ${deliveryStrategy} · ${result.transitionCount} transitions · ${result.overlayCount} alpha overlays · ${result.hasAudio ? "AAC 320k audio + loudnorm" : "no audio"}`,
    );
    console.log(`  delivery-manifest.json checks ${JSON.stringify(checks)}`);
  });

program
  .command("export-project")
  .description("Stage 3: export FCPXML + OTIO + editable Ultra template + offline inspector zip")
  .option("--out <dir>", "output directory", "build/editable-project")
  .option("--zip <path>", "zip path", "build/editable-project.zip")
  .action(async (options: { out: string; zip: string }) => {
    const { workspace, buildDir } = paths();
    const result = await exportProject({
      workspace,
      buildDir,
      outDir: path.resolve(options.out),
      zipPath: path.resolve(options.zip),
    });
    const manifestFile = path.join(buildDir, "delivery-manifest.json");
    if (await pathExists(manifestFile)) {
      const manifest = (await readJson(manifestFile)) as Record<string, unknown>;
      const files = { ...((manifest["files"] as Record<string, unknown>) ?? {}), editableZip: result.zip };
      const checks = {
        ...((manifest["checks"] as Record<string, unknown>) ?? {}),
        editableZipOk: result.zipBytes > 0,
      };
      await writeJsonAtomic(manifestFile, { ...manifest, files, checks, pass: Object.values(checks).every(Boolean) });
    }
    console.log(`export-project → ${result.dir}`);
    console.log(`  ${result.files.length} files · ${result.width}x${result.height} · FCPXML ${path.basename(result.fcpxml)} · OTIO ${path.basename(result.otio)} · inspector ${path.basename(result.inspector)}`);
    console.log(`  zip → ${result.zip} (${(result.zipBytes / 1024).toFixed(1)} KiB, CRC verified)`);
  });

program
  .command("guard")
  .description("Hallucination + evidence guard (grounding, placeholders, ffprobe/delivery assertions)")
  .option("--stage <stage>", "plan|build|verify|delivery", "plan")
  .option("--json", "machine-readable JSON")
  .action(async (options: { stage: string; json?: boolean }) => {
    const { workspace, buildDir } = paths();
    const stage: GuardStage = ["plan", "build", "verify", "delivery"].includes(options.stage)
      ? (options.stage as GuardStage)
      : "plan";
    const report = await runGuard(workspace, buildDir, stage);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`guard (${stage}) → ${report.ok ? "PASS" : "FAIL"}`);
      for (const error of report.errors) console.log(`  ERROR ${error.check}: ${error.detail}`);
      for (const warning of report.warnings) console.log(`  warn  ${warning.check}: ${warning.detail}`);
    }
    if (!report.ok) process.exitCode = 1;
  });

const ragCommand = program.command("rag").description("Offline BM25 project knowledge retrieval");
ragCommand
  .command("query <query>")
  .description("Rank styles/motifs/rules/sfx for a query")
  .option("--kind <kind>", "style|motif|sfx|rule|skill|effect")
  .option("--aspect <aspect>", "9:16|16:9|1:1")
  .option("--top <n>", "result count", "5")
  .option("--json", "machine-readable JSON")
  .action(async (query: string, options: { kind?: string; aspect?: string; top: string; json?: boolean }) => {
    const index = await loadRagIndex();
    const hits = queryRag(index, query, {
      ...(options.kind ? { kind: options.kind as never } : {}),
      ...(options.aspect && isAspectProfile(options.aspect) ? { aspect: options.aspect } : {}),
      top: Number(options.top) || 5,
    });
    if (options.json) {
      console.log(JSON.stringify({ query, hits }, null, 2));
      return;
    }
    console.log(`rag query "${query}" → ${hits.length} hits`);
    for (const hit of hits) console.log(`  ${hit.score.toFixed(3)} [${hit.kind}] ${hit.title} · ${hit.path}`);
  });

program
  .command("context-pack")
  .description("Stage-scoped token-budgeted markdown brief (rules + RAG + blockers + next command)")
  .option("--stage <stage>", "preprod|assets|build|verify|fix|master", "preprod")
  .option("--budget-tokens <n>", "token budget (chars/4 estimate)", "3500")
  .option("--out <path>", "output markdown", "workspace/context/brief.md")
  .action(async (options: { stage: string; budgetTokens: string; out: string }) => {
    const { workspace, buildDir } = paths();
    const stage = (["preprod", "assets", "build", "verify", "fix", "master"].includes(options.stage)
      ? options.stage
      : "preprod") as ContextStage;
    const result = await buildContextPack({
      workspace,
      buildDir,
      stage,
      budgetTokens: Number(options.budgetTokens) || 3500,
      outFile: path.resolve(options.out),
    });
    console.log(`context-pack (${stage}) → ${result.path}`);
    console.log(`  ~${result.estimatedTokens} tokens · ${result.hits.length} RAG hits · ${result.blockers.length} blockers`);
    console.log(`  next: ${result.nextCommand}`);
  });

program
  .command("orchestrate")
  .description("Sub-agent role orchestration: active role, artifact contract, parallel-safe steps")
  .option("--status", "show the active role status")
  .option("--next-role", "show the next role and contract")
  .option("--json", "machine-readable JSON")
  .action(async (options: { status?: boolean; nextRole?: boolean; json?: boolean }) => {
    const { workspace, buildDir } = paths();
    const status = await getRoleStatus(workspace, buildDir);
    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(`orchestrate · ${status.activeRole} (${status.title}) · stage ${status.stage}`);
    console.log(`  inputs   ${status.inputContract.join(" · ")}`);
    console.log(`  outputs  ${status.outputContract.join(" · ")}`);
    console.log(`  next     ${status.nextCommand}`);
    console.log(`  model    ${status.executionModel}`);
  });

const ralphCommand = program.command("ralph").description("Bounded deterministic Ralph verify/fix loop");
ralphCommand
  .command("init")
  .description("Initialize workspace/ralph-state.json with a machine-checkable completion promise")
  .option("--max-iter <n>", "maximum iterations", "5")
  .option("--min-score <n>", "minimum score", "90")
  .option("--target-4k", "require 4K delivery in the completion promise")
  .action(async (options: { maxIter: string; minScore: string; target4k?: boolean }) => {
    const { workspace } = paths();
    const state = await initRalph(workspace, {
      maxIter: Number(options.maxIter),
      minScore: Number(options.minScore),
      target4k: options.target4k,
    });
    console.log(`ralph init → ${path.join(workspace, "ralph-state.json")}`);
    console.log(`  maxIter ${state.maxIter} · minScore ${state.minScore} · promise ${state.completionPromise}`);
  });
ralphCommand
  .command("auto-fix")
  .description("Deterministically repair safe zones, contrast, transitions and loudness until the promise is met")
  .action(async () => {
    const { workspace, buildDir } = paths();
    const state = await autoFixRalph(workspace, buildDir);
    console.log(`ralph auto-fix → ${state.status} · attempts ${state.attempt}/${state.maxIter} · best score ${state.bestScore ?? "—"}`);
    console.log(`  history → ${path.join(workspace, "ralph-history.md")}`);
    if (state.status !== "satisfied") process.exitCode = 1;
  });
ralphCommand
  .command("status")
  .description("Report current attempt, remaining budget, failing gates and completion promise")
  .option("--json", "machine-readable JSON")
  .action(async (options: { json?: boolean }) => {
    const { workspace } = paths();
    const state = await readRalphState(workspace);
    if (options.json) {
      console.log(JSON.stringify(state, null, 2));
      return;
    }
    if (!state) {
      console.log("ralph: not initialized (run `ultra ralph init`)");
      return;
    }
    console.log(`ralph ${state.status} · attempt ${state.attempt}/${state.maxIter} · best ${state.bestScore ?? "—"} / min ${state.minScore}`);
    console.log(`  promise ${state.completionPromise}`);
    console.log(`  satisfied ${state.status === "satisfied"}`);
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
