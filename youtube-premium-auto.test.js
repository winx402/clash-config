const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const core = require("./youtube-premium-auto-surge.js");

test("declares two Surge module arguments with compatible placeholders", () => {
  const moduleText = fs.readFileSync(
    path.join(__dirname, "youtube-premium-auto.sgmodule"),
    "utf8"
  );
  assert.match(
    moduleText,
    /^#!arguments=TARGET_GROUP:Youtube,REGION_ORDER:"sg,jp,us,other"$/m
  );
  assert.match(moduleText, /TARGET_GROUP=\{\{\{TARGET_GROUP\}\}\}/);
  assert.match(moduleText, /REGION_ORDER=\{\{\{REGION_ORDER\}\}\}/);
  assert.doesNotMatch(moduleText, /%(?:TARGET_GROUP|REGION_ORDER)%/);
});

function node(name, enabled = true) {
  return { name, isGroup: false, enabled };
}

function group(name, enabled = true) {
  return { name, isGroup: true, enabled };
}

function supported(country) {
  return `{"INNERTUBE_CONTEXT_GL":"${country}","purchaseButton":{}}`;
}

test("parses the two public arguments and arbitrary country codes", () => {
  assert.deepEqual(core.parseArguments("TARGET_GROUP=Video&REGION_ORDER=tw,gb,other&RUN_MODE=manual"), {
    targetGroup: "Video",
    regionOrder: ["tw", "gb", "other"],
    runMode: "manual",
    dryRun: false,
  });
  assert.throws(() => core.parseArguments("TARGET_GROUP=Video&REGION_ORDER=sg,sg"), /重复/);
  assert.throws(() => core.parseArguments("TARGET_GROUP=&REGION_ORDER=sg"), /不能为空/);
  assert.deepEqual(
    core.parseArguments("TARGET_GROUP=Media&A&B&REGION_ORDER=sg,other&RUN_MODE=cron&DRY_RUN=true"),
    {
      targetGroup: "Media&A&B",
      regionOrder: ["sg", "other"],
      runMode: "cron",
      dryRun: true,
    }
  );
});

test("classifies supported, unavailable, consent, and malformed Premium pages", () => {
  assert.deepEqual(core.parsePremiumResponse(200, supported("JP")), {
    status: "supported",
    country: "JP",
    reason: "OK",
  });
  const unavailable =
    '{"INNERTUBE_CONTEXT_GL":"US","title":{"content":"YouTube Premium is not available in your country"}}';
  assert.equal(core.parsePremiumResponse(200, unavailable).status, "unavailable");
  assert.equal(core.parsePremiumResponse(200, "Before you continue to YouTube").reason, "CONSENT_REQUIRED");
  assert.equal(core.parsePremiumResponse(200, "{}").reason, "COUNTRY_NOT_FOUND");
  assert.equal(core.parsePremiumResponse(429, supported("SG")).reason, "HTTP_429");
});

test("does not mistake normal YouTube challenge assets for a challenge page", () => {
  const normalPage = `${supported("JP")} recaptcha challenge-form`;
  assert.equal(core.parsePremiumResponse(200, normalPage).status, "supported");
  assert.equal(
    core.parsePremiumResponse(
      200,
      '<title>Sorry...</title><form id="captcha-form" action="/sorry/index">'
    ).reason,
    "GOOGLE_CHALLENGE"
  );
});

test("ranks country before elapsed time and uses node order as final tie breaker", () => {
  const winner = core.chooseCandidate(
    [
      { status: "supported", country: "US", elapsed: 20, order: 0, node: "us" },
      { status: "supported", country: "SG", elapsed: 80, order: 2, node: "sg-2" },
      { status: "supported", country: "SG", elapsed: 80, order: 1, node: "sg-1" },
    ],
    ["sg", "jp", "us", "other"]
  );
  assert.equal(winner.node, "sg-1");
});

test("groups all direct nodes at their first appearance", () => {
  const units = core.buildUnits([node("a"), group("child"), node("b"), group("last")]);
  assert.deepEqual(
    units.map((unit) => unit.type === "nodes" ? unit.nodes.map((entry) => entry.name) : unit.name),
    [["a", "b"], "child", "last"]
  );
});

test("rejects missing or non-select targets before any policy operation", () => {
  const groups = { Auto: [node("a")], Manual: [node("b")] };
  const selectGroups = new Set(["Manual"]);
  const operations = [];
  assert.throws(() => core.validateTargetGroup(groups, selectGroups, "Missing"), /未找到/);
  assert.throws(() => core.validateTargetGroup(groups, selectGroups, "Auto"), /不是 select/);
  assert.doesNotThrow(() => core.validateTargetGroup(groups, selectGroups, "Manual"));
  assert.deepEqual(operations, []);
});

