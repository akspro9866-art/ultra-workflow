import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureDir, pathExists } from "./util.js";

export type ProcessMode = "extract-style" | "clone-reference" | "edit-in-style";

export interface HarnessState {
  version: 6;
  process: string;
  processMode: ProcessMode | "uninitialized";
  stage: string;
  activeRole: string | null;
  approval: { approved: boolean; planHash: string | null; approvedBy: string | null } | null;
  ralph: { attempt: number; bestScore: number | null; satisfied: boolean } | null;
  artifacts: Record<string, { path: string; sha1?: string; bytes?: number }>;
  updatedAt: string;
}

export function defaultState(): HarnessState {
  return {
    version: 6,
    process: "uninitialized",
    processMode: "uninitialized",
    stage: "preprod",
    activeRole: null,
    approval: null,
    ralph: null,
    artifacts: {},
    updatedAt: new Date().toISOString(),
  };
}

export async function readState(workspace: string): Promise<HarnessState> {
  const file = path.join(workspace, "state.json");
  if (!(await pathExists(file))) return defaultState();
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Partial<HarnessState>;
    return { ...defaultState(), ...raw, version: 6 };
  } catch {
    return defaultState();
  }
}

export async function writeState(workspace: string, state: HarnessState): Promise<void> {
  await ensureDir(workspace);
  state.updatedAt = new Date().toISOString();
  await fs.writeFile(path.join(workspace, "state.json"), JSON.stringify(state, null, 2) + "\n", "utf8");
}

export async function patchState(workspace: string, patch: Partial<HarnessState>): Promise<HarnessState> {
  const state = await readState(workspace);
  const next: HarnessState = { ...state, ...patch, version: 6, updatedAt: new Date().toISOString() };
  await writeState(workspace, next);
  return next;
}

export async function setProcessMode(workspace: string, mode: ProcessMode): Promise<void> {
  await patchState(workspace, { processMode: mode, process: mode });
}

/**
 * Process mode precedence: explicit ultra.json.meta.processMode → state.json →
 * plan.meta.mode → measured workflow artifacts → null (legacy/uninitialized).
 * Legacy sourceClip projects WITHOUT an explicit mode stay ungated.
 */
export async function resolveProcessMode(
  workspace: string,
  project?: { meta?: { processMode?: ProcessMode } } | null,
): Promise<ProcessMode | null> {
  const explicitProject = project?.meta?.processMode;
  if (explicitProject) return explicitProject;
  const state = await readState(workspace);
  if (state.processMode && state.processMode !== "uninitialized") return state.processMode;

  const planFile = path.join(workspace, "plan.json");
  if (await pathExists(planFile)) {
    try {
      const plan = JSON.parse(await fs.readFile(planFile, "utf8")) as { meta?: { mode?: string } };
      return plan.meta?.mode === "edit-in-style" ? "edit-in-style" : "clone-reference";
    } catch {
      // fall through
    }
  }
  if (await pathExists(path.join(workspace, "style-probe", "aggregate.json"))) return "extract-style";
  if (await pathExists(path.join(workspace, "raw-probe", "raw-edit-plan.json"))) return "edit-in-style";
  if (await pathExists(path.join(workspace, "probe.json"))) return "clone-reference";
  return null;
}

export async function recordArtifact(workspace: string, key: string, file: string): Promise<void> {
  const state = await readState(workspace);
  try {
    const stat = await fs.stat(file);
    state.artifacts[key] = { path: file, bytes: stat.size };
  } catch {
    state.artifacts[key] = { path: file };
  }
  await writeState(workspace, state);
}
