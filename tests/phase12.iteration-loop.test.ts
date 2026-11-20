import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UltraProject, type UltraProjectT } from "../core/schema.js";
import { buildProject, CACHE_VERSION } from "../core/orchestrator.js";
import { pathExists, sha1File } from "../core/util.js";
import { ffmpegOk, ffprobeJson, runBinary } from "../core/ffmpeg.js";
import { probeReference } from "../core/probe.js";
import { buildVisualPairs } from "../verifier/visual-diff.js";
import { validateAssets } from "../core/assets.js";
import { freeSpaceMb, tmpSpaceWarning, ultraTmpDir } from "../core/env.js";
import { browserCandidates, doctorSelectBrowser, resetBrowserDiscoveryCache } from "../core/cdp-browser.js";
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

describe("[2] ultraTmpDir precedence + low-space warning", () => {
  it("ULTRA_TMPDIR > <cwd>/workspace/.ultra-tmp > os.tmpdir()", async () => {
    const dir = await makeTempDir("p12-tmp");
    const originalCwd = process.cwd();
    const originalOverride = process.env.ULTRA_TMPDIR;
    try {
      const override = path.join(dir, "override");
      process.env.ULTRA_TMPDIR = override;
      expect(ultraTmpDir()).toBe(override);
      expect(await pathExists(override)).toBe(true);

      delete process.env.ULTRA_TMPDIR;
      process.chdir(dir);
      const expected = path.join(dir, "workspace", ".ultra-tmp");
      expect(ultraTmpDir()).toBe(expected);
      expect(await pathExists(expected)).toBe(true);
    } finally {
      process.chdir(originalCwd);
      if (originalOverride === undefined) delete process.env.ULTRA_TMPDIR;
      else process.env.ULTRA_TMPDIR = originalOverride;
    }
  });

  it("warns below 2 GB and stays silent above", async () => {
    expect(tmpSpaceWarning(512, "/tmp")).toContain("512 MB");
    expect(tmpSpaceWarning(2047, "/tmp")).toContain("2 GB");
    expect(tmpSpaceWarning(2048, "/tmp")).toBeNull();
    expect(tmpSpaceWarning(null, "/tmp")).toBeNull();
    expect(await freeSpaceMb(os.tmpdir())).not.toBeNull();
  });
});

describe("[1] browser discovery scans Playwright headless_shell and persists the working path", () => {
  it("finds a fake playwright cache chromium, test-launches it, and doctor reports full-cdp", async () => {
    const original = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      ULTRA_BROWSER_PATH: process.env.ULTRA_BROWSER_PATH,
      HYPERFRAMES_BROWSER_PATH: process.env.HYPERFRAMES_BROWSER_PATH,
      ULTRA_BROWSER_CACHE_ONLY: process.env.ULTRA_BROWSER_CACHE_ONLY,
    };
    try {
      resetBrowserDiscoveryCache();
      delete process.env.ULTRA_BROWSER_PATH;
      delete process.env.HYPERFRAMES_BROWSER_PATH;
      delete process.env.ULTRA_BROWSER_CACHE_ONLY;

      const dir = await makeTempDir("p12-browser");
      const fakeHome = path.join(dir, "home");
      const exeName = process.platform === "win32" ? "headless_shell.cmd" : "headless_shell";
      const fakePath = path.join(fakeHome, ".cache", "ms-playwright", "chromium-9999", "chrome-linux", exeName);
      await fs.mkdir(path.dirname(fakePath), { recursive: true });
      // A launcher stub is portable where copying a real chromium tree is not;
      // it must actually START and print the DevTools endpoint for the doctor
      // test-launch to accept it exactly like a Playwright headless_shell.
      if (process.platform === "win32") {
        await fs.writeFile(fakePath, "@echo off\r\necho DevTools listening on ws://127.0.0.1:9222/devtools/browser/fake 1>&2\r\nping -n 6 127.0.0.1 >nul\r\n", "utf8");
      } else {
        await fs.writeFile(fakePath, "#!/bin/sh\necho 'DevTools listening on ws://127.0.0.1:9222/devtools/browser/fake' >&2\nsleep 6\n", "utf8");
        await fs.chmod(fakePath, 0o755);
      }

      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      process.env.LOCALAPPDATA = path.join(fakeHome, "AppData", "Local");
      process.env.ULTRA_BROWSER_CACHE_ONLY = "1";
      resetBrowserDiscoveryCache();
      const candidates = browserCandidates();
      expect(candidates[0]?.executablePath).toBe(fakePath);
      expect(candidates[0]?.kind).toBe("playwright-cache");

      const selection = await doctorSelectBrowser();
      expect(selection.browser?.executablePath).toBe(fakePath);

      const cwd = path.join(dir, "cwd");
      await fs.mkdir(path.join(cwd, "workspace"), { recursive: true });
      const run = await runCli(cwd, ["doctor", "--json"], 240_000, {
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        LOCALAPPDATA: path.join(fakeHome, "AppData", "Local"),
        ULTRA_BROWSER_CACHE_ONLY: "1",
        ULTRA_BROWSER_PATH: "",
        HYPERFRAMES_BROWSER_PATH: "",
      });
      const json = JSON.parse(run.stdout.slice(run.stdout.indexOf("{"), run.stdout.lastIndexOf("}") + 1));
      expect(json.renderTier).toBe("full-cdp");
      expect(path.normalize(json.browser.executablePath).toLowerCase()).toBe(path.normalize(fakePath).toLowerCase());
      const state = JSON.parse(await fs.readFile(path.join(cwd, "workspace", "state.json"), "utf8"));
      expect(path.normalize(state.browserPath).toLowerCase()).toBe(path.normalize(fakePath).toLowerCase());
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetBrowserDiscoveryCache();
    }
  }, 300_000);
});

