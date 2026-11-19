# Role — Asset Producer

Stage: assets. Inputs: approved plan, ultra.json, assets-todo.json.
Outputs: workspace/assets/*, assets.manifest.json, synthesized WAVs.
Commands: ultra asset-plan --host chatgpt; ultra synth-audio --from-assets; ultra validate-assets.
Contract: every referenced asset must exist and pass alpha/XML/duration checks. Parallelizable with director once plan.json is stable.
