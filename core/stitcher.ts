import { promises as fs } from "node:fs";
import path from "node:path";
import { ffmpegOk, ffprobeJson } from "./ffmpeg.js";
import type { SceneSpecT, UltraProjectT } from "./schema.js";
import { resolveAssetPath, resolveSourceClipPath } from "./assets.js";
import { ensureDir, pathExists, resolveInside, round } from "./util.js";

export interface StitchClip {
  sceneId: string;
  file: string;
  startSec: number;
  endSec: number;
  /** Rendered duration (may include transition tail beyond endSec). */
  durationSec: number;
}

export interface StitchOptions {
  project: UltraProjectT;
  workspace: string;
  buildDir: string;
  clips: StitchClip[];
  outFile: string;
  crf?: number;
  preset?: string;
}

export interface StitchResult {
  outFile: string;
  durationSec: number;
  hasAudio: boolean;
  transitionCount: number;
  overlayCount: number;
}

const XFADE_MAP: Record<string, string> = {
  fade: "fade",
  wipeleft: "wipeleft",
  wiperight: "wiperight",
  slideup: "slideup",
  circleopen: "circleopen",
};

export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function sceneById(project: UltraProjectT, id: string): SceneSpecT {
  const scene = project.scenes.find((s) => s.id === id);
  if (!scene) throw new Error(`stitcher: unknown scene "${id}"`);
  return scene;
}

/**
 * [28] Resolve every SFX cue to absolute seconds. Scene-anchored cues follow
 * the scene's CURRENT startSec at stitch time, so a retime never orphans them.
 */
export function resolveSfxCueTimes(project: UltraProjectT): { cue: UltraProjectT["audio"]["sfxCues"][number]; atSec: number }[] {
  return project.audio.sfxCues.map((cue) => {
    if (cue.sceneId !== undefined && cue.offsetSec !== undefined) {
      const scene = sceneById(project, cue.sceneId);
      return { cue, atSec: round(Math.max(0, scene.startSec + cue.offsetSec), 3) };
    }
    return { cue, atSec: round(cue.atSec ?? 0, 3) };
  });
}

interface Run {
  clips: StitchClip[];
  startSec: number;
  endSec: number;
  /** Timeline seconds where this run joins the previous run. */
  transitionType: string;
  transitionDuration: number;
}

function groupRuns(project: UltraProjectT, mainClips: StitchClip[]): Run[] {
  const runs: Run[] = [];
  let current: Run | null = null;
  for (let i = 0; i < mainClips.length; i += 1) {
    const clip = mainClips[i] as StitchClip;
    const scene = sceneById(project, clip.sceneId);
    const transition = scene.transitionIn;
    const previous = mainClips[i - 1];
    if (previous && Math.abs(clip.startSec - previous.endSec) > 0.06) {
      throw new Error(
        `stitcher: timeline gap between "${previous.sceneId}" (end ${previous.endSec}s) and "${clip.sceneId}" (start ${clip.startSec}s)`,
      );
    }
    const needsJoin = transition.type !== "none" && transition.durationSec > 0 && i > 0;
    if (!current || needsJoin) {
      if (current) runs.push(current);
      current = {
        clips: [clip],
        startSec: clip.startSec,
        endSec: clip.endSec,
        transitionType: needsJoin ? (XFADE_MAP[transition.type] ?? "fade") : "none",
        transitionDuration: needsJoin ? transition.durationSec : 0,
      };
    } else {
      current.clips.push(clip);
      current.endSec = clip.endSec;
    }
  }
  if (current) runs.push(current);
  return runs;
}

