import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { UltraProject, type UltraProjectT } from "../core/schema.js";
import { hyperframesEngine } from "../engines/hyperframes/index.js";
import { pyCanvasEngine } from "../engines/py-canvas/index.js";
import { compileSceneHtml } from "../engines/hyperframes/compiler.js";
import { lintScene } from "../engines/hyperframes/lint.js";
import { fontMatch } from "../core/font-match.js";
import { ffmpegOk, ffmpeg, ffprobeJson, runBinary } from "../core/ffmpeg.js";
import { ensureDir, pathExists, sha1 } from "../core/util.js";
import { buildProject } from "../core/orchestrator.js";
import { PALETTE, ROOT, makeTempDir, runCli } from "./helpers.js";

/**
 * phase 14 — P3 engine expressiveness.
 * [9] prelude order, [10] video layers + frames mode, [11] motion blur cap 8,
 * [12] masks, [13] blend + parallax, [14] font-match, [15] font-stretch/scaleX,
 * [16] colour (phase13), [17] guides/anchors, [3] bundle provenance.
 */

function baseProject(opts: {
  durationSec: number;
  fps?: number;
  width?: number;
  height?: number;
  scenes?: Record<string, unknown>[];
  assets?: UltraProjectT["assets"];
  method?: "native" | "plate-replay" | "mixed";
}): UltraProjectT {
  const fps = opts.fps ?? 10;
  return UltraProject.parse({
    meta: {
      title: "P14",
      sourceVideoPath: "reference.mp4",
      width: opts.width ?? 320,
      height: opts.height ?? 180,
      fps,
      durationSec: opts.durationSec,
      method: opts.method ?? "native",
    },
    designTokens: {
      palette: PALETTE,
      fonts: { heading: "Ultra Display", body: "Ultra Sans", mono: "Ultra Mono" },
      grainOpacity: 0,
      antiSlopRules: ["palette only"],
    },
    colorGrade: {},
    audio: {},
    assets: opts.assets ?? [],
    scenes: opts.scenes ?? [
      { id: "only", name: "Only", startSec: 0, endSec: opts.durationSec, engine: "hyperframes", background: PALETTE.bg },
    ],
  });
}

async function frameRgb(file: string, atSec: number, w: number, h: number): Promise<number[]> {
  const result = await runBinary("ffmpeg", ["-v", "error", "-ss", atSec.toFixed(3), "-i", file, "-frames:v", "1", "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return Array.from(result.stdout.subarray(0, w * h * 3));
}

function centroid(pixels: number[], w: number, h: number, predicate: (r: number, g: number, b: number) => boolean): { x: number; y: number; count: number } {
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 3;
      const r = pixels[i] as number;
      const g = pixels[i + 1] as number;
      const b = pixels[i + 2] as number;
      if (!predicate(r, g, b)) continue;
      sx += x;
      sy += y;
      count += 1;
    }
  }
  return { x: count ? sx / count : NaN, y: count ? sy / count : NaN, count };
}

async function ssimFiles(aFile: string, atA: number, bFile: string, atB: number): Promise<number> {
  const run = await ffmpeg([
    "-ss", atA.toFixed(3), "-i", aFile,
    "-ss", atB.toFixed(3), "-i", bFile,
    "-filter_complex", "[0:v]scale=320:180,format=yuv420p[r];[1:v]scale=320:180,format=yuv420p[d];[r][d]ssim",
    "-frames:v", "1", "-f", "null", "-",
  ]);
  const match = run.stderr.match(/All:\s*([0-9]+(?:\.[0-9]+)?)/);
  return Number(match?.[1] ?? 0);
}

