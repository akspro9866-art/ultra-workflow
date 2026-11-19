import { promises as fs } from "node:fs";
import path from "node:path";
import { probeReference, extractFrameAt } from "./probe.js";
import { measureJitter } from "./jitter.js";
import { run } from "./ffmpeg.js";
import { renderHtmlToPng } from "./browser.js";
import { StyleProbeAggregate, type StyleProbeAggregateT } from "./style-schema.js";
import { ensureDir, formatTimestamp, round, writeJsonAtomic } from "./util.js";

interface Shot {
  startSec: number;
  endSec: number;
  duration: number;
}

interface SilenceInterval {
  startSec: number;
  endSec: number;
  duration: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return round(sorted[mid] as number, 3);
  return round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2, 3);
}

function sectionStats(values: number[]): { min: number | null; median: number | null; max: number | null } {
  if (values.length === 0) return { min: null, median: null, max: null };
  return {
    min: round(Math.min(...values), 3),
    median: median(values),
    max: round(Math.max(...values), 3),
  };
}

function buildShots(duration: number, cuts: number[]): Shot[] {
  const boundaries = [0, ...cuts.filter((t) => t > 0.08 && t < duration - 0.08), duration].sort((a, b) => a - b);
  const shots: Shot[] = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const start = boundaries[i] as number;
    const end = boundaries[i + 1] as number;
    if (end - start > 0.05) shots.push({ startSec: start, endSec: end, duration: round(end - start, 3) });
  }
  return shots;
}

function classifyShots(shots: Shot[], duration: number, hookWindowSec: number): { hook: number[]; body: number[]; outro: number[] } {
  const outroStart = duration * 0.8;
  const hook: number[] = [];
  const body: number[] = [];
  const outro: number[] = [];
  for (const shot of shots) {
    const midpoint = (shot.startSec + shot.endSec) / 2;
    if (midpoint < hookWindowSec) hook.push(shot.duration);
    else if (midpoint >= outroStart) outro.push(shot.duration);
    else body.push(shot.duration);
  }
  return { hook, body, outro };
}

async function detectSilences(file: string, thresholdDb = -35, minDurSec = 0.15): Promise<SilenceInterval[]> {
  const result = await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-y",
      "-i",
      file,
      "-vn",
      "-af",
      `silencedetect=noise=${thresholdDb}dB:d=${minDurSec}`,
      "-f",
      "null",
      "-",
    ],
    { timeoutMs: 180_000 },
  );
  const intervals: SilenceInterval[] = [];
  const starts = [...result.stderr.matchAll(/silence_start:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  const ends = [...result.stderr.matchAll(/silence_end:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i] as number;
    const end = ends[i] ?? null;
    if (end !== null && Number.isFinite(end)) intervals.push({ startSec: round(start, 3), endSec: round(end, 3), duration: round(end - start, 3) });
  }
  return intervals;
}

async function averageSaturation(file: string): Promise<number> {
  try {
    const result = await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-y",
        "-i",
        file,
        "-vf",
        "signalstats,metadata=print:key=lavfi.signalstats.SATAVG",
        "-an",
        "-f",
        "null",
        "-",
      ],
      { timeoutMs: 180_000 },
    );
    const values = [...result.stderr.matchAll(/lavfi\.signalstats\.SATAVG=([0-9.]+)/g)].map((m) => Number(m[1]));
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return round(Math.min(100, (mean / 255) * 100), 2);
  } catch {
    return 0;
  }
}

const PALETTE_BUCKET = 32;

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "").trim().toLowerCase();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function clampChannel(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v / PALETTE_BUCKET) * PALETTE_BUCKET));
}

function mergePalette(entries: { hex: string; weight: number }[]): { hex: string; share: number }[] {
  const buckets = new Map<string, number>();
  let total = 0;
  for (const entry of entries) {
    const [r, g, b] = hexToRgb(entry.hex);
    const key = `#${[clampChannel(r), clampChannel(g), clampChannel(b)]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")}`;
    buckets.set(key, (buckets.get(key) ?? 0) + entry.weight);
    total += entry.weight;
  }
  return [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([hex, weight]) => ({ hex: hex as string, share: total > 0 ? round(weight / total, 4) : 0 }));
}

