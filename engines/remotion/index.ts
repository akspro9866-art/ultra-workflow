import path from "node:path";
import { createRequire } from "node:module";
import type { RenderContext, RenderOutcome, SceneEngine } from "../types.js";
import { detectOptionalEngine, engineWorkspaceDir } from "../../core/env.js";
import { getBrowserInfo } from "../../core/browser.js";
import { ensureDir, round } from "../../core/util.js";

/**
 * Remotion adapter. The heavy Remotion packages live in an isolated workspace
 * (engines/remotion) so minimal cloud VMs never hit dependency conflicts. When
 * the workspace is not installed, `isAvailable()` returns false and the
 * orchestrator transparently falls back to HyperFrames.
 */
export const remotionEngine: SceneEngine = {
  key: "remotion",

  async isAvailable(): Promise<boolean> {
    return detectOptionalEngine("remotion");
  },

  async lint() {
    return { defects: [], pass: true };
  },

  async renderScene(ctx: RenderContext): Promise<RenderOutcome> {
    const base = engineWorkspaceDir("remotion");
    if (!(await detectOptionalEngine("remotion"))) {
      throw new Error("remotion workspace dependencies are not installed");
    }
    const requireFromEngine = createRequire(path.join(base, "package.json"));
    const bundler = requireFromEngine("@remotion/bundler") as any;
    const renderer = requireFromEngine("@remotion/renderer") as any;
    const browserInfo = await getBrowserInfo();

    await ensureDir(path.dirname(ctx.outFile));
    const serveUrl: string = await bundler.bundle({
      entryPoint: path.join(base, "Root.tsx"),
      onProgress: () => undefined,
    });
    const inputProps = {
      scene: ctx.scene,
      fps: ctx.fps,
      width: ctx.width,
      height: ctx.height,
      durationSec: ctx.durationSec,
      tokens: ctx.project.designTokens,
    };
    const browserOptions =
      browserInfo.executablePath !== null ? { browserExecutable: browserInfo.executablePath } : {};

    const composition = await renderer.selectComposition({
      serveUrl,
      id: "UltraScene",
      inputProps,
      ...browserOptions,
    });
    await renderer.renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: ctx.outFile,
      inputProps,
      pixelFormat: "yuv420p",
      overwrite: true,
      concurrency: 1,
      ...browserOptions,
    });

    const frames = Number(composition?.durationInFrames ?? Math.round(ctx.durationSec * ctx.fps));
    return {
      engineUsed: "remotion",
      outFile: ctx.outFile,
      frames,
      durationSec: round(frames / ctx.fps, 6),
      notes: [],
    };
  },
};
