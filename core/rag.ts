import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { SYNTH_PRESETS } from "./synth-audio.js";
import { installRoot } from "./env.js";
import { pathExists } from "./util.js";

/* ============================================================================
 * Offline BM25 + structured-metadata RAG (zero dependencies, zero network)
 * ========================================================================== */

export type RagKind = "style" | "motif" | "sfx" | "rule" | "skill" | "effect" | "agent";

export interface RagDoc {
  id: string;
  kind: RagKind;
  title: string;
  path: string;
  aspect: string | null;
  text: string;
  metadata: Record<string, unknown>;
}

export interface RagIndex {
  version: 1;
  builtAt: string;
  docs: RagDoc[];
}

export interface RagHit extends RagDoc {
  score: number;
  snippet: string;
  tokens: string[];
}

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "for", "with", "on", "is", "it", "this", "that", "be", "by", "as", "at", "from", "into"]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9:+-]+/)
    .map((token) => token.replace(/^[-:]+|[-:]+$/g, ""))
    .filter((token) => token.length > 1 && !STOP.has(token));
}

function stripHtml(text: string): string {
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function pngAspect(file: string): Promise<string | null> {
  try {
    const buffer = await fs.readFile(file);
    if (buffer.length < 24 || buffer.subarray(1, 4).toString("ascii") !== "PNG") return null;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (!width || !height) return null;
    const ratio = width / height;
    if (Math.abs(ratio - 9 / 16) < 0.05) return "9:16";
    if (Math.abs(ratio - 1) < 0.08) return "1:1";
    return "16:9";
  } catch {
    return null;
  }
}

async function styleAspect(dir: string): Promise<string | null> {
  try {
    const exemplars = (await fs.readdir(path.join(dir, "exemplars"))).filter((name) => name.endsWith(".png")).sort();
    for (const name of exemplars) {
      const aspect = await pngAspect(path.join(dir, "exemplars", name));
      if (aspect) return aspect;
    }
  } catch {
    // no exemplars
  }
  return null;
}

export async function buildRagIndex(root = installRoot()): Promise<RagIndex> {
  const docs: RagDoc[] = [];
  const rel = (file: string) => path.relative(root, file).split(path.sep).join("/");
  const stylesDir = path.join(root, "styles");
  try {
    for (const entry of (await fs.readdir(stylesDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(stylesDir, entry.name);
      const styleFile = path.join(dir, "style.json");
      if (!(await pathExists(styleFile))) continue;
      const raw = JSON.parse(await fs.readFile(styleFile, "utf8")) as Record<string, any>;
      const md = await fs.readFile(path.join(dir, "STYLE.md"), "utf8").catch(() => "");
      const aspect = await styleAspect(dir);
      const palette = raw["colorAndTexture"]?.palette ?? {};
      const text = [
        raw["meta"]?.name ?? entry.name,
        raw["meta"]?.description ?? "",
        md,
        `palette ${Object.values(palette).join(" ")}`,
        `aspect ${aspect ?? ""} safe-zone captions hook retention`,
      ].join("\n");
      docs.push({
        id: `style:${raw["meta"]?.slug ?? entry.name}`,
        kind: "style",
        title: raw["meta"]?.name ?? entry.name,
        path: rel(styleFile),
        aspect,
        text,
        metadata: { slug: raw["meta"]?.slug ?? entry.name, palette, typography: raw["typography"] ?? {} },
      });
      try {
        for (const motif of (await fs.readdir(path.join(dir, "motifs"))).filter((name) => name.endsWith(".html")).sort()) {
          const motifPath = path.join(dir, "motifs", motif);
          const html = await fs.readFile(motifPath, "utf8");
          docs.push({
            id: `motif:${entry.name}:${motif.replace(/\.html$/, "")}`,
            kind: "motif",
            title: `${entry.name} · ${motif.replace(/\.html$/, "").replace(/-/g, " ")}`,
            path: rel(motifPath),
            aspect,
            text: `${entry.name} ${aspect ?? ""} motif ${motif} ${stripHtml(html)}`,
            metadata: { style: entry.name, aspect, tokens: ["__ULTRA_SEEK"] },
          });
        }
      } catch {
        // no motifs
      }
    }
  } catch {
    // styles missing
  }

  const ultraDir = path.join(root, ".ultra");
  const walkMd = async (dir: string, kind: RagKind): Promise<void> => {
    let entries;
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walkMd(full, kind);
      else if (entry.name.endsWith(".md")) {
        const text = await fs.readFile(full, "utf8");
        docs.push({
          id: `${kind}:${path.relative(ultraDir, full).split(path.sep).join("/")}`,
          kind,
          title: entry.name.replace(/\.md$/, ""),
          path: rel(full),
          aspect: null,
          text,
          metadata: { section: path.basename(dir) },
        });
      }
    }
  };
  await walkMd(path.join(ultraDir, "rules"), "rule");
  await walkMd(path.join(ultraDir, "skills"), "skill");
  await walkMd(path.join(ultraDir, "agents"), "agent");

  const effects = [
    ["ultra-ease", "UltraEase easing linear expo.out expo.inOut back.out power3.out cubic-bezier kinetic typography"],
    ["grain", "film grain seeded noise texture vignette halation halftone anti-slop"],
    ["camera", "2.5D camera rig zoom pan rotate perspective punch-in ken burns drift"],
    ["captions", "word-level captions active-word pill underline safe zone 9:16 16:9 hook"],
    ["sourceClip", "sourceClip trims J-cut L-cut punch-in raw footage edit in style"],
    ["transition", "xfade fade wipeleft wiperight slideup circleopen banned transitions"],
  ] as const;
  for (const [id, text] of effects) {
    docs.push({ id: `effect:${id}`, kind: "effect", title: id, path: "engines/hyperframes", aspect: null, text, metadata: {} });
  }
  for (const preset of [...SYNTH_PRESETS.sfx, ...SYNTH_PRESETS.music]) {
    docs.push({
      id: `sfx:${preset}`,
      kind: "sfx",
      title: preset,
      path: "core/synth-audio.ts",
      aspect: null,
      text: `synth-audio preset ${preset} offline 48khz stereo wav whoosh impact riser music bed`,
      metadata: { preset },
    });
  }

  // Deterministic index: a content hash, not a wall-clock timestamp, so
  // `npm run pack:cloud` is reproducible (CI dist-check).
  const contentHash = createHash("sha1").update(JSON.stringify(docs)).digest("hex").slice(0, 12);
  return { version: 1, builtAt: `sha1:${contentHash}`, docs };
}

export async function loadRagIndex(root = installRoot()): Promise<RagIndex> {
  const bundled = path.join(root, "dist", "rag-index.json");
  if (await pathExists(bundled)) {
    try {
      const parsed = JSON.parse(await fs.readFile(bundled, "utf8")) as RagIndex;
      if (Array.isArray(parsed.docs) && parsed.docs.length > 0) return parsed;
    } catch {
      // fall through to a fresh in-memory index
    }
  }
  return buildRagIndex(root);
}

export interface RagQueryOptions {
  kind?: RagKind;
  aspect?: string;
  top?: number;
}

export function queryRag(index: RagIndex, query: string, options: RagQueryOptions = {}): RagHit[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  const docs = index.docs
    .map((doc) => ({ doc, tokens: tokenize(`${doc.title} ${doc.kind} ${doc.aspect ?? ""} ${doc.text}`) }))
    .filter(({ doc }) => !options.kind || doc.kind === options.kind);
  const N = docs.length;
  const avgLen = docs.reduce((sum, entry) => sum + entry.tokens.length, 0) / Math.max(1, N);
  const df = new Map<string, number>();
  for (const { tokens } of docs) {
    for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const k1 = 1.5;
  const b = 0.75;
  const hits: RagHit[] = [];
  for (const { doc, tokens } of docs) {
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    let score = 0;
    const matched: string[] = [];
    for (const token of queryTokens) {
      const freq = tf.get(token) ?? 0;
      if (freq === 0) continue;
      matched.push(token);
      const idf = Math.log(1 + (N - (df.get(token) ?? 0) + 0.5) / ((df.get(token) ?? 0) + 0.5));
      score += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + (b * tokens.length) / Math.max(1, avgLen))));
    }
    if (score <= 0) continue;
    if (options.aspect) {
      if (doc.aspect === options.aspect) score += 2.5;
      else if ((doc.kind === "style" || doc.kind === "motif") && doc.aspect) score -= 1.5;
    }
    const lower = doc.text.toLowerCase();
    const at = lower.indexOf(matched[0] ?? "");
    const snippet = at >= 0 ? doc.text.slice(Math.max(0, at - 80), at + 200).replace(/\s+/g, " ").trim() : doc.text.slice(0, 220).replace(/\s+/g, " ").trim();
    hits.push({ ...doc, score: Math.round(score * 1000) / 1000, snippet, tokens: matched });
  }
  return hits.sort((a, b2) => b2.score - a.score || a.id.localeCompare(b2.id)).slice(0, Math.max(1, options.top ?? 5));
}
