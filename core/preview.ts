import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SceneSpecT, UltraProjectT } from "./schema.js";
import { compileSceneHtml } from "../engines/hyperframes/compiler.js";
import { closePage, newPage, settlePage, waitForVideos } from "./browser.js";
import { extractFrameAt } from "./probe.js";
import { detectRenderTier } from "./env.js";
import { ffmpegOk } from "./ffmpeg.js";
import { renderDraftContactSheet } from "./contact-sheet.js";
import { pairHtml } from "../verifier/visual-diff.js";
import { ensureDir, formatTimestamp, rmrf, round } from "./util.js";

/**
 * [20] ultra preview — render ONE frame or a frame range without a full build.
 * full-cdp only: browserless-py / ffmpeg-only raise a clear tier error instead
 * of silently doing a full build.
 */

export interface PreviewContext {
  project: UltraProjectT;
  workspace: string;
  buildDir: string;
  width: number;
  height: number;
  /** Optional explicit reference override (defaults to meta.sourceVideoPath). */
  referenceFile?: string;
}

function mainScenes(project: UltraProjectT): SceneSpecT[] {
  return project.scenes.filter((s) => !s.overlayOfSceneId).sort((a, b) => a.startSec - b.startSec);
}

function sceneAt(project: UltraProjectT, t: number): SceneSpecT {
  const scenes = mainScenes(project);
  for (const scene of scenes) {
    if (t >= scene.startSec - 0.0005 && t < scene.endSec - 0.0005) return scene;
  }
  return scenes[scenes.length - 1] as SceneSpecT;
}

async function assertPreviewTier(ctx: PreviewContext, scene: SceneSpecT): Promise<void> {
  const tier = (await detectRenderTier()).tier;
  if (tier !== "full-cdp") {
    throw new Error(
      `ultra preview requires the full-cdp render tier (found ${tier}). ` +
        "browserless-py / ffmpeg-only do not support single-frame previews — use `ultra build` instead.",
    );
  }
  if (scene.engine !== "hyperframes") {
    throw new Error(
      `ultra preview supports hyperframes scenes on full-cdp (scene "${scene.id}" uses "${scene.engine}"). ` +
        "Run a real `ultra build` for that engine.",
    );
  }
}

async function openScenePage(ctx: PreviewContext, scene: SceneSpecT) {
  const workDir = path.join(ctx.buildDir, "preview", "tmp");
  await ensureDir(workDir);
  const htmlPath = path.join(workDir, `preview_${scene.id.replace(/[^\w.-]/g, "_")}.html`);
  await fs.writeFile(
    htmlPath,
    await compileSceneHtml({
      project: ctx.project,
      scene,
      workspace: ctx.workspace,
      width: ctx.width,
      height: ctx.height,
      fps: ctx.project.meta.fps,
    }),
    "utf8",
  );
  const page = await newPage(ctx.width, ctx.height);
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
  await settlePage(page);
  await waitForVideos(page);
  return page;
}

async function composeDiff(refFrame: string, draftFrame: string, outFile: string): Promise<void> {
  await ffmpegOk(
    [
      "-i",
      refFrame,
      "-i",
      draftFrame,
      "-filter_complex",
      "[0:v]scale=960:-2:flags=lanczos[a];[1:v]scale=960:-2:flags=lanczos[b];[a][b]blend=all_mode=difference,eq=contrast=2.2:brightness=0.06",
      "-frames:v",
      "1",
      "-y",
      outFile,
    ],
    { timeoutMs: 60_000 },
  );
}

