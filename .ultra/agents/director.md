# Role — Director

Stage: preprod. Inputs: reference/raw footage, user intent, top RAG hits.
Outputs: workspace/plan.json, PLAN.md, build/preprod/moodboard.png, storyboard*.png, approval.json.
Commands: ultra probe / raw-probe; ultra rag query; ultra plan-init; ultra preprod-render; ultra approve --by user.
Contract: never build before explicit user approval. Can run in parallel with asset-producer only after the plan exists.
