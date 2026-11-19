import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AspectProfileT } from "./schema.js";
import { PlanSchema, ApprovalSchema, type PlanT, type ApprovalT } from "./preprod-schema.js";
import { discoverFonts, installRoot, type BundledFont } from "./env.js";
import { stylesRoot } from "./style-pack.js";
import { escapeFilterPath } from "./stitcher.js";
import { ffmpegOk } from "./ffmpeg.js";
import { dangerZoneForPixelBox } from "./safe-zones.js";
import { ensureDir, pathExists, readJson, writeJsonAtomic } from "./util.js";

/* ============================================================================
 * Pre-production approval gate
 * ========================================================================== */

export function planDimensions(aspect: AspectProfileT, resolution: "4k" | "1080p" | "proxy"): { width: number; height: number } {
  if (resolution === "proxy") {
    if (aspect === "9:16") return { width: 720, height: 1280 };
    if (aspect === "1:1") return { width: 1280, height: 1280 };
    return { width: 1280, height: 720 };
  }
  if (resolution === "1080p") {
    if (aspect === "9:16") return { width: 1080, height: 1920 };
    if (aspect === "1:1") return { width: 1080, height: 1080 };
    return { width: 1920, height: 1080 };
  }
  if (aspect === "9:16") return { width: 2160, height: 3840 };
  if (aspect === "1:1") return { width: 2160, height: 2160 };
  return { width: 3840, height: 2160 };
}

export function aspectFromDims(width: number, height: number): AspectProfileT {
  if (Math.abs(width / height - 9 / 16) < 0.06) return "9:16";
  if (Math.abs(width / height - 1) < 0.08) return "1:1";
  return "16:9";
}

export const PLAN_FILE = "plan.json";
export const APPROVAL_FILE = "approval.json";

export async function loadPlan(workspace: string): Promise<PlanT | null> {
  const file = path.join(workspace, PLAN_FILE);
  if (!(await pathExists(file))) return null;
  const parsed = PlanSchema.safeParse(JSON.parse(await fs.readFile(file, "utf8")));
  if (!parsed.success) {
    throw new Error(`plan.json is invalid:\n- ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n- ")}`);
  }
  return parsed.data;
}

export async function computeApprovalHash(workspace: string): Promise<string> {
  const hash = createHash("sha256");
  const plan = await fs.readFile(path.join(workspace, PLAN_FILE));
  hash.update(plan);
  const ultraFile = path.join(workspace, "ultra.json");
  if (await pathExists(ultraFile)) {
    hash.update("\n--ultra.json--\n");
    hash.update(await fs.readFile(ultraFile));
  }
  return hash.digest("hex");
}

export async function readApproval(workspace: string): Promise<ApprovalT | null> {
  const file = path.join(workspace, APPROVAL_FILE);
  if (!(await pathExists(file))) return null;
  try {
    return ApprovalSchema.parse(await readJson(file));
  } catch {
    return null;
  }
}

export interface ApprovalGateResult {
  ok: boolean;
  required: boolean;
  planHash: string | null;
  approval: ApprovalT | null;
  code: "no-plan" | "missing" | "revoked" | "hash-mismatch" | "approved";
  message: string;
}

export async function checkApprovalGate(workspace: string, options: { skip?: boolean; require?: boolean } = {}): Promise<ApprovalGateResult> {
  const planExists = await pathExists(path.join(workspace, PLAN_FILE));
  if (options.skip) {
    return { ok: true, required: false, planHash: null, approval: null, code: "approved", message: "approval check skipped (--skip-approval)" };
  }
  if (!planExists && !options.require) {
    return { ok: true, required: false, planHash: null, approval: null, code: "no-plan", message: "no plan.json — legacy workflow" };
  }
  if (!planExists) {
    return { ok: false, required: true, planHash: null, approval: null, code: "missing", message: "plan.json is required but missing — run `ultra plan-init`" };
  }
  const planHash = await computeApprovalHash(workspace);
  const approval = await readApproval(workspace);
  if (!approval || !approval.approved) {
    return { ok: false, required: true, planHash, approval, code: approval ? "revoked" : "missing", message: "plan is not approved" };
  }
  if (approval.planHash !== planHash) {
    return { ok: false, required: true, planHash, approval, code: "hash-mismatch", message: "plan.json / ultra.json changed since approval" };
  }
  return { ok: true, required: true, planHash, approval, code: "approved", message: `approved by ${approval.approvedBy}` };
}