export async function previewFrame(
  ctx: PreviewContext,
  frame: number,
): Promise<{ frameFile: string; diffFile: string | null; sceneId: string; timestampSec: number }> {
  const fps = ctx.project.meta.fps;
  const t = frame / fps;
  const scene = sceneAt(ctx.project, t);
  await assertPreviewTier(ctx, scene);
  const outDir = path.join(ctx.buildDir, "preview");
  await ensureDir(outDir);
  const raw = path.join(outDir, "tmp", `frame_${frame}.png`);
  await ensureDir(path.dirname(raw));

  const localFrame = Math.max(0, frame - Math.round(scene.startSec * fps));
  const page = await openScenePage(ctx, scene);
  try {
    await page.evaluate(`window.__ULTRA_SEEK(${localFrame}, ${fps})`);
    await page.screenshot({ path: raw, type: "png" });
  } finally {
    await closePage(page);
  }

  const frameFile = path.join(outDir, `frame-${frame}.png`);
  const diffFile = path.join(outDir, `frame-${frame}-diff.png`);
  const ref = ctx.referenceFile ?? ctx.project.meta.sourceVideoPath;
  const reference = path.isAbsolute(ref) ? ref : await (await import("./project.js")).resolveSourceVideoPath(ctx.workspace, ref);
  if (!reference) {
    await fs.copyFile(raw, frameFile);
    return { frameFile, diffFile: null, sceneId: scene.id, timestampSec: round(t, 3) };
  }
  const refFrame = path.join(outDir, "tmp", `ref_${frame}.png`);
  await extractFrameAt(reference, t, refFrame, 960);
  const [refBuf, draftBuf] = await Promise.all([fs.readFile(refFrame), fs.readFile(raw)]);
  const html = pairHtml(
    `data:image/png;base64,${refBuf.toString("base64")}`,
    `data:image/png;base64,${draftBuf.toString("base64")}`,
    formatTimestamp(t),
    `${scene.id} · frame ${frame}`,
  );
  const { renderHtmlToPng } = await import("./browser.js");
  await renderHtmlToPng(html, 1720, 660, frameFile);
  await composeDiff(refFrame, raw, diffFile);
  await fs.rm(refFrame, { force: true });
  await fs.rm(raw, { force: true });
  return { frameFile, diffFile, sceneId: scene.id, timestampSec: round(t, 3) };
}

export async function previewRange(
  ctx: PreviewContext,
  fromFrame: number,
  toFrame: number,
): Promise<{ rangeFile: string; frames: number; scenes: string[] }> {
  const fps = ctx.project.meta.fps;
  const start = Math.min(fromFrame, toFrame);
  const end = Math.max(fromFrame, toFrame);
  const startSec = start / fps;
  const endSec = (end + 1) / fps;
  const scenes = mainScenes(ctx.project).filter((s) => s.endSec > startSec + 0.001 && s.startSec < endSec - 0.001);
  if (scenes.length === 0) throw new Error(`preview --from/--to: no scenes overlap frames ${start}..${end}`);
  for (const scene of scenes) await assertPreviewTier(ctx, scene);

  const outDir = path.join(ctx.buildDir, "preview");
  await ensureDir(outDir);
  const tmp = path.join(outDir, "tmp-range");
  await rmrf(tmp);
  await ensureDir(tmp);
  const totalFrames = end - start + 1;
  let written = 0;
  const parts: string[] = [];
  for (const scene of scenes) {
    const firstLocal = Math.max(0, start - Math.round(scene.startSec * fps));
    const lastLocal = Math.min(Math.round((scene.endSec - scene.startSec) * fps) - 1, end - Math.round(scene.startSec * fps));
    if (lastLocal < firstLocal) continue;
    const seqDir = path.join(tmp, `seq_${scene.id.replace(/[^\w.-]/g, "_")}`);
    await ensureDir(seqDir);
    const page = await openScenePage(ctx, scene);
    try {
      for (let local = firstLocal; local <= lastLocal; local += 1) {
        await page.evaluate(`window.__ULTRA_SEEK(${local}, ${fps})`);
        await page.screenshot({
          path: path.join(seqDir, `f_${String(local - firstLocal + 1).padStart(5, "0")}.png`),
          type: "png",
        });
        written += 1;
      }
    } finally {
      await closePage(page);
    }
    const partFile = path.join(tmp, `part_${parts.length}.mp4`);
    await ffmpegOk(
      [
        "-framerate",
        String(fps),
        "-i",
        path.join(seqDir, "f_%05d.png"),
        "-r",
        String(fps),
        "-fps_mode",
        "cfr",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "16",
        "-pix_fmt",
        "yuv420p",
        "-an",
        partFile,
      ],
      { timeoutMs: 20 * 60_000 },
    );
    parts.push(partFile);
  }
  const listFile = path.join(tmp, "list.txt");
  await fs.writeFile(listFile, parts.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
  const rangeFile = path.join(outDir, "range.mp4");
  await ffmpegOk(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", rangeFile], {
    timeoutMs: 10 * 60_000,
  });
  await rmrf(tmp);
  // [22] preview ranges also refresh the always-on contact sheet.
  try {
    await renderDraftContactSheet({
      video: rangeFile,
      outFile: path.join(ctx.buildDir, "contact-sheet.png"),
      title: `ULTRA · preview ${start}–${end}`,
      durationSec: totalFrames / fps,
    });
  } catch (err) {
    console.warn(`preview: contact sheet generation failed (${(err as Error).message.split("\n")[0]})`);
  }
  return { rangeFile, frames: written, scenes: scenes.map((s) => s.id) };
}
