# Kinetic editorial recreation

This folder records the native Ultra Workflow recreation of the supplied video. The source filename says “Peaceful worship room”, but its actual frames show an abstract 9-second motion-design sequence: “a NEW system / that feels / familiar / adaptable / intentional / and / human”. The visual content, not the filename, was followed.

## Project
- 9 independently timed scenes, 24 fps, 8.958333 s
- 19 visual assets: extracted photo tiles plus custom transparent vector assets
- 8 scene transitions; staggered position/opacity/scale keyframes; motion blur sampling; fine grain
- 1 ambient synth bed + whoosh, pop, shutter, sub-hit and chime SFX
- Native Ultra JSON, assets, FCPXML, OTIO, scene renders and inspector are included in the downloadable editable project package.

## Rebuild
Extract the source workspace package into the project workspace, add the supplied video as `reference.mp4`, then run:
```bash
ULTRA_NO_BROWSER=1 node ultra.mjs validate-spec
ULTRA_NO_BROWSER=1 node ultra.mjs validate-assets
ULTRA_NO_BROWSER=1 node ultra.mjs build
ULTRA_NO_BROWSER=1 node ultra.mjs verify reference.mp4
```

## Verification
PASS: exact duration and 24 fps; zero stutter; zero static holds; zero black frames; zero lint defects; audio −17.39 LUFS; delivery guard PASS.

The final downloadable master is 1920×1080 H.264/AAC, upscaled from the native Ultra 960×540 render because the original source is only 702×396. The complete source package and rendered media are provided separately with the delivery.
