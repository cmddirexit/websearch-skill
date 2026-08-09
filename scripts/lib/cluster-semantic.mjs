/**
 * cluster-semantic.mjs — 语义模式:嵌入余弦 + 贪心首领聚类 + 转载折叠 + 超大簇拆分 + 单例桶合并
 *
 * 从原 cluster.mjs 拆出(2026-08 重构,cluster.mjs 变为门面 re-export,公共 API 不变):
 *   - 转载检测(isNearDuplicateDesc / hasReprintTextEvidence):摘要 LCS 文本证据,零词表
 *   - 贪心首领聚类(greedyClusterByCentroid):增量质心,dup 折叠计数
 *   - 超大簇拆分(splitOversized):pairwise 归属度 IQR 离群检测 + 词频子主题分组,零固定阈值
 *   - 单例语义桶合并(bucketSingletons):UPGMA 平均链接 + 数据驱动截止
 *
 * 依赖:html.mjs(转载检测的 LCS/标题近重复)与本文件自身;不依赖分词/标签模块
 * (token 集由 cluster.mjs 算好传入,本模块只消费 d.tokens)。
 */

import { isNearDuplicateTitle } from "./html.mjs";

// ---- 余弦相似度 ----

/** 两个等长向量(嵌入)的余弦相似度,要求已 L2 归一化(embed.mjs 输出即归一化) */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** 向量列表 → 对称相似度矩阵(下三角,row<col 时 matrix[row][col]) */
export function cosineMatrix(vectors) {
  const n = vectors.length;
  const m = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = cosine(vectors[i], vectors[j]);
      m[i][j] = s;
      m[j][i] = s;
    }
  }
  return m;
}

// ---- 转载检测(零词表文本证据,与向量余弦组合使用,见 cluster.mjs 预处理) ----

/**
 * 判断两段文本是否存在至少 minLength 的公共连续子串。后缀自动机时间/空间均为
 * O(a+b),用于 99 条结果的 pairwise 转载候选,避免完整 LCS 的 O(a*b) 开销。
 */
function hasCommonSubstringAtLeast(a, b, minLength) {
  if (minLength <= 0) return true;
  if (!a || !b || Math.min(a.length, b.length) < minLength) return false;
  const base = a.length <= b.length ? a : b;
  const probe = a.length <= b.length ? b : a;
  const states = [{ len: 0, link: -1, next: new Map() }];
  let last = 0;
  for (let i = 0; i < base.length; i++) {
    const ch = base[i];
    const cur = states.length;
    states.push({ len: states[last].len + 1, link: 0, next: new Map() });
    let p = last;
    while (p >= 0 && !states[p].next.has(ch)) {
      states[p].next.set(ch, cur);
      p = states[p].link;
    }
    if (p >= 0) {
      const q = states[p].next.get(ch);
      if (states[p].len + 1 === states[q].len) {
        states[cur].link = q;
      } else {
        const clone = states.length;
        states.push({
          len: states[p].len + 1,
          link: states[q].link,
          next: new Map(states[q].next),
        });
        while (p >= 0 && states[p].next.get(ch) === q) {
          states[p].next.set(ch, clone);
          p = states[p].link;
        }
        states[q].link = clone;
        states[cur].link = clone;
      }
    }
    last = cur;
  }

  let state = 0;
  let length = 0;
  for (let i = 0; i < probe.length; i++) {
    const ch = probe[i];
    while (state !== 0 && !states[state].next.has(ch)) {
      state = states[state].link;
      length = states[state].len;
    }
    if (states[state].next.has(ch)) {
      state = states[state].next.get(ch);
      length += 1;
      if (length >= minLength) return true;
    } else {
      length = 0;
    }
  }
  return false;
}

const DESC_ANCHOR_LENGTH = 20;
const DESC_HASH_BASE = 16_777_619;

/** 预计算摘要的固定窗口哈希。哈希只用于无损预筛:无交集必不可能共享 20 字连续片段;
 * 有交集仍走后缀自动机精确验证,因此碰撞不会造成误判。 */
export function descWindowHashes(value) {
  const text = String(value || "").replace(/\s+/g, "").slice(0, 4096);
  const hashes = new Set();
  if (text.length < DESC_ANCHOR_LENGTH) return { text, hashes };
  let highPow = 1;
  for (let i = 1; i < DESC_ANCHOR_LENGTH; i++) highPow = Math.imul(highPow, DESC_HASH_BASE) >>> 0;
  let hash = 0;
  for (let i = 0; i < DESC_ANCHOR_LENGTH; i++) {
    hash = (Math.imul(hash, DESC_HASH_BASE) + text.charCodeAt(i)) >>> 0;
  }
  hashes.add(hash);
  for (let i = DESC_ANCHOR_LENGTH; i < text.length; i++) {
    hash = (hash - Math.imul(text.charCodeAt(i - DESC_ANCHOR_LENGTH), highPow)) >>> 0;
    hash = (Math.imul(hash, DESC_HASH_BASE) + text.charCodeAt(i)) >>> 0;
    hashes.add(hash);
  }
  return { text, hashes };
}