function batchOverviewHtml(
  videos: { label: string; sub: string; swatches: string[]; dataUri: string }[],
  title: string,
): { html: string; height: number } {
  const columns = 3;
  const rows = Math.max(1, Math.ceil(videos.length / columns));
  const height = 120 + rows * 348;
  const cells = videos
    .map(
      (video) => `
      <div class="cell">
        <div class="thumb"><img src="${video.dataUri}" alt=""/></div>
        <div class="meta">
          <div class="row"><span class="name">${video.label}</span><span class="sw">${video.swatches
            .map((hex) => `<i style="background:${hex}"></i>`)
            .join("")}</span></div>
          <div class="sub">${video.sub}</div>
        </div>
      </div>`,
    )
    .join("\n");
  return {
    html: `<!doctype html>
<html><head><meta charset="utf-8"/><style>
  html,body{margin:0;padding:0;background:#0b0d10;color:#e8eaed;font-family:"Segoe UI",Arial,sans-serif;width:1600px;height:${height}px;overflow:hidden}
  .head{display:flex;justify-content:space-between;align-items:baseline;padding:22px 28px 10px}
  .title{font-size:22px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
  .sub{font-size:13px;color:#9aa0a6;letter-spacing:.08em}
  .grid{display:grid;grid-template-columns:repeat(${columns},1fr);gap:16px;padding:0 28px 24px}
  .cell{background:#14171c;border:1px solid #23272e;border-radius:8px;overflow:hidden;display:flex;flex-direction:column}
  .thumb{height:250px;background:#000;display:flex;align-items:center;justify-content:center}
  .thumb img{max-width:100%;max-height:100%;object-fit:contain;display:block}
  .meta{border-top:1px solid #23272e;padding:10px 12px;display:flex;flex-direction:column;gap:6px;background:#101318}
  .row{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .name{font-weight:600;color:#8ab4f8;font-size:15px}
  .sw{display:inline-flex;gap:3px}
  .sw i{width:12px;height:12px;border-radius:3px;border:1px solid rgba(255,255,255,.2)}
  .sub{font-size:12px;color:#9aa0a6}
</style></head>
<body>
  <div class="head"><div class="title">${title}</div><div class="sub">STYLE PROBE · ${videos.length} reference${videos.length === 1 ? "" : "s"}</div></div>
  <div class="grid">${cells}</div>
</body></html>`,
    height,
  };
}

export interface StyleProbeResult {
  outputDir: string;
  aggregate: StyleProbeAggregateT;
}

