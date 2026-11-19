import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureDir, pathExists } from "./util.js";

export interface HarnessState {
  version: 6;
  process: string;
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
