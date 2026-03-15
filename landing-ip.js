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
 *   "showIsp": "true",
 *   "showCity": "false",
 *   "failTag": "❌落地失败",
 *   "keepFlag": "true"
 * }
 */

const {
  rename = "true",
  position = "suffix",
  concurrency = "12",
  timeout = "12000",
  cacheHours = "24",
  engine = "http-meta",
  allowNodeFallback = "false",
  cleanupOnSkip = "true",
  httpMetaUrl = "http://127.0.0.1:9876",
  httpMetaProxyHost = "",
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
const NODE_AVAILABLE_FIELD = "_node_available";
const FLAG_OPERATOR_TW_MODE = "ws";

async function operator(proxies = []) {
  const c = toPositiveInt(concurrency, 6);
  const t = toPositiveInt(timeout, 8000);
  const ttlMs = Math.max(1, toPositiveInt(cacheHours, 24)) * 3600 * 1000;
  const doRename = String(rename) !== "false";
  const doCleanupOnSkip = String(cleanupOnSkip) !== "false";
  const useIsp = String(showIsp) !== "false";
  const useCity = String(showCity) === "true";
  const retainFlag = String(keepFlag) !== "false";
  const enableNodeFallback = String(allowNodeFallback) === "true";
  let mode = String(engine).toLowerCase();
  if (mode === "node" && !enableNodeFallback) {
    $.error("landing-ip: engine=node 默认禁用，已跳过（避免本机出口误判）");
    if (doRename && doCleanupOnSkip) {
      cleanupLandingTags(proxies);
    }
    return proxies;
  }
  let metaCtx = null;
  if (mode !== "node") {
    try {
      metaCtx = await startHttpMetaBatch(proxies, t);
    } catch (err) {
      $.error(
        `landing-ip http-meta unavailable (${httpMetaUrl}): ${extractError(err)}`
      );
      if (!enableNodeFallback) {
        $.error("landing-ip: 未启用 allowNodeFallback，已跳过探测");
        if (doRename && doCleanupOnSkip) {
          cleanupLandingTags(proxies);
        }
        return proxies;
      }
      $.error("landing-ip: allowNodeFallback=true，回退 engine=node，结果可能是本机出口");
      mode = "node";
    }
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
      await tryStopMeta(metaCtx);
    }
  }
  return proxies;
}

async function probeOne(proxy, opts) {
  if (!isNodeAvailable(proxy)) {
    return;
  }

  const cacheKey = getCacheKey(proxy);
  const cached = getCache(cacheKey, opts.ttlMs);
  if (cached) {
    applyProbeResult(proxy, cached, opts);
    return;
  }

  let reachedByProxy = false;
  try {
    const node = buildNodeDescriptor(proxy);
    const resp = await queryLanding(proxy, opts, node);
    reachedByProxy = true;
    // A successful outbound request means the node path is reachable, even if geo API payload is malformed.
    setNodeAvailable(proxy, true);
    const result = parseGeoResponse(resp.body);
    if (!result.ip) {
      throw new Error("落地 IP 查询失败: 返回数据不完整");
    }

    setCache(cacheKey, result, opts.ttlMs);
    applyProbeResult(proxy, result, opts);
  } catch (err) {
    // Mark unavailable only when probe path is unreachable.
    // Geo API format/rate-limit issues should not downgrade node availability.
    const errorText = extractError(err);
    if (!reachedByProxy) {
      setNodeAvailable(proxy, false);
    }
    proxy._landing_ip = "";
    proxy._landing_country_code = "";
    proxy._landing_country = "";
    proxy._landing_city = "";
    proxy._landing_isp = "";
    proxy._landing_error = errorText;
    if (opts.doRename) {
      proxy.name = await buildLandingFailureName(proxy);
    }
    $.error(`landing-ip ${proxy.name}: ${proxy._landing_error}`);
  }
}

function applyProbeResult(proxy, result, opts) {
  setNodeAvailable(proxy, true);
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
  const cleanName = removeNameFlags(removeLandingTag(proxy.name));
  if (String(position).toLowerCase() === "prefix") {
    proxy.name = `${landingText} ${cleanName}`.trim();
  } else {
    proxy.name = `${cleanName} ${landingText}`.trim();
  }
}

