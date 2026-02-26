const $ = $substore;

/*
 * Sub-Store Script Operator: detect whether each proxy supports YouTube Premium.
 *
 * Suggested args:
 * {
 *   "rename": "true",
 *   "position": "suffix",
 *   "concurrency": "6",
 *   "timeout": "12000",
 *   "cacheHours": "24",
 *   "engine": "http-meta",
 *   "httpMetaUrl": "http://127.0.0.1:9876",
 *   "queryUrl": "https://www.youtube.com/premium"
 * }
 */

const {
  rename = "true",
  position = "suffix",
  concurrency = "6",
  timeout = "12000",
  cacheHours = "24",
  engine = "http-meta",
  httpMetaUrl = "http://127.0.0.1:9876",
  probeTimeoutMs = "45000",
  startupDelayMs = "250",
  connectRetries = "8",
  retryIntervalMs = "180",
  queryUrl = "https://www.youtube.com/premium",
  acceptLanguage = "en",
  userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
} = $arguments;

const CACHE_PREFIX = "yt-premium:";
const NODE_AVAILABLE_FIELD = "_node_available";

async function operator(proxies = []) {
  const c = toPositiveInt(concurrency, 6);
  const t = toPositiveInt(timeout, 12000);
  const ttlMs = Math.max(1, toPositiveInt(cacheHours, 24)) * 3600 * 1000;
  const doRename = String(rename) !== "false";
  let mode = String(engine).toLowerCase();

  let metaCtx = null;
  if (mode !== "node") {
    try {
      metaCtx = await startHttpMetaBatch(proxies, t);
    } catch (err) {
      $.error(
        `yt-premium http-meta unavailable (${httpMetaUrl}): ${extractError(err)}; fallback to engine=node`
      );
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

  try {
    const node = buildNodeDescriptor(proxy);
    const resp = await queryYoutube(proxy, opts, node);
    const result = parseYoutubePremium(resp.body || "");
    setCache(cacheKey, result, opts.ttlMs);
    applyProbeResult(proxy, result, opts);
  } catch (err) {
    proxy._yt_premium_supported = "";
    proxy._yt_premium_error = extractError(err);

    if (opts.doRename) {
      const clean = removeYtTag(proxy.name);
      proxy.name = clean;
    }

    $.error(`yt-premium ${proxy.name}: ${proxy._yt_premium_error}`);
  }
}

function applyProbeResult(proxy, result, opts) {
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

function removeYtTag(name) {
  return String(name || "")
    .replace(/\s*\[YTP[^\]]*\]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function buildNodeDescriptor(proxy) {
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
      // ignore
    }
  }
  return "";
}

async function queryYoutube(proxy, opts, node) {
  const headers = {
    "accept-language": acceptLanguage,
    "user-agent": userAgent,
  };

  if (opts.mode === "node") {
    if (!node) {
      throw new Error("NODE_DESCRIPTOR_EMPTY");
    }
    return $.http.get({
      url: queryUrl,
      timeout: opts.timeout,
      node,
      headers,
    });
  }

  return queryYoutubeViaHttpMeta(proxy, opts, headers);
}

async function queryYoutubeViaHttpMeta(proxy, opts, headers) {
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
  const proxyCandidates = [
    `socks5://127.0.0.1:${proxyPort}`,
    `socks5://localhost:${proxyPort}`,
    `http://127.0.0.1:${proxyPort}`,
    `http://localhost:${proxyPort}`,
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
          headers,
        });
      } catch (err) {
        lastErr = err;
      }
    }
    await sleep(step);
  }

  throw new Error(
    `HTTP_META_CONNECT_FAILED: ${extractError(lastErr)} @${proxyPort}`
  );
}

async function startHttpMetaBatch(proxies, timeoutMs) {
  const base = String(httpMetaUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("HTTP_META_URL_EMPTY");

  const normalized = proxies.map((p) => normalizeProxyForMeta(p));
  if (normalized.length !== proxies.length || normalized.some((p) => !p || !p.type)) {
    const bad = normalized.filter((p) => !p || !p.type).length;
    throw new Error(`PROXY_CONVERT_FAILED: ${bad}`);
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
        throw new Error(`HTTP_META_START_FAILED: ${started.body || "NO_PORTS"}`);
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

  throw lastErr || new Error("HTTP_META_START_FAILED");
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
    // ignore
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

function getCacheKey(proxy) {
  return `${CACHE_PREFIX}${proxy.server}:${proxy.port}:${proxy.type || ""}`;
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
