import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Page as PlaywrightPage, Browser as PlaywrightBrowser } from "playwright-core";
import {
  browserInfo,
  closeCdpBrowser,
  createCdpPage,
  CLOUD_SAFE_FLAGS,
  discoverBrowser,
  type UltraPage,
} from "./cdp-browser.js";

export type { UltraPage };

export function browserDriverMode(): "cdp" | "playwright" {
  return process.env.ULTRA_BROWSER_DRIVER === "playwright" ? "playwright" : "cdp";
}

export async function getBrowserInfo(): Promise<{
  available: boolean;
  kind: string | null;
  executablePath: string | null;
}> {
  if (process.env.ULTRA_NO_BROWSER === "1") {
    return { available: false, kind: null, executablePath: null };
  }
  const info = browserInfo();
  if (browserDriverMode() === "playwright") {
    try {
      createRequire(import.meta.url)("playwright-core");
      return {
        available: info.available,
        kind: info.kind ? `playwright (${info.kind})` : "playwright",
        executablePath: info.executablePath,
      };
    } catch {
      return { available: false, kind: "playwright (not installed)", executablePath: null };
    }
  }
  return info;
}

let playwrightBrowser: PlaywrightBrowser | null = null;

async function getPlaywrightBrowser(): Promise<PlaywrightBrowser> {
  if (playwrightBrowser) return playwrightBrowser;
  const requireFromHere = createRequire(import.meta.url);
  const playwright = requireFromHere("playwright-core") as any;
  const discovered = discoverBrowser();
  const launchArgs = CLOUD_SAFE_FLAGS.filter((flag) => !flag.startsWith("--headless") && !flag.startsWith("--remote-debugging-port"));
  playwrightBrowser = await playwright.chromium.launch({
    headless: true,
    ...(discovered ? { executablePath: discovered.executablePath } : {}),
    args: launchArgs,
  });
  return playwrightBrowser as PlaywrightBrowser;
}

export async function newPage(width: number, height: number): Promise<UltraPage> {
  if (browserDriverMode() === "playwright") {
    const browser = await getPlaywrightBrowser();
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });
    const page = (await context.newPage()) as unknown as PlaywrightPage;
    await page.emulateMedia({ reducedMotion: "reduce" });
    return page as unknown as UltraPage;
  }
  return createCdpPage(width, height);
}

export async function closePage(page: UltraPage): Promise<void> {
  try {
    await page.close();
  } catch {
    // ignore
  }
  const context = (page as unknown as { context?: () => { close: () => Promise<void> } }).context;
  if (typeof context === "function") {
    try {
      await context.call(page).close();
    } catch {
      // ignore
    }
  }
}

export async function shutdownBrowser(): Promise<void> {
  await closeCdpBrowser();
  if (playwrightBrowser) {
    try {
      await playwrightBrowser.close();
    } catch {
      // ignore
    }
    playwrightBrowser = null;
  }
}

/**
 * Deterministically screenshot a self-contained HTML document at exact pixel
 * dimensions. Local images must be embedded (data URIs) or referenced from the
 * htmlFile location.
 */
export async function renderHtmlToPng(html: string, width: number, height: number, outFile: string): Promise<void> {
  const page = await newPage(width, height);
  try {
    await page.setContent(html);
    await settlePage(page);
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await page.screenshot({ path: outFile, type: "png" });
  } finally {
    await closePage(page);
  }
}

export async function settlePage(page: UltraPage): Promise<void> {
  await page.evaluate(`(async () => {
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (e) {}
    }
    await Promise.all(Array.prototype.slice.call(document.images).map(function (img) {
      if (img.complete) return Promise.resolve();
      return new Promise(function (resolve) {
        img.addEventListener("load", function () { resolve(); }, { once: true });
        img.addEventListener("error", function () { resolve(); }, { once: true });
      });
    }));
  })()`);
  await page.waitForTimeout(30);
}

/** Wait until every <video> on the page has metadata (duration/seekable). */
export async function waitForVideos(page: UltraPage, timeoutMs = 10_000): Promise<void> {
  await page.evaluate(`(async () => {
    var videos = Array.prototype.slice.call(document.querySelectorAll("video"));
    await Promise.all(videos.map(function (video) {
      if (video.readyState >= 1 && isFinite(video.duration)) return Promise.resolve();
      return new Promise(function (resolve) {
        function done() { resolve(); }
        video.addEventListener("loadedmetadata", done, { once: true });
        video.addEventListener("error", done, { once: true });
        setTimeout(done, ${Math.max(1000, timeoutMs)});
      });
    }));
  })()`);
}
