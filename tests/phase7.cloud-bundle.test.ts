import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ffprobeJson } from "../core/ffmpeg.js";
import { UltraProject } from "../core/schema.js";
import { writeJsonAtomic } from "../core/util.js";
import { extractZip } from "./zip-extract.js";
import { PALETTE, ROOT, makeAudio, makeReferenceVideo, makeTempDir, writeBaseAssets } from "./helpers.js";

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

function runNode(cwd: string, args: string[], timeoutMs = 900_000): Promise<CliRun> {
  return new Promise<CliRun>((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`isolated node run timed out: ${args.join(" ")}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

const BESPOKE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"/>
<style>
  .bespoke-wrap { position:absolute; inset:0; display:flex; flex-direction:column; align-items:flex-start; justify-content:center; padding:0 120px; gap:24px; }
  .kicker { font-family:'Segoe UI',sans-serif; font-size:26px; letter-spacing:.22em; text-transform:uppercase; color:#8ecae6; opacity:.92; }
  .big { font-family:'Segoe UI',sans-serif; font-weight:800; font-size:110px; line-height:1; letter-spacing:-.03em; color:#f2f2f0; transform-origin:left center; }
  .meter { margin-top:24px; width:520px; height:12px; border-radius:6px; background:rgba(242,242,240,.12); overflow:hidden; }
  .meter i { display:block; height:100%; width:100%; background:#ffb703; transform-origin:left center; transform:scaleX(.1); }
  .badge { position:absolute; right:120px; top:112px; font-family:'Consolas',monospace; font-size:20px; color:#8ecae6; opacity:.8; }
</style></head>
<body>
  <div class="bespoke-wrap">
    <div class="kicker" data-audit="text">Bespoke HTML scene</div>
    <div class="big" id="b-big" data-audit="text">HAND-BUILT</div>
    <div class="meter"><i id="b-bar"></i></div>
  </div>
  <div class="badge" data-audit="text" id="b-audio">AUDIO ENV</div>
  <script>
    (function () {
      var big = document.getElementById("b-big");
      var bar = document.getElementById("b-bar");
      var badge = document.getElementById("b-audio");
      window.ultraRender = function (frame, fps, t, progress, audio) {
        var ease = window.UltraEase || { easeOutExpo: function (x) { return x; } };
        var e = ease.easeOutExpo(progress);
        big.style.transform = "translateY(" + ((1 - e) * 90 + Math.sin(t * 3.1) * 6).toFixed(2) + "px)";
        big.style.opacity = String(Math.min(1, 0.2 + e));
        var env = 0.35;
        if (audio && audio.frames && audio.frames.length) {
          var idx = Math.min(audio.frames.length - 1, Math.max(0, Math.round(t * (audio.fps || 30))));
          env = audio.frames[idx];
          badge.textContent = "AUDIO " + String(audio.frames.length) + "f";
        }
        bar.style.transform = "scaleX(" + (0.3 + env * 0.35 + Math.abs(Math.sin(t * 2.3)) * 0.35).toFixed(3) + ")";
      };
    })();
  </script>
</body></html>`;

describe("phase 7 — isolated zero-install cloud bundle", () => {
  it("packs the zip and runs probe → build → verify → render with ZERO node_modules and no npm install", async () => {
    // 1) Pack via the real npm script.
    const pack = await new Promise<{ code: number; output: string }>((resolvePromise, reject) => {
      const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "pack:cloud"], {
        cwd: ROOT,
        shell: process.platform === "win32",
        windowsHide: true,
      });
      let output = "";
      child.stdout.on("data", (c: Buffer) => (output += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (output += c.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) => resolvePromise({ code: code ?? -1, output }));
    });
    expect(pack.code, pack.output).toBe(0);
    expect(pack.output).toContain("pack:cloud →");

    const zipPath = path.join(ROOT, "dist", "ultra-workflow-cloud.zip");
    const zipStat = await fs.stat(zipPath);
    expect(zipStat.size).toBeLessThan(3 * 1024 * 1024);

    // 2) Extract into a brand-new OS temp dir with zero node_modules.
    const isolated = await fs.mkdtemp(path.join(os.tmpdir(), "ultra-cloud-"));
    const { entries } = await extractZip(zipPath, isolated);
    expect(entries.every((e) => e.crcOk), "zip CRC integrity").toBe(true);
    const names = new Set(entries.map((e) => e.name));
    for (const required of [
      "ultra.mjs",
      "ultra",
      "ultra.cmd",
      "package.json",
      "assets/vendor/three.module.min.js",
      "assets/vendor/ultra-motion.js",
      "engines/blender/render_scene.py",
      "SKILL.md",
      "CHAT_START_PROMPT.txt",
      "SPEC.md",
      "README.md",
    ]) {
      expect(names.has(required), `zip contains ${required}`).toBe(true);
    }
    expect([...names].some((n) => n.includes("node_modules"))).toBe(false);
    await expect(fs.stat(path.join(isolated, "node_modules"))).rejects.toThrow();

    // 3) Fixture: reference, assets, custom scene, audio envelope.
    const workspace = path.join(isolated, "workspace");
    await writeBaseAssets(workspace);
    await fs.mkdir(path.join(workspace, "scenes"), { recursive: true });
    await fs.writeFile(path.join(workspace, "scenes", "bespoke.html"), BESPOKE_HTML, "utf8");
    await makeReferenceVideo(path.join(isolated, "reference.mp4"));
    await makeAudio(path.join(workspace, "assets", "music.wav"), 4.05, 220);

    const project = UltraProject.parse({
      meta: {
        title: "Cloud bundle proof",
        sourceVideoPath: "reference.mp4",
        width: 1280,
        height: 720,
        fps: 30,
        durationSec: 4,
      },
      designTokens: {
        palette: PALETTE,
        fonts: { heading: "Segoe UI", body: "Segoe UI", mono: "Consolas" },
        grainOpacity: 0.05,
        antiSlopRules: [
          "No stock template gradients or filler iconography",
          "Only palette colors may appear",
          "All motion is keyframed — stutterEvents must be 0",
        ],
      },
      colorGrade: { exposure: 0, contrast: 0.04, saturation: 1.01, temperature: 0.04, vignette: 0.1 },
      audio: {
        targetLufs: -14,
        musicAssetId: "music",
        duckingDb: -12,
        sfxCues: [{ assetId: "hit", atSec: 1, gainDb: -6 }],
      },
      assets: [
        { id: "music", type: "music", description: "bed", prompt: "pulse", durationSec: 4, targetPath: "assets/music.wav" },
        { id: "hit", type: "sfx", description: "impact", prompt: "impact", durationSec: 0.4, targetPath: "assets/hit.wav" },
        { id: "graph", type: "3d_graph", description: "overlay", prompt: "torus", targetPath: "assets/scene_graph.json" },
      ],
      scenes: [
        {
          id: "bespoke",
          name: "Bespoke",
          startSec: 0,
          endSec: 1.5,
          engine: "hyperframes",
          background: PALETTE.bg,
          customHtmlFile: "bespoke.html",
          transitionIn: { type: "none", durationSec: 0 },
        },
        {
          id: "vectors",
          name: "Vector choreography",
          startSec: 1.5,
          endSec: 2.7,
          engine: "revideo",
          background: PALETTE.bg,
          transitionIn: { type: "fade", durationSec: 0.2 },
          enginePayload: { sceneType: "vectors", title: "SIGNAL", values: [0.2, 0.5, 0.35, 0.8], labels: ["A", "B", "C", "D"] },
        },
        {
          id: "vfx",
          name: "3D overlay",
          startSec: 0.8,
          endSec: 2.3,
          engine: "blender",
          alpha: true,
          overlayOfSceneId: "bespoke",
          background: "transparent",
          transitionIn: { type: "none", durationSec: 0 },
          enginePayload: { sceneGraphAssetId: "graph" },
        },
        {
          id: "outro",
          name: "Outro",
          startSec: 2.7,
          endSec: 4,
          engine: "hyperframes",
          background: PALETTE.bg,
          transitionIn: { type: "fade", durationSec: 0.2 },
          layers: [{ id: "rule", type: "shape", color: PALETTE.accent, x: 520, y: 372, width: 240, height: 10, radius: 5 }],
          textElements: [
            {
              id: "ship",
              text: "SHIP IT",
              font: "heading",
              sizePx: 96,
              color: PALETTE.accent,
              x: 440,
              y: 260,
              width: 400,
              align: "center",
              weight: 900,
              letterSpacingPx: 2,
              lineHeight: 1,
              uppercase: true,
            },
          ],
          keyframes: [
            {
              target: "ship",
              property: "scale",
              keyframes: [
                { atSec: 0, value: 0.92, ease: "easeOutBack" },
                { atSec: 0.35, value: 1, ease: "linear" },
              ],
            },
          ],
        },
      ],
    });
    await writeJsonAtomic(path.join(workspace, "ultra.json"), project);

    // 4) Zero-install CLI flow inside the isolated folder.
    const ultra = (args: string[]) => runNode(isolated, ["ultra.mjs", ...args]);

    const doctor = await ultra(["doctor", "--json"]);
    expect(doctor.code, doctor.stderr).toBe(0);
    const doctorJson = JSON.parse(doctor.stdout);
    expect(doctorJson.ok).toBe(true);
    expect(doctorJson.ffmpeg.available).toBe(true);
    expect(doctorJson.browser.available).toBe(true);
    expect(doctorJson.remotion.installed).toBe(false);
    expect(doctorJson.revideo.installed).toBe(false);

    const probe = await ultra(["probe", "reference.mp4"]);
    expect(probe.code, probe.stderr).toBe(0);
    const envelope = JSON.parse(await fs.readFile(path.join(workspace, "audio-envelope.json"), "utf8"));
    expect(envelope.frames.length).toBe(120);
    expect(envelope.beatsSec.length).toBeGreaterThan(0);
    const probeJson = JSON.parse(await fs.readFile(path.join(workspace, "probe.json"), "utf8"));
    expect(probeJson.scenes.length).toBeGreaterThan(0);
    expect(probeJson.scenes[0].colors.length).toBeGreaterThan(0);
    expect(probeJson.contactSheets.length).toBeGreaterThan(0);

    const validateSpec = await ultra(["validate-spec"]);
    expect(validateSpec.code, validateSpec.stderr).toBe(0);
    const assetPlan = await ultra(["asset-plan"]);
    expect(assetPlan.code, assetPlan.stderr).toBe(0);
    const validateAssets = await ultra(["validate-assets"]);
    expect(validateAssets.code, validateAssets.stderr).toBe(0);

    const build = await ultra(["build"]);
    expect(build.code, build.stderr).toBe(0);
    const manifest = JSON.parse(await fs.readFile(path.join(isolated, "build", "build-manifest.json"), "utf8"));
    const byId = Object.fromEntries(manifest.scenes.map((s: any) => [s.sceneId, s]));
    expect(byId.bespoke).toBeTruthy();
    expect(byId.bespoke.engineUsed).toBe("hyperframes");
    expect(byId.vectors.requestedEngine).toBe("revideo");
    expect(byId.vectors.engineUsed).toBe("hyperframes");
    expect(byId.vectors.fallback).toBe(true);
    expect(byId.vfx.alpha).toBe(true);
    expect(byId.vfx.file.endsWith(".mov")).toBe(true);

    const verify = await ultra(["verify", "reference.mp4"]);
    expect(verify.code, `${verify.stdout}\n${verify.stderr}`).toBe(0);
    const report = JSON.parse(await fs.readFile(path.join(isolated, "build", "verify-report.json"), "utf8"));
    expect(report.pass).toBe(true);
    expect(report.quantitative.stutterEvents).toBe(0);
    expect(report.quantitative.jitterOk).toBe(true);
    expect(report.lint.pass).toBe(true);
    expect(report.lint.criticalDefectCount).toBe(0);
    expect(report.visualPairs.length).toBeGreaterThanOrEqual(5);
    expect(report.sceneSimilarity.length).toBe(report.visualPairs.length);
    expect(report.sceneSimilarity.some((s: any) => typeof s.ssim === "number")).toBe(true);
    const bespokePairs = report.visualPairs.filter((p: any) => p.sceneId === "bespoke");
    expect(bespokePairs.length).toBeGreaterThan(0);

    const render = await ultra(["render"]);
    expect(render.code, render.stderr).toBe(0);
    const finalFile = path.join(isolated, "build", "ultra-final.mp4");
    const finalProbe = await ffprobeJson(finalFile);
    const video = finalProbe.streams.find((s: any) => s.codec_type === "video");
    const audio = finalProbe.streams.find((s: any) => s.codec_type === "audio");
    expect(video).toBeTruthy();
    expect(audio).toBeTruthy();
    expect(video.pix_fmt).toBe("yuv420p");
    expect(Math.abs(Number(finalProbe.format.duration) - 4)).toBeLessThanOrEqual(0.1);
    expect(Number(video.nb_frames)).toBeGreaterThanOrEqual(118);
    expect(Number(video.nb_frames)).toBeLessThanOrEqual(122);

    // No install happened anywhere in the isolated folder.
    await expect(fs.stat(path.join(isolated, "node_modules"))).rejects.toThrow();
    console.log(`[phase7] isolated cloud run OK · dir=${isolated} · zip=${(zipStat.size / 1024).toFixed(1)} KiB`);
  }, 1_500_000);
});
