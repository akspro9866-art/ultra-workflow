import { promises as fs } from "node:fs";
import path from "node:path";
import type { AspectProfileT, SceneSpecT } from "./schema.js";
import { captionSafeBox, safeZonesFor, type CaptionSafeBox } from "./safe-zones.js";
import { pathExists } from "./util.js";

/* ============================================================================
 * Word-level caption engine
 * SRT / VTT / word-JSON parsing + deterministic speech-burst forced alignment
 * for script + audio-envelope inputs (ChatGPT/Muse chats without an SRT).
 * ========================================================================== */

export interface CaptionWord {
  text: string;
  startSec: number;
  endSec: number;
  isKeyword: boolean;
}

export interface CaptionChunk {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
  words: CaptionWord[];
  emphasis: boolean;
  safeBox: CaptionSafeBox;
}

export interface CaptionTypography {
  captionFont: string;
  casing: "upper" | "title" | "sentence" | "mixed";
  activeWordHighlight: "color" | "pill" | "scale" | "underline" | "none";
  strokePx: number;
}

export interface CaptionsDoc {
  version: 1;
  createdAt: string;
  aspect: AspectProfileT;
  source: { kind: "srt" | "vtt" | "words" | "script-forced"; input: string };
  style: string | null;
  typography: CaptionTypography;
  safeZones: ReturnType<typeof safeZonesFor>;
  stats: { words: number; chunks: number; activeSpeechSec: number };
  chunks: CaptionChunk[];
}

interface RawWord {
  text: string;
  startSec: number;
  endSec: number;
  keywordHint?: boolean;
}

const KEYWORD_LIST = new Set(
  [
    "now",
    "free",
    "new",
    "never",
    "stop",
    "fast",
    "faster",
    "fastest",
    "best",
    "worst",
    "easy",
    "instantly",
    "today",
    "secret",
    "proven",
    "guaranteed",
    "warning",
    "mistake",
    "truth",
    "hack",
    "boost",
    "double",
    "triple",
    "zero",
    "only",
    "everything",
    "nobody",
    "always",
  ].map((w) => w.toLowerCase()),
);

export function isKeywordWord(word: string, keywordHint = false): boolean {
  if (keywordHint) return true;
  const clean = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%$€£]+$/gu, "");
  if (clean.length === 0) return false;
  if (/[0-9]/.test(clean)) return true;
  if (/[%$€£]/.test(word)) return true;
  if (/^[A-Z0-9][A-Z0-9'’-]{2,}$/.test(clean) && clean === clean.toUpperCase()) return true;
  return KEYWORD_LIST.has(clean.toLowerCase());
}

function parseTimestamp(raw: string): number {
  const text = raw.trim().replace(",", ".");
  const parts = text.split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p))) throw new Error(`invalid timestamp "${raw}"`);
  if (parts.length === 3) return (parts[0] as number) * 3600 + (parts[1] as number) * 60 + (parts[2] as number);
  if (parts.length === 2) return (parts[0] as number) * 60 + (parts[1] as number);
  return parts[0] as number;
}

function cleanCueText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export interface Cue {
  startSec: number;
  endSec: number;
  text: string;
}

export function parseSrt(content: string): Cue[] {
  const blocks = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    const timingIndex = lines.findIndex((l) => l.includes("-->"));
    if (timingIndex === -1) continue;
    const [from, to] = (lines[timingIndex] as string).split("-->");
    try {
      const startSec = parseTimestamp(from ?? "");
      const endSec = parseTimestamp((to ?? "").trim().split(/\s+/)[0] ?? "");
      const text = cleanCueText(lines.slice(timingIndex + 1).join(" "));
      if (text.length > 0 && endSec > startSec) cues.push({ startSec, endSec, text });
    } catch {
      // ignore malformed cue
    }
  }
  return cues;
}

