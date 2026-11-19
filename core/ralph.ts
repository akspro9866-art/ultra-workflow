import { promises as fs } from "node:fs";
import path from "node:path";
import type { SceneSpecT, UltraProjectT } from "./schema.js";
import { SceneSpec, UltraProject } from "./schema.js";
import { loadProject, validateProjectSemantics } from "./project.js";
import { buildProject, lintProject, cacheDir } from "./orchestrator.js";
import { auditDraft } from "../verifier/metrics.js";
import { loadStylePack } from "./raw-probe.js";
import { resolveAssetPath } from "./assets.js";
import { defaultSynthDuration, inferSynthPreset, synthesizeToWav } from "./synth-audio.js";
import { loadPlan, aspectFromDims, planDimensions } from "./preprod.js";
import { resolveAspectProfile, safeZonesFor, captionSafeBox, dangerZoneForPixelBox } from "./safe-zones.js";
import { ensureDir, pathExists, readJson, sha1, writeJsonAtomic } from "./util.js";
import type { StylePackT } from "./style-schema.js";

export interface RalphState {
  version: 1;
  createdAt: string;
  maxIter: number;
  minScore: number;
  target4k: boolean;
  completionPromise: string;
  status: "running" | "satisfied" | "stalled" | "exhausted";
  attempt: number;
  bestScore: number | null;
  bestSnapshot: string | null;
  history: { attempt: number; score: number; stutterEvents: number; lintCritical: number; lintWarnings: number; hash: string; fixes: number }[];
  updatedAt: string;
}

const RALPH_FILE = "ralph-state.json";
const BEST_DIR = path.resolve(process.cwd(), ".ultra-cache", "ralph-best");

function bestPath(file: string): string {
  return path.join(BEST_DIR, file);
}

export async function readRalphState(workspace: string): Promise<RalphState | null> {
  const file = path.join(workspace, RALPH_FILE);
  if (!(await pathExists(file))) return null;
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as RalphState;
  } catch {
    return null;
  }
}

export async function initRalph(workspace: string, options: { maxIter?: number; minScore?: number; target4k?: boolean }): Promise<RalphState> {
  const existing = await readRalphState(workspace);
  const state: RalphState = {
    version: 1,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    maxIter: Math.max(1, Math.min(20, options.maxIter ?? 5)),
    minScore: Math.max(1, Math.min(100, options.minScore ?? 90)),
    target4k: Boolean(options.target4k),
    completionPromise: "verify.pass && stutterEvents==0 && score>=minScore && lint.pass",
    status: "running",
    attempt: 0,
    bestScore: null,
    bestSnapshot: null,
    history: [],
    updatedAt: new Date().toISOString(),
  };
  await ensureDir(workspace);
  await writeJsonAtomic(path.join(workspace, RALPH_FILE), state);
  return state;
}

