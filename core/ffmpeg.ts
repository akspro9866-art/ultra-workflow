import { spawn } from "node:child_process";
import { tailLines } from "./util.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  command: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

export class CommandError extends Error {
  constructor(public readonly result: RunResult) {
    super(
      `Command failed (${result.code}): ${result.command}\n${tailLines(result.stderr || result.stdout)}`,
    );
    this.name = "CommandError";
  }
}

export async function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const command = [bin, ...args].join(" ");
  return new Promise<RunResult>((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const max = opts.maxBuffer ?? 64 * 1024 * 1024;
    const timer =
      opts.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            if (!settled) {
              settled = true;
              child.kill("SIGKILL");
              reject(new Error(`Command timed out after ${opts.timeoutMs}ms: ${command}`));
            }
          }, opts.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < max) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < max) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr, command });
    });
  });
}

export async function runOk(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const result = await run(bin, args, opts);
  if (result.code !== 0) throw new CommandError(result);
  return result;
}

/** True if the binary can be executed at all. */
export async function binaryAvailable(bin: string): Promise<boolean> {
  try {
    const result = await run(bin, ["-version"], { timeoutMs: 8000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

export async function ffmpegVersion(): Promise<string | null> {
  try {
    const result = await run("ffmpeg", ["-version"], { timeoutMs: 8000 });
    if (result.code !== 0) return null;
    return result.stdout.split(/\r?\n/)[0] ?? null;
  } catch {
    return null;
  }
}

export async function ffprobeJson(file: string): Promise<any> {
  const result = await runOk("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  return JSON.parse(result.stdout);
}

export async function ffmpeg(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run("ffmpeg", ["-hide_banner", "-y", ...args], opts);
}

export async function ffmpegOk(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const result = await ffmpeg(args, opts);
  if (result.code !== 0) throw new CommandError(result);
  return result;
}

/** Run a command and capture binary stdout (e.g. rawvideo frames or PCM samples). */
export async function runBinary(
  bin: string,
  args: string[],
  opts: RunOptions = {},
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4 * 1024 * 1024) stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr }));
  });
}

/** Parse an ffprobe rational like "30000/1001" into a number. */
export function parseRational(rational: string | undefined): number | null {
  if (!rational) return null;
  const parts = rational.split("/");
  const num = Number(parts[0]);
  const den = parts.length > 1 ? Number(parts[1]) : 1;
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return num / den;
}
