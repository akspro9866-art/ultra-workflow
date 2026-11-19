import type { SceneSpecT, UltraProjectT } from "../../core/schema.js";
import { fontStack, htmlEscape, normalizeHex, rgba } from "./style.js";

/**
 * Built-in "Revideo-style" sequential vector choreography runtime.
 *
 * These are deterministic, offline, Chromium-native scenes generated purely from
 * `enginePayload` (no native Revideo install needed). The compiled page exposes
 * `window.__ULTRA_CHOREO(t)` and the page runtime calls it on every seek.
 */

export interface ChoreoBlock {
  html: string;
  js: string;
}

interface ChoreoOptions {
  project: UltraProjectT;
  scene: SceneSpecT;
  width: number;
  height: number;
}

const VECTOR_TYPES = new Set(["vectors", "diagram", "sequence", "chart", "counter", "code"]);

function pickColors(project: UltraProjectT, scene: SceneSpecT) {
  const palette = Object.values(project.designTokens.palette);
  const bg = scene.background !== "transparent" ? normalizeHex(scene.background) : palette[0] ? normalizeHex(palette[0]) : "#101820";
  const rest = palette.map(normalizeHex).filter((c) => c !== bg);
  return {
    bg,
    fg: rest[2] ?? rest[0] ?? "#f2f2f0",
    accent: rest[0] ?? "#ffb703",
    secondary: rest[1] ?? rest[0] ?? "#8ecae6",
  };
}

function formatValue(v: number): string {
  if (v <= 1.0001) return `${Math.round(v * 100)}%`;
  return String(Math.round(v));
}

