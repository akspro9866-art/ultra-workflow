import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProbeResult } from "../core/schema.js";
import { makeReferenceVideo, makeTempDir, runCli } from "./helpers.js";

describe("phase 1 — probe + schema + doctor", () => {
  it("doctor --json emits a valid environment report", async () => {
    const dir = await makeTempDir("p1-doctor");
    const result = await runCli(dir, ["doctor", "--json"], 180_000);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ffmpeg.available).toBe(true);
    expect(report.ffprobe.available).toBe(true);
    expect(report.browser.available).toBe(true);
    expect(report.node).toMatch(/^v\d+/);
    expect(report.os.platform).toBeTypeOf("string");
    expect(Array.isArray(report.warnings)).toBe(true);
  }, 200_000);

  it("ultra probe extracts exact metadata, cuts, onsets, frames and contact sheets", async () => {
    const dir = await makeTempDir("p1-probe");
    const ref = path.join(dir, "ref.mp4");
    await makeReferenceVideo(ref);
    const workspace = path.join(dir, "workspace");

    const result = await runCli(dir, ["probe", "ref.mp4", "--workspace", "workspace"], 300_000);
    expect(result.code, result.stderr).toBe(0);

    const probe = ProbeResult.parse(JSON.parse(await fs.readFile(path.join(workspace, "probe.json"), "utf8")));
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
    expect(Math.abs(probe.fps.numeric - 30)).toBeLessThan(0.01);
    expect(Math.abs(probe.durationSec - 4)).toBeLessThanOrEqual(0.1);
    expect(probe.pixelFormat).toBe("yuv420p");
    expect(probe.audio).not.toBeNull();
    expect(probe.audio?.sampleRate).toBe(44100);

    expect(probe.cutsSec.length).toBeGreaterThanOrEqual(2);
    expect(probe.cutsSec.some((t) => Math.abs(t - 1.333) < 0.2)).toBe(true);
    expect(probe.cutsSec.some((t) => Math.abs(t - 2.667) < 0.2)).toBe(true);

    expect(probe.onsetsSec.length).toBeGreaterThanOrEqual(1);

    expect(probe.frames.length).toBeGreaterThanOrEqual(4);
    for (const frame of probe.frames) {
      const stat = await fs.stat(path.join(workspace, frame.path));
      expect(stat.size).toBeGreaterThan(1000);
    }

    expect(probe.contactSheets.length).toBeGreaterThanOrEqual(1);
    for (const sheet of probe.contactSheets) {
      const stat = await fs.stat(path.join(workspace, sheet));
      expect(stat.size).toBeGreaterThan(20_000);
    }
  }, 320_000);
});
