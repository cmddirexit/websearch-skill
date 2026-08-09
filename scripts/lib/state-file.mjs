/** Crash-safe synchronous writes for small CLI state and cache files. */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

let tempSequence = 0;

/** Write beside the target and atomically replace it after the full payload is on disk. */
export function atomicWriteFileSync(file, data, options) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const temp = join(
    dir,
    `.${basename(file)}.${process.pid}.${Date.now()}.${tempSequence++}.tmp`,
  );
  try {
    writeFileSync(temp, data, options);
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function atomicWriteJsonSync(file, value, options) {
  atomicWriteFileSync(file, JSON.stringify(value), options);
}
