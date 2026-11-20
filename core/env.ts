import { promises as fs, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DoctorReportT, UltraProjectT } from "./schema.js";
import { run } from "./ffmpeg.js";
import { getBrowserInfo } from "./browser.js";
import { pathExists } from "./util.js";

/**
 * Temp directory precedence: ULTRA_TMPDIR > <cwd>/workspace/.ultra-tmp > os.tmpdir().
 * Cloud agent VMs mount /tmp as a ~512 MB tmpfs; renderer scratch must live on
 * the (persistent, larger) workspace volume. Creates the directory when possible.
 */
export function ultraTmpDir(): string {
  const override = (process.env.ULTRA_TMPDIR ?? "").trim();
  if (override) {
    try {
      mkdirSync(override, { recursive: true });
      return override;
    } catch {
      // fall through if the override is not creatable
    }
  }
  const workspaceTmp = path.join(process.cwd(), "workspace", ".ultra-tmp");
  try {
    mkdirSync(workspaceTmp, { recursive: true });
    return workspaceTmp;
  } catch {
    return os.tmpdir();
  }
}

/** Free megabytes on the filesystem that holds `dir` (null when statfs is unavailable). */
export async function freeSpaceMb(dir: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(dir);
    return Math.round((Number(stats.bavail) * Number(stats.bsize)) / (1024 * 1024));
  } catch {
    return null;
  }
}

/** Doctor warning text when the chosen temp volume cannot hold large renders. */
export function tmpSpaceWarning(freeMb: number | null, tmpPath: string): string | null {
  if (freeMb === null) return null;
  if (freeMb >= 2048) return null;
  return `Temp dir ${tmpPath} has only ${freeMb} MB free (< 2 GB) — large renders may die mid-run. Set ULTRA_TMPDIR to a larger volume.`;
}

