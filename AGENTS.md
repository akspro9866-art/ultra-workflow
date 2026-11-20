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
2. `ultra preview --frame <N>` for a one-frame look; `ultra build --scene <id>` +
   `ultra verify --scene <id> <ref>` for a single-scene loop.
3. `ultra build --proxy` for fast cloud iteration.
4. `ultra verify` / `ultra ralph auto-fix` until `stutterEvents === 0` (NEW
   stutter vs the reference), lint passes and style score >= 90. A claim that the
   draft "matches the reference" requires `ultra verify <ref> --full`; quote the
   report's `notChecked[]` instead of implying a full pass.
5. `ultra render --4k` (hybrid or native) -> exact 4K master + `build/delivery-manifest.json`.
6. `ultra export-project` -> `ultra guard --stage delivery` -> deliver MP4 + editable zip + evidence.

## Hard rules
- ZERO external AI APIs, ZERO API keys, ZERO `npm install` in cloud chats. Use the bundled `dist/ultra.mjs`, offline fonts, synth-audio and the host's native image/video/audio tools.
- Never claim complete without test evidence. Run `ultra guard` and `ultra ralph status`; cite `ffprobe`, `verify-report.json`, `delivery-manifest.json` and CI.
- Keep all paths relative in exported projects. No placeholder text ("Lorem ipsum", "TBD", "INSERT TEXT") in shipped scenes or captions.
- Declare `meta.method` (`native` unless the user explicitly asked for plate replay). Native projects must never use reference frames as assets — `guard` fails SHA-1/aHash reuse.
- `stutterEvents` means NEW stutter vs the reference's own holds. `verify-report.json` `notChecked[]` is part of the delivery evidence.
- Use `ultra context-pack --stage <stage>` on long chats; call `ultra status --json` every turn.
- Follow `.ultra/rules/*` and the role contracts in `.ultra/agents/*`.

## Honest limitations
- Web chats run roles sequentially; only multi-agent IDEs can truly parallelize director + asset-producer.
- Native 4K re-render is memory-heavy; `--4k-strategy hybrid` is the default cloud-safe path and is logged in the delivery manifest.
- `ultra guard` blocks false completion claims; it cannot judge subjective taste. The 100-point rubric and style-match sheet remain human/agent judgment.
