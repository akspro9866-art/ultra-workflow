import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists, readJson } from "./util.js";

/* ============================================================================
 * Agent state tracker — `ultra status`
 * Long Gemini/Muse/ChatGPT chats lose their place; this reports the detected
 * process, finished stages, missing prerequisites and the exact next command.
 * ========================================================================== */

export type WorkflowProcess = "extract-style" | "clone-reference" | "edit-in-style" | "uninitialized";

export interface StatusStage {
  name: string;
  done: boolean;
  path?: string;
  note?: string;
}

export interface StatusReport {
  updatedAt: string;
  process: WorkflowProcess;
  workspace: string;
  buildDir: string;
  styleSlug: string | null;
  stages: StatusStage[];
  pendingAssets: number | null;
  draft: { exists: boolean; path: string; bytes: number };
  verify: { exists: boolean; pass: boolean | null; score: number | null; path: string };
  nextCommand: string;
  notes: string[];
}

export interface StatusOptions {
  cwd?: string;
  workspace?: string;
  buildDir?: string;
}

interface LooseProject {
  meta?: { sourceVideoPath?: string; aspectProfile?: string };
  assets?: unknown[];
  scenes?: { sourceClip?: unknown; captionsFile?: unknown }[];
}

async function readProject(workspace: string): Promise<LooseProject | null> {
  const file = path.join(workspace, "ultra.json");
  if (!(await pathExists(file))) return null;
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as LooseProject;
  } catch {
    return null;
  }
}

