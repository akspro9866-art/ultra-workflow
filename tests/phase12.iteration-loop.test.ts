import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UltraProject, type UltraProjectT } from "../core/schema.js";
import { buildProject, CACHE_VERSION } from "../core/orchestrator.js";
import { sha1File } from "../core/util.js";
import { ffmpegOk } from "../core/ffmpeg.js";
import { buildVisualPairs } from "../verifier/visual-diff.js";
import { PALETTE, makeColorClip, makeTempDir, runCli } from "./helpers.js";

/**
 * phase 12 — Muse iteration-loop fixes.
 * [19] customHtmlFile cache hashing; [24] duration stream validation;
 * [20] preview; [21] build --scene / verify --scene; [22] contact sheets;
 * [1] browser discovery; [2] ultraTmpDir; [4] doctor pre-flight.
 */

function customSceneProject(): UltraProjectT {
  return UltraProject.parse({
    meta: {
      title: "Cache fixture",
      sourceVideoPath: "reference.mp4",
      width: 320,
      height: 180,
      fps: 10,
      durationSec: 2,
    },
    designTokens: {
      palette: PALETTE,
      fonts: { heading: "Ultra Display", body: "Ultra Sans", mono: "Ultra Mono" },
      grainOpacity: 0,
      antiSlopRules: ["palette only"],
    },
    colorGrade: {},
    audio: {},
    assets: [],
    scenes: [
      {
        id: "scene-a",
        name: "Scene A",
        startSec: 0,
        endSec: 1,
        engine: "hyperframes",
        background: PALETTE.bg,
        customHtmlFile: "a.html",
      },
      {
        id: "scene-b",
        name: "Scene B",
        startSec: 1,
        endSec: 2,
        engine: "hyperframes",
        background: PALETTE.bg,
        customHtmlFile: "b.html",
      },
    ],
  });
}

function solidHtml(color: string, nonce = ""): string {
  return `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:${color}}</style></head><body><!--${nonce}--></body></html>`;
}

describe("[19] customHtmlFile contents are hashed into the cache key", () => {
  it("editing only the HTML file invalidates that scene, and an unrelated edit does not", async () => {
    const dir = await makeTempDir("p12-cache");
    const workspace = path.join(dir, "workspace");
    const buildDir = path.join(dir, "build");
    await fs.mkdir(path.join(workspace, "scenes"), { recursive: true });
    const project = customSceneProject();
    const projectFile = path.join(workspace, "ultra.json");
    await fs.writeFile(projectFile, JSON.stringify(project, null, 2), "utf8");
    await fs.writeFile(path.join(workspace, "scenes", "a.html"), solidHtml("#101820", path.basename(dir, "utf8")), "utf8");
    await fs.writeFile(path.join(workspace, "scenes", "b.html"), solidHtml("#2c4a7c", path.basename(dir)), "utf8");

    const first = await buildProject({ project, workspace, buildDir });
    expect(first.scenes.every((s) => !s.cached)).toBe(true);
    expect(first.version).toBe(CACHE_VERSION);
    const bytesA1 = await sha1File(path.join(buildDir, "scenes", "scene-a.mp4"));

    // Edit ONLY the scene HTML (ultra.json untouched).
    await fs.writeFile(path.join(workspace, "scenes", "a.html"), solidHtml("#d9484f", path.basename(dir)), "utf8");
    const second = await buildProject({ project, workspace, buildDir });
    const sceneA = second.scenes.find((s) => s.sceneId === "scene-a")!;
    const sceneB = second.scenes.find((s) => s.sceneId === "scene-b")!;
    expect(sceneA.cached).toBe(false);
    expect(sceneB.cached).toBe(true);
    const bytesA2 = await sha1File(path.join(buildDir, "scenes", "scene-a.mp4"));
    expect(bytesA2).not.toBe(bytesA1);

    // Editing the OTHER scene's HTML must not invalidate scene-a.
    await fs.writeFile(path.join(workspace, "scenes", "b.html"), solidHtml("#8ecae6", path.basename(dir)), "utf8");
    const third = await buildProject({ project, workspace, buildDir });
    expect(third.scenes.find((s) => s.sceneId === "scene-a")!.cached).toBe(true);
    expect(third.scenes.find((s) => s.sceneId === "scene-b")!.cached).toBe(false);
  }, 600_000);

  it("inline customCode is hashed through the scene JSON (no double implementation)", async () => {
    const dir = await makeTempDir("p12-inline");
    const workspace = path.join(dir, "workspace");
    const buildDir = path.join(dir, "build");
    await fs.mkdir(workspace, { recursive: true });
    const project = UltraProject.parse({
      meta: { title: "Inline", sourceVideoPath: "reference.mp4", width: 320, height: 180, fps: 10, durationSec: 1 },
      designTokens: {
        palette: PALETTE,
        fonts: { heading: "Ultra Display", body: "Ultra Sans", mono: "Ultra Mono" },
        grainOpacity: 0,
        antiSlopRules: ["palette only"],
      },
      colorGrade: {},
      audio: {},
      assets: [],
      scenes: [
        {
          id: "inline",
          name: "Inline",
          startSec: 0,
          endSec: 1,
          engine: "hyperframes",
          customCode: { html: "<div id='dot'></div>", css: "body{margin:0;background:#101820}", js: `window.x=1;/*${path.basename(dir)}*/` },
        },
      ],
    });
    const first = await buildProject({ project, workspace, buildDir });
    expect(first.scenes[0]!.cached).toBe(false);
    const edited = { ...project, scenes: [{ ...project.scenes[0]!, customCode: { ...project.scenes[0]!.customCode!, js: `window.x=2;/*${path.basename(dir)}*/` } }] };
    const second = await buildProject({ project: edited, workspace, buildDir });
    expect(second.scenes[0]!.cached).toBe(false);
  }, 300_000);
});

