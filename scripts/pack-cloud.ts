import { promises as fs } from "node:fs";
import path from "node:path";
import { build as esbuild } from "esbuild";
import { installRoot } from "../core/env.js";
import { ensureDir, pathExists, rmrf, writeJsonAtomic } from "../core/util.js";
import { createZip } from "../core/zip.js";
import { buildRagIndex } from "../core/rag.js";

const CLOUD_PACKAGE = {
  name: "ultra-workflow",
  version: "6.0.0",
  private: true,
  type: "module",
  description: "Zero-API, zero-install deterministic video recreation + style-pack workflow for agent chat sandboxes.",
};

const LAUNCHER_SH = `#!/bin/sh
exec node "$(dirname "$0")/ultra.mjs" "$@"
`;

const LAUNCHER_CMD = `@echo off\r
node "%~dp0ultra.mjs" %*\r
`;

const TEXT_EXTENSIONS = new Set([".mjs", ".js", ".ts", ".py", ".sh", ".md", ".json", ".txt", ".html", ".css", ".yml", ".yaml", ".cmd"]);

/** Cloud scripts must be LF-only: Windows CRLF has broken Linux shebangs before. */
async function normalizeLf(stage: string): Promise<number> {
  let changed = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      const isLauncher = entry.name === "ultra" || entry.name === "run.sh";
      if (!TEXT_EXTENSIONS.has(ext) && !isLauncher) continue;
      const raw = await fs.readFile(full);
      if (raw.includes(0x0d)) {
        await fs.writeFile(full, raw.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8");
        changed += 1;
      }
    }
  };
  await walk(stage);
  return changed;
}

async function bundleCli(root: string, dist: string): Promise<number> {
  await esbuild({
    entryPoints: [path.join(root, "bin", "ultra.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node18"],
    outfile: path.join(dist, "ultra.mjs"),
    minify: true,
    legalComments: "none",
    sourcemap: false,
    logLevel: "warning",
    absWorkingDir: root,
    external: ["playwright-core", "bufferutil", "utf-8-validate"],
    define: { "process.env.ULTRA_BUNDLED": '"1"' },
    banner: {
      js: "import { createRequire as __ultraCreateRequire } from 'node:module';\nconst require = __ultraCreateRequire(import.meta.url);",
    },
  });
  const stat = await fs.stat(path.join(dist, "ultra.mjs"));
  return stat.size;
}

async function copyDir(src: string, dest: string): Promise<number> {
  let count = 0;
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "pack-cloud") continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += await copyDir(from, to);
    } else {
      await ensureDir(path.dirname(to));
      await fs.copyFile(from, to);
      count += 1;
    }
  }
  return count;
}

