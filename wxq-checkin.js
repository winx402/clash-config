/* Surge iOS. Experimental: protocol found in the official act-center bundle;
 * authenticated iPhone capture, replay, and cross-day execution still need testing.
 * No login/refresh calls. Credentials stay in Surge's local persistent store.
 */
(function () {
  "use strict";

  var ORIGIN = "https://kohcamp.qq.com";
  var INFO = "/operation/action/signinfo";
  var SIGN = "/operation/action/signin";
  var GAME = "40001"; // Official enum: AUTO_CHESS.
  var KEY = "wxq.checkin.session.v1";
  var PENDING = "wxq.checkin.pending.v1";
  var LOCK = "wxq.checkin.lock.v1";
  var NOTICE = "wxq.checkin.notice.v1";
  var finished = false;

  function problem(message) {
    var failure = new Error(message);
    failure.wxqSafe = true;
    return failure;
  }
  function done() {
    if (!finished) { finished = true; $done({}); }
  }
  function parse(text) {
    try { return JSON.parse(text); } catch (_) { return null; }
  }
  function read(key) { return parse($persistentStore.read(key) || "null"); }
  function write(key, value) {
    if (!$persistentStore.write(value === null ? null : JSON.stringify(value), key)) {
      throw problem("无法保存本机数据");
    }
  }
  function notify(message, quiet) {
    console.log("[万象棋] " + message);
    var previous = read(NOTICE);
    if (quiet || (previous && previous.message === message && Date.now() - previous.time < 3600000)) return;
    if (typeof $notification !== "undefined") $notification.post("王者万象棋签到", "", message);
    // A notification must not fail again when storage is already unavailable.
    $persistentStore.write(JSON.stringify({ message: message, time: Date.now() }), NOTICE);
  }
  function headers(input) {
    var out = {};
    Object.keys(input || {}).forEach(function (name) {
      var key = name.toLowerCase();
      if (/^[a-z0-9-]+$/.test(key) && typeof input[name] === "string" && !/[\r\n]/.test(input[name])) {
        out[key] = input[name];
      }
    });
    return out;
  }
  function route(url) {
    var match = /^https:\/\/kohcamp\.qq\.com(\/[^?#]*)(\?[^#]*)?$/.exec(url || "");
    return match && match[1] === INFO ? { query: match[2] || "" } : null;
  }
  function replayHeaders(input) {
    var out = headers(input);
    ["host", "content-length", "connection", "proxy-connection", "transfer-encoding", "accept-encoding", "upgrade", "te"].forEach(function (key) { delete out[key]; });
    return out;
  }
  function captureTemplate(request) {
    var path = route(request.url);
    if (!path || String(request.method).toUpperCase() !== "POST") return null;
    var h = headers(request.headers);
    // Do not silently capture Glory/World when they use the same endpoint.
    if (String(h.mgameid || h.gameid || "") !== GAME) return null;
    var role = h.camproleid;
    var identity = h.userid || h.openid;
    var auth = h.msdktoken || h.gametoken || h.msdkencodeparam || h.encode || h.authorization || h.cookie;
    if (!role || !identity || !auth) throw problem("缺少角色或鉴权字段，请保留真实请求供本机核对");
    var body = typeof request.body === "string" ? request.body : "";
    var data = parse(body);
    if (!data || Array.isArray(data) || typeof data !== "object") throw problem("查询请求不是可识别的 JSON，暂不保存凭证");
    if (body.length > 16384) throw problem("查询请求过大，暂不保存凭证");
    return { url: request.url, headers: replayHeaders(h), body: body, role: role,
      identity: identity, appid: h.appid || "", game: GAME, capturedAt: Date.now() };
  }
  function sameAccount(a, b) {
    return a.identity === b.identity && a.appid === b.appid && a.role === b.role && a.game === b.game;
  }
  function numericCode(value) {
    return /^-?\d+$/.test(String(value)) ? Number(value) : null;
  }
  function checkResponse(response, raw) {
    if (!response || Number(response.status) !== 200) throw problem("网络请求未成功，请稍后重试");
    var body = parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw problem("响应不是可识别的 JSON");
    var h = headers(response.headers);
    var codes = [body.code, body.returnCode, body.resultCode, body.retCode, h.returncode];
    var explicitSuccess = false;
    codes.forEach(function (value) {
      if (value === undefined || value === null) return;
      var code = numericCode(value);
      if (code === null) throw problem("无法识别业务状态码，已停止");
      if (code !== 0) {
        if ([-30406, -32353, -32354, -30003, -30314].indexOf(code) >= 0) {
          throw problem("登录凭证失效或不完整，请在 iPhone 营地重开万象棋每日福利");
        }
        throw problem("接口返回业务错误，状态码 " + code);
      }
      explicitSuccess = true;
    });
    return { body: body, explicitSuccess: explicitSuccess };
  }
  function signMap(body) {
    var data = body.data;
    var candidates = [body, data, body.signInfo, data && data.signInfo, data && data.data];
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i] && typeof candidates[i].weekSignMap === "string" && /^[01]{7}$/.test(candidates[i].weekSignMap)) {
        return candidates[i].weekSignMap;
      }
    }
    throw problem("未识别到七日签到状态，已停止，不提交签到");
  }
  function shanghaiDay() {
    var date = new Date(Date.now() + 8 * 3600000);
    return { date: date.toISOString().slice(0, 10), index: (date.getUTCDay() + 6) % 7 };
  }
  function marked(map) { return map.charAt(shanghaiDay().index) === "1"; }

  function captureRequest() {
    var template = captureTemplate($request);
    if (!template || !$request.id) return;
    var pending = read(PENDING) || [];
    pending = pending.filter(function (item) { return Date.now() - item.time < 120000 && item.id !== $request.id; }).slice(-3);
    pending.push({ id: $request.id, time: Date.now(), template: template });
    write(PENDING, pending);
  }
  function captureResponse() {
    var pending = read(PENDING) || [];
    var item = pending.filter(function (entry) { return entry.id === $request.id && Date.now() - entry.time < 120000; })[0];
    write(PENDING, pending.filter(function (entry) { return entry.id !== $request.id && Date.now() - entry.time < 120000; }));
    if (!item) return;
    var result = checkResponse($response, $response.body);
    signMap(result.body); // Validate the actual successful state, not HTTP 200 alone.
    var previous = read(KEY);
    if (previous && !sameAccount(previous, item.template)) {
      notify("检测到不同账号或角色，保留原凭证；如需切换，请先运行清除凭证");
      return;
    }
    write(KEY, item.template);
    if (!previous) notify("已捕获当前万象棋角色的凭证，可运行只查状态进行验证");
  }
  function post(url, h, body) {
    return new Promise(function (resolve, reject) {
      $httpClient.post({ url: url, headers: replayHeaders(h), body: body, timeout: 10,
        "auto-redirect": false, "auto-cookie": false }, function (error, response, data) {
        // Native error strings can contain URLs/tokens; never print them.
        if (error) { reject(problem("网络连接失败或超时，请稍后重试")); return; }
        try { resolve(checkResponse(response, data)); } catch (failure) { reject(failure); }
      });
    });
  }
  function validateStored(session) {
    if (!session || !route(session.url) || session.game !== GAME) throw problem("尚无有效凭证，请在 iPhone 营地打开万象棋每日福利");
    var recreated = captureTemplate({ url: session.url, method: "POST", headers: session.headers, body: session.body });
    if (!recreated || !sameAccount(session, recreated)) throw problem("本机凭证数据不一致，请清除后重新捕获");
  }
  function release(owner) {
    var current = read(LOCK);
    if (current && current.owner === owner) write(LOCK, null);
  }
  async function run(mode) {
    var session = read(KEY);
    validateStored(session);
    var current = read(LOCK);
    if (current && Date.now() - current.time < 90000) {
      console.log("[万象棋] 已有任务执行中，本次跳过");
      return;
    }
    var owner = String(Date.now()) + "." + Math.random();
    write(LOCK, { owner: owner, time: Date.now() });
    try {
      var startDay = shanghaiDay().date;
      var before = await post(session.url, session.headers, session.body);
      // Check before early returns too: an old Sunday's response may contain
      // last Monday's bit, which cannot confirm the new Monday after midnight.
      if (shanghaiDay().date !== startDay) throw problem("执行期间已跨日，请重新运行");
      var map = signMap(before.body);
      if (marked(map)) { notify("今日已签到，已通过接口查询确认", mode !== "status" && typeof $trigger === "undefined"); return; }
      if (mode === "status") { notify("今日尚未签到，查询成功；本次未提交签到"); return; }
      if (!read(LOCK) || read(LOCK).owner !== owner) throw problem("执行锁已变化，已停止签到");
      var latest = read(KEY);
      if (!latest || !sameAccount(session, latest)) throw problem("账号或角色已变化，已停止签到");
      session = latest;
      validateStored(session);
      var path = route(session.url);
      await post(ORIGIN + SIGN + path.query, session.headers, JSON.stringify({ roleId: session.role }));
      // A success code alone is insufficient: verify the server's current state.
      var after = await post(session.url, session.headers, session.body);
      if (shanghaiDay().date !== startDay) throw problem("签到后已跨日，无法确认当日结果，请在营地核对");
      if (!marked(signMap(after.body))) throw problem("签到后状态未变为已签到，请在营地核对");
      notify("签到成功，已再次查询确认今日已领取");
    } finally {
      release(owner);
    }
  }
  async function main() {
    var type = typeof $script !== "undefined" ? $script.type : "";
    if (type === "http-request") { captureRequest(); return; }
    if (type === "http-response") { captureResponse(); return; }
    var argument = typeof $argument === "string" ? $argument : "mode=status";
    var match = /(?:^|&)mode=(run|status|clear)(?:&|$)/.exec(argument);
    if (!match) throw problem("无法识别运行模式，已停止");
    if (match[1] === "clear") {
      if (read(LOCK) && Date.now() - read(LOCK).time < 90000) throw problem("任务正在执行，请稍后再清除凭证");
      write(KEY, null); write(PENDING, null); write(LOCK, null); write(NOTICE, null);
      notify("本机签到凭证已清除");
      return;
    }
    await run(match[1]);
  }

  main().then(done, function (failure) {
    try { notify(failure && failure.wxqSafe ? failure.message : "脚本运行异常，未确认签到成功；未输出原始错误以保护凭证"); }
    finally { done(); }
  });
})();
