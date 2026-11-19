import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ffmpegOk, ffprobeJson } from "../core/ffmpeg.js";
import { UltraProject } from "../core/schema.js";
import { extractZip } from "../core/zip.js";
import { loadProject } from "../core/project.js";
import { lintProject } from "../core/orchestrator.js";
import { shutdownBrowser } from "../core/browser.js";
import { ensureDir, pathExists, writeJsonAtomic } from "../core/util.js";
import { ROOT, makeTempDir, runCli } from "./helpers.js";

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

function runIsolated(cwd: string, args: string[], envExtra: Record<string, string> = {}, timeoutMs = 1_200_000): Promise<CliRun> {
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", ...envExtra };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    delete env.ULTRA_FORCE_TIER;
    if (envExtra["ULTRA_FORCE_TIER"]) env.ULTRA_FORCE_TIER = envExtra["ULTRA_FORCE_TIER"];
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`isolated run timed out: ${args.join(" ")}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
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
    child.stdout.on("data", (c: Buffer) => (output += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (output += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? -1, output }));
  });
}

async function makeMovingClip(file: string, width: number, height: number): Promise<void> {
  await ensureDir(path.dirname(file));
  await ffmpegOk([
    "-hide_banner",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${width}x${height}:rate=30:duration=3`,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:duration=3",
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    file,
  ]);
}

const STYLE_SLUGS = ["punchy-shortform", "kinetic-editorial", "dark-tech-launch"] as const;
const TEXT_OR_SCRIPT = /\.(?:mjs|js|ts|py|sh|md|json|txt|html|css|yml|yaml|cmd)$/i;

