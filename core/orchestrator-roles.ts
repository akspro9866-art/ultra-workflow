import { promises as fs } from "node:fs";
import path from "node:path";
import { checkApprovalGate, loadPlan } from "./preprod.js";
import { loadProject } from "./project.js";
import { readState, resolveProcessMode, writeState } from "./state.js";
import { pathExists } from "./util.js";

export interface RoleSpec {
  id: string;
  title: string;
  stage: string;
  inputs: string[];
  outputs: string[];
  commands: string[];
  parallelizableWith: string[];
}

export const ROLES: RoleSpec[] = [
  {
    id: "director",
    title: "Director",
    stage: "preprod",
    inputs: ["workspace/reference.mp4 (or raw footage)", ".ultra/rules/01-approval-gate.md"],
    outputs: ["workspace/plan.json", "workspace/PLAN.md", "build/preprod/moodboard.png", "build/preprod/storyboard*.png", "workspace/approval.json"],
    commands: ["ultra probe/raw-probe", "ultra rag query", "ultra plan-init", "ultra preprod-render", "ultra approve --by user"],
    parallelizableWith: ["asset-producer"],
  },
  {
    id: "asset-producer",
    title: "Asset Producer",
    stage: "assets",
    inputs: ["workspace/ultra.json", "workspace/assets-todo.json", "workspace/approval.json"],
    outputs: ["workspace/assets/*", "workspace/assets.manifest.json"],
    commands: ["ultra asset-plan --host chatgpt", "ultra synth-audio --from-assets", "ultra validate-assets"],
    parallelizableWith: ["director"],
  },
  {
    id: "motion-builder",
    title: "Motion Builder",
    stage: "build",
    inputs: ["workspace/ultra.json", "workspace/captions.json", "workspace/assets/*"],
    outputs: ["build/draft.mp4", "build/build-manifest.json", "build/scenes/*"],
    commands: ["ultra validate-spec", "ultra build --proxy"],
    parallelizableWith: [],
  },
  {
    id: "qa-critic",
    title: "QA Critic",
    stage: "verify",
    inputs: ["build/draft.mp4", "build/audit-frames/*", "workspace/ultra.json"],
    outputs: ["build/verify-report.json", "build/audit-frames/*", "workspace/patch.json"],
    commands: ["ultra verify", "ultra ralph auto-fix", "ultra patch"],
    parallelizableWith: [],
  },
  {
    id: "mastering-engineer",
    title: "Mastering Engineer",
    stage: "master",
    inputs: ["build/verify-report.json", "build/build-manifest.json", "workspace/ultra.json"],
    outputs: ["build/ultra-final.mp4", "build/delivery-manifest.json", "build/editable-project.zip", "build/editable-project/*"],
    commands: ["ultra render --4k", "ultra export-project", "ultra guard --stage delivery"],
    parallelizableWith: [],
  },
];

export interface RoleStatus {
  activeRole: string;
  stage: string;
  title: string;
  inputContract: string[];
  outputContract: string[];
  commands: string[];
  parallelizableWith: string[];
  executionModel: string;
  nextCommand: string;
}

export async function getRoleStatus(workspace: string, buildDir: string): Promise<RoleStatus> {
  const project = await loadProject(workspace).catch(() => null);
  const plan = await loadPlan(workspace).catch(() => null);
  const mode = await resolveProcessMode(workspace, project);
  const gate = await checkApprovalGate(workspace, { mode });
  let role = ROLES[0] as RoleSpec;
  let nextCommand = "ultra plan-init";
  let stage = "preprod";

  if (mode === "extract-style") {
    role = ROLES[0] as RoleSpec;
    stage = "extract";
    nextCommand = await pathExists(path.join(workspace, "style-probe", "aggregate.json"))
      ? "author style.json/STYLE.md/motifs → ultra style-validate <dir> → ultra style-export <dir>"
      : "ultra style-probe <ref1..refN>";
  } else if (mode === "edit-in-style" && !gate.ok) {
    role = ROLES[0] as RoleSpec;
    stage = "preprod";
    nextCommand =
      gate.code === "missing" && !plan
        ? "ultra plan-init --mode edit-in-style"
        : gate.code === "preprod-missing"
          ? "ultra preprod-render  → show moodboard + storyboard → WAIT for approval → ultra approve --by user"
          : "ultra approve --by user";
  } else if (project) {
    const draftExists = await pathExists(path.join(buildDir, "draft.mp4"));
    const verifyExists = await pathExists(path.join(buildDir, "verify-report.json"));
    const deliveryExists = await pathExists(path.join(buildDir, "delivery-manifest.json"));
    const zipExists = await pathExists(path.join(buildDir, "editable-project.zip"));
    if (!draftExists) {
      stage = "build";
      role = ROLES[2] as RoleSpec;
      nextCommand = "ultra build --proxy";
    } else if (!verifyExists) {
      stage = "verify";
      role = ROLES[3] as RoleSpec;
      nextCommand = "ultra verify";
    } else if (!deliveryExists || !zipExists) {
      stage = "master";
      role = ROLES[4] as RoleSpec;
      nextCommand = deliveryExists ? "ultra export-project" : "ultra render --4k";
    } else {
      stage = "delivery";
      role = ROLES[4] as RoleSpec;
      nextCommand = "ultra guard --stage delivery";
    }
  } else {
    stage = "build";
    role = ROLES[2] as RoleSpec;
    nextCommand = mode === "clone-reference" ? "write workspace/ultra.json → ultra validate-spec → ultra build --proxy" : "ultra probe <reference.mp4>";
  }

  const state = await readState(workspace);
  await writeState(workspace, { ...state, stage, activeRole: role.id });
  return {
    activeRole: role.id,
    stage,
    title: role.title,
    inputContract: role.inputs,
    outputContract: role.outputs,
    commands: role.commands,
    parallelizableWith: role.parallelizableWith,
    executionModel:
      "Web chats (Gemini/Muse/ChatGPT) execute roles sequentially with clean file handoffs; multi-agent IDEs may run director + asset-producer independently in parallel, then join before motion-builder.",
    nextCommand,
  };
}

export async function roleMarkdown(roleId: string): Promise<string> {
  const file = path.join(process.cwd(), ".ultra", "agents", `${roleId}.md`);
  if (await pathExists(file)) return fs.readFile(file, "utf8");
  return "";
}
