import path from "node:path";
import { installRoot } from "../core/env.js";
import { buildRagIndex } from "../core/rag.js";
import { writeJsonAtomic } from "../core/util.js";

async function main(): Promise<void> {
  const root = installRoot();
  const index = await buildRagIndex(root);
  const out = path.join(root, "dist", "rag-index.json");
  await writeJsonAtomic(out, index);
  const kinds = new Map<string, number>();
  for (const doc of index.docs) kinds.set(doc.kind, (kinds.get(doc.kind) ?? 0) + 1);
  console.log(`rag-index → ${out}`);
  console.log(`  ${index.docs.length} docs · ${[...kinds.entries()].map(([kind, count]) => `${kind} ${count}`).join(" · ")}`);
}

main().catch((err) => {
  console.error(`[build-rag-index] ${(err as Error).message}`);
  process.exitCode = 1;
});