export function parseVtt(content: string): Cue[] {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    if (/^WEBVTT/.test(lines[0] as string) || /^NOTE/.test(lines[0] as string)) continue;
    const timingIndex = lines.findIndex((l) => l.includes("-->"));
    if (timingIndex === -1) continue;
    const [from, to] = (lines[timingIndex] as string).split("-->");
    try {
      const startSec = parseTimestamp(from ?? "");
      const endSec = parseTimestamp((to ?? "").trim().split(/\s+/)[0] ?? "");
      const text = cleanCueText(lines.slice(timingIndex + 1).join(" "));
      if (text.length > 0 && endSec > startSec) cues.push({ startSec, endSec, text });
    } catch {
      // ignore malformed cue
    }
  }
  return cues;
}

export function wordsFromCues(cues: Cue[]): RawWord[] {
  return normalizeWordTimings(cues.flatMap(distributeWordsInCue));
}

function distributeWordsInCue(cue: Cue): RawWord[] {
  const tokens = cue.text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const weights = tokens.map(syllableWeight);
  const total = weights.reduce((a, b) => a + b, 0);
  const span = cue.endSec - cue.startSec;
  const words: RawWord[] = [];
  let cursor = cue.startSec;
  for (let i = 0; i < tokens.length; i += 1) {
    const isLast = i === tokens.length - 1;
    const duration = isLast ? cue.endSec - cursor : (span * (weights[i] as number)) / total;
    const endSec = isLast ? cue.endSec : Math.min(cue.endSec, cursor + Math.max(0.001, duration));
    words.push({ text: tokens[i] as string, startSec: round3(cursor), endSec: round3(endSec) });
    cursor = endSec;
  }
  return words;
}

function syllableWeight(word: string): number {
  const clean = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (clean.length === 0) return 1;
  const groups = clean.match(/[aeiouy]+/g)?.length ?? 0;
  return Math.max(1, groups) * 0.7 + Math.max(2, clean.length) * 0.15;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface AudioEnvelopeLike {
  fps: number;
  durationSec: number;
  frames: number[];
  beatsSec?: number[];
}

export interface SpeechWindow {
  startSec: number;
  endSec: number;
}

/** Segment active speech windows from an RMS envelope, bridging micro-gaps. */
export function speechWindows(envelope: AudioEnvelopeLike): SpeechWindow[] {
  const frames = envelope.frames ?? [];
  const fps = envelope.fps > 0 ? envelope.fps : 100;
  if (frames.length === 0) return [{ startSec: 0, endSec: Math.max(0.1, envelope.durationSec) }];
  const max = Math.max(...frames);
  const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
  const threshold = Math.max(0.06, Math.min(0.35, mean + (max - mean) * 0.18, max * 0.35));
  const frameSec = 1 / fps;
  const windows: SpeechWindow[] = [];
  let open: number | null = null;
  let lastActive = -1;
  for (let i = 0; i < frames.length; i += 1) {
    const active = (frames[i] as number) >= threshold;
    if (active) {
      if (open === null) open = i * frameSec;
      lastActive = i;
    } else if (open !== null) {
      windows.push({ startSec: open, endSec: (i + 1) * frameSec });
      open = null;
    }
  }
  if (open !== null) windows.push({ startSec: open, endSec: (lastActive + 1) * frameSec });
  // bridge gaps shorter than 0.24s (natural pauses inside a sentence)
  const merged: SpeechWindow[] = [];
  for (const win of windows) {
    const prev = merged[merged.length - 1];
    if (prev && win.startSec - prev.endSec < 0.24) prev.endSec = win.endSec;
    else merged.push({ ...win });
  }
  const usable = merged.filter((w) => w.endSec - w.startSec >= 0.08);
  return usable.length > 0 ? usable : [{ startSec: 0, endSec: Math.max(0.1, envelope.durationSec) }];
}

export function parseWordJson(raw: unknown): RawWord[] {
  const out: RawWord[] = [];
  const num = (v: unknown): number => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim().length > 0) {
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  };
  const pushWord = (entry: Record<string, unknown>) => {
    const text = String(entry["text"] ?? entry["word"] ?? "").trim();
    if (text.length === 0) return;
    let start = num(entry["startSec"] ?? entry["start"]);
    let end = num(entry["endSec"] ?? entry["end"]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    out.push({ text, startSec: start, endSec: end, keywordHint: entry["isKeyword"] === true });
  };
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 6 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record["text"] === "string" || typeof record["word"] === "string") {
      pushWord(record);
      return;
    }
    for (const key of ["words", "segments", "transcript", "items"]) {
      if (Array.isArray(record[key])) visit(record[key], depth + 1);
    }
  };
  visit(raw);
  return normalizeWordTimings(out);
}