async function firstStylePackDir(workspace: string): Promise<string | null> {
  const candidates = [path.join(workspace, "style-pack"), path.join(workspace, "style"), path.join(workspace, "style-packs")];
  for (const dir of candidates) {
    if (await pathExists(path.join(dir, "style.json"))) return dir;
  }
  try {
    for (const entry of await fs.readdir(workspace, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(workspace, entry.name);
      if (await pathExists(path.join(dir, "style.json"))) return dir;
    }
  } catch {
    // workspace missing
  }
  return null;
}

async function findStyleExport(cwd: string, workspace: string): Promise<string | null> {
  for (const dir of [path.join(cwd, "build"), workspace, cwd]) {
    try {
      for (const entry of await fs.readdir(dir)) {
        if (/-style-pack\.zip$/i.test(entry)) return path.join(dir, entry);
      }
    } catch {
      // skip
    }
  }
  return null;
}

async function installedStylesCount(cwd: string): Promise<number> {
  try {
    const entries = await fs.readdir(path.join(cwd, "styles"), { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (entry.isDirectory() && (await pathExists(path.join(cwd, "styles", entry.name, "style.json")))) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

function verifyScore(report: unknown): number | null {
  if (!report || typeof report !== "object") return null;
  const rubric = (report as Record<string, unknown>)["rubric"];
  if (!rubric || typeof rubric !== "object") return null;
  const categories = (rubric as Record<string, unknown>)["categories"];
  if (!Array.isArray(categories)) return null;
  let total = 0;
  let seen = false;
  for (const category of categories) {
    if (!category || typeof category !== "object") continue;
    const items = (category as Record<string, unknown>)["items"];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const score = (item as Record<string, unknown>)["score"];
      if (typeof score === "number" && Number.isFinite(score)) {
        total += score;
        seen = true;
      }
    }
  }
  return seen ? total : null;
}

export async function buildStatus(options: StatusOptions = {}): Promise<StatusReport> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const workspace = path.resolve(options.workspace ?? path.join(cwd, "workspace"));
  const buildDir = path.resolve(options.buildDir ?? path.join(cwd, "build"));
  const notes: string[] = [];

  const project = await readProject(workspace);
  const styleProbeAggregate = path.join(workspace, "style-probe", "aggregate.json");
  const rawPlan = path.join(workspace, "raw-probe", "raw-edit-plan.json");
  const probeFile = path.join(workspace, "probe.json");
  const captionsFile = path.join(workspace, "captions.json");
  const draftFile = path.join(buildDir, "draft.mp4");
  const verifyFile = path.join(buildDir, "verify-report.json");

  const hasAggregate = await pathExists(styleProbeAggregate);
  const hasRawPlan = await pathExists(rawPlan);
  const sourceClipScenes = Boolean(project?.scenes?.some((scene) => scene && scene.sourceClip !== undefined));
  const hasProbe = await pathExists(probeFile);
  const hasDesign = await pathExists(path.join(workspace, "DESIGN.md"));
  const processKind: WorkflowProcess = hasAggregate
    ? "extract-style"
    : hasRawPlan || sourceClipScenes
      ? "edit-in-style"
      : project || hasProbe || hasDesign
        ? "clone-reference"
        : "uninitialized";

  const styleSlug = hasRawPlan
    ? await readJson(rawPlan)
        .then((plan) => (plan && typeof plan === "object" ? (plan as Record<string, unknown>)["styleSlug"] : null))
        .then((slug) => (typeof slug === "string" ? slug : null))
        .catch(() => null)
    : project
      ? null
      : null;

  const todoFile = path.join(workspace, "assets-todo.json");
  let pendingAssets: number | null = null;
  if (await pathExists(todoFile)) {
    try {
      const todo = JSON.parse(await fs.readFile(todoFile, "utf8")) as { missing?: unknown[]; complete?: boolean };
      pendingAssets = todo.complete ? 0 : Array.isArray(todo.missing) ? todo.missing.length : null;
    } catch {
      pendingAssets = null;
    }
  }

  let draftBytes = 0;
  const draftExists = await pathExists(draftFile);
  if (draftExists) draftBytes = (await fs.stat(draftFile)).size;

  let verifyPass: boolean | null = null;
  let verifyScoreValue: number | null = null;
  const verifyExists = await pathExists(verifyFile);
  if (verifyExists) {
    try {
      const report = await readJson(verifyFile);
      verifyPass = Boolean((report as Record<string, unknown>)["pass"]);
      verifyScoreValue = verifyScore(report);
    } catch {
      verifyPass = null;
    }
  }

  const stages: StatusStage[] = [];
  let nextCommand = "";

  if (processKind === "extract-style") {
    const packDir = await firstStylePackDir(workspace);
    const exportZip = await findStyleExport(cwd, workspace);
    const candidatesDir = path.join(workspace, "style-probe", "candidates");
    const candidateCount = (await fs.readdir(candidatesDir).catch(() => [] as string[])).length;
    stages.push({ name: "batch style-probe", done: true, path: styleProbeAggregate });
    stages.push({
      name: "candidate exemplar stills",
      done: candidateCount > 0,
      path: candidatesDir,
      ...(candidateCount > 0 ? { note: `${candidateCount} candidates` } : {}),
    });
    stages.push({
      name: "style pack authored",
      done: Boolean(packDir),
      ...(packDir ? { path: packDir } : { note: "style.json + STYLE.md + motifs/ + exemplars/" }),
    });
    stages.push({ name: "style export zip", done: Boolean(exportZip), ...(exportZip ? { path: exportZip } : {}) });

    if (!packDir) {
      nextCommand = "author workspace/style-pack/ (style.json, STYLE.md, 2 motifs, 2–8 exemplars) then run: ultra style-validate workspace/style-pack";
    } else if (!exportZip) {
      nextCommand = `ultra style-export "${packDir}" --out build/<slug>-style-pack.zip`;
    } else {
      nextCommand = `deliver ${path.basename(exportZip)} to the user (then Qoder: ultra style-import ${path.basename(exportZip)} --repack)`;
    }
    if (hasRawPlan || sourceClipScenes) notes.push("raw-probe artifacts also present; run Process 2B separately if this is a style-extraction chat.");
  } else if (processKind === "edit-in-style") {
    const styles = await installedStylesCount(cwd);
    const captionsExists = await pathExists(captionsFile);
    const requiredAssets = project?.assets?.length ?? 0;
    const assetsDone = project ? requiredAssets === 0 || pendingAssets === 0 : pendingAssets === 0;
    stages.push({ name: "installed style pack", done: styles > 0, path: path.join(cwd, "styles"), note: `${styles} pack(s)` });
    stages.push({ name: "raw-probe edit plan", done: hasRawPlan, path: rawPlan });
    stages.push({
      name: "word-level captions",
      done: captionsExists,
      path: captionsFile,
      note: captionsExists ? "captions.json ready" : "optional — ultra captions-align",
    });
    stages.push({ name: "edit plan (ultra.json)", done: Boolean(project), path: path.join(workspace, "ultra.json") });
    stages.push({
      name: "assets",
      done: assetsDone,
      ...(requiredAssets === 0 && project ? { note: "0 assets required" } : pendingAssets !== null ? { note: `${pendingAssets} pending` } : { note: "assets-todo.json not generated yet" }),
    });
    stages.push({ name: "draft build", done: draftExists, path: draftFile });
    stages.push({
      name: "Rule 5 verify",
      done: verifyPass === true,
      path: verifyFile,
      ...(verifyPass === true ? { note: verifyScoreValue !== null ? `score ${verifyScoreValue}` : "pass" } : {}),
    });

    if (styles === 0) nextCommand = "ultra style-list  # import a Style Pack first: ultra style-import <zip> --repack";
    else if (!hasRawPlan) nextCommand = "ultra raw-probe my_video.mp4 --style <slug> --aspect 9:16";
    else if (!project) nextCommand = "write workspace/ultra.json using workspace/raw-probe/raw-edit-plan.json + captions.json, then ultra validate-spec";
    else if (!assetsDone) nextCommand = "ultra asset-plan --host chatgpt && ultra validate-assets";
    else if (!draftExists) nextCommand = "ultra build";
    else if (verifyPass !== true) nextCommand = styleSlug ? `ultra verify --style ${styleSlug}` : "ultra verify --style <slug>";
    else nextCommand = "ultra render";
  } else {
    const requiredAssets = project?.assets?.length ?? 0;
    const assetsDone = project ? requiredAssets === 0 || pendingAssets === 0 : pendingAssets === 0;
    stages.push({ name: "reference probe", done: hasProbe, path: probeFile });
    stages.push({ name: "DESIGN.md", done: hasDesign, path: path.join(workspace, "DESIGN.md") });
    stages.push({ name: "ultra.json", done: Boolean(project), path: path.join(workspace, "ultra.json") });
    stages.push({
      name: "assets",
      done: assetsDone,
      ...(requiredAssets === 0 && project ? { note: "0 assets required" } : pendingAssets !== null ? { note: `${pendingAssets} pending` } : { note: "assets-todo.json not generated yet" }),
    });
    stages.push({ name: "draft build", done: draftExists, path: draftFile });
    stages.push({
      name: "Rule 5 verify",
      done: verifyPass === true,
      path: verifyFile,
      ...(verifyPass === true ? { note: verifyScoreValue !== null ? `score ${verifyScoreValue}` : "pass" } : {}),
    });

    if (processKind === "uninitialized") nextCommand = "ultra init  # then ultra probe <reference.mp4>";
    else if (!hasProbe) nextCommand = "ultra probe <reference.mp4>";
    else if (!project) nextCommand = "author workspace/DESIGN.md + workspace/ultra.json, then ultra validate-spec";
    else if (!assetsDone) nextCommand = "ultra asset-plan && ultra validate-assets";
    else if (!draftExists) nextCommand = "ultra build";
    else if (verifyPass !== true) nextCommand = "ultra verify <reference.mp4>";
    else nextCommand = "ultra render";
  }

  return {
    updatedAt: new Date().toISOString(),
    process: processKind,
    workspace,
    buildDir,
    styleSlug,
    stages,
    pendingAssets,
    draft: { exists: draftExists, path: draftFile, bytes: draftBytes },
    verify: { exists: verifyExists, pass: verifyPass, score: verifyScoreValue, path: verifyFile },
    nextCommand,
    notes,
  };
}