/**
 * 摘要近重复判定(转载辅助证据,零词表):归一化后公共连续片段 ≥20 字符
 * 且占较短摘要 ≥40%。只回答阈值判定,不计算无用的完整 LCS 长度。
 * 同源转载的引擎摘要(正文首段)高度重叠;不同文章即使同主题摘要也不同。
 */
export function isNearDuplicateDesc(a, b, preparedA = null, preparedB = null) {
  const pa = preparedA || descWindowHashes(a);
  const pb = preparedB || descWindowHashes(b);
  const da = pa.text;
  const db = pb.text;
  if (da.length < 20 || db.length < 20) return false;
  const small = pa.hashes.size <= pb.hashes.size ? pa.hashes : pb.hashes;
  const large = small === pa.hashes ? pb.hashes : pa.hashes;
  let hasAnchor = false;
  for (const hash of small) {
    if (large.has(hash)) {
      hasAnchor = true;
      break;
    }
  }
  if (!hasAnchor) return false;
  const needed = Math.max(20, Math.ceil(Math.min(da.length, db.length) * 0.4));
  return hasCommonSubstringAtLeast(da, db, needed);
}

/** 转载文本证据:标题或摘要任一近重复(与向量余弦组合使用,见 cluster.mjs 预处理) */
export function hasReprintTextEvidence(a, b, preparedA = null, preparedB = null) {
  return isNearDuplicateTitle(a.title, b.title) || isNearDuplicateDesc(a.desc, b.desc, preparedA, preparedB);
}

// ---- 语义建簇(贪心首领聚类) ----

/**
 * 贪心首领聚类(通用):按顺序(引擎排序)遍历,每簇维护增量质心(mean)。
 * 新结果找最近簇:
 *   - 预处理已标记 dup(转载/镜像折叠)→ 计数到最近簇,不参与聚类/展示
 *   - ≥ dupThreshold → 近似重复,折叠计数(d.dup=true 标记已消费)
 *   - ≥ simThreshold → 入簇,更新质心
 *   - 否则 → 自成新簇(单例,后续可能被并入)
 * 顺序敏感性与短语模式相当(都以引擎排序为基准);结果集小(<50)性能无虞。
 * 首次建簇与超大簇二次聚类共用(后者传更高 simThreshold)。
 */
function greedyClusterByCentroid(docs, opts) {
  const clusters = [];
  const addDuplicate = (cluster, doc, representativeIdx = null) => {
    if (!cluster) return;
    doc.duplicateOf = representativeIdx ?? doc.duplicateOf ?? cluster.members[0]?.idx;
    cluster.dups += 1;
    cluster.duplicateMembers.push(doc);
  };
  for (const d of docs) {
    // 预处理已标记的转载/镜像重复(见 cluster.mjs):折叠计数到最近簇,不参与聚类
    if (d.dup) {
      let best = clusters.find((c) => c.members.some((m) => m.idx === d.duplicateOf)) || null;
      let bestSim = 0;
      if (!best) {
        for (const c of clusters) {
          const sim = cosine(d.vec, c.centroid);
          if (sim > bestSim) {
            best = c;
            bestSim = sim;
          }
        }
      }
      addDuplicate(best, d);
      continue;
    }
    let best = null;
    let bestSim = 0;
    for (const c of clusters) {
      const sim = cosine(d.vec, c.centroid);
      if (sim > bestSim) {
        best = c;
        bestSim = sim;
      }
    }
    if (best && bestSim >= opts.dupThreshold) {
      let representative = best.members[0];
      let representativeSim = -Infinity;
      for (const member of best.members) {
        const sim = cosine(d.vec, member.vec);
        if (sim > representativeSim) {
          representative = member;
          representativeSim = sim;
        }
      }
      addDuplicate(best, d, representative?.idx); // 折叠但保留 URL 与代表关系
      d.dup = true;   // 标记已消费,不得再进 uncovered
      continue;
    }
    if (best && bestSim >= opts.simThreshold) {
      const n = best.members.length;
      best.centroid = best.centroid.map((v, i) => (v * n + d.vec[i]) / (n + 1));
      best.members.push(d);
      best.tokens.push(...d.tokens); // 簇标签用各自的 token 集(避免回退全局最高 df 词)
    } else {
      clusters.push({ members: [d], centroid: [...d.vec], dups: 0, duplicateMembers: [], tokens: [...d.tokens] });
    }
  }
  return clusters;
}