describe("[9] UltraEase prelude is injected before user head scripts", () => {
  it("a <head> script capturing UltraEase renders animated (never silently static)", async () => {
    const dir = await makeTempDir("p9-prelude");
    const workspace = path.join(dir, "workspace");
    const buildDir = path.join(dir, "build");
    await fs.mkdir(path.join(workspace, "scenes"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "scenes", "head.html"),
      `<!doctype html><html><head><script>
        var EASE = window.UltraEase.easeOutCubic;
        window.ultraRender = function (frame, fps, t, progress) {
          document.getElementById("box").style.transform = "translateX(" + (EASE(progress) * 200).toFixed(2) + "px)";
        };
      </script></head><body style="margin:0;background:#101820">
        <div id="box" style="position:absolute;left:20px;top:60px;width:40px;height:40px;background:#ffffff"></div>
      </body></html>`,
      "utf8",
    );
    const project = baseProject({
      durationSec: 1,
      scenes: [{ id: "head", name: "Head", startSec: 0, endSec: 1, engine: "hyperframes", background: PALETTE.bg, customHtmlFile: "head.html" }],
    });
    const outFile = path.join(buildDir, "head.mp4");
    await hyperframesEngine.renderScene({
      project,
      scene: project.scenes[0]!,
      workspace,
      buildDir,
      outFile,
      durationSec: 1,
      fps: 10,
      width: 320,
      height: 180,
      alpha: false,
    });
    const first = await frameRgb(outFile, 0.05, 320, 180);
    const last = await frameRgb(outFile, 0.85, 320, 180);
    const white = (r: number, g: number, b: number) => r > 200 && g > 200 && b > 200;
    const start = centroid(first, 320, 180, white);
    const end = centroid(last, 320, 180, white);
    expect(start.count).toBeGreaterThan(0);
    expect(end.x - start.x).toBeGreaterThan(120);
  }, 300_000);

  it("lint fails a script that reads UltraEase before <head> (captures undefined)", async () => {
    const dir = await makeTempDir("p9-lint");
    const workspace = path.join(dir, "workspace");
    const buildDir = path.join(dir, "build");
    await fs.mkdir(path.join(workspace, "scenes"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "scenes", "bad.html"),
      `<script>window.__E = window.UltraEase.easeOutCubic;</script><html><head></head><body style="background:#101820">bad</body></html>`,
      "utf8",
    );
    const project = baseProject({
      durationSec: 1,
      scenes: [{ id: "bad", name: "Bad", startSec: 0, endSec: 1, engine: "hyperframes", background: PALETTE.bg, customHtmlFile: "bad.html" }],
    });
    const result = await lintScene({
      project,
      scene: project.scenes[0]!,
      workspace,
      buildDir,
      fps: 10,
      width: 320,
      height: 180,
    });
    const runtime = result.defects.find((defect) => defect.category === "runtime");
    expect(runtime).toBeTruthy();
    expect(runtime!.critical).toBe(true);
    expect(runtime!.detail).toContain("UltraEase");
    expect(result.pass).toBe(false);
  }, 300_000);
});

async function makeColorCycleVideo(file: string): Promise<void> {
  await ffmpegOk([
    "-f", "lavfi", "-i", "color=c=0xd9484f:s=320x180:d=1:r=30",
    "-f", "lavfi", "-i", "color=c=0x2e7d32:s=320x180:d=1:r=30",
    "-f", "lavfi", "-i", "color=c=0x2c4a7c:s=320x180:d=1:r=30",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]",
    "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", file,
  ]);
}

function videoLayerProject(videoPath: string, opts: { inSec: number; videoMode?: "seek" | "frames" }): UltraProjectT {
  return baseProject({
    durationSec: 1,
    fps: 10,
    assets: [{ id: "clip", type: "video", description: "clip", prompt: "clip", targetPath: videoPath }],
    scenes: [
      {
        id: "vid",
        name: "Vid",
        startSec: 0,
        endSec: 1,
        engine: "hyperframes",
        background: PALETTE.bg,
        videoMode: opts.videoMode ?? "seek",
        layers: [{ id: "v", type: "video", assetId: "clip", x: 0, y: 0, width: 320, height: 180, inSec: opts.inSec, objectFit: "cover" }],
      },
    ],
  });
}

