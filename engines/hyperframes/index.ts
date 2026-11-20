import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RenderContext, RenderOutcome, SceneEngine } from "../types.js";
import { compileSceneHtml } from "./compiler.js";
import { lintScene } from "./lint.js";
import { closePage, getBrowserInfo, newPage, settlePage, waitForVideos } from "../../core/browser.js";
import { ensureDir, pathExists, rmrf, round, sha1, sha1File } from "../../core/util.js";
import { ffmpegOk } from "../../core/ffmpeg.js";
import { resolveAssetPath } from "../../core/assets.js";

function safeId(id: string): string {
  return id.replace(/[^\w.-]/g, "_");
}

async function encodeFrames(framesDir: string, fps: number, alpha: boolean, outFile: string): Promise<void> {
  await ensureDir(path.dirname(outFile));
  const args = ["-framerate", String(fps), "-i", path.join(framesDir, "f_%05d.png")];
  if (alpha) {
    args.push("-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-r", String(fps), outFile);
  } else {
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "16",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(fps),
      "-fps_mode",
      "cfr",
      outFile,
    );
  }
  await ffmpegOk(args, { timeoutMs: 15 * 60_000 });
}

async function blendSequences(sequences: string[], fps: number, frames: number, outDir: string): Promise<void> {
  await rmrf(outDir);
  await ensureDir(outDir);
  if (sequences.length === 1) {
    await fs.cp(sequences[0] as string, outDir, { recursive: true });
    return;
  }
  const inputs: string[] = [];
  for (const dir of sequences) inputs.push("-framerate", String(fps), "-i", path.join(dir, "f_%05d.png"));
  const chains: string[] = [];
  for (let i = 0; i < sequences.length; i += 1) chains.push(`[${i}:v]format=rgba[v${i}]`);
  let current = "v0";
  for (let i = 1; i < sequences.length; i += 1) {
    const label = `b${i}`;
    chains.push(`[${current}][v${i}]blend=all_mode=average[${label}]`);
    current = label;
  }
  await ffmpegOk(
    [
      ...inputs,
      "-filter_complex",
      chains.join(";"),
      "-map",
      `[${current}]`,
      "-frames:v",
      String(frames),
      path.join(outDir, "f_%05d.png"),
    ],
    { timeoutMs: 15 * 60_000 },
  );
}

/**
 * [10] `videoMode: "frames"`: pre-extract the needed frame range with FFmpeg to
 * a PNG sequence in .ultra-cache and frame-step it deterministically. Disk cost:
 * width×height RGBA PNGs per source frame (documented in FIX_REPORT).
 */
async function prepareVideoFrames(ctx: RenderContext): Promise<Record<string, { dir: string; count: number }>> {
  const frames: Record<string, { dir: string; count: number }> = {};
  if (ctx.scene.videoMode !== "frames") return frames;
  for (const layer of ctx.scene.layers) {
    if (layer.type !== "video" || !layer.assetId) continue;
    const asset = ctx.project.assets.find((a) => a.id === layer.assetId);
    if (!asset) continue;
    const file = resolveAssetPath(ctx.workspace, asset);
    if (!(await pathExists(file))) continue;
    const digest = await sha1File(file);
    const key = sha1(
      [digest, layer.inSec, layer.rate, layer.loop, ctx.durationSec, ctx.fps, ctx.width, ctx.height].join("|"),
    );
    const dir = path.join(process.cwd(), ".ultra-cache", "video-frames", key);
    let count = 0;
    try {
      count = (await fs.readdir(dir)).filter((name) => /^f_\d{5}\.png$/.test(name)).length;
    } catch {
      count = 0;
    }
    if (count === 0) {
      await rmrf(dir);
      await ensureDir(dir);
      const range = Math.max(0.1, ctx.durationSec * layer.rate + 0.25);
      await ffmpegOk(
        [
          "-ss",
          layer.inSec.toFixed(3),
          "-i",
          file,
          "-t",
          range.toFixed(3),
          "-vf",
          `fps=${ctx.fps}`,
          "-start_number",
          "1",
          path.join(dir, "f_%05d.png"),
        ],
        { timeoutMs: 20 * 60_000 },
      );
      count = (await fs.readdir(dir)).filter((name) => /^f_\d{5}\.png$/.test(name)).length;
    }
    if (count === 0) throw new Error(`videoMode "frames": FFmpeg extracted no frames for layer "${layer.id}"`);
    frames[layer.id] = { dir, count };
  }
  return frames;
}

/**
 * Deterministic frame stepper: every frame is produced by explicitly seeking the
 * in-page runtime (`__ULTRA_SEEK`) and capturing a lossless PNG, then encoding
 * at exact CFR. Optional subframe motion blur renders `motionBlurSamples`
 * sub-positions per frame (up to 8) and blends them via FFmpeg (`blend` average).
 */
export const hyperframesEngine: SceneEngine = {
  key: "hyperframes",

  async isAvailable(): Promise<boolean> {
    const info = await getBrowserInfo();
    return info.available;
  },

  async lint(ctx) {
    return lintScene(ctx);
  },

  async renderScene(ctx: RenderContext): Promise<RenderOutcome> {
    const frames = Math.max(1, Math.round(ctx.durationSec * ctx.fps));
    const samples = Math.max(1, Math.min(8, ctx.scene.motionBlurSamples ?? 1));
    const workDir = path.join(ctx.buildDir, "tmp", `hf_${safeId(ctx.scene.id)}`);
    await rmrf(workDir);
    await ensureDir(workDir);
    const videoFrames = await prepareVideoFrames(ctx);
    const htmlPath = path.join(workDir, "scene.html");
    await fs.writeFile(
      htmlPath,
      await compileSceneHtml({
        project: ctx.project,
        scene: ctx.scene,
        workspace: ctx.workspace,
        width: ctx.width,
        height: ctx.height,
        fps: ctx.fps,
        ...(Object.keys(videoFrames).length > 0 ? { videoFrames } : {}),
      }),
      "utf8",
    );

    const sequences: string[] = [];
    const page = await newPage(ctx.width, ctx.height);
    try {
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
      await settlePage(page);
      await waitForVideos(page);
      for (let s = 0; s < samples; s += 1) {
        const seqDir = path.join(workDir, `s${s}`);
        await ensureDir(seqDir);
        sequences.push(seqDir);
        for (let i = 0; i < frames; i += 1) {
          const subFrame = samples > 1 ? i + s / samples : i;
          await page.evaluate(`window.__ULTRA_SEEK(${subFrame}, ${ctx.fps})`);
          await page.screenshot({
            path: path.join(seqDir, `f_${String(i + 1).padStart(5, "0")}.png`),
            type: "png",
            omitBackground: ctx.alpha,
            animations: "disabled",
          });
        }
      }
    } finally {
      await closePage(page);
    }

    const encodeDir = path.join(workDir, "frames");
    if (samples > 1) {
      await blendSequences(sequences, ctx.fps, frames, encodeDir);
    } else {
      await fs.rename(sequences[0] as string, encodeDir);
    }
    await encodeFrames(encodeDir, ctx.fps, ctx.alpha, ctx.outFile);
    await rmrf(workDir);

    return {
      engineUsed: "hyperframes",
      outFile: ctx.outFile,
      frames,
      durationSec: round(frames / ctx.fps, 6),
      notes: samples > 1 ? [`motionBlurSamples=${samples}`] : [],
    };
  },
};