export function normalizeWordTimings(words: RawWord[]): RawWord[] {
  const sorted = [...words]
    .filter((w) => w.text.trim().length > 0 && Number.isFinite(w.startSec) && Number.isFinite(w.endSec) && w.endSec > w.startSec)
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  const out: RawWord[] = [];
  let cursor = 0;
  for (const word of sorted) {
    const start = Math.max(round3(word.startSec), cursor);
    const end = Math.max(round3(word.endSec), start + 0.001);
    if (end <= start + 0.0005) continue;
    out.push({ ...word, startSec: round3(start), endSec: round3(end) });
    cursor = end;
  }
  return out;
}

/** Deterministic forced alignment: distribute words across detected speech bursts. */
export function forceAlignScript(
  script: string,
  envelope: AudioEnvelopeLike,
  keywordHints: string[] = [],
): { words: RawWord[]; windows: SpeechWindow[] } {
  const tokens = cleanCueText(script).split(/\s+/).filter(Boolean);
  const windows = speechWindows(envelope);
  if (tokens.length === 0) throw new Error("captions-align: --script is empty");
  const weights = tokens.map((token) => (keywordHints.includes(token) ? syllableWeight(token) * 1.2 : syllableWeight(token)));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const totalActive = windows.reduce((acc, w) => acc + (w.endSec - w.startSec), 0);
  const duration = Math.max(0.1, envelope.durationSec);

  const words: RawWord[] = [];
  let windowIndex = 0;
  let cursor = windows[0]?.startSec ?? 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const targetDuration = Math.max(0.04, (totalActive * (weights[i] as number)) / totalWeight);
    let remaining = targetDuration;
    let wordStart = cursor;
    let wordEnd = cursor;
    while (remaining > 0.0001) {
      const win = windows[windowIndex];
      if (!win) break;
      if (cursor < win.startSec) cursor = win.startSec;
      const available = win.endSec - cursor;
      if (available <= 0.001) {
        windowIndex += 1;
        cursor = windows[windowIndex]?.startSec ?? cursor;
        if (windowIndex >= windows.length) break;
        continue;
      }
      const take = Math.min(available, remaining);
      wordEnd = cursor + take;
      cursor = wordEnd;
      remaining -= take;
      if (cursor >= win.endSec - 0.001) {
        windowIndex += 1;
        cursor = windows[windowIndex]?.startSec ?? cursor;
      }
    }
    if (wordEnd <= wordStart) {
      wordEnd = Math.min(duration, wordStart + 0.05);
    }
    words.push({
      text: tokens[i] as string,
      startSec: round3(Math.min(wordStart, duration)),
      endSec: round3(Math.min(Math.max(wordEnd, wordStart + 0.001), duration)),
    });
  }
  return { words: normalizeWordTimings(words), windows };
}

export interface ChunkOptions {
  minWords?: number;
  maxWords?: number;
  aspect: AspectProfileT;
}

