import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LintDefectT } from "../../core/schema.js";
import type { LintContext, LintResult } from "../types.js";
import { compileSceneHtml, paletteFor } from "./compiler.js";
import { newPage, closePage, settlePage, waitForVideos } from "../../core/browser.js";
import { ensureDir } from "../../core/util.js";

const CRITICAL = new Set(["clip", "brokenMedia", "blankFrame", "palette"]);
const AUDIT_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

interface RawDefect {
  category: string;
  detail: string;
}

/**
 * Injected as a plain script tag (never serialized from a TS function, which
 * would drag bundler helper names like __name into the page).
 */
const AUDIT_SCRIPT = String.raw`
window.__ULTRA_AUDIT = function (params) {
  var allowedPalette = params.allowedPalette;
  var background = params.background;
  var problems = [];
  var vw = window.innerWidth;
  var vh = window.innerHeight;

  function parseColor(value) {
    if (!value || value === "transparent") return null;
    var m = value.match(/rgba?\(([^)]+)\)/);
    if (!m || !m[1]) return null;
    var parts = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some(function (v) { return !isFinite(v); })) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  function channelLum(v) {
    var c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function luminance(c) {
    return 0.2126 * channelLum(c.r) + 0.7152 * channelLum(c.g) + 0.0722 * channelLum(c.b);
  }
  function contrast(fg, bg) {
    var l1 = luminance(fg);
    var l2 = luminance(bg);
    var hi = Math.max(l1, l2);
    var lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }
  function composite(fg, bg) {
    var a = fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }
  function toHex(c) {
    function h(v) { return Math.round(v).toString(16).padStart(2, "0"); }
    return "#" + h(c.r) + h(c.g) + h(c.b);
  }
  function effectiveBg(el) {
    var cur = el.parentElement;
    while (cur) {
      var s = getComputedStyle(cur);
      var c = parseColor(s.backgroundColor);
      if (c && c.a > 0.05) return c;
      cur = cur.parentElement;
    }
    return parseColor(background) || { r: 0, g: 0, b: 0, a: 1 };
  }

  var texts = Array.prototype.slice.call(document.querySelectorAll('[data-audit="text"]'));
  var elements = Array.prototype.slice.call(document.querySelectorAll('[data-audit="el"]'));
  var all = elements.concat(texts);
  var visible = [];

  all.forEach(function (el) {
    var s = getComputedStyle(el);
    var opacity = parseFloat(s.opacity || "1");
    if (s.display === "none" || s.visibility === "hidden" || opacity < 0.02) return;
    var rect = el.getBoundingClientRect();
    if (rect.width < 0.5 && rect.height < 0.5) return;
    visible.push({ el: el, uid: el.getAttribute("data-uid") || "?", rect: rect });
    var clipExempt = el.getAttribute("data-clip-exempt") === "true";
    if (!clipExempt && (rect.left < -1 || rect.top < -1 || rect.right > vw + 1 || rect.bottom > vh + 1)) {
      problems.push({
        category: "clip",
        detail: '"' + el.getAttribute("data-uid") + '" extends outside the ' + vw + "x" + vh + " viewport (" +
          Math.round(rect.left) + "," + Math.round(rect.top) + " " + Math.round(rect.width) + "x" + Math.round(rect.height) + ")"
      });
    }
  });

  var visibleTexts = visible.filter(function (b) { return b.el.getAttribute("data-audit") === "text"; });

  for (var i = 0; i < visibleTexts.length; i += 1) {
    for (var j = i + 1; j < visibleTexts.length; j += 1) {
      var a = visibleTexts[i].rect;
      var b = visibleTexts[j].rect;
      var w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      var h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 1 && h > 1) {
        var minArea = Math.min(a.width * a.height, b.width * b.height);
        if (minArea > 0 && (w * h) / minArea > 0.12) {
          problems.push({
            category: "overlap",
            detail: 'text "' + visibleTexts[i].uid + '" overlaps "' + visibleTexts[j].uid + '"'
          });
        }
      }
    }
  }

  visibleTexts.forEach(function (box) {
    var s = getComputedStyle(box.el);
    var text = (box.el.textContent || "").trim();
    if (text.length === 0) return;
    if (box.rect.width < 2 || box.rect.height < 2) {
      problems.push({ category: "layout", detail: 'text "' + box.uid + '" has no visible box' });
      return;
    }
    var fg = parseColor(s.color);
    if (fg) {
      var bg = effectiveBg(box.el);
      var ratio = contrast(composite(fg, bg), bg);
      var size = parseFloat(s.fontSize || "16");
      var weight = parseInt(s.fontWeight || "400", 10);
      var isLarge = size >= 24 || (size >= 18.66 && weight >= 700);
      var needed = isLarge ? 3.0 : 4.5;
      if (ratio < needed) {
        problems.push({
          category: "contrast",
          detail: 'text "' + box.uid + '" contrast ' + ratio.toFixed(2) + ":1 < " + needed + ":1 (" + s.color + " on " + toHex(bg) + ")"
        });
      }
      if (allowedPalette.indexOf(toHex(fg)) === -1) {
        problems.push({
          category: "palette",
          detail: 'text "' + box.uid + '" color ' + toHex(fg) + " is not in the DESIGN palette (" + allowedPalette.join(", ") + ")"
        });
      }
    }
  });

  visible.forEach(function (box) {
    if (box.el.getAttribute("data-role") !== "shape") return;
    var s = getComputedStyle(box.el);
    var bg = parseColor(s.backgroundColor);
    if (bg && allowedPalette.indexOf(toHex(bg)) === -1) {
      problems.push({
        category: "palette",
        detail: 'shape "' + box.uid + '" color ' + toHex(bg) + " is not in the DESIGN palette"
      });
    }
  });

  Array.prototype.slice.call(document.images).forEach(function (img) {
    if (!img.complete || img.naturalWidth === 0) {
      problems.push({ category: "brokenMedia", detail: "image failed to load: " + (img.currentSrc || img.src || "?").slice(-80) });
    }
  });
  Array.prototype.slice.call(document.querySelectorAll("video")).forEach(function (video) {
    if (video.readyState < 2) problems.push({ category: "brokenMedia", detail: "video layer has no decodable frames" });
  });

  let contentCount = 0;
  texts.forEach(function (el) {
    var rect = el.getBoundingClientRect();
    if ((el.textContent || "").trim().length > 0 && rect.width > 2 && rect.height > 2) contentCount += 1;
  });
  elements.forEach(function (el) {
    var tag = el.tagName.toLowerCase();
    var hasMedia = tag === "img" || tag === "video" || !!el.querySelector("img, video");
    var isShape = el.getAttribute("data-role") === "shape";
    var rect = el.getBoundingClientRect();
    if ((hasMedia || isShape) && rect.width > 4 && rect.height > 4) contentCount += 1;
  });
  if (texts.length + elements.length === 0) {
    // Custom scenes may not use audit markers at all: fall back to raw content.
    var media = document.querySelectorAll("canvas, img, video, svg");
    for (var mi = 0; mi < media.length; mi += 1) {
      var mrect = media[mi].getBoundingClientRect();
      if (mrect.width > 4 && mrect.height > 4) contentCount += 1;
    }
    if ((document.body.innerText || "").trim().length > 0) contentCount += 1;
  }
  if (contentCount === 0) {
    problems.push({ category: "blankFrame", detail: "frame contains no visible content" });
  }

  return problems;
};
`;