export function approvalErrorMessage(gate: ApprovalGateResult): string {
  return [
    "PRE-PRODUCTION APPROVAL REQUIRED",
    JSON.stringify(
      {
        error: "preprod-approval-required",
        code: gate.code,
        planHash: gate.planHash,
        required: gate.required,
        next: [
          "show build/preprod/moodboard.png and build/preprod/storyboard*.png to the user",
          "wait for explicit approval",
          "run ultra approve --by user",
          "then rerun this command",
        ],
      },
      null,
      2,
    ),
  ].join("\n");
}

export interface PlanInitOptions {
  workspace: string;
  mode: "clone" | "edit-in-style";
  styleSlug: string | null;
  aspect: AspectProfileT;
  resolution: "4k" | "1080p";
  force?: boolean;
}

export async function initPlan(options: PlanInitOptions): Promise<{ planFile: string; planMd: string; plan: PlanT }> {
  const { workspace } = options;
  await ensureDir(workspace);
  const planFile = path.join(workspace, PLAN_FILE);
  if ((await pathExists(planFile)) && !options.force) {
    throw new Error(`plan.json already exists at ${planFile} (pass --force to overwrite)`);
  }
  const dims = planDimensions(options.aspect, options.resolution);
  const durationSec = 6;
  let palette = [
    { name: "bg", hex: "#0b0d12" },
    { name: "surface", hex: "#151a23" },
    { name: "text", hex: "#f7f5ef" },
    { name: "muted", hex: "#9aa4b2" },
    { name: "accent", hex: "#ffd447" },
    { name: "alert", hex: "#ff5a5f" },
  ];
  let typography = { display: "Ultra Display", body: "Ultra Sans", mono: "Ultra Mono", hierarchy: [96, 52, 28] };
  let invariants = ["Hook resolves inside the first 2s", "Captions stay inside platform safe zones", "No banned transitions", "Loudness lands at -14 LUFS (±1.5)"];
  if (options.styleSlug) {
    for (const base of [stylesRoot(), path.join(installRoot(), "styles")]) {
      try {
        const style = JSON.parse(await fs.readFile(path.join(base, options.styleSlug, "style.json"), "utf8")) as Record<string, any>;
        const p = style["colorAndTexture"]?.["palette"];
        if (p) {
          palette = [
            { name: "bg", hex: p.bg },
            { name: "surface", hex: p.surface },
            { name: "text", hex: p.textPrimary },
            { name: "muted", hex: p.textMuted },
            { name: "accent", hex: p.accent1 },
            { name: "alert", hex: p.accent2 },
          ];
        }
        const t = style["typography"];
        if (t) {
          typography = {
            display: t.displayFont,
            body: t.captionFont,
            mono: t.monoFont,
            hierarchy: [96, Number(t.captionChunkWords?.[1] ?? 4) * 14 + 28, 28],
          };
        }
        const rules = style["narrative"]?.["styleInvariants"];
        if (Array.isArray(rules) && rules.length > 0) invariants = rules.slice(0, 6);
        break;
      } catch {
        // style not visible from this cwd; try install root
      }
    }
  }
  const shots = [
    {
      id: "s1",
      startSec: 0,
      endSec: 2,
      visual: "Hook frame: subject enters, accent shape snaps into place, highest-contrast type in the film.",
      camera: "fast push-in",
      caption: "The hook lands first",
      engine: "hyperframes" as const,
      sfx: ["sub-hit"],
    },
    {
      id: "s2",
      startSec: 2,
      endSec: 4.5,
      visual: "Body proof: measured claim, data callout or product frame, rhythmic cut on the beat.",
      camera: "slow 2.5D drift",
      caption: "Proof beats decoration",
      engine: "revideo" as const,
      sfx: ["pop"],
    },
    {
      id: "s3",
      startSec: 4.5,
      endSec: 6,
      visual: "Payoff card: title resolves into the call to action with breathing room.",
      camera: "hold with punch-out",
      caption: "Then deliver the master",
      engine: "hyperframes" as const,
      sfx: ["riser"],
    },
  ];
  const plan = PlanSchema.parse({
    meta: {
      title: options.mode === "clone" ? "Reference Clone" : "Edit In Style",
      concept:
        options.mode === "clone"
          ? "1:1 reconstruction of the reference's hook, pacing, type and sound grammar."
          : `Edit raw footage with the ${options.styleSlug ?? "installed"} Style Pack and delivery-grade mastering.`,
      mode: options.mode,
      styleSlug: options.styleSlug,
      aspect: options.aspect,
      resolution: options.resolution,
      fps: 30,
      durationSec,
    },
    palette,
    typography,
    styleInvariants: invariants,
    audio: { direction: "Punchy sub hits, tight whooshes, minimal bed", targetLufs: -14, bpm: 120, sfx: ["sub-hit", "whoosh-fast", "riser"] },
    grade: { notes: "Neutral contrast lift, restrained grain", contrast: 0.1, saturation: 1.05, grainOpacity: 0.04 },
    shots,
  });
  await writeJsonAtomic(planFile, plan);
  const md = renderPlanMarkdown(plan, dims);
  const planMd = path.join(workspace, "PLAN.md");
  await fs.writeFile(planMd, md, "utf8");
  return { planFile, planMd, plan };
}

