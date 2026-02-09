const $ = $substore;

/*
 * Sub-Store Script Operator: Detect landing IP through each proxy node.
 *
 * Suggested args:
 * {
 *   "rename": "true",
 *   "position": "suffix",
 *   "concurrency": "6",
 *   "timeout": "8000",
 *   "cacheHours": "24",
 *   "cleanupCache": "true",
 *   "forceRefresh": "false",
 *   "cacheOnly": "false",
 *   "showIsp": "true",
 *   "showCity": "false",
 *   "failTag": "❌落地失败",
 *   "keepFlag": "true"
 * }
 *
 * Recommended workflow:
 * 1) Daily prefetch task:
 *    forceRefresh=true, rename=false (probe + refresh cache only)
 * 2) Gist sync task:
 *    cacheOnly=true (read cached landing IP, no active probing)
 */

const {
  rename = "true",
  position = "suffix",
  concurrency = "6",
  timeout = "12000",
  cacheHours = "24",
  cleanupCache = "true",
  forceRefresh = "false",
  cacheOnly = "false",
  engine = "http-meta",
  httpMetaUrl = "http://127.0.0.1:9876",
  probeTimeoutMs = "45000",
  startupDelayMs = "250",
  connectRetries = "8",
  retryIntervalMs = "180",
  showIsp = "true",
  showCity = "false",
  keepFlag = "true",
  failTag = "❌落地失败",
  queryUrl = "https://api.ip.sb/geoip",
} = $arguments;

const CACHE_PREFIX = "landing-ip:";

async function operator(proxies = []) {
  const c = toPositiveInt(concurrency, 6);
  const t = toPositiveInt(timeout, 8000);
  const ttlMs = Math.max(1, toPositiveInt(cacheHours, 24)) * 3600 * 1000;
  const shouldCleanupCache = String(cleanupCache) !== "false";
  const doRename = String(rename) !== "false";
  const doForceRefresh = String(forceRefresh) === "true";
  const doCacheOnly = String(cacheOnly) === "true";
  const useIsp = String(showIsp) !== "false";
  const useCity = String(showCity) === "true";
  const retainFlag = String(keepFlag) !== "false";
  const mode = String(engine).toLowerCase();
  if (shouldCleanupCache) {
    cleanupCachePrefix(CACHE_PREFIX);
  }
  let metaCtx = null;
  if (mode !== "node" && !doCacheOnly) {
    metaCtx = await startHttpMetaBatch(proxies, t);
  }

  const queue = proxies.slice();
  const workers = [];
  for (let i = 0; i < Math.min(c, queue.length); i++) {
    workers.push(
      (async () => {
        while (queue.length) {
          const proxy = queue.shift();
          await probeOne(proxy, {
            timeout: t,
            ttlMs,
            doRename,
            doForceRefresh,
            doCacheOnly,
            useIsp,
            useCity,
            retainFlag,
            mode,
            metaCtx,
          });
        }
      })()
    );
  }

  try {
    await Promise.all(workers);
  } finally {
    if (metaCtx && metaCtx.pid) {
      await tryStopMeta(metaCtx.pid);
    }
  }
  return proxies;
}

async function probeOne(proxy, opts) {
  const cacheKey = getCacheKey(proxy);
  const cached = opts.doForceRefresh ? null : getCache(cacheKey, opts.ttlMs);
  if (cached) {
    applyProbeResult(proxy, cached, opts);
    return;
  }

  if (opts.doCacheOnly) {
    proxy._landing_error = "CACHE_MISS";
    $.info(`landing-ip ${proxy.name}: skip probing in cacheOnly mode`);
    return;
  }

  try {
    const node = buildNodeDescriptor(proxy);
    const resp = await queryLanding(proxy, opts, node);
    const result = parseGeoResponse(resp.body);
    if (!result.ip) {
      throw new Error("落地 IP 查询失败: 返回数据不完整");
    }

    setCache(cacheKey, result, opts.ttlMs);
    applyProbeResult(proxy, result, opts);
  } catch (err) {
    proxy._landing_ip = "";
    proxy._landing_country_code = "";
    proxy._landing_country = "";
    proxy._landing_city = "";
    proxy._landing_isp = "";
    proxy._landing_error = extractError(err);
    if (opts.doRename && failTag) {
      proxy.name = `${removeLandingTag(proxy.name)} ${failTag}`.trim();
    }
    $.error(`landing-ip ${proxy.name}: ${proxy._landing_error}`);
  }
}

