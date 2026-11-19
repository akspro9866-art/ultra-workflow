/**
 * Render the built-in Style Pack exemplars with Ultra Workflow itself:
 * a temporary custom scene is compiled by the HyperFrames compiler (bundled
 * fonts, deterministic runtime), seeked to a hero frame, and screenshotted at
 * 640px wide. Run: `npx tsx scripts/make-style-exemplars.ts`.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UltraProject, SceneSpec } from "../core/schema.js";
import { ensureDir, pathExists } from "../core/util.js";
import { compileSceneHtml } from "../engines/hyperframes/compiler.js";
import { newPage, closePage, settlePage, shutdownBrowser } from "../core/browser.js";
import { rebuildRegistry } from "../core/style-pack.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FPS = 30;
const DURATION = 3;

interface PackDef {
  slug: string;
  aspect: "9:16" | "16:9";
  width: number;
  height: number;
  palette: Record<string, string>;
  exemplars: {
    out: string;
    frame: number;
    motif?: string;
    code?: { html: string; css: string; js: string };
    name: string;
  }[];
}

const PUNCHY_CAPTIONS = {
  html: `
<div class="top"><span>CAPTION SYSTEM</span><span>02 / 03 · 09:16</span></div>
<div class="panel"><div class="stripe"></div><div class="orb"></div></div>
<div class="cap"><div class="line1" id="line1">THIS CHANGES</div><div class="line2"><span class="pill" id="pill">EVERYTHING</span></div></div>`,
  css: `
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0b0d12;font-family:'Ultra Sans','Segoe UI',sans-serif;color:#f7f5ef}
.top{position:absolute;left:6vw;right:6vw;top:7vh;display:flex;justify-content:space-between;font-family:'Ultra Mono',monospace;font-size:1.9vh;letter-spacing:.2em;color:#9aa4b2;text-transform:uppercase}
.panel{position:absolute;left:6vw;right:6vw;top:16vh;height:40vh;border-radius:1.4vh;background:#151a23;overflow:hidden;border:1px solid rgba(247,245,239,.08)}
.stripe{position:absolute;left:-12vw;top:-10vh;width:52vw;height:120vh;background:#ffd447;opacity:.16;transform:rotate(18deg)}
.orb{position:absolute;right:2vw;bottom:-12vh;width:44vw;height:44vw;border-radius:50%;background:#ff5a5f;opacity:.9}
.cap{position:absolute;left:5%;right:5%;top:60%;height:14%;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center}
.line1{font-family:'Ultra Display','Arial Black',sans-serif;font-weight:700;font-size:7.4vw;letter-spacing:-.02em}
.line2{margin-top:1.4vh}
.pill{display:inline-block;padding:1.1vh 2.6vw;border-radius:.6vh;background:#ffd447;color:#0b0d12;font-weight:700;font-size:5.4vw;letter-spacing:.01em}`,
  js: `
function outExpo(t){return t>=1?1:1-Math.pow(2,-10*Math.max(0,Math.min(1,t)));}
window.ultraRender=function(frame,fps){var t=frame/(fps||30);
 var p=outExpo((t-.15)/.5);
 document.getElementById('line1').style.opacity=String(p);
 document.getElementById('line1').style.transform='translateY('+(1-p)*2+'vh)';
 document.getElementById('pill').style.opacity=String(outExpo((t-.42)/.4));
 document.getElementById('pill').style.transform='scale('+(0.9+0.1*outExpo((t-.42)/.4))+')';
};`,
};

const KINETIC_CAPTIONS = {
  html: `
<div class="tag"><span>CHAPTER 02</span><span>THE MEASUREMENT</span></div>
<div class="image"><div class="block"></div><div class="disc"></div></div>
<div class="cap"><div class="a" id="a">The part nobody</div><div class="b"><span id="b">measures.</span></div></div>
<div class="src">Source: rewatch curve, 2026</div>
<div class="foot"><span>Kinetic Editorial</span><span>02 / 03</span></div>`,
  css: `
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#f6f0e6;font-family:'Ultra Sans','Segoe UI',sans-serif;color:#1c1b18}
.tag{position:absolute;left:6vw;right:6vw;top:7vh;display:flex;gap:3vw;font-family:'Ultra Mono',monospace;font-size:1.55vh;letter-spacing:.2em;text-transform:uppercase;color:#6a645a}
.tag span:first-child{color:#e4572e}
.image{position:absolute;left:6vw;top:15vh;width:44vw;height:42vh;background:#1c1b18;overflow:hidden}
.image .block{position:absolute;left:6vw;top:6vh;width:26vw;height:20vh;background:#2f5d62;opacity:.9}
.image .disc{position:absolute;right:-8vw;bottom:-10vh;width:30vw;height:30vw;border-radius:50%;background:#e4572e}
.cap{position:absolute;left:6vw;right:6vw;top:64%;}
.cap .a{font-size:4.4vh;line-height:1.15;letter-spacing:-.01em}
.cap .b{font-family:'Ultra Display','Arial Black',sans-serif;font-weight:700;font-size:6.2vh;line-height:1.05;margin-top:1.1vh}
.cap .b span{border-bottom:.7vh solid #e4572e;padding-bottom:.2vh}
.src{position:absolute;right:6vw;top:74%;font-family:'Ultra Mono',monospace;font-size:1.4vh;letter-spacing:.12em;color:#6a645a;text-transform:uppercase}
.foot{position:absolute;left:6vw;right:6vw;bottom:6vh;display:flex;justify-content:space-between;font-family:'Ultra Mono',monospace;font-size:1.4vh;letter-spacing:.2em;color:#6a645a;text-transform:uppercase}`,
  js: `
function outCubic(t){t=Math.max(0,Math.min(1,t));var p=t-1;return p*p*p+1;}
window.ultraRender=function(frame,fps){var t=frame/(fps||30);
 var p=outCubic((t-.1)/.55);
 var cap=document.querySelector('.cap'); cap.style.opacity=String(p); cap.style.transform='translateY('+(1-p)*2+'vh)';
 var img=document.querySelector('.image'); img.style.opacity=String(outCubic((t-.05)/.4));
 var fill=outCubic((t-.45)/.5); document.getElementById('b').style.borderBottomColor='#e4572e';
 document.getElementById('b').style.opacity=String(0.35+0.65*fill);
};`,
};

const DARK_METRIC = {
  html: `
<div class="kicker">ORCHESTRATION LATENCY / P95</div>
<div class="metric" id="metric">120<span>ms</span></div>
<div class="label" id="label">Frame routing, cold start<br/>on a linear launch timeline.</div>
<svg class="chart" viewBox="0 0 520 190" aria-hidden="true">
  <g class="grid">
    <line x1="0" y1="40" x2="520" y2="40"/><line x1="0" y1="90" x2="520" y2="90"/>
    <line x1="0" y1="140" x2="520" y2="140"/><line x1="0" y1="188" x2="520" y2="188"/>
  </g>
  <path class="area" id="area" d="M0 172 C60 168 80 150 120 148 S190 120 240 116 S320 98 360 84 S450 54 520 44 L520 190 L0 190 Z"/>
  <path class="line" id="line" pathLength="1" d="M0 172 C60 168 80 150 120 148 S190 120 240 116 S320 98 360 84 S450 54 520 44"/>
  <circle id="dot" cx="520" cy="44" r="5"/>
</svg>
<div class="ticks"><span>0s</span><span>1.5s</span><span>3.0s</span><span>4.5s</span></div>
<div class="foot"><span>DARK TECH LAUNCH</span><span>02 / 03</span></div>`,
  css: `
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#07090d;font-family:'Ultra Sans','Segoe UI',sans-serif;color:#f2f6ff}
.kicker{position:absolute;left:6vw;top:8vh;font-family:'Ultra Mono',monospace;font-size:1.6vh;letter-spacing:.22em;color:#8fa0b8;text-transform:uppercase}
.metric{position:absolute;left:6vw;top:20vh;font-family:'Ultra Display','Arial Black',sans-serif;font-weight:700;font-size:18vw;line-height:.86;letter-spacing:-.04em;color:#7cf5c7}
.metric span{font-size:.3em;letter-spacing:0;vertical-align:.9em;margin-left:.06em;color:#f2f6ff}
.label{position:absolute;left:6vw;top:58vh;font-size:2.3vh;line-height:1.45;color:#8fa0b8}
.chart{position:absolute;right:6vw;top:22vh;width:52vw;height:34vh;overflow:visible}
.grid line{stroke:rgba(143,160,184,.14);stroke-width:1}
.line{fill:none;stroke:#7cf5c7;stroke-width:3;stroke-linecap:round;stroke-dasharray:1;stroke-dashoffset:1;filter:drop-shadow(0 0 8px rgba(124,245,199,.45))}
.area{fill:rgba(124,245,199,.08);opacity:0}
#dot{fill:#7cf5c7;opacity:0;filter:drop-shadow(0 0 10px rgba(124,245,199,.9))}
.ticks{position:absolute;right:6vw;top:58vh;width:52vw;display:flex;justify-content:space-between;font-family:'Ultra Mono',monospace;font-size:1.25vh;letter-spacing:.14em;color:#8fa0b8}
.foot{position:absolute;left:6vw;right:6vw;bottom:7vh;display:flex;justify-content:space-between;font-family:'Ultra Mono',monospace;font-size:1.4vh;letter-spacing:.2em;color:#8fa0b8;text-transform:uppercase}`,
  js: `
function inOutCubic(t){t=Math.max(0,Math.min(1,t));return t<.5?4*t*t*t:1+4*Math.pow(t-1,3);}
window.ultraRender=function(frame,fps){var t=frame/(fps||30);
 var p=inOutCubic((t-.15)/.9);
 document.getElementById('line').style.strokeDashoffset=String(1-p);
 document.getElementById('area').style.opacity=String(p*.9);
 document.getElementById('dot').style.opacity=p>.96?1:0;
 var m=document.getElementById('metric'); m.style.opacity=String(p); m.style.transform='translateY('+(1-p)*2+'vh)';
 document.getElementById('label').style.opacity=String(inOutCubic((t-.5)/.5));
};`,
};

const PACKS: PackDef[] = [
  {
    slug: "punchy-shortform",
    aspect: "9:16",
    width: 640,
    height: 1138,
    palette: { bg: "#0b0d12", surface: "#151a23", textPrimary: "#f7f5ef", textMuted: "#9aa4b2", accent: "#ffd447", secondary: "#ff5a5f" },
    exemplars: [
      { out: "01_hook.png", frame: 48, motif: "hook-slam.html", name: "Hook slam" },
      { out: "02_captions.png", frame: 60, code: PUNCHY_CAPTIONS, name: "Active-word captions" },
      { out: "03_stat.png", frame: 54, motif: "stat-pill.html", name: "Stat pill" },
    ],
  },
  {
    slug: "kinetic-editorial",
    aspect: "16:9",
    width: 640,
    height: 360,
    palette: { bg: "#f6f0e6", surface: "#e8dfce", textPrimary: "#1c1b18", textMuted: "#6a645a", accent: "#e4572e", secondary: "#2f5d62" },
    exemplars: [
      { out: "01_chapter.png", frame: 54, motif: "chapter-card.html", name: "Chapter card" },
      { out: "02_captions.png", frame: 54, code: KINETIC_CAPTIONS, name: "Underline captions" },
      { out: "03_data.png", frame: 60, motif: "data-callout.html", name: "Data callout" },
    ],
  },
  {
    slug: "dark-tech-launch",
    aspect: "16:9",
    width: 640,
    height: 360,
    palette: { bg: "#07090d", surface: "#0e131c", textPrimary: "#f2f6ff", textMuted: "#8fa0b8", accent: "#7cf5c7", secondary: "#4f7cff" },
    exemplars: [
      { out: "01_hero.png", frame: 54, motif: "hero-reveal.html", name: "Hero reveal" },
      { out: "02_metric.png", frame: 60, code: DARK_METRIC, name: "Metric chart" },
      { out: "03_features.png", frame: 60, motif: "feature-badge.html", name: "Feature badges" },
    ],
  },
];

async function renderPack(pack: PackDef, workspace: string): Promise<void> {
  const style = JSON.parse(await fs.readFile(path.join(ROOT, "styles", pack.slug, "style.json"), "utf8")) as {
    colorAndTexture: { palette: Record<string, string>; grainOpacity: number };
  };
  const scenesDir = path.join(workspace, "scenes", pack.slug);
  await ensureDir(scenesDir);
  const exemplarDir = path.join(ROOT, "styles", pack.slug, "exemplars");
  await ensureDir(exemplarDir);

  for (let i = 0; i < pack.exemplars.length; i += 1) {
    const exemplar = pack.exemplars[i] as PackDef["exemplars"][number];
    let sceneInput: Record<string, unknown>;
    if (exemplar.motif) {
      const source = await fs.readFile(path.join(ROOT, "styles", pack.slug, "motifs", exemplar.motif), "utf8");
      const rel = path.join(pack.slug, exemplar.motif).split(path.sep).join("/");
      await fs.writeFile(path.join(scenesDir, exemplar.motif), source, "utf8");
      sceneInput = {
        id: `ex-${i + 1}`,
        name: exemplar.name,
        startSec: 0,
        endSec: DURATION,
        engine: "hyperframes",
        background: pack.palette.bg,
        customHtmlFile: rel,
      };
    } else {
      if (!exemplar.code) throw new Error(`exemplar ${exemplar.out} has no source`);
      sceneInput = {
        id: `ex-${i + 1}`,
        name: exemplar.name,
        startSec: 0,
        endSec: DURATION,
        engine: "hyperframes",
        background: pack.palette.bg,
        customCode: exemplar.code,
      };
    }

    const project = UltraProject.parse({
      meta: {
        title: `${pack.slug} exemplar`,
        sourceVideoPath: "reference.mp4",
        width: pack.width,
        height: pack.height,
        fps: FPS,
        durationSec: DURATION,
        aspectProfile: pack.aspect,
      },
      designTokens: {
        palette: {
          bg: style.colorAndTexture.palette.bg ?? pack.palette.bg,
          surface: style.colorAndTexture.palette.surface ?? pack.palette.surface,
          fg: style.colorAndTexture.palette.textPrimary ?? pack.palette.textPrimary,
          muted: style.colorAndTexture.palette.textMuted ?? pack.palette.textMuted,
          accent: style.colorAndTexture.palette.accent1 ?? pack.palette.accent,
          secondary: style.colorAndTexture.palette.accent2 ?? pack.palette.secondary,
        },
        fonts: { heading: "Ultra Display", body: "Ultra Sans", mono: "Ultra Mono" },
        grainOpacity: style.colorAndTexture.grainOpacity ?? 0.04,
        antiSlopRules: [],
      },
      colorGrade: {},
      audio: {},
      assets: [],
      scenes: [SceneSpec.parse(sceneInput)],
    });
    const scene = project.scenes[0] as (typeof project.scenes)[number];
    const html = await compileSceneHtml({
      project,
      scene,
      workspace,
      width: pack.width,
      height: pack.height,
      fps: FPS,
    });
    const out = path.join(exemplarDir, exemplar.out);
    const page = await newPage(pack.width, pack.height);
    try {
      await page.setContent(html);
      await settlePage(page);
      await page.evaluate(`window.__ULTRA_SEEK(${exemplar.frame}, ${FPS})`);
      await page.waitForTimeout(120);
      await page.screenshot({ path: out, type: "png" });
    } finally {
      await closePage(page);
    }
    console.log(`  ${pack.slug}/${exemplar.out} · ${(await fs.stat(out)).size / 1024} KiB`);
  }
}

async function main(): Promise<void> {
  const workspace = path.join(ROOT, "tmp", "style-exemplars", "workspace");
  await fs.rm(workspace, { recursive: true, force: true });
  await ensureDir(workspace);
  if (!(await pathExists(path.join(ROOT, "assets", "fonts", "UltraDisplay-Bold.ttf")))) {
    throw new Error("bundled fonts missing — run `python scripts/make-bundled-fonts.py` first");
  }
  for (const pack of PACKS) await renderPack(pack, workspace);
  await rebuildRegistry();
  await shutdownBrowser();
  console.log("style exemplars → styles/*/exemplars/*.png");
}

main().catch(async (err) => {
  console.error(`[make-style-exemplars] ${(err as Error).message}`);
  await shutdownBrowser().catch(() => undefined);
  process.exitCode = 1;
});
