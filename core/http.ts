import http from "node:http";
import { promises as fs } from "node:fs";

export interface ServedFile {
  url: string;
  close: () => Promise<void>;
}

/** Serve a single file over a loopback HTTP server (needed for ES module imports in Chromium). */
export async function serveSingleFile(file: string): Promise<ServedFile> {
  const content = await fs.readFile(file);
  const server = http.createServer((_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(content);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to bind loopback server");
  }
  return {
    url: `http://127.0.0.1:${address.port}/module.js`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