export function renderPlanMarkdown(plan: PlanT, dims: { width: number; height: number }): string {
  const lines: string[] = [
    `# ${plan.meta.title} — Production Plan`,
    "",
    `- Mode: **${plan.meta.mode}**${plan.meta.styleSlug ? ` · style \`${plan.meta.styleSlug}\`` : ""}`,
    `- Aspect: **${plan.meta.aspect}** · Resolution: **${plan.meta.resolution}** (${dims.width}×${dims.height}) · ${plan.meta.fps} fps · ${plan.meta.durationSec}s`,
    "",
    "## Concept",
    plan.meta.concept,
    "",
    "## Palette",
    "",
    "| Token | Hex |",
    "|---|---|",
    ...plan.palette.map((swatch) => `| ${swatch.name} | \`${swatch.hex}\` |`),
    "",
    "## Typography",
    "",
    `- Display: **${plan.typography.display}** (${plan.typography.hierarchy.join(" / ")} px)`,
    `- Body: **${plan.typography.body}**`,
    `- Mono: **${plan.typography.mono}**`,
    "",
    "## Audio",
    "",
    `- ${plan.audio.direction}`,
    `- Target ${plan.audio.targetLufs} LUFS${plan.audio.bpm ? ` · ${plan.audio.bpm} BPM` : ""}`,
    `- SFX: ${plan.audio.sfx.join(", ") || "—"}`,
    "",
    "## Style invariants",
    "",
    ...plan.styleInvariants.map((rule) => `- ${rule}`),
    "",
    "## Storyboard",
    "",
    "| Shot | Time | Visual | Camera | Caption | Engine | SFX |",
    "|---|---|---|---|---|---|---|",
    ...plan.shots.map(
      (shot) =>
        `| ${shot.id} | ${shot.startSec}–${shot.endSec}s | ${shot.visual} | ${shot.camera} | ${shot.caption} | ${shot.engine} | ${shot.sfx.join(", ")} |`,
    ),
    "",
    "## Approval",
    "",
    "Render the mood board + storyboard, show them to the user, wait for explicit approval, then run `ultra approve --by user`.",
    "",
  ];
  return lines.join("\n");
}