/** 重算簇质心(均值;split 单例回收并入后调用) */
function recomputeCentroid(c) {
  const n = c.members.length;
  if (n === 0) return;
  const dim = c.members[0].vec.length;
  const sum = new Array(dim).fill(0);
  for (const d of c.members) for (let k = 0; k < dim; k++) sum[k] += d.vec[k];
  c.centroid = sum.map((v) => v / n);
}

/**
 * 离群检测(完全数据驱动,零固定阈值):簇内每个成员与其余成员的相似度中位数
 * 为"簇内归属度";归属度分布用 IQR 盒须法(fence = Q1 - 1.5×IQR)检测离群者。
 *
 * 动机(实测数据驱动):均值质心内积虚高(27 条主簇成员与质心内积 0.72~0.79,
 * 而 pairwise 0.58~0.81)使固定相似度阈值拆不开离群者;pairwise 归属度分布
 * (生物文章 ~0.7 vs 混入的"死亡细胞"游戏文章 ~0.35)天然分离,IQR 自动适配
 * 当前簇的分布宽窄,零参数。
 */
function detectOutliersByPairwise(members) {
  const n = members.length;
  if (n < 5) return [];
  const medians = members.map((d, i) => {
    const sims = [];
    for (let j = 0; j < n; j++) if (j !== i) sims.push(cosine(d.vec, members[j].vec));
    sims.sort((a, b) => a - b);
    return { i, m: sims[Math.floor(sims.length / 2)] };
  });
  const ms = medians.map((x) => x.m).sort((a, b) => a - b);
  const q1 = ms[Math.floor(ms.length * 0.25)];
  const q3 = ms[Math.floor(ms.length * 0.75)];
  const fence = q1 - 1.5 * (q3 - q1);
  return medians.filter((x) => x.m < fence).map((x) => x.i);
}

/**
 * 文本子主题分组(动态词频,零固定阈值):簇内显著短语(排除泛主题词
 * df ≥ 0.5n —— 占比过半的词是共同主题无区分度),每个成员归属到"它含有的、
 * df 最高的显著短语"组。子主题词由当前结果集词频自然涌现
 * (结果/入门/融资/挑战/游戏/图灵...),不依赖任何固定相似度阈值。
 * 无显著短语、或分组无效(最大组 ≥ 0.85n,内容高度同质无子结构)→ null。
 */
function splitBySubphrase(members) {
  const n = members.length;
  const df = new Map();
  for (const d of members) for (const t of d.tokens) df.set(t, (df.get(t) || 0) + 1);
  const sig = [...df.entries()]
    .filter(([t, c]) => c >= 2 && c <= Math.max(2, Math.floor(n * 0.5)) && t.startsWith("c:"))
    .sort((a, b) => b[1] - a[1]);
  if (sig.length === 0) return null;
  const groups = new Map();
  const ungrouped = [];
  for (const d of members) {
    const best = sig.find(([t]) => d.tokens.has(t)); // 已按 df 降序,首个命中即最高
    if (best) {
      if (!groups.has(best[0])) groups.set(best[0], []);
      groups.get(best[0]).push(d);
    } else {
      ungrouped.push(d);
    }
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.length >= 2) out.push(g); // 2 条的子主题组也保留(融资/入门等小主题)
    else ungrouped.push(...g);
  }
  if (out.length === 0) return null;
  const biggest = out.reduce((m, g) => Math.max(m, g.length), 0);
  if (biggest >= n * 0.85) return null; // 无子结构(内容同质,大簇合理)
  return { groups: out, ungrouped };
}

/** 成员数组列表 → 簇对象列表(重算嵌入质心,供后续递归/展示) */
function makeClusters(groups) {
  return groups.map((g) => {
    const cl = { members: g, centroid: null, dups: 0, duplicateMembers: [], tokens: g.flatMap((d) => [...d.tokens]) };
    recomputeCentroid(cl);
    return cl;
  });
}

/**
 * 超大簇拆分信号(完全数据驱动,零固定阈值):
 *   1. 离群检测(pairwise 归属度 IQR)—— 拆出语义离群者(平安细胞/死亡细胞游戏)
 *   2. 文本子主题分组(动态词频)—— 拆出结果/入门/融资等子主题
 *   3. 无子结构 → 不拆(内容确实同质,大簇是合理的,不做无意义拆分)
 */
