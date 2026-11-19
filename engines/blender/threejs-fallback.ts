import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SceneGraphT } from "./schema.js";
import { serveSingleFile } from "../../core/http.js";
import { closePage, newPage } from "../../core/browser.js";
import { installRoot } from "../../core/env.js";
import { ensureDir, pathExists, rmrf } from "../../core/util.js";

const PAGE_JS = String.raw`
const GRAPH = JSON.parse(document.getElementById('graph').textContent);
const THREE_URL = JSON.parse(document.getElementById('three-url').textContent);

import(THREE_URL).then((THREE) => {
  const W = GRAPH.__width;
  const H = GRAPH.__height;
  const FPS = GRAPH.__fps;

  const scene = new THREE.Scene();
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  document.body.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(GRAPH.camera.fov || 45, W / H, 0.05, 500);
  const DEG = Math.PI / 180;

  const materials = {};
  (GRAPH.materials || []).forEach((m) => {
    materials[m.id] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(m.color),
      metalness: m.metalness === undefined ? 0.2 : m.metalness,
      roughness: m.roughness === undefined ? 0.5 : m.roughness,
      transparent: (m.opacity === undefined ? 1 : m.opacity) < 1,
      opacity: m.opacity === undefined ? 1 : m.opacity,
      emissive: m.emissive ? new THREE.Color(m.emissive) : new THREE.Color(0x000000),
      emissiveIntensity: m.emissiveIntensity === undefined ? 1 : m.emissiveIntensity,
    });
  });

  const objects = [];
  (GRAPH.meshes || []).forEach((spec) => {
    let geometry;
    switch (spec.primitive) {
      case 'sphere': geometry = new THREE.SphereGeometry(0.5, 32, 24); break;
      case 'plane': geometry = new THREE.PlaneGeometry(1, 1); break;
      case 'cylinder': geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 32); break;
      case 'cone': geometry = new THREE.ConeGeometry(0.5, 1, 32); break;
      case 'torus': geometry = new THREE.TorusGeometry(0.4, 0.12, 16, 32); break;
      case 'cube':
      default: geometry = new THREE.BoxGeometry(1, 1, 1);
    }
    const source = materials[spec.materialId] || new THREE.MeshStandardMaterial({ color: 0xcccccc });
    const material = source.clone();
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    objects.push({ spec, mesh, material });
  });

  (GRAPH.lights || []).forEach((light) => {
    let node;
    if (light.type === 'ambient') {
      node = new THREE.AmbientLight(new THREE.Color(light.color), light.intensity * 0.8);
    } else if (light.type === 'directional') {
      node = new THREE.DirectionalLight(new THREE.Color(light.color), light.intensity * 2.5);
      node.position.set(light.position[0], light.position[1], light.position[2]);
      node.target.position.set(0, 0, 0);
      scene.add(node.target);
    } else {
      node = new THREE.PointLight(new THREE.Color(light.color), light.intensity * 45, 0, 2);
      node.position.set(light.position[0], light.position[1], light.position[2]);
    }
    scene.add(node);
  });
  if (!GRAPH.lights || !GRAPH.lights.some((l) => l.type === 'ambient')) {
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  }

  function sampleVec(keys, field, t, fallback) {
    const pts = (keys || []).filter((k) => k[field] !== undefined).map((k) => ({ t: k.atSec, v: k[field] }));
    if (pts.length === 0) return fallback;
    if (t <= pts[0].t) return pts[0].v;
    const last = pts[pts.length - 1];
    if (t >= last.t) return last.v;
    for (let i = 1; i < pts.length; i += 1) {
      const b = pts[i];
      if (t <= b.t) {
        const a = pts[i - 1];
        const span = b.t - a.t;
        const p = span <= 0 ? 1 : (t - a.t) / span;
        return a.v.map((av, j) => av + (b.v[j] - av) * p);
      }
    }
    return last.v;
  }

  function sampleScalar(keys, field, t, fallback) {
    const pts = (keys || []).filter((k) => k[field] !== undefined).map((k) => ({ t: k.atSec, v: k[field] }));
    if (pts.length === 0) return fallback;
    if (t <= pts[0].t) return pts[0].v;
    const last = pts[pts.length - 1];
    if (t >= last.t) return last.v;
    for (let i = 1; i < pts.length; i += 1) {
      const b = pts[i];
      if (t <= b.t) {
        const a = pts[i - 1];
        const span = b.t - a.t;
        const p = span <= 0 ? 1 : (t - a.t) / span;
        return a.v + (b.v - a.v) * p;
      }
    }
    return last.v;
  }

  function applyTime(t) {
    for (const entry of objects) {
      const { spec, mesh, material } = entry;
      const position = sampleVec(spec.keyframes, 'position', t, spec.position || [0, 0, 0]);
      const rotation = sampleVec(spec.keyframes, 'rotation', t, spec.rotation || [0, 0, 0]);
      const scale = sampleVec(spec.keyframes, 'scale', t, spec.scale || [1, 1, 1]);
      mesh.position.set(position[0], position[1], position[2]);
      mesh.rotation.set(rotation[0] * DEG, rotation[1] * DEG, rotation[2] * DEG);
      mesh.scale.set(scale[0], scale[1], scale[2]);
      const baseOpacity = (GRAPH.materials || []).find((m) => m.id === spec.materialId);
      const opacity = sampleScalar(spec.keyframes, 'opacity', t, baseOpacity && baseOpacity.opacity !== undefined ? baseOpacity.opacity : 1);
      material.opacity = opacity;
      material.transparent = opacity < 0.999;
    }
    const camSpec = GRAPH.camera || {};
    const camPos = sampleVec(camSpec.keyframes, 'position', t, camSpec.position || [0, 2, 6]);
    const camTarget = sampleVec(camSpec.keyframes, 'target', t, camSpec.target || [0, 0, 0]);
    camera.position.set(camPos[0], camPos[1], camPos[2]);
    camera.lookAt(camTarget[0], camTarget[1], camTarget[2]);
    camera.updateProjectionMatrix();
  }

  window.__GRAPH_SEEK = (frameIndex) => {
    applyTime(frameIndex / FPS);
    renderer.render(scene, camera);
    return true;
  };
  window.__GRAPH_SEEK(0);
  window.__READY = true;
}).catch((err) => {
  window.__ERROR = String(err && err.stack ? err.stack : err);
});
`;