describe("phase 10 — production hardening (fonts, captions, ffmpeg-only, status, CI)", () => {
  let isolatedDir = "";
  let ultra: (args: string[], env?: Record<string, string>, timeoutMs?: number) => Promise<CliRun>;

  afterAll(async () => {
    await shutdownBrowser().catch(() => undefined);
  });

  it("packs offline fonts + LF-only scripts and all three style packs into the cloud zip", async () => {
    const pack = await packCloud();
    expect(pack.code, pack.output).toBe(0);
    expect(pack.output).toContain("assets/fonts");

    const fontsDir = path.join(ROOT, "assets", "fonts");
    const fontFiles = ["UltraDisplay-Bold.ttf", "UltraSans-Regular.ttf", "UltraSans-Bold.ttf", "UltraMono-Regular.ttf"];
    let fontBytes = 0;
    for (const file of fontFiles) {
      const bytes = await fs.readFile(path.join(fontsDir, file));
      expect(bytes.length).toBeGreaterThan(10_000);
      expect(bytes.subarray(0, 4).toString("hex")).toMatch(/^(00010000|74727565|4f54544f)$/);
      fontBytes += bytes.length;
    }
    expect(fontBytes).toBeLessThanOrEqual(650 * 1024);

    const zipPath = path.join(ROOT, "dist", "ultra-workflow-cloud.zip");
    const zipStat = await fs.stat(zipPath);
    expect(zipStat.size).toBeLessThanOrEqual(2.2 * 1024 * 1024);

    isolatedDir = await fs.mkdtemp(path.join(os.tmpdir(), "ultra-v5-"));
    const { entries } = await extractZip(zipPath, isolatedDir);
    expect(entries.every((entry) => entry.crcOk)).toBe(true);
    const names = new Set(entries.map((entry) => entry.name));
    for (const required of [
      "ultra.mjs",
      "ultra",
      "run.sh",
      "assets/fonts/UltraDisplay-Bold.ttf",
      "assets/fonts/UltraSans-Regular.ttf",
      "assets/fonts/UltraSans-Bold.ttf",
      "assets/fonts/UltraMono-Regular.ttf",
      "engines/py-canvas/render_scene.py",
      "styles/punchy-shortform/style.json",
      "styles/kinetic-editorial/style.json",
      "styles/dark-tech-launch/style.json",
      "styles/punchy-shortform/exemplars/01_hook.png",
      "styles/kinetic-editorial/exemplars/03_data.png",
      "styles/dark-tech-launch/exemplars/03_features.png",
      "prompts/CHATGPT_PROCESS2B_EDIT_MY_VIDEO_IN_STYLE.txt",
    ]) {
      expect(names.has(required), `zip contains ${required}`).toBe(true);
    }
    await expect(fs.stat(path.join(isolatedDir, "node_modules"))).rejects.toThrow();

    for (const entry of entries) {
      if (entry.name === "ultra" || entry.name === "run.sh" || TEXT_OR_SCRIPT.test(entry.name)) {
        const bytes = await fs.readFile(path.join(isolatedDir, entry.name));
        expect(bytes.includes(0x0d), `${entry.name} is LF-only`).toBe(false);
      }
    }

    ultra = (args, env = {}, timeoutMs) => runIsolated(isolatedDir, ["ultra.mjs", ...args], env, timeoutMs);
  });

  it("validates all three built-in Style Packs and lists them", async () => {
    for (const slug of STYLE_SLUGS) {
      const dir = path.join(ROOT, "styles", slug);
      const stat = await fs.stat(path.join(dir, "style.json"));
      expect(stat.size).toBeGreaterThan(200);
      for (const exemplar of (await fs.readdir(path.join(dir, "exemplars"))).filter((f) => f.endsWith(".png"))) {
        expect((await fs.stat(path.join(dir, "exemplars", exemplar))).size).toBeGreaterThan(4_000);
      }
      const validated = await runCli(ROOT, ["style-validate", dir, "--json"]);
      expect(validated.code, validated.stderr).toBe(0);
      const report = JSON.parse(validated.stdout);
      expect(report.ok).toBe(true);
      expect(report.counts.motifs).toBe(2);
      expect(report.counts.exemplars).toBe(3);
    }

    const list = await runCli(ROOT, ["style-list", "--json"]);
    expect(list.code, list.stderr).toBe(0);
    const parsed = JSON.parse(list.stdout) as { slug: string }[];
    for (const slug of STYLE_SLUGS) expect(parsed.some((entry) => entry.slug === slug)).toBe(true);
  });

  it("aligns SRT + script captions, enforces 9:16 safe boxes and lints bottom-UI captions", async () => {
    const dir = await makeTempDir("phase10-captions");
    const srtFile = path.join(dir, "captions.srt");
    await fs.writeFile(
      srtFile,
      [
        "1",
        "00:00:00,200 --> 00:00:01,200",
        "Faster hooks win now",
        "",
        "2",
        "00:00:01,400 --> 00:00:02,800",
        "Zero browser render path",
        "",
      ].join("\n"),
      "utf8",
    );
    const srtOut = path.join(dir, "captions-srt.json");
    const srtRun = await runCli(ROOT, ["captions-align", "--srt", srtFile, "--out", srtOut, "--style", "punchy-shortform", "--aspect", "9:16"]);
    expect(srtRun.code, srtRun.stderr).toBe(0);
    const srtDoc = JSON.parse(await fs.readFile(srtOut, "utf8"));
    expect(srtDoc.aspect).toBe("9:16");
    expect(srtDoc.chunks.length).toBeGreaterThanOrEqual(2);
    const wordTimes: { startSec: number; endSec: number }[] = [];
    for (const chunk of srtDoc.chunks) {
      expect(chunk.words.length).toBeGreaterThanOrEqual(2);
      expect(chunk.words.length).toBeLessThanOrEqual(4);
      expect(chunk.safeBox.yPercent).toBe(62);
      expect(chunk.safeBox.yPercent + chunk.safeBox.heightPercent).toBeLessThanOrEqual(78);
      expect(chunk.safeBox.nominalPixels.frameWidth).toBe(1080);
      for (const word of chunk.words) wordTimes.push(word);
    }
    for (let i = 1; i < wordTimes.length; i += 1) {
      expect(wordTimes[i]?.startSec).toBeGreaterThanOrEqual(wordTimes[i - 1]?.endSec ?? 0);
    }
    const keywords = srtDoc.chunks.flatMap((chunk: { words: { text: string; isKeyword: boolean }[] }) =>
      chunk.words.filter((word) => word.isKeyword).map((word) => word.text.toLowerCase()),
    );
    expect(keywords).toEqual(expect.arrayContaining(["faster", "zero"]));

    // Forced alignment from a plain script + RMS envelope.
    const scriptFile = path.join(dir, "script.txt");
    await fs.writeFile(scriptFile, "Hook them in the first second then never let go", "utf8");
    const fps = 100;
    const frames: number[] = [];
    for (let i = 0; i < 450; i += 1) {
      const t = i / fps;
      frames.push(t >= 0.2 && t < 1.5 ? 0.7 : t >= 1.7 && t < 3.8 ? 0.6 : 0.04);
    }
    const envelopeFile = path.join(dir, "envelope.json");
    await writeJsonAtomic(envelopeFile, { fps, durationSec: 4.5, frames, beatsSec: [0.4, 1.9, 3.1] });
    const scriptOut = path.join(dir, "captions-script.json");
    const scriptRun = await runCli(ROOT, [
      "captions-align",
      "--script",
      scriptFile,
      "--envelope",
      envelopeFile,
      "--out",
      scriptOut,
      "--style",
      "punchy-shortform",
      "--aspect",
      "9:16",
    ]);
    expect(scriptRun.code, scriptRun.stderr).toBe(0);
    const scriptDoc = JSON.parse(await fs.readFile(scriptOut, "utf8"));
    expect(scriptDoc.source.kind).toBe("script-forced");
    expect(scriptDoc.stats.words).toBe(10);
    expect(scriptDoc.chunks.length).toBeGreaterThanOrEqual(3);
    expect(scriptDoc.chunks.every((chunk: { words: unknown[] }) => chunk.words.length <= 4)).toBe(true);
    expect(scriptDoc.stats.activeSpeechSec).toBeGreaterThan(3);

    // The DOM linter must flag a caption parked in the bottom 22% platform UI.
    const projectDir = await makeTempDir("phase10-lint");
    const workspace = path.join(projectDir, "workspace");
    const sceneDir = path.join(workspace, "scenes");
    await ensureDir(sceneDir);
    await fs.writeFile(
      path.join(sceneDir, "bad-caption.html"),
      [
        '<div style="position:absolute;inset:0;background:#0b0d12"></div>',
        '<div data-audit="text" data-caption="true" data-uid="bad-caption" style="position:absolute;left:5%;bottom:2%;padding:12px;background:#ffd447;color:#0b0d12;font:700 44px sans-serif">BOTTOM UI ZONE</div>',
      ].join("\n"),
      "utf8",
    );
    const project = UltraProject.parse({
      meta: {
        title: "safe-zone lint",
        sourceVideoPath: "ref.mp4",
        width: 720,
        height: 1280,
        fps: 30,
        durationSec: 2,
        aspectProfile: "9:16",
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
          id: "bad",
          name: "Bad caption",
          startSec: 0,
          endSec: 2,
          engine: "hyperframes",
          background: "#0b0d12",
          customHtmlFile: "bad-caption.html",
        } as never,
      ],
    });
    await writeJsonAtomic(path.join(workspace, "ultra.json"), project);
    const loaded = await loadProject(workspace);
    const lint = await lintProject({ project: loaded, workspace, buildDir: path.join(projectDir, "build") });
    const layoutDefects = lint.scenes.flatMap((scene) => scene.defects).filter((defect) => defect.category === "layout");
    expect(layoutDefects.some((defect) => /bottom caption\/audio UI safe-zone/.test(defect.detail))).toBe(true);
    expect(lint.pass).toBe(true); // platform-zone warnings are structured, non-critical defects
  });

  it("live-renders a verified CFR yuv420p MP4 on the forced ffmpeg-only tier", async () => {
    expect(isolatedDir).not.toBe("");
    const forced = { ULTRA_FORCE_TIER: "ffmpeg-only" };
    const doctor = await ultra(["doctor", "--json"], forced);
    expect(doctor.code, doctor.stderr).toBe(0);
    const doctorJson = JSON.parse(doctor.stdout);
    expect(doctorJson.renderTier).toBe("ffmpeg-only");
    expect(doctorJson.forcedTier).toBe("ffmpeg-only");
    expect(doctorJson.fonts.bundledFonts).toHaveLength(4);
    expect(doctorJson.fonts.regular).toContain("UltraSans");

    const workspace = path.join(isolatedDir, "workspace");
    await ensureDir(path.join(workspace, "assets"));
    const raw = path.join(isolatedDir, "raw.mp4");
    await makeMovingClip(raw, 540, 960);

    const srt = path.join(isolatedDir, "a.srt");
    await fs.writeFile(
      srt,
      ["1", "00:00:00,200 --> 00:00:01,200", "Faster hooks win", "", "2", "00:00:01,400 --> 00:00:02,800", "Zero browser render path", ""].join(
        "\n",
      ),
      "utf8",
    );
    const aligned = await ultra(["captions-align", "--srt", srt, "--style", "punchy-shortform", "--aspect", "9:16", "--out", "workspace/captions.json"], forced);
    expect(aligned.code, aligned.stderr).toBe(0);

    const project = UltraProject.parse({
      meta: {
        title: "ffmpeg-only proof",
        sourceVideoPath: "raw.mp4",
        width: 540,
        height: 960,
        fps: 30,
        durationSec: 3,
        aspectProfile: "9:16",
      },
      designTokens: {
        palette: { bg: "#0b0d12", fg: "#f7f5ef", accent: "#ffd447", secondary: "#ff5a5f" },
        fonts: { heading: "Ultra Display", body: "Ultra Sans", mono: "Ultra Mono" },
        grainOpacity: 0.04,
        antiSlopRules: ["no stock gradients", "captions inside safe zone"],
      },
      colorGrade: { contrast: 0.1, saturation: 1.05, vignette: 0.2 },
      audio: { targetLufs: -14, duckingDb: -12, sfxCues: [] },
      assets: [],
      scenes: [
        {
          id: "main",
          name: "Main",
          startSec: 0,
          endSec: 3,
          engine: "hyperframes",
          background: "#0b0d12",
          sourceClip: { path: "raw.mp4", inSec: 0, outSec: 3, cropMode: "cover" },
          effects: [{ type: "grain", intensity: 0.05 }],
          motionBlurSamples: 2,
        },
      ],
    });
    await writeJsonAtomic(path.join(workspace, "ultra.json"), project);

    const build = await ultra(["-w", "workspace", "build"], forced);
    expect(build.code, build.stderr).toBe(0);
    const manifest = JSON.parse(await fs.readFile(path.join(isolatedDir, "build", "build-manifest.json"), "utf8"));
    expect(manifest.scenes).toHaveLength(1);
    expect(manifest.scenes[0].engineUsed).toBe("ffmpeg-only");
    expect(manifest.scenes[0].fallbackReason).toBe("ffmpeg-only");
    await expect(fs.stat(path.join(isolatedDir, "node_modules"))).rejects.toThrow();

    const verify = await ultra(["-w", "workspace", "verify", "raw.mp4"], forced);
    expect(verify.code, verify.stderr).toBe(0);
    const report = JSON.parse(await fs.readFile(path.join(isolatedDir, "build", "verify-report.json"), "utf8"));
    expect(report.quantitative.stutterEvents).toBe(0);
    expect(report.quantitative.cfr).toBe(true);
    expect(report.quantitative.fpsActual).toBe(30);
    expect(report.quantitative.pass).toBe(true);
    expect(report.lint.pass).toBe(true);
    expect(report.pass).toBe(true);
    expect(report.visualPairs.length).toBeGreaterThanOrEqual(1);

    const render = await ultra(["-w", "workspace", "render"], forced);
    expect(render.code, render.stderr).toBe(0);
    const finalFile = path.join(isolatedDir, "build", "ultra-final.mp4");
    const probe = await ffprobeJson(finalFile);
    const video = probe.streams.find(
      (stream: { codec_type?: string }) => stream.codec_type === "video",
    ) as { codec_name?: string; pix_fmt?: string; r_frame_rate?: string; nb_frames?: string | number } | undefined;
    expect(video?.codec_name).toBe("h264");
    expect(video?.pix_fmt).toBe("yuv420p");
    expect(video?.r_frame_rate).toBe("30/1");
    expect(Number(video?.nb_frames)).toBeGreaterThanOrEqual(88);
    expect(Number(video?.nb_frames)).toBeLessThanOrEqual(92);
    expect(Math.abs(Number(probe.format.duration) - 3)).toBeLessThanOrEqual(0.1);
  });

  it("reports stage progression and the exact next command via ultra status --json", async () => {
    const dir = await makeTempDir("phase10-status");
    const workspace = path.join(dir, "workspace");
    await ensureDir(workspace);

    const empty = await runCli(dir, ["status", "--json"]);
    expect(empty.code, empty.stderr).toBe(0);
    const emptyJson = JSON.parse(empty.stdout);
    expect(emptyJson.process).toBe("uninitialized");
    expect(emptyJson.nextCommand).toContain("ultra init");

    await ensureDir(path.join(dir, "styles", "punchy-shortform"));
    await writeJsonAtomic(path.join(dir, "styles", "punchy-shortform", "style.json"), {
      meta: { slug: "punchy-shortform" },
    });
    await ensureDir(path.join(workspace, "raw-probe"));
    await writeJsonAtomic(path.join(workspace, "raw-probe", "raw-edit-plan.json"), {
      styleSlug: "punchy-shortform",
      keepSegments: [],
    });
    await writeJsonAtomic(path.join(workspace, "captions.json"), { version: 1, chunks: [] });
    await writeJsonAtomic(path.join(dir, "build", "draft.mp4"), "draft-bytes");
    await writeJsonAtomic(path.join(dir, "build", "verify-report.json"), {
      pass: true,
      rubric: { categories: [{ items: [{ score: 20 }, { score: 20 }, { score: 20 }, { score: 20 }, { score: 20 }] }] },
    });
    await writeJsonAtomic(
      path.join(workspace, "ultra.json"),
      {
        meta: { title: "status", sourceVideoPath: "my.mp4", width: 720, height: 1280, fps: 30, durationSec: 3 },
        scenes: [{ id: "s", sourceClip: { path: "my.mp4", inSec: 0, outSec: 3 } }],
        assets: [],
      },
    );

    const progressed = await runCli(dir, ["status", "--json"]);
    expect(progressed.code, progressed.stderr).toBe(0);
    const status = JSON.parse(progressed.stdout);
    expect(status.process).toBe("edit-in-style");
    expect(status.styleSlug).toBe("punchy-shortform");
    expect(status.verify.pass).toBe(true);
    expect(status.verify.score).toBe(100);
    for (const stage of ["installed style pack", "raw-probe edit plan", "word-level captions", "edit plan (ultra.json)", "assets", "draft build", "Rule 5 verify"]) {
      expect(status.stages.find((entry: { name: string }) => entry.name === stage)?.done, `${stage} done`).toBe(true);
    }
    expect(status.nextCommand).toBe("ultra render");

    await fs.rm(path.join(dir, "build", "draft.mp4"), { force: true });
    const rebuild = await runCli(dir, ["status", "--json"]);
    const rebuildJson = JSON.parse(rebuild.stdout);
    expect(rebuildJson.stages.find((entry: { name: string }) => entry.name === "draft build")?.done).toBe(false);
    expect(rebuildJson.nextCommand).toBe("ultra build");
  });
});
