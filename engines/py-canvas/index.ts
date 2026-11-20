import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { LintDefectT } from "../../core/schema.js";
import type { LintContext, RenderContext, RenderOutcome, SceneEngine } from "../types.js";
import { resolveAssetPath, resolveSourceClipPath } from "../../core/assets.js";
import { chunksInWindow, loadCaptionsForScene } from "../../core/captions.js";
import { resolveAspectProfile } from "../../core/safe-zones.js";
import { discoverFonts, installRoot, resolvePythonCommand, type PythonCommand } from "../../core/env.js";
import { run } from "../../core/ffmpeg.js";
import { ensureDir, pathExists, rmrf, round, tailLines } from "../../core/util.js";

function safeId(id: string): string {
  return id.replace(/[^\w.-]/g, "_");
}

let pythonCache: PythonCommand | null | undefined;
let ffmpegCache: boolean | undefined;

async function pythonCommand(): Promise<PythonCommand | null> {
  if (pythonCache === undefined) pythonCache = await resolvePythonCommand();
  return pythonCache;
}

async function ffmpegAvailable(): Promise<boolean> {
  if (ffmpegCache === undefined) {
    try {
      const result = await run("ffmpeg", ["-version"], { timeoutMs: 8000 });
      ffmpegCache = result.code === 0;
    } catch {
      ffmpegCache = false;
    }
  }
  return ffmpegCache;
}

export function pyCanvasScript(): string {
  return path.join(installRoot(), "engines", "py-canvas", "render_scene.py");
}

async function buildBundle(ctx: RenderContext | LintContext): Promise<string> {
  const { project, scene, workspace, buildDir } = ctx;
  const alpha = "alpha" in ctx ? ctx.alpha : Boolean(scene.alpha);
  const durationSec = "durationSec" in ctx ? ctx.durationSec : scene.endSec - scene.startSec;
  const fonts = await discoverFonts(workspace);
  const assets: Record<string, string> = {};
  for (const asset of project.assets) assets[asset.id] = resolveAssetPath(workspace, asset);

  let sceneGraph: unknown = null;
  if (scene.engine === "blender") {
    const graphId = scene.enginePayload["sceneGraphAssetId"];
    if (typeof graphId === "string") {
      const asset = project.assets.find((a) => a.id === graphId);
      if (asset) {
        try {
          sceneGraph = JSON.parse(await fs.readFile(resolveAssetPath(workspace, asset), "utf8"));
        } catch {
          sceneGraph = null;
        }
      }
    }
  }

  let sourceClip: Record<string, unknown> | null = null;
  if (scene.sourceClip) {
    const resolved = await resolveSourceClipPath(workspace, scene.sourceClip.path);
    sourceClip = { ...scene.sourceClip, path: resolved };
  }

  const aspect = resolveAspectProfile(project.meta);
  const captionsDoc = await loadCaptionsForScene(workspace, scene);
  const captions = captionsDoc
    ? {
        aspect: captionsDoc.aspect,
        typography: captionsDoc.typography,
        chunks: chunksInWindow(captionsDoc, scene.startSec, scene.endSec),
      }
    : null;

  const bundle = {
    scene: { ...scene, sourceClip },
    tokens: project.designTokens,
    assets,
    meta: {
      width: ctx.width,
      height: ctx.height,
      fps: ctx.fps,
      durationSec,
      sceneDurationSec: round(scene.endSec - scene.startSec, 6),
      sceneStartSec: scene.startSec,
      aspectProfile: project.meta.aspectProfile ?? null,
      aspect,
      alpha,
      motionBlurSamples: scene.motionBlurSamples ?? 1,
      seed: 424242,
    },
    sceneGraph,
    captions,
    fontFiles: {
      regular: fonts.regular,
      bold: fonts.bold,
      mono: fonts.mono,
      bundled: fonts.bundled.map((f) => ({ file: f.file, family: f.family, role: f.role, path: f.path })),
    },
  };

  const tmp = path.join(buildDir, "tmp");
  await ensureDir(tmp);
  const file = path.join(tmp, `py_${safeId(scene.id)}.json`);
  await fs.writeFile(file, JSON.stringify(bundle), "utf8");
  return file;
}

