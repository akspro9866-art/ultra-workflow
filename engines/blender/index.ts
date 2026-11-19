import { promises as fs } from "node:fs";
import path from "node:path";
import type { RenderContext, RenderOutcome, SceneEngine } from "../types.js";
import { SceneGraph, type SceneGraphT } from "./schema.js";
import { renderSceneGraphWithThreeJs } from "./threejs-fallback.js";
import { resolveAssetPath } from "../../core/assets.js";
import { ffmpegOk, run } from "../../core/ffmpeg.js";
import { installRoot } from "../../core/env.js";
import { getBrowserInfo } from "../../core/browser.js";
import { ensureDir, rmrf, round, tailLines } from "../../core/util.js";

let blenderChecked: string | null | undefined;

export async function blenderBinary(): Promise<string | null> {
  if (blenderChecked !== undefined) return blenderChecked;
  const override = process.env.ULTRA_BLENDER_PATH;
  if (override && override.trim().length > 0) {
    blenderChecked = override.trim();
    return blenderChecked;
  }
  try {
    const result = await run("blender", ["--version"], { timeoutMs: 15_000 });
    blenderChecked = result.code === 0 ? "blender" : null;
  } catch {
    blenderChecked = null;
  }
  return blenderChecked;
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

function safeId(id: string): string {
  return id.replace(/[^\w.-]/g, "_");
}

/**
 * 3D engine: native headless Blender when the binary exists, otherwise the
 * deterministic Three.js WebGL fallback compiling the SAME scene_graph.json.
 */
export const blenderEngine: SceneEngine = {
  key: "blender",

  async isAvailable(): Promise<boolean> {
    if ((await blenderBinary()) !== null) return true;
    // Without Blender the deterministic Three.js WebGL fallback takes over.
    const browser = await getBrowserInfo();
    return browser.available;
  },

  async lint() {
    return { defects: [], pass: true };
  },

  async renderScene(ctx: RenderContext): Promise<RenderOutcome> {
    const assetId = ctx.scene.enginePayload["sceneGraphAssetId"];
    if (typeof assetId !== "string") {
      throw new Error(`blender scene "${ctx.scene.id}" is missing enginePayload.sceneGraphAssetId`);
    }
    const asset = ctx.project.assets.find((a) => a.id === assetId);
    if (!asset) throw new Error(`blender scene "${ctx.scene.id}" references unknown asset "${assetId}"`);
    const graphRaw = JSON.parse(await fs.readFile(resolveAssetPath(ctx.workspace, asset), "utf8")) as unknown;
    const graph: SceneGraphT = SceneGraph.parse(graphRaw);
    graph.durationSec = ctx.durationSec;

    const framesDir = path.join(ctx.buildDir, "tmp", `3d_${safeId(ctx.scene.id)}`);
    await rmrf(framesDir);
    await ensureDir(framesDir);
    const graphPath = path.join(framesDir, "scene_graph.json");
    await fs.writeFile(graphPath, JSON.stringify(graph, null, 2), "utf8");

    const notes: string[] = [];
    let frames = Math.max(1, Math.round(ctx.durationSec * ctx.fps));
    let rendered = false;

    const binary = await blenderBinary();
    if (binary) {
      try {
        const script = path.join(installRoot(), "engines", "blender", "render_scene.py");
        const result = await run(
          binary,
          [
            "--background",
            "--factory-startup",
            "--python",
            script,
            "--",
            "--json",
            graphPath,
            "--out",
            framesDir,
            "--fps",
            String(ctx.fps),
            "--width",
            String(ctx.width),
            "--height",
            String(ctx.height),
          ],
          { timeoutMs: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 },
        );
        if (result.code !== 0) {
          throw new Error(tailLines(result.stderr || result.stdout, 15));
        }
        const summary = result.stdout.match(/ULTRA_BLENDER_SUMMARY=(.+)/);
        notes.push("blender-native", summary ? `backend=${JSON.parse(summary[1] ?? "{}").backend ?? "unknown"}` : "backend=unknown");
        rendered = true;
      } catch (err) {
        notes.push(`blender-native failed (${(err as Error).message.split("\n")[0]}); falling back to Three.js WebGL`);
      }
    } else {
      notes.push("blender binary not found");
    }

    if (!rendered) {
      const fallback = await renderSceneGraphWithThreeJs({
        graph,
        outDir: framesDir,
        width: ctx.width,
        height: ctx.height,
        fps: ctx.fps,
        durationSec: ctx.durationSec,
      });
      frames = fallback.frames;
      notes.push(...fallback.notes);
    }

    await encodeFrames(framesDir, ctx.fps, ctx.alpha, ctx.outFile);
    await rmrf(framesDir);

    return {
      engineUsed: "blender",
      outFile: ctx.outFile,
      frames,
      durationSec: round(frames / ctx.fps, 6),
      notes,
    };
  },
};
