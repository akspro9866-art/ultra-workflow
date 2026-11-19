import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ffmpegOk, ffprobeJson } from "../core/ffmpeg.js";
import { UltraProject } from "../core/schema.js";
import { writeJsonAtomic } from "../core/util.js";
import { extractZip } from "../core/zip.js";
import { makeTempDir, runCli } from "./helpers.js";

const C = {
  bg: "#101820",
  surface: "#1a2634",
  textPrimary: "#f2f2f0",
  textMuted: "#8ecae6",
  accent1: "#ffb703",
  accent2: "#8ecae6",
};

async function makeStyledReference(
  file: string,
  opts: { duration: number; cuts: number[]; colors: string[]; fps?: number },
): Promise<void> {
  const fps = opts.fps ?? 30;
  const boundaries = [0, ...opts.cuts, opts.duration];
  const inputs: string[] = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const len = (boundaries[i + 1] as number) - (boundaries[i] as number);
    inputs.push("-f", "lavfi", "-i", `color=c=${opts.colors[i % opts.colors.length]}:s=1280x720:d=${len.toFixed(3)}:r=${fps}`);
  }
  const concat = `${boundaries
    .slice(0, -1)
    .map((_, i) => `[${i}:v]`)
    .join("")}concat=n=${boundaries.length - 1}:v=1:a=0,format=yuv420p[v]`;
  const burst = opts.cuts.map((c) => `between(t,${(c - 0.02).toFixed(3)},${(c + 0.2).toFixed(3)})`).join("+");
  const audioExpr = `0.22+0.78*min(1\\,${burst || "0"})`;
  const audioInput = ["-f", "lavfi", "-i", `sine=frequency=440:duration=${opts.duration}`];
  await ffmpegOk([
    ...inputs,
    ...audioInput,
    "-filter_complex",
    `${concat};[${boundaries.length - 1}:a]volume='${audioExpr}':eval=frame[a]`,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-r",
    String(fps),
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-t",
    String(opts.duration),
    file,
  ]);
}

