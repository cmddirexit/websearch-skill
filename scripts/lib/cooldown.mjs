/**
 * cooldown.mjs — 失败记忆/冷却通用工具
 *
 * 模式:引擎/后端连续失败达阈值 → 进入冷却期,期内直接跳过不再请求;
 * 成功自动清零(恢复即重新参与,不误伤)。可选磁盘持久化:跨 CLI 进程生效,
 * 直连不通的引擎(如 CN 网络下 api.github.com)首次失败后,后续搜索直接跳过。
 *
 * 使用方(三处复用):
 *  - aggregate.mjs  引擎失败记忆:多 key + 持久化(ENGINE_FAIL_FILE)
 *  - embed.mjs      API 嵌入失败记忆:单 key("api")+ 持久化
 *  - sogou.mjs      验证码冷却:单 key + 进程内(会话级,无需持久化)
 *
 * 注意:未冷却但已累计的 fails 计数必须持久化(只存冷却条目会导致跨进程
 * 计数归零、永远达不到阈值 —— 早期 bug 的教训,见 load() 实现)。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * @param {Object} cfg
 * @param {number} [cfg.threshold=2] 连续失败多少次进入冷却
 * @param {number} [cfg.cooldownMs=5*60_000] 冷却时长(ms)
 * @param {string|null} [cfg.file=null] 持久化文件路径;null = 仅进程内
 */
export function createCooldown({ threshold = 2, cooldownMs = 5 * 60_000, file = null } = {}) {
  const state = new Map(); // key → {fails, cooledUntil}

  /** 加载持久化状态(模块创建时执行一次) */
  function load() {
    try {
      if (!file || !existsSync(file)) return;
      const j = JSON.parse(readFileSync(file, "utf8"));
      const now = Date.now();
      for (const [k, v] of Object.entries(j)) {
        if (!v) continue;
        if (v.cooledUntil > now) {
          state.set(k, { fails: v.fails || 0, cooledUntil: v.cooledUntil });
        } else if ((v.fails || 0) > 0) {
          // 未冷却但已累计失败:保留计数跨进程累计(见文件头注释)
          state.set(k, { fails: v.fails || 0, cooledUntil: 0 });
        }
      }
    } catch {
      /* 损坏/无权限:忽略,退化为进程内记忆 */
    }
  }
  load();

  /** 写回磁盘(失败累计/成功清零时调用;写失败不影响主流程) */
  function save() {
    if (!file) return;
    try {
      const j = {};
      for (const [k, v] of state) j[k] = v;
      writeFileSync(file, JSON.stringify(j));
    } catch {
      /* 忽略 */
    }
  }

  return {
    /** 冷却期内 → true;过期条目自动清理 */
    isCooled(key) {
      const s = state.get(key);
      if (!s) return false;
      if (s.cooledUntil && Date.now() < s.cooledUntil) return true;
      if (s.cooledUntil && Date.now() >= s.cooledUntil) state.delete(key); // 过期清理
      return false;
    },
    /** 记录成败:成功清零;失败累计,达阈值进入冷却。返回更新后的状态 */
    mark(key, ok) {
      const s = state.get(key) || { fails: 0, cooledUntil: 0 };
      if (ok) {
        s.fails = 0;
        s.cooledUntil = 0;
      } else {
        s.fails++;
        if (s.fails >= threshold) {
          s.cooledUntil = Date.now() + cooldownMs;
          s.fails = 0; // 冷却期内不再累计
        }
      }
      state.set(key, s);
      save();
      return s;
    },
    /** 直接设置冷却(如 sogou 触发验证码时精确设置时长);ms<=0 清除 */
    setCooldown(key, ms) {
      const s = state.get(key) || { fails: 0, cooledUntil: 0 };
      s.cooledUntil = ms > 0 ? Date.now() + ms : 0;
      state.set(key, s);
      save();
    },
    /** 测试/手动:清空全部状态(含磁盘) */
    reset() {
      state.clear();
      if (file) {
        try { writeFileSync(file, "{}"); } catch { /* 忽略 */ }
      }
    },
  };
}