describe("[10] video layers honour inSec/rate/loop + frames mode", () => {
  it("inSec=2 renders the 2s frame, not 0s", async () => {
    const dir = await makeTempDir("p10-insec");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const video = path.join(workspace, "cycle.mp4");
    await makeColorCycleVideo(video);
    const project = videoLayerProject("cycle.mp4", { inSec: 2 });
    const out = path.join(dir, "insec.mp4");
    await hyperframesEngine.renderScene({
      project,
      scene: project.scenes[0]!,
      workspace,
      buildDir: path.join(dir, "build"),
      outFile: out,
      durationSec: 1,
      fps: 10,
      width: 320,
      height: 180,
      alpha: false,
    });
    const pixels = await frameRgb(out, 0.1, 320, 180);
    const center = centroid(pixels, 320, 180, (r, g, b) => b > 80 && b > r + 30);
    expect(center.count).toBeGreaterThan(320 * 180 * 0.5); // blue segment at 2s
    const zero = videoLayerProject("cycle.mp4", { inSec: 0 });
    const outZero = path.join(dir, "insec0.mp4");
    await hyperframesEngine.renderScene({
      project: zero,
      scene: zero.scenes[0]!,
      workspace,
      buildDir: path.join(dir, "build"),
      outFile: outZero,
      durationSec: 1,
      fps: 10,
      width: 320,
      height: 180,
      alpha: false,
    });
    const zeroPixels = await frameRgb(outZero, 0.1, 320, 180);
    const red = centroid(zeroPixels, 320, 180, (r, g, b) => r > 120 && r > g + 40);
    expect(red.count).toBeGreaterThan(320 * 180 * 0.5);
  }, 300_000);

  it("frames mode matches an FFmpeg extraction of the same instant (SSIM > 0.99)", async () => {
    const dir = await makeTempDir("p10-frames");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const video = path.join(workspace, "detail.mp4");
    await ffmpegOk([
      "-f", "lavfi", "-i", "color=c=0x101820:s=320x180:d=3:r=30",
      "-f", "lavfi", "-i", "color=c=white:s=40x40:d=3:r=30",
      "-filter_complex", "[1:v]format=rgba[b];[0:v][b]overlay=x='40+200*t':y=70:shortest=1,format=yuv420p[v]",
      "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", video,
    ]);
    const project = videoLayerProject("detail.mp4", { inSec: 1, videoMode: "frames" });
    const out = path.join(dir, "frames.mp4");
    const outcome = await hyperframesEngine.renderScene({
      project,
      scene: project.scenes[0]!,
      workspace,
      buildDir: path.join(dir, "build"),
      outFile: out,
      durationSec: 1,
      fps: 10,
      width: 320,
      height: 180,
      alpha: false,
    });
    expect(outcome.frames).toBe(10);
    const referencePng = path.join(dir, "ref-1.2.png");
    await ffmpegOk(["-ss", "1.2", "-i", video, "-frames:v", "1", "-y", referencePng]);
    // Extract the rendered frame at scene t=0.2 (same source instant 1.2s).
    const renderedPng = path.join(dir, "rendered-0.2.png");
    await ffmpegOk(["-ss", "0.2", "-i", out, "-frames:v", "1", "-y", renderedPng]);
    const ssim = await ffmpeg([
      "-i", referencePng, "-i", renderedPng,
      "-filter_complex", "[0:v]scale=320:180,format=yuv420p[r];[1:v]scale=320:180,format=yuv420p[d];[r][d]ssim",
      "-frames:v", "1", "-f", "null", "-",
    ]);
    const value = Number(/All:\s*([0-9.]+)/.exec(ssim.stderr)?.[1] ?? 0);
    expect(value).toBeGreaterThan(0.99);
    // Lookup cache must live in .ultra-cache/video-frames.
    expect(await pathExists(path.join(ROOT, ".ultra-cache", "video-frames"))).toBe(true);
  }, 600_000);
});

