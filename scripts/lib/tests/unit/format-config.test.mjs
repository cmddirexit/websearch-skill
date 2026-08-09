import { test } from "node:test";
import assert from "node:assert/strict";
import { CLUSTER_SIM_THRESHOLD, EMBED_API_SIM_THRESHOLD } from "../../config.mjs";
import { semanticClusterOptions } from "../../format.mjs";

test("semantic cluster options select a backend threshold without mutating env", () => {
  const env = {};
  const vectors = [[1, 0]];
  const qVec = [1, 0];

  assert.deepEqual(semanticClusterOptions({ backend: "api", vectors, qVec }, env), {
    vectors,
    queryVec: qVec,
    simThreshold: EMBED_API_SIM_THRESHOLD,
  });
  assert.equal(env.WEBSEARCH_SIM_THRESHOLD, undefined);
  assert.equal(
    semanticClusterOptions({ backend: "local", vectors }, env).simThreshold,
    CLUSTER_SIM_THRESHOLD,
  );
});

test("semantic cluster options preserve an explicit zero threshold", () => {
  const env = { WEBSEARCH_SIM_THRESHOLD: "0" };
  assert.equal(semanticClusterOptions({ backend: "api", vectors: [] }, env).simThreshold, 0);
  assert.equal(env.WEBSEARCH_SIM_THRESHOLD, "0");
});