export async function lintScene(ctx: LintContext): Promise<LintResult> {
  const { project, scene, workspace, buildDir, fps, width, height } = ctx;
  const html = await compileSceneHtml({ project, scene, workspace, width, height, fps });
  const workDir = path.join(buildDir, "tmp");
  await ensureDir(workDir);
  const htmlPath = path.join(workDir, `lint_${scene.id.replace(/[^\w.-]/g, "_")}.html`);
  await fs.writeFile(htmlPath, html, "utf8");

  const palette = paletteFor(project, scene);
  const sceneBg = scene.background === "transparent" ? "#000000" : scene.background;

  const sceneFrames = Math.max(1, Math.round((scene.endSec - scene.startSec) * fps));
  const frameIndices = [
    ...new Set(AUDIT_FRACTIONS.map((f) => Math.min(sceneFrames - 1, Math.round(f * (sceneFrames - 1))))),
  ].sort((a, b) => a - b);

  const defects: LintDefectT[] = [];
  const seen = new Set<string>();
  const page = await newPage(width, height);
  try {
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    await page.addScriptTag({ content: AUDIT_SCRIPT });
    await settlePage(page);
    await waitForVideos(page);
    const auditArgs = JSON.stringify({ allowedPalette: palette, background: sceneBg });
    for (const frameIndex of frameIndices) {
      await page.evaluate(`window.__ULTRA_SEEK(${frameIndex}, ${fps})`);
      const raw = (await page.evaluate(`window.__ULTRA_AUDIT(${auditArgs})`)) as RawDefect[];
      for (const problem of raw) {
        const key = `${problem.category}::${problem.detail}`;
        if (seen.has(key)) continue;
        seen.add(key);
        defects.push({
          category: problem.category as LintDefectT["category"],
          sceneId: scene.id,
          frameIndex,
          critical: CRITICAL.has(problem.category),
          detail: problem.detail,
        });
      }
    }
  } finally {
    await closePage(page);
  }

  const criticalCount = defects.filter((d) => d.critical).length;
  return { defects, pass: criticalCount === 0 };
}