describe("[11] motion blur: cap 8, py-canvas parity, honest warnings", () => {
  it("schema accepts 8 and rejects 9", () => {
    const scene = { id: "s", name: "S", startSec: 0, endSec: 1, engine: "hyperframes", background: PALETTE.bg, motionBlurSamples: 8 };
    expect(baseProject({ durationSec: 1, scenes: [scene] }).scenes[0]!.motionBlurSamples).toBe(8);
    expect(() => baseProject({ durationSec: 1, scenes: [{ ...scene, motionBlurSamples: 9 }] })).toThrow();
  });

  it("py-canvas samples=2 differs from samples=1 and loosely matches hyperframes", async () => {
    const dir = await makeTempDir("p11-blur");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const make = (samples: number) =>
      baseProject({
        durationSec: 1,
        fps: 10,
        scenes: [
          {
            id: "move",
            name: "Move",
            startSec: 0,
            endSec: 1,
            engine: "hyperframes",
            background: PALETTE.bg,
            motionBlurSamples: samples,
            layers: [{ id: "box", type: "shape", color: "#ffffff", x: 20, y: 60, width: 40, height: 40 }],
            keyframes: [{ target: "box", property: "x", keyframes: [{ atSec: 0, value: 20, ease: "linear" }, { atSec: 1, value: 240, ease: "linear" }] }],
          },
        ],
      });
    const render = async (engine: typeof pyCanvasEngine, project: UltraProjectT, out: string) =>
      engine.renderScene({ project, scene: project.scenes[0]!, workspace, buildDir: path.join(dir, "build"), outFile: out, durationSec: 1, fps: 10, width: 320, height: 180, alpha: false });

    await render(pyCanvasEngine, make(1), path.join(dir, "py-1.mp4"));
    await render(pyCanvasEngine, make(2), path.join(dir, "py-2.mp4"));
    await render(hyperframesEngine, make(2), path.join(dir, "hf-2.mp4"));

    const diff = await ffmpeg(["-i", path.join(dir, "py-1.mp4"), "-i", path.join(dir, "py-2.mp4"), "-filter_complex", "[0:v][1:v]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-frames:v", "3", "-f", "null", "-"]);
    const avg = [...diff.stderr.matchAll(/YAVG=([0-9.]+)/g)].reduce((acc, m) => acc + Number(m[1]), 0) / Math.max(1, [...diff.stderr.matchAll(/YAVG=/g)].length);
    expect(avg).toBeGreaterThan(0.5);
    const parity = await ssimFiles(path.join(dir, "py-2.mp4"), 0.5, path.join(dir, "hf-2.mp4"), 0.5);
    expect(parity).toBeGreaterThan(0.95);
  }, 600_000);

  it("warns when probe-measured fast motion is rendered without motion blur", async () => {
    const dir = await makeTempDir("p11-warn");
    const workspace = path.join(dir, "workspace");
    const buildDir = path.join(dir, "build");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "probe.json"),
      JSON.stringify({ scenes: [{ index: 0, startSec: 0, endSec: 1, motionScore: 7.5, colors: [], avgLuminance: 0.2, contrast: 0.2 }] }),
      "utf8",
    );
    const project = baseProject({
      durationSec: 1,
      scenes: [
        {
          id: "fast",
          name: "Fast",
          startSec: 0,
          endSec: 1,
          engine: "hyperframes",
          background: PALETTE.bg,
          layers: [{ id: "box", type: "shape", color: "#ffffff", x: 20, y: 60, width: 30, height: 30 }],
        },
      ],
    });
    const manifest = await buildProject({ project, workspace, buildDir });
    const scene = manifest.scenes[0]!;
    expect(scene.notes.join(" ")).toContain("without motion blur");
  }, 300_000);
});

describe("[12] masks render feathered soft edges", () => {
  it("a feathered circle mask produces >3 intermediate grey levels across the edge", async () => {
    const dir = await makeTempDir("p12-mask");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const project = baseProject({
      durationSec: 0.3,
      fps: 10,
      width: 200,
      height: 200,
      scenes: [
        {
          id: "mask",
          name: "Mask",
          startSec: 0,
          endSec: 0.3,
          engine: "hyperframes",
          background: PALETTE.bg,
          layers: [
            {
              id: "plate",
              type: "shape",
              color: "#ffffff",
              x: 0,
              y: 0,
              width: 200,
              height: 200,
              mask: { type: "circle", pointsOrPath: "60", featherPx: 30, invert: false, centerXPercent: 50, centerYPercent: 50 },
            },
          ],
        },
      ],
    });
    const out = path.join(dir, "mask.mp4");
    await hyperframesEngine.renderScene({
      project,
      scene: project.scenes[0]!,
      workspace,
      buildDir: path.join(dir, "build"),
      outFile: out,
      durationSec: 0.3,
      fps: 10,
      width: 200,
      height: 200,
      alpha: false,
    });
    const pixels = await frameRgb(out, 0.1, 200, 200);
    let intermediates = 0;
    for (let x = 0; x < 200; x += 1) {
      const i = (100 * 200 + x) * 3;
      const v = pixels[i] as number;
      if (v > 25 && v < 230) intermediates += 1;
    }
    expect(intermediates).toBeGreaterThan(3);
  }, 300_000);
});