function applyProbeResult(proxy, result, opts) {
  proxy._landing_ip = result.ip || "";
  proxy._landing_country_code = result.countryCode || "";
  proxy._landing_country = result.country || "";
  proxy._landing_city = result.city || "";
  proxy._landing_isp = result.isp || "";
  proxy._landing_error = "";

  if (!opts.doRename) return;

  const parts = [];
  if (opts.retainFlag && result.countryCode) {
    parts.push(getFlagEmoji(result.countryCode));
  }
  if (result.countryCode || result.country) {
    parts.push(result.countryCode || result.country);
  }
  if (result.ip) {
    parts.push(result.ip);
  }
  if (opts.useCity && result.city) {
    parts.push(result.city);
  }
  if (opts.useIsp && result.isp) {
    parts.push(result.isp);
  }

  const landingText = `[落地 ${parts.join(" | ")}]`;
  const cleanName = removeLandingTag(proxy.name);
  if (String(position).toLowerCase() === "prefix") {
    proxy.name = `${landingText} ${cleanName}`.trim();
  } else {
    proxy.name = `${cleanName} ${landingText}`.trim();
  }
}

function buildNodeDescriptor(proxy) {
  // Try common targets to maximize compatibility across different sub-store runtimes.
  const candidates = ["Surge", "Loon", "ClashMeta", "Clash"];
  for (const target of candidates) {
    try {
      let node = ProxyUtils.produce([proxy], target);
      if (!node || typeof node !== "string") continue;
      if (target === "Loon") {
        const idx = node.indexOf("=");
        if (idx > -1) node = node.substring(idx + 1).trim();
      }
      if (node.trim()) return node.trim();
    } catch (_) {
      // ignore and continue
    }
  }
  return "";
}

async function queryLanding(proxy, opts, node) {
  if (opts.mode === "node") {
    if (!node) {
      throw new Error("无法生成节点描述，通常是节点类型不兼容");
    }
    return $.http.get({
      url: queryUrl,
      timeout: opts.timeout,
      node,
    });
  }

  return queryLandingViaHttpMeta(proxy, opts);
}

async function queryLandingViaHttpMeta(proxy, opts) {
  const ctx = opts.metaCtx;
  if (!ctx || !Array.isArray(ctx.ports)) {
    throw new Error("http-meta 未就绪");
  }
  const idx = ctx.proxies.indexOf(proxy);
  const proxyPort = ctx.ports[idx];
  if (!proxyPort) {
    throw new Error("http-meta 端口映射失败");
  }
  const delay = toPositiveInt(startupDelayMs, 250);
  const retries = toPositiveInt(connectRetries, 8);
  const step = toPositiveInt(retryIntervalMs, 180);
  const proxyCandidates = [
    `socks5://127.0.0.1:${proxyPort}`,
    `socks5://localhost:${proxyPort}`,
  ];
  let lastErr = null;

  await sleep(delay);

  for (let i = 0; i < retries; i++) {
    for (const p of proxyCandidates) {
      try {
        return await $.http.get({
          url: queryUrl,
          timeout: opts.timeout,
          proxy: p,
        });
      } catch (err) {
        lastErr = err;
      }
    }
    await sleep(step);
  }
  throw new Error(
    `http-meta 代理端口连接失败: ${extractError(lastErr)} @${proxyPort}`
  );
}

async function startHttpMetaBatch(proxies, timeoutMs) {
  const base = String(httpMetaUrl || "").replace(/\/+$/, "");
  if (!base) {
    throw new Error("httpMetaUrl 不能为空");
  }
  const normalized = proxies.map((p) => normalizeProxyForMeta(p));
  if (normalized.length !== proxies.length || normalized.some((p) => !p || !p.type)) {
    const bad = normalized.filter((p) => !p || !p.type).length;
    throw new Error(`节点转换失败: ${bad} 个节点无法转换为 ClashMeta`);
  }
  const started = await $.http.post({
    url: `${base}/start`,
    timeout: timeoutMs,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      timeout: toPositiveInt(probeTimeoutMs, 45000),
      proxies: normalized,
    }),
  });

  const payload = JSON.parse(started.body || "{}");
  const ports = Array.isArray(payload.ports) ? payload.ports : [];
  if (!ports.length) {
    throw new Error(`http-meta 启动失败: ${started.body || "无可用端口"}`);
  }

  return {
    pid: payload.pid,
    ports,
    proxies,
  };
}

async function tryStopMeta(pid) {
  const base = String(httpMetaUrl || "").replace(/\/+$/, "");
  if (!base || !pid) return;
  try {
    await $.http.post({
      url: `${base}/stop`,
      timeout: 3000,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pid }),
    });
  } catch (_) {
    // http-meta stop may fail on some builds
  }
}