describe("[24] meta.durationSec must match the reference VIDEO stream", () => {
  function durationProject(durationSec: number): UltraProjectT {
    return UltraProject.parse({
      meta: { title: "Duration", sourceVideoPath: "reference.mp4", width: 320, height: 180, fps: 30, durationSec },
      designTokens: {
        palette: PALETTE,
        fonts: { heading: "Ultra Display", body: "Ultra Sans", mono: "Ultra Mono" },
        grainOpacity: 0,
        antiSlopRules: ["palette only"],
      },
      colorGrade: {},
      audio: {},
      assets: [],
      scenes: [{ id: "only", name: "Only", startSec: 0, endSec: durationSec, engine: "hyperframes", background: PALETTE.bg }],
    });
  }

  it("fails immediately when durationSec is the audio/container length, and passes when it is the video length", async () => {
    const dir = await makeTempDir("p24-duration");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    // 2.0s video + 2.4s audio → container/format duration is 2.4s.
    await ffmpegOk([
      "-f", "lavfi", "-i", "color=c=0x101820:s=320x180:d=2:r=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2.4",
      "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
      path.join(dir, "reference.mp4"),
    ]);

    await fs.writeFile(path.join(workspace, "ultra.json"), JSON.stringify(durationProject(2.4), null, 2), "utf8");
    const bad = await runCli(dir, ["validate-spec"], 120_000);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("VIDEO stream");
    expect(bad.stderr).toContain("2.400s");
    expect(bad.stderr).toContain("2.000s");
    expect(bad.stderr).toContain("audio stream 2.400s");

    await fs.writeFile(path.join(workspace, "ultra.json"), JSON.stringify(durationProject(2), null, 2), "utf8");
    const good = await runCli(dir, ["validate-spec"], 120_000);
    expect(good.code, good.stderr).toBe(0);
    expect(good.stdout).toContain("video stream 2.000s");
  }, 300_000);

  it("visual-diff clamps every sample to the measured draft duration (last pair is in-range)", async () => {
    const dir = await makeTempDir("p24-clamp");
    const reference = path.join(dir, "reference.mp4");
    const draft = path.join(dir, "draft.mp4");
    await makeColorClip(reference, 2, "0x101820", 320, 180, 30);
    // Draft is 0.4s SHORTER than the spec claims (the real Muse failure mode).
    await makeColorClip(draft, 1.6, "0x101820", 320, 180, 30);
    const project = durationProject(2);
    const pairs = await buildVisualPairs({
      reference,
      draft,
      project,
      outDir: path.join(dir, "audit-frames"),
      probe: null,
      maxPairs: 6,
    });
    expect(pairs.length).toBeGreaterThan(0);
    for (const pair of pairs) {
      expect(pair.timestampSec).toBeLessThanOrEqual(1.6);
      const stat = await fs.stat(pair.path);
      expect(stat.size).toBeGreaterThan(1000);
    }
  }, 300_000);
});
