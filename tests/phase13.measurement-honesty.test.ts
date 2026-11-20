import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UltraProject, type UltraProjectT } from "../core/schema.js";
import { probeReference } from "../core/probe.js";
import { classifyFrameDifferences } from "../core/jitter.js";
import { auditDraft, reconcileJitter } from "../verifier/metrics.js";
import { createRubric } from "../verifier/rubric.js";
import { runGuard } from "../core/guard.js";
import { resolveSfxCueTimes } from "../core/stitcher.js";
import { stitchTimeline } from "../core/stitcher.js";
import { measureAudioSync, sfxSyncWarnings } from "../core/audio-sync.js";
import { fullFrameAudit } from "../verifier/full-audit.js";
import { measureEasingCurves, buildAssetSimilaritySection, buildFontCheckSection, buildNotCheckedList } from "../verifier/honesty.js";
import { colourRoundTrip } from "../verifier/colour.js";
import { validateAssets } from "../core/assets.js";
import { synthesizeToWav } from "../core/synth-audio.js";
import { ffmpegOk, runBinary, ffprobeJson } from "../core/ffmpeg.js";
import { pathExists, sha1, writeJsonAtomic } from "../core/util.js";
import { PALETTE, makeTempDir, runCli } from "./helpers.js";

/**
 * phase 13 — P2 measurement honesty + audio.
 * [5] soft cuts, [6] geometry, [7] source annotations, [23] jitter vs reference,
 * [25] verify --full, [26] method provenance, [27] honest verify sections,
 * [28] scene-anchored SFX, [29] audio sync, [30] audio origin labels,
 * [16] colour round-trip, [27b] easing curve error.
 */

function smallProject(opts: {
  durationSec: number;
  fps?: number;
  width?: number;
  height?: number;
  assets?: UltraProjectT["assets"];
  scenes?: Record<string, unknown>[];
  method?: "native" | "plate-replay" | "mixed";
}): UltraProjectT {
  const fps = opts.fps ?? 10;
  const width = opts.width ?? 160;
  const height = opts.height ?? 90;
  return UltraProject.parse({
    meta: {
      title: "P13",
      sourceVideoPath: "reference.mp4",
      width,
      height,
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
    scenes:
      opts.scenes ?? [
        { id: "only", name: "Only", startSec: 0, endSec: opts.durationSec, engine: "hyperframes", background: PALETTE.bg },
      ],
  });
}

/** Moving white box via overlay (drawbox does not evaluate t per frame). */
async function makeMovingBox(file: string, durationSec: number, fps: number, xExpression: string, width = 320, height = 180): Promise<void> {
  await ffmpegOk([
    "-f", "lavfi", "-i", `color=c=0x101820:s=${width}x${height}:d=${durationSec}:r=${fps}`,
    "-f", "lavfi", "-i", `color=c=white:s=40x40:d=${durationSec}:r=${fps}`,
    "-filter_complex", `[1:v]format=rgba[box];[0:v][box]overlay=x='${xExpression}':y=70:shortest=1,format=yuv420p[v]`,
    "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", file,
  ]);
}

describe("[5] two-pass probe finds soft/graphic cuts without inventing hard cuts", () => {
  it("labels a graphic reconfiguration as a soft cut (with frame number), not cutsSec", async () => {
    const dir = await makeTempDir("p5-softcut");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const ref = path.join(dir, "jump.mp4");
    await makeMovingBox(ref, 3, 30, "if(lt(t,2.4),40,200)");
    const probe = await probeReference(ref, workspace, {});
    expect(probe.cutsSec.some((t) => Math.abs(t - 2.4) < 0.4)).toBe(false);
    expect(probe.softCutsSec.some((t) => Math.abs(t - 2.4) < 0.2)).toBe(true);
    const event = probe.softCutFrames.find((entry) => Math.abs(entry.atSec - 2.4) < 0.2);
    expect(event?.frame).toBeGreaterThan(60);
    expect(event?.frame).toBeLessThan(84);
    expect(probe.scenes[0]!.motionScore).toBeGreaterThan(0);
  }, 300_000);

  it("warns when --max-segments truncates instead of silently capping at 24", async () => {
    const dir = await makeTempDir("p5-truncate");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const ref = path.join(dir, "three.mp4");
    await ffmpegOk([
      "-f", "lavfi", "-i", "color=c=0x101820:s=160x90:d=1:r=10",
      "-f", "lavfi", "-i", "color=c=0xd9484f:s=160x90:d=1:r=10",
      "-f", "lavfi", "-i", "color=c=0x2c4a7c:s=160x90:d=1:r=10",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]",
      "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", ref,
    ]);
    const probe = await probeReference(ref, workspace, { maxSegments: 1 });
    expect(probe.scenes).toHaveLength(1);
    const cli = await runCli(dir, ["probe", "three.mp4", "--max-segments", "1"], 300_000);
    expect(cli.code, cli.stderr).toBe(0);
    expect(cli.stdout).toContain("probe"); // output still produced
    expect(cli.stderr).toContain("truncating to --max-segments 1");
  }, 600_000);
});

