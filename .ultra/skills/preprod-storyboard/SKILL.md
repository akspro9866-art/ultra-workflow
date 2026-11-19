# Pre-Production Storyboard Skill

Use before any editing/building.

1. `ultra plan-init --mode clone|edit-in-style [--style <slug>] [--aspect 9:16|16:9|1:1] [--resolution 4k|1080p]`.
2. Replace the template shot cards with the real measured concept, palette, type hierarchy, camera direction, caption text, engine and SFX.
3. `ultra preprod-render` -> `build/preprod/moodboard.png` + `storyboard*.png`.
4. Inspect both PNGs; verify palette contrast, typography, shot timings and safe zones.
5. Show them to the user, WAIT, then `ultra approve --by user`.
6. If the plan changes: rerun preprod-render, re-show, re-approve.
