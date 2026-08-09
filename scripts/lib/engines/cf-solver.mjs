/**
 * engines/cf-solver.mjs — Cloudflare Turnstile 自动求解(独立模块)
 *
 * 从 browser.mjs 拆出:CF 求解是独立关注点(识别挑战类型 → 定位复选框 →
 * 拟人点击 → 轮询检测),不依赖浏览器启动管理,可单独复用/测试。
 * 思路移植自 Scrapling StealthyFetcher 的 _cloudflare_solver。
 *
 * 注意:仅库模式(page 对象可交互)可用;CLI 模式无鼠标/page,维持
 * virtual-time-budget 方案(见 browser.mjs getDomViaCli)。
 */

/** CF 挑战 iframe 的 URL 特征(Scrapling __CF_PATTERN__ 同款) */
const CF_PATTERN = /^https?:\/\/challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform\/.*/;
/** CF 挑战未通过的标志性标题 */
const CF_JUST_A_MOMENT = /<title>Just a moment\.\.\.<\/title>/;
/** 求解总预算(超过即放弃,防拖慢降级链/聚合) */
const CF_SOLVE_BUDGET_MS = 20_000;

/**
 * 检测页面 HTML 中的 Cloudflare 挑战类型(纯函数,可单测)。
 * @returns {'non-interactive'|'managed'|'interactive'|'embedded'|null}
 */
export function detectCloudflareChallenge(html) {
  if (!html) return null;
  if (/cType: 'non-interactive'/.test(html)) return "non-interactive";
  if (/cType: 'managed'/.test(html)) return "managed";
  if (/cType: 'interactive'/.test(html)) return "interactive";
  if (/script[^>]*src="[^"]*challenges\.cloudflare\.com\/turnstile\/v/i.test(html)) return "embedded";
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等待网络空闲(puppeteer 有 waitForNetworkIdle,playwright 用 load_state networkidle) */
async function waitForNetworkIdle(page, timeoutMs = 5000) {
  try {
    if (typeof page.waitForNetworkIdle === "function") {
      await page.waitForNetworkIdle({ idleTime: 500, timeout: timeoutMs });
    } else {
      await page.waitForLoadState("networkidle", { timeout: timeoutMs });
    }
  } catch {
    /* 超时/不支持则忽略 */
  }
}

/** 轮询检测 CF 挑战是否已通过(标题不再是 "Just a moment...") */
async function cfChallengePassed(page) {
  try {
    const c = await page.content();
    return !CF_JUST_A_MOMENT.test(c);
  } catch {
    return false;
  }
}

/** 找 CF 挑战 iframe(puppeteer/playwright 的 page.frames() 都有) */
function findCfFrame(page) {
  try {
    return page.frames().find((f) => CF_PATTERN.test(f.url())) || null;
  } catch {
    return null;
  }
}

/** 取元素盒(puppeteer boundingBox / playwright bounding_box 兼容) */
async function elementBox(el) {
  if (!el) return null;
  try {
    if (typeof el.boundingBox === "function") return await el.boundingBox();
    if (typeof el.bounding_box === "function") return await el.bounding_box();
  } catch {
    /* 元素已分离等 */
  }
  return null;
}

/**
 * Cloudflare Turnstile/Interstitial 自动求解。
 * 先检测再动手:页面无挑战特征时零开销直接返回。
 * - non-interactive:纯等待,Turnstile 自动验证后页面自行跳转
 * - interactive/managed/embedded:定位复选框 → 拟人点击 → 轮询检测,最多 3 轮
 */
export async function solveCloudflareChallenge(page, budgetMs = CF_SOLVE_BUDGET_MS) {
  let html;
  try {
    html = await page.content();
  } catch {
    return;
  }
  const ctype = detectCloudflareChallenge(html);
  if (!ctype) return;
  const deadline = Date.now() + budgetMs;
  await waitForNetworkIdle(page, 5000);

  if (ctype === "non-interactive") {
    // 纯等待:倒计时结束后自动跳转,最多等 20s(预算内)
    while (Date.now() < deadline) {
      if (await cfChallengePassed(page)) return;
      await sleep(1000);
    }
    return;
  }

  // interactive / managed / embedded:定位 + 拟人点击
  for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
    const frame = findCfFrame(page);
    let box = null;
    if (frame) {
      try {
        await waitForNetworkIdle(frame, 3000);
        const fe = await frame.frameElement();
        box = await elementBox(fe);
      } catch {
        /* iframe 不可用则走 CSS 选择器退路 */
      }
    }
    if (!box) {
      // 退路:CSS 选择器定位 Turnstile 容器(Scrapling box_selector 同款)
      try {
        const sel = "#cf_turnstile div, #cf-turnstile div, .turnstile>div>div";
        const loc = await page.$(sel);
        box = await elementBox(loc);
      } catch {
        /* 定位失败,继续 */
      }
    }
    if (!box) {
      // 定位不到:可能 embedded 已自动完成,检查后重试
      if (await cfChallengePassed(page)) return;
      await sleep(1000);
      continue;
    }
    // 拟人点击:坐标略偏中心(Scrapling randint(26,28)/randint(25,27) 同款)+ 按下延迟
    const x = box.x + 26 + Math.floor(Math.random() * 3);
    const y = box.y + 25 + Math.floor(Math.random() * 3);
    try {
      await page.mouse.click(x, y, { delay: 100 + Math.floor(Math.random() * 100) });
    } catch {
      /* 点击失败,继续 */
    }
    await waitForNetworkIdle(page, 5000);
    // 轮询检测通过(最多 ~10s)
    while (Date.now() < deadline) {
      if (await cfChallengePassed(page)) return;
      await sleep(100);
    }
  }
}
