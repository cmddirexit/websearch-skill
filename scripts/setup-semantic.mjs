#!/usr/bin/env node
/**
 * setup-semantic.mjs — 一键启用语义嵌入层(Termux/Android 与桌面通用)
 *
 * 为什么需要它:transformers.js 硬依赖 onnxruntime-node(原生 glibc 库),
 * 在 Termux(platform=android)上 npm 平台校验直接拒绝(EBADPLATFORM,无 android 预编译),
 * 常规 `npm i @huggingface/transformers` 会失败。本脚本绕开:
 *   1. 只安装可用的 WASM 后端依赖:tokenizers/jinja/onnxruntime-web/onnxruntime-common
 *      (onnxruntime-node 由 embed.mjs 的 registerHooks 重定向到 onnxruntime-web,
 *       sharp 由空 shim 替代 —— embedding 路径用不到它们)
 *   2. npm pack 拿 transformers 本体 → 手动放入 node_modules(不触发其依赖解析)
 *   3. 动态 import 验证
 *
 * ⚠️ 顺序:先装 npm 依赖、后手动放包(npm i 会清理非 npm 管理的目录);
 *    幂等,可重跑(若在技能目录跑过别的 npm i 把包清掉,重跑本脚本即可)。
 *
 * 用法:
 *   cd ~/.pi/agent/skills/websearch && npm run setup:semantic
 *
 * 模型在首次搜索时自动下载(Xenova/bge-small-zh-v1.5 ~95MB,缓存于
 * node_modules/@huggingface/transformers/.cache/,可删缓存释放空间)。
 */

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TF_DIR = path.join(SKILL_DIR, "node_modules/@huggingface/transformers");
const require_ = createRequire(path.join(SKILL_DIR, "package.json"));

function sh(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, {
    cwd: SKILL_DIR,
    stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    maxBuffer: 64 * 1024 * 1024,
  });
}
function shCapture(cmd) {
  return sh(cmd, { capture: true }).toString();
}
function pkgExists(name) {
  try {
    require_.resolve(name);
    return true;
  } catch {
    return false;
  }
}

// 可安装的 WASM 后端依赖(onnxruntime-node/sharp 故意不装,由 embed.mjs hooks 处理)
const WASM_DEPS = ["@huggingface/tokenizers", "@huggingface/jinja", "onnxruntime-web", "onnxruntime-common"];

console.log("== 语义嵌入层安装(websearch) ==");

// 1. 先装 WASM 后端依赖(npm 管理,不被清理)
const missing = WASM_DEPS.filter((d) => !pkgExists(d));
if (missing.length === 0) {
  console.log("步骤 1/3: WASM 后端依赖已齐全,跳过");
} else {
  console.log("步骤 1/3: 安装 WASM 后端依赖...");
  // 版本要求:若能读到 transformers 的依赖声明则对齐,否则 latest
  let specs = missing.map((d) => `${d}@latest`).join(" ");
  try {
    const tfPkg = JSON.parse(readFileSync(path.join(TF_DIR, "package.json"), "utf8"));
    if (tfPkg.dependencies) specs = missing.map((d) => `${d}@${tfPkg.dependencies[d]}`).join(" ");
  } catch { /* transformers 尚未放置,用 latest */ }
  sh(`npm i --no-save ${specs}`);
}

// 2. transformers 本体:pack + 手动放置(放在 npm i 之后,避免被清理)
if (existsSync(path.join(TF_DIR, "package.json"))) {
  console.log("步骤 2/3: @huggingface/transformers 已存在,跳过");
} else {
  console.log("步骤 2/3: 获取 @huggingface/transformers(npm pack,不触发依赖解析)...");
  const out = shCapture("npm pack @huggingface/transformers@latest --pack-destination ./node_modules");
  const tgz = out.trim().split(/\s+/).filter((l) => l.endsWith(".tgz")).pop();
  if (!tgz) throw new Error("npm pack 未返回 tgz 文件名: " + out);
  mkdirSync(TF_DIR, { recursive: true });
  sh(`tar -xzf "${path.join(SKILL_DIR, "node_modules", tgz)}" -C "${TF_DIR}" --strip-components=1`);
  rmSync(path.join(SKILL_DIR, "node_modules", tgz));
  console.log(`   → 已放置到 ${TF_DIR}`);
}

// 3. 快速自检:注册 hooks 后能否加载 transformers(不下载模型)
console.log("\n步骤 3/3: 加载自检(不下载模型)...");
const check = `
(async () => {
  const { registerHooks } = await import("node:module");
  const entry = import.meta.resolve("onnxruntime-web");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "onnxruntime-node") return { url: entry, shortCircuit: true };
      if (specifier === "sharp") return { url: "data:text/javascript,export default {};", shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  const tf = await import("@huggingface/transformers");
  console.log("[ok] transformers.js 可加载,版本:", tf.env.version);
  console.log("[ok] onnxruntime-web →", entry);
})().catch((e) => { console.error("[fail]", e.message.split("\\n")[0]); process.exit(1); });
`;
try {
  execSync(`node --input-type=module -e "${check.replace(/"/g, '\\"')}"`, { cwd: SKILL_DIR, stdio: "inherit", maxBuffer: 16 * 1024 * 1024 });
} catch {
  console.error("\n❌ 加载自检失败,语义层不可用(自动降级短语聚类,主流程不受影响)");
  process.exit(1);
}

console.log(`
✅ 语义嵌入层就绪!下次搜索自动启用(嵌入不可用时静默回退短语聚类)。
   模型默认 Xenova/bge-small-zh-v1.5(~95MB,首次搜索时自动下载到
   node_modules/@huggingface/transformers/.cache/,之后秒级加载)。
   中英混合: export WEBSEARCH_EMBED_MODEL=Xenova/multilingual-e5-small WEBSEARCH_SIM_THRESHOLD=0.8
   关闭:   搜索时加 --no-semantic,或 export WEBSEARCH_EMBED_BACKEND=off
   磁盘:   ~/.pi/agent/skills/websearch/node_modules/@huggingface/transformers/.cache/
`);
