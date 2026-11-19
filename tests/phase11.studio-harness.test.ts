import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ffmpegOk, ffprobeJson } from "../core/ffmpeg.js";
import { UltraProject } from "../core/schema.js";
import { extractZip } from "../core/zip.js";
import { ensureDir, pathExists, writeJsonAtomic } from "../core/util.js";
import { ROOT, makeTempDir, runCli } from "./helpers.js";

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

function runCliEnv(cwd: string, args: string[], envExtra: Record<string, string> = {}, timeoutMs = 1_200_000): Promise<CliRun> {
  const requireFromRoot = createRequire(path.join(ROOT, "package.json"));
  const loaderPath = requireFromRoot.resolve("tsx/esm");
  const binPath = path.join(ROOT, "bin", "ultra.ts");
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", ...envExtra };
    const child = spawn(process.execPath, ["--import", pathToFileURL(loaderPath).href, binPath, ...args], {
      cwd,
      windowsHide: true,
      env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: ${args.join(" ")}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

function runNodeIsolated(cwd: string, args: string[], envExtra: Record<string, string> = {}, timeoutMs = 1_200_000): Promise<CliRun> {
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", ...envExtra };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`isolated timed out: ${args.join(" ")}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

function packCloud(): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "pack:cloud"], {
      cwd: ROOT,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? -1, output }));
  });
}

