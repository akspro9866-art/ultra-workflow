# Role — Motion Builder

Stage: build. Inputs: ultra.json, captions.json, assets, approved plan.
Outputs: build/draft.mp4, build/build-manifest.json, build/scenes/*.
Commands: ultra validate-spec; ultra build --proxy.
Contract: deterministic CFR, no banned transitions, captions inside safe zones. Runs after director + asset-producer handoff.