describe("[6] probe --geometry measures grid lines within ±4px", () => {
  it("finds three vertical and three horizontal lines on a synthetic grid", async () => {
    const dir = await makeTempDir("p6-geometry");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const ref = path.join(dir, "grid.mp4");
    const boxes = [
      "drawbox=x=200:y=0:w=3:h=720:color=white:t=fill",
      "drawbox=x=640:y=0:w=3:h=720:color=white:t=fill",
      "drawbox=x=1080:y=0:w=3:h=720:color=white:t=fill",
      "drawbox=x=0:y=100:w=1280:h=3:color=white:t=fill",
      "drawbox=x=0:y=360:w=1280:h=3:color=white:t=fill",
      "drawbox=x=0:y=620:w=1280:h=3:color=white:t=fill",
    ].join(",");
    await ffmpegOk([
      "-f", "lavfi", "-i", "color=c=0x101820:s=1280x720:d=1:r=10",
      "-vf", boxes, "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", ref,
    ]);
    await probeReference(ref, workspace, { geometry: true });
    const geometry = JSON.parse(await fs.readFile(path.join(workspace, "geometry.json"), "utf8")) as {
      segmentIndex: number;
      lines: { orientation: "v" | "h"; x?: number; y?: number }[];
    }[];
    const first = geometry[0]!;
    const verticals = first.lines.filter((l) => l.orientation === "v").map((l) => l.x as number);
    const horizontals = first.lines.filter((l) => l.orientation === "h").map((l) => l.y as number);
    for (const target of [200, 640, 1080]) {
      expect(verticals.some((x) => Math.abs(x - target) <= 4), `vertical ${target} not in ${JSON.stringify(verticals)}`).toBe(true);
    }
    for (const target of [100, 360, 620]) {
      expect(horizontals.some((y) => Math.abs(y - target) <= 4), `horizontal ${target} not in ${JSON.stringify(horizontals)}`).toBe(true);
    }
  }, 300_000);
});

describe("[7] source annotations + measurements.json are surfaced by guard", () => {
  it("lists exactly the guessed scenes and never blocks the plan", async () => {
    const dir = await makeTempDir("p7-source");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const project = smallProject({
      durationSec: 2,
      scenes: [
        { id: "measured-scene", name: "M", startSec: 0, endSec: 1, engine: "hyperframes", background: PALETTE.bg, source: "measured", evidence: "probe cut 0.98s" },
        { id: "guess-scene", name: "G", startSec: 1, endSec: 2, engine: "hyperframes", background: PALETTE.bg },
      ],
    });
    await writeJsonAtomic(path.join(workspace, "ultra.json"), project);
    await writeJsonAtomic(path.join(workspace, "measurements.json"), { cuts: [0.98], grid: { x: [120, 640] } });
    const report = await runGuard(workspace, path.join(dir, "build"), "plan");
    expect(report.ok).toBe(true);
    const sourceWarnings = report.warnings.filter((warning) => warning.check === "source");
    expect(sourceWarnings).toHaveLength(1);
    expect(sourceWarnings[0]!.detail).toContain("guess-scene");
    expect(sourceWarnings[0]!.detail).not.toContain("measured-scene");
    expect(report.warnings.some((warning) => warning.check === "measurements" && warning.detail.includes("supported"))).toBe(true);
  }, 120_000);
});

