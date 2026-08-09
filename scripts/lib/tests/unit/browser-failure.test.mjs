import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("browser CLI failure is diagnostic and a later success clears stale failure state", () => {
  const dir = mkdtempSync(join(tmpdir(), "websearch-browser-failure-"));
  const fakeBrowser = join(dir, "chromium");
  const successMarker = join(dir, "succeed");
  writeFileSync(
    fakeBrowser,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Chromium 149.0.0.0"; exit 0; fi\nif [ -f "$WEBSEARCH_FAKE_BROWSER_SUCCESS_FILE" ]; then echo "<html><body>rendered</body></html>"; exit 0; fi\necho "intentional browser failure" >&2\nexit 1\n',
  );
  chmodSync(fakeBrowser, 0o755);

  try {
    const script = `
      const { writeFileSync } = await import("node:fs");
      const { getDom, getLastBrowserFailure, closeBrowser } = await import(${JSON.stringify(new URL("../../engines/browser.mjs", import.meta.url).href)});
      const failed = await getDom("https://example.invalid");
      if (failed !== null || !getLastBrowserFailure()) throw new Error("missing browser failure state");
      writeFileSync(process.env.WEBSEARCH_FAKE_BROWSER_SUCCESS_FILE, "ok");
      const html = await getDom("https://example.invalid");
      if (!html || getLastBrowserFailure() !== "") throw new Error("stale browser failure state");
      await closeBrowser();
      console.log("ok");
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        WEBSEARCH_BROWSER_PATH: fakeBrowser,
        WEBSEARCH_CACHE_DIR: dir,
        WEBSEARCH_FAKE_BROWSER_SUCCESS_FILE: successMarker,
      },
      timeout: 15_000,
    });

    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /ok/);
    assert.doesNotMatch(child.stderr, /ReferenceError|BROWSER_DEBUG_LOG is not defined/);
    assert.match(child.stderr, /intentional browser failure/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