function splitBySignals(c) {
  const n = c.members.length;
  const outlierIdx = detectOutliersByPairwise(c.members);
  if (outlierIdx.length > 0 && outlierIdx.length < n) {
    const oset = new Set(outlierIdx);
    return {
      subs: makeClusters([
        c.members.filter((_, i) => oset.has(i)),
        c.members.filter((_, i) => !oset.has(i)),
      ]),
      via: "outlier",
    };
  }
  const sub = splitBySubphrase(c.members);
  if (sub) {
    const all = [...sub.groups, ...sub.ungrouped.map((d) => [d])];
    return { subs: makeClusters(all), via: "phrase" };
  }
  return { subs: [c], via: "none" };
}

/**
 * 超大簇拆分(仅语义模式):簇内成员数 > maxClusterSize 时拆子主题。
 *
 * 设计动机(数据驱动,非调参):大主题查询(如"虚拟细胞大赛"29 条全聚一簇)
 * 共享词命中率高,主阈值建出的簇把结果报道/入门指南/产业融资/无关条目
 * (平安细胞)混在一起。拆分信号见 splitBySignals:
 *   - 语义离群者 → pairwise 归属度 IQR 检测,自动拆出
 *   - 子主题 → 当前结果集词频涌现的显著短语,成员按最高 df 短语分组
 *   - 无子结构 → 不拆(大簇即同质内容,强行拆分反而碎片化)
 * 递归拆分直到无簇 > maxClusterSize(深度受限防退化)。
 */
function splitOversized(rawClusters, opts, depth = 0) {
  if (depth >= opts.maxSplitDepth) return rawClusters;
  const out = [];
  for (const c of rawClusters) {
    if (c.members.length <= opts.maxClusterSize) { out.push(c); continue; }
    const { subs, via } = splitBySignals(c);
    if (via === "none") { out.push(c); continue; }
    // 重复项跟随其代表成员进入子簇;旧状态只有计数时才回退到最大子簇。
    const biggest = subs.sort((a, b) => b.members.length - a.members.length)[0];
    for (const duplicate of c.duplicateMembers || []) {
      const target = subs.find((s) => s.members.some((m) => m.idx === duplicate.duplicateOf)) || biggest;
      if (target) {
        target.dups += 1;
        target.duplicateMembers.push(duplicate);
      }
    }
    const untracked = Math.max(0, (c.dups || 0) - (c.duplicateMembers?.length || 0));
    if (biggest) biggest.dups += untracked;
    for (const s of subs) out.push(...splitOversized([s], opts, depth + 1));
  }
  return out;
}

/**
 * UPGMA 平均链接层次聚类(语义桶合并):把语义模式下拆剩的单例簇合并成桶。
 *
 * 动机(实测数据驱动):超大簇拆分后仍有大量单例(如"虚拟细胞大赛"13 个),
 * 它们文本上不共享显著短语但语义同属一类(融资/方案解读/官方站),agent 阅读
 * 时要逐条扫。嵌入 pairwise 有区分度(同桶 0.64~0.71),但均值质心内积虚高
 * (0.72~0.79)使固定阈值合并不稳 → 用 pairwise + 平均链接 + 数据驱动截止。
 *
 * 截止:
 *   - 绝对下限:合并高度必须 ≥ 当前后端 simThreshold,防正余弦基线强制合并无关项
 *   - 分布下限:同时必须 ≥ 单例集合 pairwise 的 Q3(75 分位)
 *   - 相对截断:在 ≥ Q3 的合并序列里找最大 gap,之后的合并放弃(桶内合并高度
 *     高、桶间合并高度低,最大跳变即自然分界)
 *   - 平均链接(桶间相似度 = 两桶成员 pairwise 均值)防单链接链式污染
 *   - 桶规模 ≤ maxBucketSize(超出禁止该对合并,防一桶吞下所有)
 *
 * @param {number} n 成员数
 * @param {number[][]} sim pairwise 余弦相似度矩阵
 * @param {number} maxBucketSize 桶规模上限
 * @returns {number[][]} 桶(每桶为成员索引数组;含未合并的单例桶)
 */