export async function approvePlan(workspace: string, by: string, notes = ""): Promise<ApprovalT> {
  if (!(await pathExists(path.join(workspace, PLAN_FILE)))) throw new Error("plan.json not found — run `ultra plan-init` first");
  const planHash = await computeApprovalHash(workspace);
  const approval = ApprovalSchema.parse({
    approved: true,
    planHash,
    approvedBy: by,
    approvedAt: new Date().toISOString(),
    notes,
  });
  await writeJsonAtomic(path.join(workspace, APPROVAL_FILE), approval);
  return approval;
}

export async function revokeApproval(workspace: string, by: string, notes = ""): Promise<ApprovalT> {
  const approval = ApprovalSchema.parse({
    approved: false,
    planHash: null,
    approvedBy: by,
    approvedAt: new Date().toISOString(),
    notes,
  });
  await writeJsonAtomic(path.join(workspace, APPROVAL_FILE), approval);
  return approval;
}

/* ============================================================================
 * Mood board + storyboard PNG renderer — pure FFmpeg (all render tiers)
 * ========================================================================== */

function luminance(hex: string): number {
  const value = parseInt(hex.replace("#", "").slice(0, 6), 16);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel((value >> 16) & 255) + 0.7152 * channel((value >> 8) & 255) + 0.0722 * channel(value & 255);
}

function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function pickFont(fonts: BundledFont[], role: BundledFont["role"], fallback: string | null): string | null {
  return fonts.find((font) => font.role === role)?.path ?? fallback;
}

async function styleExemplars(slug: string | null): Promise<string[]> {
  if (!slug) return [];
  for (const dir of [path.join(stylesRoot(), slug, "exemplars"), path.join(installRoot(), "styles", slug, "exemplars")]) {
    try {
      const files = (await fs.readdir(dir)).filter((name) => /\.(png|jpg|jpeg|webp)$/i.test(name)).sort();
      if (files.length > 0) return files.slice(0, 4).map((name) => path.join(dir, name));
    } catch {
      // try next base
    }
  }
  return [];
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, Math.max(0, max - 1)) + "…" : text;
}

interface TextSpec {
  text: string;
  size: number;
  color: string;
  x: number | string;
  y: number;
  font: string | null;
  extra?: string;
}

async function drawTexts(tmpDir: string, prefix: string, texts: TextSpec[]): Promise<string[]> {
  const filters: string[] = [];
  for (let i = 0; i < texts.length; i += 1) {
    const spec = texts[i] as TextSpec;
    const file = path.join(tmpDir, `${prefix}_t${i}.txt`);
    await fs.writeFile(file, spec.text, "utf8");
    const options = [
      `textfile='${escapeFilterPath(file)}'`,
      `fontsize=${Math.round(spec.size)}`,
      `fontcolor=${spec.color.replace("#", "0x")}`,
      `x=${typeof spec.x === "number" ? Math.round(spec.x) : spec.x}`,
      `y=${Math.round(spec.y)}`,
      "fix_bounds=1",
      ...(spec.extra ? [spec.extra] : []),
    ];
    if (spec.font) options.push(`fontfile='${escapeFilterPath(spec.font)}'`);
    filters.push(`drawtext=${options.join(":")}`);
  }
  return filters;
}

export interface PreprodRenderResult {
  moodboard: string;
  storyboards: string[];
  width: number;
  height: number;
}