async function main(): Promise<void> {
  const root = installRoot();
  const dist = path.join(root, "dist");
  if (!(await pathExists(path.join(dist, "bin", "ultra.js")))) {
    throw new Error("dist/bin/ultra.js missing — run `npm run build` first (npm run pack:cloud does this).");
  }

  const bundleBytes = await bundleCli(root, dist);
  const ragIndex = await buildRagIndex(root);
  await writeJsonAtomic(path.join(dist, "rag-index.json"), ragIndex);
  // Keep clone-and-run launchers next to the bundle at the dist root (tracked in git).
  await fs.writeFile(path.join(dist, "ultra"), LAUNCHER_SH, "utf8");
  await fs.chmod(path.join(dist, "ultra"), 0o755);
  await fs.writeFile(path.join(dist, "run.sh"), LAUNCHER_SH, "utf8");
  await fs.chmod(path.join(dist, "run.sh"), 0o755);
  await fs.writeFile(path.join(dist, "ultra.cmd"), LAUNCHER_CMD, "utf8");

  const stage = path.join(dist, "pack-cloud");
  await rmrf(stage);
  await ensureDir(stage);

  await fs.copyFile(path.join(dist, "ultra.mjs"), path.join(stage, "ultra.mjs"));
  await writeJsonAtomic(path.join(stage, "package.json"), CLOUD_PACKAGE);

  let vendorCount = await copyDir(path.join(root, "assets", "vendor"), path.join(stage, "assets", "vendor"));
  let fontCount = 0;
  if (await pathExists(path.join(root, "assets", "fonts"))) {
    fontCount = await copyDir(path.join(root, "assets", "fonts"), path.join(stage, "assets", "fonts"));
  }

  await ensureDir(path.join(stage, "engines", "blender"));
  await fs.copyFile(
    path.join(root, "engines", "blender", "render_scene.py"),
    path.join(stage, "engines", "blender", "render_scene.py"),
  );
  await ensureDir(path.join(stage, "engines", "py-canvas"));
  await fs.copyFile(
    path.join(root, "engines", "py-canvas", "render_scene.py"),
    path.join(stage, "engines", "py-canvas", "render_scene.py"),
  );

  for (const doc of ["SKILL.md", "AGENTS.md", "CHAT_START_PROMPT.txt", "SPEC.md", "README.md"]) {
    await fs.copyFile(path.join(root, doc), path.join(stage, doc));
  }
  const ultraDocs = await copyDir(path.join(root, ".ultra"), path.join(stage, ".ultra"));
  await ensureDir(path.join(stage, "dist"));
  await fs.copyFile(path.join(dist, "rag-index.json"), path.join(stage, "dist", "rag-index.json"));

  // v3: installed Style Packs + ready-to-paste prompts travel with the bundle.
  let styleCount = 0;
  if (await pathExists(path.join(root, "styles"))) {
    styleCount = await copyDir(path.join(root, "styles"), path.join(stage, "styles"));
  } else {
    await ensureDir(path.join(stage, "styles"));
    await writeJsonAtomic(path.join(stage, "styles", "registry.json"), { updatedAt: new Date().toISOString(), styles: [] });
  }
  let promptCount = 0;
  if (await pathExists(path.join(root, "prompts"))) {
    promptCount = await copyDir(path.join(root, "prompts"), path.join(stage, "prompts"));
  }

  await fs.copyFile(path.join(dist, "ultra"), path.join(stage, "ultra"));
  await fs.chmod(path.join(stage, "ultra"), 0o755);
  await fs.copyFile(path.join(dist, "run.sh"), path.join(stage, "run.sh"));
  await fs.chmod(path.join(stage, "run.sh"), 0o755);
  await fs.copyFile(path.join(dist, "ultra.cmd"), path.join(stage, "ultra.cmd"));

  const normalized = await normalizeLf(stage);

  const zipPath = path.join(dist, "ultra-workflow-cloud.zip");
  const files: { name: string; source: string; mode?: number }[] = [];
  const collect = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await collect(full);
      else {
        const rel = path.relative(stage, full).split(path.sep).join("/");
        files.push({ name: rel, source: full, ...(rel === "ultra" || rel === "run.sh" ? { mode: 0o755 } : {}) });
      }
    }
  };
  await collect(stage);
  const zip = await createZip(files, zipPath);

  const zipMiB = zip.bytes / (1024 * 1024);
  if (zipMiB > 2.5) {
    throw new Error(`cloud zip exceeds the 2.5 MiB limit (${zipMiB.toFixed(2)} MiB) — compress exemplars/motifs`);
  }
  if (zipMiB > 2.0) {
    console.warn(`[pack:cloud] warning: zip is ${zipMiB.toFixed(2)} MiB (v6 target is <= 2.5 MiB)`);
  }
  await rmrf(stage);

  console.log(`pack:cloud → ${zipPath}`);
  console.log(
    `  ultra.mjs ${(bundleBytes / 1024).toFixed(1)} KiB · vendor ${vendorCount} · fonts ${fontCount} · styles ${styleCount} · prompts ${promptCount} · ultra docs ${ultraDocs} · rag ${ragIndex.docs.length} docs · LF-normalized ${normalized} · zip ${(zip.bytes / 1024).toFixed(1)} KiB (${zipMiB.toFixed(2)} MiB)`,
  );
  console.log(
    `  contents: ultra.mjs, ultra, run.sh, ultra.cmd, package.json, assets/vendor/, assets/fonts/ (Ultra Display/Sans/Mono), styles/, prompts/, .ultra/ (rules+skills+agents), AGENTS.md, dist/rag-index.json, engines/blender+py-canvas scripts, docs`,
  );
}

main().catch((err) => {
  console.error(`[pack:cloud] ${(err as Error).message}`);
  process.exitCode = 1;
});
