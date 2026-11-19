import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function ensureDir(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function rmrf(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}

export function sha1(data: string | Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

export async function sha1File(file: string): Promise<string> {
  const buf = await fs.readFile(file);
  return sha1(buf);
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function formatTimestamp(sec: number): string {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

/** Resolve a possibly-relative path against a base without requiring existence. */
export function resolveInside(base: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}

export function tailLines(text: string, count = 25): string {
  const lines = text.trimEnd().split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}
