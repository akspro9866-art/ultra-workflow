import { promises as fs } from "node:fs";
import path from "node:path";
import { installRoot } from "./env.js";
import { loadPlan, readApproval, checkApprovalGate } from "./preprod.js";
import { loadRagIndex, queryRag, type RagHit } from "./rag.js";
import { runGuard, type GuardStage } from "./guard.js";
import { buildStatus } from "./status.js";
import { patchState, resolveProcessMode } from "./state.js";
import { ensureDir, pathExists } from "./util.js";

export type ContextStage = "preprod" | "assets" | "build" | "verify" | "fix" | "master";

const STAGE_RULES: Record<ContextStage, string[]> = {
  preprod: ["01-approval-gate.md", "02-anti-slop-motion.md"],
  assets: ["01-approval-gate.md", "03-zero-hallucination.md"],
  build: ["02-anti-slop-motion.md", "03-zero-hallucination.md"],
  verify: ["02-anti-slop-motion.md", "03-zero-hallucination.md"],
  fix: ["02-anti-slop-motion.md", "03-zero-hallucination.md"],
  master: ["04-4k-and-editable-delivery.md", "03-zero-hallucination.md"],
};

const STAGE_QUERY: Record<ContextStage, string> = {
  preprod: "moodboard storyboard hook motif safe-zone typography",
  assets: "asset image video sfx synth-audio",
  build: "anti-slop motion caption safe-zone transition punch-in",
  verify: "verify stutterEvents zero lint contrast palette",
  fix: "patch safe-zone contrast ralph rollback",
  master: "4K delivery editable fcpxml otio export guard",
};

const NEXT: Record<ContextStage, string> = {
  preprod: "ultra preprod-render && ultra approve --by user",
  assets: "ultra asset-plan --host chatgpt && ultra validate-assets",
  build: "ultra build --proxy",
  verify: "ultra verify --style <slug>  (or ultra verify <ref.mp4>)",
  fix: "ultra ralph auto-fix",
  master: "ultra render --4k && ultra export-project && ultra guard --stage delivery",
};