describe("[4] doctor pre-flights disk/fs/memory and build refuses oversized projects", () => {
  function fixture(durationSec = 1, width = 320, height = 180): UltraProjectT {
    return UltraProject.parse({
      meta: { title: "Preflight", sourceVideoPath: "reference.mp4", width, height, fps: 30, durationSec },
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

  it("doctor --json contains disk, fs and memory blocks (with a project estimate)", async () => {
    const dir = await makeTempDir("p12-preflight");
    await fs.mkdir(path.join(dir, "workspace"), { recursive: true });
    await fs.writeFile(path.join(dir, "workspace", "ultra.json"), JSON.stringify(fixture()), "utf8");
    const run = await runCli(dir, ["doctor", "--json"], 240_000);
    const json = JSON.parse(run.stdout.slice(run.stdout.indexOf("{"), run.stdout.lastIndexOf("}") + 1));
    expect(json.disk.tmpPath).toContain(".ultra-tmp");
    expect(typeof json.disk.tmpFreeMb).toBe("number");
    expect(typeof json.disk.workspaceFreeMb).toBe("number");
    expect(typeof json.fs.homeWritable).toBe("boolean");
    expect(typeof json.fs.cacheWritable).toBe("boolean");
    expect(json.fs.cacheWritable).toBe(true);
    expect(json.memory.totalMb).toBeGreaterThan(0);
    expect(json.memory.estimatedPeakMbForProject).toBeGreaterThanOrEqual(350);
  }, 300_000);

  it("refuses an oversized fixture before rendering", async () => {
    const dir = await makeTempDir("p12-oversize");
    await fs.mkdir(path.join(dir, "workspace"), { recursive: true });
    // 40000x40000 RGBA buffers → far above 80% of any agent VM's RAM.
    await fs.writeFile(path.join(dir, "workspace", "ultra.json"), JSON.stringify(fixture(1, 40000, 40000)), "utf8");
    const run = await runCli(dir, ["build"], 120_000);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("[preflight]");
    expect(run.stderr).toContain("estimated peak RAM");
    expect(run.stderr).toContain("ultra doctor --json");
  }, 300_000);
});

describe("[18] asset content similarity vs the reference segment", () => {
  function imageProject(): UltraProjectT {
    return UltraProject.parse({
      meta: { title: "Similarity", sourceVideoPath: "reference.mp4", width: 320, height: 180, fps: 30, durationSec: 2 },
      designTokens: {
        palette: PALETTE,
        fonts: { heading: "Ultra Display", body: "Ultra Sans", mono: "Ultra Mono" },
        grainOpacity: 0,
        antiSlopRules: ["palette only"],
      },
      colorGrade: {},
      audio: {},
      assets: [
        { id: "correct", type: "image", description: "red plate", prompt: "red", targetPath: "assets/red.png" },
        { id: "wrong", type: "image", description: "blue plate", prompt: "blue", targetPath: "assets/blue.png" },
        { id: "missing", type: "image", description: "unbuilt", prompt: "green", targetPath: "assets/green.png" },
      ],
      scenes: [
        {
          id: "s1",
          name: "S1",
          startSec: 0,
          endSec: 1,
          engine: "hyperframes",
          background: PALETTE.bg,
          layers: [
            { id: "l1", type: "image", assetId: "correct", x: 0, y: 0, width: 320, height: 180 },
            { id: "l3", type: "image", assetId: "missing", x: 0, y: 0, width: 40, height: 40 },
          ],
        },
        {
          id: "s2",
          name: "S2",
          startSec: 1,
          endSec: 2,
          engine: "hyperframes",
          background: PALETTE.bg,
          layers: [{ id: "l2", type: "image", assetId: "wrong", x: 0, y: 0, width: 320, height: 180 }],
        },
      ],
    });
  }

  it("flags a wrong-photo asset and passes a matching one (warn, never fail)", async () => {
    const dir = await makeTempDir("p18-similarity");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(path.join(workspace, "assets"), { recursive: true });
    await ffmpegOk(["-f", "lavfi", "-i", "color=c=0xd9484f:s=320x180:d=2:r=30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", path.join(workspace, "reference.mp4")]);
    await ffmpegOk(["-f", "lavfi", "-i", "color=c=0xd9484f:s=320x180", "-frames:v", "1", "-pix_fmt", "rgb24", path.join(workspace, "assets", "red.png")]);
    await ffmpegOk(["-f", "lavfi", "-i", "color=c=0x2c4a7c:s=320x180", "-frames:v", "1", "-pix_fmt", "rgb24", path.join(workspace, "assets", "blue.png")]);
    await ffmpegOk(["-f", "lavfi", "-i", "color=c=0x2e7d32:s=320x180", "-frames:v", "1", "-pix_fmt", "rgb24", path.join(workspace, "assets", "green.png")]);
    const project = imageProject();

    const result = await validateAssets(project, workspace);
    expect(result.ok).toBe(true); // similarity NEVER fails the gate
    const correct = result.checks.find((c) => c.id === "correct")!;
    const wrong = result.checks.find((c) => c.id === "wrong")!;
    expect(correct.similarity?.sceneId).toBe("s1");
    expect(correct.similarity?.ssimToRefSegment).toBeGreaterThan(0.8);
    expect(correct.similarity?.warnings).toHaveLength(0);
    expect(wrong.similarity?.warnings.length).toBeGreaterThan(0);
    expect(wrong.similarity?.warnings.join(" ")).toContain('"wrong"');
    // Flat solid plates keep structural SSIM high — the colour-histogram term is
    // what catches a wrong photograph here (real photos trip SSIM as well).
    expect(wrong.similarity?.histogramDistance ?? 0).toBeGreaterThan(0.35);
    expect(wrong.similarity?.warnings.join(" ")).toContain("histogram");
    expect(result.warnings.some((w) => w.includes('"wrong"'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('"correct"'))).toBe(false);

    const manifest = JSON.parse(await fs.readFile(path.join(workspace, "assets.manifest.json"), "utf8"));
    expect(manifest.assets.wrong.similarity.histogramDistance).toBeGreaterThan(0.35);

    // Missing image assets must carry the similarity target in asset-plan output.
    await fs.rm(path.join(workspace, "assets", "green.png"));
    const replan = await validateAssets(project, workspace);
    const todo = JSON.parse(await fs.readFile(path.join(workspace, "assets-todo.json"), "utf8"));
    const missing = todo.missing.find((m: any) => m.id === "missing");
    expect(missing.similarityTarget).toEqual({ sceneId: "s1", startSec: 0, endSec: 1 });
    expect(replan.ok).toBe(false);
  }, 300_000);
});

describe("[8] clone-feasibility warning on low-quality references", () => {
  it("flags a 736x414 @ 0.38 Mbps reference and leaves a clean 1080p one alone", async () => {
    const dir = await makeTempDir("p8-feasibility");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const low = path.join(dir, "low.mp4");
    await ffmpegOk([
      "-f", "lavfi", "-i", "testsrc2=size=736x414:rate=24:duration=2",
      "-c:v", "libx264", "-preset", "veryfast", "-b:v", "380k", "-maxrate", "380k", "-bufsize", "190k",
      "-pix_fmt", "yuv420p", low,
    ]);
    const clean = path.join(dir, "clean.mp4");
    await ffmpegOk([
      "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=2,noise=alls=25:allf=t",
      "-c:v", "libx264", "-preset", "veryfast", "-b:v", "18M", "-minrate", "18M", "-maxrate", "18M", "-bufsize", "2M",
      "-x264-params", "nal-hrd=cbr", "-pix_fmt", "yuv420p", clean,
    ]);

    const lowProbe = await runCli(dir, ["probe", "low.mp4"], 300_000);
    expect(lowProbe.code, lowProbe.stderr).toBe(0);
    expect(lowProbe.stdout).toContain("clone      score");
    expect(lowProbe.stdout).toContain("This reference cannot support exact cloning of fine detail — expect a native approximation, not a copy.");
    const lowJson = JSON.parse(await fs.readFile(path.join(workspace, "probe.json"), "utf8"));
    expect(lowJson.cloneFeasibility.score).toBeLessThan(55);
    expect(lowJson.cloneFeasibility.bitratePerPixel).toBeLessThan(0.1);
    expect(lowJson.cloneFeasibility.textLegibility === "poor" || lowJson.cloneFeasibility.textLegibility === "destroyed").toBe(true);
    expect(lowJson.cloneFeasibility.warnings.join(" ")).toContain("cannot support exact cloning");
    expect(typeof lowJson.containsRealRecording).toBe("boolean");

    const cleanWorkspace = path.join(dir, "clean-workspace");
    await fs.mkdir(cleanWorkspace, { recursive: true });
    const cleanProbe = await probeReference(clean, cleanWorkspace, {});
    expect(cleanProbe.cloneFeasibility).toBeTruthy();
    expect(cleanProbe.cloneFeasibility!.score).toBeGreaterThanOrEqual(55);
    expect(cleanProbe.cloneFeasibility!.textLegibility).toBe("ok");
    expect(cleanProbe.cloneFeasibility!.warnings.join(" ")).not.toContain("cannot support exact cloning");
  }, 600_000);
});

async function writeSolidScenes(workspace: string, colors: string[]): Promise<void> {
  await fs.mkdir(path.join(workspace, "scenes"), { recursive: true });
  for (let i = 0; i < colors.length; i += 1) {
    await fs.writeFile(path.join(workspace, "scenes", `s${i + 1}.html`), solidHtml(colors[i] as string), "utf8");
  }
}

function multiSceneProject(count: number, durationSec: number, fps: number, width = 320, height = 180): UltraProjectT {
  const per = durationSec / count;
  const scenes = Array.from({ length: count }, (_, i) => {
    const startSec = roundTo(i * per);
    const endSec = i === count - 1 ? roundTo(durationSec) : roundTo((i + 1) * per);
    return {
      id: `s${i + 1}`,
      name: `S${i + 1}`,
      startSec,
      endSec,
      engine: "hyperframes" as const,
      background: PALETTE.bg,
      customHtmlFile: `s${i + 1}.html`,
    };
  });
  return UltraProject.parse({
    meta: { title: "Multi", sourceVideoPath: "reference.mp4", width, height, fps, durationSec },
    designTokens: {
      palette: PALETTE,
      fonts: { heading: "Ultra Display", body: "Ultra Sans", mono: "Ultra Mono" },
      grainOpacity: 0,
      antiSlopRules: ["palette only"],
    },
    colorGrade: {},
    audio: {},
    assets: [],
    scenes,
  });
}

function roundTo(value: number): number {
  return Math.round(value * 1000) / 1000;
}

async function centerPixel(png: string, x = 80, y = 44): Promise<{ r: number; g: number; b: number }> {
  // yuv420p requires even crop dimensions/offsets → sample a 2x2 block.
  const evenX = x % 2 === 0 ? x : x - 1;
  const evenY = y % 2 === 0 ? y : y - 1;
  const result = await runBinary("ffmpeg", ["-v", "error", "-i", png, "-vf", `crop=2:2:${evenX}:${evenY}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return { r: result.stdout[0] as number, g: result.stdout[1] as number, b: result.stdout[2] as number };
}

describe("[21] build --scene renders one scene only + [22] always-on contact sheet", () => {
  it("renders only the target scene (cold cache), then adds 1s handles from the full draft", async () => {
    const dir = await makeTempDir("p21-scene");
    const workspace = path.join(dir, "workspace");
    await writeSolidScenes(workspace, ["#101820", "#d9484f", "#2c4a7c", "#8ecae6"]);
    await fs.writeFile(path.join(workspace, "ultra.json"), JSON.stringify(multiSceneProject(4, 4, 10)), "utf8");

    const started = Date.now();
    const first = await runCli(dir, ["build", "--scene", "s2"], 300_000);
    expect(first.code, first.stderr).toBe(0);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, "build", "scene-s2-manifest.json"), "utf8"));
    expect(manifest.renderedScenes).toEqual(["s2"]);
    expect(manifest.cache.misses).toBe(1);
    expect(manifest.cache.hits).toBe(0);
    expect(manifest.handles).toEqual([]); // no draft yet → scene alone
    expect(await pathExists(path.join(dir, "build", "draft.mp4"))).toBe(false);

    const sheet = path.join(dir, "build", "contact-sheet.png");
    expect(await pathExists(sheet)).toBe(true);
    expect((await fs.stat(sheet)).mtimeMs).toBeGreaterThan(started - 2_000);
    const pixel = await centerPixel(path.join(dir, "build", "scene-s2-preview.mp4"), 160, 90);
    expect(pixel.r).toBeGreaterThan(120); // s2 is red

    // Full build once, then the scene preview must be a cache hit + 1s handles.
    const full = await runCli(dir, ["build"], 900_000);
    expect(full.code, full.stderr).toBe(0);
    const second = await runCli(dir, ["build", "--scene", "s2"], 300_000);
    expect(second.code, second.stderr).toBe(0);
    const manifest2 = JSON.parse(await fs.readFile(path.join(dir, "build", "scene-s2-manifest.json"), "utf8"));
    expect(manifest2.cache.hits).toBe(1);
    expect(manifest2.cache.misses).toBe(0);
    expect(manifest2.handles.map((h: any) => h.side).sort()).toEqual(["after", "before"]);
    expect(manifest2.durationSec).toBeGreaterThan(2.5);

    const verify = await runCli(dir, ["verify", "--scene", "s2", "workspace/s2-local.mp4"], 120_000);
    // No reference fixture here: verify fails on the missing reference, not on rendering.
    expect(verify.code).toBe(1);
    expect(verify.stderr).toContain("Reference video not found");
  }, 900_000);
});

describe("[20] ultra preview — frame + range without a full build", () => {
  it("renders a single side-by-side frame in a fraction of a full build and never writes a draft", async () => {
    const dir = await makeTempDir("p20-preview");
    const workspace = path.join(dir, "workspace");
    await writeSolidScenes(workspace, ["#101820", "#d9484f", "#2c4a7c"]);
    const project = multiSceneProject(3, 508 / 30, 30, 160, 90);
    await fs.writeFile(path.join(workspace, "ultra.json"), JSON.stringify(project), "utf8");
    await makeColorClip(path.join(workspace, "reference.mp4"), 508 / 30, "0xd9484f", 160, 90, 30);

    // Warm the OS/browser caches with one preview so the ratio measures scene
    // work, not Chrome cold start (which both commands pay once).
    const warm = await runCli(dir, ["preview", "--frame", "0"], 300_000);
    expect(warm.code, warm.stderr).toBe(0);

    const fullStart = Date.now();
    const full = await runCli(dir, ["build"], 1_800_000);
    expect(full.code, full.stderr).toBe(0);
    const fullMs = Date.now() - fullStart;
    expect(await pathExists(path.join(dir, "build", "draft.mp4"))).toBe(true);

    const previewStart = Date.now();
    const preview = await runCli(dir, ["preview", "--frame", "300"], 300_000);
    expect(preview.code, preview.stderr).toBe(0);
    const previewMs = Date.now() - previewStart;
    expect(preview.stdout).toContain("frame-300.png");
    expect(await pathExists(path.join(dir, "build", "preview", "frame-300.png"))).toBe(true);
    expect(await pathExists(path.join(dir, "build", "preview", "frame-300-diff.png"))).toBe(true);
    expect(previewMs).toBeLessThan(fullMs * 0.25);
    // The draft from the earlier full build is untouched (no surprise rebuild).
    expect(preview.stdout).toContain("no full build performed");
  }, 1_800_000);

  it("renders a frame range to build/preview/range.mp4 and refreshes the contact sheet", async () => {
    const dir = await makeTempDir("p20-range");
    const workspace = path.join(dir, "workspace");
    await writeSolidScenes(workspace, ["#101820", "#d9484f"]);
    await fs.writeFile(path.join(workspace, "ultra.json"), JSON.stringify(multiSceneProject(2, 2, 10)), "utf8");
    const started = Date.now();
    const run = await runCli(dir, ["preview", "--from", "5", "--to", "14"], 300_000);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("10 frames");
    const range = path.join(dir, "build", "preview", "range.mp4");
    expect(await pathExists(range)).toBe(true);
    const probe = await ffprobeJson(range);
    const video = probe.streams.find((s: any) => s.codec_type === "video");
    expect(Number(video.nb_frames)).toBe(10);
    const sheet = path.join(dir, "build", "contact-sheet.png");
    expect(await pathExists(sheet)).toBe(true);
    expect((await fs.stat(sheet)).mtimeMs).toBeGreaterThan(started - 2_000);
    // Tier limitation is explicit, never a silent full build.
    const blocked = await runCli(dir, ["preview", "--frame", "1"], 120_000, { ULTRA_NO_BROWSER: "1" });
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain("requires the full-cdp render tier");
  }, 300_000);
});
