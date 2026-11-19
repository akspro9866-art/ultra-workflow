import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ffmpegOk, ffprobeJson } from "../core/ffmpeg.js";
import { UltraProject } from "../core/schema.js";
import { writeJsonAtomic } from "../core/util.js";
import { extractZip } from "../core/zip.js";
import { PALETTE, ROOT, makeReferenceVideo } from "./helpers.js";

const C9 = {
  bg: "#101820",
  surface: "#1a2634",
  fg: "#f2f2f0",
  accent: "#ffb703",
  secondary: "#8ecae6",
};

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

function runIsolated(cwd: string, args: string[], timeoutMs = 1_200_000): Promise<CliRun> {
  return new Promise<CliRun>((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", ULTRA_NO_BROWSER: "1" };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
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

async function makeRawClip(file: string): Promise<void> {
  await ffmpegOk([
    "-f",
    "lavfi",
    "-i",
    `color=c=0x101820:s=1280x720:d=3:r=30`,
    "-f",
    "lavfi",
    "-i",
    `color=c=0xffb703:s=260x150:d=3:r=30`,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:duration=3",
    "-filter_complex",
    "[0:v][1:v]overlay=x='mod(t*420,1000)':y=280:shortest=1,format=yuv420p[v];[2:a]volume='0.6+0.2*sin(2*PI*1.5*t)':eval=frame[a]",
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-r",
    "30",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-t",
    "3",
    file,
  ]);
}

const SCENE_GRAPH = {
  durationSec: 1.5,
  fps: 30,
  width: 1280,
  height: 720,
  backgroundAlpha: true,
  camera: { position: [0, 1.2, 3.6], target: [0, 0, 0], fov: 45, keyframes: [] },
  lights: [
    { type: "point", color: "#ffffff", intensity: 4, position: [2, 3, 3] },
    { type: "ambient", color: "#8ecae6", intensity: 0.5, position: [0, 0, 0] },
  ],
  materials: [
    { id: "amber", color: "#ffb703", metalness: 0.5, roughness: 0.4 },
    { id: "sky", color: "#8ecae6", metalness: 0.2, roughness: 0.6 },
  ],
  meshes: [
    {
      id: "cube",
      primitive: "cube",
      materialId: "amber",
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1.1, 1.1, 1.1],
      keyframes: [
        { atSec: 0, rotation: [0, 0, 0] },
        { atSec: 1.5, rotation: [20, 140, 30] },
      ],
    },
    {
      id: "sphere",
      primitive: "sphere",
      materialId: "sky",
      position: [1.2, 0.2, 0],
      rotation: [0, 0, 0],
      scale: [0.8, 0.8, 0.8],
      keyframes: [
        { atSec: 0, position: [1.2, 0.2, 0] },
        { atSec: 1.5, position: [-1.2, 0.4, 0] },
      ],
    },
  ],
};

describe("phase 9 — ChatGPT browserless container (zero browser, zero install)", () => {
  it("packs, forces browserless-py, synthesizes audio, renders multi-scene video and verifies it", async () => {
    const pack = await new Promise<{ code: number; output: string }>((resolvePromise, reject) => {
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
    expect(pack.code, pack.output).toBe(0);

    const zipPath = path.join(ROOT, "dist", "ultra-workflow-cloud.zip");
    const zipStat = await fs.stat(zipPath);
    expect(zipStat.size).toBeLessThan(2.2 * 1024 * 1024); // v5 budget: bundled fonts + 3 style packs
    const isolated = await fs.mkdtemp(path.join(os.tmpdir(), "ultra-chatgpt-"));
    const { entries } = await extractZip(zipPath, isolated);
    expect(entries.every((e) => e.crcOk)).toBe(true);
    const names = new Set(entries.map((e) => e.name));
    for (const required of [
      "ultra.mjs",
      "engines/py-canvas/render_scene.py",
      "engines/blender/render_scene.py",
      "prompts/CHATGPT_PROCESS1_EXTRACT_STYLE.txt",
      "prompts/CHATGPT_PROCESS2A_CLONE_REFERENCE.txt",
      "prompts/CHATGPT_PROCESS2B_EDIT_MY_VIDEO_IN_STYLE.txt",
    ]) {
      expect(names.has(required), `zip contains ${required}`).toBe(true);
    }
    await expect(fs.stat(path.join(isolated, "node_modules"))).rejects.toThrow();

    const ultra = (args: string[], timeoutMs?: number) => runIsolated(isolated, ["ultra.mjs", ...args], timeoutMs);

    // Doctor must report the ChatGPT browserless tier.
    const doctor = await ultra(["doctor", "--json", "--host", "chatgpt"]);
    expect(doctor.code, doctor.stderr).toBe(0);
    const doctorJson = JSON.parse(doctor.stdout);
    expect(doctorJson.renderTier).toBe("browserless-py");
    expect(doctorJson.browser.available).toBe(false);
    expect(doctorJson.pythonModules.pil).toBe(true);
    expect(doctorJson.host).toBe("chatgpt");
    expect(doctorJson.fonts.count).toBeGreaterThan(0);

    // Fixture: raw clip, scene graph, reference, project (assets intentionally missing first).
    const workspace = path.join(isolated, "workspace");
    await fs.mkdir(path.join(workspace, "assets"), { recursive: true });
    await makeRawClip(path.join(isolated, "my_raw.mp4"));
    await makeReferenceVideo(path.join(isolated, "ref.mp4"));
    await writeJsonAtomic(path.join(workspace, "assets", "scene_graph.json"), SCENE_GRAPH);

    const project = UltraProject.parse({
      meta: {
        title: "ChatGPT browserless proof",
        sourceVideoPath: "my_raw.mp4",
        width: 1280,
        height: 720,
        fps: 30,
        durationSec: 3,
      },
      designTokens: {
        palette: C9,
        fonts: { heading: "Segoe UI", body: "Segoe UI", mono: "Consolas" },
        grainOpacity: 0.06,
        antiSlopRules: ["palette locked", "beat-timed cuts", "stutterEvents must be 0"],
      },
      colorGrade: { exposure: 0, contrast: 0.05, saturation: 1.02, temperature: 0.03, vignette: 0.1 },
      audio: {
        targetLufs: -14,
        musicAssetId: "bed",
        duckingDb: -12,
        sfxCues: [
          { assetId: "whoosh", atSec: 1.0, gainDb: -6 },
          { assetId: "pop", atSec: 1.9, gainDb: -4 },
        ],
      },
      assets: [
        { id: "bed", type: "music", description: "punchy beat bed", prompt: "tempo-locked tech pulse", durationSec: 4, targetPath: "assets/bed.wav" },
        { id: "whoosh", type: "sfx", description: "fast whoosh transition", prompt: "whoosh", durationSec: 0.4, targetPath: "assets/whoosh.wav" },
        { id: "pop", type: "sfx", description: "ui pop accent", prompt: "pop", durationSec: 0.1, targetPath: "assets/pop.wav" },
        { id: "graph", type: "3d_graph", description: "alpha wireframe overlay", prompt: "cube+sphere", targetPath: "assets/scene_graph.json" },
      ],
      scenes: [
        {
          id: "clip",
          name: "Raw cut",
          startSec: 0,
          endSec: 1.0,
          engine: "hyperframes",
          background: C9.bg,
          transitionIn: { type: "none", durationSec: 0 },
          sourceClip: {
            path: "my_raw.mp4",
            inSec: 0.1,
            outSec: 1.0,
            muteSourceAudio: false,
            jCutLeadSec: 0,
            lCutTrailSec: 0,
            scale: 1,
            panX: 0,
            panY: 0,
            cropMode: "cover",
          },
          camera: {
            perspectivePx: 1200,
            keyframes: [
              { atSec: 0, zoom: 1.0, ease: "linear" },
              { atSec: 1.0, zoom: 1.07, ease: "linear" },
            ],
          },
          textElements: [
            {
              id: "cap",
              text: "RAW CUT",
              font: "heading",
              sizePx: 52,
              color: C9.fg,
              x: 120,
              y: 520,
              width: 800,
              align: "left",
              weight: 800,
              letterSpacingPx: 1,
              lineHeight: 1.05,
              uppercase: true,
            },
            {
              id: "tag",
              text: "BROWSERLESS",
              font: "mono",
              sizePx: 22,
              color: C9.secondary,
              x: 122,
              y: 596,
              align: "left",
              letterSpacingPx: 3,
              lineHeight: 1.2,
              uppercase: true,
            },
          ],
          keyframes: [
            {
              target: "cap",
              property: "opacity",
              keyframes: [
                { atSec: 0, value: 0, ease: "easeOutCubic" },
                { atSec: 0.25, value: 1, ease: "linear" },
              ],
            },
          ],
          enginePayload: {},
        },
        {
          id: "kinetic",
          name: "Kinetic title",
          startSec: 1.0,
          endSec: 1.8,
          engine: "hyperframes",
          background: C9.bg,
          transitionIn: { type: "fade", durationSec: 0.2 },
          textElements: [
            {
              id: "frame",
              text: "FRAME",
              font: "heading",
              sizePx: 92,
              color: C9.fg,
              x: 120,
              y: 300,
              width: 700,
              align: "left",
              weight: 900,
              letterSpacingPx: -2,
              lineHeight: 1,
              uppercase: true,
              reveal: {
                mode: "chars",
                staggerSec: 0.05,
                durationSec: 0.4,
                delaySec: 0.05,
                from: "up",
                distancePx: 60,
                easing: "easeOutCubic",
                mask: true,
              },
            },
            {
              id: "perfect",
              text: "PERFECT",
              font: "heading",
              sizePx: 54,
              color: C9.accent,
              x: 124,
              y: 420,
              width: 600,
              align: "left",
              weight: 800,
              letterSpacingPx: 4,
              lineHeight: 1.1,
              uppercase: true,
            },
          ],
          keyframes: [
            {
              target: "perfect",
              property: "opacity",
              keyframes: [
                { atSec: 0.2, value: 0, ease: "easeOutCubic" },
                { atSec: 0.6, value: 1, ease: "linear" },
              ],
            },
          ],
          effects: [{ type: "grain", intensity: 0.28 }],
          enginePayload: {},
        },
        {
          id: "stats",
          name: "Stat callout",
          startSec: 1.8,
          endSec: 3.0,
          engine: "revideo",
          background: C9.bg,
          transitionIn: { type: "fade", durationSec: 0.2 },
          enginePayload: {
            sceneType: "chart",
            title: "PERF",
            values: [0.35, 0.62, 0.48, 0.85],
            labels: ["A", "B", "C", "D"],
          },
        },
        {
          id: "vfx",
          name: "3D overlay",
          startSec: 0.5,
          endSec: 2.0,
          engine: "blender",
          alpha: true,
          overlayOfSceneId: "clip",
          background: "transparent",
          transitionIn: { type: "none", durationSec: 0 },
          enginePayload: { sceneGraphAssetId: "graph" },
        },
      ],
    });
    await writeJsonAtomic(path.join(workspace, "ultra.json"), project);

    const validate = await ultra(["validate-spec"]);
    expect(validate.code, validate.stderr).toBe(0);

    // Host-aware asset plan must flag synth strategies before assets exist.
    const plan = await ultra(["asset-plan", "--host", "chatgpt"]);
    expect(plan.code, plan.stderr).toBe(0);
    const todo = JSON.parse(await fs.readFile(path.join(workspace, "assets-todo.json"), "utf8"));
    expect(todo.complete).toBe(false);
    const byId = Object.fromEntries(todo.missing.map((m: any) => [m.id, m]));
    expect(byId.bed.chatgptStrategy).toBe("ultra-synth-audio");
    expect(byId.bed.synthPreset.preset).toBeTruthy();
    expect(byId.whoosh.chatgptStrategy).toBe("ultra-synth-audio");
    expect(byId.pop.synthPreset.preset).toBeTruthy();

    // Synthesize SFX + a 4s 120 BPM bed exactly as the ChatGPT prompt instructs.
    for (const [preset, out, extra] of [
      ["whoosh", "workspace/assets/whoosh.wav", []],
      ["pop", "workspace/assets/pop.wav", []],
      ["beat-pulse", "workspace/assets/bed.wav", ["--duration", "4", "--bpm", "120", "--mood", "tech"]],
    ] as [string, string, string[]][]) {
      const synth = await ultra(["synth-audio", "--preset", preset, "--out", out, ...extra], 300_000);
      expect(synth.code, synth.stderr).toBe(0);
      const probe = await ffprobeJson(path.join(isolated, out));
      const audio = probe.streams.find((s: any) => s.codec_type === "audio");
      expect(audio, `${out} audio stream`).toBeTruthy();
      expect(Number(audio.sample_rate)).toBe(48000);
      expect(Number(audio.channels)).toBe(2);
    }

    const validateAssets = await ultra(["validate-assets"]);
    expect(validateAssets.code, validateAssets.stderr).toBe(0);

    const build = await ultra(["build"], 1_200_000);
    expect(build.code, build.stderr).toBe(0);
    const manifest = JSON.parse(await fs.readFile(path.join(isolated, "build", "build-manifest.json"), "utf8"));
    expect(manifest.scenes).toHaveLength(4);
    for (const scene of manifest.scenes) {
      expect(scene.engineUsed, `scene ${scene.sceneId} engine`).toBe("py-canvas");
      expect(scene.fallbackReason).toBe("browserless-py");
    }
    const vfx = manifest.scenes.find((s: any) => s.sceneId === "vfx");
    expect(vfx.alpha).toBe(true);
    expect(vfx.file.endsWith(".mov")).toBe(true);
    const vfxProbe = await ffprobeJson(vfx.file);
    const vfxVideo = vfxProbe.streams.find((s: any) => s.codec_type === "video");
    expect(String(vfxVideo.pix_fmt)).toMatch(/yuva/i);

    const verify = await ultra(["verify", "ref.mp4"], 1_200_000);
    expect(verify.code, `${verify.stdout}\n${verify.stderr}`).toBe(0);
    const report = JSON.parse(await fs.readFile(path.join(isolated, "build", "verify-report.json"), "utf8"));
    expect(report.pass).toBe(true);
    expect(report.quantitative.stutterEvents).toBe(0);
    expect(report.quantitative.fpsOk).toBe(true);
    expect(report.quantitative.cfrOk).toBe(true);
    expect(report.quantitative.loudness.ok).toBe(true);
    expect(report.lint.pass).toBe(true);
    expect(report.visualPairs.length).toBeGreaterThanOrEqual(4);
    for (const pair of report.visualPairs) {
      const stat = await fs.stat(pair.path);
      expect(stat.size).toBeGreaterThan(5000);
    }

    const render = await ultra(["render"], 1_200_000);
    expect(render.code, render.stderr).toBe(0);
    const finalFile = path.join(isolated, "build", "ultra-final.mp4");
    const finalProbe = await ffprobeJson(finalFile);
    const video = finalProbe.streams.find((s: any) => s.codec_type === "video");
    const audio = finalProbe.streams.find((s: any) => s.codec_type === "audio");
    expect(video).toBeTruthy();
    expect(audio).toBeTruthy();
    expect(video.pix_fmt).toBe("yuv420p");
    expect(Math.abs(Number(finalProbe.format.duration) - 3)).toBeLessThanOrEqual(0.1);
    expect(Number(video.nb_frames)).toBeGreaterThanOrEqual(88);
    expect(Number(video.nb_frames)).toBeLessThanOrEqual(92);
    await ffmpegOk(["-v", "error", "-i", finalFile, "-f", "null", "-"], { timeoutMs: 120_000 });

    await expect(fs.stat(path.join(isolated, "node_modules"))).rejects.toThrow();
    console.log(`[phase9] ChatGPT browserless run OK · dir=${isolated} · zip=${(zipStat.size / 1024).toFixed(1)} KiB`);
  }, 1_800_000);
});
