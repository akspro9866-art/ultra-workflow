import archiver from "archiver";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { ensureDir } from "./util.js";

export interface ZipEntry {
  name: string;
  size: number;
  crcOk: boolean;
}

export interface ZipInputFile {
  name: string;
  source?: string;
  data?: Buffer | string;
  mode?: number;
}

let CRC_TABLE: Uint32Array | null = null;

function crc32(buffer: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ (buffer[i] as number)) & 0xff] as number);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function safeRelative(name: string): string | null {
  if (!name || name.includes("..") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return null;
  return name.split("\\").join("/");
}

/** Deterministic zip writer used by pack:cloud and style-export. */
export async function createZip(files: ZipInputFile[], outFile: string): Promise<{ bytes: number; count: number }> {
  await ensureDir(path.dirname(outFile));
  await fs.rm(outFile, { force: true });
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outFile);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.on("warning", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      reject(err);
    });
    archive.pipe(output);
    for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
      const options = { name: file.name, ...(file.mode !== undefined ? { mode: file.mode } : {}) };
      if (file.data !== undefined) {
        archive.append(typeof file.data === "string" ? Buffer.from(file.data, "utf8") : file.data, options);
      } else if (file.source) {
        archive.file(file.source, options);
      } else {
        throw new Error(`zip input "${file.name}" has neither source nor data`);
      }
    }
    void archive.finalize();
  });
  const stat = await fs.stat(outFile);
  return { bytes: stat.size, count: files.length };
}

/**
 * Minimal deterministic zip extractor (EOCD + central directory + inflateRaw)
 * with CRC-32 verification — pure Node, no external unzip binaries.
 */
export async function extractZip(zipPath: string, destDir: string): Promise<{ entries: ZipEntry[] }> {
  const buf = await fs.readFile(zipPath);
  let eocd = -1;
  const lowest = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= lowest; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip EOCD not found");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central directory entry at ${p}`);
    const method = buf.readUInt16LE(p + 10);
    const expectedCrc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith("/")) continue;
    const name = safeRelative(rawName);
    if (!name) continue;

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = inflateRawSync(compressed);
    else throw new Error(`unsupported compression method ${method} for ${name}`);

    const crcOk = (crc32(data) >>> 0) === (expectedCrc >>> 0);
    entries.push({ name, size: data.length, crcOk });
    const outFile = path.join(destDir, ...name.split("/"));
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, data);
  }
  return { entries };
}