describe("[13] blend modes + parallax depth", () => {
  it("layers with different parallaxDepth move different pixel amounts under the same camera pan", async () => {
    const dir = await makeTempDir("p13-parallax");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const project = baseProject({
      durationSec: 1,
      fps: 10,
      scenes: [
        {
          id: "cam",
          name: "Cam",
          startSec: 0,
          endSec: 1,
          engine: "hyperframes",
          background: PALETTE.bg,
          camera: { perspectivePx: 1200, keyframes: [{ atSec: 0, panX: 0, ease: "linear" }, { atSec: 1, panX: 200, ease: "linear" }] },
          layers: [
            { id: "front", type: "shape", color: PALETTE.accent, x: 40, y: 30, width: 30, height: 30, parallaxDepth: 0 },
            { id: "back", type: "shape", color: PALETTE.secondary, x: 40, y: 120, width: 30, height: 30, parallaxDepth: 1 },
          ],
        },
      ],
    });
    const out = path.join(dir, "parallax.mp4");
    await hyperframesEngine.renderScene({
      project,
      scene: project.scenes[0]!,
      workspace,
      buildDir: path.join(dir, "build"),
      outFile: out,
      durationSec: 1,
      fps: 10,
      width: 320,
      height: 180,
      alpha: false,
    });
    const accent = (r: number, g: number, b: number) => r > 200 && g > 140 && b < 100;
    const secondary = (r: number, g: number, b: number) => b > 180 && g > 150 && r < 160;
    const p0 = await frameRgb(out, 0.05, 320, 180);
    const p1 = await frameRgb(out, 0.85, 320, 180);
    const front0 = centroid(p0, 320, 180, accent);
    const front1 = centroid(p1, 320, 180, accent);
    const back0 = centroid(p0, 320, 180, secondary);
    const back1 = centroid(p1, 320, 180, secondary);
    expect(front0.count).toBeGreaterThan(0);
    expect(back0.count).toBeGreaterThan(0);
    const frontDelta = front1.x - front0.x;
    const backDelta = back1.x - back0.x;
    expect(frontDelta).toBeGreaterThan(150);
    expect(Math.abs(backDelta - frontDelta)).toBeGreaterThan(60);
    // [13] blend enum maps add → plus-lighter in CSS.
    const html = await compileSceneHtml({
      project: baseProject({
        durationSec: 1,
        scenes: [{ id: "b", name: "B", startSec: 0, endSec: 1, engine: "hyperframes", background: PALETTE.bg, layers: [{ id: "l", type: "shape", color: "#ffffff", blend: "add", x: 0, y: 0, width: 10, height: 10 }] }],
      }),
      scene: baseProject({
        durationSec: 1,
        scenes: [{ id: "b", name: "B", startSec: 0, endSec: 1, engine: "hyperframes", background: PALETTE.bg, layers: [{ id: "l", type: "shape", color: "#ffffff", blend: "add", x: 0, y: 0, width: 10, height: 10 }] }],
      }).scenes[0]!,
      workspace,
      width: 320,
      height: 180,
      fps: 10,
    });
    expect(html).toContain("mix-blend-mode:plus-lighter");
  }, 300_000);
});

describe("[14] font-match ranks the narrowest candidate #1", () => {
  it("identifies the condensed source font and reports widthErrorPercent", async () => {
    const dir = await makeTempDir("p14-font");
    await fs.mkdir(dir, { recursive: true });
    const text = "HAMBURGEFONTSIV";
    const renderProbe = async (font: string, out: string, scaleX?: number) => {
      const escaped = font.replace(/\\/g, "/").replace(/:/g, "\\:");
      const vf = [
        `drawtext=fontfile='${escaped}':text='${text}':fontsize=90:fontcolor=black:x=30:y=30`,
        ...(scaleX ? [`scale=iw*${scaleX}:ih`] : []),
      ].join(",");
      await ffmpegOk(["-f", "lavfi", "-i", "color=c=white:s=1400x220:d=1", "-vf", vf, "-frames:v", "1", "-y", out]);
    };
    const display = path.join(ROOT, "assets", "fonts", "UltraDisplay-Bold.ttf");
    const sans = path.join(ROOT, "assets", "fonts", "UltraSans-Bold.ttf");
    const probe = path.join(dir, "probe.png");
    await renderProbe(display, probe);
    const first = await fontMatch(probe, { text });
    expect(first.length).toBeGreaterThanOrEqual(2);
    const narrowest = [...first].sort((a, b) => a.inkWidthPx - b.inkWidthPx)[0]!;
    expect(typeof narrowest.widthErrorPercent).toBe("number");

    const condensed = path.join(dir, "condensed.png");
    await renderProbe(narrowest.file || sans, condensed, 0.7);
    const ranked = await fontMatch(condensed, { text });
    expect(ranked[0]!.file).toBe(narrowest.file);
    expect(typeof ranked[0]!.widthErrorPercent).toBe("number");
    expect(ranked[0]!.widthErrorPercent).toBeLessThan(70);
  }, 300_000);
});

