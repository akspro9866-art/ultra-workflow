import path from "node:path";
import { createRequire } from "node:module";
import type { RenderContext, RenderOutcome, SceneEngine } from "../types.js";
import { detectOptionalEngine, engineWorkspaceDir } from "../../core/env.js";
import { ensureDir, round } from "../../core/util.js";

/**
 * Revideo adapter. Like Remotion, Revideo lives in an isolated workspace.
 *
 * Native Revideo rendering is an explicit opt-in (`ULTRA_REVIDEO_NATIVE=1`)
 * because its upstream headless runtime pulls undeclared peer packages
 * (@revideo/vite-plugin, @revideo/ui) and spawns Vite + Puppeteer, which is
 * environment-sensitive on minimal cloud VMs. Until the operator verifies their
 * workspace with a smoke render, scenes fall back to the deterministic
 * HyperFrames compiler (recorded in the build manifest).
 */
export const revideoEngine: SceneEngine = {
  key: "revideo",

  async isAvailable(): Promise<boolean> {
    if (!(await detectOptionalEngine("revideo"))) return false;
    return process.env.ULTRA_REVIDEO_NATIVE === "1";
  },

  async lint() {
    return { defects: [], pass: true };
  },

  async renderScene(ctx: RenderContext): Promise<RenderOutcome> {
    const base = engineWorkspaceDir("revideo");
    if (!(await detectOptionalEngine("revideo"))) {
      throw new Error("revideo workspace dependencies are not installed");
    }
    process.env.DISABLE_TELEMETRY = "true";
    const requireFromEngine = createRequire(path.join(base, "package.json"));
    const renderer = requireFromEngine("@revideo/renderer") as any;
    await ensureDir(path.dirname(ctx.outFile));

    const timeoutMs = Number(process.env.ULTRA_REVIDEO_TIMEOUT_MS ?? 10 * 60_000);
    await Promise.race([
      renderer.renderVideo({
        projectFile: path.join(base, "project.ts"),
        variables: {
          payload: ctx.scene.enginePayload ?? {},
          tokens: ctx.project.designTokens,
          fps: ctx.fps,
          width: ctx.width,
          height: ctx.height,
        },
        settings: {
          outFile: ctx.outFile,
          outDir: path.join(ctx.buildDir, "tmp", "revideo"),
          fps: ctx.fps,
          resolution: { x: ctx.width, y: ctx.height },
        },
      }),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error(`revideo render exceeded ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);

    const frames = Math.max(1, Math.round(ctx.durationSec * ctx.fps));
    return {
      engineUsed: "revideo",
      outFile: ctx.outFile,
      frames,
      durationSec: round(frames / ctx.fps, 6),
      notes: [],
    };
  },
};
