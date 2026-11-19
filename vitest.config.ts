import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/phase*.test.ts"],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    reporters: ["verbose"],
  },
});