async function makeClip(file: string, width: number, height: number, duration: number): Promise<void> {
  await ensureDir(path.dirname(file));
  await ffmpegOk([
    "-hide_banner",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${width}x${height}:rate=30:duration=${duration}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=330:duration=${duration}`,
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    file,
  ]);
}

function pythonBin(): string | null {
  for (const candidate of ["python", "python3"]) {
    const result = spawnSync(candidate, ["-c", "print(1)"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }
  return null;
}

function validateXml(file: string): boolean {
  const python = pythonBin();
  if (!python) return false;
  const script = `import xml.etree.ElementTree as ET; ET.parse(${JSON.stringify(file.replace(/\\/g, "/"))})`;
  return spawnSync(python, ["-c", script], { encoding: "utf8" }).status === 0;
}

const FAST = { ULTRA_FORCE_TIER: "ffmpeg-only", ULTRA_NO_BROWSER: "1" };

describe("phase 11 — studio harness, pre-prod approval, 4K mastering + editable delivery", () => {
  it("ranks RAG knowledge, budgets context packs and blocks hallucinated projects with guard", async () => {
    const rag = await runCli(ROOT, ["rag", "query", "9:16 pill caption hook", "--aspect", "9:16", "--json"], 300_000);
    expect(rag.code, rag.stderr).toBe(0);
    const ragJson = JSON.parse(rag.stdout) as { hits: { kind: string; title: string; path: string; score: number }[] };
    expect(ragJson.hits.length).toBeGreaterThanOrEqual(3);
    expect(ragJson.hits.slice(0, 4).some((hit) => hit.kind === "style" && /punchy/i.test(`${hit.title} ${hit.path}`))).toBe(true);
    expect(ragJson.hits.slice(0, 4).some((hit) => hit.kind === "motif" && /punchy-shortform/.test(hit.path))).toBe(true);

    const dir = await makeTempDir("phase11-context");
    const plan = await runCli(dir, ["plan-init", "--mode", "edit-in-style", "--style", "punchy-shortform", "--aspect", "9:16"], 120_000);
    expect(plan.code, plan.stderr).toBe(0);
    const pack = await runCliEnv(dir, ["context-pack", "--stage", "preprod", "--budget-tokens", "2000"], {}, 120_000);
    expect(pack.code, pack.stderr).toBe(0);
    const briefFile = path.join(dir, "workspace", "context", "brief.md");
    const brief = await fs.readFile(briefFile, "utf8");
    expect(Math.ceil(brief.length / 4)).toBeLessThanOrEqual(2000);
    expect(brief).toContain("preprod");
    expect(brief).toContain("Next command");

    const guardDir = await makeTempDir("phase11-guard");
    const workspace = path.join(guardDir, "workspace");
    await ensureDir(path.join(workspace, "assets"));
    const hallucinated = {
      meta: { title: "Hallucinated", sourceVideoPath: "ref.mp4", width: 1280, height: 720, fps: 30, durationSec: 2 },
      designTokens: {
        palette: { bg: "#0b0d12", fg: "#f7f5ef", accent: "#ffd447" },
        fonts: { heading: "Ultra Display", body: "Ultra Sans", mono: "Ultra Mono" },
        grainOpacity: 0.03,
        antiSlopRules: ["palette only"],
      },
      colorGrade: {},
      audio: {},
      assets: [{ id: "ghost", type: "image", description: "ghost asset", prompt: "x", targetPath: "assets/missing.png" }],
      scenes: [
        {
          id: "s1",
          name: "S1",
          startSec: 0,
          endSec: 2,
          engine: "hyperframes",
          background: "#0b0d12",
          textElements: [
            { id: "t", text: "Lorem ipsum dolor sit amet", font: "heading", sizePx: 60, color: "#f7f5ef", x: 80, y: 300 },
          ],
        },
      ],
    };
    await writeJsonAtomic(path.join(workspace, "ultra.json"), hallucinated);
    const guard = await runCli(guardDir, ["guard", "--stage", "plan", "--json"], 120_000);
    expect(guard.code).not.toBe(0);
    const guardJson = JSON.parse(guard.stdout);
    expect(guardJson.ok).toBe(false);
    const checks = guardJson.errors.map((error: { check: string }) => error.check);
    expect(checks).toContain("asset");
    expect(checks).toContain("placeholder");
  });

  it("Process 2B: mood board + storyboard approval hard-blocks build AND render until approved", async () => {
    const dir = await makeTempDir("phase11-preprod");
    const plan = await runCli(dir, ["plan-init", "--mode", "edit-in-style", "--style", "punchy-shortform", "--aspect", "9:16", "--resolution", "1080p"], 120_000);
    expect(plan.code, plan.stderr).toBe(0);
    const workspace = path.join(dir, "workspace");
    const project = UltraProject.parse({
      meta: {
        title: "Gate",
        sourceVideoPath: "ref.mp4",
        width: 720,
        height: 1280,
        fps: 30,
        durationSec: 2,
        aspectProfile: "9:16",
        processMode: "edit-in-style",
      },
      designTokens: {
        palette: { bg: "#0b0d12", fg: "#f7f5ef", accent: "#ffd447" },
        fonts: { heading: "Ultra Display", body: "Ultra Sans", mono: "Ultra Mono" },
        grainOpacity: 0.03,
        antiSlopRules: ["palette only"],
      },
      colorGrade: {},
      audio: {},
      assets: [],
      scenes: [
        {
          id: "s1",
          name: "S1",
          startSec: 0,
          endSec: 2,
          engine: "hyperframes",
          background: "#0b0d12",
          textElements: [{ id: "t", text: "APPROVED BUILD", font: "heading", sizePx: 64, color: "#f7f5ef", x: 60, y: 520, width: 600 }],
        },
      ],
    });
    await writeJsonAtomic(path.join(workspace, "ultra.json"), project);

    // Pre-prod deliverables do not exist yet: build must fail on the Process 2B gate.
    const missingAssets = await runCliEnv(dir, ["build", "--proxy"], FAST, 300_000);
    expect(missingAssets.code).not.toBe(0);
    expect(`${missingAssets.stdout}\n${missingAssets.stderr}`).toContain("preprod-approval-required");

    const preprod = await runCli(dir, ["preprod-render"], 180_000);
    expect(preprod.code, preprod.stderr).toBe(0);
    const moodboard = path.join(dir, "build", "preprod", "moodboard.png");
    const storyboard = path.join(dir, "build", "preprod", "storyboard.png");
    for (const file of [moodboard, storyboard]) {
      const bytes = await fs.readFile(file);
      expect(bytes.length).toBeGreaterThan(10_000);
      expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
    }

    const blockedBuild = await runCliEnv(dir, ["build", "--proxy"], FAST, 300_000);
    expect(blockedBuild.code).not.toBe(0);
    expect(`${blockedBuild.stdout}\n${blockedBuild.stderr}`).toContain("PRE-PRODUCTION APPROVAL REQUIRED");
    const blockedRender = await runCliEnv(dir, ["render", "--force"], FAST, 300_000);
    expect(blockedRender.code).not.toBe(0);
    expect(`${blockedRender.stdout}\n${blockedRender.stderr}`).toContain("preprod-approval-required");

    const approved = await runCli(dir, ["approve", "--by", "ci", "--notes", "phase11"], 60_000);
    expect(approved.code, approved.stderr).toBe(0);
    const approval = JSON.parse(await fs.readFile(path.join(workspace, "approval.json"), "utf8"));
    expect(approval.approved).toBe(true);
    expect(approval.planHash).toMatch(/^[0-9a-f]{64}$/);

    const built = await runCliEnv(dir, ["build", "--proxy"], FAST, 300_000);
    expect(built.code, built.stderr).toBe(0);
    expect(await pathExists(path.join(dir, "build", "draft.mp4"))).toBe(true);
    const rendered = await runCliEnv(dir, ["render", "--force"], FAST, 300_000);
    expect(rendered.code, `${rendered.stdout}\n${rendered.stderr}`).toBe(0);
    expect(await pathExists(path.join(dir, "build", "ultra-final.mp4"))).toBe(true);
    const status = await runCliEnv(dir, ["status", "--json"], FAST, 120_000);
    expect(status.code, status.stderr).toBe(0);
    const statusJson = JSON.parse(status.stdout);
    expect(statusJson.processMode).toBe("edit-in-style");
    expect(statusJson.stages.some((stage: { name: string; done: boolean }) => stage.name === "plan approval (2B)" && stage.done)).toBe(true);
  });

  it("Process 1 (extract-style) runs style-probe -> validate -> export with no plan/approval pause", async () => {
    const dir = await makeTempDir("phase11-process1");
    const ref = path.join(dir, "ref.mp4");
    await makeClip(ref, 640, 360, 2);
    const probe = await runCli(dir, ["style-probe", "ref.mp4", "--out", "workspace/style-probe", "--hook-window", "1"], 300_000);
    expect(probe.code, probe.stderr).toBe(0);
    expect(await pathExists(path.join(dir, "workspace", "style-probe", "aggregate.json"))).toBe(true);
    expect(await pathExists(path.join(dir, "workspace", "plan.json"))).toBe(false);
    expect(await pathExists(path.join(dir, "workspace", "approval.json"))).toBe(false);
    const state = JSON.parse(await fs.readFile(path.join(dir, "workspace", "state.json"), "utf8"));
    expect(state.processMode).toBe("extract-style");

    const packDir = path.join(dir, "pack", "punchy-shortform");
    await fs.cp(path.join(ROOT, "styles", "punchy-shortform"), packDir, { recursive: true });
    const validated = await runCli(dir, ["style-validate", packDir], 120_000);
    expect(validated.code, validated.stderr).toBe(0);
    const exported = await runCli(dir, ["style-export", packDir, "--out", "build/punchy-style-pack.zip"], 120_000);
    expect(exported.code, exported.stderr).toBe(0);
    expect(await pathExists(path.join(dir, "build", "punchy-style-pack.zip"))).toBe(true);
    expect(await pathExists(path.join(dir, "workspace", "approval.json"))).toBe(false);
  });

  it("Ralph deterministically heals safe-zone, contrast and scoring regressions", async () => {
    const dir = await makeTempDir("phase11-ralph");
    const workspace = path.join(dir, "workspace");
    await ensureDir(workspace);
    await makeClip(path.join(dir, "raw.mp4"), 720, 1280, 1.5);
    const project = UltraProject.parse({
      meta: {
        title: "Ralph heal",
        sourceVideoPath: "raw.mp4",
        width: 720,
        height: 1280,
        fps: 30,
        durationSec: 1.5,
        aspectProfile: "9:16",
      },
      designTokens: {
        palette: { bg: "#0b0d12", fg: "#f7f5ef", accent: "#ffd447", muted: "#9aa4b2" },
        fonts: { heading: "Ultra Display", body: "Ultra Sans", mono: "Ultra Mono" },
        grainOpacity: 0.03,
        antiSlopRules: ["palette only"],
      },
      colorGrade: {},
      audio: { targetLufs: -14, duckingDb: -12, sfxCues: [] },
      assets: [],
      scenes: [
        {
          id: "s1",
          name: "S1",
          startSec: 0,
          endSec: 1.5,
          engine: "hyperframes",
          background: "#0b0d12",
          sourceClip: { path: "raw.mp4", inSec: 0, outSec: 1.5, cropMode: "cover" },
          textElements: [
            { id: "bad", text: "LOW CONTRAST DANGER ZONE", font: "heading", sizePx: 64, color: "#0b0d12", x: 60, y: 1120, width: 600 },
          ],
        },
      ],
    });
    await writeJsonAtomic(path.join(workspace, "ultra.json"), project);

    const init = await runCliEnv(dir, ["ralph", "init", "--max-iter", "3", "--min-score", "90"], FAST, 60_000);
    expect(init.code, init.stderr).toBe(0);
    const fix = await runCliEnv(dir, ["ralph", "auto-fix"], FAST, 600_000);
    expect(fix.code, `${fix.stdout}\n${fix.stderr}`).toBe(0);
    const state = JSON.parse(await fs.readFile(path.join(workspace, "ralph-state.json"), "utf8"));
    expect(state.status).toBe("satisfied");
    expect(state.bestScore).toBeGreaterThanOrEqual(90);
    expect(state.history.length).toBeGreaterThanOrEqual(2);
    expect(state.history[0].score).toBeLessThan(state.history[state.history.length - 1].score);
    expect(state.history[state.history.length - 1].stutterEvents).toBe(0);
    const healed = JSON.parse(await fs.readFile(path.join(workspace, "ultra.json"), "utf8"));
    const text = healed.scenes[0].textElements[0];
    expect(text.color).not.toBe("#0b0d12");
    expect(text.y + text.sizePx * text.lineHeight).toBeLessThanOrEqual(1280 * 0.78 + 2);
    const history = await fs.readFile(path.join(workspace, "ralph-history.md"), "utf8");
    expect(history).toContain("Ralph loop history");
  });

  it("Process 2A: clone-reference builds, verifies, masters 4K, exports and guards with NO plan/approval", async () => {
    const dir = await makeTempDir("phase11-master");
    const raw = path.join(dir, "raw.mp4");
    await makeClip(raw, 1280, 720, 1.5);
    const probed = await runCliEnv(dir, ["probe", "raw.mp4"], {}, 300_000);
    expect(probed.code, probed.stderr).toBe(0);
    const workspace = path.join(dir, "workspace");
    await ensureDir(workspace);
    const project = UltraProject.parse({
      meta: {
        title: "4K master",
        sourceVideoPath: "raw.mp4",
        width: 1280,
        height: 720,
        fps: 30,
        durationSec: 1.5,
        aspectProfile: "16:9",
        deliveryResolution: "4k",
        processMode: "clone-reference",
      },
      designTokens: {
        palette: { bg: "#0b0d12", fg: "#f7f5ef", accent: "#ffd447", secondary: "#8ecae6" },
        fonts: { heading: "Ultra Display", body: "Ultra Sans", mono: "Ultra Mono" },
        grainOpacity: 0.03,
        antiSlopRules: ["palette only"],
      },
      colorGrade: { contrast: 0.08, saturation: 1.04, vignette: 0.15 },
      audio: { targetLufs: -14, duckingDb: -12, sfxCues: [] },
      assets: [],
      scenes: [
        {
          id: "main",
          name: "Main",
          startSec: 0,
          endSec: 1.5,
          engine: "hyperframes",
          background: "#0b0d12",
          sourceClip: { path: "raw.mp4", inSec: 0, outSec: 1.5, cropMode: "cover" },
          textElements: [{ id: "t", text: "MASTERED", font: "heading", sizePx: 80, color: "#f7f5ef", x: 80, y: 260, width: 700 }],
        },
      ],
    });
    await writeJsonAtomic(path.join(workspace, "ultra.json"), project);
    expect(await pathExists(path.join(workspace, "plan.json"))).toBe(false);
    expect(await pathExists(path.join(workspace, "approval.json"))).toBe(false);
    const status = await runCliEnv(dir, ["status", "--json"], FAST, 120_000);
    expect(status.code, status.stderr).toBe(0);
    const statusJson = JSON.parse(status.stdout);
    expect(statusJson.processMode).toBe("clone-reference");
    expect(statusJson.nextCommand).not.toMatch(/approve|plan-init|preprod/i);

    const build = await runCliEnv(dir, ["build"], FAST, 300_000);
    expect(build.code, build.stderr).toBe(0);
    const verify = await runCliEnv(dir, ["verify", "raw.mp4"], FAST, 600_000);
    expect(verify.code, `${verify.stdout}\n${verify.stderr}`).toBe(0);
    const verifyReport = JSON.parse(await fs.readFile(path.join(dir, "build", "verify-report.json"), "utf8"));
    expect(verifyReport.quantitative.stutterEvents).toBe(0);
    expect(verifyReport.pass).toBe(true);

    const render = await runCliEnv(dir, ["render", "--4k"], FAST, 900_000);
    expect(render.code, `${render.stdout}\n${render.stderr}`).toBe(0);
    const master = path.join(dir, "build", "ultra-final.mp4");
    const probe = await ffprobeJson(master);
    const video = probe.streams.find((stream: { codec_type?: string }) => stream.codec_type === "video") as {
      codec_name?: string;
      width?: number;
      height?: number;
      pix_fmt?: string;
      r_frame_rate?: string;
      avg_frame_rate?: string;
    };
    const audio = probe.streams.find((stream: { codec_type?: string }) => stream.codec_type === "audio") as {
      codec_name?: string;
      sample_rate?: string;
      channels?: number;
    };
    expect([video.width, video.height]).toEqual([3840, 2160]);
    expect(video.pix_fmt).toBe("yuv420p");
    expect(video.codec_name).toBe("h264");
    expect(video.r_frame_rate).toBe("30/1");
    expect(video.avg_frame_rate).toBe("30/1");
    expect(audio.codec_name).toBe("aac");
    expect(audio.sample_rate).toBe("48000");
    expect(audio.channels).toBe(2);
    expect(Math.abs(Number(probe.format.duration) - 1.5)).toBeLessThanOrEqual(0.1);
    const delivery = JSON.parse(await fs.readFile(path.join(dir, "build", "delivery-manifest.json"), "utf8"));
    expect(delivery.strategy).toMatch(/hybrid|native/);
    expect(delivery.target).toEqual({ width: 3840, height: 2160 });
    expect(delivery.pass).toBe(true);

    const exported = await runCli(dir, ["export-project"], 180_000);
    expect(exported.code, exported.stderr).toBe(0);
    const exportDir = path.join(dir, "build", "editable-project");
    for (const file of ["timeline.fcpxml", "timeline.otio", "project.ultra.json", "index.html", "assets"]) {
      expect(await pathExists(path.join(exportDir, file)), `${file} exists`).toBe(true);
    }
    expect(validateXml(path.join(exportDir, "timeline.fcpxml"))).toBe(true);
    const fcpxml = await fs.readFile(path.join(exportDir, "timeline.fcpxml"), "utf8");
    expect(fcpxml).toContain('width="3840"');
    expect(fcpxml).toContain('height="2160"');
    const otio = JSON.parse(await fs.readFile(path.join(exportDir, "timeline.otio"), "utf8"));
    expect(otio.OTIO_SCHEMA).toBe("Timeline.1");
    expect(otio.tracks.OTIO_SCHEMA).toBe("Stack.1");
    expect(otio.tracks.children.map((track: { name: string }) => track.name)).toEqual(["Video", "Overlays", "Audio"]);
    expect(otio.tracks.children[0].OTIO_SCHEMA).toBe("Track.1");
    expect(otio.tracks.children[0].children[0].OTIO_SCHEMA).toBe("Clip.1");
    expect(otio.metadata.ultra.width).toBe(3840);
    const exportedProjectText = await fs.readFile(path.join(exportDir, "project.ultra.json"), "utf8");
    expect(exportedProjectText).not.toMatch(/[A-Za-z]:\\\\/);
    expect(exportedProjectText).not.toContain("/Users/");
    expect(exportedProjectText).toContain("assets/");
    const inspector = await fs.readFile(path.join(exportDir, "index.html"), "utf8");
    expect(inspector).toContain("project-data");
    expect(inspector).not.toContain("http://");
    expect(inspector).not.toContain("https://");
    const zip = await extractZip(path.join(dir, "build", "editable-project.zip"), await fs.mkdtemp(path.join(os.tmpdir(), "phase11-export-")));
    expect(zip.entries.length).toBeGreaterThan(5);
    expect(zip.entries.every((entry) => entry.crcOk)).toBe(true);

    const guard = await runCli(dir, ["guard", "--stage", "delivery", "--json"], 120_000);
    expect(guard.code, guard.stderr).toBe(0);
    const guardJson = JSON.parse(guard.stdout);
    expect(guardJson.ok).toBe(true);
    expect(guardJson.errors).toEqual([]);
    expect(await pathExists(path.join(workspace, "approval.json"))).toBe(false);
  });

  it("runs rag, context-pack and preprod-render from the zero-install cloud zip", async () => {
    const pack = await packCloud();
    expect(pack.code, pack.output).toBe(0);
    const zipPath = path.join(ROOT, "dist", "ultra-workflow-cloud.zip");
    const stat = await fs.stat(zipPath);
    expect(stat.size).toBeLessThanOrEqual(2.5 * 1024 * 1024);
    const isolated = await fs.mkdtemp(path.join(os.tmpdir(), "phase11-cloud-"));
    const { entries } = await extractZip(zipPath, isolated);
    expect(entries.every((entry) => entry.crcOk)).toBe(true);
    const names = new Set(entries.map((entry) => entry.name));
    for (const required of [
      "ultra.mjs",
      "dist/rag-index.json",
      "AGENTS.md",
      ".ultra/rules/01-approval-gate.md",
      ".ultra/skills/preprod-storyboard/SKILL.md",
      ".ultra/agents/director.md",
      "assets/fonts/UltraDisplay-Bold.ttf",
    ]) {
      expect(names.has(required), `zip contains ${required}`).toBe(true);
    }
    await expect(fs.stat(path.join(isolated, "node_modules"))).rejects.toThrow();

    const rag = await runNodeIsolated(isolated, ["ultra.mjs", "rag", "query", "9:16 pill caption hook", "--aspect", "9:16", "--json"], {}, 300_000);
    expect(rag.code, rag.stderr).toBe(0);
    const ragJson = JSON.parse(rag.stdout);
    expect(ragJson.hits.some((hit: { kind: string; title: string; path: string }) => /punchy/i.test(`${hit.title} ${hit.path}`))).toBe(true);

    const plan = await runNodeIsolated(isolated, ["ultra.mjs", "plan-init", "--aspect", "9:16", "--resolution", "1080p"], {}, 180_000);
    expect(plan.code, plan.stderr).toBe(0);
    const context = await runNodeIsolated(isolated, ["ultra.mjs", "context-pack", "--stage", "preprod", "--budget-tokens", "2000"], {}, 180_000);
    expect(context.code, context.stderr).toBe(0);
    const brief = await fs.readFile(path.join(isolated, "workspace", "context", "brief.md"), "utf8");
    expect(Math.ceil(brief.length / 4)).toBeLessThanOrEqual(2000);
    const preprod = await runNodeIsolated(isolated, ["ultra.mjs", "preprod-render"], {}, 300_000);
    expect(preprod.code, preprod.stderr).toBe(0);
    for (const file of ["moodboard.png", "storyboard.png"]) {
      const bytes = await fs.readFile(path.join(isolated, "build", "preprod", file));
      expect(bytes.length).toBeGreaterThan(10_000);
      expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
    }
  });
});