export interface ThreeRenderOptions {
  graph: SceneGraphT;
  outDir: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
}

export async function renderSceneGraphWithThreeJs(opts: ThreeRenderOptions): Promise<{ frames: number; notes: string[] }> {
  const vendorCandidates = [
    path.join(installRoot(), "assets", "vendor", "three.module.min.js"),
    path.join(installRoot(), "node_modules", "three", "build", "three.module.min.js"),
    path.join(installRoot(), "node_modules", "three", "build", "three.module.js"),
  ];
  let threePath: string | null = null;
  for (const candidate of vendorCandidates) {
    if (await pathExists(candidate)) {
      threePath = candidate;
      break;
    }
  }
  if (!threePath) {
    throw new Error("three.js module not found (expected assets/vendor/three.module.min.js); run npm install");
  }
  await rmrf(opts.outDir);
  await ensureDir(opts.outDir);

  const graphWithMeta = { ...opts.graph, __width: opts.width, __height: opts.height, __fps: opts.fps };
  const server = await serveSingleFile(threePath);
  const html = `<!doctype html>
<html><head><meta charset="utf-8"/><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}canvas{display:block}</style></head>
<body>
<script id="graph" type="application/json">${JSON.stringify(graphWithMeta).replace(/</g, "\\u003c")}</script>
<script id="three-url" type="application/json">${JSON.stringify(server.url)}</script>
<script type="module">${PAGE_JS}</script>
</body></html>`;

  const htmlPath = path.join(opts.outDir, "scene.html");
  await fs.writeFile(htmlPath, html, "utf8");

  const frames = Math.max(1, Math.round(opts.durationSec * opts.fps));
  const page = await newPage(opts.width, opts.height);
  try {
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    await page.waitForFunction("window.__READY === true || !!window.__ERROR", undefined, { timeout: 30000 });
    const pageError = await page.evaluate("window.__ERROR || null");
    if (pageError) throw new Error(String(pageError));
    for (let i = 0; i < frames; i += 1) {
      await page.evaluate(`window.__GRAPH_SEEK(${i})`);
      await page.screenshot({
        path: path.join(opts.outDir, `f_${String(i + 1).padStart(5, "0")}.png`),
        type: "png",
        omitBackground: true,
        animations: "disabled",
      });
    }
  } finally {
    await closePage(page);
    await server.close();
  }

  return { frames, notes: ["threejs-webgl-fallback"] };
}
