import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { LintDefectT } from "../../core/schema.js";
import type { LintContext, LintResult, RenderContext, RenderOutcome, SceneEngine } from "../types.js";
import { resolveAssetPath, resolveSourceClipPath } from "../../core/assets.js";
import { loadCaptionsForScene, applyCasing } from "../../core/captions.js";
import { dangerZoneForPixelBox, resolveAspectProfile } from "../../core/safe-zones.js";
import { discoverFonts } from "../../core/env.js";
import { run } from "../../core/ffmpeg.js";
import { ensureDir, pathExists, rmrf, round, tailLines } from "../../core/util.js";

/* ============================================================================
 * ffmpeg-only tier — the last-resort deterministic renderer.
 * No browser, no Python, no Pillow: pure FFmpeg drawtext/drawbox/zoompan/noise
 * driven by the bundled offline TTFs. Used when Chromium AND Pillow are absent
 * (or when ULTRA_FORCE_TIER=ffmpeg-only is set for CI proof).
 * ========================================================================== */

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = hex.match(/^#([0-9a-fA-F]{6})/);
  if (!match || !match[1]) return null;
  const value = parseInt(match[1], 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function relLuminance(hex: string): number | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

function contrastRatio(a: string, b: string): number | null {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  if (la === null || lb === null) return null;
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

function drawtextColor(hex: string): string {
  return "0x" + hex.replace("#", "").slice(0, 8);
}

/** FFmpeg filtergraph: escape backslashes/colons/apostrophes in file paths. */
function escapePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function estimateTextWidth(text: string, sizePx: number): number {
  return text.length * sizePx * 0.56;
}

function ffmpegAvailable(): Promise<boolean> {
  return run("ffmpeg", ["-version"], { timeoutMs: 8000 }).then((r) => r.code === 0).catch(() => false);
}

async function buildDrawtextFilters(
  ctx: RenderContext | LintContext,
  textDir: string,
): Promise<{ filters: string[]; textFiles: string[]; captionBoxes: { id: string; x: number; y: number; width: number; height: number }[] }> {
  const { project, scene, workspace, fps } = ctx;
  const width = ctx.width;
  const height = ctx.height;
  const duration = Math.max(0.05, scene.endSec - scene.startSec);
  const fonts = await discoverFonts(workspace);
  const boldFont = fonts.bold ?? fonts.regular ?? null;
  const regularFont = fonts.regular ?? boldFont;
  const filters: string[] = [];
  const textFiles: string[] = [];
  const captionBoxes: { id: string; x: number; y: number; width: number; height: number }[] = [];

  const writeTextFile = async (name: string, text: string): Promise<string> => {
    const file = path.join(textDir, `${name}.txt`);
    await fs.writeFile(file, text, "utf8");
    textFiles.push(file);
    return file;
  };

  // Declared text elements.
  for (let i = 0; i < scene.textElements.length; i += 1) {
    const el = scene.textElements[i];
    if (!el) continue;
    const raw = el.uppercase ? el.text.toUpperCase() : el.text;
    if (raw.trim().length === 0) continue;
    const size = Math.max(8, Math.round(el.sizePx));
    const file = await writeTextFile(`text_${i}`, raw.replace(/\n+/g, " "));
    const fontFile = (el.weight ?? 500) >= 600 || el.font === "heading" ? boldFont : regularFont;
    const options = [
      `textfile='${escapePath(file)}'`,
      `fontsize=${size}`,
      `fontcolor=${drawtextColor(el.color)}`,
      `x=${Math.round(el.x)}`,
      `y=${Math.round(el.y)}`,
      "fix_bounds=1",
    ];
    if (fontFile) options.push(`fontfile='${escapePath(fontFile)}'`);
    options.push("borderw=2", "bordercolor=0x000000AA");
    void fps;
    void duration;
    filters.push(`drawtext=${options.join(":")}`);
  }

  // Word-level caption chunks from workspace/captions.json (sourceClip scenes).
  const captions = await loadCaptionsForScene(workspace, scene);
  if (captions) {
    const accent = (project.designTokens.palette["accent"] ??
      project.designTokens.palette["accent1"] ??
      Object.values(project.designTokens.palette)[2] ??
      "#ffb703") as string;
    const family = captions.typography.captionFont;
    const useBold = true;
    const fontFile = useBold ? boldFont : regularFont;
    const startBound = scene.startSec;
    const endBound = scene.endSec;
    let index = 0;
    for (const chunk of captions.chunks) {
      if (chunk.endSec <= startBound + 0.001 || chunk.startSec >= endBound - 0.001) continue;
      const localStart = Math.max(0, chunk.startSec - startBound);
      const localEnd = Math.min(duration, chunk.endSec - startBound);
      if (localEnd <= localStart) continue;
      const band = chunk.safeBox;
      const boxX = Math.round((band.xPercent / 100) * width);
      const boxW = Math.round((band.widthPercent / 100) * width);
      const boxY = Math.round((band.yPercent / 100) * height);
      const boxH = Math.round((band.heightPercent / 100) * height);
      const size = Math.max(14, Math.round(Math.min(boxW / Math.max(8, chunk.text.length) * 1.7, height * (height > width ? 0.042 : 0.052))));
      const text = applyCasing(chunk.text, captions.typography.casing);
      const file = await writeTextFile(`caption_${index}`, text);
      const options = [
        `textfile='${escapePath(file)}'`,
        `fontsize=${size}`,
        `fontcolor=${drawtextColor(chunk.emphasis ? accent : "#ffffff")}`,
        "x=(w-text_w)/2",
        `y=${boxY + Math.max(0, Math.round((boxH - size * 1.25) / 2))}`,
        "box=1",
        "boxcolor=0x00000099",
        "boxborderw=16",
        "borderw=2",
        "bordercolor=0x000000CC",
        `enable='between(t,${localStart.toFixed(3)},${localEnd.toFixed(3)})'`,
      ];
      if (fontFile) options.push(`fontfile='${escapePath(fontFile)}'`);
      filters.push(`drawtext=${options.join(":")}`);
      captionBoxes.push({ id: chunk.id, x: boxX, y: boxY, width: boxW, height: boxH });
      index += 1;
    }
    void family;
  }

  return { filters, textFiles, captionBoxes };
}

async function renderViaFfmpeg(ctx: RenderContext): Promise<void> {
  const { project, scene, workspace } = ctx;
  const { width, height, fps } = ctx;
  const duration = ctx.durationSec;
  const frames = Math.max(1, Math.round(duration * fps));
  const tmp = path.join(ctx.buildDir, "tmp");
  await ensureDir(tmp);
  const textDir = path.join(tmp, `ff_${scene.id.replace(/[^\w.-]/g, "_")}`);
  await ensureDir(textDir);

  const { filters: drawFilters, textFiles } = await buildDrawtextFilters(ctx, textDir);
  const args: string[] = ["-hide_banner", "-y"];

  let baseFilter = "";
  if (scene.sourceClip) {
    const sourcePath = await resolveSourceClipPath(workspace, scene.sourceClip.path);
    args.push("-ss", String(scene.sourceClip.inSec), "-t", String(Math.max(0.2, duration + 0.5)), "-i", sourcePath);
    baseFilter = `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},setsar=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=0.5,trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS`;
    const zoomMin = 1 + Math.max(0, (scene.sourceClip.scale - 1) * 0.35);
    const zoomMax = Math.max(zoomMin + 0.003, scene.sourceClip.scale);
    baseFilter += `,zoompan=z='${zoomMin.toFixed(4)}+(${(zoomMax - zoomMin).toFixed(4)})*pow(on/${Math.max(1, frames - 1)},0.55)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps}`;
  } else {
    const bg = scene.background === "transparent" ? "black@0.0" : scene.background;
    args.push("-f", "lavfi", "-i", `color=c=${bg}:s=${width}x${height}:r=${fps}:d=${(duration + 0.2).toFixed(3)}`);
    baseFilter = `trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS`;
    if (!ctx.alpha) {
      // slow deterministic camera drift so static cards still read as motion, never stutter
      const drift = Math.max(1, Math.min(4, scene.camera.keyframes.length));
      if (drift > 0 && scene.camera.keyframes.length > 0) {
        baseFilter += `,zoompan=z='1.02+0.02*pow(on/${Math.max(1, frames - 1)},0.6)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps}`;
      }
    }
  }

  const grade = project.colorGrade;
  const gradeFilters: string[] = [];
  const brightness = Math.max(-1, Math.min(1, grade.exposure * 0.25));
  const contrast = Math.max(0.3, Math.min(2.5, 1 + grade.contrast * 0.35));
  const saturation = Math.max(0, Math.min(3, grade.saturation));
  if (Math.abs(brightness) > 0.001 || Math.abs(contrast - 1) > 0.001 || Math.abs(saturation - 1) > 0.001) {
    gradeFilters.push(`eq=contrast=${contrast.toFixed(3)}:saturation=${saturation.toFixed(3)}:brightness=${brightness.toFixed(3)}`);
  }
  if (Math.abs(grade.temperature) > 0.001) {
    gradeFilters.push(
      `colorbalance=rs=${(grade.temperature * 0.12).toFixed(3)}:gs=${(grade.temperature * 0.02).toFixed(3)}:bs=${(-grade.temperature * 0.12).toFixed(3)}`,
    );
  }

  const effectFilters: string[] = [];
  const grain = Math.max(
    project.designTokens.grainOpacity,
    ...scene.effects.filter((e) => e.type === "grain").map((e) => e.intensity * 0.5),
  );
  if (grain > 0.002) effectFilters.push(`noise=alls=${Math.max(1, Math.round(grain * 24))}:allf=t+u`);
  const vignette = Math.max(project.colorGrade.vignette, ...scene.effects.filter((e) => e.type === "vignette").map((e) => e.intensity));
  if (vignette > 0.01 && !ctx.alpha) effectFilters.push(`vignette=PI/4`);

  const tail = ctx.alpha ? "format=yuva444p10le" : "scale=out_range=tv,format=yuv420p";
  const chain = [baseFilter, ...gradeFilters, ...effectFilters, ...drawFilters, tail].filter(Boolean).join(",");
  args.push("-filter_complex", `[0:v]${chain}[v]`, "-map", "[v]");

  if (ctx.alpha) {
    args.push("-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le");
  } else {
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "16",
      "-pix_fmt",
      "yuv420p",
      "-color_range",
      "tv",
      "-colorspace",
      "bt709",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
    );
  }
  args.push("-r", String(fps), "-fps_mode", "cfr", "-frames:v", String(frames), "-an", ctx.outFile);

  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`ffmpeg-only render failed (ffmpeg ${code}):\n${tailLines(stderr, 14)}`));
      });
    });
  } finally {
    for (const file of textFiles) await rmrf(file);
    await rmrf(textDir);
  }

  if (!(await pathExists(ctx.outFile))) throw new Error(`ffmpeg-only produced no output at ${ctx.outFile}`);
}