async function makeStillPng(file: string, color: string): Promise<void> {
  await ffmpegOk([
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=640x360`,
    "-frames:v",
    "1",
    "-pix_fmt",
    "rgb24",
    file,
  ]);
}

/** 4s raw talking-style clip: moving accent card over brand bg, tone with a 1.5s silence gap. */
async function makeRawTalkingVideo(file: string): Promise<void> {
  await ffmpegOk([
    "-f",
    "lavfi",
    "-i",
    `color=c=${C.bg.replace("#", "0x")}:s=1280x720:d=4:r=30`,
    "-f",
    "lavfi",
    "-i",
    `color=c=${C.accent1.replace("#", "0x")}:s=240x140:d=4:r=30`,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:duration=4",
    "-filter_complex",
    "[0:v][1:v]overlay=x='mod(t*380,1040)':y=300:shortest=1,format=yuv420p[v];[2:a]volume='if(between(t,1.02,2.48),0,0.7)':eval=frame[a]",
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-r",
    "30",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-t",
    "4",
    file,
  ]);
}

const STYLE_JSON = {
  meta: {
    slug: "demo-punchy",
    name: "Demo Punchy",
    description: "Fast punch-in cuts, high-contrast amber accents, word-highlighted captions.",
    version: "1.0.0",
    createdAt: "2026-11-19T00:00:00.000Z",
    referenceCount: 2,
    sourceNotes: "Measured from ref1/ref2 cuts, palettes and beat bursts.",
  },
  pacing: {
    hookWindowSec: 1.0,
    hookAslSec: [0.8, 2.0],
    bodyAslSec: [0.8, 2.0],
    outroAslSec: [0.5, 2.5],
    maxStaticHoldSec: 0.5,
    silenceTrimMs: 120,
    jCutMs: 80,
    lCutMs: 120,
    beatSnapRatioTarget: 0.5,
  },
  motion: {
    dominantEasing: "easeOutCubic",
    secondaryEasings: ["easeOutExpo"],
    punchInScaleRange: [1.03, 1.12],
    kenBurnsDriftScale: 0.3,
    motionBlurSamples: 1,
    shutterAngle: 180,
    cameraDriftAmplitude: 2,
  },
  typography: {
    displayFont: "Segoe UI",
    captionFont: "Segoe UI",
    monoFont: "Consolas",
    casing: "upper",
    captionChunkWords: [2, 4],
    safeZoneYPercent: 78,
    activeWordHighlight: "pill",
    strokePx: 0,
    shadowSpec: "0 2px 18px rgba(0,0,0,0.45)",
  },
  visualLayering: {
    aRollRatio: 0.7,
    bRollRatio: 0.2,
    motionGraphicRatio: 0.1,
    preferredEngines: ["hyperframes"],
    motifTriggers: [{ trigger: "stat pop", motifFile: "motifs/stat-pop.html", description: "number pop-in" }],
  },
  colorAndTexture: {
    palette: C,
    grade: { exposure: 0, contrast: 0.04, saturation: 1.02, temperature: 0.04, vignette: 0.08 },
    grainOpacity: 0.05,
    halationOpacity: 0.02,
    halftoneOpacity: 0,
  },
  transitions: { mix: { fade: 0.7, slideup: 0.3 }, durationFrames: [5, 9], bannedTypes: ["wipeleft", "circleopen"] },
  soundDesign: {
    targetLufs: -14,
    musicDuckingDb: -12,
    musicBpmRange: [90, 130],
    eventToSfxMap: { whoosh: "assets/whoosh.wav" },
  },
  narrative: {
    hookPatterns: ["question", "result-first"],
    chapterResetIntervalSec: 20,
    styleInvariants: ["palette locked", "cut on beat"],
    antiPatterns: ["slow zooms", "template lower-thirds"],
  },
};

const STYLE_MD = `# Demo Punchy — measured style contract

Source: 2 reference clips (ref1 4s, ref2 5s), probed with \`ultra style-probe\`.

## Pacing
Hook window 1.0s; hook/body ASL 0.8–2.0s; outro 0.5–2.5s; max static hold 0.5s;
silence trim 120ms; J-cuts 80ms; L-cuts 120ms; beat-snap target 50%.

## Motion
Dominant easing easeOutCubic with easeOutExpo accents; punch-ins 1.03–1.12;
subtle 0.3 drift; shutter 180°.

## Typography
Segoe UI display/captions, uppercase, 2–4 word chunks in the lower safe zone,
pill highlight on the active word.

## Colour & texture
Background ${C.bg}; surface ${C.surface}; ink ${C.textPrimary}; muted ${C.textMuted};
amber accent ${C.accent1}; sky accent ${C.accent2}. Grade: gentle contrast/saturation
lift, 0.08 vignette, 0.05 grain, 0.02 halation.

## Transitions & sound
Fade/slide only — wipeleft and circleopen are banned. −14 LUFS target, music ducks −12 dB.

## Narrative
Question or result-first hooks; hard cuts land on beats; no slow zooms, no template
lower-thirds. This file exists to prove the validator (>=300 chars) and to give the
agent an explicit, measured checklist when editing raw footage in this style.
`;

const MOTIF_HTML = `<!doctype html>
<html><head><meta charset="utf-8"/><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden;font-family:'Segoe UI',Arial,sans-serif}
  #n{font-size:120px;font-weight:800;color:${C.accent1};letter-spacing:-.03em}
</style></head>
<body><div id="n">0</div>
<script>
  window.ultraRender = function (frame, fps, t, progress) {
    var p = Math.max(0, Math.min(1, progress));
    var eased = 1 - Math.pow(2, -10 * p);
    document.getElementById("n").textContent = String(Math.round(42 * eased));
  };
  window.__ULTRA_SEEK = async function (frame, fps) {
    if (window.ultraRender) await window.ultraRender(frame, fps, frame / fps, (frame / fps) / 2);
    return true;
  };
</script></body></html>`;

describe("phase 8 — dual-process style system", () => {
  it("extracts a style pack, imports it, probes raw footage and edits in style end-to-end", async () => {
    const dir = await makeTempDir("p8-style");

    // 1) Two distinct references with known cuts + beat bursts.
    const ref1 = path.join(dir, "ref1.mp4");
    const ref2 = path.join(dir, "ref2.mp4");
    await makeStyledReference(ref1, { duration: 4, cuts: [1.2, 2.4], colors: ["0x101820", "0xd9484f", "0x2c4a7c"] });
    await makeStyledReference(ref2, { duration: 5, cuts: [1.5, 3.0], colors: ["0x1a2634", "0xffb703", "0x8ecae6"], fps: 30 });

    // 2) style-probe both references.
    const probe = await runCli(dir, ["style-probe", "ref1.mp4", "ref2.mp4", "--out", "workspace/style-probe", "--hook-window", "1"], 600_000);
    expect(probe.code, probe.stderr).toBe(0);
    const aggregate = JSON.parse(await fs.readFile(path.join(dir, "workspace", "style-probe", "aggregate.json"), "utf8"));
    expect(aggregate.videos).toHaveLength(2);
    expect(aggregate.sections.hook.min).toBeCloseTo(1.2, 1);
    expect(aggregate.sections.hook.max).toBeCloseTo(1.5, 1);
    expect(aggregate.sections.body.median).toBeGreaterThan(0);
    expect(aggregate.sections.outro.max).toBeGreaterThanOrEqual(1.5);
    expect(aggregate.sections.outro.max).toBeLessThanOrEqual(2.1);
    expect(typeof aggregate.pacing.beatSnapRatio).toBe("number");
    expect(aggregate.pacing.beatSnapRatio).toBeGreaterThanOrEqual(0);
    expect(aggregate.videos[0].beatSnapRatio).toBeGreaterThanOrEqual(0);
    expect(aggregate.videos[0].palette.length).toBeGreaterThan(0);
    expect(aggregate.candidates.length).toBe(10);
    const overview = await fs.stat(path.join(dir, "workspace", "style-probe", "batch-overview.png"));
    expect(overview.size).toBeGreaterThan(10_000);

    // 3) Complete demo-punchy Style Pack.
    const packDir = path.join(dir, "pack", "demo-punchy");
    await fs.mkdir(path.join(packDir, "motifs"), { recursive: true });
    await fs.mkdir(path.join(packDir, "exemplars"), { recursive: true });
    await writeJsonAtomic(path.join(packDir, "style.json"), STYLE_JSON);
    await fs.writeFile(path.join(packDir, "STYLE.md"), STYLE_MD, "utf8");
    await fs.writeFile(path.join(packDir, "motifs", "stat-pop.html"), MOTIF_HTML, "utf8");
    await makeStillPng(path.join(packDir, "exemplars", "ex-01.png"), C.accent1.replace("#", "0x"));
    await makeStillPng(path.join(packDir, "exemplars", "ex-02.png"), C.textMuted.replace("#", "0x"));

    const validatePack = await runCli(dir, ["style-validate", "pack/demo-punchy"], 120_000);
    expect(validatePack.code, validatePack.stderr).toBe(0);
    expect(validatePack.stdout).toContain("style-validate OK");

    // 4) Export → zip with import instructions → import into the isolated temp repo.
    const exported = await runCli(dir, ["style-export", "pack/demo-punchy", "--out", "build/demo-punchy-style-pack.zip"], 180_000);
    expect(exported.code, exported.stderr).toBe(0);
    const packZip = path.join(dir, "build", "demo-punchy-style-pack.zip");
    const stat = await fs.stat(packZip);
    expect(stat.size).toBeGreaterThan(1000);
    const unpacked = path.join(dir, "unzip-check");
    const { entries } = await extractZip(packZip, unpacked);
    expect(entries.every((e) => e.crcOk)).toBe(true);
    const names = new Set(entries.map((e) => e.name));
    for (const required of ["style.json", "STYLE.md", "motifs/stat-pop.html", "exemplars/ex-01.png", "ADD_TO_REPO_IN_QODER.txt"]) {
      expect(names.has(required), `style zip contains ${required}`).toBe(true);
    }

    const imported = await runCli(dir, ["style-import", "build/demo-punchy-style-pack.zip"], 180_000);
    expect(imported.code, imported.stderr).toBe(0);
    const installed = path.join(dir, "styles", "demo-punchy");
    await fs.access(path.join(installed, "style.json"));
    const registry = JSON.parse(await fs.readFile(path.join(dir, "styles", "registry.json"), "utf8"));
    expect(registry.styles.map((s: { slug: string }) => s.slug)).toEqual(["demo-punchy"]);
    const listed = await runCli(dir, ["style-list", "--json"], 60_000);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)[0].slug).toBe("demo-punchy");

    // 5) Raw footage with a deliberate 1.5s silence gap → raw-probe edit plan.
    const raw = path.join(dir, "my_raw.mp4");
    await makeRawTalkingVideo(raw);
    const rawProbeRun = await runCli(dir, ["raw-probe", "my_raw.mp4", "--style", "demo-punchy", "--out", "workspace/raw-probe"], 300_000);
    expect(rawProbeRun.code, rawProbeRun.stderr).toBe(0);
    const plan = JSON.parse(await fs.readFile(path.join(dir, "workspace", "raw-probe", "raw-edit-plan.json"), "utf8"));
    expect(plan.silences.length).toBeGreaterThanOrEqual(1);
    expect(plan.removedDurationSec).toBeGreaterThan(1.2);
    expect(plan.keepSegments.length).toBe(2);
    const first = plan.keepSegments[0];
    const second = plan.keepSegments[1];
    expect(first.endSec).toBeLessThanOrEqual(1.1);
    expect(second.startSec).toBeGreaterThanOrEqual(2.4);
    expect(plan.pacing.punchInPoints.length).toBeGreaterThan(0);

    // 6) Build an edited video from sourceClip trims + punch-in + styled captions + grade.
    const workspace = path.join(dir, "workspace");
    const project = UltraProject.parse({
      meta: {
        title: "Punchy edit",
        sourceVideoPath: "my_raw.mp4",
        width: 1280,
        height: 720,
        fps: 30,
        durationSec: 2.2,
      },
      designTokens: {
        palette: { bg: C.bg, surface: C.surface, fg: C.textPrimary, muted: C.textMuted, accent: C.accent1, sky: C.accent2 },
        fonts: { heading: "Segoe UI", body: "Segoe UI", mono: "Consolas" },
        grainOpacity: 0.05,
        antiSlopRules: ["style palette locked", "cuts on plan keep-segments", "no banned transitions"],
      },
      colorGrade: { exposure: 0, contrast: 0.04, saturation: 1.02, temperature: 0.04, vignette: 0.08 },
      audio: { targetLufs: -14, duckingDb: -12, sfxCues: [] },
      assets: [],
      scenes: [
        {
          id: "cut-a",
          name: "Hook cut",
          startSec: 0,
          endSec: 1.1,
          engine: "hyperframes",
          background: C.bg,
          transitionIn: { type: "none", durationSec: 0 },
          sourceClip: {
            path: "my_raw.mp4",
            inSec: 0.05,
            outSec: 1.1,
            muteSourceAudio: false,
            jCutLeadSec: 0.08,
            lCutTrailSec: 0,
            scale: 1,
            panX: 0,
            panY: 0,
            cropMode: "cover",
          },
          camera: {
            perspectivePx: 1200,
            keyframes: [
              { atSec: 0, zoom: 1.0, ease: "linear" },
              { atSec: 1.1, zoom: 1.08, ease: "linear" },
            ],
          },
          textElements: [
            {
              id: "cap-a",
              text: "DEAD AIR CUT",
              font: "heading",
              sizePx: 52,
              color: C.textPrimary,
              x: 120,
              y: 520,
              width: 800,
              align: "left",
              weight: 800,
              letterSpacingPx: 1,
              lineHeight: 1.05,
              uppercase: true,
            },
            {
              id: "tag-a",
              text: "STYLE LOCKED",
              font: "mono",
              sizePx: 22,
              color: C.textMuted,
              x: 122,
              y: 596,
              align: "left",
              letterSpacingPx: 3,
              lineHeight: 1.2,
              uppercase: true,
            },
          ],
          keyframes: [
            {
              target: "cap-a",
              property: "opacity",
              keyframes: [
                { atSec: 0, value: 0, ease: "easeOutCubic" },
                { atSec: 0.3, value: 1, ease: "linear" },
              ],
            },
          ],
          enginePayload: {},
        },
        {
          id: "cut-b",
          name: "Punch line",
          startSec: 1.1,
          endSec: 2.2,
          engine: "hyperframes",
          background: C.bg,
          transitionIn: { type: "fade", durationSec: 0.2 },
          sourceClip: {
            path: "my_raw.mp4",
            inSec: 2.55,
            outSec: 3.65,
            muteSourceAudio: false,
            jCutLeadSec: 0,
            lCutTrailSec: 0.12,
            scale: 1,
            panX: 0,
            panY: 0,
            cropMode: "cover",
          },
          textElements: [
            {
              id: "cap-b",
              text: "PUNCHY",
              font: "heading",
              sizePx: 84,
              color: C.accent1,
              x: 120,
              y: 500,
              width: 700,
              align: "left",
              weight: 900,
              letterSpacingPx: 2,
              lineHeight: 1,
              uppercase: true,
              reveal: {
                mode: "chars",
                staggerSec: 0.04,
                durationSec: 0.4,
                delaySec: 0.1,
                from: "up",
                distancePx: 50,
                easing: "easeOutBack",
                mask: true,
              },
            },
          ],
          enginePayload: {},
        },
      ],
    });
    await writeJsonAtomic(path.join(workspace, "ultra.json"), project);

    const validate = await runCli(dir, ["validate-spec"], 120_000);
    expect(validate.code, validate.stderr).toBe(0);
    const build = await runCli(dir, ["build"], 900_000);
    expect(build.code, build.stderr).toBe(0);
    const draft = path.join(dir, "build", "draft.mp4");
    const draftProbe = await ffprobeJson(draft);
    expect(Math.abs(Number(draftProbe.format.duration) - 2.2)).toBeLessThanOrEqual(0.1);

    // 7) Style-aware Rule 5 verification.
    const verify = await runCli(dir, ["verify", "--style", "demo-punchy"], 900_000);
    expect(verify.code, `${verify.stdout}\n${verify.stderr}`).toBe(0);
    const report = JSON.parse(await fs.readFile(path.join(dir, "build", "verify-report.json"), "utf8"));
    expect(report.pass).toBe(true);
    expect(report.quantitative.stutterEvents).toBe(0);
    expect(report.quantitative.jitterOk).toBe(true);
    expect(report.style.slug).toBe("demo-punchy");
    expect(report.style.compliance.pass).toBe(true);
    expect(report.style.compliance.aslOk).toBe(true);
    expect(report.style.compliance.staticHoldOk).toBe(true);
    expect(report.style.compliance.transitionsOk).toBe(true);
    expect(report.style.compliance.paletteOk).toBe(true);
    expect(report.style.compliance.loudnessOk).toBe(true);
    expect(report.style.compliance.paletteDistanceAvg).toBeLessThanOrEqual(110);
    expect(report.style.compliance.details).toEqual(expect.any(Array));
    expect(report.style.matchSheet).toContain("style-match.png");
    const matchSheet = await fs.stat(path.join(dir, "build", "audit-frames", "style-match.png"));
    expect(matchSheet.size).toBeGreaterThan(20_000);

    // 6b/8) Final render is a playable CFR yuv420p MP4.
    const render = await runCli(dir, ["render"], 900_000);
    expect(render.code, render.stderr).toBe(0);
    const finalFile = path.join(dir, "build", "ultra-final.mp4");
    const finalProbe = await ffprobeJson(finalFile);
    const video = finalProbe.streams.find((s: any) => s.codec_type === "video");
    const audio = finalProbe.streams.find((s: any) => s.codec_type === "audio");
    expect(video).toBeTruthy();
    expect(audio).toBeTruthy();
    expect(video.pix_fmt).toBe("yuv420p");
    expect(Math.abs(Number(finalProbe.format.duration) - 2.2)).toBeLessThanOrEqual(0.1);
    await ffmpegOk(["-v", "error", "-i", finalFile, "-f", "null", "-"], { timeoutMs: 120_000 });
  }, 1_500_000);
});
