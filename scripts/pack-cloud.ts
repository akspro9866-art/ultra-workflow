import archiver from "archiver";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { build as esbuild } from "esbuild";
import { installRoot } from "../core/env.js";
import { ensureDir, pathExists, rmrf, writeJsonAtomic } from "../core/util.js";

const CLOUD_PACKAGE = {
  name: "ultra-workflow",
  version: "1.1.0",
  private: true,
  type: "module",
  description: "Zero-API, zero-install deterministic video compiler for agent chat sandboxes.",
};

const LAUNCHER_SH = `#!/bin/sh
exec node "$(dirname "$0")/ultra.mjs" "$@"
`;

const LAUNCHER_CMD = `@echo off\r
node "%~dp0ultra.mjs" %*\r
`;

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
  // Keep clone-and-run launchers next to the bundle at the dist root (tracked in git).
  await fs.writeFile(path.join(dist, "ultra"), LAUNCHER_SH, "utf8");
  await fs.chmod(path.join(dist, "ultra"), 0o755);
  await fs.writeFile(path.join(dist, "ultra.cmd"), LAUNCHER_CMD, "utf8");

  const stage = path.join(dist, "pack-cloud");
  await rmrf(stage);
  await ensureDir(stage);

  await fs.copyFile(path.join(dist, "ultra.mjs"), path.join(stage, "ultra.mjs"));
  await writeJsonAtomic(path.join(stage, "package.json"), CLOUD_PACKAGE);

  const vendorCount = await copyDir(path.join(root, "assets", "vendor"), path.join(stage, "assets", "vendor"));

  await ensureDir(path.join(stage, "engines", "blender"));
  await fs.copyFile(
    path.join(root, "engines", "blender", "render_scene.py"),
    path.join(stage, "engines", "blender", "render_scene.py"),
  );

  for (const doc of ["SKILL.md", "CHAT_START_PROMPT.txt", "SPEC.md", "README.md"]) {
    await fs.copyFile(path.join(root, doc), path.join(stage, doc));
  }

  await fs.copyFile(path.join(dist, "ultra"), path.join(stage, "ultra"));
  await fs.chmod(path.join(stage, "ultra"), 0o755);
  await fs.copyFile(path.join(dist, "ultra.cmd"), path.join(stage, "ultra.cmd"));

  const zipPath = path.join(dist, "ultra-workflow-cloud.zip");
  await rmrf(zipPath);
  const stageFiles: string[] = [];
  const collect = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await collect(full);
      else stageFiles.push(path.relative(stage, full).split(path.sep).join("/"));
    }
  };
  await collect(stage);
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.on("warning", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      reject(err);
    });
    archive.pipe(output);
    for (const rel of stageFiles.sort()) {
      archive.file(path.join(stage, ...rel.split("/")), {
        name: rel,
        ...(rel === "ultra" ? { mode: 0o755 } : {}),
      });
    }
    void archive.finalize();
  });

  const stat = await fs.stat(zipPath);
  const zipMiB = stat.size / (1024 * 1024);
  if (zipMiB > 3) {
    throw new Error(`cloud zip exceeds the 3 MB hard limit (${zipMiB.toFixed(2)} MiB)`);
  }
  if (zipMiB > 2.5) {
    console.warn(`[pack:cloud] warning: zip is ${zipMiB.toFixed(2)} MiB (target < 2.5 MiB)`);
  }
  await rmrf(stage);

  console.log(`pack:cloud → ${zipPath}`);
  console.log(
    `  ultra.mjs ${(bundleBytes / 1024).toFixed(1)} KiB · vendor ${vendorCount} files · zip ${(stat.size / 1024).toFixed(1)} KiB (${zipMiB.toFixed(2)} MiB)`,
  );
  console.log(`  zero-install contents: ultra.mjs, ultra, ultra.cmd, package.json, assets/vendor/, engines/blender/render_scene.py, SKILL.md, CHAT_START_PROMPT.txt, SPEC.md, README.md`);
}

main().catch((err) => {
  console.error(`[pack:cloud] ${(err as Error).message}`);
  process.exitCode = 1;
});
