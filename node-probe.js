const $ = $substore;

/*
 * Sub-Store Script Operator: Node probe (landing IP + YouTube Premium).
 *
 * Suggested args:
 * {
 *   "checkLanding": "true",
 *   "checkYoutube": "true",
 *   "rename": "true",
 *   "position": "suffix",
 *   "concurrency": "12",
 *   "timeout": "12000",
 *   "cacheHours": "24",
 *   "engine": "http-meta",
 *   "mihomoForSurgeUnsupported": "true",
 *   "httpMetaUrl": "http://127.0.0.1:9876",
 *   "landingQueryUrl": "https://api.ip.sb/geoip",
 *   "youtubeQueryUrl": "https://www.youtube.com/premium"
 * }
 */

const rawArgs = $arguments || {};

const {
  checkLanding = "true",
  checkYoutube = "true",
  rename = "true",
  position = "suffix",
  concurrency = "12",
  timeout = "12000",
  cacheHours = "24",
  engine = "http-meta",
  allowNodeFallback = "false",
  mihomoForSurgeUnsupported = "true",
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
  landingQueryUrl = "",
  youtubeQueryUrl = "",
  queryUrl = "",
  acceptLanguage = "en",
  userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
} = rawArgs;

const LANDING_CACHE_PREFIX = "landing-ip:";
const YT_CACHE_PREFIX = "yt-premium:";
const NODE_AVAILABLE_FIELD = "_node_available";
const DEFAULT_LANDING_QUERY_URL = "https://api.ip.sb/geoip";
const DEFAULT_YOUTUBE_QUERY_URL = "https://www.youtube.com/premium";
const LANDING_QUERY_URL = resolveLandingQueryUrl(landingQueryUrl, queryUrl);
const YOUTUBE_QUERY_URL = resolveYoutubeQueryUrl(youtubeQueryUrl, queryUrl);
const SURGE_SUPPORTED_CACHE = new WeakMap();

