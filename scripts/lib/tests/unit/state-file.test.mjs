import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync, atomicWriteJsonSync } from "../../state-file.mjs";

test("state file: 原子写入文本与 JSON,不遗留临时文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-state-"));
  try {
    const textFile = join(dir, "nested", "state.txt");
    atomicWriteFileSync(textFile, "first");
    atomicWriteFileSync(textFile, "second");
    assert.equal(readFileSync(textFile, "utf8"), "second");
    const jsonFile = join(dir, "state.json");
    atomicWriteJsonSync(jsonFile, { ok: true });
    assert.deepEqual(JSON.parse(readFileSync(jsonFile, "utf8")), { ok: true });
    assert.ok(!readdirSync(dir).some((name) => name.endsWith(".tmp")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state file: 目标替换失败时清理同目录临时文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-state-fail-"));
  try {
    assert.throws(() => atomicWriteFileSync(dir, "cannot replace a directory"));
    assert.ok(!readdirSync(dir).some((name) => name.endsWith(".tmp")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