test("keeps child group order ahead of global region preference", async () => {
  const calls = [];
  const groups = {
    Root: [group("First"), group("Second")],
    First: [node("us")],
    Second: [node("sg")],
  };
  const result = await core.searchPolicyTree(
    "Root",
    groups,
    new Set(["Root", "First", "Second"]),
    async (parent) => {
      calls.push(parent);
      const country = parent === "First" ? "US" : "SG";
      return {
        winner: { node: country.toLowerCase(), country, elapsed: 10, status: "supported" },
        supported: 1,
        unavailable: 0,
        unknown: 0,
        excluded: 0,
        considered: 1,
        warnings: [],
      };
    }
  );
  assert.equal(result.winner.node, "us");
  assert.deepEqual(result.path, ["Root", "First"]);
  assert.deepEqual(calls, ["First"]);
});

test("skips an automatic subtree and continues to a later select group", async () => {
  const groups = {
    Root: [group("Auto"), group("Manual")],
    Auto: [node("must-not-run")],
    Manual: [node("usable")],
  };
  const calls = [];
  const result = await core.searchPolicyTree(
    "Root",
    groups,
    new Set(["Root", "Manual"]),
    async (parent) => {
      calls.push(parent);
      return {
        winner: { node: "usable", country: "SG", elapsed: 12, status: "supported" },
        supported: 1,
        unavailable: 0,
        unknown: 0,
        excluded: 0,
        skipped: 0,
        considered: 1,
        warnings: [],
      };
    }
  );
  assert.equal(result.winner.node, "usable");
  assert.equal(result.skipped, 1);
  assert.deepEqual(calls, ["Manual"]);
});

test("treats skipped automatic groups as an inconclusive all-fail result", () => {
  assert.equal(core.isInconclusiveSearch({ unknown: 0, skipped: 1 }, 3), true);
  assert.equal(core.isInconclusiveSearch({ unknown: 1, skipped: 0 }, 3), true);
  assert.equal(core.isInconclusiveSearch({ unknown: 0, skipped: 0 }, 0), true);
  assert.equal(core.isInconclusiveSearch({ unknown: 0, skipped: 0 }, 3), false);
});

test("continues after a cycle and can select a later direct-node pool", async () => {
  const groups = {
    Root: [group("Nested")],
    Nested: [group("Root"), node("usable")],
  };
  const result = await core.searchPolicyTree(
    "Root",
    groups,
    new Set(["Root", "Nested"]),
    async (parent) => ({
      winner: { node: "usable", country: "SG", elapsed: 15, status: "supported" },
      supported: 1,
      unavailable: 0,
      unknown: 0,
      excluded: 0,
      skipped: 0,
      considered: 1,
      warnings: [`probed:${parent}`],
    })
  );
  assert.equal(result.winner.node, "usable");
  assert.deepEqual(result.path, ["Root", "Nested"]);
  assert.ok(result.warnings.some((warning) => warning.includes("循环策略组")));
});

test("probes a repeated group-scoped node only once and restores temporary overrides", async () => {
  const requests = [];
  const selections = { A: "native-a", B: "native-b" };
  const operations = [];
  const adapter = {
    getGroupSelection: async (name) => selections[name],
    setGroupPolicy: async (name, value) => {
      operations.push([name, value]);
      selections[name] = value;
    },
    requestPremium: async (policy, nodeName) => {
      requests.push([policy, nodeName]);
      return { status: 200, body: supported("SG"), elapsed: 20 };
    },
    sleep: async () => {},
  };
  const manager = core.createProbeManager(
    adapter,
    { regionOrder: ["sg", "other"] },
    new Set(),
    { owned: [] }
  );
  await manager.probePool("A", [{ name: "same", order: 0 }]);
  await manager.probePool("B", [{ name: "same", order: 0 }]);
  assert.equal(requests.length, 1);
  assert.deepEqual(operations, [
    ["A", "same"],
    ["A", "native-a"],
  ]);
});

test("applies a nested winner deepest-first and releases stale owned groups", async () => {
  const operations = [];
  const adapter = {
    getGroupSelection: async (name) => `baseline-${name}`,
    setGroupPolicy: async (name, value) => operations.push(["set", name, value]),
  };
  const previous = {
    owned: [{ group: "Old", baseline: "old-native", selected: "old-node" }],
  };
  const manager = { getSnapshot: () => null };
  const owned = await core.applyWinner(["Root", "Child"], "Node", previous, manager, adapter);
  assert.deepEqual(operations, [
    ["set", "Old", "old-native"],
    ["set", "Child", "Node"],
    ["set", "Root", "Child"],
  ]);
  assert.deepEqual(owned.map((entry) => [entry.group, entry.selected]), [
    ["Root", "Child"],
    ["Child", "Node"],
  ]);
});

test("restores every owned select group to its recorded baseline", async () => {
  const operations = [];
  const adapter = {
    setGroupPolicy: async (name, value) => operations.push(["set", name, value]),
  };
  await core.releaseOwned(
    [
      { group: "Outer", baseline: "Before" },
      { group: "Inner", baseline: "InnerBefore" },
    ],
    adapter
  );
  assert.deepEqual(operations, [
    ["set", "Inner", "InnerBefore"],
    ["set", "Outer", "Before"],
  ]);
});
