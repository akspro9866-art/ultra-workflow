# AGENTS.md — Ultra Workflow v6 universal agent contract

Applies to Qoder, Google Gemini, Meta Muse, ChatGPT, Codex, Claude and any future coding agent.

## Mandatory Pre-Production Approval Gate
1. Read the user's request and pick a process: EXTRACT STYLE, CLONE REFERENCE, or EDIT IN STYLE.
2. Run `ultra plan-init` (add `--style`, `--aspect`, `--resolution` as needed) and write the real concept, palette, typography, audio direction and shot-by-shot storyboard into `workspace/plan.json`.
3. Run `ultra preprod-render`, inspect `build/preprod/moodboard.png` and `build/preprod/storyboard*.png`, then SHOW BOTH to the user.
4. WAIT for explicit user approval. Never self-approve. Only after the user says yes run `ultra approve --by user`.
5. `ultra build` / `ultra render` are hard-blocked until `workspace/approval.json` matches the SHA-256 of plan.json + ultra.json. If the plan changes, re-render, re-show, re-approve.

## Six-step workflow
1. Probe + RAG + Plan Mode + Mood Board + Storyboard -> approval.
2. `ultra approve` -> assets (native tools or `ultra synth-audio`) -> `ultra validate-assets`.
3. `ultra build --proxy` for fast cloud iteration.
4. `ultra verify` / `ultra ralph auto-fix` until `stutterEvents === 0`, lint passes and style score >= 90.
5. `ultra render --4k` (hybrid or native) -> exact 4K master + `build/delivery-manifest.json`.
6. `ultra export-project` -> `ultra guard --stage delivery` -> deliver MP4 + editable zip + evidence.

## Hard rules
- ZERO external AI APIs, ZERO API keys, ZERO `npm install` in cloud chats. Use the bundled `dist/ultra.mjs`, offline fonts, synth-audio and the host's native image/video/audio tools.
- Never claim complete without test evidence. Run `ultra guard` and `ultra ralph status`; cite `ffprobe`, `verify-report.json`, `delivery-manifest.json` and CI.
- Keep all paths relative in exported projects. No placeholder text ("Lorem ipsum", "TBD", "INSERT TEXT") in shipped scenes or captions.
- Use `ultra context-pack --stage <stage>` on long chats; call `ultra status --json` every turn.
- Follow `.ultra/rules/*` and the role contracts in `.ultra/agents/*`.

## Honest limitations
- Web chats run roles sequentially; only multi-agent IDEs can truly parallelize director + asset-producer.
- Native 4K re-render is memory-heavy; `--4k-strategy hybrid` is the default cloud-safe path and is logged in the delivery manifest.
- `ultra guard` blocks false completion claims; it cannot judge subjective taste. The 100-point rubric and style-match sheet remain human/agent judgment.