describe("[23] stutter verification compares against the reference's own holds", () => {
  it("does not flag a draft stutter that the reference also has, but flags a NEW one", () => {
    const fps = 30;
    const total = 120;
    const base = new Array(total - 1).fill(5);
    const refDiffs = [...base];
    refDiffs[40] = 0;
    refDiffs[41] = 0; // reference holds 2 frames at ~1.37s
    const reference = classifyFrameDifferences(refDiffs, total, fps);
    expect(reference.stutterRuns.length).toBeGreaterThan(0);
    const same = classifyFrameDifferences([...refDiffs], total, fps);
    expect(reconcileJitter(same, reference, fps)).toHaveLength(0);

    const newer = [...base];
    newer[40] = 0;
    newer[41] = 0;
    newer[80] = 0;
    newer[81] = 0;
    const draft = classifyFrameDifferences(newer, total, fps);
    const unmatched = reconcileJitter(draft, reference, fps);
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]!.atSec).toBeCloseTo(81 / fps, 2);
  });

  it("auditDraft passes matching reference/draft freezes and fails a new freeze with its timestamp", async () => {
    const dir = await makeTempDir("p23-jitter");
    const makeVideo = async (file: string, extraFreeze: boolean) => {
      const freeze = extraFreeze
        ? "if(lt(t,1),t*120,if(lt(t,1.1),120,if(lt(t,2),120+(t-1.1)*120,if(lt(t,2.1),228,228+(t-2.1)*120))))"
        : "if(lt(t,1),t*120,if(lt(t,1.1),120,120+(t-1.1)*120))";
      await makeMovingBox(file, 3, 30, freeze, 320, 180);
    };
    const ref = path.join(dir, "ref.mp4");
    const same = path.join(dir, "draft-same.mp4");
    const newer = path.join(dir, "draft-new.mp4");
    await makeVideo(ref, false);
    await makeVideo(same, false);
    await makeVideo(newer, true);

    const matched = await auditDraft({ draftFile: same, referenceFile: ref, expectedDurationSec: 3, expectedFps: 30, targetLufs: -14 });
    expect(matched.jitterReference).toBeTruthy();
    expect(matched.stutterEvents).toBe(0);
    expect(matched.jitterOk).toBe(true);

    const failing = await auditDraft({ draftFile: newer, referenceFile: ref, expectedDurationSec: 3, expectedFps: 30, targetLufs: -14 });
    expect(failing.stutterEvents).toBeGreaterThanOrEqual(1);
    expect(failing.jitterUnmatchedEvents[0]!.atSec).toBeGreaterThan(1.8);
    expect(failing.jitterUnmatchedEvents[0]!.atSec).toBeLessThan(2.2);
    expect(failing.jitterOk).toBe(false);
  }, 600_000);
});

describe("[25] verify --full streams SSIM for every frame", () => {
  it("frame count equals the draft's frame count and mean matches a sampled SSIM", async () => {
    const dir = await makeTempDir("p25-full");
    const ref = path.join(dir, "ref.mp4");
    const draft = path.join(dir, "draft.mp4");
    await ffmpegOk(["-f", "lavfi", "-i", "color=c=0x2c4a7c:s=160x90:d=1:r=30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", ref]);
    await ffmpegOk(["-f", "lavfi", "-i", "color=c=0x2c4a7c:s=160x90:d=1:r=30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", draft]);
    const full = await fullFrameAudit({ reference: ref, draft, fps: 30, outDir: path.join(dir, "audit-frames") });
    const probe = await ffprobeJson(draft);
    const video = probe.streams.find((s: any) => s.codec_type === "video");
    expect(full.frameCount).toBe(Number(video.nb_frames));
    expect(full.mean).toBeGreaterThan(0.97);
    expect(full.worst20.length).toBeGreaterThan(0);
    expect(full.thumbnails.length).toBeGreaterThan(0);
    for (const thumb of full.thumbnails) expect(await pathExists(thumb)).toBe(true);
  }, 300_000);
});