function sanitizeProxy(proxy) {
  const out = {};
  const keys = Object.keys(proxy || {});
  for (const key of keys) {
    if (key.startsWith("_")) continue;
    out[key] = proxy[key];
  }
  return out;
}

function normalizeProxyForMeta(proxy) {
  // Convert internal proxy schema to ClashMeta-compatible proxy object first.
  // If conversion fails, fallback to sanitized raw object.
  try {
    const text = ProxyUtils.produce(
      [proxy],
      "ClashMeta",
      undefined,
      { "include-unsupported-proxy": true }
    );
    const parsed = parseProducedProxy(text);
    if (parsed) return parsed;
  } catch (_) {
    // fallback below
  }
  return sanitizeProxy(proxy);
}

function parseProducedProxy(text) {
  if (!text || typeof text !== "string") return null;
  // Try YAML first
  try {
    if (ProxyUtils && ProxyUtils.yaml && ProxyUtils.yaml.parse) {
      const y = ProxyUtils.yaml.parse(text);
      if (Array.isArray(y) && y.length && isPlainObject(y[0])) return y[0];
      if (y && Array.isArray(y.proxies) && y.proxies.length) return y.proxies[0];
    }
  } catch (_) {
    // continue
  }
  // Fallback JSON parse
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j) && j.length && isPlainObject(j[0])) return j[0];
    if (j && Array.isArray(j.proxies) && j.proxies.length) return j.proxies[0];
  } catch (_) {
    // ignore
  }
  return null;
}

function removeLandingTag(name) {
  return String(name || "")
    .replace(/\s*\[落地[^\]]*\]\s*/g, " ")
    .replace(/\s*❌落地失败\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getFlagEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) return "";
  const codePoints = countryCode
    .toUpperCase()
    .split("")
    .map((c) => 127397 + c.charCodeAt());
  return String.fromCodePoint(...codePoints).replace(/🇹🇼/g, "🇨🇳");
}

function getCacheKey(proxy) {
  return `${CACHE_PREFIX}${proxy.server}:${proxy.port}:${proxy.type || ""}`;
}

function getCache(key, ttlMs) {
  if (typeof scriptResourceCache === "undefined") return null;
  // Prefer official pattern: write cache with TTL, read directly.
  // ttlMs is kept for backward compatibility with old cache entries.
  let value = scriptResourceCache.get(key);
  if (!value) {
    value = scriptResourceCache.get(key, ttlMs, true);
  }
  if (!value || typeof value !== "object") return null;
  return value;
}

function setCache(key, value, ttlMs) {
  if (typeof scriptResourceCache === "undefined") return;
  scriptResourceCache.set(key, value, ttlMs);
}

function cleanupCachePrefix(prefix) {
  if (typeof scriptResourceCache === "undefined") return;
  try {
    scriptResourceCache._cleanup(prefix);
  } catch (_) {
    // Some runtime builds may not expose _cleanup
  }
}

function toPositiveInt(value, fallback) {
  const n = parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseGeoResponse(body) {
  const data = JSON.parse(body || "{}");

  // ip-api schema
  if (typeof data.status === "string") {
    if (data.status !== "success") {
      throw new Error(data.message || "ip-api 查询失败");
    }
    return {
      ip: data.query || "",
      countryCode: (data.countryCode || "").toUpperCase(),
      country: data.country || "",
      city: data.city || "",
      isp: data.isp || data.org || data.as || "",
      at: Date.now(),
    };
  }

  // ip.sb schema
  if (data.ip || data.country_code || data.country) {
    return {
      ip: data.ip || "",
      countryCode: String(data.country_code || "").toUpperCase(),
      country: data.country || "",
      city: data.city || "",
      isp: data.isp || data.organization || data.asn_organization || "",
      at: Date.now(),
    };
  }

  // ipwho.is schema
  if (Object.prototype.hasOwnProperty.call(data, "success")) {
    if (data.success === false) {
      throw new Error(data.message || "ipwho.is 查询失败");
    }
    return {
      ip: data.ip || "",
      countryCode: String(data.country_code || "").toUpperCase(),
      country: data.country || "",
      city: data.city || "",
      isp: (data.connection && data.connection.isp) || "",
      at: Date.now(),
    };
  }

  return {
    ip: "",
    countryCode: "",
    country: "",
    city: "",
    isp: "",
    at: Date.now(),
  };
}

function extractError(err) {
  if (!err) return "UnknownError";
  if (typeof err === "string") return err;
  if (err.message && err.message !== "Error") return String(err.message);
  if (err.code) return String(err.code);
  try {
    return JSON.stringify(err);
  } catch (_) {
    return String(err);
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
