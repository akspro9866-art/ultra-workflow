import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SceneSpecT, UltraProjectT } from "../../core/schema.js";
import { resolveAssetPath, resolveSourceClipPath } from "../../core/assets.js";
import { buildChoreography } from "./choreo.js";
import { fontStack, htmlEscape, normalizeHex, rgba } from "./style.js";
import { discoverFonts } from "../../core/env.js";
import { applyCasing, chunksInWindow, loadCaptionsForScene } from "../../core/captions.js";

export { fontStack, normalizeHex } from "./style.js";

/** Allowed DESIGN.md palette for a scene (tokens + its own background). */
export function paletteFor(project: UltraProjectT, scene: SceneSpecT): string[] {
  const colors = Object.values(project.designTokens.palette).map(normalizeHex);
  if (scene.background !== "transparent") colors.push(normalizeHex(scene.background));
  return [...new Set(colors)];
}

interface CompiledElement {
  uid: string;
  x: number;
  y: number;
  opacity: number;
  rotation: number;
}

export interface CompileOptions {
  project: UltraProjectT;
  scene: SceneSpecT;
  workspace: string;
  width: number;
  height: number;
  fps: number;
}

function assetUrl(project: UltraProjectT, workspace: string, assetId: string): string {
  const asset = project.assets.find((a) => a.id === assetId);
  if (!asset) throw new Error(`hyperframes: unknown asset "${assetId}"`);
  return pathToFileURL(resolveAssetPath(workspace, asset)).href;
}

async function readTextFile(file: string, what: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    throw new Error(`hyperframes: cannot read ${what} at ${file}`);
  }
}

/** Local @font-face rules: bundled OFL TTFs + workspace/assets/fonts overrides. */
async function fontFaceCss(project: UltraProjectT, workspace: string): Promise<string> {
  const discovered = await discoverFonts(workspace);
  const byRole = (role: "display" | "regular" | "bold" | "mono") => discovered.bundled.find((f) => f.role === role)?.path ?? null;
  const display = byRole("display");
  const regular = byRole("regular");
  const bold = byRole("bold") ?? display;
  const mono = byRole("mono") ?? regular;
  const faces: string[] = [];
  const seen = new Set<string>();
  const add = (family: string, file: string | null, weight: number) => {
    if (!file) return;
    const clean = family.replace(/['"]/g, "").trim();
    if (clean.length === 0) return;
    const key = `${clean}::${weight}`;
    if (seen.has(key)) return;
    seen.add(key);
    const format = path.extname(file).toLowerCase() === ".otf" ? "opentype" : "truetype";
    faces.push(
      `@font-face{font-family:'${clean}';src:url('${pathToFileURL(file).href}') format('${format}');font-weight:${weight};font-style:normal;font-display:block;}`,
    );
  };

  add("Ultra Display", display, 700);
  add("Ultra Sans", regular, 400);
  add("Ultra Sans", bold, 700);
  add("Ultra Mono", mono, 400);

  // Design-token aliases (e.g. "Segoe UI" / "Inter" / "Space Grotesk") resolve to bundled faces.
  add(project.designTokens.fonts.heading, display, 700);
  add(project.designTokens.fonts.heading, regular, 400);
  add(project.designTokens.fonts.body, regular, 400);
  add(project.designTokens.fonts.body, bold, 700);
  add(project.designTokens.fonts.mono, mono, 400);

  // Workspace overrides (filename stem becomes the family name).
  try {
    const dir = path.join(workspace, "assets", "fonts");
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(ttf|otf)$/i.test(entry.name)) continue;
      const family = entry.name.replace(/\.(ttf|otf)$/i, "");
      add(family, path.join(dir, entry.name), /bold|black|heavy/i.test(family) ? 700 : 400);
    }
  } catch {
    // no workspace overrides
  }
  return faces.join("\n");
}

