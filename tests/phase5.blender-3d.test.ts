import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UltraProject } from "../core/schema.js";
import { ffprobeJson } from "../core/ffmpeg.js";
import { writeJsonAtomic } from "../core/util.js";
import { PALETTE, makeTempDir, runCli, writeBaseAssets } from "./helpers.js";

describe("phase 5 — Blender engine with Three.js WebGL fallback", () => {
  it("renders a 1.5s transparent scene_graph overlay and composites it over video", async () => {
    const dir = await makeTempDir("p5-blender");
    const workspace = path.join(dir, "workspace");
    await writeBaseAssets(workspace);

    const project = UltraProject.parse({
      meta: {
        title: "3D overlay",
        sourceVideoPath: "reference.mp4",
        width: 1280,
        height: 720,
        fps: 30,
        durationSec: 2.5,
      },
      designTokens: {
        palette: PALETTE,
        fonts: { heading: "Segoe UI", body: "Segoe UI", mono: "Consolas" },
        grainOpacity: 0.04,
        antiSlopRules: ["palette only"],
      },
      colorGrade: {},
      audio: {},
      assets: [
        {
          id: "graph",
          type: "3d_graph",
          description: "amber torus",
          prompt: "torus",
          targetPath: "assets/scene_graph.json",
        },
      ],
      scenes: [
        {
          id: "base",
          name: "Base",
          startSec: 0,
          endSec: 2.5,
          engine: "hyperframes",
          background: PALETTE.bg,
          layers: [{ id: "bar", type: "shape", color: PALETTE.accent, x: 100, y: 500, width: 300, height: 10, radius: 5 }],
          textElements: [
            {
              id: "title",
              text: "OVERLAY",
              font: "heading",
              sizePx: 84,
              color: PALETTE.fg,
              x: 100,
              y: 300,
              width: 800,
              align: "left",
              weight: 800,
              letterSpacingPx: -1,
              lineHeight: 1,
              uppercase: true,
            },
          ],
          enginePayload: {},
        },
        {
          id: "vfx",
          name: "3D",
          startSec: 0.5,
          endSec: 2.0,
          engine: "blender",
          alpha: true,
          overlayOfSceneId: "base",
          transitionIn: { type: "none", durationSec: 0 },
          background: "transparent",
          enginePayload: { sceneGraphAssetId: "graph" },
        },
      ],
    });
    await writeJsonAtomic(path.join(workspace, "ultra.json"), project);

    const build = await runCli(dir, ["build"], 900_000);
    expect(build.code, build.stderr).toBe(0);

    const manifest = JSON.parse(await fs.readFile(path.join(dir, "build", "build-manifest.json"), "utf8"));
    const vfx = manifest.scenes.find((s: any) => s.sceneId === "vfx");
    expect(vfx).toBeTruthy();
    expect(vfx.alpha).toBe(true);
    expect(vfx.file.endsWith(".mov")).toBe(true);
    expect(vfx.notes.join(" ")).toMatch(/threejs-webgl-fallback|blender-native/);
    expect(manifest.stitch.overlayCount).toBe(1);

    const overlayProbe = await ffprobeJson(vfx.file);
    const overlayVideo = overlayProbe.streams.find((s: any) => s.codec_type === "video");
    expect(String(overlayVideo.pix_fmt)).toMatch(/yuva/i);
    expect(Number(overlayVideo.nb_frames)).toBeGreaterThanOrEqual(44);
    expect(Number(overlayVideo.nb_frames)).toBeLessThanOrEqual(46);

    const draft = path.join(dir, "build", "draft.mp4");
    const stat = await fs.stat(draft);
    expect(stat.size).toBeGreaterThan(50_000);
    const probe = await ffprobeJson(draft);
    expect(Math.abs(Number(probe.format.duration) - 2.5)).toBeLessThanOrEqual(0.1);
    const video = probe.streams.find((s: any) => s.codec_type === "video");
    expect(Number(video.nb_frames)).toBeGreaterThanOrEqual(73);
    expect(Number(video.nb_frames)).toBeLessThanOrEqual(77);
  }, 900_000);
});