export function buildChoreography(opts: ChoreoOptions): ChoreoBlock | null {
  const { project, scene, width, height } = opts;
  const payload = scene.enginePayload as Record<string, unknown>;
  const sceneType = typeof payload["sceneType"] === "string" ? (payload["sceneType"] as string) : "";
  if (!VECTOR_TYPES.has(sceneType)) return null;
  if (scene.customHtmlFile || scene.customCode) return null;

  const colors = pickColors(project, scene);
  const heading = fontStack(project.designTokens.fonts.heading);
  const mono = fontStack(project.designTokens.fonts.mono);
  const title = typeof payload["title"] === "string" ? (payload["title"] as string) : scene.name;
  const suffixId = scene.id.replace(/[^\w-]/g, "_");
  const duration = Math.max(0.1, scene.endSec - scene.startSec);
  const values = Array.isArray(payload["values"]) && (payload["values"] as unknown[]).length >= 2
    ? (payload["values"] as number[]).map((v) => Number(v))
    : [0.28, 0.52, 0.37, 0.78, 0.64];
  const labels = Array.isArray(payload["labels"]) ? (payload["labels"] as unknown[]).map(String) : values.map((_, i) => String(i + 1));

  const titleHtml = `<div data-audit="text" style="position:absolute;left:110px;top:52px;font-family:${heading};font-size:44px;font-weight:700;letter-spacing:0.02em;color:${colors.fg};z-index:120">${htmlEscape(title)}</div>`;

  if (sceneType === "counter") {
    const target = Number(payload["target"] ?? 100);
    const prefix = typeof payload["prefix"] === "string" ? payload["prefix"] : "";
    const suffix = typeof payload["suffix"] === "string" ? payload["suffix"] : "";
    const label = typeof payload["label"] === "string" ? payload["label"] : "total";
    const html = `${titleHtml}
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px">
        <div id="cho-num-${suffixId}" data-audit="text" style="font-family:${heading};font-size:168px;font-weight:800;letter-spacing:-0.03em;color:${colors.accent};line-height:1">${htmlEscape(prefix)}0${htmlEscape(suffix)}</div>
        <div data-audit="text" style="font-family:${mono};font-size:24px;letter-spacing:0.14em;text-transform:uppercase;color:${colors.secondary}">${htmlEscape(label)}</div>
      </div>`;
    const js = `(function(){
      var el = document.getElementById("cho-num-${suffixId}");
      var D = ${duration}, target = ${target}, prefix = ${JSON.stringify(prefix)}, suffix = ${JSON.stringify(suffix)};
      function clamp(x,a,b){ return x<a?a:(x>b?b:x); }
      function easeOutExpo(t){ return t>=1?1:1-Math.pow(2,-10*t); }
      window.__ULTRA_CHOREO = function(t){
        var p = easeOutExpo(clamp((t - 0.1) / (D * 0.72), 0, 1));
        el.textContent = prefix + String(Math.round(target * p)) + suffix;
      };
      window.__ULTRA_CHOREO(0);
    })();`;
    return { html, js };
  }

  if (sceneType === "code") {
    const lines = Array.isArray(payload["lines"]) && (payload["lines"] as unknown[]).length > 0
      ? (payload["lines"] as unknown[]).map(String)
      : ["const frames = seek(t);", "verify({ stutterEvents: 0 });", "render({ crf: 16 });"];
    const lineHeight = 46;
    const top = Math.max(140, Math.round(height * 0.32));
    const rows = lines
      .map(
        (line, i) =>
          `<div class="cho-line" style="height:${lineHeight}px;line-height:${lineHeight}px">${htmlEscape(line)}</div>`,
      )
      .join("");
    const html = `${titleHtml}
      <div style="position:absolute;left:110px;top:${top}px;width:${Math.round(width * 0.68)}px;padding:18px 26px;border-radius:14px;background:${rgba(colors.fg, 0.05)};border:1px solid ${rgba(colors.secondary, 0.35)};z-index:110">
        <div id="cho-hl-${suffixId}" style="position:absolute;left:8px;right:8px;height:${lineHeight}px;border-radius:8px;background:${rgba(colors.accent, 0.16)};top:18px"></div>
        <div data-audit="text" style="position:relative;font-family:${mono};font-size:24px;color:${colors.fg};white-space:pre">${rows}</div>
      </div>`;
    const js = `(function(){
      var hl = document.getElementById("cho-hl-${suffixId}");
      var lines = hl.parentElement.querySelectorAll(".cho-line");
      var D = ${duration}, LH = ${lineHeight}, N = ${lines.length};
      function clamp(x,a,b){ return x<a?a:(x>b?b:x); }
      window.__ULTRA_CHOREO = function(t){
        var p = clamp(t / (D * 0.85), 0, 1) * (N + 0.001);
        for (var i = 0; i < N; i += 1) {
          lines[i].style.opacity = i < p ? "1" : "0.08";
        }
        var idx = Math.min(N - 1, Math.floor(p));
        hl.style.top = (18 + idx * LH) + "px";
      };
      window.__ULTRA_CHOREO(0);
    })();`;
    return { html, js };
  }

  if (sceneType === "chart") {
    const left = 120;
    const right = width - 120;
    const baseY = height - 110;
    const topY = Math.round(height * 0.34);
    const slot = (right - left) / values.length;
    const bars = values
      .map((v, i) => {
        const barW = Math.min(120, slot * 0.55);
        const x = left + slot * i + (slot - barW) / 2;
        const h = Math.max(4, Math.round(Math.min(1, Math.abs(v)) * (baseY - topY)));
        return `<g class="cho-bar" data-i="${i}">
          <rect x="${x.toFixed(1)}" y="${(baseY - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h}" rx="8" fill="${i === values.length - 1 ? colors.accent : colors.secondary}" opacity="0.92"></rect>
          <text x="${(x + barW / 2).toFixed(1)}" y="${(baseY + 40).toFixed(1)}" text-anchor="middle" font-family="${mono}" font-size="22" fill="${colors.fg}" opacity="0.75">${htmlEscape(labels[i] ?? String(i + 1))}</text>
        </g>`;
      })
      .join("\n");
    const html = `${titleHtml}
      <svg viewBox="0 0 ${width} ${height}" style="position:absolute;inset:0;z-index:100">
        <line x1="${left - 20}" y1="${baseY + 1}" x2="${right + 20}" y2="${baseY + 1}" stroke="${rgba(colors.secondary, 0.45)}" stroke-width="2"></line>
        ${bars}
      </svg>`;
    const js = `(function(){
      var bars = document.querySelectorAll('[data-i] > rect');
      var groups = document.querySelectorAll('.cho-bar');
      var D = ${duration};
      function clamp(x,a,b){ return x<a?a:(x>b?b:x); }
      function easeOutBack(t){ var c1=1.70158, c3=c1+1; var p=t-1; return 1+c3*p*p*p+c1*p*p; }
      window.__ULTRA_CHOREO = function(t){
        for (var i = 0; i < groups.length; i += 1) {
          var g = groups[i];
          var p = clamp((t - 0.12 - i * 0.09) / 0.55, 0, 1);
          var e = easeOutBack(p);
          g.style.transform = "translateY(" + (1 - e) * 60 + "px)";
          g.style.opacity = String(p);
        }
      };
      window.__ULTRA_CHOREO(0);
    })();`;
    return { html, js };
  }

  // vectors / diagram / sequence: animated polyline + staggered nodes.
  const left = 130;
  const right = width - 130;
  const baseY = height - 150;
  const topY = Math.round(height * 0.34);
  const n = values.length;
  const px = (i: number) => left + (n === 1 ? 0 : (i / (n - 1)) * (right - left));
  const py = (v: number) => baseY - Math.max(0, Math.min(1, v)) * (baseY - topY);
  const points = values.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
  const dots = values
    .map(
      (v, i) => `<g class="cho-node" data-i="${i}">
        <circle cx="${px(i).toFixed(1)}" cy="${py(v).toFixed(1)}" r="10" fill="${i === n - 1 ? colors.accent : colors.secondary}"></circle>
        <text x="${px(i).toFixed(1)}" y="${(py(v) - 30).toFixed(1)}" text-anchor="middle" font-family="${mono}" font-size="24" fill="${colors.fg}">${formatValue(v)}</text>
        <text x="${px(i).toFixed(1)}" y="${(baseY + 44).toFixed(1)}" text-anchor="middle" font-family="${mono}" font-size="20" fill="${colors.secondary}" opacity="0.8">${htmlEscape(labels[i] ?? String(i + 1))}</text>
      </g>`,
    )
    .join("\n");
  const html = `${titleHtml}
    <svg viewBox="0 0 ${width} ${height}" style="position:absolute;inset:0;z-index:100">
      <line x1="${left - 30}" y1="${baseY + 1}" x2="${right + 30}" y2="${baseY + 1}" stroke="${rgba(colors.secondary, 0.4)}" stroke-width="2"></line>
      <line x1="${left - 30}" y1="${topY - 40}" x2="${left - 30}" y2="${baseY + 1}" stroke="${rgba(colors.secondary, 0.25)}" stroke-width="2"></line>
      <polyline id="cho-path-${suffixId}" points="${points}" fill="none" stroke="${colors.accent}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"></polyline>
      ${dots}
    </svg>`;
  const js = `(function(){
    var path = document.getElementById("cho-path-${suffixId}");
    var nodes = document.querySelectorAll(".cho-node");
    var D = ${duration};
    function clamp(x,a,b){ return x<a?a:(x>b?b:x); }
    function easeInOutCubic(t){ return t<0.5 ? 4*t*t*t : 1+4*Math.pow(t-1,3); }
    function easeOutBack(t){ var c1=1.70158, c3=c1+1; var p=t-1; return 1+c3*p*p*p+c1*p*p; }
    window.__ULTRA_CHOREO = function(t){
      var draw = easeInOutCubic(clamp((t - 0.1) / (D * 0.55), 0, 1));
      path.style.strokeDashoffset = String(1 - draw);
      for (var i = 0; i < nodes.length; i += 1) {
        var node = nodes[i];
        var stagger = ${Math.min(0.11, 0.5 / Math.max(1, n)).toFixed(4)};
        var p = clamp((t - 0.18 - i * stagger) / 0.34, 0, 1);
        var e = easeOutBack(p);
        node.style.transform = "translateY(" + (1 - e) * 26 + "px)";
        node.style.opacity = String(clamp(p * 1.4, 0, 1));
        node.style.transformOrigin = "center";
      }
    };
    window.__ULTRA_CHOREO(0);
  })();`;
  return { html, js };
}