function buildGradeChain(project: UltraProjectT, workspace: string, inputLabel: string): { chain: string; outLabel: string } {
  const grade = project.colorGrade;
  const filters: string[] = [];
  if (grade.lutPath) {
    const lut = resolveInside(workspace, grade.lutPath);
    filters.push(`lut3d=file='${escapeFilterPath(lut)}'`);
  }
  if (grade.exposure !== 0 || grade.contrast !== 0 || grade.saturation !== 1) {
    filters.push(
      `eq=brightness=${round(grade.exposure * 0.12, 4)}:contrast=${round(1 + grade.contrast * 0.5, 4)}:saturation=${round(grade.saturation, 4)}`,
    );
  }
  if (grade.temperature !== 0) {
    const t = round(grade.temperature * 0.12, 4);
    filters.push(`colorbalance=rs=${t}:bs=${round(-t, 4)}:rm=${round(t * 0.5, 4)}:bm=${round(-t * 0.5, 4)}`);
  }
  if (grade.vignette > 0) {
    const angle = round(Math.PI / (10 - 8 * grade.vignette), 5);
    filters.push(`vignette=angle=${angle}`);
  }
  // Normalize range metadata (some engines emit full-range yuvj) to broadcast
  // limited-range yuv420p before delivery encoding.
  filters.push("scale=out_range=tv");
  filters.push("format=yuv420p");
  const outLabel = "vgraded";
  return { chain: `[${inputLabel}]${filters.join(",")}[${outLabel}]`, outLabel };
}

