# Extract Style Skill — Process 1 (autonomous, NO approval pause)

No `plan.json`, moodboard, storyboard, `approve` or approval wait belongs in this process.

1. `ultra style-probe <1-10 videos> --out workspace/style-probe --hook-window 5`.
2. Map-Reduce the 8 parameter groups into style.json (strict schema), STYLE.md, 2+ deterministic motifs and 2-8 exemplars.
3. `ultra style-validate <dir>` until exit 0.
4. `ultra style-export <dir> --out build/<slug>-style-pack.zip`.
5. Deliver only the validated zip; Qoder imports it with `ultra style-import <zip> --repack`.
