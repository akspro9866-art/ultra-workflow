import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffprobeJson, ffmpegOk } from "../core/ffmpeg.js";
import { writeJsonAtomic } from "../core/util.js";
import { fullFixtureProject, makeReferenceVideo, makeTempDir, runCli, writeBaseAssets } from "./helpers.js";

describe("phase 6 — verify → break → patch → rebuild → verify → render", () => {
  let dir = "";
  let workspace = "";
  let reference = "";
  const project = fullFixtureProject();
  const headline = project.scenes[0]!.textElements.find((t) => t.id === "headline")!;
  const sub = project.scenes[0]!.textElements.find((t) => t.id === "sub")!;

  beforeAll(async () => {
    dir = await makeTempDir("p6-flow");
    workspace = path.join(dir, "workspace");
    reference = path.join(dir, "reference.mp4");
    await writeBaseAssets(workspace);
    await makeReferenceVideo(reference);
    await writeJsonAtomic(path.join(workspace, "ultra.json"), project);

    const probe = await runCli(dir, ["probe", "reference.mp4"], 300_000);
    expect(probe.code, probe.stderr).toBe(0);
    const build = await runCli(dir, ["build"], 900_000);
    expect(build.code, build.stderr).toBe(0);
    const verify = await runCli(dir, ["verify", "reference.mp4"], 900_000);
    expect(verify.code, `${verify.stdout}\n${verify.stderr}`).toBe(0);
  }, 1_500_000);

  it("initial verify passes with quantitative metrics, lint, labeled pairs and a rubric template", async () => {
    const report = JSON.parse(await fs.readFile(path.join(dir, "build", "verify-report.json"), "utf8"));
    expect(report.pass).toBe(true);
    expect(report.quantitative.pass).toBe(true);
    expect(report.quantitative.durationOk).toBe(true);
    expect(report.quantitative.fpsOk).toBe(true);
    expect(report.quantitative.cfrOk).toBe(true);
    expect(report.lint.pass).toBe(true);
    expect(report.lint.criticalDefectCount).toBe(0);

    expect(report.visualPairs.length).toBeGreaterThanOrEqual(5);
    for (const pair of report.visualPairs) {
      const stat = await fs.stat(pair.path);
      expect(stat.size).toBeGreaterThan(10_000);
      expect(path.basename(pair.path)).toMatch(/^pair_\d{2}\.png$/);
    }

    expect(report.rubric.categories).toHaveLength(5);
    expect(report.rubric.passThreshold).toBe(90);
    for (const category of report.rubric.categories) {
      expect(category.maxPoints).toBe(20);
      expect(category.items).toHaveLength(4);
    }
  }, 120_000);

  it("intentionally breaking a scene (off-palette color + clipped text) makes verify fail with those defects", async () => {
    const brokenElements = [{ ...headline, color: "#ff0000", x: 2000 }, { ...sub }];
    await writeJsonAtomic(path.join(workspace, "break.json"), {
      patches: [{ sceneId: "intro", reason: "phase6 intentional break", changes: { textElements: brokenElements } }],
    });

    const patch = await runCli(dir, ["patch", "workspace/break.json"], 120_000);
    expect(patch.code, patch.stderr).toBe(0);
    expect(patch.stdout).toContain("invalidated");

    const build = await runCli(dir, ["build"], 900_000);
    expect(build.code, build.stderr).toBe(0);

    const verify = await runCli(dir, ["verify", "reference.mp4"], 900_000);
    expect(verify.code).toBe(1);

    const report = JSON.parse(await fs.readFile(path.join(dir, "build", "verify-report.json"), "utf8"));
    expect(report.pass).toBe(false);
    expect(report.lint.pass).toBe(false);
    expect(report.lint.criticalDefectCount).toBeGreaterThan(0);
    const categories = new Set(
      report.lint.scenes.flatMap((s: any) => s.defects.map((d: any) => d.category)),
    );
    expect(categories.has("palette")).toBe(true);
    expect(categories.has("clip")).toBe(true);
    const introDefects = report.lint.scenes.find((s: any) => s.sceneId === "intro").defects;
    expect(introDefects.some((d: any) => d.category === "palette" && d.detail.includes("#ff0000"))).toBe(true);
  }, 1_000_000);

  it("applying the fix patch rebuilds, re-verifies clean, and renders the final broadcast MP4", async () => {
    await writeJsonAtomic(path.join(workspace, "fix.json"), {
      patches: [{ sceneId: "intro", reason: "restore palette + layout", changes: { textElements: [headline, sub] } }],
    });
    const patch = await runCli(dir, ["patch", "workspace/fix.json"], 120_000);
    expect(patch.code, patch.stderr).toBe(0);

    const build = await runCli(dir, ["build"], 900_000);
    expect(build.code, build.stderr).toBe(0);
    const verify = await runCli(dir, ["verify", "reference.mp4"], 900_000);
    expect(verify.code, `${verify.stdout}\n${verify.stderr}`).toBe(0);

    const report = JSON.parse(await fs.readFile(path.join(dir, "build", "verify-report.json"), "utf8"));
    expect(report.pass).toBe(true);

    const render = await runCli(dir, ["render"], 900_000);
    expect(render.code, render.stderr).toBe(0);

    const finalFile = path.join(dir, "build", "ultra-final.mp4");
    const stat = await fs.stat(finalFile);
    expect(stat.size).toBeGreaterThan(100_000);
    const probe = await ffprobeJson(finalFile);
    const video = probe.streams.find((s: any) => s.codec_type === "video");
    const audio = probe.streams.find((s: any) => s.codec_type === "audio");
    expect(video).toBeTruthy();
    expect(audio).toBeTruthy();
    expect(Math.abs(Number(probe.format.duration) - 4)).toBeLessThanOrEqual(0.1);
    expect(Number(video.width)).toBe(1280);
    expect(Number(video.height)).toBe(720);
    expect(video.pix_fmt).toBe("yuv420p");

    // Decode the whole file to prove it is playable (no corrupt frames).
    await ffmpegOk(["-v", "error", "-i", finalFile, "-f", "null", "-"], { timeoutMs: 120_000 });
  }, 1_200_000);
});

afterAll(async () => {
  // Temp dirs are kept for post-mortem inspection under tmp/tests/.
});
