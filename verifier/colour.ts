import { promises as fs } from "node:fs";
import path from "node:path";
import type { UltraProjectT, VerifyReportT } from "../core/schema.js";
import { UltraProject } from "../core/schema.js";
import { routeScene } from "../core/orchestrator.js";
import { stitchTimeline } from "../core/stitcher.js";
import { detectRenderTier } from "../core/env.js";
import { runBinary } from "../core/ffmpeg.js";
import { ensureDir, rmrf, round } from "../core/util.js";
import { ultraTmpDir } from "../core/env.js";

/**
 * [16] Colour round-trip: every palette colour is rendered as a solid swatch
 * through the NORMAL pipeline (engine → stitch grade → yuv420p bt709 encode),
 * the encoded centre pixel is decoded back to sRGB and compared to the intent
 * in CIE76 ΔE. No auto-correction here — the report tells the truth.
 */

function srgbToLinear(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function hexToLab(hex: string): { L: number; a: number; b: number } {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean.slice(0, 6);
  const r = srgbToLinear(parseInt(full.slice(0, 2), 16));
  const g = srgbToLinear(parseInt(full.slice(2, 4), 16));
  const b = srgbToLinear(parseInt(full.slice(4, 6), 16));
  // sRGB → XYZ (D65)
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = (r * 0.2126729 + g * 0.7151522 + b * 0.072175) / 1.0;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function deltaE76(a: string, b: string): number {
  const labA = hexToLab(a);
  const labB = hexToLab(b);
  return round(Math.sqrt((labA.L - labB.L) ** 2 + (labA.a - labB.a) ** 2 + (labA.b - labB.b) ** 2), 3);
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

export async function colourRoundTrip(
  project: UltraProjectT,
  workspace: string,
  buildDir: string,
): Promise<NonNullable<VerifyReportT["colour"]> | undefined> {
  const entries = Object.entries(project.designTokens.palette);
  if (entries.length === 0) return undefined;
  const tier = (await detectRenderTier()).tier;
  const scratch = path.join(ultraTmpDir(), `ultra-colour-${process.pid}-${Date.now()}`);
  await ensureDir(scratch);
  const results: NonNullable<VerifyReportT["colour"]> = [];
  try {
    for (const [name, hex] of entries) {
      const duration = round(Math.max(0.2, 4 / project.meta.fps), 3);
      const swatchProject = UltraProject.parse({
        meta: { ...project.meta, title: `colour ${name}`, durationSec: duration },
        designTokens: { ...project.designTokens, grainOpacity: 0 },
        colorGrade: project.colorGrade,
        audio: {},
        assets: [],
        scenes: [
          {
            id: "swatch",
            name: "Swatch",
            startSec: 0,
            endSec: duration,
            engine: "hyperframes",
            background: hex,
            layers: [],
            textElements: [],
            effects: [],
          },
        ],
      });
      const scene = swatchProject.scenes[0]!;
      const choice = await routeScene(scene, false, tier);
      const clipFile = path.join(scratch, `clip-${name.replace(/[^\w.-]/g, "_")}.mp4`);
      await choice.engine.renderScene({
        project: swatchProject,
        scene,
        workspace,
        buildDir: path.join(scratch, "build"),
        outFile: clipFile,
        durationSec: duration,
        fps: project.meta.fps,
        width: project.meta.width,
        height: project.meta.height,
        alpha: false,
      });
      const stitched = path.join(scratch, `stitched-${name.replace(/[^\w.-]/g, "_")}.mp4`);
      await stitchTimeline({
        project: swatchProject,
        workspace,
        buildDir: path.join(scratch, "build"),
        clips: [{ sceneId: scene.id, file: clipFile, startSec: 0, endSec: duration, durationSec: duration }],
        outFile: stitched,
        crf: 16,
        preset: "fast",
      });
      const evenW = project.meta.width - (project.meta.width % 2);
      const evenH = project.meta.height - (project.meta.height % 2);
      const pixel = await runBinary("ffmpeg", [
        "-v",
        "error",
        "-ss",
        (duration / 2).toFixed(3),
        "-i",
        stitched,
        "-vf",
        `crop=2:2:${Math.floor(evenW / 2 / 2) * 2}:${Math.floor(evenH / 2 / 2) * 2}`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
      ]);
      if (pixel.stdout.length < 3) continue;
      const measuredHex = toHex(pixel.stdout[0] as number, pixel.stdout[1] as number, pixel.stdout[2] as number);
      results.push({
        name,
        intendedHex: hex,
        measuredHex,
        deltaE: deltaE76(hex, measuredHex),
        method: "CIE76",
      });
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
  return results.length > 0 ? results : undefined;
}

export const __test = { deltaE76, hexToLab };
