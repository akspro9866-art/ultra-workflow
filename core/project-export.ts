import { promises as fs } from "node:fs";
import path from "node:path";
import type { SceneSpecT, UltraProjectT } from "./schema.js";
import { resolveAssetPath, resolveSourceClipPath } from "./assets.js";
import { loadProject } from "./project.js";
import { loadPlan, aspectFromDims, planDimensions } from "./preprod.js";
import { loadStylePack } from "./raw-probe.js";
import { listBundledFonts, installRoot, ultraTmpDir } from "./env.js";
import { createZip, extractZip } from "./zip.js";
import { ensureDir, pathExists, readJson, rmrf, writeJsonAtomic } from "./util.js";

/* ============================================================================
 * Editable project exporter: FCPXML 1.10 + OTIO + Ultra template + inspector
 * ========================================================================== */

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeName(value: string): string {
  return value.replace(/[^\w.-]+/g, "_");
}

async function copyInto(src: string, dest: string): Promise<void> {
  await ensureDir(path.dirname(dest));
  await fs.copyFile(src, dest);
}

interface MediaEntry {
  id: string;
  rel: string;
  name: string;
  hasVideo: boolean;
  hasAudio: boolean;
  durationSec: number;
}

export interface ExportResult {
  dir: string;
  zip: string;
  files: string[];
  fcpxml: string;
  otio: string;
  inspector: string;
  width: number;
  height: number;
  zipBytes: number;
}

export interface ExportOptions {
  workspace: string;
  buildDir: string;
  outDir: string;
  zipPath: string;
}

