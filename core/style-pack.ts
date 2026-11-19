import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StylePackSchema, StyleRegistry, type StylePackT } from "./style-schema.js";
import { createZip, extractZip } from "./zip.js";
import { installRoot } from "./env.js";
import { ensureDir, pathExists, readJson, rmrf, writeJsonAtomic } from "./util.js";

/* ============================================================================
 * Paths
 * ========================================================================== */

/** Style packs live in `styles/` next to the project (cwd) or the Ultra install. */
export function stylesRoot(): string {
  const override = process.env.ULTRA_STYLES_DIR;
  if (override && override.trim().length > 0) return path.resolve(override.trim());
  const cwdStyles = path.resolve(process.cwd(), "styles");
  return cwdStyles;
}

export function registryFile(): string {
  return path.join(stylesRoot(), "registry.json");
}

export const EXAMPLE_ADD_TO_REPO = "ADD_TO_REPO_IN_QODER.txt";

/* ============================================================================
 * Validation
 * ========================================================================== */

export interface StyleCounts {
  motifs: number;
  exemplars: number;
  hasLut: boolean;
  hasAssets: boolean;
}

export interface StyleValidationResult {
  ok: boolean;
  errors: string[];
  style?: StylePackT;
  counts: StyleCounts;
  dir: string;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const SECRET_PATTERNS: RegExp[] = [
  /[A-Za-z]:[\\/]{1,2}(Users|Documents|Desktop|home)[\\/]/i,
  /(^|[\s"'(])\/(Users|home)\//m,
  /file:\/\//i,
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/,
];

function imageMagic(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  const png = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  const webp = buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  return png || jpeg || webp;
}

async function walkFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(full, base)));
    else out.push(path.relative(base, full));
  }
  return out;
}

async function copyTree(src: string, dest: string): Promise<number> {
  let count = 0;
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += await copyTree(from, to);
    } else {
      await ensureDir(path.dirname(to));
      await fs.copyFile(from, to);
      count += 1;
    }
  }
  return count;
}

