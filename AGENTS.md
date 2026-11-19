# AGENTS.md — Ultra Workflow v6 universal agent contract

Applies to Qoder, Google Gemini, Meta Muse, ChatGPT, Codex, Claude and any future coding agent.

## Pre-production gate — PROCESS 2B ONLY
**Mood Board + Storyboard Approval Gate applies ONLY to Process 2B (`edit-in-style`, "Edit My Own Footage in Style"). Process 1 (Extract Style) and Process 2A (Clone Reference Video) run autonomously start-to-finish without any pre-prod approval pause.**

- **Process 2B (`edit-in-style`) — gated:**
  1. `ultra plan-init --mode edit-in-style [--style ...]` and write the real concept, palette, typography, audio direction and shot storyboard.
  2. `ultra preprod-render`, inspect `build/preprod/moodboard.png` + `storyboard*.png`, then SHOW BOTH to the user.
  3. WAIT for explicit approval (never self-approve), then `ultra approve --by user`.
  4. `ultra build` / `ultra render` are hard-blocked until the moodboard + storyboard exist AND `workspace/approval.json` matches the SHA-256 of plan.json + ultra.json. Edits invalidate approval.
- **Process 2A (`clone-reference`) — autonomous:** `probe` → DESIGN/ultra.json → `validate-spec` → `asset-plan` → `build --proxy` → `verify`/`ralph` → `render --4k` → `export-project` → `guard --stage delivery`. No plan, moodboard, storyboard or approval pause.
- **Process 1 (`extract-style`) — autonomous:** `style-probe` → distill 8 parameter groups → `style-validate` → `style-export <slug>-style-pack.zip`. No plan/moodboard/approval pause.

## Delivery workflow
1. Assets (native tools or `ultra synth-audio`) -> `ultra validate-assets` (2A/2B).
2. `ultra build --proxy` for fast cloud iteration.
3. `ultra verify` / `ultra ralph auto-fix` until `stutterEvents === 0`, lint passes and style score >= 90.
4. `ultra render --4k` (hybrid or native) -> exact 4K master + `build/delivery-manifest.json`.
5. `ultra export-project` -> `ultra guard --stage delivery` -> deliver MP4 + editable zip + evidence.

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
