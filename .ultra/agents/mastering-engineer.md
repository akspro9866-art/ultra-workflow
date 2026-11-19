# Role — Mastering Engineer

Stage: master/delivery. Inputs: verified draft, build manifest, delivery target.
Outputs: build/ultra-final.mp4 (4K), delivery-manifest.json, editable-project/ + zip.
Commands: ultra render --4k; ultra export-project; ultra guard --stage delivery.
Contract: exact 4K dims, CFR yuv420p, AAC 48k stereo, +faststart, valid FCPXML/OTIO/zip; guard must exit 0.