export interface ContextPackResult {
  path: string;
  stage: ContextStage;
  estimatedTokens: number;
  nextCommand: string;
  hits: RagHit[];
  blockers: string[];
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function readRules(stage: ContextStage): Promise<{ name: string; text: string }[]> {
  const out: { name: string; text: string }[] = [];
  for (const name of STAGE_RULES[stage]) {
    const file = path.join(installRoot(), ".ultra", "rules", name);
    if (await pathExists(file)) out.push({ name, text: (await fs.readFile(file, "utf8")).trim() });
  }
  return out;
}

export async function buildContextPack(options: {
  workspace: string;
  buildDir: string;
  stage: ContextStage;
  budgetTokens: number;
  outFile: string;
}): Promise<ContextPackResult> {
  const { workspace, buildDir, stage } = options;
  const budget = Math.max(400, options.budgetTokens);
  const plan = await loadPlan(workspace).catch(() => null);
  const approval = await readApproval(workspace);
  const status = await buildStatus({ workspace, buildDir, cwd: process.cwd() });
  const stageGuardMap: Record<ContextStage, GuardStage> = {
    preprod: "plan",
    assets: "plan",
    build: "build",
    verify: "verify",
    fix: "verify",
    master: "delivery",
  };
  const guard = await runGuard(workspace, buildDir, stageGuardMap[stage]);
  const blockers = guard.errors.slice(0, 6).map((error) => `${error.check}: ${error.detail}`);
  const rules = await readRules(stage);

  const index = await loadRagIndex(installRoot());
  const query = `${STAGE_QUERY[stage]} ${plan?.meta.title ?? ""} ${plan?.meta.styleSlug ?? ""}`.trim();
  const hits = queryRag(index, query, { aspect: plan?.meta.aspect, top: 4 });

  const artifactLines = [
    ["ultra.json", path.join(workspace, "ultra.json")],
    ["plan.json", path.join(workspace, "plan.json")],
    ["approval.json", path.join(workspace, "approval.json")],
    ["captions.json", path.join(workspace, "captions.json")],
    ["draft.mp4", path.join(buildDir, "draft.mp4")],
    ["verify-report.json", path.join(buildDir, "verify-report.json")],
    ["delivery-manifest.json", path.join(buildDir, "delivery-manifest.json")],
    ["editable-project.zip", path.join(buildDir, "editable-project.zip")],
  ] as const;
  const verified: string[] = [];
  for (const [label, file] of artifactLines) {
    if (await pathExists(file)) verified.push(`${label} → ${file}`);
  }

  const mode = await resolveProcessMode(workspace);
  const approvalLine =
    mode !== "edit-in-style"
      ? `not required (${mode ?? "legacy/clone/extract"} — only Process 2B is gated)`
      : plan
        ? approval?.approved
          ? `approved by ${approval.approvedBy} at ${approval.approvedAt}`
          : await checkApprovalGate(workspace, { mode }).then((gate) => `NOT APPROVED (${gate.code}) — show moodboard/storyboard and wait`)
        : "no plan.json — run `ultra plan-init --mode edit-in-style`";
  const stageNext = stage === "preprod" && mode && mode !== "edit-in-style" ? status.nextCommand : NEXT[stage];
  const nextCommand = stageNext ?? status.nextCommand;

  const header = [
    `# Ultra context brief — stage ${stage}`,
    "",
    `- Stage: **${stage}** · process: **${status.process}** · mode: **${mode ?? "legacy"}** · next: \`${nextCommand}\``,
    `- Plan: ${plan ? `${plan.meta.title} · ${plan.meta.aspect} · ${plan.meta.resolution}` : "none"}`,
    `- Approval: ${approvalLine}`,
    "",
    "## Active rules",
    "",
  ].join("\n");
  const rulesText = rules.map((rule) => `### ${rule.name}\n${rule.text}\n`).join("\n");
  const blockersText = ["## Blocking errors", "", ...(blockers.length ? blockers.map((line) => `- ${line}`) : ["- none"])].join("\n") + "\n";
  const artifactsText = ["## Verified paths on disk", "", ...(verified.length ? verified.map((line) => `- ${line}`) : ["- none"])].join("\n") + "\n";
  const ragLines = hits.map(
    (hit) => `- [${hit.kind}] **${hit.title}** (score ${hit.score}) — \`${hit.path}\`\n  ${hit.snippet.slice(0, 220)}`,
  );
  const ragText = ["## Retrieved context (BM25)", "", ...(ragLines.length ? ragLines : ["- no hits"])].join("\n") + "\n";

  let body = `${header}${rulesText}\n${blockersText}\n${ragText}\n${artifactsText}\n## Next command\n\n\`\`\`bash\n${nextCommand}\n\`\`\`\n`;
  // Enforce the token budget deterministically by trimming retrieved context first.
  while (estimateTokens(body) > budget && hits.length > 0) {
    hits.pop();
    const trimmed = hits.map((hit) => `- [${hit.kind}] **${hit.title}** (${hit.score}) — \`${hit.path}\``);
    body = body.replace(/## Retrieved context \(BM25\)[\s\S]*?\n\n## Verified paths/, `## Retrieved context (BM25)\n\n${trimmed.join("\n") || "- budget-trimmed"}\n\n## Verified paths`);
  }
  while (estimateTokens(body) > budget && body.length > 400) {
    body = body.slice(0, Math.max(300, body.length - 400));
  }
  const outFile = path.resolve(options.outFile);
  await ensureDir(path.dirname(outFile));
  await fs.writeFile(outFile, body, "utf8");
  await patchState(workspace, { stage, activeRole: stage === "preprod" ? "director" : stage === "assets" ? "asset-producer" : stage === "build" ? "motion-builder" : stage === "verify" || stage === "fix" ? "qa-critic" : "mastering-engineer" });
  return { path: outFile, stage, estimatedTokens: estimateTokens(body), nextCommand, hits, blockers };
}