export async function validateStylePack(styleDirInput: string): Promise<StyleValidationResult> {
  const dir = path.resolve(styleDirInput);
  const errors: string[] = [];
  const counts: StyleCounts = { motifs: 0, exemplars: 0, hasLut: false, hasAssets: false };
  let style: StylePackT | undefined;

  const styleFile = path.join(dir, "style.json");
  if (!(await pathExists(styleFile))) {
    errors.push(`missing style.json in ${dir}`);
    return { ok: false, errors, counts, dir };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(styleFile, "utf8"));
  } catch (err) {
    errors.push(`style.json is not valid JSON: ${(err as Error).message}`);
    return { ok: false, errors, counts, dir };
  }
  const parsed = StylePackSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 20)) {
      errors.push(`style.json ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
  } else {
    style = parsed.data;
  }

  const mdFile = path.join(dir, "STYLE.md");
  if (!(await pathExists(mdFile))) errors.push("missing STYLE.md");
  else {
    const md = await fs.readFile(mdFile, "utf8");
    if (md.trim().length < 300) errors.push(`STYLE.md too short (${md.trim().length} chars, need >= 300)`);
  }

  const exemplarDir = path.join(dir, "exemplars");
  const exemplarFiles = (await walkFiles(exemplarDir)).filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()));
  if (exemplarFiles.length < 2 || exemplarFiles.length > 8) {
    errors.push(`exemplars/ must contain 2 to 8 images (found ${exemplarFiles.length})`);
  }
  for (const file of exemplarFiles) {
    const full = path.join(exemplarDir, file);
    const stat = await fs.stat(full);
    const buffer = await fs.readFile(full);
    if (stat.size === 0) errors.push(`exemplar ${file} is empty`);
    else if (!imageMagic(buffer)) errors.push(`exemplar ${file} is not a valid PNG/JPEG/WebP`);
  }
  counts.exemplars = exemplarFiles.length;

  const motifDir = path.join(dir, "motifs");
  const motifFiles = (await walkFiles(motifDir)).filter((f) => f.toLowerCase().endsWith(".html"));
  counts.motifs = motifFiles.length;
  for (const file of motifFiles) {
    const content = await fs.readFile(path.join(motifDir, file), "utf8");
    if (!content.includes("__ULTRA_SEEK")) errors.push(`motif ${file} is missing the deterministic __ULTRA_SEEK hook`);
    if (/<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i.test(content)) {
      errors.push(`motif ${file} loads an external CDN script (http/https) — offline packs only`);
    }
  }

  if (style?.colorAndTexture.lutFile) {
    const lutPath = path.join(dir, style.colorAndTexture.lutFile);
    const lutInside = lutPath.startsWith(dir + path.sep);
    if (!lutInside) {
      errors.push(`lutFile escapes the style pack: ${style.colorAndTexture.lutFile}`);
    } else if (!(await pathExists(lutPath))) {
      errors.push(`lutFile referenced but missing: ${style.colorAndTexture.lutFile}`);
    } else {
      const stat = await fs.stat(lutPath);
      const content = await fs.readFile(lutPath, "utf8");
      if (stat.size === 0) errors.push("grade LUT file is empty");
      else if (!/LUT_3D_SIZE\s+\d+/.test(content)) errors.push("grade LUT is missing a valid LUT_3D_SIZE header");
      else counts.hasLut = true;
    }
  }
  counts.hasAssets = await pathExists(path.join(dir, "assets"));

  // Whole-pack hygiene: no absolute machine paths, secrets or file:// leaks.
  const allFiles = await walkFiles(dir);
  for (const rel of allFiles) {
    const ext = path.extname(rel).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".webp", ".cube"].includes(ext)) continue;
    const stat = await fs.stat(path.join(dir, rel));
    if (stat.size > 512 * 1024) continue;
    const text = await fs.readFile(path.join(dir, rel), "utf8").catch(() => "");
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        errors.push(`forbidden machine path or secret in ${rel} (pattern ${pattern.source.slice(0, 40)}…)`);
        break;
      }
    }
  }

  return { ok: errors.length === 0 && Boolean(style), errors, ...(style ? { style } : {}), counts, dir };
}

/* ============================================================================
 * Registry / list
 * ========================================================================== */

export interface StyleListEntry {
  slug: string;
  name: string;
  version: string;
  referenceCount: number;
  motifs: number;
  exemplars: number;
  dir: string;
}

export async function styleList(): Promise<StyleListEntry[]> {
  const root = stylesRoot();
  if (!(await pathExists(root))) return [];
  const entries: StyleListEntry[] = [];
  for (const dirent of await fs.readdir(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const dir = path.join(root, dirent.name);
    const styleFile = path.join(dir, "style.json");
    if (!(await pathExists(styleFile))) continue;
    try {
      const parsed = StylePackSchema.safeParse(JSON.parse(await fs.readFile(styleFile, "utf8")));
      if (!parsed.success) continue;
      const motifs = (await walkFiles(path.join(dir, "motifs"))).filter((f) => f.endsWith(".html")).length;
      const exemplars = (await walkFiles(path.join(dir, "exemplars"))).filter((f) =>
        IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()),
      ).length;
      entries.push({
        slug: parsed.data.meta.slug,
        name: parsed.data.meta.name,
        version: parsed.data.meta.version,
        referenceCount: parsed.data.meta.referenceCount,
        motifs,
        exemplars,
        dir,
      });
    } catch {
      // skip malformed packs (style-validate reports them explicitly)
    }
  }
  return entries.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function rebuildRegistry(installedSlug?: string): Promise<void> {
  const root = stylesRoot();
  await ensureDir(root);
  let previous: Record<string, string> = {};
  try {
    const reg = StyleRegistry.parse(await readJson(registryFile()));
    previous = Object.fromEntries(reg.styles.map((s) => [s.slug, s.installedAt]));
  } catch {
    previous = {};
  }
  const entries = await styleList();
  const registry = {
    updatedAt: new Date().toISOString(),
    styles: entries.map((entry) => ({
      slug: entry.slug,
      name: entry.name,
      version: entry.version,
      referenceCount: entry.referenceCount,
      installedAt: previous[entry.slug] ?? (entry.slug === installedSlug ? new Date().toISOString() : new Date().toISOString()),
    })),
  };
  StyleRegistry.parse(registry);
  await writeJsonAtomic(registryFile(), registry);
}

/* ============================================================================
 * Export
 * ========================================================================== */

export interface StyleExportResult {
  slug: string;
  zipPath: string;
  bytes: number;
  files: number;
}

export async function styleExport(styleDirInput: string, outFileInput?: string): Promise<StyleExportResult> {
  const validation = await validateStylePack(styleDirInput);
  if (!validation.ok || !validation.style) {
    throw new Error(`style pack is invalid:\n- ${validation.errors.join("\n- ")}`);
  }
  const style = validation.style;
  const dir = validation.dir;
  const slug = style.meta.slug;
  const outFile = path.resolve(outFileInput ?? path.join("build", `${slug}-style-pack.zip`));

  const staging = await fs.mkdtemp(path.join(os.tmpdir(), `ultra-style-export-${slug}-`));
  const files: { name: string; source: string }[] = [];
  try {
    const copy = async (rel: string) => {
      const full = path.join(dir, rel);
      if (!(await pathExists(full))) return;
      const dest = path.join(staging, rel);
      await ensureDir(path.dirname(dest));
      await fs.copyFile(full, dest);
      files.push({ name: rel.split(path.sep).join("/"), source: dest });
    };
    await copy("style.json");
    await copy("STYLE.md");
    for (const rel of await walkFiles(path.join(dir, "motifs"))) {
      await copy(path.join("motifs", rel));
    }
    for (const rel of await walkFiles(path.join(dir, "exemplars"))) {
      await copy(path.join("exemplars", rel));
    }
    if (style.colorAndTexture.lutFile) await copy(style.colorAndTexture.lutFile);
    if (await pathExists(path.join(dir, "assets"))) {
      for (const rel of await walkFiles(path.join(dir, "assets"))) {
        await copy(path.join("assets", rel));
      }
    }
    const addToRepo = [
      `ULTRA STYLE PACK — ${style.meta.name} (${slug})`,
      ``,
      `Drop this zip into Qoder and paste prompts/QODER_IMPORT_STYLE_TO_REPO.txt,`,
      `or run directly:`,
      ``,
      `  node dist/ultra.mjs style-import ${slug}-style-pack.zip --repack`,
      `  npm test && git add styles prompts && git commit -m "style: add ${slug} pack" && git push origin main`,
      ``,
      `The import validates the pack, installs it to styles/${slug}/, updates`,
      `styles/registry.json and repacks dist/ultra-workflow-cloud.zip so every`,
      `future Gemini / Meta Muse chat can use --style ${slug}.`,
      ``,
    ].join("\n");
    await fs.writeFile(path.join(staging, EXAMPLE_ADD_TO_REPO), addToRepo, "utf8");
    files.push({ name: EXAMPLE_ADD_TO_REPO, source: path.join(staging, EXAMPLE_ADD_TO_REPO) });

    const zip = await createZip(files, outFile);
    return { slug, zipPath: outFile, bytes: zip.bytes, files: zip.count };
  } finally {
    await rmrf(staging);
  }
}

/* ============================================================================
 * Import
 * ========================================================================== */

async function findPackRoot(dir: string): Promise<string | null> {
  if (await pathExists(path.join(dir, "style.json"))) return dir;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    if (await pathExists(path.join(child, "style.json"))) return child;
  }
  return null;
}

export interface StyleImportResult {
  slug: string;
  installedDir: string;
  registryFile: string;
  files: number;
  repackRequested: boolean;
  repacked: boolean;
  repackExit: number | null;
}

export async function styleImport(zipOrDir: string, repack: boolean): Promise<StyleImportResult> {
  const source = path.resolve(zipOrDir);
  await fs.access(source).catch(() => {
    throw new Error(`style-import source not found: ${source}`);
  });
  const stat = await fs.stat(source);
  let packRoot: string;
  let tempExtract: string | null = null;
  try {
    if (stat.isDirectory()) {
      const found = await findPackRoot(source);
      if (!found) throw new Error(`no style.json found in ${source}`);
      packRoot = found;
    } else {
      tempExtract = await fs.mkdtemp(path.join(os.tmpdir(), "ultra-style-import-"));
      const { entries } = await extractZip(source, tempExtract);
      if (!entries.every((e) => e.crcOk)) throw new Error("style pack zip failed CRC verification");
      const found = await findPackRoot(tempExtract);
      if (!found) throw new Error("style.json not found inside the zip");
      packRoot = found;
    }

    const validation = await validateStylePack(packRoot);
    if (!validation.ok || !validation.style) {
      throw new Error(`style pack failed validation:\n- ${validation.errors.join("\n- ")}`);
    }
    const slug = validation.style.meta.slug;
    const target = path.join(stylesRoot(), slug);
    await ensureDir(stylesRoot());
    await rmrf(target);
    await ensureDir(target);
    const files = await copyTree(packRoot, target);
    await rebuildRegistry(slug);

    let repacked = false;
    let repackExit: number | null = null;
    if (repack) {
      const root = installRoot();
      const devPack = path.join(root, "scripts", "pack-cloud.ts");
      if (await pathExists(devPack)) {
        const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "pack:cloud"], {
          cwd: root,
          stdio: "inherit",
          shell: process.platform === "win32",
        });
        repackExit = result.status ?? 1;
        repacked = repackExit === 0;
        if (!repacked) {
          console.warn(`[style-import] warning: pack:cloud exited ${repackExit}; styles are installed but dist is stale.`);
        }
      } else {
        console.warn("[style-import] not a dev repo (no scripts/pack-cloud.ts); styles installed — run pack:cloud in the repo.");
      }
    }

    return {
      slug,
      installedDir: target,
      registryFile: registryFile(),
      files,
      repackRequested: repack,
      repacked,
      repackExit,
    };
  } finally {
    if (tempExtract) await rmrf(tempExtract);
  }
}