export function chunkWords(words: RawWord[], options: ChunkOptions): CaptionChunk[] {
  const min = Math.max(1, Math.min(12, options.minWords ?? 2));
  const max = Math.max(min, Math.min(16, options.maxWords ?? 4));
  const ordered = normalizeWordTimings(words);
  const chunks: CaptionChunk[] = [];
  let i = 0;
  let index = 0;
  while (i < ordered.length) {
    let take = Math.min(max, ordered.length - i);
    // Prefer semantic cue boundaries: break on a real pause when the chunk is viable.
    for (let j = i + 1; j < i + take; j += 1) {
      const gap = (ordered[j]?.startSec ?? 0) - (ordered[j - 1]?.endSec ?? 0);
      if (gap > 0.18) {
        if (j - i >= min) take = j - i;
        break;
      }
    }
    const leftover = ordered.length - i - take;
    if (take === max && leftover > 0 && leftover < min) {
      take = Math.max(1, ordered.length - i - min);
    }
    const slice = ordered.slice(i, i + take);
    i += take;
    index += 1;
    if (slice.length === 0) continue;
    const startSec = slice[0]?.startSec ?? 0;
    const endSec = slice[slice.length - 1]?.endSec ?? startSec;
    const words: CaptionWord[] = slice.map((w) => ({
      text: w.text,
      startSec: w.startSec,
      endSec: w.endSec,
      isKeyword: isKeywordWord(w.text, w.keywordHint),
    }));
    chunks.push({
      id: `caption-${String(index).padStart(3, "0")}`,
      startSec: round3(startSec),
      endSec: round3(endSec),
      text: words.map((w) => w.text).join(" "),
      words,
      emphasis: words.some((w) => w.isKeyword),
      safeBox: captionSafeBox(options.aspect),
    });
  }
  return chunks;
}

export interface BuildCaptionsOptions {
  aspect: AspectProfileT;
  source: CaptionsDoc["source"];
  style: string | null;
  typography: CaptionTypography;
  minWords: number;
  maxWords: number;
}

export function buildCaptionsDoc(words: RawWord[], options: BuildCaptionsOptions): CaptionsDoc {
  const normalized = normalizeWordTimings(words);
  if (normalized.length === 0) throw new Error("captions-align: no timed words were produced from the input");
  const chunks = chunkWords(normalized, { minWords: options.minWords, maxWords: options.maxWords, aspect: options.aspect });
  const activeSpeechSec = round3(
    chunks.reduce((acc, chunk) => acc + chunk.words.reduce((sum, w) => sum + (w.endSec - w.startSec), 0), 0),
  );
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    aspect: options.aspect,
    source: options.source,
    style: options.style,
    typography: options.typography,
    safeZones: safeZonesFor(options.aspect),
    stats: { words: normalized.length, chunks: chunks.length, activeSpeechSec },
    chunks,
  };
}

/* ============================================================================
 * I/O helpers shared by engines
 * ========================================================================== */

export async function loadCaptionsDoc(file: string): Promise<CaptionsDoc | null> {
  if (!(await pathExists(file))) return null;
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Partial<CaptionsDoc>;
    if (!Array.isArray(raw.chunks) || raw.chunks.length === 0) return null;
    return raw as CaptionsDoc;
  } catch {
    return null;
  }
}

/** Scene captions: explicit `captionsFile` or workspace/captions.json on sourceClip scenes. */
export async function loadCaptionsForScene(workspace: string, scene: SceneSpecT): Promise<CaptionsDoc | null> {
  const rel = scene.captionsFile ?? (scene.sourceClip ? "captions.json" : undefined);
  if (!rel) return null;
  return loadCaptionsDoc(path.resolve(workspace, rel));
}

/** Chunks that overlap a project-absolute scene window. */
export function chunksInWindow(doc: CaptionsDoc, startSec: number, endSec: number): CaptionChunk[] {
  return doc.chunks.filter((chunk) => chunk.endSec > startSec + 0.001 && chunk.startSec < endSec - 0.001);
}

export function applyCasing(text: string, casing: CaptionTypography["casing"]): string {
  if (casing === "upper") return text.toUpperCase();
  if (casing === "title") return text.replace(/\p{L}[\p{L}'’-]*/gu, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  if (casing === "sentence") {
    const lower = text.toLowerCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }
  return text;
}

export const DEFAULT_CAPTION_TYPOGRAPHY: CaptionTypography = {
  captionFont: "Ultra Sans",
  casing: "upper",
  activeWordHighlight: "pill",
  strokePx: 0,
};
