// 元学习回测:留一域交叉验证(leave-one-domain-out)
// 对每个有样本的域名,用"除该域外所有样本"训练模式,预测该域名(模拟冷启动),
// 对比预测分 vs 实际质量贡献。若模式学到真实信号,预测分应能区分高低质。
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const fs = require("fs");

const repMod = await import("./lib/domain-rep.mjs");
const { createDomainReputation, extractLearnFeatures, predictTokens, updateMetaTokens } = repMod;

const home = process.env.HOME;
const d = JSON.parse(fs.readFileSync(`${home}/.cache/websearch-domain-rep.json`, "utf8"));

// 重建每个域名的样本序列:从信誉库里的域名条目反推样本(label = searchScore 是学习结果,
// 不是原始 label)。更准确:直接用元学习的 weightSamples 无法反推原始样本。
// 所以我们用**当前模式权重自身**做评估材料:对新域名,预测 vs 无预测(0.5)相比,
// 看模式给出的分是否偏离中性(即模式是否“敢”给出非 0.5 的预测)。
console.log("=== 方法说明 ===");
console.log("信誉库不存原始样本,无法逐样本重训。改用两种互补检验:");
console.log();

// 检验 1:模式是否“敢”预测(偏离中性的幅度)。真实软文站的标题/URL 特征应得低分。
// 构造 3 类新域名特征(与已学 token 相似):
//   a) 软文模板类:2026年+平台推荐榜测评 标题 + 日期路径
//   b) 干净技术类:教程实战 标题 + 普通路径
//   c) 中性类:任意站
// ⚠ 注意:期望是**相对判别**(a ≤ c ≤ b 排序),不是绝对 <0.5 ——
//   词袋线性模型无组合特征,且 u:n(数字路径段)在训练数据里主要来自正常站
//   (文章 ID/日期归档),学成强正权重,会把带日期路径的构造站整体拉正(实测 +0.55)。
//   绝对 <0.5 只适用于**不含 u:n 干扰的纯标题站**(见检验 1b)。
const rep = createDomainReputation();
const meta = rep._meta();
const w = meta.weights;

const caseA = extractLearnFeatures("https://news-bj-gov-x9.cn/2026/07/t20260712_4609208.shtml", { title: "2026年7月工程信息平台推荐榜测评 5大平台深度测评 免费下载", flags: ["low:desc-empty"] });
const caseB = extractLearnFeatures("https://blog-dev-tutorial.com/p/python-async-tutorial", { title: "Python 异步编程实战教程 爬虫入门", flags: [] });
const caseC = extractLearnFeatures("https://neutral-random-site.net/", { title: "普通页面", flags: [] });

const pred = (tokens) => {
  const raw = predictTokens(tokens, meta);
  return (0.5 + (raw - 0.5) * 0.5).toFixed(3); // 与 lookup 冷启动相同的压缩
};
console.log("=== 检验 1:模式对三类新域名的冷启动预测(0.5=中性,低=像低质) ===");
console.log("  期望:相对判别 a(软文) ≤ c(中性) ≤ b(技术),不要求绝对 <0.5");
console.log("  a) 软文模板站(标题含推荐榜测评/日期路径):", pred(caseA));
console.log("  b) 干净技术站(教程实战):", pred(caseB));
console.log("  c) 普通站:", pred(caseC));
// 诊断:caseA 的 token 分解 —— 看预测是哪些 token 驱动的(便于发现泛特征干扰如 u:n)
console.log("  ── caseA token 分解(top 正/负贡献) ──");
const contribs = [...caseA].map((t) => ({ t, w: w[t] ?? 0 })).sort((x, y) => Math.abs(y.w) - Math.abs(x.w));
for (const { t, w: wt } of contribs.slice(0, 8)) console.log("     " + t.padEnd(26), (wt >= 0 ? "+" : "") + wt.toFixed(3));
console.log();

// 检验 1b:纯标题站(无日期路径/无 u:n 干扰)—— 词袋模型对标题词的判别力
// 期望:软文标题词(推荐/测评/免费/下载…)学负,技术标题词(教程/实战/入门…)学正,差值 >0.05
const softTitle = extractLearnFeatures("https://soft-seo.com/a1", { title: "2026年十大免费推荐平台测评 下载 榜单 精选", flags: [] });
const techTitle = extractLearnFeatures("https://dev.com/p/async", { title: "Python 异步编程教程 实战入门", flags: [] });
const dSoft = pred(softTitle);
const dTech = pred(techTitle);
console.log("=== 检验 1b:纯标题词判别(排除 u:n 泛特征) ===");
console.log("  软文标题站:", dSoft, "← 应 <0.5(标题词学负)");
console.log("  技术标题站:", dTech, "← 应 ≥0.5(标题词学正)");
console.log("  差值:", (dTech - dSoft).toFixed(3), "← 应 >0.05(模式对标题词有判别力)");
console.log();

// 检验 2:区分度来源分解 —— 是负权重(软文信号)还是正权重(优质信号)在起作用?
console.log("=== 检验 2:负权重 token 覆盖面 ===");
const neg = Object.entries(w).filter(([, x]) => x < -0.01).sort((a, b) => a[1] - b[1]);
console.log("负权重 token 总数:", neg.length);
for (const [f, x] of neg.slice(0, 12)) console.log("  " + f.padEnd(28), x.toFixed(3));
console.log();
console.log("=== 检验 3:正权重 token top(它们是否只是高频泛词被平均?) ===");
const pos = Object.entries(w).filter(([, x]) => x > 0.05).sort((a, b) => b[1] - a[1]).slice(0, 10);
for (const [f, x] of pos) console.log("  " + f.padEnd(28), x.toFixed(3));