function buildNodeDescriptor(proxy) {
  // Try common targets to maximize compatibility across different sub-store runtimes.
  const candidates = ["ClashMeta", "Clash", "Loon", "Surge"];
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
  const proxyCandidates = getHttpMetaProxyCandidates(proxyPort, ctx.base);
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
  const candidates = getHttpMetaCandidates(base);
  let lastErr = null;
  for (const candidate of candidates) {
    try {
      const started = await $.http.post({
        url: `${candidate}/start`,
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
        base: candidate,
      };
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error("http-meta 启动失败");
}

function getHttpMetaCandidates(base) {
  const out = [base];
  try {
    const u = new URL(base);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") {
      u.hostname = "host.docker.internal";
      out.push(String(u).replace(/\/+$/, ""));
    }
  } catch (_) {
    // ignore
  }
  return Array.from(new Set(out));
}

async function tryStopMeta(metaCtxOrPid) {
  if (!metaCtxOrPid) return;
  const pid =
    typeof metaCtxOrPid === "object" ? metaCtxOrPid.pid : metaCtxOrPid;
  const base =
    typeof metaCtxOrPid === "object" && metaCtxOrPid.base
      ? String(metaCtxOrPid.base).replace(/\/+$/, "")
      : String(httpMetaUrl || "").replace(/\/+$/, "");
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

function getHttpMetaProxyCandidates(proxyPort, baseUrl) {
  const hosts = [];
  const overrideHost = String(httpMetaProxyHost || "").trim();
  if (overrideHost) {
    hosts.push(overrideHost);
  }
  try {
    const u = new URL(String(baseUrl || ""));
    if (u.hostname) {
      hosts.push(u.hostname);
    }
  } catch (_) {
    // ignore
  }
  hosts.push("127.0.0.1", "localhost");
  const uniqHosts = Array.from(new Set(hosts.filter(Boolean)));
  const out = [];
  for (const h of uniqHosts) {
    out.push(`socks5://${h}:${proxyPort}`);
    out.push(`http://${h}:${proxyPort}`);
  }
  return out;
}

function removeLandingTag(name) {
  return String(name || "")
    .replace(/\s*\[落地[^\]]*\]\s*/g, " ")
    .replace(/\s*❌落地失败\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function buildLandingFailureName(proxy) {
  const cleanName = removeNameFlags(removeLandingTag(proxy && proxy.name));
  const flaggedName = await tryApplyBuiltinFlagName(proxy, cleanName);
  const baseName = flaggedName || cleanName;
  if (!failTag) return baseName;
  return `${baseName} ${failTag}`.trim();
}

async function tryApplyBuiltinFlagName(proxy, name) {
  if (!ProxyUtils || typeof ProxyUtils.process !== "function") {
    return "";
  }

  try {
    const processed = await ProxyUtils.process(
      [{ ...sanitizeProxy(proxy), name }],
      [{ type: "Flag Operator", args: { mode: "add", tw: FLAG_OPERATOR_TW_MODE } }],
      "JSON"
    );
    const flaggedName =
      Array.isArray(processed) &&
      processed[0] &&
      typeof processed[0].name === "string"
        ? processed[0].name.trim()
        : "";
    if (!flaggedName || !hasFlagEmoji(flaggedName)) {
      return "";
    }
    if (extractLeadingFlag(flaggedName) === "🏴‍☠️") {
      return "";
    }
    return flaggedName;
  } catch (_) {
    return "";
  }
}

function cleanupLandingTags(proxies) {
  if (!Array.isArray(proxies)) return;
  for (const proxy of proxies) {
    if (!proxy || typeof proxy !== "object") continue;
    proxy.name = removeLandingTag(proxy.name || "");
  }
}

function removeNameFlags(name) {
  return String(name || "")
    .replace(/(?:[\u{1F1E6}-\u{1F1FF}]{2}|🏴‍☠️)\s*/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getFlagEmoji(countryCode) {
  const cc = safeUpper(countryCode);
  if (!/^[a-zA-Z]{2}$/.test(cc)) return "";
  if (cc === "TW") {
    if (FLAG_OPERATOR_TW_MODE === "ws") return "🇼🇸";
    if (FLAG_OPERATOR_TW_MODE === "tw") return "🇹🇼";
    return "🇨🇳";
  }
  const codePoints = cc
    .split("")
    .map((c) => 127397 + c.charCodeAt());
  return String.fromCodePoint(...codePoints);
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
      countryCode: safeUpper(data.countryCode),
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
      countryCode: safeUpper(data.country_code),
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
      countryCode: safeUpper(data.country_code),
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

function safeUpper(value) {
  try {
    return String(value ?? "").toUpperCase();
  } catch (_) {
    return "";
  }
}

function hasFlagEmoji(name) {
  return /[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]|🏴‍☠️|🏳️‍🌈/.test(
    String(name || "")
  );
}

function extractLeadingFlag(name) {
  const matched = String(name || "").match(
    /^(?:[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]|🏴‍☠️|🏳️‍🌈)/
  );
  return matched ? matched[0] : "";
}

function isNodeAvailable(proxy) {
  if (!proxy || typeof proxy !== "object") return true;
  const v = proxy[NODE_AVAILABLE_FIELD];
  if (v === undefined || v === null || v === "") return true;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (!s) return true;
  return !["0", "false", "no", "off", "down", "unavailable", "disabled"].includes(s);
}

function setNodeAvailable(proxy, available) {
  if (!proxy || typeof proxy !== "object") return;
  proxy[NODE_AVAILABLE_FIELD] = Boolean(available);
}