describe("[15] font-stretch + scaleX lint", () => {
  it("warns on text condensed by transform: scaleX but not on images", async () => {
    const dir = await makeTempDir("p15-stretch");
    const workspace = path.join(dir, "workspace");
    const buildDir = path.join(dir, "build");
    await fs.mkdir(path.join(workspace, "scenes"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "scenes", "text.html"),
      `<!doctype html><html><head><style>.headline{transform:scaleX(0.75)}</style></head><body style="background:#101820"><div class="headline" data-audit="text">TITLE</div></body></html>`,
      "utf8",
    );
    const project = baseProject({
      durationSec: 1,
      scenes: [{ id: "t", name: "T", startSec: 0, endSec: 1, engine: "hyperframes", background: PALETTE.bg, customHtmlFile: "text.html" }],
    });
    const bad = await lintScene({ project, scene: project.scenes[0]!, workspace, buildDir, fps: 10, width: 320, height: 180 });
    const scaleDefect = bad.defects.find((defect) => defect.detail.includes("scaleX"));
    expect(scaleDefect).toBeTruthy();
    expect(scaleDefect!.detail).toContain("fontStretchPercent");
    expect(scaleDefect!.critical).toBe(false);

    await fs.writeFile(
      path.join(workspace, "scenes", "image.html"),
      `<!doctype html><html><head><style>.logo{transform:scaleX(0.75)}</style></head><body style="background:#101820"><div class="logo" data-audit="el"><svg width="20" height="20"><rect width="20" height="20" fill="white"/></svg></div></body></html>`,
      "utf8",
    );
    const imageProject = baseProject({
      durationSec: 1,
      scenes: [{ id: "i", name: "I", startSec: 0, endSec: 1, engine: "hyperframes", background: PALETTE.bg, customHtmlFile: "image.html" }],
    });
    const good = await lintScene({ project: imageProject, scene: imageProject.scenes[0]!, workspace, buildDir, fps: 10, width: 320, height: 180 });
    expect(good.defects.some((defect) => defect.detail.includes("scaleX"))).toBe(false);

    const textProject = baseProject({
      durationSec: 1,
      scenes: [
        {
          id: "text",
          name: "Text",
          startSec: 0,
          endSec: 1,
          engine: "hyperframes",
          background: PALETTE.bg,
          textElements: [{ id: "t1", text: "TITLE", font: { family: "Ultra Display" }, sizePx: 40, color: "#ffffff", x: 20, y: 60, fontStretchPercent: 80 }],
        },
      ],
    });
    const html = await compileSceneHtml({ project: textProject, scene: textProject.scenes[0]!, workspace, width: 320, height: 180, fps: 10 });
    expect(html).toContain("font-stretch:80%");
    expect(html).toContain("font-family:'Ultra Display'");
  }, 300_000);
});

