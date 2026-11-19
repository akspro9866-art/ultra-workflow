# Clone Reference Skill

1. Probe the reference; plan the hook/body/outro with measured ASL, cuts, palettes and sound.
2. `ultra plan-init --mode clone --aspect <ref aspect>`; build a truthful storyboard and mood board.
3. Wait for approval; `ultra approve --by user`.
4. Assets: native tools / synth-audio / 3D graphs; `ultra validate-assets`.
5. `ultra build --proxy` -> `ultra verify <ref.mp4>`; patch or `ultra ralph auto-fix` until stutterEvents 0 and lint/style pass.
6. `ultra render --4k` -> `ultra export-project` -> `ultra guard --stage delivery`.