function upgmaBuckets(n, sim, maxBucketSize, minSimilarity) {
  if (n < 2) return Array.from({ length: n }, (_, i) => [i]);
  // 第一遍:完整合并,记录每步相似度(带规模约束)
  const heights = [];
  simulateUpgma(n, sim, n - 1, maxBucketSize, heights);
  // 数据驱动截止 + 绝对语义底线。仅用 Q3 时,三个余弦都为正的无关单例也会
  // 被强制合并最高的一对;minSimilarity 复用当前嵌入后端的主聚类阈值。
  const all = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) all.push(sim[i][j]);
  all.sort((a, b) => a - b);
  const q3 = all[Math.floor(all.length * 0.75)];
  const minHeight = Math.max(minSimilarity, q3);
  let cut = heights.length;
  while (cut > 0 && heights[cut - 1] < minHeight) cut--;
  let maxGap = 0, gapCut = cut;
  for (let i = 0; i < cut - 1; i++) {
    const gap = heights[i] - heights[i + 1];
    if (gap > maxGap) { maxGap = gap; gapCut = i + 1; }
  }
  // 第二遍:只执行前 cut 步(与第一遍同逻辑,结果一致)
  return simulateUpgma(n, sim, gapCut, maxBucketSize, null).map((c) => [...c.ids]);
}

/** 模拟 UPGMA 合并 steps 步;heights 非 null 时记录每步合并相似度 */
function simulateUpgma(n, sim, steps, maxBucketSize, heights) {
  let clusters = Array.from({ length: n }, (_, i) => ({ ids: new Set([i]), size: 1 }));
  const D = sim.map((row) => [...row]);
  let merged = 0;
  while (merged < steps) {
    let bi = -1, bj = -1, best = -1;
    for (let i = 0; i < clusters.length; i++)
      for (let j = i + 1; j < clusters.length; j++)
        if (D[i][j] > best) { best = D[i][j]; bi = i; bj = j; }
    if (best <= 0) break; // 无正相似度,停止
    const a = clusters[bi], b = clusters[bj];
    if (a.size + b.size > maxBucketSize) {
      D[bi][bj] = -1; D[bj][bi] = -1; // 规模超限,禁止这对
      continue;
    }
    if (heights) heights.push(best);
    const na = a.size + b.size;
    for (let k = 0; k < clusters.length; k++) {
      if (k === bi || k === bj) continue;
      D[bi][k] = D[k][bi] = (a.size * D[bi][k] + b.size * D[bj][k]) / na;
    }
    a.ids = new Set([...a.ids, ...b.ids]);
    a.size = na;
    clusters.splice(bj, 1);
    for (let k = 0; k < clusters.length; k++) D[k].splice(bj, 1);
    D.splice(bj, 1);
    merged++;
  }
  return clusters;
}

/**
 * 单例语义桶合并:把单例簇(pairwise 相关)合并成小桶(≤ maxBucketSize)。
 * 仅合并语义模式拆剩下的单例;桶内成员共享嵌入语义(融资/方案解读/官方站等),
 * 桶名走 readableClusterLabel(桶内共享短语/回退)。截止见 upgmaBuckets。
 */
function bucketSingletons(clusters, maxBucketSize, minSimilarity) {
  const singles = clusters.filter((c) => c.members.length === 1);
  // n < 3 无统计意义(Q3 退化:两个值里的"最大值"必 ≥ Q3,低相似度也会被强制合并);
  // 2 个单例保持独立展示,由 relevance 层按语义分定级
  if (singles.length < 3) return clusters;
  const items = singles.map((c) => c.members[0]);
  const sim = cosineMatrix(items.map((d) => d.vec));
  const buckets = upgmaBuckets(items.length, sim, maxBucketSize, minSimilarity);
  const multi = clusters.filter((c) => c.members.length > 1);
  if (buckets.length === singles.length) return clusters; // 无桶产生
  const out = [...multi];
  for (const b of buckets) {
    if (b.length === 1) {
      out.push(singles[b[0]]); // 未归桶单例保持原样
      continue;
    }
    const members = b.map((i) => items[i]);
    const sourceClusters = b.map((i) => singles[i]);
    const duplicateMembers = sourceClusters.flatMap((c) => c.duplicateMembers || []);
    const cl = {
      members,
      centroid: null,
      dups: sourceClusters.reduce((sum, c) => sum + (c.dups || 0), 0),
      duplicateMembers,
      tokens: members.flatMap((d) => [...d.tokens]),
    };
    recomputeCentroid(cl);
    out.push(cl);
  }
  return out;
}

/**
 * 语义建簇:贪心首领聚类 + 超大簇拆分 + 单例语义桶合并(见对应函数)。
 */
export function buildSemantic(docs, opts) {
  let clusters = splitOversized(greedyClusterByCentroid(docs, opts), opts);
  if (opts.bucketSingletons) clusters = bucketSingletons(clusters, opts.maxBucketSize, opts.simThreshold);
  return clusters;
}