describe("[17] guides + anchors resolve before other transforms", () => {
  it("moving a guide keyframe moves anchored elements by the same delta and leaves unanchored ones put", async () => {
    const dir = await makeTempDir("p17-guides");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const project = baseProject({
      durationSec: 1,
      fps: 10,
      scenes: [
        {
          id: "grid",
          name: "Grid",
          startSec: 0,
          endSec: 1,
          engine: "hyperframes",
          background: PALETTE.bg,
          guides: [{ id: "g1", orientation: "v", keyframes: [{ atSec: 0, positionPx: 100, easing: "linear" }, { atSec: 1, positionPx: 300, easing: "linear" }] }],
          layers: [
            { id: "anchored", type: "shape", color: "#ffffff", x: 100, y: 30, width: 30, height: 30, anchor: { to: "guide:g1", dx: 0, dy: 0 } },
            { id: "free", type: "shape", color: PALETTE.secondary, x: 250, y: 120, width: 30, height: 30 },
          ],
        },
      ],
    });
    const out = path.join(dir, "guides.mp4");
    await hyperframesEngine.renderScene({
      project,
      scene: project.scenes[0]!,
      workspace,
      buildDir: path.join(dir, "build"),
      outFile: out,
      durationSec: 1,
      fps: 10,
      width: 320,
      height: 180,
      alpha: false,
    });
    const white = (r: number, g: number, b: number) => r > 200 && g > 200 && b > 200;
    const secondary = (r: number, g: number, b: number) => b > 180 && g > 150 && r < 160;
    const p0 = await frameRgb(out, 0.05, 320, 180);
    const p1 = await frameRgb(out, 0.85, 320, 180);
    const a0 = centroid(p0, 320, 180, white);
    const a1 = centroid(p1, 320, 180, white);
    const f0 = centroid(p0, 320, 180, secondary);
    const f1 = centroid(p1, 320, 180, secondary);
    expect(a0.count).toBeGreaterThan(0);
    expect(f0.count).toBeGreaterThan(0);
    expect(a1.x - a0.x).toBeGreaterThan(120);
    expect(Math.abs(f1.x - f0.x)).toBeLessThan(5);
  }, 300_000);

  it("lint warns about unanchored elements that track a guide", async () => {
    const dir = await makeTempDir("p17-lint");
    const workspace = path.join(dir, "workspace");
    const buildDir = path.join(dir, "build");
    await fs.mkdir(workspace, { recursive: true });
    const project = baseProject({
      durationSec: 1,
      scenes: [
        {
          id: "grid",
          name: "Grid",
          startSec: 0,
          endSec: 1,
          engine: "hyperframes",
          background: PALETTE.bg,
          guides: [{ id: "g1", orientation: "v", keyframes: [{ atSec: 0, positionPx: 100 }, { atSec: 1, positionPx: 300 }] }],
          layers: [
            { id: "tracks", type: "shape", color: "#ffffff", x: 100, y: 30, width: 20, height: 20 },
            { id: "anchored", type: "shape", color: "#ffffff", x: 300, y: 60, width: 20, height: 20, anchor: { to: "guide:g1", dx: 0, dy: 0 } },
          ],
        },
      ],
    });
    const result = await lintScene({ project, scene: project.scenes[0]!, workspace, buildDir, fps: 10, width: 320, height: 180 });
    const warning = result.defects.find((defect) => defect.detail.includes("not anchored"));
    expect(warning).toBeTruthy();
    expect(warning!.detail).toContain('"tracks"');
    expect(warning!.detail).not.toContain('"anchored"');
  }, 300_000);
});

describe("[3] bundle provenance", () => {
  it("packed dist embeds the commit and doctor reports it", async () => {
    const dir = await makeTempDir("p3-bundle");
    await fs.mkdir(path.join(dir, "workspace"), { recursive: true });
    const pack = spawnSync("npm run pack:cloud", { cwd: ROOT, shell: true, encoding: "utf8", timeout: 300_000 });
    expect(pack.status, `${pack.stdout}\n${pack.stderr}`).toBe(0);
    const head = spawnSync("git rev-parse HEAD", { cwd: ROOT, shell: true, encoding: "utf8" }).stdout.trim();
    const bundle = await fs.readFile(path.join(ROOT, "dist", "ultra.mjs"), "utf8");
    expect(bundle.slice(0, 200)).toContain(`ultra-bundle-commit: ${head}`);
    expect(await pathExists(path.join(ROOT, "dist", "ultra.mjs.map"))).toBe(true);
    const doctor = await runCli(dir, ["doctor", "--json"], 240_000);
    const json = JSON.parse(doctor.stdout.slice(doctor.stdout.indexOf("{"), doctor.stdout.lastIndexOf("}") + 1));
    expect(json.bundleCommit).toBe(head);
    expect(json.sourceMatchesBundle).toBe(true);
  }, 600_000);
});
