import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ffprobeJson } from "../core/ffmpeg.js";
import { writeJsonAtomic } from "../core/util.js";
import { fullFixtureProject, makeTempDir, runCli, writeBaseAssets } from "./helpers.js";

describe("phase 4 — orchestrator + multi-engine routing with cloud-safe fallback", () => {
  it("builds all scenes across hyperframes/remotion/revideo/blender (or verified fallback) and stitches 1 MP4", async () => {
    const dir = await makeTempDir("p4-build");
    const workspace = path.join(dir, "workspace");
    await writeBaseAssets(workspace);
    const project = fullFixtureProject();
    await writeJsonAtomic(path.join(workspace, "ultra.json"), project);

    const build = await runCli(dir, ["build"], 900_000);
    expect(build.code, build.stderr).toBe(0);

    const manifest = JSON.parse(await fs.readFile(path.join(dir, "build", "build-manifest.json"), "utf8"));
    expect(manifest.scenes).toHaveLength(5);
    expect(manifest.fps).toBe(30);

    const byId = Object.fromEntries(manifest.scenes.map((s: any) => [s.sceneId, s]));
    expect(byId.intro.engineUsed).toBe("hyperframes");
    expect(byId.outro.engineUsed).toBe("hyperframes");

    for (const [sceneId, requested] of [
      ["spring", "remotion"],
      ["diagram", "revideo"],
    ] as const) {
      const scene = byId[sceneId];
      expect(scene.requestedEngine).toBe(requested);
      const native = scene.engineUsed === requested;
      const fallback = scene.engineUsed === "hyperframes" && scene.fallback === true;
      expect(native || fallback, `${sceneId} must use ${requested} or a recorded fallback`).toBe(true);
      if (fallback) expect(scene.notes.join(" ")).toMatch(/unavailable|failed/i);
    }

    expect(byId.vfx.engineUsed).toBe("blender");
    expect(byId.vfx.notes.length).toBeGreaterThan(0);

    expect(manifest.stitch.transitionCount).toBe(3);
    expect(manifest.stitch.overlayCount).toBe(1);

    const draft = path.join(dir, "build", "draft.mp4");
    const stat = await fs.stat(draft);
    expect(stat.size).toBeGreaterThan(100_000);
    const probe = await ffprobeJson(draft);
    const video = probe.streams.find((s: any) => s.codec_type === "video");
    const audio = probe.streams.find((s: any) => s.codec_type === "audio");
    expect(video).toBeTruthy();
    expect(audio).toBeTruthy();
    expect(Math.abs(Number(probe.format.duration) - 4)).toBeLessThanOrEqual(0.1);
    expect(Number(video.nb_frames)).toBeGreaterThanOrEqual(118);
    expect(Number(video.nb_frames)).toBeLessThanOrEqual(122);

    // Incremental SHA-1 cache: second build must be a full cache hit.
    const rebuild = await runCli(dir, ["build"], 900_000);
    expect(rebuild.code, rebuild.stderr).toBe(0);
    const manifest2 = JSON.parse(await fs.readFile(path.join(dir, "build", "build-manifest.json"), "utf8"));
    expect(manifest2.cache.misses).toBe(0);
    expect(manifest2.cache.hits).toBe(5);
    expect(manifest2.scenes.every((s: any) => s.cached === true)).toBe(true);
  }, 900_000);
});