export async function stitchTimeline(opts: StitchOptions): Promise<StitchResult> {
  const { project, workspace, buildDir } = opts;
  const fps = project.meta.fps;
  const width = project.meta.width;
  const height = project.meta.height;
  const durationSec = project.meta.durationSec;

  const mainClips = opts.clips
    .filter((c) => !sceneById(project, c.sceneId).overlayOfSceneId)
    .sort((a, b) => a.startSec - b.startSec);
  const overlayClips = opts.clips
    .filter((c) => Boolean(sceneById(project, c.sceneId).overlayOfSceneId))
    .sort((a, b) => a.startSec - b.startSec);
  if (mainClips.length === 0) throw new Error("stitcher: no main timeline clips");

  for (const clip of mainClips) {
    if (!(await pathExists(clip.file))) throw new Error(`stitcher: missing rendered clip for "${clip.sceneId}": ${clip.file}`);
    const scene = sceneById(project, clip.sceneId);
    const needed = scene.endSec - scene.startSec;
    if (clip.durationSec + 0.02 < needed) {
      throw new Error(
        `stitcher: clip "${clip.sceneId}" renders ${clip.durationSec}s but scene needs ${needed}s plus transition tail`,
      );
    }
  }
  for (const clip of overlayClips) {
    if (!(await pathExists(clip.file))) throw new Error(`stitcher: missing overlay clip for "${clip.sceneId}": ${clip.file}`);
  }

  const runs = groupRuns(project, mainClips);
  const tmpDir = path.join(buildDir, "tmp");
  await ensureDir(tmpDir);

  // 1) Concatenate each run's clips (identical encodes, exact CFR).
  const runFiles: string[] = [];
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i] as Run;
    if (run.clips.length === 1) {
      runFiles.push((run.clips[0] as StitchClip).file);
      continue;
    }
    const listFile = path.join(tmpDir, `run_${i}.txt`);
    const lines = run.clips.map((c) => `file '${c.file.replace(/'/g, "'\\''")}'`);
    await fs.writeFile(listFile, lines.join("\n"), "utf8");
    const out = path.join(tmpDir, `run_${i}.mp4`);
    await ffmpegOk([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-r",
      String(fps),
      "-fps_mode",
      "cfr",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "16",
      "-pix_fmt",
      "yuv420p",
      "-an",
      out,
    ]);
    runFiles.push(out);
  }

  // 2) Assemble final pass: xfade run joins, alpha overlays, color grade, audio mix.
  const args: string[] = [];
  for (const file of runFiles) args.push("-i", file);
  const overlayBaseIndex = runFiles.length;
  for (const clip of overlayClips) args.push("-i", clip.file);

  const audioAssets = project.audio;
  const assetById = (id: string | undefined) => project.assets.find((a) => a.id === id) ?? null;
  const musicAsset = assetById(audioAssets.musicAssetId);
  const voiceAsset = assetById(audioAssets.voiceAssetId);
  const resolvedCues = resolveSfxCueTimes(project);
  const sfxAssets = resolvedCues
    .map(({ cue, atSec }) => ({ cue, atSec, asset: assetById(cue.assetId) }))
    .filter((v): v is { cue: (typeof audioAssets.sfxCues)[number]; atSec: number; asset: NonNullable<ReturnType<typeof assetById>> } => Boolean(v.asset));

  let nextInput = overlayBaseIndex + overlayClips.length;
  let musicIndex = -1;
  let voiceIndex = -1;
  if (musicAsset) {
    musicIndex = nextInput++;
    args.push("-i", resolveAssetPath(workspace, musicAsset));
  }
  if (voiceAsset) {
    voiceIndex = nextInput++;
    args.push("-i", resolveAssetPath(workspace, voiceAsset));
  }
  const sfxIndices: number[] = [];
  for (const { asset } of sfxAssets) {
    sfxIndices.push(nextInput++);
    args.push("-i", resolveAssetPath(workspace, asset));
  }

  const filters: string[] = [];
  for (let i = 0; i < runFiles.length; i += 1) {
    filters.push(`[${i}:v]fps=${fps},settb=AVTB,format=yuv420p[rv${i}]`);
  }
  let currentV = "rv0";
  let transitionCount = 0;
  for (let i = 1; i < runs.length; i += 1) {
    const run = runs[i] as Run;
    const offset = round(run.startSec, 3);
    const dur = round(run.transitionDuration, 3);
    const label = `vx${i}`;
    filters.push(`[${currentV}][rv${i}]xfade=transition=${run.transitionType}:duration=${dur}:offset=${offset}[${label}]`);
    currentV = label;
    transitionCount += 1;
  }
  let overlayCount = 0;
  for (let i = 0; i < overlayClips.length; i += 1) {
    const clip = overlayClips[i] as StitchClip;
    const scene = sceneById(project, clip.sceneId);
    const length = round(scene.endSec - scene.startSec, 3);
    const idx = overlayBaseIndex + i;
    filters.push(
      `[${idx}:v]trim=duration=${length},setpts=PTS-STARTPTS+${round(clip.startSec, 3)}/TB,format=rgba[ov${i}]`,
    );
    filters.push(
      `[${currentV}][ov${i}]overlay=x=0:y=0:eof_action=pass:enable='between(t,${round(clip.startSec, 3)},${round(
        clip.startSec + length,
        3,
      )})'[vov${i}]`,
    );
    currentV = `vov${i}`;
    overlayCount += 1;
  }

  const grade = buildGradeChain(project, workspace, currentV);
  let filterGraph = `${filters.join(";")};${grade.chain}`;

  // Process 2B: trimmed audio from the user's own source clips (J-cuts / L-cuts).
  interface SourceAudioEntry {
    index: number;
    startSec: number;
    inSec: number;
    outSec: number;
    jCutLeadSec: number;
    lCutTrailSec: number;
  }
  const sourceAudioEntries: SourceAudioEntry[] = [];
  const audioPresence = new Map<string, boolean>();
  for (const sourceScene of project.scenes
    .filter((s) => s.sourceClip && !s.sourceClip.muteSourceAudio)
    .sort((a, b) => a.startSec - b.startSec)) {
    const clip = sourceScene.sourceClip;
    if (!clip) continue;
    let file: string;
    try {
      file = await resolveSourceClipPath(workspace, clip.path);
    } catch {
      continue;
    }
    if (!audioPresence.has(file)) {
      try {
        const probe = await ffprobeJson(file);
        audioPresence.set(file, (probe.streams ?? []).some((s: any) => s.codec_type === "audio"));
      } catch {
        audioPresence.set(file, false);
      }
    }
    if (!audioPresence.get(file)) continue;
    const index = nextInput++;
    args.push("-i", file);
    sourceAudioEntries.push({
      index,
      startSec: sourceScene.startSec,
      inSec: clip.inSec,
      outSec: clip.outSec,
      jCutLeadSec: clip.jCutLeadSec,
      lCutTrailSec: clip.lCutTrailSec,
    });
  }

  const hasAnyAudio = Boolean(musicAsset || voiceAsset || sfxAssets.length > 0 || sourceAudioEntries.length > 0);
  if (hasAnyAudio) {
    const audioChains: string[] = [];
    const mixLabels: string[] = [];
    const durStr = round(durationSec, 3);
    if (musicIndex >= 0) {
      audioChains.push(
        `[${musicIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${durStr},atrim=0:${durStr}[music]`,
      );
    }
    if (voiceIndex >= 0) {
      audioChains.push(
        `[${voiceIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${durStr},atrim=0:${durStr}[voice]`,
      );
    }
    if (musicIndex >= 0 && voiceIndex >= 0) {
      audioChains.push(`[voice]asplit=2[voiceMix][voiceKey]`);
      audioChains.push(
        `[music][voiceKey]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=320:level_sc=1[musicDuck]`,
      );
      mixLabels.push("[musicDuck]", "[voiceMix]");
    } else {
      if (musicIndex >= 0) mixLabels.push("[music]");
      if (voiceIndex >= 0) mixLabels.push("[voice]");
    }
    sfxAssets.forEach(({ cue, atSec }, i) => {
      const label = `sfx${i}`;
      audioChains.push(
        `[${sfxIndices[i]}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${round(
          cue.gainDb,
          2,
        )}dB,adelay=${Math.round(atSec * 1000)}|${Math.round(atSec * 1000)},apad=whole_dur=${durStr},atrim=0:${durStr}[${label}]`,
      );
      mixLabels.push(`[${label}]`);
    });
    sourceAudioEntries.forEach((entry, i) => {
      const label = `sclip${i}`;
      const audioIn = Math.max(0, entry.inSec - entry.jCutLeadSec);
      const audioOut = Math.max(audioIn + 0.05, entry.outSec + entry.lCutTrailSec);
      const delayMs = Math.round(Math.max(0, entry.startSec) * 1000);
      audioChains.push(
        `[${entry.index}:a]atrim=start=${audioIn.toFixed(3)}:end=${audioOut.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${delayMs}|${delayMs},apad=whole_dur=${durStr},atrim=0:${durStr}[${label}]`,
      );
      mixLabels.push(`[${label}]`);
    });
    const mixCount = mixLabels.length;
    audioChains.push(`${mixLabels.join("")}amix=inputs=${mixCount}:duration=longest:dropout_transition=0:normalize=0[mixed]`);
    audioChains.push(`[mixed]alimiter=limit=0.891:attack=5:release=50[limited]`);
    audioChains.push(
      `[limited]loudnorm=I=${round(project.audio.targetLufs, 1)}:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo[aout]`,
    );
    filterGraph += `;${audioChains.join(";")}`;
  }

  await ensureDir(path.dirname(opts.outFile));
  const encodeArgs = [
    ...args,
    "-filter_complex",
    filterGraph,
    "-map",
    `[${grade.outLabel}]`,
    ...(hasAnyAudio ? ["-map", "[aout]"] : []),
    "-r",
    String(fps),
    "-fps_mode",
    "cfr",
    "-t",
    String(round(durationSec, 3)),
    "-c:v",
    "libx264",
    "-preset",
    opts.preset ?? "medium",
    "-crf",
    String(opts.crf ?? 18),
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
    ...(hasAnyAudio ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"] : []),
    "-movflags",
    "+faststart",
    opts.outFile,
  ];
  await ffmpegOk(encodeArgs, { timeoutMs: 30 * 60_000 });

  return {
    outFile: opts.outFile,
    durationSec: round(durationSec, 3),
    hasAudio: hasAnyAudio,
    transitionCount,
    overlayCount,
  };
}
