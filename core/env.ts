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

export async function detectEnvironment(): Promise<DoctorReportT> {
  const warnings: string[] = [];
  const ffmpegVersionLine = await probeVersion("ffmpeg", ["-version"], 8000);
  const ffprobeVersionLine = await probeVersion("ffprobe", ["-version"], 8000);
  const python = await detectPython();
  const blender = await detectBlender();
  const browserInfo = await getBrowserInfo().catch(() => null);
  const [remotionInstalled, revideoInstalled, gpu] = await Promise.all([
    detectOptionalEngine("remotion"),
    detectOptionalEngine("revideo"),
    detectGpu(),
  ]);

  if (!ffmpegVersionLine) warnings.push("FFmpeg is missing; install FFmpeg and ensure it is on PATH.");
  if (!ffprobeVersionLine) warnings.push("ffprobe is missing; install FFmpeg (full build) and ensure it is on PATH.");
  if (!python) warnings.push("Python 3.11+ is not available; Blender-native rendering will be unavailable.");
  if (!browserInfo) warnings.push("No Chromium-compatible browser found; HyperFrames rendering requires Chrome/Edge/Chromium.");
  if (!blender) warnings.push("Blender not found; 3D scenes will use the deterministic Three.js WebGL fallback.");
  if (!remotionInstalled) warnings.push("Remotion workspace not installed; remotion scenes will fall back to HyperFrames. Run `npm run setup:engines` to enable.");
  if (!revideoInstalled) warnings.push("Revideo workspace not installed; revideo scenes will fall back to HyperFrames. Run `npm run setup:engines` to enable.");

  return {
    ok: Boolean(ffmpegVersionLine && ffprobeVersionLine && browserInfo),
    os: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      cpus: os.cpus().length,
    },
    node: process.version,
    python,
    ffmpeg: { available: Boolean(ffmpegVersionLine), version: ffmpegVersionLine },
    ffprobe: { available: Boolean(ffprobeVersionLine), version: ffprobeVersionLine },
    browser: {
      available: Boolean(browserInfo),
      kind: browserInfo?.kind ?? null,
      executablePath: browserInfo?.executablePath ?? null,
    },
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
