import type { LintDefectT, SceneSpecT, UltraProjectT } from "../core/schema.js";

export type EngineKey = "hyperframes" | "remotion" | "revideo" | "blender" | "py-canvas";

export interface RenderContext {
  project: UltraProjectT;
  scene: SceneSpecT;
  /** Absolute workspace directory (contains assets, probe.json, ultra.json). */
  workspace: string;
  /** Absolute build directory. */
  buildDir: string;
  /** Absolute destination file (.mp4, or .mov for alpha scenes). */
  outFile: string;
  /** Exact duration to render, in seconds, including transition tail. */
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  alpha: boolean;
}

export interface RenderOutcome {
  engineUsed: EngineKey;
  outFile: string;
  frames: number;
  durationSec: number;
  notes: string[];
}

export interface LintContext {
  project: UltraProjectT;
  scene: SceneSpecT;
  workspace: string;
  buildDir: string;
  fps: number;
  width: number;
  height: number;
}

export interface LintResult {
  defects: LintDefectT[];
  pass: boolean;
}

export interface SceneEngine {
  key: EngineKey;
  isAvailable(): Promise<boolean>;
  lint(ctx: LintContext): Promise<LintResult>;
  renderScene(ctx: RenderContext): Promise<RenderOutcome>;
}
