import { UltraProject, type UltraProjectT } from "./schema.js";

export function starterProject(): UltraProjectT {
  return UltraProject.parse({
    meta: {
      title: "Ultra Starter",
      sourceVideoPath: "reference.mp4",
      width: 1280,
      height: 720,
      fps: 30,
      durationSec: 4,
    },
    designTokens: {
      palette: {
        bg: "#0b0d10",
        fg: "#f2f2f0",
        accent: "#ffb703",
        secondary: "#219ebc",
      },
      fonts: { heading: "Segoe UI", body: "Segoe UI", mono: "Consolas" },
      grainOpacity: 0.05,
      antiSlopRules: [
        "No stock template gradients or filler iconography",
        "Every visible color must come from the palette",
        "No wall-clock motion: every animation is keyframed",
      ],
    },
    colorGrade: { exposure: 0, contrast: 0, saturation: 1, temperature: 0, vignette: 0 },
    audio: { targetLufs: -14, duckingDb: -12, sfxCues: [] },
    assets: [],
    scenes: [
      {
        id: "intro",
        name: "Intro",
        startSec: 0,
        endSec: 2.2,
        engine: "hyperframes",
        alpha: false,
        transitionIn: { type: "none", durationSec: 0 },
        background: "#0b0d10",
        layers: [
          {
            id: "rule",
            type: "shape",
            color: "#ffb703",
            x: 140,
            y: 436,
            width: 260,
            height: 8,
            opacity: 1,
            rotation: 0,
            radius: 4,
            blend: "normal",
          },
        ],
        keyframes: [
          {
            target: "headline",
            property: "opacity",
            keyframes: [
              { atSec: 0, value: 0, ease: "easeOutCubic" },
              { atSec: 0.45, value: 1, ease: "linear" },
            ],
          },
          {
            target: "headline",
            property: "y",
            keyframes: [
              { atSec: 0, value: 352, ease: "easeOutCubic" },
              { atSec: 0.6, value: 300, ease: "linear" },
            ],
          },
          {
            target: "rule",
            property: "scale",
            keyframes: [
              { atSec: 0.25, value: 0, ease: "easeOutExpo" },
              { atSec: 0.9, value: 1, ease: "linear" },
            ],
          },
        ],
        textElements: [
          {
            id: "headline",
            text: "ULTRA",
            font: "heading",
            sizePx: 150,
            color: "#f2f2f0",
            x: 140,
            y: 300,
            align: "left",
            letterSpacingPx: -4,
            lineHeight: 1,
            uppercase: true,
          },
          {
            id: "sub",
            text: "workflow starter",
            font: "body",
            sizePx: 28,
            color: "#219ebc",
            x: 144,
            y: 470,
            align: "left",
            weight: 500,
            letterSpacingPx: 1,
            lineHeight: 1.2,
            uppercase: false,
          },
        ],
        effects: [],
        enginePayload: {},
      },
      {
        id: "outro",
        name: "Outro",
        startSec: 2.2,
        endSec: 4,
        engine: "hyperframes",
        alpha: false,
        transitionIn: { type: "fade", durationSec: 0.3 },
        background: "#0b0d10",
        layers: [],
        keyframes: [
          {
            target: "tagline",
            property: "opacity",
            keyframes: [
              { atSec: 0, value: 0, ease: "easeOutCubic" },
              { atSec: 0.5, value: 1, ease: "linear" },
            ],
          },
        ],
        textElements: [
          {
            id: "tagline",
            text: "BUILD · VERIFY · RENDER",
            font: "heading",
            sizePx: 54,
            color: "#ffb703",
            x: 340,
            y: 330,
            align: "center",
            letterSpacingPx: 2,
            lineHeight: 1.1,
            uppercase: true,
          },
        ],
        effects: [],
        enginePayload: {},
      },
    ],
  });
}

export const DESIGN_TEMPLATE = `# DESIGN.md — style · palette · anti-slop contract

Fill this in AFTER inspecting \`workspace/probe.json\`, \`workspace/contact-sheet-*.png\`
and the raw reference frames. Every value here must come from the reference — not
from a template.

## Palette (exact hex)
| token | hex | where it appears |
|-------|-----|------------------|
| bg    | #0b0d10 | background |
| fg    | #f2f2f0 | primary text |
| accent | #ffb703 | emphasis / rules |
| secondary | #219ebc | support text |

Mirror this table into \`ultra.json → designTokens.palette\`.

## Typography
- Heading: (family, weight, tracking, case) — match the reference's display scale.
- Body: (family, weight, size range).
- Mono: for labels/numbers only.

## Surface & texture
- Grain opacity vs reference: __
- Vignette/falloff: __
- LUT / curve grade: (file or parameter intent)

## Anti-slop rules (non-negotiable)
1. No stock template gradients, glow blobs, or filler iconography.
2. Every visible color must exist in \`designTokens.palette\`.
3. No wall-clock animation: every move is a keyframe with a real easing curve.
4. Text must never clip or overlap at any frame (the linter enforces this).
5. Motion must echo the reference's rhythm (cut/beat timestamps from probe.json).
`;

export const MOTION_TEMPLATE = `# Motion.md — shot-by-shot contract

| # | sceneId | in | out | engine | transition in | motion notes | audio cues |
|---|---------|----|-----|--------|---------------|--------------|------------|
| 1 | intro | 0.0s | 2.2s | hyperframes | — | headline rises 52px easeOutCubic 0.6s; rule scales in easeOutExpo | — |
| 2 | outro | 2.2s | 4.0s | hyperframes | fade 0.3s | tagline fades 0.5s | — |

Rules:
- Every row must map 1:1 to a scene in \`ultra.json\` (same ids).
- Timestamps must line up with probe.json cuts/onsets.
- Engines: hyperframes (DOM/animation), remotion (UI/data/spring), revideo
  (generator diagrams), blender (3D alpha overlays via enginePayload.sceneGraphAssetId).
`;