function grainDataUri(): string {
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'>" +
    "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='2' stitchTiles='stitch'/>" +
    "<feColorMatrix type='saturate' values='0'/><feComponentTransfer><feFuncA type='linear' slope='0.55'/></feComponentTransfer></filter>" +
    "<rect width='240' height='240' filter='url(#n)'/></svg>";
  const encoded = encodeURIComponent(svg).replace(/'/g, "%27");
  return `url('data:image/svg+xml;charset=utf-8,${encoded}')`;
}

/* ============================================================================
 * Text reveal markup (kinetic split text)
 * ========================================================================== */

function revealMarkup(text: string, reveal: SceneSpecT["textElements"][number]["reveal"]): string {
  if (!reveal || reveal.mode === "none") {
    return htmlEscape(text).replace(/\n/g, "<br/>");
  }
  const wrap = (chunk: string, index: number) =>
    `<span class="rv"${reveal.mask ? "" : ' style="overflow:visible"'}><span class="rv-i" data-i="${index}">${htmlEscape(
      chunk,
    )}</span></span>`;
  let out = "";
  let index = 0;
  if (reveal.mode === "lines") {
    const lines = text.split("\n");
    out = lines.map((line, i) => (i < lines.length - 1 ? `${wrap(line, index + i)}<br/>` : wrap(line, index + i))).join("");
    return out;
  }
  if (reveal.mode === "words") {
    const parts = text.split(/(\s+)/);
    for (const part of parts) {
      if (part.length === 0) continue;
      if (/^\s+$/.test(part)) {
        out += part.includes("\n") ? "<br/>" : `<span style="white-space:pre"> </span>`;
        continue;
      }
      out += wrap(part, index);
      index += 1;
    }
    return out;
  }
  // chars
  for (const ch of Array.from(text)) {
    if (ch === "\n") {
      out += "<br/>";
      continue;
    }
    if (ch === " ") {
      out += `<span style="white-space:pre"> </span>`;
      continue;
    }
    out += wrap(ch, index);
    index += 1;
  }
  return out;
}

/* ============================================================================
 * Runtime (deterministic virtual clock)
 * ========================================================================== */

const PAGE_RUNTIME = String.raw`
(function () {
  "use strict";
  var DATA = JSON.parse(document.getElementById("ultra-data").textContent);
  var NODES = {};
  DATA.elements.forEach(function (e) {
    NODES[e.uid] = document.querySelector('[data-uid="' + e.uid + '"]');
  });
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  var EASES = {
    linear: function (t) { return t; },
    easeInQuad: function (t) { return t * t; },
    easeOutQuad: function (t) { return t * (2 - t); },
    easeInOutQuad: function (t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; },
    easeInCubic: function (t) { return t * t * t; },
    easeOutCubic: function (t) { var p = t - 1; return p * p * p + 1; },
    easeInOutCubic: function (t) { return t < 0.5 ? 4 * t * t * t : 1 + 4 * Math.pow(t - 1, 3); },
    easeOutBack: function (t) { var c1 = 1.70158, c3 = c1 + 1; var p = t - 1; return 1 + c3 * p * p * p + c1 * p * p; },
    easeOutExpo: function (t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); },
    easeInOutSine: function (t) { return -(Math.cos(Math.PI * t) - 1) / 2; }
  };
  function ease(name, t) { var f = EASES[name] || EASES.easeInOutCubic; return f(clamp(t, 0, 1)); }
  function sampleTrack(track, t) {
    var kfs = track.keyframes;
    if (!kfs.length) return null;
    if (t <= kfs[0].atSec) return kfs[0].value;
    var last = kfs[kfs.length - 1];
    if (t >= last.atSec) return last.value;
    for (var i = 1; i < kfs.length; i += 1) {
      var b = kfs[i];
      if (t <= b.atSec) {
        var a = kfs[i - 1];
        var span = b.atSec - a.atSec;
        var p = span <= 0 ? 1 : (t - a.atSec) / span;
        return a.value + (b.value - a.value) * ease(b.ease || "easeInOutCubic", p);
      }
    }
    return last.value;
  }
  function sampleProp(kfs, prop, t, fallback) {
    var pts = [];
    for (var i = 0; i < kfs.length; i += 1) {
      if (kfs[i][prop] !== undefined) pts.push(kfs[i]);
    }
    if (!pts.length) return fallback;
    if (t <= pts[0].atSec) return pts[0][prop];
    var last = pts[pts.length - 1];
    if (t >= last.atSec) return last[prop];
    for (var j = 1; j < pts.length; j += 1) {
      var b = pts[j];
      if (t <= b.atSec) {
        var a = pts[j - 1];
        var span = b.atSec - a.atSec;
        var p = span <= 0 ? 1 : (t - a.atSec) / span;
        return a[prop] + (b[prop] - a[prop]) * ease(b.ease || "easeInOutCubic", p);
      }
    }
    return last[prop];
  }

  var CAMERA = document.getElementById("camera");
  var CONTENT = document.getElementById("content");

  function applyCamera(t) {
    if (!CAMERA || !DATA.camera) return;
    var kfs = DATA.camera.keyframes || [];
    var rx = kfs.length ? sampleProp(kfs, "rotateX", t, 0) : 0;
    var ry = kfs.length ? sampleProp(kfs, "rotateY", t, 0) : 0;
    var rz = kfs.length ? sampleProp(kfs, "rotateZ", t, 0) : 0;
    var zoom = kfs.length ? sampleProp(kfs, "zoom", t, 1) : 1;
    var panX = kfs.length ? sampleProp(kfs, "panX", t, 0) : 0;
    var panY = kfs.length ? sampleProp(kfs, "panY", t, 0) : 0;
    CAMERA.style.transform =
      "translate3d(" + panX + "px," + panY + "px,0) rotateX(" + rx + "deg) rotateY(" + ry + "deg) rotateZ(" + rz + "deg) scale(" + zoom + ")";
  }

  function applyClip(t) {
    if (!CONTENT || !DATA.clipReveal || DATA.clipReveal.type === "none") return;
    var cr = DATA.clipReveal;
    var p = clamp((t - cr.delaySec) / Math.max(0.0001, cr.durationSec), 0, 1);
    var e = ease("easeInOutCubic", p);
    if (cr.type === "wipe") CONTENT.style.clipPath = "inset(0 " + ((1 - e) * 100).toFixed(3) + "% 0 0)";
    else if (cr.type === "iris") CONTENT.style.clipPath = "circle(" + (e * 76).toFixed(3) + "% at 50% 50%)";
    else if (cr.type === "diagonal") {
      CONTENT.style.clipPath =
        "polygon(0 0, " + (e * 140).toFixed(2) + "% 0, " + (e * 140 - 40).toFixed(2) + "% 100%, 0 100%)";
    }
  }

  function applyReveals(t) {
    for (var i = 0; i < DATA.reveals.length; i += 1) {
      var r = DATA.reveals[i];
      var host = document.querySelector('[data-reveal="' + r.uid + '"]');
      if (!host) continue;
      var spans = host.querySelectorAll(".rv-i");
      for (var j = 0; j < spans.length; j += 1) {
        var span = spans[j];
        var idx = Number(span.getAttribute("data-i") || j);
        var p = clamp((t - r.delaySec - idx * r.staggerSec) / Math.max(0.0001, r.durationSec), 0, 1);
        var e = ease(r.easing, p);
        var dist = r.distancePx * (1 - e);
        var tx = 0, ty = 0;
        if (r.from === "up") ty = dist;
        else if (r.from === "down") ty = -dist;
        else if (r.from === "left") tx = -dist;
        else if (r.from === "right") tx = dist;
        span.style.transform = "translate(" + tx.toFixed(2) + "px," + ty.toFixed(2) + "px)";
        span.style.opacity = String(e);
      }
    }
  }

  function applySvgDraw(t) {
    for (var i = 0; i < DATA.svgDraws.length; i += 1) {
      var d = DATA.svgDraws[i];
      var host = document.querySelector('[data-svgdraw="' + d.uid + '"]');
      if (!host) continue;
      var p = clamp((t - d.delay) / Math.max(0.0001, d.duration), 0, 1);
      var shapes = host.querySelectorAll("path, line, polyline, polygon, circle, ellipse, rect");
      for (var j = 0; j < shapes.length; j += 1) {
        shapes[j].style.strokeDasharray = "1";
        shapes[j].style.strokeDashoffset = String(1 - p);
      }
    }
  }

  function applyCaptions(t) {
    if (!DATA.captions || DATA.captions.length === 0) return;
    var abs = DATA.sceneStartSec + t;
    for (var i = 0; i < DATA.captions.length; i += 1) {
      var cap = DATA.captions[i];
      var el = document.querySelector('[data-caption-uid="' + cap.uid + '"]');
      if (!el) continue;
      var active = abs >= cap.startSec && abs < cap.endSec;
      el.style.display = active ? "flex" : "none";
      if (!active) continue;
      var spans = el.querySelectorAll("[data-word-index]");
      var activeWord = -1;
      for (var w = 0; w < cap.words.length; w += 1) {
        if (abs >= cap.words[w].startSec && abs < cap.words[w].endSec) { activeWord = w; break; }
        if (abs >= cap.words[w].startSec) activeWord = w;
      }
      for (var s = 0; s < spans.length; s += 1) {
        var idx = Number(spans[s].getAttribute("data-word-index"));
        if (idx === activeWord) spans[s].classList.add("active");
        else spans[s].classList.remove("active");
      }
    }
  }

  function apply(t) {
    applyCaptions(t);
    var anim = {};
    for (var i = 0; i < DATA.tracks.length; i += 1) {
      var track = DATA.tracks[i];
      var v = sampleTrack(track, t);
      if (v === null) continue;
      if (!anim[track.target]) anim[track.target] = {};
      anim[track.target][track.property] = v;
    }
    for (var j = 0; j < DATA.elements.length; j += 1) {
      var e = DATA.elements[j];
      var el = NODES[e.uid];
      if (!el) continue;
      var a = anim[e.uid] || {};
      var x = a.x !== undefined ? a.x : e.x;
      var y = a.y !== undefined ? a.y : e.y;
      var opacity = a.opacity !== undefined ? a.opacity : e.opacity;
      var scale = a.scale !== undefined ? a.scale : 1;
      var rotation = a.rotation !== undefined ? a.rotation : e.rotation;
      var blur = a.blur !== undefined ? a.blur : 0;
      el.style.opacity = String(opacity);
      el.style.transform = "translate(" + (x - e.x) + "px," + (y - e.y) + "px) rotate(" + rotation + "deg) scale(" + scale + ")";
      el.style.filter = blur > 0.01 ? "blur(" + blur + "px)" : "none";
    }
    applyCamera(t);
    applyClip(t);
    applyReveals(t);
    applySvgDraw(t);
    if (typeof window.__ULTRA_CHOREO === "function") window.__ULTRA_CHOREO(t);
  }

  window.__ULTRA_SEEK = async function (frameIndex, fps) {
    var t = frameIndex / fps;
    window.__ULTRA_FRAME = frameIndex;
    window.__ULTRA_TIME = t;
    apply(t);
    var animations = document.getAnimations ? document.getAnimations() : [];
    for (var i = 0; i < animations.length; i += 1) {
      try { animations[i].pause(); animations[i].currentTime = t * 1000; } catch (e) { /* noop */ }
    }
    var videos = document.querySelectorAll("video");
    for (var v = 0; v < videos.length; v += 1) {
      var video = videos[v];
      if (!isFinite(video.duration) || video.duration <= 0) continue;
      var offsetAttr = video.getAttribute("data-source-in");
      var base = offsetAttr !== null ? (parseFloat(offsetAttr) || 0) : 0;
      var target = Math.min(base + t, video.duration - 0.001);
      if (Math.abs(video.currentTime - target) > 0.0008) {
        await new Promise(function (resolve) {
          var done = false;
          function finish() { if (!done) { done = true; resolve(); } }
          video.addEventListener("seeked", finish, { once: true });
          setTimeout(finish, 400);
          video.currentTime = target;
        });
      }
    }
    await new Promise(function (resolve) {
      requestAnimationFrame(function () { requestAnimationFrame(resolve); });
    });
    return true;
  };
  apply(0);
})();
`;

/* ============================================================================
 * Custom scene escape hatch
 * ========================================================================== */

const MOTION_PRELUDE = String.raw`
(function () {
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function outCubic(t) { t = clamp(t, 0, 1); var p = t - 1; return p * p * p + 1; }
  function inOutCubic(t) { t = clamp(t, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 + 4 * Math.pow(t - 1, 3); }
  function outExpo(t) { t = clamp(t, 0, 1); return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); }
  function outBack(t) { t = clamp(t, 0, 1); var c1 = 1.70158, c3 = c1 + 1, p = t - 1; return 1 + c3 * p * p * p + c1 * p * p; }
  function spring(t, stiffness, damping) {
    var k = stiffness === undefined ? 12 : stiffness;
    var d = damping === undefined ? 6 : damping;
    t = Math.max(0, t);
    if (t === 0) return 0;
    if (t >= 2) return 1;
    return 1 - Math.exp(-d * t) * Math.cos(k * t);
  }
  window.UltraEase = {
    clamp: clamp,
    linear: function (t) { return clamp(t, 0, 1); },
    easeOutCubic: outCubic,
    easeInOutCubic: inOutCubic,
    easeOutExpo: outExpo,
    easeOutBack: outBack,
    spring: spring
  };
})();
`;

const CUSTOM_RUNTIME = String.raw`
(function () {
  "use strict";
  var DURATION = __ULTRA_DURATION__;
  var FPS = __ULTRA_FPS__;
  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function pauseAnimations(t) {
    var animations = document.getAnimations ? document.getAnimations() : [];
    for (var i = 0; i < animations.length; i += 1) {
      try { animations[i].pause(); animations[i].currentTime = t * 1000; } catch (e) { /* noop */ }
    }
  }
  window.__ULTRA_PAUSE_ANIMATIONS = pauseAnimations;
  window.__ULTRA_SEEK = async function (frameIndex, fps) {
    var safeFps = fps || FPS;
    var t = frameIndex / safeFps;
    var progress = DURATION > 0 ? clamp(t / DURATION, 0, 1) : 0;
    window.__ULTRA_FRAME = frameIndex;
    window.__ULTRA_TIME = t;
    window.__ULTRA_PROGRESS = progress;
    if (typeof window.ultraRender === "function") {
      await window.ultraRender(frameIndex, safeFps, t, progress, window.__ULTRA_AUDIO);
    }
    try {
      window.dispatchEvent(new CustomEvent("ultra:frame", {
        detail: { frame: frameIndex, fps: safeFps, timeSec: t, progress: progress, audio: window.__ULTRA_AUDIO }
      }));
    } catch (e) { /* noop */ }
    pauseAnimations(t);
    var videos = document.querySelectorAll("video");
    for (var v = 0; v < videos.length; v += 1) {
      var video = videos[v];
      if (!isFinite(video.duration) || video.duration <= 0) continue;
      var offsetAttr = video.getAttribute("data-source-in");
      var base = offsetAttr !== null ? (parseFloat(offsetAttr) || 0) : 0;
      var target = Math.min(base + t, video.duration - 0.001);
      if (Math.abs(video.currentTime - target) > 0.0008) {
        await new Promise(function (resolve) {
          var done = false;
          function finish() { if (!done) { done = true; resolve(); } }
          video.addEventListener("seeked", finish, { once: true });
          setTimeout(finish, 400);
          video.currentTime = target;
        });
      }
    }
    await new Promise(function (resolve) {
      requestAnimationFrame(function () { requestAnimationFrame(resolve); });
    });
    return true;
  };
  window.__ULTRA_SEEK(0, FPS);
})();
`;

async function loadAudioEnvelope(workspace: string): Promise<unknown> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(workspace, "audio-envelope.json"), "utf8")) as Record<string, unknown>;
    if (Array.isArray(raw["frames"])) return raw;
  } catch {
    // no envelope available
  }
  return null;
}

