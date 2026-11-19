import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UltraProject, type UltraProjectT } from "../core/schema.js";
import { ffprobeJson } from "../core/ffmpeg.js";
import { stitchTimeline } from "../core/stitcher.js";
import { writeJsonAtomic } from "../core/util.js";
import {
  PALETTE,
  makeAlphaPng,
  makeAudio,
  makeColorClip,
  makeOverlayMov,
  makeTempDir,
  makeWarmLut,
  runCli,
} from "./helpers.js";

function assetProject(): UltraProjectT {
  return UltraProject.parse({
    meta: {
      title: "Asset plan fixture",
      sourceVideoPath: "reference.mp4",
      width: 1280,
      height: 720,
      fps: 30,
      durationSec: 2,
    },
    designTokens: {
      palette: PALETTE,
      fonts: { heading: "Segoe UI", body: "Segoe UI", mono: "Consolas" },
      grainOpacity: 0.05,
      antiSlopRules: ["palette only"],
    },
    colorGrade: {},
    audio: {},
    assets: [
      {
        id: "logo",
        type: "png_alpha",
        description: "logo mark",
        prompt: "flat amber rectangle",
        width: 160,
        height: 48,
        requireAlpha: true,
        targetPath: "assets/logo.png",
      },
      {
        id: "badge",
        type: "svg",
        description: "vector badge",
        prompt: "blue badge",
        targetPath: "assets/badge.svg",
      },
    ],
    scenes: [
      {
        id: "only",
        name: "Only scene",
        startSec: 0,
        endSec: 2,
        engine: "hyperframes",
        background: PALETTE.bg,
        layers: [{ id: "logo", type: "png_alpha", assetId: "logo", x: 100, y: 100, width: 160, height: 48 }],
        textElements: [
          {
            id: "label",
            text: "ASSETS",
            font: "heading",
            sizePx: 64,
            color: PALETTE.fg,
            x: 100,
            y: 300,
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

describe("phase 2 — assets + FFmpeg stitcher", () => {
  it("asset-plan lists only missing assets, validate-assets enforces alpha + SVG XML rules", async () => {
    const dir = await makeTempDir("p2-assets");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(path.join(workspace, "assets"), { recursive: true });
    await writeJsonAtomic(path.join(workspace, "ultra.json"), assetProject());

    const plan = await runCli(dir, ["asset-plan"], 120_000);
    expect(plan.code, plan.stderr).toBe(0);
    const todo = JSON.parse(await fs.readFile(path.join(workspace, "assets-todo.json"), "utf8"));
    expect(todo.complete).toBe(false);
    expect(todo.missing.map((m: { id: string }) => m.id).sort()).toEqual(["badge", "logo"]);
    for (const item of todo.missing) expect(item.instruction.length).toBeGreaterThan(20);

    const early = await runCli(dir, ["validate-assets"], 120_000);
    expect(early.code).toBe(1);
    expect(early.stderr).toContain("asset");

    await makeAlphaPng(path.join(workspace, "assets", "logo.png"));
    await fs.writeFile(
      path.join(workspace, "assets", "badge.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60"><rect width="200" height="60" fill="#8ecae6"/></svg>`,
      "utf8",
    );

    const ok = await runCli(dir, ["validate-assets"], 120_000);
    expect(ok.code, ok.stderr).toBe(0);
    const manifest = JSON.parse(await fs.readFile(path.join(workspace, "assets.manifest.json"), "utf8"));
    expect(manifest.assets.logo.valid).toBe(true);
    expect(manifest.assets.logo.sha1).toMatch(/^[0-9a-f]{40}$/);

    await fs.writeFile(path.join(workspace, "assets", "badge.svg"), "<svg><rect width='2'</svg>", "utf8");
    const broken = await runCli(dir, ["validate-assets"], 120_000);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain("badge");
    expect(broken.stderr).toMatch(/invalid svg|malformed|unbalanced|unclosed/i);
  }, 180_000);

  it("stitches 3 xfaded scenes + an alpha overlay + ducked audio + LUT grade at exact duration", async () => {
    const dir = await makeTempDir("p2-stitch");
    const workspace = path.join(dir, "workspace");
    const buildDir = path.join(dir, "build");
    const assets = path.join(workspace, "assets");
    await fs.mkdir(assets, { recursive: true });
    await makeAudio(path.join(assets, "music.wav"), 3.2, 220);
    await makeAudio(path.join(assets, "voice.wav"), 1.2, 330);
    await makeAudio(path.join(assets, "hit.wav"), 0.3, 880);
    await makeAlphaPng(path.join(assets, "logo.png"));
    await makeWarmLut(path.join(assets, "warm.cube"));
    const overlay = path.join(assets, "overlay.mov");
    await makeOverlayMov(overlay, path.join(assets, "logo.png"), 1.0);

    const clipsDir = path.join(buildDir, "scenes");
    await fs.mkdir(clipsDir, { recursive: true });
    await makeColorClip(path.join(clipsDir, "s1.mp4"), 1.25, "0x101820");
    await makeColorClip(path.join(clipsDir, "s2.mp4"), 1.2, "0xd9484f");
    await makeColorClip(path.join(clipsDir, "s3.mp4"), 1.0, "0x2c4a7c");

    const project = UltraProject.parse({
      meta: {
        title: "Stitch",
        sourceVideoPath: "reference.mp4",
        width: 1280,
        height: 720,
        fps: 30,
        durationSec: 3,
      },
      designTokens: {
        palette: PALETTE,
        fonts: { heading: "Segoe UI", body: "Segoe UI", mono: "Consolas" },
        grainOpacity: 0.05,
        antiSlopRules: ["palette only"],
      },
      colorGrade: { lutPath: "assets/warm.cube", exposure: 0.05, contrast: 0.1, saturation: 1.05, temperature: 0.1, vignette: 0.2 },
      audio: {
        targetLufs: -14,
        musicAssetId: "music",
        voiceAssetId: "voice",
        duckingDb: -12,
        sfxCues: [{ assetId: "hit", atSec: 1, gainDb: -8 }],
      },
      assets: [
        { id: "music", type: "music", description: "bed", prompt: "bed", durationSec: 3, targetPath: "assets/music.wav" },
        { id: "voice", type: "voice", description: "vo", prompt: "vo", durationSec: 1, targetPath: "assets/voice.wav" },
        { id: "hit", type: "sfx", description: "hit", prompt: "hit", durationSec: 0.25, targetPath: "assets/hit.wav" },
      ],
      scenes: [
        {
          id: "s1",
          name: "S1",
          startSec: 0,
          endSec: 1,
          engine: "hyperframes",
          background: "#101820",
          transitionIn: { type: "none", durationSec: 0 },
          enginePayload: {},
        },
        {
          id: "s2",
          name: "S2",
          startSec: 1,
          endSec: 2,
          engine: "hyperframes",
          background: "#d9484f",
          transitionIn: { type: "fade", durationSec: 0.25 },
          enginePayload: {},
        },
        {
          id: "s3",
          name: "S3",
          startSec: 2,
          endSec: 3,
          engine: "hyperframes",
          background: "#2c4a7c",
          transitionIn: { type: "wipeleft", durationSec: 0.2 },
          enginePayload: {},
        },
        {
          id: "ov",
          name: "Overlay",
          startSec: 0.5,
          endSec: 1.5,
          engine: "blender",
          alpha: true,
          overlayOfSceneId: "s1",
          transitionIn: { type: "none", durationSec: 0 },
          background: "transparent",
          enginePayload: {},
        },
      ],
    });

    const outFile = path.join(buildDir, "draft.mp4");
    const result = await stitchTimeline({
      project,
      workspace,
      buildDir,
      clips: [
        { sceneId: "s1", file: path.join(clipsDir, "s1.mp4"), startSec: 0, endSec: 1, durationSec: 1.25 },
        { sceneId: "s2", file: path.join(clipsDir, "s2.mp4"), startSec: 1, endSec: 2, durationSec: 1.2 },
        { sceneId: "s3", file: path.join(clipsDir, "s3.mp4"), startSec: 2, endSec: 3, durationSec: 1.0 },
        { sceneId: "ov", file: overlay, startSec: 0.5, endSec: 1.5, durationSec: 1.0 },
      ],
      outFile,
    });

    expect(result.hasAudio).toBe(true);
    expect(result.transitionCount).toBe(2);
    expect(result.overlayCount).toBe(1);
    expect(Math.abs(result.durationSec - 3)).toBeLessThanOrEqual(0.001);

    const probe = await ffprobeJson(outFile);
    const video = probe.streams.find((s: any) => s.codec_type === "video");
    const audio = probe.streams.find((s: any) => s.codec_type === "audio");
    expect(video).toBeTruthy();
    expect(audio).toBeTruthy();
    expect(Math.abs(Number(probe.format.duration) - 3)).toBeLessThanOrEqual(0.08);
    expect(Number(video.nb_frames)).toBeGreaterThanOrEqual(87);
    expect(Number(video.nb_frames)).toBeLessThanOrEqual(92);
    expect(video.pix_fmt).toBe("yuv420p");
  }, 300_000);
});
