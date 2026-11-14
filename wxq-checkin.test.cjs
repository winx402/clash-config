const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(`${__dirname}/wxq-checkin.js`, 'utf8');
const KEY = 'wxq.checkin.session.v1';
const PENDING = 'wxq.checkin.pending.v1';
const SECRET = 'TEST_PRIVATE_TOKEN_NEVER_LOG';
const url = 'https://kohcamp.qq.com/operation/action/signinfo';
const request = (extra = {}) => ({
  id: 'request-1', method: 'POST', url, body: '{}',
  headers: { mGameId: '40001', campRoleId: 'test-role', userId: 'test-user',
    msdkEncodeParam: SECRET, sig: 'test-sig', timestamp: '1700000000',
    'Content-Type': 'application/json', Host: 'kohcamp.qq.com', 'Content-Length': '2' },
  ...extra,
});
const result = (map, extra = {}) => ({ status: 200, headers: { returnCode: '0' },
  body: JSON.stringify({ weekSignMap: map }), ...extra });

async function execute({ type = 'generic', mode = 'run', store = new Map(), req,
  response, replies = [], trigger = 'editor', failWrites = false, clock = { now: Date.parse('2026-11-13T02:00:00Z') } } = {}) {
  const calls = [], logs = [], notices = [];
  let doneCount = 0;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  let resolveDone;
  const completed = new Promise(resolve => { resolveDone = resolve; });
  const context = {
    Date: FixedDate, console: { log: text => logs.push(String(text)) },
    $script: { type }, $argument: `mode=${mode}`, $trigger: trigger,
    $persistentStore: {
      read: key => store.get(key) ?? null,
      write: (value, key) => {
        if (failWrites) return false;
        if (value === null) store.delete(key); else store.set(key, value);
        return true;
      },
    },
    $notification: { post: (...args) => notices.push(args.join(' ')) },
    $done: () => { doneCount++; resolveDone(); },
    $httpClient: { post: (options, callback) => {
      calls.push(options);
      const reply = replies[calls.length - 1];
      queueMicrotask(() => {
        if (!reply) { callback('Unexpected request', null, null); return; }
        if (reply.clockAfter !== undefined) clock.now = reply.clockAfter;
        callback(reply.error || null, reply, reply.body);
      });
    } },
  };
  if (req) context.$request = req;
  if (response) context.$response = response;
  vm.runInNewContext(source, context, { timeout: 1000 });
  let timer;
  try {
    await Promise.race([completed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Script did not call $done')), 1500);
    })]);
  } finally { clearTimeout(timer); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(doneCount, 1);
  assert.ok(!JSON.stringify({ logs, notices }).includes(SECRET));
  return { store, calls, logs, notices };
}

async function capture(store = new Map(), req = request(), response = result('0000100')) {
  await execute({ type: 'http-request', store, req });
  return execute({ type: 'http-response', store, req, response });
}

test('captures only after a paired successful response; no network calls or credential logs', async () => {
  const store = new Map();
  await execute({ type: 'http-request', store, req: request() });
  assert.ok(!store.has(KEY));
  assert.ok(store.has(PENDING));
  const run = await execute({ type: 'http-response', store, req: request(), response: result('0000100') });
  const saved = JSON.parse(store.get(KEY));
  assert.equal(saved.game, '40001');
  assert.equal(saved.headers.msdkencodeparam, SECRET);
  assert.equal(saved.headers.host, undefined);
  assert.equal(saved.headers['content-length'], undefined);
  assert.equal(run.calls.length, 0);
});

test('ignores other games and foreign hosts', async () => {
  for (const req of [request({ headers: { ...request().headers, mGameId: '20001' } }),
    request({ url: 'https://kohcamp.qq.com.evil.invalid/operation/action/signinfo' }),
    request({ url: 'https://kohcamp.qq.com/operation/action/signin' })]) {
    const run = await capture(new Map(), req);
    assert.ok(!run.store.has(KEY));
    assert.equal(run.calls.length, 0);
  }
});

test('rejects incomplete role/auth and non-JSON request body without altering traffic', async () => {
  for (const req of [request({ headers: { mGameId: '40001' } }), request({ body: 'encrypted-body' })]) {
    const run = await execute({ type: 'http-request', req });
    assert.ok(!run.store.has(KEY));
    assert.equal(run.calls.length, 0);
  }
});

test('HTTP 200 with auth failure is not accepted or promoted', async () => {
  const run = await capture(new Map(), request(), result('0000100', {
    headers: { returnCode: '-30314' }, body: JSON.stringify({ code: 0, message: SECRET }),
  }));
  assert.ok(!run.store.has(KEY));
  assert.match(run.notices.join(''), /凭证失效/);
});

test('unpaired and malformed responses cannot install a session', async () => {
  const unpaired = await execute({ type: 'http-response', req: request(), response: result('0000100') });
  assert.ok(!unpaired.store.has(KEY));
  const invalid = await capture(new Map(), request(), result('0000100', { body: '<html>login</html>' }));
  assert.ok(!invalid.store.has(KEY));
});

