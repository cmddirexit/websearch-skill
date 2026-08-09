#!/usr/bin/env python3
"""zendriver CF solver — 裸 WebSocket CDP 驱动系统 chromium,直取渲染后 HTML。

背景:Playwright/puppeteer 的 Runtime.enable CDP 泄漏会被 Cloudflare 检测(实测必拿
"Just a moment" 验证页);zendriver 走裸 CDP + 指纹模拟,实测 cell.com/nature.com
3s 内直接拿到真实页面,无需 45-90s 的 CLI 等待轮询。

用法: python3 zd_solver.py <url> [timeout_seconds] [chromium_path]
输出: 单行 JSON {ok, title, html, elapsed, error}

chromium_path 由调用方(node 侧 resolveChromiumPath)动态探测传入,本脚本不硬编码路径,
换设备/换浏览器位置无需改脚本。
"""
import asyncio, json, os, sys, time, shutil, subprocess
import zendriver as zd

CHROME = sys.argv[3] if len(sys.argv) > 3 else "/data/data/com.termux/files/usr/lib/chromium/chrome"  # 兜底(调用方通常显式传入)
PROFILE = f"{os.environ.get('HOME', '/tmp')}/.cache/websearch-zd-profile"


def clean_profile():
    """启动前清理孤儿锁 + 渲染缓存(保留 Cookies/Local State —— 会话凭证)。
    zendriver 进程被外部 kill(SIGKILL/SIGTERM)时 chromium 来不及释放 SingletonLock,
    残留锁会让下次启动卡死等锁(实测 150s 超时)—— 删锁是必要兜底。"""
    for f in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
        try:
            os.remove(os.path.join(PROFILE, f))
        except OSError:
            pass
    # 渲染缓存无会话价值且会膨胀,每次清理;Cookies/Local State 是 cf_clearance 会话,保留
    for d in ("ShaderCache", "GPUCache", "GraphiteDawnCache", "GrShaderCache", "Code Cache"):
        p = os.path.join(PROFILE, d)
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)


async def main(url, wait):
    t0 = time.time()
    clean_profile()
    browser = await zd.start(
        headless=True,
        browser_executable_path=CHROME,
        user_data_dir=PROFILE,
        additional_browser_args=["--no-sandbox", "--disable-dev-shm-usage"],
        log_level=30,
    )
    try:
        page = await browser.get(url)
        # browser.get 只等导航事件(不等 JS 渲染完成,Next.js 等 CSR 站此时还是 Loading 壳);
        # 轮询等待渲染完成:非 CF 验证页(title 非 Just a moment)且正文已出现(壳只有几百字节,
        # 渲染后 >2KB)才取内容。总预算仍受 wait 约束,超时取当前内容兜底。
        while time.time() - t0 < wait:
            title = await page.evaluate("document.title")
            # 渲染完成判定:非 CF 验证页(title 非 Just a moment)且 body 已出现真实正文。
            # ⚠ 不能看 HTML 总长度:Next.js 壳含 20+ script 标签引用,总长也能超 2KB;
            # 壳的 body.innerText 只有几十字节("Loading..."),渲染后才是长文本
            if "Just a moment" not in (title or ""):
                text_len = await page.evaluate("document.body ? document.body.innerText.length : 0")
                if text_len > 500:
                    break
            await page.sleep(3)
        html = await page.get_content()
        title = await page.evaluate("document.title")
        print(json.dumps({
            "ok": True,
            "title": title,
            "html": html,
            "elapsed": round(time.time() - t0, 1),
        }, ensure_ascii=False))
    finally:
        await browser.stop()
        # Termux 实测:zendriver 的 stop 只断开 CDP,chromium 进程树(zygote/renderer)仍残留
        # (12 个孤儿,各占 ~100MB 且锁住共享 profile,下次启动卡死等锁)。
        # 按唯一 profile 路径 pkill 兜底,不影响其他 chromium 实例。
        subprocess.run(["pkill", "-9", "-f", PROFILE], capture_output=True)


if __name__ == "__main__":
    url = sys.argv[1]
    wait = int(sys.argv[2]) if len(sys.argv) > 2 else 60
    try:
        asyncio.run(main(url, wait))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)[:300], "elapsed": 0}))
