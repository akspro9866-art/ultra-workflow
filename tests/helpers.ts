import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ffmpegOk } from "../core/ffmpeg.js";
import { UltraProject } from "../core/schema.js";
import type { UltraProjectT } from "../core/schema.js";
import { ensureDir, writeJsonAtomic } from "../core/util.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PALETTE = {
  bg: "#101820",
  fg: "#f2f2f0",
  accent: "#ffb703",
  secondary: "#8ecae6",
};

export async function makeTempDir(prefix: string): Promise<string> {
  const base = path.join(ROOT, "tmp", "tests");
  await ensureDir(base);
  return fs.mkdtemp(path.join(base, `${prefix}-`));
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCli(cwd: string, args: string[], timeoutMs = 900_000, envOverrides: Record<string, string | undefined> = {}): Promise<CliRun> {
  const requireFromRoot = createRequire(path.join(ROOT, "package.json"));
  const loaderPath = requireFromRoot.resolve("tsx/esm");
  const binPath = path.join(ROOT, "bin", "ultra.ts");
  return new Promise<CliRun>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(loaderPath).href, binPath, ...args], {
      cwd,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1", ...envOverrides },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs}ms: ultra ${args.join(" ")}\n${stdout}\n${stderr}`));
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

/** 4s 1280x720@30 reference built from three solid-color segments (clean scene cuts) + pulsing tone. */
export async function makeReferenceVideo(file: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await ffmpegOk([
    "-f",
    "lavfi",
    "-i",
    "color=c=0x101820:s=1280x720:d=1.3333:r=30",
    "-f",
    "lavfi",
    "-i",
    "color=c=0xd9484f:s=1280x720:d=1.3333:r=30",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x2c4a7c:s=1280x720:d=1.3334:r=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=4.0",
    "-filter_complex",
    "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v];[3:a]volume='0.4+0.5*sin(2*PI*2*t)':eval=frame[a]",
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
    "4",
    file,
  ]);
}

export async function makeAudio(file: string, seconds: number, frequency = 330): Promise<void> {
  await ensureDir(path.dirname(file));
  await ffmpegOk([
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${frequency}:duration=${seconds}`,
    "-c:a",
    "pcm_s16le",
    file,
  ]);
}

export async function makeAlphaPng(file: string, width = 160, height = 48, color = "0xffb703@1.0"): Promise<void> {
  await ensureDir(path.dirname(file));
  await ffmpegOk([
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=${width}x${height}`,
    "-frames:v",
    "1",
    "-vf",
    "format=rgba",
    "-pix_fmt",
    "rgba",
    file,
  ]);
}

export async function makeOverlayMov(file: string, alphaPng: string, seconds: number): Promise<void> {
  await ensureDir(path.dirname(file));
  await ffmpegOk([
    "-loop",
    "1",
    "-framerate",
    "30",
    "-i",
    alphaPng,
    "-t",
    String(seconds),
    "-c:v",
    "prores_ks",
    "-profile:v",
    "4444",
    "-pix_fmt",
    "yuva444p10le",
    file,
  ]);
}

export async function makeColorClip(
  file: string,
  durationSec: number,
  color: string,
  width = 1280,
  height = 720,
  fps = 30,
): Promise<void> {
  await ensureDir(path.dirname(file));
  await ffmpegOk([
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=${width}x${height}:d=${durationSec}:r=${fps}`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
}

/** Deterministic warm LUT (.cube) — 17^3 identity tilted slightly warm. */
export async function makeWarmLut(file: string): Promise<void> {
  await ensureDir(path.dirname(file));
  const size = 17;
  const lines: string[] = ['TITLE "Ultra warm test LUT"', "LUT_3D_SIZE 17", "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"];
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const rf = Math.min(1, Math.pow(r / (size - 1), 0.96) + 0.012);
        const gf = g / (size - 1);
        const bf = Math.max(0, Math.pow(b / (size - 1), 1.04) - 0.012);
        lines.push(`${rf.toFixed(6)} ${gf.toFixed(6)} ${bf.toFixed(6)}`);
      }
    }
  }
  await fs.writeFile(file, lines.join("\n"), "utf8");
}

export async function writeBaseAssets(workspace: string): Promise<void> {
  const assets = path.join(workspace, "assets");
  await ensureDir(assets);
  await makeAlphaPng(path.join(assets, "logo.png"));
  await fs.writeFile(
    path.join(assets, "badge.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60"><rect x="0" y="0" width="200" height="60" rx="8" fill="#8ecae6"/><text x="100" y="38" font-family="Arial" font-size="22" fill="#101820" text-anchor="middle">ULTRA</text></svg>`,
    "utf8",
  );
  await makeAudio(path.join(assets, "music.wav"), 4.05, 220);
  await makeAudio(path.join(assets, "hit.wav"), 0.42, 880);
  await makeAudio(path.join(assets, "voice.wav"), 1.6, 330);
  await writeJsonAtomic(path.join(assets, "scene_graph.json"), {
    durationSec: 2,
    fps: 30,
    width: 1280,
    height: 720,
    backgroundAlpha: true,
    camera: {
      position: [0, 1.4, 4.2],
      target: [0, 0, 0],
      fov: 45,
      keyframes: [
        { atSec: 0, position: [0, 1.4, 4.6] },
        { atSec: 2, position: [0, 1.4, 3.8] },
      ],
    },
    lights: [
      { type: "point", color: "#ffffff", intensity: 5, position: [2, 3, 3] },
      { type: "ambient", color: "#8ecae6", intensity: 0.6, position: [0, 0, 0] },
    ],
    materials: [
      { id: "accent", color: "#ffb703", metalness: 0.6, roughness: 0.3 },
      { id: "secondary", color: "#8ecae6", metalness: 0.1, roughness: 0.6 },
    ],
    meshes: [
      {
        id: "torus",
        primitive: "torus",
        materialId: "accent",
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1.2, 1.2, 1.2],
        keyframes: [
          { atSec: 0, rotation: [0, 0, 0] },
          { atSec: 2, rotation: [0, 180, 90] },
        ],
      },
      {
        id: "sphere",
        primitive: "sphere",
        materialId: "secondary",
        position: [1.1, 0.3, 0],
        rotation: [0, 0, 0],
        scale: [0.8, 0.8, 0.8],
        keyframes: [
          { atSec: 0, position: [1.1, 0.3, 0] },
          { atSec: 2, position: [-1.1, 0.5, 0] },
        ],
      },
    ],
  });
}

/** 4s / 1280x720 / 30fps project exercising hyperframes + remotion + revideo + a Blender alpha overlay. */
export function fullFixtureProject(): UltraProjectT {
  const raw = {
    meta: {
      title: "Ultra Fixture",
      sourceVideoPath: "reference.mp4",
      width: 1280,
      height: 720,
      fps: 30,
      durationSec: 4,
    },
    designTokens: {
      palette: PALETTE,
      fonts: { heading: "Segoe UI", body: "Segoe UI", mono: "Consolas" },
      grainOpacity: 0.05,
      antiSlopRules: [
        "No stock template gradients",
        "Only palette colors may appear",
        "All motion is keyframed — no wall-clock sampling",
      ],
    },
    colorGrade: { exposure: 0, contrast: 0.05, saturation: 1.02, temperature: 0.05, vignette: 0.1 },
    audio: {
      targetLufs: -14,
      musicAssetId: "music",
      voiceAssetId: "voice",
      duckingDb: -12,
      sfxCues: [{ assetId: "hit", atSec: 1, gainDb: -6 }],
    },
    assets: [
      {
        id: "logo",
        type: "png_alpha",
        description: "Ultra mark",
        prompt: "flat amber rounded rectangle mark",
        width: 160,
        height: 48,
        requireAlpha: true,
        targetPath: "assets/logo.png",
      },
      {
        id: "badge",
        type: "svg",
        description: "Badge",
        prompt: "vector badge",
        targetPath: "assets/badge.svg",
      },
      {
        id: "music",
        type: "music",
        description: "Music bed",
        prompt: "minimal pulse",
        durationSec: 4,
        targetPath: "assets/music.wav",
      },
      {
        id: "hit",
        type: "sfx",
        description: "Impact",
        prompt: "soft impact",
        durationSec: 0.4,
        targetPath: "assets/hit.wav",
      },
      {
        id: "voice",
        type: "voice",
        description: "Narration",
        prompt: "calm narration",
        durationSec: 1.5,
        targetPath: "assets/voice.wav",
      },
      {
        id: "graph",
        type: "3d_graph",
        description: "Overlay scene graph",
        prompt: "amber torus + blue sphere",
        targetPath: "assets/scene_graph.json",
      },
    ],
    scenes: [
      {
        id: "intro",
        name: "Intro",
        startSec: 0,
        endSec: 1.4,
        engine: "hyperframes",
        background: PALETTE.bg,
        transitionIn: { type: "none", durationSec: 0 },
        layers: [
          { id: "rule", type: "shape", color: PALETTE.accent, x: 100, y: 370, width: 240, height: 8, radius: 4 },
          { id: "logo", type: "png_alpha", assetId: "logo", x: 100, y: 430, width: 160, height: 48 },
        ],
        textElements: [
          {
            id: "headline",
            text: "ULTRA",
            font: "heading",
            sizePx: 96,
            color: PALETTE.fg,
            x: 100,
            y: 260,
            width: 600,
            align: "left",
            weight: 800,
            letterSpacingPx: -2,
            lineHeight: 1,
            uppercase: true,
          },
          {
            id: "sub",
            text: "workflow, verified",
            font: "body",
            sizePx: 28,
            color: PALETTE.secondary,
            x: 104,
            y: 400,
            align: "left",
            weight: 500,
            letterSpacingPx: 1,
            lineHeight: 1.2,
            uppercase: false,
          },
        ],
        keyframes: [
          {
            target: "headline",
            property: "opacity",
            keyframes: [
              { atSec: 0, value: 0, ease: "easeOutCubic" },
              { atSec: 0.35, value: 1, ease: "linear" },
            ],
          },
          {
            target: "headline",
            property: "y",
            keyframes: [
              { atSec: 0, value: 300, ease: "easeOutCubic" },
              { atSec: 0.5, value: 260, ease: "linear" },
            ],
          },
          {
            target: "rule",
            property: "scale",
            keyframes: [
              { atSec: 0.15, value: 0, ease: "easeOutExpo" },
              { atSec: 0.7, value: 1, ease: "linear" },
            ],
          },
        ],
        effects: [],
        enginePayload: {},
      },
      {
        id: "spring",
        name: "Spring title",
        startSec: 1.4,
        endSec: 2.4,
        engine: "remotion",
        background: PALETTE.bg,
        transitionIn: { type: "fade", durationSec: 0.25 },
        layers: [],
        textElements: [
          {
            id: "springLabel",
            text: "FRAME BY FRAME",
            font: "heading",
            sizePx: 72,
            color: PALETTE.accent,
            x: 290,
            y: 320,
            width: 700,
            align: "center",
            weight: 800,
            letterSpacingPx: 2,
            lineHeight: 1.05,
            uppercase: true,
          },
        ],
        keyframes: [
          {
            target: "springLabel",
            property: "opacity",
            keyframes: [
              { atSec: 0, value: 0, ease: "easeOutCubic" },
              { atSec: 0.4, value: 1, ease: "linear" },
            ],
          },
        ],
        effects: [],
        enginePayload: { sceneType: "springType", lines: ["FRAME", "BY FRAME"] },
      },
      {
        id: "diagram",
        name: "Diagram",
        startSec: 2.4,
        endSec: 3.4,
        engine: "revideo",
        background: PALETTE.bg,
        transitionIn: { type: "wipeleft", durationSec: 0.2 },
        layers: [],
        textElements: [
          {
            id: "diagramLabel",
            text: "SIGNAL",
            font: "heading",
            sizePx: 64,
            color: PALETTE.secondary,
            x: 420,
            y: 300,
            width: 440,
            align: "center",
            weight: 700,
            letterSpacingPx: 4,
            lineHeight: 1.1,
            uppercase: true,
          },
        ],
        keyframes: [
          {
            target: "diagramLabel",
            property: "opacity",
            keyframes: [
              { atSec: 0, value: 0, ease: "easeOutCubic" },
              { atSec: 0.35, value: 1, ease: "linear" },
            ],
          },
        ],
        effects: [],
        enginePayload: { sceneType: "diagram", title: "Signal", values: [0.2, 0.5, 0.35, 0.8] },
      },
      {
        id: "outro",
        name: "Outro",
        startSec: 3.4,
        endSec: 4,
        engine: "hyperframes",
        background: PALETTE.bg,
        transitionIn: { type: "fade", durationSec: 0.2 },
        layers: [],
        textElements: [
          {
            id: "go",
            text: "GO",
            font: "heading",
            sizePx: 96,
            color: PALETTE.accent,
            x: 570,
            y: 320,
            align: "center",
            weight: 900,
            letterSpacingPx: 6,
            lineHeight: 1,
            uppercase: true,
          },
        ],
        keyframes: [
          {
            target: "go",
            property: "scale",
            keyframes: [
              { atSec: 0, value: 0.9, ease: "easeOutBack" },
              { atSec: 0.3, value: 1, ease: "linear" },
            ],
          },
        ],
        effects: [],
        enginePayload: {},
      },
      {
        id: "vfx",
        name: "3D overlay",
        startSec: 1.2,
        endSec: 3.2,
        engine: "blender",
        alpha: true,
        overlayOfSceneId: "intro",
        transitionIn: { type: "none", durationSec: 0 },
        background: "transparent",
        layers: [],
        keyframes: [],
        textElements: [],
        effects: [],
        enginePayload: { sceneGraphAssetId: "graph" },
      },
    ],
  };
  return UltraProject.parse(raw);
}

/** Small hyperframes-only project for the 60fps engine test. */
export function kineticProject(fps = 60): UltraProjectT {
  const raw = {
    meta: { title: "Kinetic", sourceVideoPath: "reference.mp4", width: 1280, height: 720, fps, durationSec: 3 },
    designTokens: {
      palette: PALETTE,
      fonts: { heading: "Segoe UI", body: "Segoe UI", mono: "Consolas" },
      grainOpacity: 0.04,
      antiSlopRules: ["No wall-clock animation", "Palette-only colors"],
    },
    colorGrade: {},
    audio: {},
    assets: [],
    scenes: [
      {
        id: "kinetic",
        name: "Kinetic type",
        startSec: 0,
        endSec: 3,
        engine: "hyperframes",
        background: PALETTE.bg,
        layers: [{ id: "bar", type: "shape", color: PALETTE.accent, x: 160, y: 470, width: 320, height: 10, radius: 5 }],
        textElements: [
          {
            id: "word",
            text: "MOTION",
            font: "heading",
            sizePx: 118,
            color: PALETTE.fg,
            x: 160,
            y: 300,
            width: 900,
            align: "left",
            weight: 800,
            letterSpacingPx: -3,
            lineHeight: 1,
            uppercase: true,
          },
          {
            id: "tag",
            text: "deterministic · zero jitter",
            font: "mono",
            sizePx: 26,
            color: PALETTE.secondary,
            x: 164,
            y: 510,
            align: "left",
            letterSpacingPx: 1,
            lineHeight: 1.2,
            uppercase: false,
          },
        ],
        keyframes: [
          {
            target: "word",
            property: "opacity",
            keyframes: [
              { atSec: 0, value: 0, ease: "easeOutCubic" },
              { atSec: 0.5, value: 1, ease: "linear" },
            ],
          },
          {
            target: "word",
            property: "y",
            keyframes: [
              { atSec: 0, value: 360, ease: "easeOutExpo" },
              { atSec: 0.9, value: 300, ease: "linear" },
            ],
          },
          {
            target: "word",
            property: "scale",
            keyframes: [
              { atSec: 0.9, value: 1, ease: "easeInOutCubic" },
              { atSec: 2.4, value: 1.04, ease: "linear" },
            ],
          },
          {
            target: "bar",
            property: "scale",
            keyframes: [
              { atSec: 0.2, value: 0, ease: "easeOutExpo" },
              { atSec: 1.1, value: 1, ease: "linear" },
            ],
          },
          {
            target: "tag",
            property: "opacity",
            keyframes: [
              { atSec: 1.0, value: 0, ease: "easeOutCubic" },
              { atSec: 1.5, value: 1, ease: "linear" },
            ],
          },
        ],
        effects: [{ type: "grain", intensity: 0.2 }],
        enginePayload: {},
      },
    ],
  };
  return UltraProject.parse(raw);
}
