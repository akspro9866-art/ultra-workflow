#!/usr/bin/env node
/**
 * Installs the optional heavy engines (Remotion, Revideo) in their isolated
 * workspaces. Failure is non-fatal: the orchestrator falls back to HyperFrames.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const engine of ["remotion", "revideo"]) {
  const cwd = path.join(root, "engines", engine);
  console.log(`\n[setup:engines] installing ${engine} workspace deps…`);
  const result = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.warn(
      `[setup:engines] ${engine} install failed (exit ${result.status}). ` +
        `This is optional: ${engine} scenes will fall back to HyperFrames.`,
    );
    continue;
  }
  // Recent npm versions can block postinstall scripts; approve only the known
  // build-time dependencies these engines need, then rebuild their binaries.
  for (const pkg of ["esbuild", "puppeteer", "@revideo/telemetry"]) {
    spawnSync("npm", ["install-scripts", "approve", pkg], { cwd, stdio: "ignore", shell: process.platform === "win32" });
  }
  spawnSync("npm", ["rebuild"], { cwd, stdio: "ignore", shell: process.platform === "win32" });
}

console.log("\n[setup:engines] done. `ultra doctor --json` shows what is active.");