describe("[26] method provenance: native bans reference frames as assets", () => {
  it("fails guard when a reference frame is declared as a native asset", async () => {
    const dir = await makeTempDir("p26-method");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(path.join(workspace, "assets"), { recursive: true });
    const ref = path.join(workspace, "reference.mp4");
    await ffmpegOk(["-f", "lavfi", "-i", "testsrc2=size=320x180:d=1:r=30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", ref]);
    const stolen = path.join(workspace, "assets", "stolen.png");
    await ffmpegOk(["-ss", "0.5", "-i", ref, "-frames:v", "1", "-y", stolen]);
    const project = smallProject({
      durationSec: 1,
      assets: [{ id: "stolen", type: "image", description: "reference frame", prompt: "x", targetPath: "assets/stolen.png" }],
      scenes: [
        {
          id: "only",
          name: "Only",
          startSec: 0,
          endSec: 1,
          engine: "hyperframes",
          background: PALETTE.bg,
          layers: [{ id: "l", type: "image", assetId: "stolen", x: 0, y: 0, width: 160, height: 90 }],
        },
      ],
      method: "native",
    });
    await writeJsonAtomic(path.join(workspace, "ultra.json"), project);
    const report = await runGuard(workspace, path.join(dir, "build"), "plan");
    expect(report.ok).toBe(false);
    expect(report.errors.some((error) => error.check === "method" && error.detail.includes('"stolen"'))).toBe(true);
  }, 300_000);

  it("rubrics report per-method expectations, never one comparable number", () => {
    const native = createRubric("native");
    const plate = createRubric("plate-replay");
    expect(native.method).toBe("native");
    expect(plate.method).toBe("plate-replay");
    expect(native.categories[0]!.expectation).not.toBe(plate.categories[0]!.expectation);
    expect(native.categories.every((category) => typeof category.expectation === "string")).toBe(true);
  });
});