function luminance(hex: string): number | null {
  const match = hex.match(/^#([0-9a-fA-F]{6})/);
  if (!match || !match[1]) return null;
  const value = parseInt(match[1], 16);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel((value >> 16) & 255) + 0.7152 * channel((value >> 8) & 255) + 0.0722 * channel(value & 255);
}

function contrast(a: string, b: string): number {
  const la = luminance(a) ?? 0;
  const lb = luminance(b) ?? 0;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function estimateTextBox(scene: SceneSpecT, el: SceneSpecT["textElements"][number], aspect: "9:16" | "16:9" | "1:1", width: number, height: number) {
  const lines = Math.max(1, el.text.split("\n").length);
  const boxWidth = el.width ?? Math.min(width, el.text.length * el.sizePx * 0.56);
  const boxHeight = el.sizePx * el.lineHeight * lines;
  const zone = dangerZoneForPixelBox({ x: el.x, y: el.y, width: boxWidth, height: boxHeight }, aspect, width, height);
  return { zone, boxWidth, boxHeight };
}

function clampToSafeRect(
  x: number,
  y: number,
  w: number,
  h: number,
  frame: { width: number; height: number },
  aspect: "9:16" | "16:9" | "1:1",
): { x: number; y: number } {
  const rect = safeZonesFor(aspect).safeRect;
  const left = rect.x * frame.width;
  const top = rect.y * frame.height;
  const right = (rect.x + rect.width) * frame.width;
  const bottom = (rect.y + rect.height) * frame.height;
  return {
    x: Math.round(Math.min(Math.max(x, left), Math.max(left, right - w))),
    y: Math.round(Math.min(Math.max(y, top), Math.max(top, bottom - h))),
  };
}

export interface RalphFixResult {
  project: UltraProjectT;
  fixes: string[];
  captionsChanged: boolean;
}

export async function autoFixProject(workspace: string, project: UltraProjectT, style: StylePackT | null): Promise<RalphFixResult> {
  const next = UltraProject.parse(JSON.parse(JSON.stringify(project))) as UltraProjectT;
  const fixes: string[] = [];
  const aspect = resolveAspectProfile(next.meta).aspect;
  const frame = { width: next.meta.width, height: next.meta.height };
  const palette = Object.values(next.designTokens.palette);
  let captionsChanged = false;

  for (const scene of next.scenes) {
    const bg = scene.background === "transparent" ? next.designTokens.palette["bg"] ?? "#000000" : scene.background;
    for (const el of scene.textElements) {
      const needed = el.sizePx >= 24 || (el.sizePx >= 18.66 && (el.weight ?? 400) >= 700) ? 3 : 4.5;
      const ratio = contrast(el.color, bg);
      if (ratio < needed && palette.length > 0) {
        const best = [...palette].sort((a, b) => contrast(b, bg) - contrast(a, bg))[0] as string;
        if (contrast(best, bg) > ratio) {
          fixes.push(`scene ${scene.id} text ${el.id}: contrast ${ratio.toFixed(2)}→${contrast(best, bg).toFixed(2)} (${el.color}→${best})`);
          el.color = best;
        }
      }
      if (next.meta.aspectProfile) {
        const box = estimateTextBox(scene, el, aspect, frame.width, frame.height);
        if (box.zone) {
          const clamped = clampToSafeRect(el.x, el.y, box.boxWidth, box.boxHeight, frame, aspect);
          if (clamped.x !== el.x || clamped.y !== el.y) {
            fixes.push(`scene ${scene.id} text ${el.id}: moved out of ${box.zone.id} safe-zone (${el.x},${el.y}→${clamped.x},${clamped.y})`);
            el.x = clamped.x;
            el.y = clamped.y;
          }
        }
      }
    }
    if (style) {
      const banned = new Set(style.transitions.bannedTypes);
      if (banned.has(scene.transitionIn.type)) {
        const fallback =
          (["fade", "slideup", "circleopen", "none"] as const).find((type) => type === "none" || !banned.has(type)) ?? "none";
        fixes.push(`scene ${scene.id}: banned transition ${scene.transitionIn.type}→${fallback}`);
        scene.transitionIn = { ...scene.transitionIn, type: fallback as SceneSpecT["transitionIn"]["type"] };
      }
    }
  }
  if (style && Math.abs(next.audio.targetLufs - style.soundDesign.targetLufs) > 1.5) {
    fixes.push(`audio target ${next.audio.targetLufs}→${style.soundDesign.targetLufs} LUFS`);
    next.audio = { ...next.audio, targetLufs: style.soundDesign.targetLufs };
  }

  for (const asset of next.assets) {
    if (!["sfx", "music"].includes(asset.type)) continue;
    const file = resolveAssetPath(workspace, asset);
    if (await pathExists(file)) continue;
    const hint = inferSynthPreset(asset.id, asset.type, `${asset.description} ${asset.prompt}`);
    await ensureDir(path.dirname(file));
    await synthesizeToWav({
      preset: hint.preset,
      out: file,
      durationSec: asset.durationSec ?? defaultSynthDuration(hint.preset),
      bpm: 120,
      mood: "tech",
    });
    fixes.push(`asset ${asset.id}: synthesized missing ${asset.type} with preset ${hint.preset}`);
  }

  const captionsFile = path.join(workspace, "captions.json");
  if (await pathExists(captionsFile)) {
    try {
      const doc = JSON.parse(await fs.readFile(captionsFile, "utf8")) as { chunks?: { id: string; safeBox?: unknown }[] };
      if (Array.isArray(doc.chunks)) {
        const band = captionSafeBox(aspect, frame.width, frame.height);
        for (const chunk of doc.chunks) {
          const current = chunk.safeBox as { xPercent?: number; yPercent?: number } | undefined;
          if (!current || current.yPercent !== band.yPercent || current.xPercent !== band.xPercent) {
            chunk.safeBox = band;
            captionsChanged = true;
          }
        }
        if (captionsChanged) {
          fixes.push(`captions.json: clamped ${doc.chunks.length} chunk(s) inside the ${aspect} caption safe zone`);
          await writeJsonAtomic(captionsFile, doc);
        }
      }
    } catch {
      // malformed captions handled by guard/lint
    }
  }
  return { project: next, fixes, captionsChanged };
}

export async function autoFixRalph(workspace: string, buildDir: string): Promise<RalphState> {
  let state = await readRalphState(workspace);
  if (!state) state = await initRalph(workspace, {});
  state.status = "running";
  const plan = await loadPlan(workspace).catch(() => null);
  let style: StylePackT | null = null;
  const styleSlug = plan?.meta.styleSlug ?? null;
  if (styleSlug) {
    try {
      style = (await loadStylePack(styleSlug)).style;
    } catch {
      style = null;
    }
  }
  await ensureDir(BEST_DIR);

  let project = await loadProject(workspace);
  const history: RalphState["history"] = [...state.history];
  let bestScore = state.bestScore;
  let bestHash = "";
  let previousHash = "";
  let previousScore = -1;

  const evaluate = async (candidate: UltraProjectT) => {
    const proxy = planDimensions(resolveAspectProfile(candidate.meta).aspect, "proxy");
    const manifest = await buildProject({ project: candidate, workspace, buildDir, renderWidth: proxy.width, renderHeight: proxy.height });
    const lint = await lintProject({ project: candidate, workspace, buildDir });
    const reference = await (async () => {
      const candidates = [path.resolve(process.cwd(), candidate.meta.sourceVideoPath), path.resolve(workspace, candidate.meta.sourceVideoPath)];
      for (const entry of candidates) if (await pathExists(entry)) return entry;
      return manifest.draftFile;
    })();
    const metrics = await auditDraft({
      draftFile: manifest.draftFile,
      referenceFile: reference,
      expectedDurationSec: candidate.meta.durationSec,
      expectedFps: candidate.meta.fps,
      targetLufs: candidate.audio.targetLufs,
    });
    const warnings = lint.scenes.flatMap((scene) => scene.defects).filter((defect) => !defect.critical).length;
    let score = 100 - lint.criticalDefectCount * 25 - warnings * 8 - metrics.stutterEvents * 15;
    if (!metrics.durationOk) score -= 10;
    if (!metrics.fpsOk || !metrics.cfr) score -= 10;
    if (!metrics.blackOk) score -= 10;
    return { manifest, lint, metrics, warnings, score: Math.max(0, Math.min(100, Math.round(score))) };
  };

  const baseline = await evaluate(project);
  history.push({
    attempt: 0,
    score: baseline.score,
    stutterEvents: baseline.metrics.stutterEvents,
    lintCritical: baseline.lint.criticalDefectCount,
    lintWarnings: baseline.warnings,
    hash: sha1(JSON.stringify(project)),
    fixes: 0,
  });
  bestScore = baseline.score;
  state.bestScore = baseline.score;
  state.bestSnapshot = bestPath("ultra.json");
  await ensureDir(BEST_DIR);
  await fs.copyFile(path.join(workspace, "ultra.json"), state.bestSnapshot);
  await writeJsonAtomic(path.join(buildDir, "ralph-report.json"), { iteration: 0, ...baseline, fixes: [] });
  await writeJsonAtomic(path.join(workspace, RALPH_FILE), state);
  const baselineSatisfied =
    baseline.score >= state.minScore && baseline.metrics.stutterEvents === 0 && baseline.lint.pass && baseline.metrics.pass;
  if (baselineSatisfied) {
    state.status = "satisfied";
    state.history = history;
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(path.join(workspace, RALPH_FILE), state);
    await fs.writeFile(
      path.join(workspace, "ralph-history.md"),
      `# Ralph loop history\n\n- status: **satisfied**\n- score ${baseline.score} met the promise without patches.\n`,
      "utf8",
    );
    return state;
  }
  previousHash = sha1(JSON.stringify(project));
  previousScore = baseline.score;

  for (let iteration = 1; iteration <= state.maxIter; iteration += 1) {
    const fixed = await autoFixProject(workspace, project, style);
    project = fixed.project;
    const errors = validateProjectSemantics(project);
    if (errors.length > 0) throw new Error(`ralph auto-fix produced an invalid project:\n- ${errors.join("\n- ")}`);
    await writeJsonAtomic(path.join(workspace, "ultra.json"), project);
    const hash = sha1(JSON.stringify(project));
    const measured = await evaluate(project);
    const { metrics, lint, warnings, score } = measured;
    state.attempt = iteration;
    state.history = history;
    history.push({
      attempt: iteration,
      score,
      stutterEvents: metrics.stutterEvents,
      lintCritical: lint.criticalDefectCount,
      lintWarnings: warnings,
      hash,
      fixes: fixed.fixes.length,
    });
    await writeJsonAtomic(path.join(buildDir, "ralph-report.json"), { iteration, score, metrics, lint, fixes: fixed.fixes });
    if (bestScore === null || score > bestScore) {
      bestScore = score;
      bestHash = hash;
      state.bestScore = score;
      state.bestSnapshot = bestPath("ultra.json");
      await fs.copyFile(path.join(workspace, "ultra.json"), state.bestSnapshot);
      if (await pathExists(path.join(workspace, "captions.json"))) {
        await fs.copyFile(path.join(workspace, "captions.json"), bestPath("captions.json"));
      }
    }
    state.status = "running";
    await writeJsonAtomic(path.join(workspace, RALPH_FILE), state);

    const satisfied = score >= state.minScore && metrics.stutterEvents === 0 && lint.pass && metrics.pass;
    if (satisfied) {
      state.status = "satisfied";
      break;
    }
    if (hash === previousHash && score <= previousScore) {
      state.status = "stalled";
      if (state.bestSnapshot && (await pathExists(state.bestSnapshot))) {
        await fs.copyFile(state.bestSnapshot, path.join(workspace, "ultra.json"));
        if (await pathExists(bestPath("captions.json"))) {
          await fs.copyFile(bestPath("captions.json"), path.join(workspace, "captions.json"));
        }
      }
      break;
    }
    if (fixed.fixes.length === 0 && score < state.minScore) {
      state.status = "exhausted";
      break;
    }
    previousHash = hash;
    previousScore = score;
    void bestHash;
  }
  if (state.status === "running") state.status = "exhausted";
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path.join(workspace, RALPH_FILE), state);

  const lines = [
    "# Ralph loop history",
    "",
    `- status: **${state.status}**`,
    `- completion promise: \`${state.completionPromise}\``,
    `- best score: ${state.bestScore ?? "—"} / min ${state.minScore} (max ${state.maxIter} iterations)`,
    "",
    "| Attempt | Score | stutterEvents | lint critical | lint warnings | fixes | hash |",
    "|---|---|---|---|---|---|---|",
    ...history.map(
      (entry) =>
        `| ${entry.attempt} | ${entry.score} | ${entry.stutterEvents} | ${entry.lintCritical} | ${entry.lintWarnings} | ${entry.fixes} | ${entry.hash.slice(0, 10)} |`,
    ),
    "",
  ];
  await fs.writeFile(path.join(workspace, "ralph-history.md"), lines.join("\n"), "utf8");
  return state;
}