function injectIntoTemplateDocument(html: string, injection: { meta: string; baseCss: string; userCss: string; tail: string }): string {
  let doc = html;
  const headInjection = `${injection.meta}${injection.baseCss}${injection.userCss}`;
  if (/<head[^>]*>/i.test(doc)) {
    doc = doc.replace(/<head([^>]*)>/i, `<head$1>${headInjection}`);
  } else if (/<html[^>]*>/i.test(doc)) {
    doc = doc.replace(/<html([^>]*)>/i, `<html$1><head>${headInjection}</head>`);
  } else {
    doc = `<head>${headInjection}</head>` + doc;
  }
  if (/<\/body>/i.test(doc)) doc = doc.replace(/<\/body>/i, `${injection.tail}</body>`);
  else doc += injection.tail;
  if (!/<!doctype html>/i.test(doc)) doc = "<!doctype html>\n" + doc;
  return doc;
}

async function compileCustomSceneHtml(opts: CompileOptions): Promise<string> {
  const { scene, workspace, width, height, fps, project } = opts;
  const isFullDocument = (source: string) => /<html[\s>]/i.test(source) || /<body[\s>]/i.test(source);

  let source = "";
  if (scene.customHtmlFile) {
    const file = path.resolve(workspace, "scenes", scene.customHtmlFile);
    const scenesDir = path.resolve(workspace, "scenes");
    if (!file.startsWith(scenesDir + path.sep) && file !== scenesDir) {
      throw new Error(`customHtmlFile escapes workspace/scenes: ${scene.customHtmlFile}`);
    }
    source = await readTextFile(file, `customHtmlFile "${scene.customHtmlFile}"`);
  } else if (scene.customCode) {
    source = `${scene.customCode.html}`;
  }

  const audio = await loadAudioEnvelope(workspace);
  const background = scene.background === "transparent" ? "transparent" : scene.background;
  const meta = `<meta charset="utf-8"/><meta name="viewport" content="width=${width}, height=${height}"/>`;
  const fontFaces = await fontFaceCss(project, workspace);
  const baseCss = `<style id="ultra-base">${fontFaces}html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;background:${background};}</style>`;
  const userCss = scene.customCode ? `<style id="ultra-user-css">${scene.customCode.css}</style>` : "";
  const prelude = `<script>${MOTION_PRELUDE}</script><script>window.__ULTRA_AUDIO = ${JSON.stringify(audio)};</script>`;
  const js = scene.customCode?.js ?? "";
  const runtime = CUSTOM_RUNTIME.replace(/__ULTRA_DURATION__/g, String(Math.max(0.001, scene.endSec - scene.startSec)))
    .replace(/__ULTRA_FPS__/g, String(fps));
  const tail = `${prelude}<script id="ultra-user-js">${js}</script><script id="ultra-custom-runtime">${runtime}</script>`;

  if (isFullDocument(source)) {
    return injectIntoTemplateDocument(source, { meta, baseCss, userCss, tail });
  }
  const fragmentDoc = `<html><head>${meta}${baseCss}${userCss}</head><body>${source}</body></html>`;
  return injectIntoTemplateDocument(fragmentDoc, { meta: "", baseCss: "", userCss: "", tail });
}

