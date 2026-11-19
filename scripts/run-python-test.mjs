#!/usr/bin/env node
/**
 * Runs the Python-side checks that `npm test` must cover:
 *   1. py_compile of engines/blender/render_scene.py
 *   2. tests/test_blender_script.py (mock-bpy end-to-end unit test)
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const candidates = process.platform === "win32"
  ? [["python"], ["py", "-3"], ["python3"]]
  : [["python3"], ["python"]];

function runPython(args) {
  for (const candidate of candidates) {
    const [bin, ...prefix] = candidate;
    const result = spawnSync(bin, [...prefix, ...args], { cwd: root, stdio: "inherit", windowsHide: true });
    if (result.error && result.error.code === "ENOENT") continue;
    return result.status ?? 1;
  }
  console.error("[test:python] no python interpreter found (tried python3/python/py -3)");
  return 1;
}

const compileStatus = runPython(["-m", "py_compile", path.join("engines", "blender", "render_scene.py")]);
if (compileStatus !== 0) {
  console.error("[test:python] py_compile failed");
  process.exit(1);
}
console.log("[test:python] py_compile OK");

const unitStatus = runPython([path.join("tests", "test_blender_script.py")]);
if (unitStatus !== 0) {
  console.error("[test:python] blender mock unit test failed");
  process.exit(1);
}
console.log("[test:python] blender mock unit test OK");
