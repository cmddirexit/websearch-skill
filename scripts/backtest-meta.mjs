// Cross-domain prior evaluation from replayable v4 training events.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { REP_FILE } from "./lib/config.mjs";
import { predictTokens, updateMetaTokens } from "./lib/domain-rep.mjs";

const file = process.argv[2] || REP_FILE;
if (!existsSync(file)) {
  console.error(`没有信誉状态文件: ${file}`);
  process.exitCode = 2;
} else {
  const state = JSON.parse(readFileSync(file, "utf8"));
  const events = Array.isArray(state.events) ? state.events.filter((event) => event?.tokens?.length) : [];
  if (state.version !== 4 || events.length < 10) {
    console.error(`可回放事件不足: schema=${state.version}, events=${events.length}; 至少需要 v4 的 10 条事件`);
    process.exitCode = 2;
  } else {
    evaluate(events);
  }
}

function emptyMeta() {
  return { bias: 0, weights: {}, touched: {}, z: {}, n: {}, weightSamples: 0, effectiveSamples: 0, positiveSamples: 0, negativeSamples: 0 };
}

function train(events) {
  const meta = emptyMeta();
  for (const event of events) {
    updateMetaTokens(meta, new Set(event.tokens), event.label, { confidence: event.confidence ?? 1 });
  }
  return meta;
}

function foldFor(domain) {
  const byte = createHash("sha256").update(domain || "unknown").digest()[0];
  return byte % 5;
}

function metrics(rows) {
  if (!rows.length) return null;
  let brier = 0;
  let mae = 0;
  let lowTotal = 0;
  let lowHit = 0;
  let goodTotal = 0;
  let goodFalsePositive = 0;
  for (const row of rows) {
    brier += (row.pred - row.label) ** 2;
    mae += Math.abs(row.pred - row.label);
    if (row.label <= 0.35) {
      lowTotal++;
      if (row.pred <= 0.4) lowHit++;
    }
    if (row.label >= 0.65) {
      goodTotal++;
      if (row.pred <= 0.4) goodFalsePositive++;
    }
  }
  return {
    n: rows.length,
    brier: brier / rows.length,
    mae: mae / rows.length,
    lowRecall: lowTotal ? lowHit / lowTotal : null,
    goodFalsePositiveRate: goodTotal ? goodFalsePositive / goodTotal : null,
  };
}

function predict(meta, event) {
  return predictTokens(new Set(event.tokens), meta);
}

function printMetrics(label, result, rows) {
  if (!result) {
    console.log(`${label}: 无法计算（需要至少两个可分离的域名组）`);
    return;
  }
  const pct = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
  const neutralBrier = rows.reduce((sum, row) => sum + (0.5 - row.label) ** 2, 0) / rows.length;
  console.log(`${label}: n=${result.n} Brier=${result.brier.toFixed(4)} neutral-Brier=${neutralBrier.toFixed(4)} MAE=${result.mae.toFixed(4)} low-recall@0.4=${pct(result.lowRecall)} good-FPR@0.4=${pct(result.goodFalsePositiveRate)}`);
}

function evaluate(events) {
  const sourceCounts = {};
  for (const event of events) sourceCounts[event.source] = (sourceCounts[event.source] || 0) + 1;
  console.log(`事件 ${events.length} 条, 域名 ${new Set(events.map((event) => event.domain)).size} 个`);
  console.log(`来源: ${Object.entries(sourceCounts).map(([source, count]) => `${source}=${count}`).join(", ")}`);

  const groupedRows = [];
  for (let fold = 0; fold < 5; fold++) {
    const training = events.filter((event) => foldFor(event.domain) !== fold);
    const heldOut = events.filter((event) => foldFor(event.domain) === fold);
    if (!training.length || !heldOut.length) continue;
    const meta = train(training);
    for (const event of heldOut) groupedRows.push({ label: event.label, pred: predict(meta, event) });
  }
  printMetrics("5-fold 按域名隔离", metrics(groupedRows), groupedRows);

  const ordered = [...events].sort((a, b) => (a.at || 0) - (b.at || 0));
  const split = Math.max(1, Math.floor(ordered.length * 0.8));
  const temporalMeta = train(ordered.slice(0, split));
  const temporalRows = ordered.slice(split).map((event) => ({ label: event.label, pred: predict(temporalMeta, event) }));
  printMetrics("时间后 20% 留出", metrics(temporalRows), temporalRows);
  console.log("模型必须同时低于对应切分的 neutral-Brier 并控制正常内容误伤率。");
}