export async function renderPreprod(workspace: string, buildDir: string): Promise<PreprodRenderResult> {
  const plan = await loadPlan(workspace);
  if (!plan) throw new Error("plan.json not found — run `ultra plan-init` first");
  const dims = planDimensions(plan.meta.aspect, plan.meta.resolution);
  const outDir = path.join(buildDir, "preprod");
  const tmpDir = path.join(buildDir, "tmp", "preprod");
  await ensureDir(outDir);
  await ensureDir(tmpDir);
  const fonts = await discoverFonts(workspace);
  const display = pickFont(fonts.bundled, "display", fonts.bold ?? fonts.regular);
  const body = pickFont(fonts.bundled, "regular", fonts.regular);
  const bold = pickFont(fonts.bundled, "bold", fonts.bold ?? body);
  const mono = pickFont(fonts.bundled, "mono", body);
  const palette = Object.fromEntries(plan.palette.map((entry) => [entry.name, entry.hex]));
  const bg = palette["bg"] ?? palette["background"] ?? plan.palette[0]?.hex ?? "#0b0d12";
  const fg = palette["text"] ?? palette["fg"] ?? "#f7f5ef";
  const muted = palette["muted"] ?? "#9aa4b2";
  const accent = palette["accent"] ?? plan.palette[4]?.hex ?? "#ffd447";

  /* ---- mood board ---- */
  const W = 1600;
  const H = 1000;
  const exemplars = await styleExemplars(plan.meta.styleSlug);
  const args: string[] = ["-hide_banner", "-y", "-f", "lavfi", "-i", `color=c=${bg.replace("#", "0x")}:s=${W}x${H}:d=1`];
  for (const file of exemplars) args.push("-i", file);
  const filters: string[] = [];
  let chain = "0:v";
  const boxes: string[] = [];
  boxes.push(`drawbox=x=0:y=0:w=${W}:h=8:color=${accent.replace("#", "0x")}:t=fill`);
  for (let i = 0; i < plan.palette.length && i < 6; i += 1) {
    const swatch = plan.palette[i] as { name: string; hex: string };
    const x = 80 + i * 240;
    boxes.push(`drawbox=x=${x}:y=230:w=200:h=90:color=${swatch.hex.replace("#", "0x")}:t=fill`);
    boxes.push(`drawbox=x=${x}:y=230:w=200:h=90:color=0xffffff@0.15:t=2`);
  }
  boxes.push(`drawbox=x=80:y=600:w=1440:h=130:color=${(palette["surface"] ?? "#151a23").replace("#", "0x")}:t=fill`);
  for (let i = 0; i < 7; i += 1) {
    const color = (plan.palette[i % plan.palette.length]?.hex ?? accent).replace("#", "0x");
    boxes.push(`drawbox=x=${95 + i * 200}:y=615:w=185:h=100:color=${color}@0.28:t=fill`);
  }
  for (let i = 0; i < 4; i += 1) {
    if (i >= exemplars.length) {
      boxes.push(`drawbox=x=${80 + i * 300}:y=${770}:w=260:h=146:color=${(palette["surface"] ?? "#151a23").replace("#", "0x")}:t=fill`);
      boxes.push(`drawbox=x=${80 + i * 300}:y=${770}:w=260:h=146:color=${accent.replace("#", "0x")}@0.35:t=2`);
    }
  }
  const texts: TextSpec[] = [
    { text: plan.meta.title, size: 62, color: fg, x: 80, y: 55, font: display },
    {
      text: `${plan.meta.mode.toUpperCase()} · ${plan.meta.aspect} · ${plan.meta.resolution.toUpperCase()} ${dims.width}×${dims.height} · ${plan.meta.fps} FPS`,
      size: 24,
      color: muted,
      x: 84,
      y: 145,
      font: mono,
    },
    { text: "PALETTE / WCAG CONTRAST", size: 22, color: muted, x: 80, y: 195, font: mono },
    { text: "TYPOGRAPHY HIERARCHY", size: 22, color: muted, x: 80, y: 405, font: mono },
    { text: "HOOK FRAME", size: 74, color: fg, x: 80, y: 445, font: display },
    { text: "Proof beats decoration — measured, not decorative.", size: 32, color: fg, x: 620, y: 492, font: body },
    { text: "00:00:00:00 · Ultra Sans 28 · Ultra Mono 18", size: 18, color: muted, x: 620, y: 542, font: mono },
    { text: "GRADE / TEXTURE MOOD", size: 22, color: muted, x: 80, y: 570, font: mono },
    {
      text: `contrast ${plan.grade.contrast.toFixed(2)} · saturation ${plan.grade.saturation.toFixed(2)} · grain ${plan.grade.grainOpacity.toFixed(2)}`,
      size: 20,
      color: fg,
      x: 1000,
      y: 650,
      font: mono,
    },
    { text: "STYLE EXEMPLARS", size: 22, color: muted, x: 80, y: 740, font: mono },
  ];
  for (let i = 0; i < Math.min(6, plan.palette.length); i += 1) {
    const swatch = plan.palette[i] as { name: string; hex: string };
    texts.push({ text: swatch.hex.toUpperCase(), size: 18, color: fg, x: 80 + i * 240, y: 330, font: mono });
    texts.push({ text: `${swatch.name} · ${contrastRatio(swatch.hex, bg).toFixed(2)}:1`, size: 16, color: muted, x: 80 + i * 240, y: 356, font: mono });
  }
  const textFilters = await drawTexts(tmpDir, "mood", texts);
  filters.push(`[${chain}]${boxes.join(",")}${textFilters.length ? "," + textFilters.join(",") : ""}[vbase]`);
  chain = "vbase";
  for (let i = 0; i < exemplars.length; i += 1) {
    const input = i + 1;
    filters.push(`[${input}:v]scale=260:146:force_original_aspect_ratio=increase,crop=260:146,format=rgba[ex${i}]`);
    filters.push(`[${chain}][ex${i}]overlay=x=${80 + i * 300}:y=770[vex${i}]`);
    chain = `vex${i}`;
  }
  filters.push(`[${chain}]format=rgb24[out]`);
  const moodboard = path.join(outDir, "moodboard.png");
  await ffmpegOk([
    ...args,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[out]",
    "-frames:v",
    "1",
    "-update",
    "1",
    moodboard,
  ]);

  /* ---- storyboard ---- */
  const perPage = 9;
  const pages = Math.ceil(plan.shots.length / perPage);
  const storyboards: string[] = [];
  for (let page = 0; page < pages; page += 1) {
    const pW = 1800;
    const pH = 1200;
    const pageArgs: string[] = ["-hide_banner", "-y", "-f", "lavfi", "-i", `color=c=${bg.replace("#", "0x")}:s=${pW}x${pH}:d=1`];
    const pageFilters: string[] = [];
    const pageBoxes: string[] = [`drawbox=x=0:y=0:w=${pW}:h=8:color=${accent.replace("#", "0x")}:t=fill`];
    const pageTexts: TextSpec[] = [
      { text: `${plan.meta.title} — STORYBOARD ${page + 1}/${pages}`, size: 34, color: fg, x: 60, y: 40, font: display },
      {
        text: `${plan.meta.aspect} · ${dims.width}×${dims.height} · ${plan.meta.fps} FPS · ${plan.meta.durationSec}s`,
        size: 20,
        color: muted,
        x: 60,
        y: 90,
        font: mono,
      },
    ];
    const pageShots = plan.shots.slice(page * perPage, page * perPage + perPage);
    const cellW = 540;
    const cellH = 330;
    const gapX = 30;
    const gapY = 26;
    const left = 60;
    const top = 130;
    pageShots.forEach((shot, index) => {
      const col = index % 3;
      const row = Math.floor(index / 3);
      const x = left + col * (cellW + gapX);
      const y = top + row * (cellH + gapY);
      pageBoxes.push(`drawbox=x=${x}:y=${y}:w=${cellW}:h=${cellH}:color=${(palette["surface"] ?? "#151a23").replace("#", "0x")}:t=fill`);
      pageBoxes.push(`drawbox=x=${x}:y=${y}:w=${cellW}:h=${cellH}:color=${accent.replace("#", "0x")}@0.55:t=2`);
      pageBoxes.push(`drawbox=x=${x + 16}:y=${y + 58}:w=${cellW - 32}:h=190:color=${bg.replace("#", "0x")}:t=fill`);
      // aspect-accurate inner frame
      const aspect = plan.meta.aspect === "9:16" ? 9 / 16 : plan.meta.aspect === "1:1" ? 1 : 16 / 9;
      const maxW = cellW - 64;
      const maxH = 150;
      const frameW = aspect >= 1 ? maxW : Math.round(maxH * aspect);
      const frameH = aspect >= 1 ? Math.round(maxW / aspect) : maxH;
      const fx = x + Math.round((cellW - frameW) / 2);
      const fy = y + 62 + Math.round((maxH + 14 - frameH) / 2);
      pageBoxes.push(`drawbox=x=${fx}:y=${fy}:w=${frameW}:h=${frameH}:color=${(palette["surface"] ?? "#151a23").replace("#", "0x")}:t=fill`);
      pageBoxes.push(`drawbox=x=${fx}:y=${fy}:w=${frameW}:h=${frameH}:color=${accent.replace("#", "0x")}@0.7:t=1`);
      pageBoxes.push(`drawbox=x=${fx + Math.round(frameW * 0.1)}:y=${fy + Math.round(frameH * 0.18)}:w=${Math.round(frameW * 0.46)}:h=${Math.max(8, Math.round(frameH * 0.5))}:color=${accent.replace("#", "0x")}@0.5:t=fill`);
      pageBoxes.push(`drawbox=x=${fx + Math.round(frameW * 0.62)}:y=${fy + Math.round(frameH * 0.2)}:w=${Math.round(frameW * 0.26)}:h=${Math.max(4, Math.round(frameH * 0.06))}:color=${fg.replace("#", "0x")}@0.7:t=fill`);
      pageTexts.push({ text: `${shot.id.toUpperCase()}  ·  ${shot.startSec.toFixed(3)}–${shot.endSec.toFixed(3)}s`, size: 22, color: fg, x: x + 18, y: y + 16, font: mono });
      pageTexts.push({ text: `CAM · ${truncate(shot.camera, 30)}`, size: 15, color: muted, x: x + 18, y: y + 260, font: mono });
      pageTexts.push({ text: `ENGINE · ${shot.engine}`, size: 15, color: muted, x: x + 260, y: y + 260, font: mono });
      if (shot.caption) {
        pageTexts.push({ text: truncate(shot.caption, 44), size: 18, color: fg, x: x + 18, y: y + 286, font: bold });
      }
      if (shot.sfx.length > 0) {
        pageTexts.push({ text: `SFX · ${truncate(shot.sfx.join(" "), 26)}`, size: 14, color: accent, x: x + 300, y: y + 288, font: mono });
      }
    });
    const storyTexts = await drawTexts(tmpDir, `story-${page}`, pageTexts);
    pageFilters.push(`[0:v]${pageBoxes.join(",")},${storyTexts.join(",")},format=rgb24[out]`);
    const out = pages === 1 ? path.join(outDir, "storyboard.png") : path.join(outDir, `storyboard-${String(page + 1).padStart(2, "0")}.png`);
    await ffmpegOk([...pageArgs, "-filter_complex", pageFilters.join(";"), "-map", "[out]", "-frames:v", "1", "-update", "1", out]);
    storyboards.push(out);
  }

  return { moodboard, storyboards, width: dims.width, height: dims.height };
}

/** Deterministic safe-zone repair used by Ralph and preprod validation. */
export function clampTextIntoViewport(
  box: { x: number; y: number; width: number; height: number },
  aspect: "9:16" | "16:9" | "1:1",
  frame: { width: number; height: number },
): { x: number; y: number } | null {
  const zone = dangerZoneForPixelBox(box, aspect, frame.width, frame.height);
  if (!zone) return null;
  const safe = zone.rect;
  const frameX = safe.x * frame.width;
  const frameY = safe.y * frame.height;
  const frameW = safe.width * frame.width;
  const frameH = safe.height * frame.height;
  const x = Math.min(Math.max(box.x, frameX), frameX + Math.max(0, frameW - box.width));
  const y = Math.min(Math.max(box.y, frameY), frameY + Math.max(0, frameH - box.height));
  return { x: Math.round(x), y: Math.round(y) };
}

export function resolveStyleDir(slug: string): string {
  return path.join(stylesRoot(), slug);
}

export function ultraRoot(): string {
  return installRoot();
}
