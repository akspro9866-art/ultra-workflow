import { promises as fs } from "node:fs";
import path from "node:path";
import { run } from "../core/ffmpeg.js";
import { ensureDir, round } from "../core/util.js";

/**
 * [25] verify --full: SSIM for EVERY frame, streamed through the FFmpeg ssim
 * filter (stats_file=-) — frames are never loaded into RAM. The sampled audit
 * remains the fast default; a claim of "matches reference" requires --full.
 */

export interface FullAuditEntry {
  frame: number;
  timestampSec: number;
  ssim: number;
}

export interface FullAuditResult {
  frameCount: number;
  mean: number | null;
  p10: number | null;
  worst20: FullAuditEntry[];
  thumbnails: string[];
}

export async function fullFrameAudit(opts: {
  reference: string;
  draft: string;
  fps: number;
  outDir: string;
}): Promise<FullAuditResult> {
  const result = await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      opts.reference,
      "-i",
      opts.draft,
      "-filter_complex",
      "[0:v]scale=480:270:flags=area,format=yuv420p[r];[1:v]scale=480:270:flags=area,format=yuv420p[d];[r][d]ssim=stats_file=-",
      "-an",
      "-f",
      "null",
      "-",
    ],
    { timeoutMs: 60 * 60_000, maxBuffer: 256 * 1024 * 1024 },
  );
  const entries: FullAuditEntry[] = [];
  const re = /n:\s*(\d+)[^\n]*?All:\s*([0-9]+(?:\.[0-9]+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(result.stdout)) !== null) {
    const frame = Number(match[1]);
    const ssim = Number(match[2]);
    if (!Number.isFinite(frame) || !Number.isFinite(ssim)) continue;
    entries.push({ frame: frame - 1, timestampSec: round((frame - 1) / opts.fps, 3), ssim });
  }
  if (entries.length === 0) {
    throw new Error(`verify --full: SSIM produced no frame stats (ffmpeg exit ${result.code}):\n${result.stderr.split("\n").slice(-4).join("\n")}`);
  }
  const values = entries.map((entry) => entry.ssim).sort((a, b) => a - b);
  const mean = round(values.reduce((a, b) => a + b, 0) / values.length, 6);
  const p10 = round(values[Math.max(0, Math.floor(0.1 * (values.length - 1)))] as number, 6);
  const worst20 = [...entries].sort((a, b) => a.ssim - b.ssim).slice(0, 20);

  await ensureDir(opts.outDir);
  const thumbnails: string[] = [];
  for (let i = 0; i < Math.min(5, worst20.length); i += 1) {
    const entry = worst20[i] as FullAuditEntry;
    const out = path.join(opts.outDir, `worst_${String(i + 1).padStart(2, "0")}_f${String(entry.frame).padStart(5, "0")}.png`);
    const runThumb = await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-ss",
        entry.timestampSec.toFixed(3),
        "-i",
        opts.reference,
        "-ss",
        entry.timestampSec.toFixed(3),
        "-i",
        opts.draft,
        "-filter_complex",
        "[0:v]scale=760:428:force_original_aspect_ratio=decrease,pad=760:428:(ow-iw)/2:(oh-ih)/2:color=black[a];" +
          "[1:v]scale=760:428:force_original_aspect_ratio=decrease,pad=760:428:(ow-iw)/2:(oh-ih)/2:color=black[b];" +
          "[a][b]hstack=inputs=2[out]",
        "-map",
        "[out]",
        "-frames:v",
        "1",
        "-y",
        out,
      ],
      { timeoutMs: 120_000 },
    );
    if (runThumb.code === 0) thumbnails.push(out);
    await fs.access(out).catch(() => undefined);
  }
  return { frameCount: entries.length, mean, p10, worst20, thumbnails };
}