export async function exportProject(options: ExportOptions): Promise<ExportResult> {
  const { workspace, buildDir } = options;
  const project = await loadProject(workspace);
  const plan = await loadPlan(workspace).catch(() => null);
  const outDir = path.resolve(options.outDir);
  const zipPath = path.resolve(options.zipPath);
  await rmrf(outDir);
  await ensureDir(outDir);
  const files: string[] = [];

  const aspect = project.meta.aspectProfile ?? aspectFromDims(project.meta.width, project.meta.height);
  const use4k = project.meta.deliveryResolution === "4k" || plan?.meta.resolution === "4k";
  const dims = use4k ? planDimensions(aspect, "4k") : { width: project.meta.width, height: project.meta.height };
  const fps = project.meta.fps;

  const copyFile = async (src: string, rel: string): Promise<void> => {
    const dest = path.join(outDir, rel);
    await copyInto(src, dest);
    files.push(rel);
  };

  /* ---- assets ---- */
  const assetRel = new Map<string, string>();
  for (const asset of project.assets) {
    const source = resolveAssetPath(workspace, asset);
    if (!(await pathExists(source))) continue;
    const rel = `assets/${safeName(asset.id)}-${safeName(path.basename(source))}`;
    await copyFile(source, rel);
    assetRel.set(asset.id, rel);
  }

  const usedPaths = new Set<string>();
  const sourceClipRel = new Map<string, string>();
  for (const scene of project.scenes) {
    if (!scene.sourceClip) continue;
    const resolved = await resolveSourceClipPath(workspace, scene.sourceClip.path).catch(() => null);
    if (!resolved || usedPaths.has(resolved)) continue;
    usedPaths.add(resolved);
    const rel = `assets/${safeName(path.basename(resolved))}`;
    await copyFile(resolved, rel);
    sourceClipRel.set(resolved, rel);
    sourceClipRel.set(scene.sourceClip.path, rel);
  }

  /* ---- rendered scene media ---- */
  const sceneMediaRel = new Map<string, string>();
  const manifestPath = path.join(buildDir, "build-manifest.json");
  if (await pathExists(manifestPath)) {
    try {
      const manifest = (await readJson(manifestPath)) as { scenes?: { sceneId: string; file: string }[] };
      for (const scene of manifest.scenes ?? []) {
        if (!(await pathExists(scene.file))) continue;
        const rel = `media/${safeName(scene.sceneId)}${path.extname(scene.file) || ".mp4"}`;
        await copyFile(scene.file, rel);
        sceneMediaRel.set(scene.sceneId, rel);
      }
    } catch {
      // media is optional
    }
  }

  /* ---- scenes / captions / docs / fonts / motifs / grade ---- */
  for (const scene of project.scenes) {
    if (!scene.customHtmlFile) continue;
    const source = path.join(workspace, "scenes", scene.customHtmlFile);
    if (await pathExists(source)) await copyFile(source, `scenes/${scene.customHtmlFile.split(path.sep).join("/")}`);
  }
  for (const doc of ["PLAN.md", "DESIGN.md", "Motion.md"]) {
    if (await pathExists(path.join(workspace, doc))) await copyFile(path.join(workspace, doc), doc);
  }
  if (plan) {
    if (await pathExists(path.join(workspace, "plan.json"))) {
      const exportedPlan = {
        ...plan,
        meta: { ...plan.meta, resolution: use4k ? "4k" : plan.meta.resolution },
      };
      await writeJsonAtomic(path.join(outDir, "plan.json"), exportedPlan);
      files.push("plan.json");
    }
  }
  let captionsCopied = false;
  if (await pathExists(path.join(workspace, "captions.json"))) {
    await copyFile(path.join(workspace, "captions.json"), "captions.json");
    captionsCopied = true;
  }
  const fonts = await listBundledFonts();
  for (const font of fonts) {
    await copyFile(font.path, `fonts/${font.file}`);
  }
  let gradeRel: string | null = null;
  if (project.colorGrade.lutPath) {
    const lut = path.isAbsolute(project.colorGrade.lutPath)
      ? project.colorGrade.lutPath
      : path.resolve(workspace, project.colorGrade.lutPath);
    if (await pathExists(lut)) {
      await copyFile(lut, "grade.cube");
      gradeRel = "grade.cube";
    }
  }
  if (plan?.meta.styleSlug) {
    try {
      const { style, dir } = await loadStylePack(plan.meta.styleSlug);
      void style;
      const motifs = path.join(dir, "motifs");
      if (await pathExists(motifs)) {
        for (const entry of await fs.readdir(motifs)) {
          if (entry.endsWith(".html")) await copyFile(path.join(motifs, entry), `motifs/${entry}`);
        }
      }
    } catch {
      // style pack not installed in this workspace
    }
  }

  const exportedProject: UltraProjectT = JSON.parse(JSON.stringify(project)) as UltraProjectT;
  exportedProject.assets = exportedProject.assets.map((asset) => ({
    ...asset,
    targetPath: assetRel.get(asset.id) ?? asset.targetPath,
  }));
  exportedProject.scenes = await Promise.all(
    exportedProject.scenes.map(async (scene) => {
      const next: SceneSpecT = { ...scene };
      if (next.sourceClip) {
        let rel = sourceClipRel.get(next.sourceClip.path) ?? null;
        if (!rel) {
          const resolved = await resolveSourceClipPath(workspace, next.sourceClip.path).catch(() => null);
          rel = resolved ? sourceClipRel.get(resolved) ?? null : null;
        }
        if (rel) next.sourceClip = { ...next.sourceClip, path: rel };
      }
      if (next.captionsFile && captionsCopied) next.captionsFile = "captions.json";
      return next;
    }),
  );
  if (gradeRel) exportedProject.colorGrade = { ...exportedProject.colorGrade, lutPath: gradeRel };
  await writeJsonAtomic(path.join(outDir, "project.ultra.json"), exportedProject);
  files.push("project.ultra.json");

  /* ---- FCPXML ---- */
  const frame = (sec: number) => Math.round(sec * fps);
  const mediaEntries: MediaEntry[] = [];
  let mediaIndex = 1;
  const refFor = (rel: string, name: string, hasVideo: boolean, durationSec: number): string => {
    const existing = mediaEntries.find((entry) => entry.rel === rel);
    if (existing) return existing.id;
    const id = `a${mediaIndex++}`;
    mediaEntries.push({ id, rel, name, hasVideo, hasAudio: false, durationSec });
    return id;
  };
  const timelineLines: string[] = [];
  let mainIndex = 0;
  for (const scene of [...project.scenes].filter((s) => !s.overlayOfSceneId).sort((a, b) => a.startSec - b.startSec)) {
    const duration = frame(scene.endSec - scene.startSec);
    let ref: string | null = null;
    let startFrames = 0;
    if (scene.sourceClip) {
      const resolved = await resolveSourceClipPath(workspace, scene.sourceClip.path).catch(() => null);
      const rel = resolved ? sourceClipRel.get(resolved) : undefined;
      if (rel) {
        ref = refFor(rel, path.basename(rel), true, scene.sourceClip.outSec - scene.sourceClip.inSec + 0.5);
        startFrames = frame(scene.sourceClip.inSec);
      }
    }
    if (!ref) {
      const rel = sceneMediaRel.get(scene.id);
      if (rel) ref = refFor(rel, scene.name, true, scene.endSec - scene.startSec + 0.5);
    }
    if (!ref) continue;
    mainIndex += 1;
    timelineLines.push(
      `        <asset-clip ref="${ref}" name="${xmlEscape(scene.name)}" offset="${frame(scene.startSec)}/${fps}s" start="${startFrames}/${fps}s" duration="${duration}/${fps}s" lane="0" tcFormat="NDF">`,
    );
    for (let i = 0; i < 1; i += 1) {
      timelineLines.push(`          <marker start="${frame(scene.startSec)}/${fps}s" duration="1/${fps}s" value="${xmlEscape(`Shot ${mainIndex}`)}"/>`);
    }
    timelineLines.push("        </asset-clip>");
  }
  for (const scene of [...project.scenes].filter((s) => s.overlayOfSceneId).sort((a, b) => a.startSec - b.startSec)) {
    const rel = sceneMediaRel.get(scene.id);
    if (!rel) continue;
    const ref = refFor(rel, scene.name, true, scene.endSec - scene.startSec + 0.5);
    timelineLines.push(
      `        <asset-clip ref="${ref}" name="${xmlEscape(scene.name)}" offset="${frame(scene.startSec)}/${fps}s" start="0/${fps}s" duration="${frame(scene.endSec - scene.startSec)}/${fps}s" lane="1" tcFormat="NDF"/>`,
    );
  }
  const audioLines: string[] = [];
  for (const asset of project.assets) {
    if (!["sfx", "music", "voice"].includes(asset.type)) continue;
    const rel = assetRel.get(asset.id);
    if (!rel) continue;
    const ref = refFor(rel, asset.description, false, asset.durationSec ?? project.meta.durationSec);
    const cue = project.audio.sfxCues.find((entry) => entry.assetId === asset.id);
    const atSec = cue?.atSec ?? 0;
    const gain = cue?.gainDb ?? 0;
    audioLines.push(
      `        <asset-clip ref="${ref}" name="${xmlEscape(asset.id)}" offset="${frame(atSec)}/${fps}s" start="0/${fps}s" duration="${frame(asset.durationSec ?? project.meta.durationSec)}/${fps}s" lane="-1" tcFormat="NDF">${gain !== 0 ? `<adjust-volume amount="${gain}dB"/>` : ""}</asset-clip>`,
    );
  }
  const resources = [
    `    <format id="r1" name="FFVideoFormat${dims.width}x${dims.height}p${Math.round(fps)}" frameDuration="1/${fps}s" width="${dims.width}" height="${dims.height}" colorSpace="1-1-1 (Rec. 709)"/>`,
    ...mediaEntries.map(
      (entry) =>
        `    <asset id="${entry.id}" name="${xmlEscape(entry.name)}" start="0s" duration="${entry.durationSec}s" hasVideo="${entry.hasVideo ? 1 : 0}" hasAudio="${entry.hasAudio ? 1 : 0}" format="r1"><media-rep kind="original-media" src="${xmlEscape(entry.rel)}"/></asset>`,
    ),
  ].join("\n");
  const fcpxml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
${resources}
  </resources>
  <library>
    <event name="Ultra Workflow">
      <project name="${xmlEscape(project.meta.title)}">
        <sequence format="r1" duration="${frame(project.meta.durationSec)}/${fps}s" tcStart="0/${fps}s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
${timelineLines.join("\n")}
${audioLines.join("\n")}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
  const fcpxmlPath = path.join(outDir, "timeline.fcpxml");
  await fs.writeFile(fcpxmlPath, fcpxml, "utf8");
  files.push("timeline.fcpxml");

  /* ---- OTIO ---- */
  const rate = fps;
  const time = (value: number) => ({ OTIO_SCHEMA: "RationalTime.1", rate, value });
  const range = (start: number, duration: number) => ({
    OTIO_SCHEMA: "TimeRange.1",
    start_time: time(start),
    duration: time(duration),
  });
  const videoClips: Record<string, unknown>[] = [];
  const overlayClipsOtio: Record<string, unknown>[] = [];
  const audioClips: Record<string, unknown>[] = [];
  for (const scene of [...project.scenes].sort((a, b) => a.startSec - b.startSec)) {
    let rel: string | null = null;
    let mediaStart = 0;
    if (scene.sourceClip) {
      const resolved = await resolveSourceClipPath(workspace, scene.sourceClip.path).catch(() => null);
      rel = resolved ? sourceClipRel.get(resolved) ?? null : null;
      mediaStart = scene.sourceClip.inSec;
    }
    rel = rel ?? sceneMediaRel.get(scene.id) ?? null;
    if (!rel) continue;
    const clip = {
      OTIO_SCHEMA: "Clip.1",
      name: scene.name,
      source_range: range(mediaStart, scene.endSec - scene.startSec),
      media_reference: {
        OTIO_SCHEMA: "ExternalReference.1",
        target_url: rel,
        available_range: range(0, scene.endSec - scene.startSec + 0.5),
      },
      markers: [{ OTIO_SCHEMA: "Marker.1", name: `Shot ${scene.id}`, marked_range: range(scene.startSec, 0) }],
      metadata: {
        ultra: {
          sceneId: scene.id,
          startSec: scene.startSec,
          engine: scene.engine,
          transitionIn: scene.transitionIn,
          keyframes: scene.keyframes,
          camera: scene.camera,
          effects: scene.effects,
          sourceClip: scene.sourceClip ?? null,
        },
      },
    };
    if (scene.overlayOfSceneId) overlayClipsOtio.push(clip);
    else videoClips.push(clip);
  }
  for (const asset of project.assets) {
    if (!["sfx", "music", "voice"].includes(asset.type)) continue;
    const rel = assetRel.get(asset.id);
    if (!rel) continue;
    const cue = project.audio.sfxCues.find((entry) => entry.assetId === asset.id);
    audioClips.push({
      OTIO_SCHEMA: "Clip.1",
      name: asset.id,
      source_range: range(0, asset.durationSec ?? project.meta.durationSec),
      media_reference: { OTIO_SCHEMA: "ExternalReference.1", target_url: rel },
      metadata: { ultra: { assetId: asset.id, type: asset.type, atSec: cue?.atSec ?? 0, gainDb: cue?.gainDb ?? 0 } },
    });
  }
  const withGaps = (entries: { atSec: number; clip: Record<string, any> }[]): Record<string, unknown>[] => {
    const ordered = [...entries].sort((a, b) => a.atSec - b.atSec);
    const out: Record<string, unknown>[] = [];
    let cursor = 0;
    for (const entry of ordered) {
      const duration = Number(entry.clip.source_range?.duration?.value ?? 0);
      if (entry.atSec > cursor + 0.001) {
        out.push({
          OTIO_SCHEMA: "Gap.1",
          name: "gap",
          source_range: range(0, entry.atSec - cursor),
          metadata: {},
        });
        cursor = entry.atSec;
      }
      out.push(entry.clip);
      cursor += duration;
    }
    return out;
  };
  const overlayTrack = withGaps(
    overlayClipsOtio.map((clip) => {
      const meta = clip["metadata"] as Record<string, any> | undefined;
      return { atSec: Number(meta?.["ultra"]?.sceneStartSec ?? meta?.["ultra"]?.startSec ?? 0), clip };
    }),
  );
  const audioTrack = withGaps(
    audioClips.map((clip) => ({ atSec: Number((clip.metadata as Record<string, any>)?.ultra?.atSec ?? 0), clip })),
  );
  const otio = {
    OTIO_SCHEMA: "Timeline.1",
    name: project.meta.title,
    global_start_time: time(0),
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      children: [
        { OTIO_SCHEMA: "Track.1", name: "Video", kind: "Video", children: videoClips },
        { OTIO_SCHEMA: "Track.1", name: "Overlays", kind: "Video", children: overlayTrack },
        { OTIO_SCHEMA: "Track.1", name: "Audio", kind: "Audio", children: audioTrack },
      ],
    },
    metadata: {
      ultra: {
        version: 6,
        fps: project.meta.fps,
        width: dims.width,
        height: dims.height,
        durationSec: project.meta.durationSec,
        designTokens: project.designTokens,
        colorGrade: project.colorGrade,
        audio: project.audio,
        plan: plan?.meta ?? null,
      },
    },
  };
  const otioPath = path.join(outDir, "timeline.otio");
  await writeJsonAtomic(otioPath, otio);
  files.push("timeline.otio");

  /* ---- offline inspector ---- */
  const inspector = `<!doctype html>
<html><head><meta charset="utf-8"/><title>${xmlEscape(project.meta.title)} — Ultra Inspector</title>
<style>
  :root{color-scheme:dark} body{margin:0;background:#0b0d12;color:#f7f5ef;font:14px/1.5 Inter,system-ui,sans-serif}
  header{padding:24px 32px;border-bottom:1px solid #232a36} h1{margin:0;font-size:24px;letter-spacing:-.02em}
  .sub{color:#9aa4b2;font:12px/1.6 ui-monospace,monospace;margin-top:6px}
  main{display:grid;grid-template-columns:2fr 1fr;gap:24px;padding:24px 32px}
  section{background:#11151d;border:1px solid #232a36;border-radius:10px;padding:16px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.14em;color:#9aa4b2;margin:0 0 12px}
  .row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #1b2230}
  .row:last-child{border:0} code{font:12px ui-monospace,monospace;color:#ffd447}
  .sw{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:middle}
  ul{margin:0;padding-left:18px;color:#c7cfdc} li{margin:4px 0}
</style></head><body>
<header><h1>${xmlEscape(project.meta.title)}</h1>
<div class="sub">${xmlEscape(project.meta.aspectProfile ?? aspect)} · ${dims.width}×${dims.height} · ${project.meta.fps} fps · ${project.meta.durationSec}s — offline Ultra project inspector</div></header>
<main>
<section><h2>Scenes / layers / keyframes</h2><div id="scenes"></div></section>
<section><h2>Assets & fonts</h2><div id="assets"></div><h2 style="margin-top:18px">Palette</h2><div id="palette"></div></section>
</main>
<script id="project-data" type="application/json">${JSON.stringify(exportedProject).replace(/</g, "\\u003c")}</script>
<script>
  var project = JSON.parse(document.getElementById("project-data").textContent);
  function esc(v){return String(v).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
  document.getElementById("scenes").innerHTML = project.scenes.map(function(scene){
    return '<div class="row"><div><strong>'+esc(scene.name)+'</strong><br><span class="sub">'+scene.startSec+'–'+scene.endSec+'s · '+esc(scene.engine)+' · '+scene.layers.length+' layers · '+(scene.keyframes||[]).length+' tracks</span></div><code>'+esc(scene.id)+'</code></div>';
  }).join("");
  document.getElementById("assets").innerHTML = project.assets.map(function(asset){
    return '<div class="row"><div>'+esc(asset.description)+'</div><code>'+esc(asset.targetPath)+'</code></div>';
  }).join("") || '<div class="sub">no external assets</div>';
  document.getElementById("palette").innerHTML = Object.keys(project.designTokens.palette).map(function(key){
    var hex = project.designTokens.palette[key];
    return '<div class="row"><div><span class="sw" style="background:'+hex+'"></span>'+esc(key)+'</div><code>'+hex+'</code></div>';
  }).join("");
</script>
</body></html>
`;
  const inspectorPath = path.join(outDir, "index.html");
  await fs.writeFile(inspectorPath, inspector, "utf8");
  files.push("index.html");

  /* ---- zip + integrity ---- */
  const zipInputs: { name: string; source: string }[] = [];
  const collect = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await collect(full);
      else zipInputs.push({ name: path.relative(outDir, full).split(path.sep).join("/"), source: full });
    }
  };
  await collect(outDir);
  await ensureDir(path.dirname(zipPath));
  const zip = await createZip(zipInputs, zipPath);
  const verifyDir = await fs.mkdtemp(path.join(ultraTmpDir(), "ultra-export-check-"));
  try {
    const { entries } = await extractZip(zipPath, verifyDir);
    if (entries.length === 0 || entries.some((entry) => !entry.crcOk)) {
      throw new Error("editable project zip failed CRC verification");
    }
  } finally {
    await rmrf(verifyDir);
  }

  return {
    dir: outDir,
    zip: zipPath,
    files,
    fcpxml: fcpxmlPath,
    otio: otioPath,
    inspector: inspectorPath,
    width: dims.width,
    height: dims.height,
    zipBytes: zip.bytes,
  };
}

export function exportRoot(): string {
  return installRoot();
}