function spawnPython(python: PythonCommand, args: string[]) {
  return spawn(python.bin, [...python.prefix, pyCanvasScript(), ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

/**
 * Zero-browser deterministic renderer (ChatGPT Linux containers):
 * Python + Pillow compose every frame and pipe raw RGBA/RGB into FFmpeg — no
 * temp frame files, no Chromium, no npm install, no external AI APIs.
 * Without Pillow the Python script itself falls back to an FFmpeg filtergraph.
 */
export const pyCanvasEngine: SceneEngine = {
  key: "py-canvas",

  async isAvailable(): Promise<boolean> {
    return Boolean(await pythonCommand()) && (await ffmpegAvailable());
  },

  async lint(ctx): Promise<{ defects: LintDefectT[]; pass: boolean }> {
    const python = await pythonCommand();
    if (!python) {
      return { defects: [], pass: true };
    }
    const bundleFile = await buildBundle(ctx);
    try {
      const child = spawnPython(python, ["--bundle", bundleFile, "--mode", "lint"]);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? -1)));
      if (code !== 0) {
        return {
          defects: [
            {
              category: "layout",
              sceneId: ctx.scene.id,
              frameIndex: 0,
              critical: false,
              detail: `py-canvas lint failed: ${tailLines(stderr, 6)}`,
            },
          ],
          pass: true,
        };
      }
      const parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? "{\"defects\":[]}") as {
        defects?: { category?: string; detail?: string; frameIndex?: number; critical?: boolean }[];
      };
      const allowed = new Set(["clip", "overlap", "contrast", "brokenMedia", "blankFrame", "palette", "layout", "runtime"]);
      const defects: LintDefectT[] = (parsed.defects ?? []).map((d) => ({
        category: (allowed.has(d.category ?? "") ? d.category : "layout") as LintDefectT["category"],
        sceneId: ctx.scene.id,
        frameIndex: Number(d.frameIndex ?? 0),
        critical: Boolean(d.critical),
        detail: String(d.detail ?? "py-canvas defect"),
      }));
      const criticalCount = defects.filter((d) => d.critical).length;
      return { defects, pass: criticalCount === 0 };
    } finally {
      await rmrf(bundleFile);
    }
  },

  async renderScene(ctx: RenderContext): Promise<RenderOutcome> {
    const python = await pythonCommand();
    if (!python) throw new Error("py-canvas requires Python 3 on PATH");
    const frames = Math.max(1, Math.round(ctx.durationSec * ctx.fps));
    const bundleFile = await buildBundle(ctx);
    await ensureDir(path.dirname(ctx.outFile));

    const pythonChild = spawnPython(python, ["--bundle", bundleFile, "--mode", "render"]);
    const encodeArgs = [
      "-hide_banner",
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      ctx.alpha ? "rgba" : "rgb24",
      "-s",
      `${ctx.width}x${ctx.height}`,
      "-framerate",
      String(ctx.fps),
      "-i",
      "-",
    ];
    if (ctx.alpha) {
      encodeArgs.push("-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-r", String(ctx.fps), ctx.outFile);
    } else {
      encodeArgs.push(
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "16",
        "-pix_fmt",
        "yuv420p",
        "-color_range",
        "tv",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-r",
        String(ctx.fps),
        "-fps_mode",
        "cfr",
        ctx.outFile,
      );
    }
    const ffmpegChild = spawn("ffmpeg", encodeArgs, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let pythonErr = "";
    let ffmpegErr = "";
    pythonChild.stderr.on("data", (c: Buffer) => (pythonErr += c.toString("utf8")));
    ffmpegChild.stderr.on("data", (c: Buffer) => (ffmpegErr += c.toString("utf8")));
    pythonChild.stdout.pipe(ffmpegChild.stdin as NodeJS.WritableStream);

    const [pythonCode, ffmpegCode] = await Promise.all([
      new Promise<number>((resolve) => pythonChild.on("close", (c) => resolve(c ?? -1))),
      new Promise<number>((resolve) => ffmpegChild.on("close", (c) => resolve(c ?? -1))),
    ]);
    await rmrf(bundleFile);
    if (pythonCode !== 0) {
      throw new Error(`py-canvas render failed (python ${pythonCode}):\n${tailLines(pythonErr, 12)}`);
    }
    if (ffmpegCode !== 0) {
      throw new Error(`py-canvas encode failed (ffmpeg ${ffmpegCode}):\n${tailLines(ffmpegErr, 12)}`);
    }
    if (!(await pathExists(ctx.outFile))) {
      throw new Error(`py-canvas produced no output at ${ctx.outFile}`);
    }

    return {
      engineUsed: "py-canvas",
      outFile: ctx.outFile,
      frames,
      durationSec: round(frames / ctx.fps, 6),
      notes: ["browserless-py"],
    };
  },
};
