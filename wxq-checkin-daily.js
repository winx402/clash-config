/* Opt-in Surge iOS daily-page refresh. Never logs URLs or authentication values.
 * Only signinfo is called; no login, ticket generation, refresh or sign-in calls.
 */
(function () {
  "use strict";
  var VERSION = "20261115c";
  var KEY = "wxq.checkin.session.v1";
  var STATE = "wxq.checkin.daily.v1";
  var URL_INFO = "https://kohcamp.qq.com/operation/action/signinfo";
  var AUTH = ["msdkencodeparam", "sig", "timestamp", "encode", "algorithm", "version", "msdktoken", "gametoken", "token", "authorization", "cookie", "itopencodeparam"];
  var ACCEPT_AUTH = ["msdkencodeparam", "sig", "timestamp", "encode", "algorithm", "version", "msdktoken", "token"];
  var MESSAGES = {
    seen: "看到了营地网页文档入口", empty: "看到了页面，但没有支持的认证参数", template: "缺少结构有效的万象棋模板；请先完成一次临时捕获",
    account: "无法证明与已存万象棋账号一致；保留原凭证", mismatch: "页面账号或身份字段不匹配；保留原凭证", conflict: "页面字段冲突或格式不明确；保留原凭证",
    validating: "同账号候选已开始只读验证", rejected: "候选未通过严格只读验证；保留原凭证", timeout: "候选验证超时；保留原凭证",
    updated: "验证通过，已更新同账号凭证", same: "验证通过，凭证相同；未伪报更新", recent: "凭证相同且近期已验证；本次未发起查询",
    older: "候选签名时间早于已存凭证；保留原凭证", filtered: "匹配网页路径，但未认定为文档导航；未读取页面参数",
    stale: "验证期间模板或页面已变化；未写回旧结果", storage: "本机存储失败；未确认更新"
  };
  var finished = false, ticket = "", original = "";
  function parse(s) { try { return JSON.parse(s); } catch (_) { return null; } }
  function read(k) { return parse($persistentStore.read(k) || "null"); }
  function write(k, value) { if (!$persistentStore.write(JSON.stringify(value), k)) throw "storage"; }
  function done() { if (!finished) { finished = true; $done({}); } }
  function fail(code) { throw code; }
  function normalize(input) {
    var out = {};
    Object.keys(input || {}).forEach(function (name) {
      var key = name.toLowerCase(), value = input[name];
      if (typeof value !== "string" || /[\r\n]/.test(value)) fail("conflict");
      if (out[key] !== undefined && out[key] !== value) fail("conflict");
      out[key] = value;
    });
    return out;
  }
  function diagnostic(code, extra) {
    var state = read(STATE) || {};
    if (ticket && state.ticket !== ticket) return;
    state.code = code; state.message = MESSAGES[code]; state.time = Date.now(); state.version = VERSION;
    if (["validating", "rejected", "timeout", "updated", "same", "recent", "stale"].indexOf(code) >= 0) state.progress = { code: code, time: Date.now() };
    Object.keys(extra || {}).forEach(function (k) { state[k] = extra[k]; });
    write(STATE, state);
  }
  function query(url) {
    var q = {}, part = (url.split("?")[1] || "").split("#")[0];
    if (part.length > 32768) fail("conflict");
    part.split("&").forEach(function (entry) {
      if (!entry) return;
      var p = entry.indexOf("="), key, value;
      try { key = decodeURIComponent(p < 0 ? entry : entry.slice(0, p)).toLowerCase(); value = decodeURIComponent((p < 0 ? "" : entry.slice(p + 1)).replace(/\+/g, " ")); } catch (_) { fail("conflict"); }
      if (q[key] !== undefined || /[\r\n]/.test(value)) fail("conflict");
      if (/^[a-z][a-z0-9]*$/.test(key)) q[key] = value;
    });
    return q;
  }
  function pagePath(req) {
    var path = /^https:\/\/camp\.qq\.com(\/h5\/[^?#]*)(?:\?[^#]*)?$/.exec(req.url || "");
    return path && /(?:\.html?|\/)$/i.test(path[1]);
  }
  function documentFilter(req, res, h) {
    if (String(req.method).toUpperCase() !== "GET") return "method";
    if (!res) return "response";
    var status = Number(res.status), contentType = normalize(res.headers)["content-type"] || "";
    var acceptHtml = /(?:^|[,\s])text\/html(?:[,;\s]|$)/i.test(h.accept || "");
    if (status === 304) {
      if (h["sec-fetch-dest"] !== "document" || h["sec-fetch-mode"] !== "navigate") return "cache-navigation";
      if (!acceptHtml) return "html-accept";
      if (contentType && !/^text\/html(?:\s*;|$)/i.test(contentType)) return "content-type";
    } else {
      if (status !== 200) return "response-status";
      if (!/^text\/html(?:\s*;|$)/i.test(contentType)) return "content-type";
    }
    if (h["sec-fetch-dest"] && h["sec-fetch-dest"] !== "document") return "document-destination";
    if (h["sec-fetch-mode"] && h["sec-fetch-mode"] !== "navigate") return "navigation-mode";
    return h["sec-fetch-dest"] === "document" || acceptHtml ? "" : "html-accept";
  }
  function template(raw) {
    var s = parse(raw), h, b;
    if (!s || s.game !== "30001" || !/^https:\/\/kohcamp\.qq\.com\/operation\/action\/signinfo(?:\?[^#]*)?$/.test(s.url || "")) fail("template");
    h = normalize(s.headers); b = parse(s.body);
    if (!b || typeof b !== "object" || Array.isArray(b) || typeof s.body !== "string" || s.body.length > 16384) fail("template");
    if (String(h.gameid || h.mgameid || "") !== "30001" || (h.gameid && h.mgameid && h.gameid !== h.mgameid)) fail("template");
    if (!h.camproleid || s.role !== h.camproleid || s.identity !== (h.userid || h.openid || h.camproleid) || s.appid !== (h.appid || "")) fail("template");
    if (s.signRole !== (h.roleid || b.roleId || "") || s.signGame !== (b.gameId === undefined ? (h.gameid || h.mgameid) : b.gameId) || String(s.signGame) !== "30001") fail("template");
    if (!AUTH.some(function (k) { return h[k]; })) fail("template");
    return { session: s, headers: h, body: b };
  }
  function identity(q, h, old) {
    var proven = false, a = old.headers;
    ["userid", "openid", "appid"].forEach(function (k) {
      var value = q[k] || h[k];
      if (q[k] && h[k] && q[k] !== h[k]) fail("mismatch");
      if (value && a[k] && value !== a[k]) fail("mismatch");
      if (k !== "appid" && value && a[k] && value === a[k]) proven = true;
    });
    // uniqueRoleId is a role identifier, never a substitute for userId.
    // Ordinary non-game pages can prove an account via userId/openid without
    // sharing WXQ's role. A game-specific page must also match WXQ's role.
    var game = q.mgameid || q.gameid;
    if (q.mgameid && q.gameid && q.mgameid !== q.gameid) fail("mismatch");
    if (game === "30001") {
      if (q.uniqueroleid && q.uniqueroleid !== old.session.role) fail("mismatch");
      if (q.roleid && q.roleid !== old.session.signRole) fail("mismatch");
      if (q.uniqueroleid === old.session.role) proven = true;
    }
    if (!proven) fail("account");
  }
  function candidate(q, h, old) {
    var cookie = {}, fresh = {};
    // Never forward a raw Cookie or an Authorization value. Cookie token names
    // are accepted only after same-request account ownership has been checked.
    (h.cookie || "").split(";").forEach(function (entry) {
      var p = entry.indexOf("="); if (p < 0) return;
      var key = entry.slice(0, p).trim().toLowerCase();
      if (["msdktoken", "token"].indexOf(key) < 0) return;
      var value = entry.slice(p + 1).trim();
      if (cookie[key] !== undefined) fail("conflict");
      cookie[key] = value;
    });
    // Query and headers belong to this one observed request. Combine only
    // nonconflicting companion fields; never pull an old stored auth field.
    ACCEPT_AUTH.forEach(function (k) {
      if (q[k] && h[k] && q[k] !== h[k]) fail("conflict");
      if (q[k] || h[k]) fresh[k] = q[k] || h[k];
    });
    if (!(fresh.msdkencodeparam || fresh.msdktoken || fresh.token)) {
      Object.keys(cookie).forEach(function (k) { if (cookie[k]) fresh[k] = cookie[k]; });
    }
    if (!fresh || !(fresh.msdkencodeparam || fresh.msdktoken || fresh.token)) fail("empty");
    if (fresh.msdkencodeparam && (!fresh.sig || !/^\d+$/.test(fresh.timestamp || ""))) fail("conflict");
    if (!fresh.msdkencodeparam && (fresh.sig || fresh.timestamp)) fail("conflict");
    function epoch(value) {
      if (/^\d{10}$/.test(value || "")) return Number(value) * 1000;
      if (/^\d{13}$/.test(value || "")) return Number(value);
      return null; // No timestamp guesses for opaque or unrecognized formats.
    }
    if (fresh.msdkencodeparam && old.headers.msdkencodeparam) {
      var nextTime = epoch(fresh.timestamp), oldTime = epoch(old.headers.timestamp);
      if (nextTime !== null && oldTime !== null && nextTime < oldTime) fail("older");
    }
    var out = {};
    ["gameid", "mgameid", "camproleid", "roleid", "userid", "openid", "appid", "cclientversionname", "user-agent"].forEach(function (k) { if (old.headers[k]) out[k] = old.headers[k]; });
    out["content-type"] = "application/json";
    Object.keys(fresh).forEach(function (k) { out[k] = fresh[k]; });
    var body = { gameId: old.session.signGame };
    ["cSystem", "h5Get", "roleId"].forEach(function (k) { if (old.body[k] !== undefined) body[k] = old.body[k]; });
    var next = parse(original);
    next.url = URL_INFO; next.headers = out; next.body = JSON.stringify(body);
    var oldAuth = {}, newAuth = {};
    AUTH.forEach(function (k) { if (old.headers[k]) oldAuth[k] = old.headers[k]; if (out[k]) newAuth[k] = out[k]; });
    var same = JSON.stringify(oldAuth) === JSON.stringify(newAuth) && old.session.url === URL_INFO &&
      !Object.keys(old.body).some(function (k) { return AUTH.indexOf(k.toLowerCase()) >= 0; });
    return { next: next, same: same };
  }
  function strictSuccess(res, data) {
    if (!res || Number(res.status) !== 200 || typeof data !== "string" || data.length > 262144) return false;
    var b = parse(data), h = normalize(res.headers), found = false;
    if (!b || typeof b !== "object" || Array.isArray(b)) return false;
    var codes = [b.code, b.returnCode, b.resultCode, b.retCode, h.returncode];
    for (var i = 0; i < codes.length; i++) {
      if (codes[i] === undefined || codes[i] === null) continue;
      if (!/^-?\d+$/.test(String(codes[i])) || Number(codes[i]) !== 0) return false;
      found = true;
    }
    return found && b.data && typeof b.data.weekSignMap === "string" && /^[012]{7}$/.test(b.data.weekSignMap);
  }
  function current() { var state = read(STATE); return !finished && state && state.ticket === ticket && $persistentStore.read(KEY) === original; }
  function refresh() {
    var req = $request;
    if (!pagePath(req)) { done(); return; }
    var h = normalize(req.headers), reason = documentFilter(req, $response, h);
    var previous = read(STATE) || {};
    if (reason) {
      diagnostic("filtered", { filtered: (Number(previous.filtered) || 0) + 1, filterReason: reason, filterTime: Date.now() });
      done(); return;
    }
    ticket = String(Date.now()) + "." + Math.random();
    write(STATE, { ticket: ticket, pages: (Number(previous.pages) || 0) + 1, code: "seen", message: MESSAGES.seen, time: Date.now(), version: VERSION,
      verifiedAt: previous.verifiedAt || 0, verifiedCapturedAt: previous.verifiedCapturedAt || 0, progress: previous.progress || null, filtered: previous.filtered || 0, filterReason: previous.filterReason || "", filterTime: previous.filterTime || 0 });
    original = $persistentStore.read(KEY);
    var q = query(req.url);
    diagnostic("seen", { fields: {
      querySigned: !!q.msdkencodeparam, queryToken: !!(q.msdktoken || q.token),
      headerSigned: !!h.msdkencodeparam, headerToken: !!(h.msdktoken || h.token),
      cookieToken: /(?:^|;)\s*(?:msdktoken|token)=/i.test(h.cookie || ""), account: !!(q.userid || q.openid || h.userid || h.openid)
    } });
    if (![q.msdkencodeparam, q.msdktoken, q.token, h.msdkencodeparam, h.msdktoken, h.token].some(Boolean) && !/(?:^|;)\s*(?:msdktoken|token)=/i.test(h.cookie || "")) fail("empty");
    var old = template(original);
    identity(q, h, old);
    var c = candidate(q, h, old), state = read(STATE);
    if (c.same && state.verifiedAt && state.verifiedCapturedAt === old.session.capturedAt && Date.now() - state.verifiedAt < 60000) { diagnostic("recent"); done(); return; }
    diagnostic("validating");
    var timer = setTimeout(function () { if (current()) diagnostic("timeout"); done(); }, 1200);
    $httpClient.post({ url: URL_INFO, headers: c.next.headers, body: c.next.body, timeout: 1,
      "auto-cookie": false, "auto-redirect": false }, function (error, response, data) {
      if (finished) return;
      clearTimeout(timer);
      try {
        if (!current()) { diagnostic("stale"); done(); return; }
        if (error || !strictSuccess(response, data)) { diagnostic("rejected"); done(); return; }
        // All checks and the final reread/write are synchronous, with no await.
        // Surge has no cross-script CAS; this guards observable clear/recapture,
        // newer daily attempts, and out-of-order HTTP callbacks.
        if (!current()) { diagnostic("stale"); done(); return; }
        if (!c.same) { c.next.capturedAt = Date.now(); write(KEY, c.next); }
        diagnostic(c.same ? "same" : "updated", { verifiedAt: Date.now(), verifiedCapturedAt: c.same ? old.session.capturedAt : c.next.capturedAt });
      } catch (_) { try { diagnostic("storage"); } catch (_) {} }
      done();
    });
  }
  try {
    if (typeof $script !== "undefined" && $script.type === "http-response") refresh();
    else {
      var state = read(STATE), message = state && MESSAGES[state.code] ? MESSAGES[state.code] : "尚未看到符合条件的营地网页文档入口";
      var suffix = state ? "；已观察页面 " + (Number(state.pages) || 0) + " 次；记录时间 " + new Date(state.time).toISOString() : "";
      if (state && state.filtered) suffix += "；路径过滤 " + state.filtered + " 次，最近原因 " + state.filterReason;
      if (state && state.fields) suffix += "；字段类别（仅有无） " + Object.keys(state.fields).map(function (k) { return k + "=" + (state.fields[k] ? "有" : "无"); }).join("，");
      if (state && state.progress && MESSAGES[state.progress.code]) suffix += "；最近验证进度：" + MESSAGES[state.progress.code] + "（" + new Date(state.progress.time).toISOString() + "）";
      var text = "[万象棋日常刷新 " + VERSION + "] " + message + suffix;
      console.log(text);
      if (typeof $notification !== "undefined") $notification.post("万象棋日常刷新诊断", "只读；未发起网络请求", text);
      done();
    }
  } catch (code) { try { diagnostic(MESSAGES[code] ? code : "conflict"); } catch (_) {} done(); }
})();