/** Batch style probe across 1–10 reference videos (Process 1 · Rule-style analysis). */
export async function styleProbe(videos: string[], outDirInput: string, hookWindowSec = 5): Promise<StyleProbeResult> {
  if (videos.length < 1 || videos.length > 10) {
    throw new Error(`style-probe accepts 1 to 10 videos (got ${videos.length})`);
  }
  const outDir = path.resolve(outDirInput);
  await fs.rm(outDir, { recursive: true, force: true });
  await ensureDir(outDir);
  const candidatesDir = path.join(outDir, "candidates");
  await ensureDir(candidatesDir);

  const aggregateVideos: StyleProbeAggregateT["videos"] = [];
  const candidates: string[] = [];
  const overviewCells: { label: string; sub: string; swatches: string[]; dataUri: string }[] = [];
  const hookAslAll: number[] = [];
  const bodyAslAll: number[] = [];
  const outroAslAll: number[] = [];
  let maxHold = 0;
  let silenceMedianAll = 0;
  let silenceAvgAll = 0;
  let beatSnapWeighted = 0;
  let cutCountAll = 0;
  const paletteEntries: { hex: string; weight: number }[] = [];
  let lumSum = 0;
  let contrastSum = 0;
  let satSum = 0;

  for (let i = 0; i < videos.length; i += 1) {
    const source = path.resolve(videos[i] as string);
    await fs.access(source).catch(() => {
      throw new Error(`Reference video not found: ${source}`);
    });
    const refName = `ref-${String(i + 1).padStart(2, "0")}`;
    const probeDir = path.join(outDir, refName);
    await ensureDir(probeDir);
    const probe = await probeReference(source, probeDir);
    const shots = buildShots(probe.durationSec, probe.cutsSec);
    const sections = classifyShots(shots, probe.durationSec, hookWindowSec);
    const hookAsl = sections.hook.length > 0 ? round(sections.hook.reduce((a, b) => a + b, 0) / sections.hook.length, 3) : null;
    const bodyAsl = sections.body.length > 0 ? round(sections.body.reduce((a, b) => a + b, 0) / sections.body.length, 3) : null;
    const outroAsl = sections.outro.length > 0 ? round(sections.outro.reduce((a, b) => a + b, 0) / sections.outro.length, 3) : null;
    if (hookAsl !== null) hookAslAll.push(hookAsl);
    if (bodyAsl !== null) bodyAslAll.push(bodyAsl);
    if (outroAsl !== null) outroAslAll.push(outroAsl);

    let longestHold = 0;
    try {
      const totalFrames = Math.max(1, Math.round(probe.durationSec * probe.fps.numeric));
      longestHold = (await measureJitter(source, probe.fps.numeric, totalFrames)).maxStaticHoldSec;
    } catch {
      longestHold = 0;
    }
    maxHold = Math.max(maxHold, longestHold);

    const silences = await detectSilences(source);
    const silenceDurations = silences.map((s) => s.duration);
    const silenceCount = silences.length;
    const silenceAvg = silenceDurations.length > 0 ? round(silenceDurations.reduce((a, b) => a + b, 0) / silenceDurations.length, 3) : 0;
    const silenceMed = median(silenceDurations) ?? 0;
    const silenceMax = silenceDurations.length > 0 ? round(Math.max(...silenceDurations), 3) : 0;
    silenceMedianAll = silenceMed;
    silenceAvgAll = silenceAvg;

    const beatSet = [...probe.onsetsSec];
    try {
      const envelope = JSON.parse(await fs.readFile(path.join(probeDir, "audio-envelope.json"), "utf8")) as { beatsSec?: number[] };
      for (const beat of envelope.beatsSec ?? []) beatSet.push(beat);
    } catch {
      // envelope optional
    }
    beatSet.sort((a, b) => a - b);
    let snapped = 0;
    for (const cut of probe.cutsSec) {
      if (beatSet.some((beat) => Math.abs(beat - cut) <= 0.1)) snapped += 1;
    }
    const beatSnapRatio = probe.cutsSec.length > 0 ? round(snapped / probe.cutsSec.length, 3) : 0;
    beatSnapWeighted += snapped;
    cutCountAll += probe.cutsSec.length;

    const durationShares = probe.scenes.length > 0
      ? probe.scenes.map((scene) => ({ scene, weight: scene.endSec - scene.startSec }))
      : [];
    for (const { scene, weight } of durationShares) {
      for (const color of scene.colors) paletteEntries.push({ hex: color.hex, weight: color.share * weight });
    }
    const avgLuminance = probe.scenes.length > 0
      ? round(probe.scenes.reduce((acc, scene) => acc + scene.avgLuminance * (scene.endSec - scene.startSec), 0) / Math.max(0.001, probe.durationSec), 4)
      : 0;
    const contrast = probe.scenes.length > 0
      ? round(probe.scenes.reduce((acc, scene) => acc + scene.contrast, 0) / probe.scenes.length, 4)
      : 0;
    const avgSaturation = await averageSaturation(source);
    lumSum += avgLuminance;
    contrastSum += contrast;
    satSum += avgSaturation;

    const videoPalette = mergePalette(
      probe.scenes.flatMap((scene) => scene.colors.map((c) => ({ hex: c.hex, weight: c.share * (scene.endSec - scene.startSec) }))),
    );

    // Candidate exemplar stills (4–6 per reference, cut-avoiding).
    const fractions = [0.16, 0.32, 0.5, 0.68, 0.84];
    for (let c = 0; c < fractions.length; c += 1) {
      let at = round(probe.durationSec * (fractions[c] as number), 3);
      for (const cut of probe.cutsSec) if (Math.abs(cut - at) < 0.25) at = Math.min(probe.durationSec - 0.1, at + 0.3);
      const candidateFile = path.join(candidatesDir, `${refName}-cand-${String(c + 1).padStart(2, "0")}.png`);
      await extractFrameAt(source, at, candidateFile, 960);
      candidates.push(path.relative(outDir, candidateFile));
      if (c === 1) {
        const buffer = await fs.readFile(candidateFile);
        overviewCells.push({
          label: path.basename(source),
          sub: `${probe.width}x${probe.height} · ${probe.durationSec}s · ${probe.cutsSec.length} cuts · hook ${hookAsl ?? "—"}s / body ${bodyAsl ?? "—"}s @ ${formatTimestamp(at)}`,
          swatches: videoPalette.map((c2) => c2.hex),
          dataUri: `data:image/png;base64,${buffer.toString("base64")}`,
        });
      }
    }

    aggregateVideos.push({
      source,
      probeDir: path.relative(outDir, probeDir),
      durationSec: probe.durationSec,
      fps: probe.fps.numeric,
      width: probe.width,
      height: probe.height,
      cutCount: probe.cutsSec.length,
      hookAslSec: hookAsl,
      bodyAslSec: bodyAsl,
      outroAslSec: outroAsl,
      longestStaticHoldSec: longestHold,
      silence: { thresholdDb: -35, count: silenceCount, avgSec: silenceAvg, medianSec: silenceMed, maxSec: silenceMax },
      beatSnapRatio,
      palette: videoPalette,
      avgLuminance,
      contrast,
      avgSaturation,
      contactSheets: probe.contactSheets,
    });
  }

  const overview = batchOverviewHtml(overviewCells, "ULTRA · style probe batch overview");
  const overviewPng = path.join(outDir, "batch-overview.png");
  await renderHtmlToPng(overview.html, 1600, overview.height, overviewPng);

  const palette = mergePalette(paletteEntries);
  const aggregate: StyleProbeAggregateT = {
    generatedAt: new Date().toISOString(),
    videos: aggregateVideos,
    sections: {
      hook: sectionStats(hookAslAll),
      body: sectionStats(bodyAslAll),
      outro: sectionStats(outroAslAll),
    },
    pacing: {
      maxStaticHoldSec: round(maxHold, 3),
      silenceTrimMsSuggested: Math.min(500, Math.max(80, Math.round(silenceAvgAll * 250))),
      beatSnapRatio: cutCountAll > 0 ? round(beatSnapWeighted / cutCountAll, 3) : 0,
    },
    palette,
    avgLuminance: round(lumSum / videos.length, 4),
    avgContrast: round(contrastSum / videos.length, 4),
    avgSaturation: round(satSum / videos.length, 2),
    candidates,
    overviewPng: path.relative(outDir, overviewPng),
  };
  StyleProbeAggregate.parse(aggregate);
  await writeJsonAtomic(path.join(outDir, "aggregate.json"), aggregate);
  void silenceMedianAll;
  return { outputDir: outDir, aggregate };
}