/* ============================================================================
 * Standard scene compiler
 * ========================================================================== */

export async function compileSceneHtml(opts: CompileOptions): Promise<string> {
  const { project, scene, workspace, width, height, fps } = opts;
  if (scene.customHtmlFile || scene.customCode) {
    return compileCustomSceneHtml(opts);
  }

  const tokens = project.designTokens;
  const fontFaces = await fontFaceCss(project, workspace);
  const background =
    scene.background === "transparent" ? (scene.alpha ? "transparent" : "#000000") : scene.background;

  const glowEffect = scene.effects.find((e) => e.type === "glow");
  const chromaticEffect = scene.effects.find((e) => e.type === "chromatic");
  const blurEffect = scene.effects.find((e) => e.type === "blur");
  const grainEffects = scene.effects.filter((e) => e.type === "grain");
  const vignetteEffects = scene.effects.filter((e) => e.type === "vignette");
  const halftoneEffects = scene.effects.filter((e) => e.type === "halftone");

  const textShadows: string[] = [];
  if (chromaticEffect) {
    const k = Math.max(0.5, chromaticEffect.intensity * 4);
    textShadows.push(`-${k}px 0 rgba(255,40,90,0.55)`, `${k}px 0 rgba(40,200,255,0.55)`);
  }
  if (glowEffect) {
    const g = Math.max(2, glowEffect.intensity * 26);
    textShadows.push(`0 0 ${g}px rgba(255,255,255,${(0.25 + glowEffect.intensity * 0.35).toFixed(2)})`);
  }

  const elements: CompiledElement[] = [];
  const reveals: Record<string, unknown>[] = [];
  const svgDraws: Record<string, unknown>[] = [];
  const layerHtml: string[] = [];

  // Process 2B: trimmed segment of the user's own footage behind all layers.
  let sourceHtml = "";
  if (scene.sourceClip) {
    const clip = scene.sourceClip;
    const sourcePath = await resolveSourceClipPath(workspace, clip.path);
    const url = pathToFileURL(sourcePath).href;
    elements.push({ uid: "source-clip", x: 0, y: 0, opacity: 1, rotation: 0 });
    sourceHtml = `<div class="layer media source-clip" data-audit="el" data-clip-exempt="true" data-uid="source-clip" style="left:0;top:0;width:${width}px;height:${height}px;z-index:1;overflow:hidden"><video src="${url}" muted playsinline preload="auto" data-source-in="${clip.inSec}" style="width:100%;height:100%;object-fit:${clip.cropMode};transform:translate(${clip.panX}px,${clip.panY}px) scale(${clip.scale})"></video></div>`;
  }

  for (let index = 0; index < scene.layers.length; index += 1) {
    const layer = scene.layers[index] as SceneSpecT["layers"][number];
    elements.push({ uid: layer.id, x: layer.x, y: layer.y, opacity: layer.opacity, rotation: layer.rotation });
    const base = [
      `left:${layer.x}px`,
      `top:${layer.y}px`,
      ...(layer.width !== undefined ? [`width:${layer.width}px`] : []),
      ...(layer.height !== undefined ? [`height:${layer.height}px`] : []),
      `opacity:${layer.opacity}`,
      `border-radius:${layer.radius}px`,
      `z-index:${10 + index}`,
      `transform:rotate(${layer.rotation}deg)`,
      ...(layer.blend !== "normal" ? [`mix-blend-mode:${layer.blend}`] : []),
    ];

    if (layer.type === "shape") {
      if (layer.glass) {
        layerHtml.push(
          `<div class="layer shape glass" data-audit="el" data-role="shape" data-uid="${htmlEscape(layer.id)}" style="${base.join(
            ";",
          )};background-color:${rgba(layer.color as string, 0.16)};border:1px solid ${rgba("#ffffff", 0.16)};backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4)"></div>`,
        );
      } else {
        layerHtml.push(
          `<div class="layer shape" data-audit="el" data-role="shape" data-uid="${htmlEscape(layer.id)}" style="${base.join(
            ";",
          )};background-color:${layer.color}"></div>`,
        );
      }
      continue;
    }
    if (layer.type === "grain" || layer.type === "vignette") {
      layerHtml.push(
        `<div class="layer fx-slot" data-audit="el" data-uid="${htmlEscape(layer.id)}" style="${base.join(";")}"></div>`,
      );
      continue;
    }
    if (layer.type === "video") {
      const url = assetUrl(project, workspace, layer.assetId as string);
      layerHtml.push(
        `<div class="layer media" data-audit="el" data-uid="${htmlEscape(layer.id)}" style="${base.join(
          ";",
        )}"><video src="${url}" muted playsinline preload="auto" style="width:100%;height:100%;object-fit:cover"></video></div>`,
      );
      continue;
    }
    if (layer.type === "svg" && layer.svgDraw) {
      const asset = project.assets.find((a) => a.id === layer.assetId);
      if (!asset) throw new Error(`hyperframes: unknown asset "${layer.assetId}"`);
      let svg = await readTextFile(resolveAssetPath(workspace, asset), `svg asset "${asset.id}"`);
      svg = svg
        .replace(/<\?xml[\s\S]*?\?>/gi, "")
        .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
        .replace(/<(path|line|polyline|polygon|circle|ellipse|rect)([^>]*)>/gi, (whole: string, tag: string, attrs: string) =>
          /pathLength/i.test(attrs) ? whole : `<${tag} pathLength="1"${attrs}>`,
        )
        .replace(/<svg\b/i, '<svg class="ultra-svg" style="width:100%;height:100%;display:block"');
      svgDraws.push({ uid: layer.id, delay: layer.drawDelaySec, duration: layer.drawDurationSec });
      layerHtml.push(
        `<div class="layer svg-inline" data-audit="el" data-uid="${htmlEscape(layer.id)}" data-svgdraw="${htmlEscape(
          layer.id,
        )}" style="${base.join(";")}">${svg}</div>`,
      );
      continue;
    }
    const url = assetUrl(project, workspace, layer.assetId as string);
    layerHtml.push(
      `<div class="layer media" data-audit="el" data-uid="${htmlEscape(layer.id)}" style="${base.join(
        ";",
      )}"><img src="${url}" alt="" draggable="false" style="width:100%;height:100%;object-fit:contain"/></div>`,
    );
  }

  const textHtml: string[] = [];
  const weightDefaults: Record<string, number> = { heading: 700, body: 450, mono: 500 };
  for (let index = 0; index < scene.textElements.length; index += 1) {
    const textEl = scene.textElements[index] as SceneSpecT["textElements"][number];
    elements.push({ uid: textEl.id, x: textEl.x, y: textEl.y, opacity: 1, rotation: 0 });
    if (textEl.reveal && textEl.reveal.mode !== "none") {
      reveals.push({
        uid: textEl.id,
        mode: textEl.reveal.mode,
        staggerSec: textEl.reveal.staggerSec,
        durationSec: textEl.reveal.durationSec,
        delaySec: textEl.reveal.delaySec,
        from: textEl.reveal.from,
        distancePx: textEl.reveal.distancePx,
        easing: textEl.reveal.easing,
        mask: textEl.reveal.mask,
      });
    }
    const font = tokens.fonts[textEl.font];
    const shadows = textShadows.length > 0 ? `;text-shadow:${textShadows.join(",")}` : "";
    const style = [
      `left:${textEl.x}px`,
      `top:${textEl.y}px`,
      ...(textEl.width !== undefined ? [`width:${textEl.width}px`] : ["white-space:pre"]),
      `font-family:${fontStack(font)}`,
      `font-size:${textEl.sizePx}px`,
      `font-weight:${textEl.weight ?? weightDefaults[textEl.font] ?? 500}`,
      `color:${textEl.color}`,
      `letter-spacing:${textEl.letterSpacingPx}px`,
      `line-height:${textEl.lineHeight}`,
      `text-align:${textEl.align}`,
      `z-index:${100 + index}`,
      "transform-origin:center center",
      ...(textEl.uppercase ? ["text-transform:uppercase"] : []),
    ];
    textHtml.push(
      `<div class="text" data-audit="text" data-uid="${htmlEscape(textEl.id)}"${
        textEl.reveal && textEl.reveal.mode !== "none" ? ` data-reveal="${htmlEscape(textEl.id)}"` : ""
      } style="${style.join(";")}${shadows}">${revealMarkup(textEl.text, textEl.reveal)}</div>`,
    );
  }

  /* ---- word-level captions (workspace/captions.json on sourceClip scenes) ---- */
  const captionsDoc = await loadCaptionsForScene(workspace, scene);
  const captionHtml: string[] = [];
  const captionData: Record<string, unknown>[] = [];
  let captionCss = "";
  if (captionsDoc) {
    const palette = tokens.palette;
    const paletteValues = Object.values(palette).map(normalizeHex);
    const captionColor = normalizeHex(palette["textPrimary"] ?? palette["fg"] ?? palette["text"] ?? "#ffffff");
    const bgColor = normalizeHex(palette["bg"] ?? paletteValues[0] ?? "#000000");
    const accent = normalizeHex(
      palette["accent"] ?? palette["accent1"] ?? paletteValues.find((c) => c !== bgColor && c !== captionColor) ?? captionColor,
    );
    const chunks = chunksInWindow(captionsDoc, scene.startSec, scene.endSec);
    const fontPx = Math.max(18, Math.round(height * (height > width ? 0.045 : 0.05)));
    const highlight = captionsDoc.typography.activeWordHighlight;
    const casing = captionsDoc.typography.casing;
    for (const chunk of chunks) {
      const uid = `${scene.id}-${chunk.id}`.replace(/[^\w.-]/g, "_");
      const wordsHtml = chunk.words
        .map(
          (word, wi) =>
            `<span class="cw" data-word-index="${wi}">${htmlEscape(applyCasing(word.text, casing))}</span>`,
        )
        .join(" ");
      captionHtml.push(
        `<div class="ultra-caption" data-caption="true" data-caption-uid="${htmlEscape(uid)}" data-audit="text" data-uid="${htmlEscape(
          uid,
        )}" style="left:${chunk.safeBox.xPercent}%;top:${chunk.safeBox.yPercent}%;width:${chunk.safeBox.widthPercent}%;height:${chunk.safeBox.heightPercent}%;font-family:${fontStack(
          captionsDoc.typography.captionFont,
        )};font-size:${fontPx}px;color:${captionColor};${captionsDoc.typography.strokePx > 0 ? `-webkit-text-stroke:${captionsDoc.typography.strokePx}px ${bgColor};` : ""}display:none"><div class="ultra-caption-line">${wordsHtml}</div></div>`,
      );
      captionData.push({
        uid,
        startSec: chunk.startSec,
        endSec: chunk.endSec,
        words: chunk.words.map((w) => ({ startSec: w.startSec, endSec: w.endSec })),
      });
    }
    captionCss = `
  .ultra-captions { position:absolute; inset:0; z-index:600; pointer-events:none; }
  .ultra-caption { position:absolute; align-items:flex-end; justify-content:center; text-align:center; font-weight:700; line-height:1.16; letter-spacing:0.02em; text-shadow:0 3px 16px rgba(0,0,0,0.72); }
  .ultra-caption-line { display:flex; flex-wrap:wrap; justify-content:center; gap:0.16em 0.1em; }
  .ultra-caption .cw { display:inline-block; padding:0 0.1em; border-radius:0.2em; }
  .ultra-captions.hl-pill .cw.active { background:${accent}; color:${bgColor}; text-shadow:none; }
  .ultra-captions.hl-color .cw.active { color:${accent}; }
  .ultra-captions.hl-scale .cw.active { color:${accent}; transform:scale(1.14); }
  .ultra-captions.hl-underline .cw.active { color:${accent}; border-bottom:0.08em solid ${accent}; }`;
    if (captionHtml.length > 0) {
      captionHtml.unshift(`<div class="ultra-captions hl-${highlight}">`);
      captionHtml.push("</div>");
    }
  }

  const choreo = scene.engine === "revideo" ? buildChoreography({ project, scene, width, height }) : null;

  const fxHtml: string[] = [];
  const tokenGrain = tokens.grainOpacity;
  const effectGrain = grainEffects.reduce((acc, e) => Math.max(acc, e.intensity), 0);
  const grainOpacity = Math.min(1, Math.max(tokenGrain, effectGrain * 0.5));
  if (grainOpacity > 0.001) {
    fxHtml.push(
      `<div class="fx fx-grain" data-audit="fx" style="opacity:${grainOpacity};background-image:${grainDataUri()}"></div>`,
    );
  }
  const halftoneIntensity = halftoneEffects.reduce((acc, e) => Math.max(acc, e.intensity), 0);
  if (halftoneIntensity > 0.001) {
    const size = Math.max(4, Math.round(8 - halftoneIntensity * 3));
    fxHtml.push(
      `<div class="fx fx-halftone" data-audit="fx" style="opacity:${(0.12 + halftoneIntensity * 0.38).toFixed(
        2,
      )};background-image:radial-gradient(circle, rgba(255,255,255,0.55) 1px, transparent 1.4px);background-size:${size}px ${size}px"></div>`,
    );
  }
  const vignetteIntensity = vignetteEffects.reduce((acc, e) => Math.max(acc, e.intensity), 0);
  if (vignetteIntensity > 0.001) {
    fxHtml.push(
      `<div class="fx fx-vignette" data-audit="fx" style="background:radial-gradient(ellipse at center, rgba(0,0,0,0) 52%, rgba(0,0,0,${(
        0.35 +
        vignetteIntensity * 0.55
      ).toFixed(2)}) 100%)"></div>`,
    );
  }

  const data = {
    fps,
    sceneId: scene.id,
    durationSec: scene.endSec - scene.startSec,
    elements,
    tracks: scene.keyframes.map((track) => ({
      target: track.target,
      property: track.property,
      keyframes: track.keyframes.map((kf) => ({ atSec: kf.atSec, value: kf.value, ease: kf.ease })),
    })),
    reveals,
    svgDraws,
    camera: scene.camera && scene.camera.keyframes.length > 0 ? { perspectivePx: scene.camera.perspectivePx, keyframes: scene.camera.keyframes } : null,
    clipReveal:
      scene.clipReveal && scene.clipReveal.type !== "none"
        ? { type: scene.clipReveal.type, durationSec: scene.clipReveal.durationSec, delaySec: scene.clipReveal.delaySec }
        : null,
    sceneStartSec: scene.startSec,
    captions: captionData,
  };
  const dataJson = JSON.stringify(data).replace(/</g, "\\u003c");
  const contentBlur = blurEffect ? `filter:blur(${(blurEffect.intensity * 6).toFixed(2)}px);` : "";
  const perspective = scene.camera?.perspectivePx ?? 1200;

  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>${htmlEscape(scene.name)}</title>
<style>
  ${fontFaces}
  html, body { margin:0; padding:0; width:${width}px; height:${height}px; overflow:hidden; background:${background}; }
  * { box-sizing:border-box; }
  #stage { position:absolute; inset:0; width:${width}px; height:${height}px; overflow:hidden; background:${background}; }
  #camera { position:absolute; inset:0; perspective:${perspective}px; perspective-origin:50% 50%; transform-style:preserve-3d; }
  #content { position:absolute; inset:0; ${contentBlur} }
  .layer { position:absolute; }
  .layer.media img, .layer.media video, .layer.svg-inline svg { display:block; }
  .text { position:absolute; }
  .rv { display:inline-block; overflow:hidden; vertical-align:top; }
  .rv .rv-i { display:inline-block; will-change:transform; }
  .fx { position:absolute; inset:0; pointer-events:none; }
  .fx-grain { background-repeat:repeat; background-size:240px 240px; z-index:900; }
  .fx-halftone { z-index:880; }
  .fx-vignette { z-index:890; }
  ${captionCss}
</style></head>
<body>
  <div id="stage">
    <div id="camera">
      <div id="content">
      ${sourceHtml}
      ${layerHtml.join("\n      ")}
      ${choreo ? choreo.html : ""}
      ${textHtml.join("\n      ")}
      ${captionHtml.join("\n      ")}
      ${fxHtml.join("\n      ")}
      </div>
    </div>
  </div>
  ${choreo ? `<script>${choreo.js}</script>` : ""}
  <script id="ultra-data" type="application/json">${dataJson}</script>
  <script>${PAGE_RUNTIME}</script>
</body></html>`;
}

export function compiledHtmlPath(buildDir: string, sceneId: string): string {
  return path.join(buildDir, "tmp", `hf_${sceneId.replace(/[^\w.-]/g, "_")}.html`);
}