async function isWritableDir(dir: string): Promise<boolean> {
  const probe = path.join(dir, `.ultra-write-test-${process.pid}-${Date.now()}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probe, "ok", "utf8");
    await fs.rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Conservative RAM estimate for a project render (browser buffers + subframe sequences + FFmpeg). */
export function estimatePeakMb(project: Pick<UltraProjectT, "meta" | "scenes"> | null): number {
  const baseMb = 350;
  if (!project) return baseMb;
  const width = project.meta.width;
  const height = project.meta.height;
  const frameMb = (width * height * 4) / (1024 * 1024);
  const samples = Math.max(1, ...project.scenes.map((s) => s.motionBlurSamples ?? 1));
  // Double-buffered page + screenshot + N subframe sequences + FFmpeg blend.
  return Math.round(baseMb + frameMb * (3 + samples * 2) + samples * 40);
}

export class MemoryPreflightError extends Error {
  constructor(
    public readonly estimatedPeakMb: number,
    public readonly totalMb: number,
  ) {
    super(
      `Refusing to build: estimated peak RAM ${estimatedPeakMb} MB > 80% of total ${totalMb} MB. ` +
        `Reduce meta.width/height, motionBlurSamples, or run on a larger VM. ` +
        `Override only for known-safe local runs with ULTRA_SKIP_MEMORY_CHECK=1.`,
    );
    this.name = "MemoryPreflightError";
  }
}

/** [4] Build must fail EARLY instead of dying at frame 300/508 or OOM-ing on a 4K upscale. */
export function assertBuildMemoryFits(project: Pick<UltraProjectT, "meta" | "scenes">): void {
  if (process.env.ULTRA_SKIP_MEMORY_CHECK === "1") return;
  const totalMb = Math.round(os.totalmem() / (1024 * 1024));
  const estimatedPeakMb = estimatePeakMb(project);
  if (estimatedPeakMb > totalMb * 0.8) throw new MemoryPreflightError(estimatedPeakMb, totalMb);
}

/** Repository / install root — valid both from src (tsx, core/) and compiled dist (dist/core/). */
export function installRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  let candidate = dir;
  while (candidate !== path.dirname(candidate)) {
    const pkg = path.join(candidate, "package.json");
    try {
      const raw = readFileSync(pkg, "utf8");
      if (raw.includes('"name": "ultra-workflow"')) return candidate;
    } catch {
      // keep walking
    }
    candidate = path.dirname(candidate);
  }
  return path.resolve(dir, "..", "..");
}

async function probeVersion(bin: string, args: string[], timeoutMs = 10000): Promise<string | null> {
  try {
    const result = await run(bin, args, { timeoutMs });
    if (result.code !== 0) return null;
    const text = (result.stdout + "\n" + result.stderr).trim();
    return text.split(/\r?\n/)[0] ?? null;
  } catch {
    return null;
  }
}

async function detectPython(): Promise<string | null> {
  for (const candidate of ["python", "python3", "py"]) {
    const v = await probeVersion(candidate, ["--version"], 8000);
    if (v && /python\s+\d+/i.test(v)) return v;
  }
  return null;
}

async function detectBlender(): Promise<string | null> {
  try {
    const result = await run("blender", ["--version"], { timeoutMs: 12000 });
    if (result.code !== 0) return null;
    const first = result.stdout.split(/\r?\n/)[0];
    return first && first.trim().length > 0 ? first.trim() : "blender (unknown version)";
  } catch {
    return null;
  }
}

async function detectGpu(): Promise<{ available: boolean; name: string | null }> {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      const ps = await run(
        "powershell",
        ["-NoProfile", "-Command", "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"],
        { timeoutMs: 15000 },
      );
      if (ps.code === 0 && ps.stdout.trim()) {
        const names = ps.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (names.length > 0) return { available: true, name: names.join(", ") };
      }
    } else if (platform === "linux") {
      const smi = await run("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { timeoutMs: 8000 });
      if (smi.code === 0 && smi.stdout.trim()) {
        return { available: true, name: smi.stdout.trim().split(/\r?\n/)[0] ?? null };
      }
      const lspci = await run("bash", ["-lc", "lspci 2>/dev/null | grep -i -E 'vga|3d' | head -3"], { timeoutMs: 8000 });
      if (lspci.code === 0 && lspci.stdout.trim()) {
        return { available: true, name: lspci.stdout.trim().replace(/\s+/g, " ").slice(0, 200) };
      }
    } else if (platform === "darwin") {
      const sp = await run("system_profiler", ["SPDisplaysDataType"], { timeoutMs: 15000 });
      if (sp.code === 0) {
        const match = sp.stdout.match(/Chipset Model:\s*(.+)/);
        if (match) return { available: true, name: match[1]?.trim() ?? null };
      }
    }
  } catch {
    // fall through
  }
  return { available: false, name: null };
}

export function engineWorkspaceDir(engine: "remotion" | "revideo"): string {
  return path.join(installRoot(), "engines", engine);
}

/**
 * [3] Bundle provenance: pack-cloud embeds the packing commit in dist/ultra.mjs.
 * sourceMatchesBundle compares it with the current git HEAD (false when there is
 * no .git, e.g. inside the extracted cloud zip).
 */
export function bundleProvenance(): { bundleCommit: string | null; sourceMatchesBundle: boolean } {
  let bundleCommit: string | null = null;
  try {
    const head = readFileSync(path.join(installRoot(), "dist", "ultra.mjs"), "utf8").slice(0, 4096);
    const match = /ultra-bundle-commit:\s*([0-9a-f]{7,40})/.exec(head);
    if (match?.[1]) bundleCommit = match[1];
  } catch {
    bundleCommit = null;
  }
  let gitHead: string | null = null;
  try {
    gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: installRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    gitHead = null;
  }
  let sourceMatchesBundle = Boolean(bundleCommit && gitHead && bundleCommit === gitHead);
  if (!sourceMatchesBundle && bundleCommit && gitHead && bundleCommit !== "unknown") {
    // A dist-only follow-up commit is normal (the bundle must embed the commit
    // before it can be committed). Treat "same source tree (excluding dist)" as
    // a match so the provenance stays truthful without a self-reference loop.
    try {
      execFileSync("git", ["diff", "--quiet", bundleCommit, "HEAD", "--", ".", ":(exclude)dist"], {
        cwd: installRoot(),
        stdio: ["ignore", "ignore", "ignore"],
      });
      sourceMatchesBundle = true;
    } catch {
      sourceMatchesBundle = false;
    }
  }
  return { bundleCommit, sourceMatchesBundle };
}

export async function detectOptionalEngine(engine: "remotion" | "revideo"): Promise<boolean> {
  const base = engineWorkspaceDir(engine);
  const marker =
    engine === "remotion"
      ? path.join(base, "node_modules", "@remotion", "renderer", "package.json")
      : path.join(base, "node_modules", "@revideo", "renderer", "package.json");
  return pathExists(marker);
}

export interface PythonCommand {
  bin: string;
  prefix: string[];
}

let pythonCommandCache: PythonCommand | null | undefined;

export async function resolvePythonCommand(): Promise<PythonCommand | null> {
  if (pythonCommandCache !== undefined) return pythonCommandCache;
  const candidates: PythonCommand[] =
    process.platform === "win32"
      ? [{ bin: "python", prefix: [] }, { bin: "py", prefix: ["-3"] }, { bin: "python3", prefix: [] }]
      : [{ bin: "python3", prefix: [] }, { bin: "python", prefix: [] }];
  for (const candidate of candidates) {
    try {
      const result = await run(candidate.bin, [...candidate.prefix, "--version"], { timeoutMs: 8000 });
      if (result.code === 0) {
        pythonCommandCache = candidate;
        return candidate;
      }
    } catch {
      // try next
    }
  }
  pythonCommandCache = null;
  return null;
}

export async function detectPythonModules(): Promise<{ pil: boolean; numpy: boolean; cairosvg: boolean }> {
  const python = await resolvePythonCommand();
  if (!python) return { pil: false, numpy: false, cairosvg: false };
  const script = [
    "import json",
    "out={}",
    "for name in ['PIL','numpy','cairosvg']:",
    "    try:",
    "        __import__(name)",
    "        out[name]=True",
    "    except Exception:",
    "        out[name]=False",
    "print(json.dumps(out))",
  ].join("\n");
  try {
    const result = await run(python.bin, [...python.prefix, "-c", script], { timeoutMs: 20_000 });
    if (result.code === 0) {
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() ?? "{}") as Record<string, boolean>;
      return { pil: Boolean(parsed["PIL"]), numpy: Boolean(parsed["numpy"]), cairosvg: Boolean(parsed["cairosvg"]) };
    }
  } catch {
    // treat as missing
  }
  return { pil: false, numpy: false, cairosvg: false };
}

export interface BundledFont {
  file: string;
  family: string;
  role: "display" | "regular" | "bold" | "mono";
  path: string;
  bytes: number;
}

const BUNDLED_FONT_FILES: { file: string; family: string; role: BundledFont["role"] }[] = [
  { file: "UltraDisplay-Bold.ttf", family: "Ultra Display", role: "display" },
  { file: "UltraSans-Regular.ttf", family: "Ultra Sans", role: "regular" },
  { file: "UltraSans-Bold.ttf", family: "Ultra Sans", role: "bold" },
  { file: "UltraMono-Regular.ttf", family: "Ultra Mono", role: "mono" },
];

/** Offline OFL fonts shipped with Ultra Workflow (assets/fonts, bundled in the cloud zip). */
export function bundledFontsDir(): string {
  return path.join(installRoot(), "assets", "fonts");
}

export async function listBundledFonts(): Promise<BundledFont[]> {
  const dir = bundledFontsDir();
  const out: BundledFont[] = [];
  for (const entry of BUNDLED_FONT_FILES) {
    const file = path.join(dir, entry.file);
    try {
      const stat = await fs.stat(file);
      out.push({ ...entry, path: file, bytes: stat.size });
    } catch {
      // font not bundled (source checkout without generated fonts)
    }
  }
  return out;
}

function fontDirectoriesFor(workspaceDir: string): string[] {
  const home = os.homedir();
  const workspaceDirs = [path.join(workspaceDir, "assets", "fonts"), path.join(process.cwd(), "workspace", "assets", "fonts")];
  const dirs: string[] = [...workspaceDirs, bundledFontsDir()];
  if (process.platform === "win32") {
    dirs.push("C:\\Windows\\Fonts");
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts"));
  } else if (process.platform === "darwin") {
    dirs.push("/System/Library/Fonts", "/Library/Fonts", path.join(home, "Library", "Fonts"));
  } else {
    dirs.push("/usr/share/fonts", "/usr/local/share/fonts", path.join(home, ".fonts"), path.join(home, ".local", "share", "fonts"));
  }
  return [...new Set(dirs)];
}

async function walkFonts(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth < 0 || out.length > 500) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFonts(full, depth - 1, out);
    else if (/\.(ttf|otf)$/i.test(entry.name)) out.push(full);
  }
}

export async function discoverFonts(workspaceDir?: string): Promise<{
  regular: string | null;
  bold: string | null;
  mono: string | null;
  count: number;
  directories: string[];
  bundled: BundledFont[];
}> {
  const workspace = workspaceDir ?? path.resolve(process.cwd(), "workspace");
  const directories = fontDirectoriesFor(workspace);
  const files: string[] = [];
  for (const dir of directories) await walkFonts(dir, 4, files);
  const isItalic = (f: string) => /italic|oblique/i.test(path.basename(f));
  const isBold = (f: string) => /bold|bd|black|heavy|semibold/i.test(path.basename(f));
  const isMono = (f: string) => /mono|consol|courier|menlo|code|hack/i.test(path.basename(f));
  const pick = (predicate: (f: string) => boolean, preference: RegExp) =>
    files.find((f) => predicate(f) && preference.test(path.basename(f)) && !isItalic(f)) ??
    files.find((f) => predicate(f) && !isItalic(f)) ??
    null;
  return {
    regular: pick(
      (f) => !isBold(f) && !isMono(f),
      /ultra.*sans.*regular|segoeui|arial|inter|roboto|noto.*sans|dejavu.*sans|liberation.*sans/i,
    ),
    bold: pick(isBold, /ultra.*sans.*bold|ultra.*display|segoeui.*b|arial.*b|inter.*b|roboto.*b|noto.*sans.*b|dejavu.*sans.*b|liberation.*sans.*b/i),
    mono: pick(isMono, /ultra.*mono|consola|dejavu.*mono|liberation.*mono|menlo|noto.*mono/i),
    count: files.length,
    directories,
    bundled: await listBundledFonts(),
  };
}

export type RenderTier = "full-cdp" | "browserless-py" | "ffmpeg-only";

function forcedRenderTier(): RenderTier | null {
  const raw = (process.env.ULTRA_FORCE_TIER ?? "").trim();
  return raw === "full-cdp" || raw === "browserless-py" || raw === "ffmpeg-only" ? raw : null;
}

export async function detectRenderTier(): Promise<{
  tier: RenderTier;
  detectedTier: RenderTier;
  forcedTier: RenderTier | null;
  browser: { available: boolean; kind: string | null; executablePath: string | null };
  pythonModules: { pil: boolean; numpy: boolean; cairosvg: boolean };
  python: boolean;
  ffmpeg: boolean;
}> {
  const forcedNoBrowser = process.env.ULTRA_NO_BROWSER === "1";
  const forcedTier = forcedRenderTier();
  const browser = forcedNoBrowser
    ? { available: false, kind: null, executablePath: null }
    : await getBrowserInfo().catch(() => ({ available: false, kind: null, executablePath: null }));
  const ffmpeg = Boolean(await probeVersion("ffmpeg", ["-version"], 8000));
  const python = Boolean(await resolvePythonCommand());
  const pythonModules = await detectPythonModules();
  const detectedTier: RenderTier = browser.available
    ? "full-cdp"
    : ffmpeg && python && pythonModules.pil
      ? "browserless-py"
      : "ffmpeg-only";
  const tier = forcedTier ?? detectedTier;
  return { tier, detectedTier, forcedTier, browser, pythonModules, python, ffmpeg };
}

export async function detectEnvironment(host: "auto" | "gemini" | "muse" | "chatgpt" = "auto"): Promise<DoctorReportT> {
  const warnings: string[] = [];
  const ffmpegVersionLine = await probeVersion("ffmpeg", ["-version"], 8000);
  const ffprobeVersionLine = await probeVersion("ffprobe", ["-version"], 8000);
  const python = await detectPython();
  const blender = await detectBlender();
  const [remotionInstalled, revideoInstalled, gpu, tierInfo, fonts] = await Promise.all([
    detectOptionalEngine("remotion"),
    detectOptionalEngine("revideo"),
    detectGpu(),
    detectRenderTier(),
    discoverFonts(),
  ]);
  const browserInfo = tierInfo.browser;

  if (!ffmpegVersionLine) warnings.push("FFmpeg is missing; install FFmpeg and ensure it is on PATH.");
  if (!ffprobeVersionLine) warnings.push("ffprobe is missing; install FFmpeg (full build) and ensure it is on PATH.");
  if (!python) warnings.push("Python 3.11+ is not available; Blender-native rendering and py-canvas are unavailable.");
  if (tierInfo.forcedTier) {
    warnings.push(
      `ULTRA_FORCE_TIER=${tierInfo.forcedTier} · detected tier was ${tierInfo.detectedTier}; routing is forced for deterministic testing.`,
    );
  } else if (!browserInfo.available) {
    warnings.push(
      tierInfo.tier === "browserless-py"
        ? "No browser: renderTier=browserless-py (Pillow renderer + synth-audio; install Chromium for full-cdp)."
        : "No browser and no Pillow: renderTier=ffmpeg-only (pure FFmpeg drawtext/drawbox/zoompan renderer with bundled TTFs).",
    );
  }
  if (!blender) warnings.push("Blender not found; 3D scenes use Three.js (full-cdp) or the py-canvas wireframe fallback.");
  if (!remotionInstalled) warnings.push("Remotion workspace not installed; remotion scenes fall back automatically.");
  if (!revideoInstalled) warnings.push("Revideo workspace not installed; revideo scenes use the built-in choreography runtime.");
  if (host === "chatgpt") {
    warnings.push(
      tierInfo.tier === "full-cdp"
        ? "Host=chatgpt · full-cdp available: HyperFrames/Three.js pipeline will run unchanged."
        : "Host=chatgpt · browserless: py-canvas takes over rendering; use ChatGPT Image Generation for stills/B-roll keyframes and `ultra synth-audio` for SFX/music.",
    );
    if (!tierInfo.pythonModules.pil) warnings.push("Host=chatgpt · Pillow not detected: py-canvas will use its FFmpeg filtergraph fallback.");
  }

  // [4] Sandbox pre-flight: disk, writability, RAM — so builds fail before
  // frame 300/508 instead of mid-render OOM on agent VMs.
  const tmpPath = ultraTmpDir();
  const workspaceDir = path.resolve(process.cwd(), "workspace");
  const [tmpFreeMb, workspaceFreeMb, homeWritable, cacheWritable] = await Promise.all([
    freeSpaceMb(tmpPath),
    freeSpaceMb(workspaceDir),
    isWritableDir(os.homedir()),
    isWritableDir(path.join(process.cwd(), ".ultra-cache")),
  ]);
  let projectForEstimate: UltraProjectT | null = null;
  try {
    const raw = JSON.parse(await fs.readFile(path.join(workspaceDir, "ultra.json"), "utf8")) as UltraProjectT;
    if (raw?.meta && Array.isArray(raw?.scenes)) projectForEstimate = raw;
  } catch {
    projectForEstimate = null;
  }
  const totalMb = Math.round(os.totalmem() / (1024 * 1024));
  const estimatedPeakMbForProject = estimatePeakMb(projectForEstimate);
  const spaceWarning = tmpSpaceWarning(tmpFreeMb, tmpPath);
  if (spaceWarning) warnings.push(spaceWarning);
  if (estimatedPeakMbForProject > totalMb * 0.8) {
    warnings.push(
      `Estimated peak RAM ${estimatedPeakMbForProject} MB exceeds 80% of ${totalMb} MB — ultra build will refuse this project on this VM.`,
    );
  }
  if (!cacheWritable) warnings.push(`.ultra-cache is not writable at ${path.join(process.cwd(), ".ultra-cache")} — renders will fail.`);
  if (tierInfo.tier === "ffmpeg-only") {
    warnings.push("ffmpeg-only tier has NO motion blur — motionBlurSamples is ignored by the pure-FFmpeg engine.");
  }
  const provenance = bundleProvenance();
  if (!provenance.bundleCommit) {
    warnings.push("dist/ultra.mjs has no bundle commit banner — run `npm run pack:cloud` to ship provenance.");
  } else if (!provenance.sourceMatchesBundle) {
    warnings.push(`dist/ultra.mjs commit ${provenance.bundleCommit} differs from the working tree HEAD (or no git metadata) — repack before shipping.`);
  }

  return {
    ok: Boolean(ffmpegVersionLine && ffprobeVersionLine),
    renderTier: tierInfo.tier,
    forcedTier: tierInfo.forcedTier,
    host,
    os: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      cpus: os.cpus().length,
    },
    node: process.version,
    python,
    pythonModules: tierInfo.pythonModules,
    fonts: { ...fonts, bundledFonts: fonts.bundled },
    ffmpeg: { available: Boolean(ffmpegVersionLine), version: ffmpegVersionLine },
    ffprobe: { available: Boolean(ffprobeVersionLine), version: ffprobeVersionLine },
    browser: browserInfo,
    disk: { tmpFreeMb, workspaceFreeMb, tmpPath },
    fs: { homeWritable, cacheWritable },
    memory: { totalMb, estimatedPeakMbForProject },
    bundleCommit: provenance.bundleCommit,
    sourceMatchesBundle: provenance.sourceMatchesBundle,
    remotion: { installed: remotionInstalled },
    revideo: { installed: revideoInstalled },
    blender: { available: Boolean(blender), version: blender },
    gpu,
    warnings,
  };
}

export async function ensureWorkspace(workspace: string): Promise<void> {
  await fs.mkdir(path.join(workspace, "assets"), { recursive: true });
}
