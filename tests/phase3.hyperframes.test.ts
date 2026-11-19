import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UltraProject, type UltraProjectT } from "../core/schema.js";
import { hyperframesEngine } from "../engines/hyperframes/index.js";
import { ffprobeJson } from "../core/ffmpeg.js";
import { writeJsonAtomic } from "../core/util.js";
import { PALETTE, kineticProject, makeTempDir } from "./helpers.js";

function badSceneProject(): UltraProjectT {
  return UltraProject.parse({
    meta: {
      title: "Bad layout",
      sourceVideoPath: "reference.mp4",
      width: 1280,
      height: 720,
      fps: 30,
      durationSec: 1,
    },
    designTokens: {
      palette: PALETTE,
      fonts: { heading: "Segoe UI", body: "Segoe UI", mono: "Consolas" },
      grainOpacity: 0.03,
      antiSlopRules: ["palette only"],
    },
    colorGrade: {},
    audio: {},
    assets: [],
    scenes: [
      {
        id: "bad",
        name: "Bad",
        startSec: 0,
        endSec: 1,
        engine: "hyperframes",
        background: PALETTE.bg,
        textElements: [
          {
            id: "clipT",
            text: "CLIPPED",
            font: "body",
            sizePx: 20,
            color: "#7a7a7a",
            x: 1240,
            y: 100,
            align: "left",
            letterSpacingPx: 0,
            lineHeight: 1.2,
            uppercase: false,
          },
          {
            id: "overA",
            text: "OVERLAP",
            font: "heading",
            sizePx: 44,
            color: PALETTE.accent,
            x: 200,
            y: 300,
            align: "left",
            letterSpacingPx: 0,
            lineHeight: 1.1,
            uppercase: true,
          },
          {
            id: "overB",
            text: "OVERLAP",
            font: "heading",
            sizePx: 44,
            color: PALETTE.secondary,
            x: 210,
            y: 305,
            align: "left",
            letterSpacingPx: 0,
            lineHeight: 1.1,
            uppercase: true,
          },
        ],
        enginePayload: {},
      },
    ],
  });
}

describe("phase 3 — HyperFrames deterministic engine + DOM linter", () => {
  it("renders a real 3s 60fps kinetic typography clip with exact CFR", async () => {
    const dir = await makeTempDir("p3-render");
    const workspace = path.join(dir, "workspace");
    const buildDir = path.join(dir, "build");
    await fs.mkdir(workspace, { recursive: true });
    const project = kineticProject(60);
    await writeJsonAtomic(path.join(workspace, "ultra.json"), project);
    const scene = project.scenes[0]!;

    const outFile = path.join(buildDir, "kinetic.mp4");
    const outcome = await hyperframesEngine.renderScene({
      project,
      scene,
      workspace,
      buildDir,
      outFile,
      durationSec: 3,
      fps: 60,
      width: 1280,
      height: 720,
      alpha: false,
    });
    expect(outcome.frames).toBe(180);
    expect(outcome.engineUsed).toBe("hyperframes");

    const stat = await fs.stat(outFile);
    expect(stat.size).toBeGreaterThan(8_000);

    const probe = await ffprobeJson(outFile);
    const video = probe.streams.find((s: any) => s.codec_type === "video");
    expect(Number(video.nb_frames)).toBe(180);
    expect(Math.abs(Number(probe.format.duration) - 3)).toBeLessThanOrEqual(0.05);
    expect(video.width).toBe(1280);
    expect(video.height).toBe(720);
    const fps = video.avg_frame_rate === "60/1" ? 60 : Number(video.avg_frame_rate.split("/")[0]) / Number(video.avg_frame_rate.split("/")[1]);
    expect(Math.abs(fps - 60)).toBeLessThan(0.01);
  }, 600_000);

  it("DOM linter passes a clean scene and catches clipping, low contrast, off-palette color and text overlap", async () => {
    const dir = await makeTempDir("p3-lint");
    const workspace = path.join(dir, "workspace");
    const buildDir = path.join(dir, "build");
    await fs.mkdir(workspace, { recursive: true });

    const good = kineticProject(30);
    const goodLint = await hyperframesEngine.lint({
      project: good,
      scene: good.scenes[0]!,
      workspace,
      buildDir,
      fps: 30,
      width: 1280,
      height: 720,
    });
    expect(goodLint.pass).toBe(true);
    expect(goodLint.defects.filter((d) => d.critical)).toHaveLength(0);

    const bad = badSceneProject();
    const badLint = await hyperframesEngine.lint({
      project: bad,
      scene: bad.scenes[0]!,
      workspace,
      buildDir,
      fps: 30,
      width: 1280,
      height: 720,
    });
    const categories = new Set(badLint.defects.map((d) => d.category));
    expect(categories.has("clip")).toBe(true);
    expect(categories.has("contrast")).toBe(true);
    expect(categories.has("palette")).toBe(true);
    expect(categories.has("overlap")).toBe(true);
    expect(badLint.pass).toBe(false);
    expect(badLint.defects.some((d) => d.critical)).toBe(true);
  }, 300_000);
});