async function operator(proxies = []) {
  const c = toPositiveInt(concurrency, 12);
  const t = toPositiveInt(timeout, 12000);
  const ttlMs = Math.max(1, toPositiveInt(cacheHours, 24)) * 3600 * 1000;
  const doRename = String(rename) !== "false";
  const doCleanupOnSkip = String(cleanupOnSkip) !== "false";
  const doCheckLanding = String(checkLanding) !== "false";
  const doCheckYoutube = String(checkYoutube) !== "false";
  const useIsp = String(showIsp) !== "false";
  const useCity = String(showCity) === "true";
  const retainFlag = String(keepFlag) !== "false";
  const enableNodeFallback = String(allowNodeFallback) === "true";
  const useMihomoForUnsupported =
    String(mihomoForSurgeUnsupported) !== "false";
  const unsupportedCount = useMihomoForUnsupported
    ? countSurgeUnsupportedProxies(proxies)
    : 0;
  let mode = String(engine).toLowerCase();
  const blockNodeMode = mode === "node" && !enableNodeFallback;
  if (blockNodeMode && unsupportedCount === 0) {
    $.error("node-probe: engine=node 默认禁用，已跳过（避免本机出口误判）");
    if (doRename && doCleanupOnSkip) {
      cleanupProbeTags(proxies);
    }
    return proxies;
  }
  if (blockNodeMode && unsupportedCount > 0) {
    $.error(
      "node-probe: engine=node 默认禁用，仅对 Surge 不支持协议尝试 Mihomo 探测"
    );
  }

  if (!doCheckLanding && !doCheckYoutube) {
    $.info("node-probe: both checks disabled");
    return proxies;
  }

  let metaCtx = null;
  if (mode !== "node") {
    try {
      metaCtx = await startHttpMetaBatch(proxies, t);
    } catch (err) {
      $.error(
        `node-probe http-meta unavailable (${httpMetaUrl}): ${extractError(err)}`
      );
      if (!enableNodeFallback) {
        $.error("node-probe: 未启用 allowNodeFallback，已跳过探测");
        if (doRename && doCleanupOnSkip) {
          cleanupProbeTags(proxies);
        }
        return proxies;
      }
      $.error("node-probe: allowNodeFallback=true，回退 engine=node，结果可能是本机出口");
      mode = "node";
    }
  }

  // Independent from engine mode:
  // if some proxies are not Surge-compatible, try enabling Mihomo (http-meta) route for them.
  if (!metaCtx && unsupportedCount > 0) {
    try {
      metaCtx = await startHttpMetaBatch(proxies, t);
      $.info(
        `node-probe: 检测到 ${unsupportedCount} 个 Surge 不支持协议，已启用 Mihomo 分流探测`
      );
    } catch (err) {
      $.error(
        `node-probe: Mihomo 分流探测初始化失败 (${httpMetaUrl}): ${extractError(err)}`
      );
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
            doCheckLanding,
            doCheckYoutube,
            useIsp,
            useCity,
            retainFlag,
            mode,
            metaCtx,
            useMihomoForUnsupported,
            blockNodeMode,
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

  const route = buildProbeRoute(proxy, opts);
  if (route.skip) {
    return;
  }

  // Run landing check first.
  if (opts.doCheckLanding) {
    await probeLandingOne(proxy, opts, route);
  }

  // Run YouTube check in the same loop and honor availability from landing stage.
  if (opts.doCheckYoutube && isNodeAvailable(proxy)) {
    await probeYoutubeOne(proxy, opts, route);
  }
}

async function probeLandingOne(proxy, opts, route) {
  const cacheKey = getLandingCacheKey(proxy);
  const cached = getCache(cacheKey, opts.ttlMs);
  if (cached) {
    applyLandingResult(proxy, cached, opts);
    return;
  }

  let reachedByProxy = false;
  try {
    const resp = await requestThroughProxy(proxy, opts, route, {
      url: LANDING_QUERY_URL,
    });
    reachedByProxy = true;
    // Reachable proxy path even if geo payload is malformed.
    setNodeAvailable(proxy, true);

    const result = parseGeoResponse(resp.body);
    if (!result.ip) {
      throw new Error("落地 IP 查询失败: 返回数据不完整");
    }

    setCache(cacheKey, result, opts.ttlMs);
    applyLandingResult(proxy, result, opts);
  } catch (err) {
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

async function probeYoutubeOne(proxy, opts, route) {
  const cacheKey = getYoutubeCacheKey(proxy);
  const cached = getCache(cacheKey, opts.ttlMs);
  if (cached) {
    applyYoutubeResult(proxy, cached, opts);
    return;
  }

  try {
    const resp = await requestThroughProxy(proxy, opts, route, {
      url: YOUTUBE_QUERY_URL,
      headers: {
        "accept-language": acceptLanguage,
        "user-agent": userAgent,
      },
    });

    const result = parseYoutubePremium(resp.body || "");
    setCache(cacheKey, result, opts.ttlMs);
    applyYoutubeResult(proxy, result, opts);
  } catch (err) {
    proxy._yt_premium_supported = "";
    proxy._yt_premium_error = extractError(err);

    if (opts.doRename) {
      proxy.name = removeYtTag(proxy.name);
    }

    $.error(`yt-premium ${proxy.name}: ${proxy._yt_premium_error}`);
  }
}

function applyLandingResult(proxy, result, opts) {
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
  const cleanName = removeLandingTag(proxy.name);
  if (String(position).toLowerCase() === "prefix") {
    proxy.name = `${landingText} ${cleanName}`.trim();
  } else {
    proxy.name = `${cleanName} ${landingText}`.trim();
  }
}

function applyYoutubeResult(proxy, result, opts) {
  proxy._yt_premium_supported = String(Boolean(result.supported));
  proxy._yt_premium_error = "";

  if (!opts.doRename) return;

  const clean = removeYtTag(proxy.name);
  if (result.supported) {
    const tag = "[YTP]";
    if (String(position).toLowerCase() === "prefix") {
      proxy.name = `${tag} ${clean}`.trim();
    } else {
      proxy.name = `${clean} ${tag}`.trim();
    }
  } else {
    proxy.name = clean;
  }
}

async function requestThroughProxy(proxy, opts, route, req) {
  const headers = req.headers || null;

  if (!route.useHttpMeta) {
    const node = route.nodeDescriptor;
    if (!node) {
      throw new Error("NODE_DESCRIPTOR_EMPTY");
    }
    const payload = {
      url: req.url,
      timeout: opts.timeout,
      node,
    };
    if (headers) {
      payload.headers = headers;
    }
    return $.http.get(payload);
  }

  return requestViaHttpMeta(proxy, opts, req.url, headers);
}

async function requestViaHttpMeta(proxy, opts, url, headers) {
  const ctx = opts.metaCtx;
  if (!ctx || !Array.isArray(ctx.ports)) {
    throw new Error("HTTP_META_NOT_READY");
  }

  const idx = ctx.proxies.indexOf(proxy);
  const proxyPort = ctx.ports[idx];
  if (!proxyPort) {
    throw new Error("HTTP_META_PORT_MISSING");
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
        const payload = {
          url,
          timeout: opts.timeout,
          proxy: p,
        };
        if (headers) {
          payload.headers = headers;
        }
        return await $.http.get(payload);
      } catch (err) {
        lastErr = err;
      }
    }
    await sleep(step);
  }

  throw new Error(`HTTP_META_CONNECT_FAILED: ${extractError(lastErr)} @${proxyPort}`);
}

function parseYoutubePremium(body) {
  const text = String(body || "");
  if (!text.trim()) throw new Error("EMPTY_RESPONSE");

  if (/(Premium is not available in your country)/i.test(text)) {
    return {
      supported: false,
      at: Date.now(),
    };
  }

  if (/consent\.youtube\.com|Before you continue to YouTube/i.test(text)) {
    throw new Error("CONSENT_REQUIRED");
  }

  if (/unusual traffic from your computer network/i.test(text)) {
    throw new Error("GOOGLE_CHALLENGE");
  }

  return {
    supported: true,
    at: Date.now(),
  };
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

function buildProbeRoute(proxy, opts) {
  let useHttpMeta = opts.mode !== "node";

  if (
    !useHttpMeta &&
    opts.useMihomoForUnsupported &&
    opts.metaCtx &&
    !isSurgeSupportedProxy(proxy)
  ) {
    useHttpMeta = true;
  }
  if (!useHttpMeta && opts.blockNodeMode) {
    return {
      useHttpMeta: false,
      nodeDescriptor: "",
      skip: true,
    };
  }

  const nodeDescriptor = useHttpMeta
    ? ""
    : buildNodeDescriptor(proxy, ["Surge", "Loon", "ClashMeta", "Clash"]);

  return {
    useHttpMeta,
    nodeDescriptor,
    skip: false,
  };
}

function buildNodeDescriptor(proxy, candidates = ["ClashMeta", "Clash", "Loon", "Surge"]) {
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

function isSurgeSupportedProxy(proxy) {
  if (!proxy || typeof proxy !== "object") return false;
  if (SURGE_SUPPORTED_CACHE.has(proxy)) {
    return SURGE_SUPPORTED_CACHE.get(proxy);
  }

  let supported = false;
  try {
    const text = ProxyUtils.produce([proxy], "Surge");
    supported = typeof text === "string" && text.trim().length > 0;
  } catch (_) {
    supported = false;
  }

  SURGE_SUPPORTED_CACHE.set(proxy, supported);
  return supported;
}

function countSurgeUnsupportedProxies(proxies) {
  let count = 0;
  for (const proxy of proxies || []) {
    if (!isSurgeSupportedProxy(proxy)) {
      count += 1;
    }
  }
  return count;
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
    // ignore
  }
}

function normalizeProxyForMeta(proxy) {
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
    // ignore
  }
  return sanitizeProxy(proxy);
}

function parseProducedProxy(text) {
  if (!text || typeof text !== "string") return null;

  try {
    if (ProxyUtils && ProxyUtils.yaml && ProxyUtils.yaml.parse) {
      const y = ProxyUtils.yaml.parse(text);
      if (Array.isArray(y) && y.length && isPlainObject(y[0])) return y[0];
      if (y && Array.isArray(y.proxies) && y.proxies.length) return y.proxies[0];
    }
  } catch (_) {
    // continue
  }

  try {
    const j = JSON.parse(text);
    if (Array.isArray(j) && j.length && isPlainObject(j[0])) return j[0];
    if (j && Array.isArray(j.proxies) && j.proxies.length) return j.proxies[0];
  } catch (_) {
    // ignore
  }

  return null;
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

function removeLandingTag(name) {
  return String(name || "")
    .replace(/\s*\[落地[^\]]*\]\s*/g, " ")
    .replace(/\s*❌落地失败\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removeYtTag(name) {
  return String(name || "")
    .replace(/\s*\[YTP[^\]]*\]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function buildLandingFailureName(proxy) {
  const cleanName = removeLandingTag(proxy && proxy.name);
  const existingFlag = extractLeadingFlag(cleanName);
  const flaggedName = existingFlag ? "" : await tryApplyBuiltinFlagName(proxy, cleanName);
  const baseName = existingFlag ? cleanName : flaggedName || cleanName;
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
      [{ type: "Flag Operator", args: { mode: "add", tw: "ws" } }],
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

function getFlagEmoji(countryCode) {
  const cc = safeUpper(countryCode);
  if (!/^[a-zA-Z]{2}$/.test(cc)) return "";
  const codePoints = cc
    .split("")
    .map((c) => 127397 + c.charCodeAt());
  return String.fromCodePoint(...codePoints).replace(/🇹🇼/g, "🇼🇸");
}

function getLandingCacheKey(proxy) {
  return `${LANDING_CACHE_PREFIX}${proxy.server}:${proxy.port}:${proxy.type || ""}`;
}

function getYoutubeCacheKey(proxy) {
  return `${YT_CACHE_PREFIX}${proxy.server}:${proxy.port}:${proxy.type || ""}`;
}

function resolveLandingQueryUrl(landingUrl, legacyUrl) {
  if (isValidUrlLike(landingUrl)) return String(landingUrl).trim();
  if (isValidUrlLike(legacyUrl) && !isYoutubeUrl(legacyUrl)) {
    return String(legacyUrl).trim();
  }
  return DEFAULT_LANDING_QUERY_URL;
}

function resolveYoutubeQueryUrl(youtubeUrl, legacyUrl) {
  if (isValidUrlLike(youtubeUrl)) return String(youtubeUrl).trim();
  if (isValidUrlLike(legacyUrl) && isYoutubeUrl(legacyUrl)) {
    return String(legacyUrl).trim();
  }
  return DEFAULT_YOUTUBE_QUERY_URL;
}

function cleanupProbeTags(proxies) {
  if (!Array.isArray(proxies)) return;
  for (const proxy of proxies) {
    if (!proxy || typeof proxy !== "object") continue;
    proxy.name = removeYtTag(removeLandingTag(proxy.name || ""));
  }
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

function isYoutubeUrl(url) {
  return /youtube\.com|youtu\.be/i.test(String(url || ""));
}

function isValidUrlLike(url) {
  const s = String(url || "").trim();
  return /^https?:\/\//i.test(s);
}

function getCache(key, ttlMs) {
  if (typeof scriptResourceCache === "undefined") return null;
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
