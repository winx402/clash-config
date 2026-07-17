(function () {
  "use strict";

  const PREMIUM_URL = "https://www.youtube.com/premium?hl=en";
  const REQUEST_TIMEOUT_SECONDS = 8;
  const MAX_DIRECT_CONCURRENCY = 5;
  const LOCK_TTL_MS = 12 * 60 * 1000;
  const STATE_KEY = "youtube-premium-auto:state:v1";
  const LOCK_KEY = "youtube-premium-auto:lock:v1";
  const ERROR_NOTICE_KEY = "youtube-premium-auto:error-notice:v1";

  function parseArguments(input) {
    const values = {};
    if (input && typeof input === "object") {
      Object.keys(input).forEach((key) => {
        values[key] = String(input[key]);
      });
    } else {
      const raw = String(input || "");
      const targetPrefix = "TARGET_GROUP=";
      const regionMarker = "&REGION_ORDER=";
      if (raw.startsWith(targetPrefix) && raw.includes(regionMarker)) {
        const regionIndex = raw.indexOf(regionMarker);
        values.TARGET_GROUP = safeDecode(raw.slice(targetPrefix.length, regionIndex));
        raw
          .slice(regionIndex + 1)
          .split("&")
          .filter(Boolean)
          .forEach((part) => {
            const index = part.indexOf("=");
            const rawKey = index === -1 ? part : part.slice(0, index);
            const rawValue = index === -1 ? "" : part.slice(index + 1);
            values[safeDecode(rawKey)] = safeDecode(rawValue);
          });
      } else {
        raw
          .split("&")
          .filter(Boolean)
          .forEach((part) => {
            const index = part.indexOf("=");
            const rawKey = index === -1 ? part : part.slice(0, index);
            const rawValue = index === -1 ? "" : part.slice(index + 1);
            values[safeDecode(rawKey)] = safeDecode(rawValue);
          });
      }
    }

    const targetGroup = String(values.TARGET_GROUP || "").trim();
    if (!targetGroup) throw new Error("TARGET_GROUP 不能为空");

    const regionOrder = String(values.REGION_ORDER || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (!regionOrder.length) throw new Error("REGION_ORDER 不能为空");

    const seen = new Set();
    regionOrder.forEach((region) => {
      if (region !== "other" && !/^[a-z]{2}$/.test(region)) {
        throw new Error(`无效地区代码: ${region}`);
      }
      if (seen.has(region)) throw new Error(`地区代码重复: ${region}`);
      seen.add(region);
    });

    return {
      targetGroup,
      regionOrder,
      runMode: String(values.RUN_MODE || "cron").toLowerCase() === "manual" ? "manual" : "cron",
      dryRun: String(values.DRY_RUN || "").toLowerCase() === "true",
    };
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(String(value).replace(/\+/g, " "));
    } catch (_) {
      return String(value);
    }
  }

  function extractCountry(body) {
    const text = String(body || "");
    const patterns = [
      /"countryCode"\s*:\s*"([A-Z]{2})"/i,
      /"INNERTUBE_CONTEXT_GL"\s*:\s*"([A-Z]{2})"/i,
      /\\"countryCode\\"\s*:\s*\\"([A-Z]{2})\\"/i,
      /\\"INNERTUBE_CONTEXT_GL\\"\s*:\s*\\"([A-Z]{2})\\"/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1].toUpperCase();
    }
    return null;
  }

  function parsePremiumResponse(statusCode, body) {
    const status = Number(statusCode || 0);
    const text = String(body || "");
    if (status === 403) return unknown("HTTP_403");
    if (status === 429) return unknown("HTTP_429");
    if (status < 200 || status >= 300) return unknown(`HTTP_${status || "ERROR"}`);
    if (!text.trim()) return unknown("EMPTY_RESPONSE");

    if (/consent\.youtube\.com|Before you continue to YouTube/i.test(text)) {
      return unknown("CONSENT_REQUIRED");
    }
    if (/unusual traffic from your computer network|recaptcha|challenge-form/i.test(text)) {
      return unknown("GOOGLE_CHALLENGE");
    }

    const country = extractCountry(text);
    const unavailable =
      /"(?:content|simpleText)"\s*:\s*"(?:YouTube )?Premium(?: Lite)? is not available in your (?:country|region)"/i.test(text) ||
      /<(?:h1|h2|title)[^>]*>[^<]*(?:YouTube )?Premium(?: Lite)? is not available in your (?:country|region)/i.test(text);
    if (unavailable) {
      return { status: "unavailable", country, reason: "PREMIUM_UNAVAILABLE" };
    }

    const hasPurchaseMarker =
      /"purchaseButton"\s*:/i.test(text) ||
      /"(?:youtubePremiumSignupPanelRenderer|premiumOfferDetails)"\s*:/i.test(text);
    if (!country) return unknown("COUNTRY_NOT_FOUND");
    if (!hasPurchaseMarker) return unknown("PREMIUM_MARKER_NOT_FOUND", country);
    return { status: "supported", country, reason: "OK" };
  }

  function unknown(reason, country) {
    return { status: "unknown", country: country || null, reason };
  }

  function regionRank(country, regionOrder) {
    const normalized = String(country || "").toLowerCase();
    const exact = regionOrder.indexOf(normalized);
    if (exact !== -1) return exact;
    const other = regionOrder.indexOf("other");
    return other === -1 ? Infinity : other;
  }

  function chooseCandidate(results, regionOrder) {
    return results
      .filter((result) => result.status === "supported")
      .map((result) => ({ ...result, rank: regionRank(result.country, regionOrder) }))
      .filter((result) => Number.isFinite(result.rank))
      .sort((a, b) => a.rank - b.rank || a.elapsed - b.elapsed || a.order - b.order)[0] || null;
  }

  function buildUnits(items) {
    const units = [];
    let nodePool = null;
    (Array.isArray(items) ? items : []).forEach((item, index) => {
      if (!item || item.enabled === false || !item.name) return;
      if (item.isGroup === true) {
        units.push({ type: "group", name: item.name, order: index });
        return;
      }
      if (!nodePool) {
        nodePool = { type: "nodes", nodes: [], order: index };
        units.push(nodePool);
      }
      nodePool.nodes.push({ name: item.name, order: index });
    });
    return units;
  }

  function emptySearchResult() {
    return {
      winner: null,
      path: null,
      supported: 0,
      unavailable: 0,
      unknown: 0,
      excluded: 0,
      skipped: 0,
      considered: 0,
      warnings: [],
    };
  }

  function mergeSearchResult(target, source) {
    ["supported", "unavailable", "unknown", "excluded", "skipped", "considered"].forEach((key) => {
      target[key] += Number(source[key] || 0);
    });
    if (Array.isArray(source.warnings)) target.warnings.push(...source.warnings);
    return target;
  }

  function validateTargetGroup(groups, selectGroups, targetGroup) {
    if (!Object.prototype.hasOwnProperty.call(groups, targetGroup)) {
      const error = new Error(`未找到顶层策略组: ${targetGroup}`);
      error.code = "TARGET_NOT_FOUND";
      throw error;
    }
    if (!selectGroups.has(targetGroup)) {
      const error = new Error(`顶层策略组不是 select，已跳过: ${targetGroup}`);
      error.code = "TARGET_NOT_SELECT";
      throw error;
    }
  }

  function isInconclusiveSearch(search, requestCount) {
    return search.unknown > 0 || search.skipped > 0 || requestCount === 0;
  }

  async function searchPolicyTree(groupName, groups, selectGroups, probePool, ancestors) {
    const result = emptySearchResult();
    const stack = Array.isArray(ancestors) ? ancestors : [];
    if (stack.includes(groupName)) {
      result.unknown += 1;
      result.warnings.push(`检测到循环策略组: ${stack.concat(groupName).join(" -> ")}`);
      return result;
    }

    const items = groups[groupName];
    if (!Array.isArray(items)) {
      result.unknown += 1;
      result.warnings.push(`无法读取策略组: ${groupName}`);
      return result;
    }

    const units = buildUnits(items);
    for (const unit of units) {
      let current;
      if (unit.type === "group") {
        if (!selectGroups.has(unit.name)) {
          result.skipped += 1;
          result.warnings.push(`跳过非 select 策略组: ${unit.name}`);
          continue;
        }
        current = await searchPolicyTree(
          unit.name,
          groups,
          selectGroups,
          probePool,
          stack.concat(groupName)
        );
        mergeSearchResult(result, current);
        if (current.winner) {
          result.winner = current.winner;
          result.path = [groupName].concat(current.path || []);
          return result;
        }
      } else {
        current = await probePool(groupName, unit.nodes);
        mergeSearchResult(result, current);
        if (current.winner) {
          result.winner = current.winner;
          result.path = [groupName];
          return result;
        }
      }
    }
    return result;
  }

  function normalizePolicyNames(payload) {
    const names = new Set(["DIRECT", "REJECT", "REJECT-TINYGIF"]);
    const proxies = payload && Array.isArray(payload.proxies) ? payload.proxies : [];
    proxies.forEach((entry) => {
      if (typeof entry === "string") names.add(entry);
      else if (entry && entry.name) names.add(entry.name);
    });
    return names;
  }

  function createProbeManager(adapter, config, globalPolicies, previousState) {
    const cache = new Map();
    const snapshots = new Map();
    const oldOwned = new Map(
      ((previousState && previousState.owned) || []).map((entry) => [entry.group, entry])
    );
    const stats = { requests: 0 };

    async function snapshotGroup(group) {
      if (snapshots.has(group)) return snapshots.get(group);
      const snapshot = {
        group,
        policy: await adapter.getGroupSelection(group),
      };
      snapshots.set(group, snapshot);
      return snapshot;
    }

    async function restoreTemporaryGroup(group) {
      const owned = oldOwned.get(group);
      if (owned && owned.selected) {
        await adapter.setGroupPolicy(group, owned.selected);
        return;
      }
      const snapshot = snapshots.get(group);
      if (!snapshot) return;
      if (snapshot.policy) {
        await adapter.setGroupPolicy(group, snapshot.policy);
      }
    }

    async function requestNode(nodeName, policyName) {
      stats.requests += 1;
      try {
        const response = await adapter.requestPremium(policyName, nodeName);
        const parsed = parsePremiumResponse(response.status, response.body);
        return {
          ...parsed,
          node: nodeName,
          elapsed: response.elapsed,
        };
      } catch (error) {
        return {
          status: "unknown",
          country: null,
          reason: errorMessage(error),
          node: nodeName,
          elapsed: REQUEST_TIMEOUT_SECONDS * 1000,
        };
      }
    }

    function cachedGlobalProbe(nodeName) {
      if (!cache.has(nodeName)) cache.set(nodeName, requestNode(nodeName, nodeName));
      return cache.get(nodeName);
    }

    async function cachedScopedProbe(parentGroup, nodeName) {
      if (cache.has(nodeName)) return cache.get(nodeName);
      const promise = (async () => {
        try {
          await adapter.setGroupPolicy(parentGroup, nodeName);
          await adapter.sleep(30);
          return await requestNode(nodeName, parentGroup);
        } catch (error) {
          return {
            status: "unknown",
            country: null,
            reason: `POLICY_OVERRIDE_FAILED: ${errorMessage(error)}`,
            node: nodeName,
            elapsed: REQUEST_TIMEOUT_SECONDS * 1000,
          };
        }
      })();
      cache.set(nodeName, promise);
      return promise;
    }

    async function probePool(parentGroup, nodes) {
      const direct = [];
      const scoped = [];
      nodes.forEach((node) => {
        (globalPolicies.has(node.name) ? direct : scoped).push(node);
      });

      const results = [];
      const directResults = await mapLimit(direct, MAX_DIRECT_CONCURRENCY, async (node) => ({
        ...(await cachedGlobalProbe(node.name)),
        order: node.order,
      }));
      results.push(...directResults);

      const uncachedScoped = scoped.some((node) => !cache.has(node.name));
      if (uncachedScoped) await snapshotGroup(parentGroup);
      try {
        for (const node of scoped) {
          results.push({
            ...(await cachedScopedProbe(parentGroup, node.name)),
            order: node.order,
          });
        }
      } finally {
        if (uncachedScoped) await restoreTemporaryGroup(parentGroup);
      }

      const summary = emptySearchResult();
      summary.considered = results.length;
      results.forEach((entry) => {
        if (entry.status === "supported") {
          summary.supported += 1;
          if (!Number.isFinite(regionRank(entry.country, config.regionOrder))) summary.excluded += 1;
        } else if (entry.status === "unavailable") {
          summary.unavailable += 1;
        } else {
          summary.unknown += 1;
        }
      });
      summary.winner = chooseCandidate(results, config.regionOrder);
      return summary;
    }

    async function restoreAllTemporary() {
      for (const group of snapshots.keys()) {
        try {
          await restoreTemporaryGroup(group);
        } catch (_) {
          // Best effort cleanup after a runtime failure.
        }
      }
    }

    return {
      probePool,
      getSnapshot: (group) => snapshots.get(group) || null,
      restoreAllTemporary,
      stats,
    };
  }

  async function mapLimit(items, limit, worker) {
    if (!items.length) return [];
    const results = new Array(items.length);
    let cursor = 0;
    const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index], index);
      }
    });
    await Promise.all(workers);
    return results;
  }

  async function releaseOwned(entries, adapter, warnings) {
    const failures = [];
    for (const entry of Array.isArray(entries) ? entries.slice().reverse() : []) {
      try {
        if (entry.baseline) {
          await adapter.setGroupPolicy(entry.group, entry.baseline);
        } else {
          throw new Error(`缺少原始 select 选项: ${entry.group}`);
        }
      } catch (error) {
        failures.push(error);
        if (warnings) warnings.push(`恢复 ${entry.group} 失败: ${errorMessage(error)}`);
      }
    }
    return failures;
  }

  async function reapplyOwned(entries, adapter) {
    for (const entry of (Array.isArray(entries) ? entries : []).slice().reverse()) {
      if (entry.selected) await adapter.setGroupPolicy(entry.group, entry.selected);
    }
  }

  async function applyWinner(path, nodeName, previousState, probeManager, adapter) {
    const desired = new Map();
    path.forEach((group, index) => {
      desired.set(group, index + 1 < path.length ? path[index + 1] : nodeName);
    });

    const oldEntries = (previousState && previousState.owned) || [];
    const oldMap = new Map(oldEntries.map((entry) => [entry.group, entry]));
    const newEntries = [];

    for (const group of path) {
      const existing = oldMap.get(group);
      if (existing) {
        newEntries.push({ ...existing, selected: desired.get(group) });
        continue;
      }
      const snapshot = probeManager.getSnapshot(group) || {
        policy: await adapter.getGroupSelection(group),
      };
      newEntries.push({
        group,
        baseline: snapshot.policy || null,
        selected: desired.get(group),
      });
    }

    const released = oldEntries.filter((entry) => !desired.has(entry.group));
    try {
      const releaseFailures = await releaseOwned(released, adapter);
      if (releaseFailures.length) throw releaseFailures[0];
      for (const entry of newEntries.slice().reverse()) {
        await adapter.setGroupPolicy(entry.group, entry.selected);
      }
      return newEntries;
    } catch (error) {
      const added = newEntries.filter((entry) => !oldMap.has(entry.group));
      await releaseOwned(added, adapter, []);
      try {
        await reapplyOwned(oldEntries, adapter);
      } catch (_) {
        // Keep the original error; state is not committed on a partial apply.
      }
      throw error;
    }
  }

  function createSurgeAdapter() {
    let cachedSelectGroups = null;

    function api(method, path, body) {
      return new Promise((resolve, reject) => {
        try {
          $httpAPI(method, path, body == null ? null : body, (result) => {
            if (result && result.error) reject(new Error(String(result.error)));
            else resolve(result || {});
          });
        } catch (error) {
          reject(error);
        }
      });
    }

    async function getPolicyGroups() {
      const result = await api("GET", "/v1/policy_groups", null);
      return result.map && typeof result.map === "object" ? result.map : result;
    }

    async function getGlobalPolicies() {
      return normalizePolicyNames(await api("GET", "/v1/policies", null));
    }

    async function getSelectGroups(groups) {
      if (cachedSelectGroups) return cachedSelectGroups;
      cachedSelectGroups = new Set();
      try {
        const details = $surge.selectGroupDetails();
        Object.keys((details && details.groups) || {}).forEach((name) => cachedSelectGroups.add(name));
        return cachedSelectGroups;
      } catch (_) {
        // Fall back to profile declarations when selectGroupDetails is unavailable.
      }

      for (const group of Object.keys(groups)) {
        try {
          const detail = await api(
            "GET",
            `/v1/policies/detail?policy_name=${encodeURIComponent(group)}`,
            null
          );
          const line = detail[group] || Object.values(detail)[0] || "";
          if (/=\s*select(?:\s*,|\s*$)/i.test(String(line))) cachedSelectGroups.add(group);
        } catch (_) {
          // Unreadable groups remain unsupported and are skipped.
        }
      }
      return cachedSelectGroups;
    }

    async function getGroupSelection(group) {
      const result = await api(
        "GET",
        `/v1/policy_groups/select?group_name=${encodeURIComponent(group)}`,
        null
      );
      if (!result.policy) throw new Error(`无法读取策略组当前选择: ${group}`);
      return result.policy;
    }

    async function setGroupPolicy(group, policy) {
      if (!$surge || typeof $surge.setSelectGroupPolicy !== "function") {
        throw new Error("当前 Surge 不支持 setSelectGroupPolicy");
      }
      if (!$surge.setSelectGroupPolicy(group, policy)) {
        throw new Error(`无法设置策略组 ${group} -> ${policy}`);
      }
    }

    function requestPremium(policyName, nodeName) {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const separator = PREMIUM_URL.includes("?") ? "&" : "?";
        const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        $httpClient.get(
          {
            url: `${PREMIUM_URL}${separator}surge_ytp_probe=${nonce}`,
            policy: policyName,
            timeout: REQUEST_TIMEOUT_SECONDS,
            "auto-cookie": false,
            "auto-redirect": true,
            headers: {
              accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "accept-language": "en-US,en;q=0.9",
              "cache-control": "no-cache",
              cookie: "SOCS=CAI",
              pragma: "no-cache",
              "user-agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            },
          },
          (error, response, body) => {
            if (error) {
              reject(new Error(`${nodeName}: ${errorMessage(error)}`));
              return;
            }
            resolve({
              status: response && (response.status || response.statusCode),
              body: String(body || ""),
              elapsed: Date.now() - started,
            });
          }
        );
      });
    }

    return {
      getPolicyGroups,
      getGlobalPolicies,
      getSelectGroups,
      getGroupSelection,
      setGroupPolicy,
      requestPremium,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      readState: () => readJsonStore(STATE_KEY),
      writeState: (state) => writeJsonStore(STATE_KEY, state),
      notify: (title, subtitle, body) => $notification.post(title, subtitle, body),
      log: (message) => console.log(message),
    };
  }

  function readJsonStore(key) {
    const value = $persistentStore.read(key);
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  }

  function writeJsonStore(key, value) {
    return $persistentStore.write(JSON.stringify(value), key);
  }

  function acquireLock() {
    const now = Date.now();
    const current = readJsonStore(LOCK_KEY);
    if (current && Number(current.expiresAt) > now) return null;
    const token = `${now}-${Math.random().toString(36).slice(2)}`;
    writeJsonStore(LOCK_KEY, { token, expiresAt: now + LOCK_TTL_MS });
    const confirmed = readJsonStore(LOCK_KEY);
    return confirmed && confirmed.token === token ? token : null;
  }

  function releaseLock(token) {
    const current = readJsonStore(LOCK_KEY);
    if (current && current.token === token) $persistentStore.write("", LOCK_KEY);
  }

  function stateNoticeKey(status, winner, detail) {
    if (status === "success" && winner) {
      return `success:${winner.country}:${winner.node}:${(winner.path || []).join("/")}`;
    }
    return `${status}:${detail || ""}`;
  }

  function shouldNotify(config, previousState, noticeKey) {
    return config.runMode === "manual" || !previousState || previousState.lastNoticeKey !== noticeKey;
  }

  function notifyErrorOnce(runMode, subtitle, message, key) {
    const noticeKey = `${key}:${message}`;
    const previous = $persistentStore.read(ERROR_NOTICE_KEY);
    if (runMode === "manual" || previous !== noticeKey) {
      $notification.post("YouTube Premium 自动选路", subtitle, message);
    }
    $persistentStore.write(noticeKey, ERROR_NOTICE_KEY);
  }

  function baseState(targetGroup) {
    return {
      version: 1,
      targetGroup,
      status: "idle",
      owned: [],
      winner: null,
      lastNoticeKey: null,
      updatedAt: Date.now(),
    };
  }

  async function runSurge() {
    let config;
    try {
      config = parseArguments(typeof $argument === "undefined" ? "" : $argument);
    } catch (error) {
      const rawArgument = typeof $argument === "undefined" ? "" : String($argument);
      const runMode = /(?:^|&)RUN_MODE=manual(?:&|$)/i.test(rawArgument) ? "manual" : "cron";
      notifyErrorOnce(runMode, "配置错误", errorMessage(error), "CONFIG");
      return;
    }

    const token = acquireLock();
    if (!token) {
      if (config.runMode === "manual") {
        $notification.post("YouTube Premium 自动选路", "检测正在运行", "请稍后再试");
      }
      return;
    }

    const adapter = createSurgeAdapter();
    let probeManager = null;
    try {
      const groups = await adapter.getPolicyGroups();
      const selectGroups = await adapter.getSelectGroups(groups);
      validateTargetGroup(groups, selectGroups, config.targetGroup);

      const previousState = adapter.readState() || baseState(config.targetGroup);
      if (config.dryRun) {
        const count = Array.isArray(groups[config.targetGroup]) ? groups[config.targetGroup].length : 0;
        adapter.log(`DRY_RUN: ${config.targetGroup}, ${count} 个直属子项`);
        if (config.runMode === "manual") {
          adapter.notify("YouTube Premium 自动选路", "只读检查完成", `${config.targetGroup}: ${count} 个直属子项`);
        }
        $persistentStore.write("", ERROR_NOTICE_KEY);
        return;
      }

      let activeState = previousState;
      if (previousState.targetGroup && previousState.targetGroup !== config.targetGroup) {
        const warnings = [];
        await releaseOwned(previousState.owned, adapter, warnings);
        if (warnings.length) {
          try {
            await reapplyOwned(previousState.owned, adapter);
          } catch (_) {
            // Keep the restore failure as the reported error.
          }
          throw new Error(warnings.join("；"));
        }
        activeState = baseState(config.targetGroup);
        adapter.writeState(activeState);
      }

      const globalPolicies = await adapter.getGlobalPolicies();
      probeManager = createProbeManager(adapter, config, globalPolicies, activeState);
      const search = await searchPolicyTree(
        config.targetGroup,
        groups,
        selectGroups,
        probeManager.probePool,
        []
      );
      await probeManager.restoreAllTemporary();

      if (search.winner) {
        const path = search.path || [config.targetGroup];
        const owned = await applyWinner(
          path,
          search.winner.node,
          activeState,
          probeManager,
          adapter
        );
        const winner = { ...search.winner, path };
        const noticeKey = stateNoticeKey("success", winner);
        const nextState = {
          ...activeState,
          targetGroup: config.targetGroup,
          status: "success",
          owned,
          winner,
          lastNoticeKey: noticeKey,
          updatedAt: Date.now(),
        };
        adapter.writeState(nextState);
        if (shouldNotify(config, activeState, noticeKey)) {
          adapter.notify(
            "YouTube Premium 自动选路",
            `${winner.country} · ${winner.elapsed} ms`,
            `${path.concat(winner.node).join(" -> ")}\n本轮请求 ${probeManager.stats.requests} 个节点`
          );
        }
        $persistentStore.write("", ERROR_NOTICE_KEY);
        return;
      }

      const noReliableConclusion = isInconclusiveSearch(search, probeManager.stats.requests);
      if (noReliableConclusion) {
        await reapplyOwned(activeState.owned, adapter);
        const details = [];
        if (search.unknown > 0) details.push(`${search.unknown} 个结果无法确认`);
        if (search.skipped > 0) details.push(`跳过 ${search.skipped} 个非 select 策略组`);
        if (probeManager.stats.requests === 0 && !details.length) details.push("没有可检测节点");
        const detail = details.join("，");
        const noticeKey = stateNoticeKey("unknown", null, detail);
        const nextState = {
          ...activeState,
          targetGroup: config.targetGroup,
          status: "unknown",
          lastNoticeKey: noticeKey,
          updatedAt: Date.now(),
        };
        adapter.writeState(nextState);
        if (shouldNotify(config, activeState, noticeKey)) {
          adapter.notify(
            "YouTube Premium 自动选路",
            "未改变当前选择",
            `${detail}；已保留上一次策略\n本轮请求 ${probeManager.stats.requests} 个节点`
          );
        }
        $persistentStore.write("", ERROR_NOTICE_KEY);
        return;
      }

      const warnings = search.warnings.slice();
      await releaseOwned(activeState.owned, adapter, warnings);
      const restoreFailures = warnings.filter((warning) => warning.startsWith("恢复 "));
      if (restoreFailures.length) {
        try {
          await reapplyOwned(activeState.owned, adapter);
        } catch (_) {
          // Keep the restore failure as the reported error.
        }
        throw new Error(restoreFailures.join("；"));
      }
      const status = search.excluded > 0 ? "no-match" : "unavailable";
      const detail = status === "no-match" ? "没有符合地区顺序的可用节点" : "所有节点均不支持 Premium";
      const noticeKey = stateNoticeKey(status, null, detail);
      const nextState = {
        ...baseState(config.targetGroup),
        status,
        lastNoticeKey: noticeKey,
        updatedAt: Date.now(),
      };
      adapter.writeState(nextState);
      if (shouldNotify(config, activeState, noticeKey)) {
        adapter.notify(
          "YouTube Premium 自动选路",
          "已恢复接管前选择",
          `${detail}\n本轮请求 ${probeManager.stats.requests} 个节点`
        );
      }
      $persistentStore.write("", ERROR_NOTICE_KEY);
    } catch (error) {
      if (probeManager) await probeManager.restoreAllTemporary();
      adapter.log(`YouTube Premium 自动选路: ${errorMessage(error)}`);
      const compatibilityError = error && ["TARGET_NOT_FOUND", "TARGET_NOT_SELECT"].includes(error.code);
      notifyErrorOnce(
        config.runMode,
        compatibilityError ? "兼容性检查未通过，未修改策略" : "执行失败，未应用新选择",
        errorMessage(error),
        error && error.code ? error.code : "RUNTIME"
      );
    } finally {
      releaseLock(token);
    }
  }

  function errorMessage(error) {
    if (error == null) return "UNKNOWN_ERROR";
    if (typeof error === "string") return error;
    return error.message || String(error);
  }

  const exported = {
    parseArguments,
    extractCountry,
    parsePremiumResponse,
    regionRank,
    chooseCandidate,
    buildUnits,
    searchPolicyTree,
    validateTargetGroup,
    isInconclusiveSearch,
    normalizePolicyNames,
    createProbeManager,
    applyWinner,
    releaseOwned,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (typeof $done === "function" && typeof $httpClient !== "undefined") {
    runSurge()
      .catch((error) => console.log(errorMessage(error)))
      .finally(() => $done());
  }
})();