export const ffmpegOnlyEngine: SceneEngine = {
  key: "ffmpeg-only",

  async isAvailable(): Promise<boolean> {
    return ffmpegAvailable();
  },

  async lint(ctx: LintContext): Promise<LintResult> {
    const defects: LintDefectT[] = [];
    const { scene, project, workspace, width, height } = ctx;
    const bg = scene.background === "transparent" ? "#000000" : scene.background;
    const aspect = resolveAspectProfile(project.meta);

    const textDir = path.join(ctx.buildDir, "tmp", `fflint_${scene.id.replace(/[^\w.-]/g, "_")}`);
    await ensureDir(textDir);
    let boxInfo: { id: string; x: number; y: number; width: number; height: number }[] = [];
    try {
      const built = await buildDrawtextFilters(ctx, textDir);
      boxInfo = built.captionBoxes;
      for (const file of built.textFiles) await rmrf(file);
    } finally {
      await rmrf(textDir);
    }

    for (const layer of scene.layers) {
      if (!["image", "video", "svg", "png_alpha", "illustration"].includes(layer.type)) continue;
      const asset = project.assets.find((a) => a.id === layer.assetId);
      if (!asset || !(await pathExists(resolveAssetPath(workspace, asset)))) {
        defects.push({
          category: "brokenMedia",
          sceneId: scene.id,
          frameIndex: 0,
          critical: true,
          detail: `layer "${layer.id}" asset missing on disk`,
        });
      }
    }
    if (scene.sourceClip) {
      const source = await resolveSourceClipPath(workspace, scene.sourceClip.path).catch(() => null);
      if (!source || !(await pathExists(source))) {
        defects.push({ category: "brokenMedia", sceneId: scene.id, frameIndex: 0, critical: true, detail: "sourceClip file missing" });
      }
    }

    for (const el of scene.textElements) {
      const estWidth = estimateTestWidthSafe(el.text, el.sizePx, el.width);
      if (el.x < -1 || el.y < -1 || el.x + estWidth > width + 1 || el.y + el.sizePx * 1.4 > height + 1) {
        defects.push({
          category: "clip",
          sceneId: scene.id,
          frameIndex: 0,
          critical: true,
          detail: `text "${el.id}" extends outside the ${width}x${height} viewport`,
        });
      }
      const ratio = contrastRatio(el.color, bg);
      if (ratio !== null && ratio < (el.sizePx >= 24 ? 3 : 4.5)) {
        defects.push({
          category: "contrast",
          sceneId: scene.id,
          frameIndex: 0,
          critical: false,
          detail: `text "${el.id}" contrast ${ratio.toFixed(2)}:1 below ${el.sizePx >= 24 ? 3 : 4.5}:1`,
        });
      }
    }

    if (aspect.explicit) {
      for (const box of boxInfo) {
        const zone = dangerZoneForPixelBox(box, aspect.aspect, width, height);
        if (zone) {
          defects.push({
            category: "layout",
            sceneId: scene.id,
            frameIndex: 0,
            critical: false,
            detail: `caption "${box.id}" enters the ${aspect.aspect} ${zone.label} safe-zone`,
          });
        }
      }
    }

    const hasContent =
      scene.textElements.length > 0 ||
      scene.layers.length > 0 ||
      Boolean(scene.sourceClip) ||
      Boolean(scene.enginePayload["sceneType"]) ||
      scene.engine === "blender";
    if (!hasContent) {
      defects.push({ category: "blankFrame", sceneId: scene.id, frameIndex: 0, critical: true, detail: "frame contains no visible content" });
    }

    return { defects, pass: defects.filter((d) => d.critical).length === 0 };
  },

  async renderScene(ctx: RenderContext): Promise<RenderOutcome> {
    const frames = Math.max(1, Math.round(ctx.durationSec * ctx.fps));
    await ensureDir(path.dirname(ctx.outFile));
    await renderViaFfmpeg(ctx);
    return {
      engineUsed: "ffmpeg-only",
      outFile: ctx.outFile,
      frames,
      durationSec: round(frames / ctx.fps, 6),
      notes: ["ffmpeg-only"],
    };
  },
};

function estimateTestWidthSafe(text: string, sizePx: number, width?: number): number {
  if (width !== undefined) return width;
  return estimateTextWidth(text.replace(/\n/g, " "), sizePx);
}
