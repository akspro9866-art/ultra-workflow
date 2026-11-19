import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs, existsSync, readdirSync, statSync, accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { tailLines } from "./util.js";

/* ============================================================================
 * Browser discovery (Linux / Windows / macOS; system + Playwright/Puppeteer caches)
 * ========================================================================== */

export interface DiscoveredBrowser {
  kind: string;
  executablePath: string;
}

function isRunnableFile(p: string): boolean {
  try {
    const stat = statSync(p);
    if (!stat.isFile()) return false;
    if (process.platform !== "win32") accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathCandidatesOnPath(names: string[]): DiscoveredBrowser[] {
  const found: DiscoveredBrowser[] = [];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        if (isRunnableFile(candidate)) {
          found.push({ kind: name, executablePath: candidate });
          break;
        }
      }
    }
  }
  return found;
}

function findFirstUnder(base: string, predicate: (rel: string) => boolean, maxDepth = 4): string | null {
  if (!existsSync(base)) return null;
  const queue: { dir: string; depth: number }[] = [{ dir: base, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const rel = path.relative(base, full).replace(/\\/g, "/");
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (!isDir && predicate(rel)) return full;
      if (isDir && depth < maxDepth) queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return null;
}

// Prefer full Google Chrome on Linux: distro Chromium builds often omit the
// proprietary H.264/AAC decoders that sourceClip editing depends on.
const LINUX_KNOWN = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/google/chrome/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/usr/bin/microsoft-edge",
  "/usr/bin/microsoft-edge-stable",
];

const WINDOWS_KNOWN = () => {
  const local = process.env.LOCALAPPDATA ?? "";
  const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
  const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
  return [
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
};

const DARWIN_KNOWN = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

function playwrightCacheBases(): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [path.join(local, "ms-playwright"), path.join(home, ".cache", "ms-playwright")];
  }
  return [path.join(home, ".cache", "ms-playwright"), path.join(home, "Library", "Caches", "ms-playwright")];
}

function puppeteerCacheBases(): string[] {
  const home = os.homedir();
  return [path.join(home, ".cache", "puppeteer"), path.join(home, ".cache", "puppeteer-core")];
}

function findInPlaywrightCache(): DiscoveredBrowser | null {
  for (const base of playwrightCacheBases()) {
    const hit = findFirstUnder(
      base,
      (rel) => /(^|\/)(chrome|chrome\.exe)$/.test(rel) && /(chrome-linux|chrome-win|chrome-linux64|chrome-mac)/.test(rel),
      3,
    );
    if (hit) return { kind: "playwright-cache", executablePath: hit };
  }
  return null;
}

function findInPuppeteerCache(): DiscoveredBrowser | null {
  for (const base of puppeteerCacheBases()) {
    const hit = findFirstUnder(
      base,
      (rel) =>
        /(^|\/)(chrome|chrome\.exe)$/.test(rel) &&
        /(chrome-linux64|chrome-win64|chrome-mac|Chrome for Testing)/.test(rel),
      4,
    );
    if (hit) return { kind: "puppeteer-cache", executablePath: hit };
  }
  return null;
}

let discoveryCache: DiscoveredBrowser | null | undefined;

export function discoverBrowser(): DiscoveredBrowser | null {
  if (discoveryCache !== undefined) return discoveryCache;
  const override = process.env.ULTRA_BROWSER_PATH;
  if (override && override.trim() && isRunnableFile(override.trim())) {
    discoveryCache = { kind: "env-override", executablePath: override.trim() };
    return discoveryCache;
  }

  const systemCandidates: DiscoveredBrowser[] = [];
  if (process.platform === "win32") {
    for (const p of WINDOWS_KNOWN()) if (isRunnableFile(p)) systemCandidates.push({ kind: path.basename(p), executablePath: p });
    systemCandidates.push(
      ...pathCandidatesOnPath(["chrome", "msedge", "chromium"]),
    );
  } else if (process.platform === "darwin") {
    for (const p of DARWIN_KNOWN) if (isRunnableFile(p)) systemCandidates.push({ kind: path.basename(p), executablePath: p });
  } else {
    for (const p of LINUX_KNOWN) if (isRunnableFile(p)) systemCandidates.push({ kind: path.basename(p), executablePath: p });
    systemCandidates.push(...pathCandidatesOnPath(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]));
  }
  if (systemCandidates.length > 0) {
    discoveryCache = systemCandidates[0] as DiscoveredBrowser;
    return discoveryCache;
  }
  const pw = findInPlaywrightCache();
  if (pw) {
    discoveryCache = pw;
    return discoveryCache;
  }
  const pp = findInPuppeteerCache();
  if (pp) {
    discoveryCache = pp;
    return discoveryCache;
  }
  discoveryCache = null;
  return null;
}

