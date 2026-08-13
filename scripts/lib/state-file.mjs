/**
 * Crash-safe synchronous writes for small CLI state and cache files.
 *
 * 并发限制:原子性只保证"写入过程不产生半截文件";多个 CLI 进程并发读写同一状态文件
 * (域名信誉/引擎失败记忆/cookie)时是 last-write-wins,可能丢更新。当前按单进程模型
 * 使用;如需并发安全需引入文件锁(超出当前需求,暂不做)。
 */
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
