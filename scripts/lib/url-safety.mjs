/** Validation for user-supplied page fetch targets. */
import { isIP } from "node:net";

export const UNSAFE_URL_CODE = "ERR_WEBSEARCH_UNSAFE_URL";

function unsafe(message) {
  const error = new Error(`拒绝抓取不安全 URL: ${message}`);
  error.code = UNSAFE_URL_CODE;
  return error;
}

function isNonPublicIpv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function isNonPublicIpv6(address) {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  const first = value.startsWith("::") ? 0 : Number.parseInt(value.split(":", 1)[0], 16);
  // Public IPv6 unicast currently occupies 2000::/3. This also rejects loopback,
  // ULA/link-local, multicast, IPv4-mapped forms, and other reserved ranges.
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return true;
  return value.startsWith("2001:db8:"); // documentation range
}

export function isNonPublicIp(address) {
  const version = isIP(String(address || "").replace(/^\[|\]$/g, ""));
  if (version === 4) return isNonPublicIpv4(address);
  if (version === 6) return isNonPublicIpv6(address);
  return false;
}

/** Parse and normalize a user target, rejecting local resources and non-web schemes. */
export function validateFetchUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw unsafe("URL 格式无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw unsafe(`仅允许 http/https 协议(${url.protocol || "无协议"})`);
  }
  if (url.username || url.password) throw unsafe("不允许 URL 内嵌用户名或密码");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) throw unsafe(`本地主机 ${host}`);
  if (isNonPublicIp(host)) throw unsafe(`非公网地址 ${host}`);
  return url.href;
}