describe("[27] honest verify: notChecked, easing curves, scored sections", () => {
  it("builds notChecked, assetSimilarity and fontCheck sections", async () => {
    const dir = await makeTempDir("p27-sections");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    await writeJsonAtomic(path.join(workspace, "assets.manifest.json"), {
      generatedAt: new Date().toISOString(),
      assets: {
        bird: {
          id: "bird",
          targetPath: "assets/bird.png",
          exists: true,
          bytes: 10,
          sha1: "x",
          valid: true,
          status: "valid image",
          similarity: {
            sceneId: "s1",
            startSec: 0,
            endSec: 1,
            ssimToRefSegment: 0.7,
            histogramDistance: 0.2,
            edgeDensityRatio: 1.1,
            warnings: [],
          },
        },
      },
    });
    const project = smallProject({
      durationSec: 1,
      assets: [{ id: "bird", type: "image", description: "x", prompt: "x", targetPath: "assets/bird.png" }],
    });
    const section = await buildAssetSimilaritySection(project, workspace);
    expect(section).toHaveLength(1);
    expect(section![0]!.score).toBeGreaterThan(50);
    const fontCheck = await buildFontCheckSection(project, workspace);
    expect(fontCheck.score).toBe(100);
    expect(fontCheck.unavailableFonts).toHaveLength(0);
    const notChecked = buildNotCheckedList({ hasAudio: false, hasFullAudit: false, hasReference: true, fontMatched: false });
    expect(notChecked.join(" ")).toContain("per-frame SSIM");
    expect(notChecked.join(" ")).toContain("audio sync");
  });

  it("reports a bigger motion-curve error for a linear draft against an eased reference", async () => {
    const dir = await makeTempDir("p27-easing");
    const ref = path.join(dir, "ref.mp4");
    const eased = path.join(dir, "eased.mp4");
    const linear = path.join(dir, "linear.mp4");
    const make = async (file: string, expression: string) => {
      await makeMovingBox(file, 2, 30, expression, 320, 180);
    };
    const easedExpr = "40+600*(1-pow(1-min(t/2,1),3))";
    await make(ref, easedExpr);
    await make(eased, easedExpr);
    await make(linear, "40+600*min(t/2,1)");
    const project = smallProject({ durationSec: 2, fps: 30, width: 320, height: 180 });
    const right = await measureEasingCurves(ref, eased, project);
    const wrong = await measureEasingCurves(ref, linear, project);
    const rightError = right[0]!.curveError as number;
    const wrongError = wrong[0]!.curveError as number;
    expect(rightError).not.toBeNull();
    expect(wrongError).toBeGreaterThan(rightError + 5);
  }, 300_000);

  it("verify CLI ends with notChecked and writes fullAudit frame count", async () => {
    const dir = await makeTempDir("p27-cli");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const ref = path.join(workspace, "reference.mp4");
    await ffmpegOk(["-f", "lavfi", "-i", "color=c=0x101820:s=160x90:d=1:r=10", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", ref]);
    const project = smallProject({ durationSec: 1 });
    await writeJsonAtomic(path.join(workspace, "ultra.json"), project);
    const build = await runCli(dir, ["build"], 300_000);
    expect(build.code, build.stderr).toBe(0);
    const verify = await runCli(dir, ["verify", "workspace/reference.mp4", "--full"], 900_000);
    const report = JSON.parse(await fs.readFile(path.join(dir, "build", "verify-report.json"), "utf8"));
    expect(report.notChecked.length).toBeGreaterThan(0);
    expect(report.method).toBe("native");
    expect(report.jitterDraft).toBeTruthy();
    expect(report.easing.length).toBeGreaterThan(0);
    const lines = verify.stdout.trim().split(/\r?\n/);
    expect(lines[lines.length - 1]).toContain("notChecked:");
    expect(report.fullAudit.frameCount).toBe(10);
    expect(typeof report.fontCheck.score).toBe("number");
  }, 1_200_000);
});

describe("[16] colour round-trip reports ΔE per palette colour", () => {
  it("reports a small ΔE for an identity pipeline and >3 when the grade shifts colours", async () => {
    const dir = await makeTempDir("p16-colour");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const base = smallProject({ durationSec: 0.4, fps: 10, width: 64, height: 36 });
    const identity = UltraProject.parse({ ...base, designTokens: { ...base.designTokens, palette: { a: "#d9484f", b: "#2c4a7c" } } });
    const exact = await colourRoundTrip(identity, workspace, path.join(dir, "build"));
    expect(exact).toHaveLength(2);
    for (const entry of exact!) expect(entry.deltaE).toBeLessThan(3);

    const shifted = UltraProject.parse({
      ...identity,
      colorGrade: { saturation: 2.2, exposure: 0.9, temperature: 1 },
    });
    const drift = await colourRoundTrip(shifted, workspace, path.join(dir, "build"));
    expect(drift!.some((entry) => entry.deltaE > 3)).toBe(true);
  }, 300_000);
});

describe("[28] scene-anchored SFX cues follow retimes; atSec-only cues stay put", () => {
  it("resolves exactly one anchor and keeps legacy cues identical", () => {
    const dir = "/tmp/unused";
    void dir;
    const project = UltraProject.parse({
      meta: { title: "Cues", sourceVideoPath: "reference.mp4", width: 160, height: 90, fps: 10, durationSec: 2, method: "native" },
      designTokens: {
        palette: PALETTE,
        fonts: { heading: "A", body: "B", mono: "C" },
        grainOpacity: 0,
        antiSlopRules: ["x"],
      },
      colorGrade: {},
      audio: {
        sfxCues: [
          { assetId: "hit", atSec: 0.5, gainDb: -3 },
          { assetId: "hit", sceneId: "s2", offsetSec: 0.1, gainDb: 0 },
        ],
      },
      assets: [{ id: "hit", type: "sfx", description: "hit", prompt: "hit", targetPath: "assets/hit.wav" }],
      scenes: [
        { id: "s1", name: "S1", startSec: 0, endSec: 1, engine: "hyperframes", background: PALETTE.bg },
        { id: "s2", name: "S2", startSec: 1, endSec: 2, engine: "hyperframes", background: PALETTE.bg },
      ],
    });
    expect(resolveSfxCueTimes(project).map((entry) => entry.atSec)).toEqual([0.5, 1.1]);
    const retimed = UltraProject.parse({
      ...project,
      scenes: [project.scenes[0], { ...project.scenes[1]!, startSec: 1.5, endSec: 2 }],
      meta: { ...project.meta, durationSec: 2 },
    });
    expect(resolveSfxCueTimes(retimed).map((entry) => entry.atSec)).toEqual([0.5, 1.6]);
    expect(() =>
      UltraProject.parse({
        ...project,
        audio: { sfxCues: [{ assetId: "hit", atSec: 1, sceneId: "s2", offsetSec: 0.1 }] },
      }),
    ).toThrow();
    expect(() => UltraProject.parse({ ...project, audio: { sfxCues: [{ assetId: "hit", sceneId: "s2" }] } })).toThrow();
  });

  it("keeps legacy atSec-only audio deterministic (golden PCM hash over two stitches)", async () => {
    const dir = await makeTempDir("p28-golden");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(path.join(workspace, "assets"), { recursive: true });
    await ffmpegOk(["-f", "lavfi", "-i", "sine=frequency=880:duration=0.4", "-c:a", "pcm_s16le", path.join(workspace, "assets", "hit.wav")]);
    const clipA = path.join(dir, "a.mp4");
    const clipB = path.join(dir, "b.mp4");
    await ffmpegOk(["-f", "lavfi", "-i", "color=c=0x101820:s=160x90:d=1:r=10", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", clipA]);
    await ffmpegOk(["-f", "lavfi", "-i", "color=c=0xd9484f:s=160x90:d=1:r=10", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", clipB]);
    const project = UltraProject.parse({
      meta: { title: "Golden", sourceVideoPath: "reference.mp4", width: 160, height: 90, fps: 10, durationSec: 2, method: "native" },
      designTokens: { palette: PALETTE, fonts: { heading: "A", body: "B", mono: "C" }, grainOpacity: 0, antiSlopRules: ["x"] },
      colorGrade: {},
      audio: { sfxCues: [{ assetId: "hit", atSec: 0.5, gainDb: 0 }] },
      assets: [{ id: "hit", type: "sfx", description: "hit", prompt: "hit", targetPath: "assets/hit.wav" }],
      scenes: [
        { id: "s1", name: "S1", startSec: 0, endSec: 1, engine: "hyperframes", background: PALETTE.bg },
        { id: "s2", name: "S2", startSec: 1, endSec: 2, engine: "hyperframes", background: PALETTE.bg },
      ],
    });
    const stitch = async (out: string) =>
      stitchTimeline({
        project,
        workspace,
        buildDir: path.join(dir, "build"),
        clips: [
          { sceneId: "s1", file: clipA, startSec: 0, endSec: 1, durationSec: 1 },
          { sceneId: "s2", file: clipB, startSec: 1, endSec: 2, durationSec: 1 },
        ],
        outFile: out,
        crf: 20,
        preset: "veryfast",
      });
    const one = path.join(dir, "stitch-1.mp4");
    const two = path.join(dir, "stitch-2.mp4");
    await stitch(one);
    await stitch(two);
    const pcm = async (file: string) =>
      sha1((await runBinary("ffmpeg", ["-v", "error", "-i", file, "-vn", "-f", "s16le", "-ac", "2", "-ar", "48000", "-"])).stdout);
    expect(await pcm(one)).toBe(await pcm(two));
  }, 600_000);
});

describe("[29] audio sync + SFX cue warnings", () => {
  it("reports a 250ms delayed draft within ±40ms", async () => {
    const dir = await makeTempDir("p29-sync");
    await fs.mkdir(dir, { recursive: true });
    const ref = path.join(dir, "ref.wav");
    const draft = path.join(dir, "draft.wav");
    const burst = "if(lt(mod(t,0.5),0.1),sin(2*PI*1000*t)*0.8,0)";
    await ffmpegOk(["-f", "lavfi", "-i", `aevalsrc='${burst}':s=48000:d=2`, "-c:a", "pcm_s16le", ref]);
    await ffmpegOk(["-f", "lavfi", "-i", `aevalsrc='${burst}':s=48000:d=2`, "-af", "adelay=250|250", "-c:a", "pcm_s16le", draft]);
    const sync = await measureAudioSync(ref, draft);
    expect(sync).toBeTruthy();
    expect(Math.abs(sync!.offsetMs - 250)).toBeLessThanOrEqual(40);
  }, 300_000);

  it("warns when an SFX cue is more than 80ms from the nearest onset/cut", async () => {
    const dir = await makeTempDir("p29-cues");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    await writeJsonAtomic(path.join(workspace, "probe.json"), {
      sourcePath: "reference.mp4",
      width: 160,
      height: 90,
      fps: { rational: "10/1", numeric: 10 },
      durationSec: 2,
      pixelFormat: "yuv420p",
      audio: null,
      cutsSec: [1.0],
      onsetsSec: [0.5],
      frames: [],
      contactSheets: [],
      scenes: [],
      audioEnvelopePath: null,
    });
    const project = UltraProject.parse({
      meta: { title: "Cues", sourceVideoPath: "reference.mp4", width: 160, height: 90, fps: 10, durationSec: 2, method: "native" },
      designTokens: { palette: PALETTE, fonts: { heading: "A", body: "B", mono: "C" }, grainOpacity: 0, antiSlopRules: ["x"] },
      colorGrade: {},
      audio: { sfxCues: [{ assetId: "hit", atSec: 0.8, gainDb: 0 }] },
      assets: [{ id: "hit", type: "sfx", description: "hit", prompt: "hit", targetPath: "assets/hit.wav" }],
      scenes: [
        { id: "s1", name: "S1", startSec: 0, endSec: 1, engine: "hyperframes", background: PALETTE.bg },
        { id: "s2", name: "S2", startSec: 1, endSec: 2, engine: "hyperframes", background: PALETTE.bg },
      ],
    });
    const warnings = await sfxSyncWarnings(project, workspace);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.distanceMs).toBeGreaterThan(80);
    expect(warnings[0]!.nearestSec).toBe(1.0);
  });
});

describe("[30] synthesised audio is labelled without the agent setting origin", () => {
  it("marks synth-audio outputs as synthesised in assets.manifest.json and assets-todo.json", async () => {
    const dir = await makeTempDir("p30-origin");
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(path.join(workspace, "assets"), { recursive: true });
    const whoosh = path.join(workspace, "assets", "whoosh.wav");
    await synthesizeToWav({ preset: "whoosh", out: whoosh, durationSec: 0.5 });
    await synthesizeToWav({ preset: "ambient-tech", out: path.join(workspace, "assets", "bed.wav"), durationSec: 1 });
    const project = UltraProject.parse({
      meta: { title: "Origin", sourceVideoPath: "reference.mp4", width: 160, height: 90, fps: 10, durationSec: 1, method: "native" },
      designTokens: { palette: PALETTE, fonts: { heading: "A", body: "B", mono: "C" }, grainOpacity: 0, antiSlopRules: ["x"] },
      colorGrade: {},
      audio: { musicAssetId: "bed" },
      assets: [
        { id: "whoosh", type: "sfx", description: "whoosh", prompt: "whoosh", targetPath: "assets/whoosh.wav" },
        { id: "bed", type: "music", description: "bed", prompt: "bed", targetPath: "assets/bed.wav" },
        { id: "missing", type: "sfx", description: "not generated yet", prompt: "x", targetPath: "assets/missing.wav" },
      ],
      scenes: [{ id: "only", name: "Only", startSec: 0, endSec: 1, engine: "hyperframes", background: PALETTE.bg }],
    });
    const result = await validateAssets(project, workspace);
    const manifest = JSON.parse(await fs.readFile(path.join(workspace, "assets.manifest.json"), "utf8"));
    expect(manifest.assets.whoosh.origin).toBe("synthesised");
    expect(manifest.assets.bed.origin).toBe("synthesised");
    expect(result.ok).toBe(false); // missing asset still fails existence, not origin
    const todo = JSON.parse(await fs.readFile(path.join(workspace, "assets-todo.json"), "utf8"));
    expect(todo.missing[0].origin).toBe("user-supplied");
  }, 300_000);
});
