# Punchy Shortform — 9:16 retention grammar

A shortform system built for the first three seconds. Hooks are blunt, type is enormous, and every cut earns the next hundred milliseconds. Use it for product demos, talking-head edits, list videos and stat-driven explainers that must survive the TikTok / Reels / Shorts feed.

## Pacing

- Hook average shot length: **0.9–1.6s**. Land a claim, a number or a contradiction before the viewer's thumb moves.
- Body ASL: **1.6–2.8s**. Cut on the beat, never coast past **2.8s** of static frame.
- Trim silence at **160ms**, keep **120ms J-cuts** and **180ms L-cuts** so audio leads the picture.
- Aim for **65%** of cuts landing within ±100ms of an onset.

## Type & captions

Display type is Ultra Display (700), tight tracking, sentence meaning over decoration. Captions are Ultra Sans 700, **2–4 words per chunk**, uppercase, with an **active-word pill** in accent yellow. The caption band lives at **62–76% height** on 9:16 — fully above the bottom 22% platform UI and clear of the right 15% rail.

## Motion

Punch-ins run **1.00 → 1.14** with `easeOutExpo`; the accent uses `easeOutBack` for a decisive overshoot. Motion blur is sampled **4×** per frame so zooms read like a real camera, not a CSS transition. Camera drift stays under 18px.

## Color & texture

Obsidian `#0B0D12`, raised surfaces `#151A23`, warm white `#F7F5EF`, muted blue-grey `#9AA4B2`, signal yellow `#FFD447`, alert coral `#FF5A5F`. Grade adds +0.12 contrast, +12% saturation and a restrained 0.18 vignette. Film grain 0.045, halation 0.12 — texture, not haze.

## Sound

Target **−14 LUFS** with a **110–150 BPM** bed. Hook → sub-hit, transition → whoosh-fast, accent → ui-click, pop-ins → pop. Duck music **11 dB** under voice.

## Non-negotiables

No slow logo stings. No talking head held past 2.8s. No captions under the platform rail. No decorative gradient washes — color comes from the palette, type and footage.