test('a new account or role never silently overwrites the pinned account', async () => {
  const first = await capture();
  const original = first.store.get(KEY);
  await capture(first.store, request({ headers: { ...request().headers, userId: 'another-user', campRoleId: 'another-role' } }));
  assert.equal(first.store.get(KEY), original);
});

test('without credentials, cron performs no network calls', async () => {
  const run = await execute();
  assert.equal(run.calls.length, 0);
  assert.match(run.notices.join(''), /尚无有效凭证/);
});

test('already signed today uses one read request and never submits', async () => {
  const { store } = await capture();
  const run = await execute({ store, replies: [result('0000100')] });
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0].url, url);
  assert.equal(run.calls[0]['auto-redirect'], false);
  assert.equal(run.calls[0]['auto-cookie'], false);
  assert.equal(run.calls[0].insecure, undefined);
  assert.match(run.notices.join(''), /今日已签到/);
});

test('status mode never submits even when unsigned', async () => {
  const { store } = await capture();
  const run = await execute({ store, mode: 'status', replies: [result('0000000')] });
  assert.equal(run.calls.length, 1);
  assert.match(run.notices.join(''), /尚未签到/);
});

test('unsigned day submits the known role and verifies the server state afterwards', async () => {
  const { store } = await capture();
  const run = await execute({ store, replies: [result('0000000'),
    { status: 200, headers: { returnCode: '0' }, body: '{}' }, result('0000100')] });
  assert.equal(run.calls.length, 3);
  assert.equal(run.calls[1].url, 'https://kohcamp.qq.com/operation/action/signin');
  assert.deepEqual(JSON.parse(run.calls[1].body), { roleId: 'test-role' });
  assert.equal(run.calls[2].url, url);
  assert.match(run.notices.join(''), /签到成功/);
});

test('a successful submission response alone never reports success', async () => {
  const { store } = await capture();
  const run = await execute({ store, replies: [result('0000000'),
    { status: 200, headers: { returnCode: '0' }, body: '{}' }, result('0000000')] });
  assert.equal(run.calls.length, 3);
  assert.ok(!run.notices.join('').includes('签到成功'));
  assert.match(run.notices.join(''), /状态未变/);
});

test('auth, transport, redirect and schema failures stop before submission', async () => {
  for (const reply of [
    { status: 200, headers: { returnCode: '-32353' }, body: '{}' },
    { error: `Network error ${SECRET}` },
    { status: 302, headers: { location: `https://evil.invalid/${SECRET}` }, body: '{}' },
    { status: 200, headers: { returnCode: '0' }, body: '{"message":"ok"}' },
  ]) {
    const { store } = await capture();
    const run = await execute({ store, replies: [reply] });
    assert.equal(run.calls.length, 1);
    assert.ok(!run.notices.join('').includes('签到成功'));
  }
});

test('Shanghai date rolls over before submission, even when host timezone differs', async () => {
  const { store } = await capture();
  const clock = { now: Date.parse('2026-11-13T15:59:59Z') };
  const run = await execute({ store, clock, replies: [result('0000000', {
    clockAfter: Date.parse('2026-11-13T16:00:01Z'),
  })] });
  assert.equal(run.calls.length, 1);
  assert.match(run.notices.join(''), /跨日/);
});

test('Sunday uses bitmap index 6', async () => {
  const { store } = await capture();
  const run = await execute({ store, clock: { now: Date.parse('2026-11-15T02:00:00Z') }, replies: [result('0000001')] });
  assert.equal(run.calls.length, 1);
  assert.match(run.notices.join(''), /今日已签到/);
});

test('old Monday bit cannot confirm a new week when a Sunday query crosses midnight', async () => {
  const { store } = await capture();
  const clock = { now: Date.parse('2026-11-15T15:59:59Z') };
  const run = await execute({ store, clock, replies: [result('1000000', {
    clockAfter: Date.parse('2026-11-15T16:00:01Z'),
  })] });
  assert.equal(run.calls.length, 1);
  assert.match(run.notices.join(''), /跨日/);
  assert.ok(!run.notices.join('').includes('今日已签到'));
});

test('an active run is not duplicated; clear mode removes credential data', async () => {
  const { store } = await capture();
  store.set('wxq.checkin.lock.v1', JSON.stringify({ owner: 'other', time: Date.parse('2026-11-13T02:00:00Z') }));
  const skipped = await execute({ store });
  assert.equal(skipped.calls.length, 0);
  const blockedClear = await execute({ store, mode: 'clear' });
  assert.ok(blockedClear.store.has(KEY));
  store.delete('wxq.checkin.lock.v1');
  const cleared = await execute({ store, mode: 'clear' });
  assert.ok(!cleared.store.has(KEY));
  assert.ok(!cleared.store.has(PENDING));
});

test('persistent-store failure still completes the intercepted request', async () => {
  const run = await execute({ type: 'http-request', req: request(), failWrites: true });
  assert.equal(run.calls.length, 0);
});