export function browserInfo(): { available: boolean; kind: string | null; executablePath: string | null } {
  const found = discoverBrowser();
  return { available: Boolean(found), kind: found?.kind ?? null, executablePath: found?.executablePath ?? null };
}

/* ============================================================================
 * CDP wire connection
 * ========================================================================== */

interface PendingCommand {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

interface EventWaiter {
  method: string;
  sessionId: string | undefined;
  resolve: (params: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export const CLOUD_SAFE_FLAGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--enable-webgl",
  "--hide-scrollbars",
  "--mute-audio",
  "--allow-file-access-from-files",
  "--disable-web-security",
  "--autoplay-policy=no-user-gesture-required",
  "--force-color-profile=srgb",
  "--disable-extensions",
  "--disable-background-networking",
];

class CdpConnection {
  private nextId = 1;
  private pending = new Map<number, PendingCommand>();
  private waiters: EventWaiter[] = [];

  constructor(
    public readonly ws: WebSocket,
    public readonly child: ChildProcess,
  ) {
    ws.on("message", (data) => this.handleMessage(data.toString()));
  }

  private handleMessage(raw: string): void {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id) as PendingCommand;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
      else entry.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === "string") {
      for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
        const waiter = this.waiters[i] as EventWaiter;
        if (waiter.method === message.method && waiter.sessionId === message.sessionId) {
          this.waiters.splice(i, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message.params ?? {});
        }
      }
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  waitForEvent(method: string, sessionId: string | undefined, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`CDP event ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ method, sessionId, resolve, reject, timer });
    });
  }

  close(): void {
    for (const [, pending] of this.pending) pending.reject(new Error("CDP connection closed"));
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("CDP connection closed"));
    }
    this.waiters = [];
    try {
      this.ws.close();
    } catch {
      // ignore
    }
    try {
      this.child.kill();
    } catch {
      // ignore
    }
  }
}

async function launchBrowserProcess(): Promise<{ connection: CdpConnection; info: DiscoveredBrowser }> {
  const info = discoverBrowser();
  if (!info) {
    throw new Error(
      "No Chromium-compatible browser found. Install chromium/chrome/edge, or set ULTRA_BROWSER_PATH. Run `ultra doctor` for details.",
    );
  }
  const args = [
    ...CLOUD_SAFE_FLAGS,
    "--remote-debugging-port=0",
    "--user-data-dir=" + path.join(os.tmpdir(), `ultra-cdp-profile-${process.pid}-${Date.now()}`),
    "about:blank",
  ];
  const child = spawn(info.executablePath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    // First cold start on a loaded Linux runner can exceed 25s; 60s is still
    // bounded but avoids flaky DevTools timeouts before any test has warmed up.
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      reject(new Error(`Timed out waiting for the DevTools endpoint:\n${tailLines(buffer, 8)}`));
    }, 60_000);
    child.stderr?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1] as string);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Browser exited early (code ${code}):\n${tailLines(buffer, 8)}`));
    });
  });

  const ws = new WebSocket(wsUrl, { maxPayload: 512 * 1024 * 1024, perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return { connection: new CdpConnection(ws, child), info };
}

/* ============================================================================
 * Page abstraction (same surface the engines already use)
 * ========================================================================== */

export interface UltraPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<void>;
  setContent(html: string): Promise<void>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  addScriptTag(options: { content: string }): Promise<void>;
  screenshot(options: {
    path: string;
    omitBackground?: boolean;
    type?: string;
    animations?: string;
  }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  waitForFunction(expression: string, arg?: unknown, options?: { timeout?: number }): Promise<void>;
  close(): Promise<void>;
}

class CdpPage implements UltraPage {
  private tempFiles: string[] = [];

  constructor(
    private readonly connection: CdpConnection,
    private readonly targetId: string,
    private readonly sessionId: string,
    private readonly width: number,
    private readonly height: number,
  ) {}

  async goto(url: string, options: { waitUntil?: string; timeout?: number } = {}): Promise<void> {
    const loaded = this.connection.waitForEvent("Page.loadEventFired", this.sessionId, options.timeout ?? 30_000);
    const result = await this.connection.send("Page.navigate", { url }, this.sessionId);
    if (result?.errorText) {
      await loaded.catch(() => undefined);
      throw new Error(`Navigation failed: ${result.errorText}`);
    }
    await loaded;
    await this.waitForTimeout(15);
  }

  async setContent(html: string): Promise<void> {
    const file = path.join(os.tmpdir(), `ultra-page-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.html`);
    await fs.writeFile(file, html, "utf8");
    this.tempFiles.push(file);
    await this.goto(pathToFileURL(file).href);
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.connection.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true, userGesture: false },
      this.sessionId,
    );
    if (result?.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "evaluation failed";
      throw new Error(`Page evaluate failed: ${String(detail).slice(0, 800)}`);
    }
    return result?.result?.value as T;
  }

  async addScriptTag(options: { content: string }): Promise<void> {
    await this.evaluate(options.content);
  }

  async screenshot(options: {
    path: string;
    omitBackground?: boolean;
    type?: string;
    animations?: string;
  }): Promise<void> {
    if (options.omitBackground) {
      await this.connection.send(
        "Emulation.setDefaultBackgroundColorOverride",
        { color: { r: 0, g: 0, b: 0, a: 0 } },
        this.sessionId,
      );
    } else {
      await this.connection.send("Emulation.setDefaultBackgroundColorOverride", {}, this.sessionId);
    }
    const result = await this.connection.send(
      "Page.captureScreenshot",
      { format: "png", fromSurface: true, captureBeyondViewport: false },
      this.sessionId,
    );
    const data = String(result?.data ?? "");
    if (!data) throw new Error("Page.captureScreenshot returned no data");
    await fs.mkdir(path.dirname(options.path), { recursive: true });
    await fs.writeFile(options.path, Buffer.from(data, "base64"));
  }

  async waitForTimeout(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async waitForFunction(expression: string, _arg?: unknown, options: { timeout?: number } = {}): Promise<void> {
    const deadline = Date.now() + (options.timeout ?? 30_000);
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(`Boolean(${expression})`)) return;
      } catch {
        // page may not be ready yet
      }
      await this.waitForTimeout(100);
    }
    throw new Error(`waitForFunction timed out: ${expression.slice(0, 200)}`);
  }

  async close(): Promise<void> {
    await this.connection.send("Target.closeTarget", { targetId: this.targetId }).catch(() => undefined);
    for (const temp of this.tempFiles) await fs.rm(temp, { force: true }).catch(() => undefined);
    this.tempFiles = [];
  }

  get viewport(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }
}

/* ============================================================================
 * Shared browser lifecycle
 * ========================================================================== */

let shared: { connection: CdpConnection; info: DiscoveredBrowser } | null = null;

async function getShared(): Promise<{ connection: CdpConnection; info: DiscoveredBrowser }> {
  if (!shared) shared = await launchBrowserProcess();
  return shared;
}

export async function createCdpPage(width: number, height: number): Promise<UltraPage> {
  const { connection } = await getShared();
  const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
  await connection.send("Page.enable", {}, sessionId);
  await connection.send("Runtime.enable", {}, sessionId);
  await connection.send(
    "Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await connection.send(
    "Emulation.setEmulatedMedia",
    { features: [{ name: "prefers-reduced-motion", value: "reduce" }] },
    sessionId,
  );
  return new CdpPage(connection, targetId, sessionId, width, height);
}

export async function closeCdpBrowser(): Promise<void> {
  if (!shared) return;
  shared.connection.close();
  shared = null;
}
