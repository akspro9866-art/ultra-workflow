import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DoctorReportT } from "./schema.js";
import { run } from "./ffmpeg.js";
import { getBrowserInfo } from "./browser.js";
import { pathExists } from "./util.js";

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

function fontDirectoriesFor(workspaceDir: string): string[] {
  const home = os.homedir();
  const dirs: string[] = [path.join(workspaceDir, "assets", "fonts"), path.join(process.cwd(), "workspace", "assets", "fonts")];
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
}> {
  const workspace = workspaceDir ?? path.resolve(process.cwd(), "workspace");
  const directories = fontDirectoriesFor(workspace);
  const files: string[] = [];
  for (const dir of directories) await walkFonts(dir, 4, files);
  const isItalic = (f: string) => /italic|oblique/i.test(path.basename(f));
  const isBold = (f: string) => /bold|bd|black|heavy|semibold/i.test(path.basename(f));
  const isMono = (f: string) => /mono|consol|courier|menlo|code|hack/i.test(path.basename(f));
  const preferred = (f: string, terms: RegExp) => terms.test(path.basename(f));
  const pick = (predicate: (f: string) => boolean, preference: RegExp) =>
    files.find((f) => predicate(f) && preference.test(path.basename(f)) && !isItalic(f)) ??
    files.find((f) => predicate(f) && !isItalic(f)) ??
    null;
  return {
    regular: pick((f) => !isBold(f) && !isMono(f), /segoeui|arial|inter|roboto|noto.*sans|dejavu.*sans|liberation.*sans/i),
    bold: pick(isBold, /segoeui.*b|arial.*b|inter.*b|roboto.*b|noto.*sans.*b|dejavu.*sans.*b|liberation.*sans.*b/i),
    mono: pick(isMono, /consola|dejavu.*mono|liberation.*mono|menlo|noto.*mono/i),
    count: files.length,
    directories,
  };
}

export type RenderTier = "full-cdp" | "browserless-py" | "ffmpeg-only";

export async function detectRenderTier(): Promise<{
  tier: RenderTier;
  browser: { available: boolean; kind: string | null; executablePath: string | null };
  pythonModules: { pil: boolean; numpy: boolean; cairosvg: boolean };
  python: boolean;
  ffmpeg: boolean;
}> {
  const forcedNoBrowser = process.env.ULTRA_NO_BROWSER === "1";
  const browser = forcedNoBrowser
    ? { available: false, kind: null, executablePath: null }
    : await getBrowserInfo().catch(() => ({ available: false, kind: null, executablePath: null }));
  const ffmpeg = Boolean(await probeVersion("ffmpeg", ["-version"], 8000));
  const python = Boolean(await resolvePythonCommand());
  const pythonModules = await detectPythonModules();
  const tier: RenderTier = browser.available
    ? "full-cdp"
    : ffmpeg && python && pythonModules.pil
      ? "browserless-py"
      : "ffmpeg-only";
  return { tier, browser, pythonModules, python, ffmpeg };
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
  if (!browserInfo.available) {
    warnings.push(
      tierInfo.tier === "browserless-py"
        ? "No browser: renderTier=browserless-py (Pillow renderer + synth-audio; install Chromium for full-cdp)."
        : "No browser and no Pillow: renderTier=ffmpeg-only (reduced py-canvas rendering).",
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

  return {
    ok: Boolean(ffmpegVersionLine && ffprobeVersionLine && tierInfo.tier !== "ffmpeg-only"),
    renderTier: tierInfo.tier,
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
    fonts,
    ffmpeg: { available: Boolean(ffmpegVersionLine), version: ffmpegVersionLine },
    ffprobe: { available: Boolean(ffprobeVersionLine), version: ffprobeVersionLine },
    browser: browserInfo,
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
