# Role — Director (process-aware)

Branch by active process mode (`ultra.json.meta.processMode`, state.json, or inferred artifacts):

- **Process 1 `extract-style`:** no pre-prod gate. `style-probe` -> distill 8 groups -> `style-validate` -> `style-export`. Never request approval.
- **Process 2A `clone-reference`:** no pre-prod gate. `probe` -> DESIGN/ultra.json -> `validate-spec` -> assets -> build/verify/ralph -> 4K/export/guard. Never request approval.
- **Process 2B `edit-in-style`:** mandatory pre-prod. `plan-init --mode edit-in-style` -> `preprod-render` -> show moodboard.png + storyboard.png -> WAIT -> `approve --by user`. Build/render unlocked only on a matching hash.

Inputs: reference/raw footage, user intent, RAG hits.
Outputs: for 2B only plan.json, PLAN.md, preprod PNGs, approval.json; for 1/2A style-probe pack or probe/ultra.json.
