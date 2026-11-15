const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/wxq-checkin-daily.js`, 'utf8');
const legacy = fs.readFileSync(`${__dirname}/wxq-checkin.js`, 'utf8');
const KEY = 'wxq.checkin.session.v1', STATE = 'wxq.checkin.daily.v1';
const INFO = 'https://kohcamp.qq.com/operation/action/signinfo';
const OLD = 'PRIVATE_OLD_TOKEN', NEW = 'PRIVATE_NEW_TOKEN';
const session = () => ({ url: INFO, headers: { gameid: '30001', camproleid: 'camp-role', roleid: 'native-role', userid: 'camp-user',
  openid: 'camp-open', appid: 'camp-app', token: OLD, msdkencodeparam: OLD, sig: OLD, timestamp: '100', encode: '2', 'content-type': 'application/json' },
  body: '{"cSystem":"ios","h5Get":1,"gameId":"30001"}', role: 'camp-role', signRole: 'native-role', signGame: '30001', identity: 'camp-user', appid: 'camp-app', game: '30001', capturedAt: 100 });
const storeFor = s => new Map([[KEY, JSON.stringify(s || session())]]);
const page = (q = `userId=camp-user&msdkEncodeParam=${NEW}&sig=new-sig&timestamp=200&encode=2`, h = {}) => ({ method: 'GET',
  url: `https://camp.qq.com/h5/webdist/news/index.html?${q}`, headers: { Accept: 'text/html,application/xhtml+xml', ...h } });
const html = { status: 200, headers: { 'Content-Type': 'text/html;charset=utf-8' } };
const success = (body = { returnCode: 0, data: { weekSignMap: '0000100' } }, headers = {}) => ({ status: 200, headers, body: JSON.stringify(body) });
function run({ store = storeFor(), req = page(), res = html, type = 'http-response', failWrite = () => false, code = source } = {}) {
  const calls = [], logs = [], notices = [], callbacks = [], timers = new Map();
  let done = 0, nextTimer = 1;
  const ctx = { console: { log: x => logs.push(String(x)) }, $script: { type }, $argument: code === legacy ? 'mode=status' : 'mode=diagnostic',
    $request: req, $response: res, $done: out => { done++; assert.deepEqual(Object.keys(out), []); },
    setTimeout: fn => { const id = nextTimer++; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    $persistentStore: { read: key => store.get(key) ?? null, write: (value, key) => { if (failWrite(key)) return false; store.set(key, value); return true; } },
    $notification: { post: (...args) => notices.push(args.join(' ')) },
    $httpClient: { post: (options, cb) => { calls.push(options); callbacks.push(cb); } },
  };
  vm.runInNewContext(code, ctx);
  return { store, calls, callbacks, timers, logs, notices, get done() { return done; },
    reply(response = success(), error = null) { callbacks.shift()(error, response, response && response.body); },
    expire() { [...timers.values()].forEach(fn => fn()); },
    diag() { return JSON.parse(store.get(STATE)); },
    saved() { return JSON.parse(store.get(KEY)); },
    privacy() { assert.ok(!JSON.stringify({ logs, notices, state: this.diag() }).includes(OLD)); assert.ok(!JSON.stringify({ logs, notices, state: this.diag() }).includes(NEW)); assert.ok(!JSON.stringify({ logs, notices, state: this.diag() }).includes('https://')); },
  };
}

test('opt-in module only MITMs camp.qq.com, no request hook, body buffering or cron; old URLs untouched', () => {
  const module = fs.readFileSync(`${__dirname}/wxq-checkin-daily.sgmodule`, 'utf8');
  assert.match(module, /hostname = %APPEND% camp\.qq\.com\n/);
  assert.doesNotMatch(module, /hostname.*kohcamp|type=http-request|type=cron|requires-body=true/);
  assert.match(module, /requires-body=false/);
  assert.match(module, /万象棋日常刷新诊断 = type=generic/);
  const pattern = new RegExp(module.match(/pattern=(.*?),requires-body/)[1]);
  assert.ok(pattern.test(page().url));
  for (const u of ['https://camp.qq.com/h5/static/a.js?x=1', 'https://camp.qq.com/h5/a.css', INFO, 'https://camp.qq.com.evil/h5/index.html', 'https://camp.qq.com/api/index.html']) assert.ok(!pattern.test(u));
});

test('same-account ordinary page validates fresh-only signed credentials and preserves all bindings', () => {
  const r = run(); assert.equal(r.calls.length, 1); assert.equal(r.done, 0); assert.equal(r.diag().code, 'validating');
  const call = r.calls[0]; assert.equal(call.url, INFO); assert.equal(call.timeout, 3); assert.equal(call['auto-cookie'], false); assert.equal(call['auto-redirect'], false);
  assert.equal(call.headers.msdkencodeparam, NEW); assert.equal(call.headers.token, undefined); assert.ok(!JSON.stringify(call).includes(OLD));
  r.reply(); assert.equal(r.done, 1); assert.equal(r.diag().code, 'updated');
  for (const k of ['role','signRole','signGame','identity','appid','game']) assert.equal(r.saved()[k], session()[k]);
  r.privacy();
});

test('pure candidate drops credentials from original URL/body/header alternative paths', () => {
  const s = session(); s.url += `?token=${OLD}`; s.body = JSON.stringify({ ...JSON.parse(s.body), token: OLD, Authorization: OLD });
  s.headers.cookie = `token=${OLD}`; s.headers.authorization = OLD; s.headers.gametoken = OLD; s.headers['x-unknown-auth'] = OLD; s.headers.referer = `https://x/?token=${OLD}`;
  const r = run({store: storeFor(s)}); assert.equal(r.calls.length, 1); assert.ok(!JSON.stringify(r.calls[0]).includes(OLD)); r.reply(); assert.equal(r.diag().code, 'updated'); r.privacy();
});

test('request header and whitelisted cookie tokens require a matching query account', () => {
  for (const headers of [{ msdkToken: NEW }, { Cookie: `unrelated=x; token=${NEW}` }]) {
    const r = run({req: page('userId=camp-user', headers)}); assert.equal(r.calls.length, 1); r.reply(); assert.equal(r.diag().code, 'updated'); assert.equal(r.saved().headers.cookie, undefined); r.privacy();
    const noIdentity = run({req: page('', headers)}); assert.equal(noIdentity.calls.length, 0); assert.equal(noIdentity.diag().code, 'account');
  }
});

test('does not supplement partial query signature using old or alternate new tokens', () => {
  for (const q of [`userId=camp-user&msdkEncodeParam=${NEW}`, `userId=camp-user&msdkEncodeParam=${NEW}&sig=s&timestamp=NaN`]) {
    const r = run({req: page(q, {token: NEW})}); assert.equal(r.calls.length, 0); assert.ok(['conflict','empty'].includes(r.diag().code));
  }
});

test('account-only ordinary page can refresh despite having another non-WXQ role', () => {
  const r = run({req: page(`userId=camp-user&gameId=50001&roleId=other-role&uniqueRoleId=other-unique&token=${NEW}`)});
  assert.equal(r.calls.length, 1); r.reply(); assert.equal(r.saved().role, 'camp-role'); assert.equal(r.saved().signRole, 'native-role');
});

test('never equates ordinary page roleId/uniqueRoleId with an account', () => {
  for (const q of [`roleId=camp-user&token=${NEW}`, `uniqueRoleId=camp-role&token=${NEW}`, `userId=other&token=${NEW}`, `openId=other&token=${NEW}`,
    `userId=camp-user&appid=other&token=${NEW}`, `userId=camp-user&openId=other&token=${NEW}`, `userId=camp-user&gameId=30001&uniqueRoleId=other&token=${NEW}`]) {
    const store = storeFor(), before = store.get(KEY); const r = run({store,req:page(q)}); assert.equal(r.calls.length,0); assert.equal(store.get(KEY),before); r.privacy();
  }
});

test('role-only captured template only accepts an explicitly matching WXQ role page', () => {
  const s = session(); delete s.headers.userid; delete s.headers.openid; s.identity = s.role;
  const r = run({store:storeFor(s)}); assert.equal(r.calls.length,0); assert.equal(r.diag().code,'account');
  const yes = run({store:storeFor(s),req:page(`gameId=30001&uniqueRoleId=camp-role&roleId=native-role&token=${NEW}`)}); assert.equal(yes.calls.length,1); yes.reply(); assert.equal(yes.diag().code,'updated');
});

test('missing params are counted as observation and remain visible to offline diagnosis', () => {
  const r = run({req:page(''),store:new Map()}); assert.equal(r.calls.length,0); assert.equal(r.diag().code,'empty'); assert.equal(r.diag().pages,1); assert.equal(r.done,1);
  const before = JSON.stringify([...r.store]); const d = run({store:r.store,type:'generic'}); assert.equal(d.calls.length,0); assert.equal(JSON.stringify([...r.store]),before); assert.match(d.notices.join(''),/没有支持的认证参数/); d.privacy();
});

test('without any observed page the diagnostic is read-only and explicitly says so', () => {
  const store = new Map(), r = run({store,type:'generic'}); assert.equal(store.size,0); assert.equal(r.done,1); assert.match(r.logs.join(''),/尚未看到/); assert.equal(r.calls.length,0);
});

test('ignores resources, fetches, iframes, non-html, foreign hosts and unrelated paths', () => {
  for (const {req,res} of [
    {req:{...page(),url:'https://camp.qq.com/h5/static/a.js?token=x'}},
    {req:page(undefined,{'Sec-Fetch-Dest':'iframe'})}, {req:page(undefined,{'Sec-Fetch-Mode':'cors'})},
    {req:page(undefined,{Accept:'application/json'})}, {req:{...page(),method:'POST'}},
    {req:{...page(),url:page().url.replace('camp.qq.com','camp.qq.com.evil')}},
    {req:{...page(),url:page().url.replace('/h5/','/web/')}}, {res:{status:302,headers:html.headers}},
    {res:{status:200,headers:{'Content-Type':'application/javascript'}}},
  ]) {const r=run({req:req||page(),res:res||html});assert.equal(r.calls.length,0);if (r.store.has(STATE)) assert.equal(r.diag().code,'filtered');assert.equal(r.done,1);}
});

test('malformed/mixed identities and duplicate query fields never make a request', () => {
  for (const q of [`userId=camp-user&userId=camp-user&token=${NEW}`,`userId=camp-user&token=%ZZ`,`userId=camp-user&token=x%0D%0AY`, `userId=camp-user&gameId=30001&mGameId=50001&token=${NEW}`]) {
    const r=run({req:page(q)});assert.equal(r.calls.length,0);assert.equal(r.done,1);
  }
  const r=run({req:page(undefined,{userid:'different'})});assert.equal(r.calls.length,0);assert.equal(r.diag().code,'mismatch');
});

test('refuses absent, corrupt, inconsistent and wrong-game templates', () => {
  for (const modify of [s=>{s.game='20001'},s=>{s.headers.camproleid='other'},s=>{s.signRole='other'},s=>{s.signGame=30001},s=>{s.body='null'},s=>{s.identity='other'},s=>{s.appid='other'}]) {
    const s=session();modify(s);const r=run({store:storeFor(s)});assert.equal(r.calls.length,0);assert.equal(r.diag().code,'template');
  }
  const r=run({store:new Map()});assert.equal(r.diag().code,'template');assert.equal(r.calls.length,0);
});

test('strict validation requires HTTP 200 explicit all-zero business codes and exact seven-day map', () => {
  const replies=[success({data:{weekSignMap:'0000000'}}),success({returnCode:0,data:{weekSignMap:'111111'}}),success({returnCode:0,data:{weekSignMap:'1111113'}}),
    success({returnCode:0,code:-30314,data:{weekSignMap:'0000000'}}),success({returnCode:0,data:{weekSignMap:'0000000'}},{returncode:'-1'}),
    success({returnCode:'ok',data:{weekSignMap:'0000000'}}),{status:302,headers:{},body:success().body},{status:200,headers:{},body:'<html>login</html>'}];
  for(const reply of replies){const r=run(),before=r.store.get(KEY);r.reply(reply);assert.ok(['business','map','nocode','codeformat','http','nonjson'].includes(r.diag().code));assert.equal(r.store.get(KEY),before);assert.equal(r.done,1);r.privacy();}
});

test('same credentials get a real first query and a distinct same result; subsequent one-minute same event skips query', () => {
  const s=session();s.headers={gameid:'30001',camproleid:'camp-role',roleid:'native-role',userid:'camp-user',appid:'camp-app',token:NEW,'content-type':'application/json'};
  const store=storeFor(s),before=store.get(KEY),r=run({store,req:page(`userId=camp-user&token=${NEW}`)});
  assert.equal(r.calls.length,1);r.reply();assert.equal(r.diag().code,'wrapped');assert.equal(r.saved().headers.token,NEW);
  const next=run({store,req:page(`userId=camp-user&token=${NEW}`)});assert.equal(next.calls.length,0);assert.equal(next.diag().code,'recent');assert.equal(next.done,1);assert.equal(r.saved().headers.token,NEW);
});

test('a failed same-credential first verification cannot create a throttle success', () => {
  const s=session();s.headers.token=NEW;delete s.headers.msdkencodeparam;delete s.headers.sig;delete s.headers.timestamp;delete s.headers.encode;
  const store=storeFor(s),r=run({store,req:page(`userId=camp-user&token=${NEW}`)});r.reply(success({returnCode:-30314}));assert.equal(r.diag().code,'business');
  assert.equal(run({store,req:page(`userId=camp-user&token=${NEW}`)}).calls.length,1);
});

test('clear, recapture or new page invalidates pending old callback; newest candidate wins out of order', () => {
  for(const mutate of [store=>store.delete(KEY),store=>store.set(KEY,JSON.stringify({...session(),capturedAt:200})),store=>run({store,req:page('')})]) {
    const store=storeFor(),r=run({store});mutate(store);const before=store.get(KEY);r.reply();assert.equal(store.get(KEY),before);assert.equal(r.done,1);r.privacy();
  }
  const store=storeFor(),first=run({store}),second=run({store,req:page('userId=camp-user&token=NEWEST')});
  second.reply();const latest=store.get(KEY);first.reply();assert.equal(store.get(KEY),latest);assert.equal(JSON.parse(latest).headers.token,'NEWEST');
});

test('deadline passes page unchanged and any later HTTP callback is inert', () => {
  const r=run(),before=r.store.get(KEY);r.expire();assert.equal(r.done,1);assert.equal(r.diag().code,'timeout');r.reply();assert.equal(r.done,1);assert.equal(r.store.get(KEY),before);assert.equal(r.diag().code,'timeout');
});

test('network failures and storage failures never claim a successful update', () => {
  const r=run(),before=r.store.get(KEY);r.reply(null,'PRIVATE error including '+NEW);assert.equal(r.diag().code,'network');assert.equal(r.store.get(KEY),before);r.privacy();
  const fail=run({failWrite:k=>k===KEY});fail.reply();assert.equal(fail.diag().code,'storage');assert.equal(fail.saved().headers.token,OLD);assert.equal(fail.done,1);
  const all=run({failWrite:()=>true});assert.equal(all.done,1);assert.equal(all.calls.length,0);
});

test('saved candidate remains structurally compatible with original status task', async () => {
  const r=run();r.reply();
  const old=run({store:r.store,code:legacy,type:'generic'});assert.equal(old.calls.length,1);assert.equal(old.calls[0].headers.msdkencodeparam,NEW);assert.equal(old.calls[0].url,INFO);
  old.reply();await new Promise(resolve=>setImmediate(resolve));assert.equal(old.done,1);assert.match(old.notices.join(''),/查询成功|今日已签到/);
});

test('body-only roleId stays compatible with original status validation', async () => {
  const s=session();delete s.headers.roleid;s.body=JSON.stringify({...JSON.parse(s.body),roleId:'native-role'});
  const r=run({store:storeFor(s)});r.reply();assert.equal(JSON.parse(r.saved().body).roleId,'native-role');
  const old=run({store:r.store,code:legacy,type:'generic'});assert.equal(old.calls.length,1);old.reply();await new Promise(resolve=>setImmediate(resolve));assert.equal(old.done,1);
});

test('combines signed companion fields from this request without letting query metadata shadow header auth', () => {
  for(const [q,h] of [
    ['userId=camp-user&encode=2',{msdkToken:NEW}],
    ['userId=camp-user&msdkEncodeParam='+NEW,{sig:'new-sig',timestamp:'200'}],
    ['userId=camp-user&sig=new-sig&timestamp=200',{msdkEncodeParam:NEW}],
  ]) {const r=run({req:page(q,h)});assert.equal(r.calls.length,1);assert.ok(!JSON.stringify(r.calls[0]).includes(OLD));r.reply();assert.equal(r.diag().code,'updated');}
  const bad=run({req:page(undefined,{msdkEncodeParam:'CONFLICT'})});assert.equal(bad.calls.length,0);assert.equal(bad.diag().code,'conflict');
});

test('304 cached document requires explicit top-level navigation and HTML accept', () => {
  const res={status:304,headers:{}};
  const r=run({req:page(undefined,{'Sec-Fetch-Dest':'document','Sec-Fetch-Mode':'navigate'}),res});assert.equal(r.calls.length,1);r.reply();assert.equal(r.diag().code,'updated');
  for(const h of [{},{'Sec-Fetch-Dest':'iframe','Sec-Fetch-Mode':'navigate'},{'Sec-Fetch-Dest':'document','Sec-Fetch-Mode':'cors'},{'Sec-Fetch-Dest':'document','Sec-Fetch-Mode':'navigate',Accept:'application/json'}]) {
    const no=run({req:page(undefined,h),res});assert.equal(no.calls.length,0);assert.equal(no.diag().code,'filtered');
  }
});

test('empty later pages preserve most recent validation progress and safe field categories', () => {
  const store=storeFor(),r=run({store});r.reply();const verified=r.diag().progress;
  const empty=run({store,req:page('')});assert.equal(empty.diag().code,'empty');assert.deepEqual(empty.diag().progress,verified);assert.equal(empty.diag().fields.querySigned,false);
  const diag=run({store,type:'generic'});assert.match(diag.logs.join(''),/最近验证进度：验证通过，已更新/);diag.privacy();
});

test('comparable signed timestamp cannot regress, including seconds versus milliseconds', () => {
  for (const [oldTime,newTime,reject] of [['1800000000','1700000000000',true],['1800000000000','1700000000',true],['1700000000','1800000000000',false],['1700000000000','1800000000',false]]) {
    const s=session();s.headers.timestamp=oldTime;const store=storeFor(s),before=store.get(KEY);
    const r=run({store,req:page(`userId=camp-user&msdkEncodeParam=${NEW}&sig=new&timestamp=${newTime}`)});
    if(reject){assert.equal(r.calls.length,0);assert.equal(r.diag().code,'older');assert.equal(store.get(KEY),before);}else{assert.equal(r.calls.length,1);r.reply();assert.equal(r.diag().code,'updated');}
  }
});

test('opaque token has no inferred timestamp ordering', () => {
  const s=session();s.headers.timestamp='9999999999999';const r=run({store:storeFor(s),req:page(`userId=camp-user&token=${NEW}`)});assert.equal(r.calls.length,1);r.reply();assert.equal(r.diag().code,'updated');
});

test('path-only filtered events retain anonymous reason/count without reading malformed query', () => {
  const r=run({req:page('token=%ZZ',{Accept:'application/json'} )});assert.equal(r.done,1);assert.equal(r.diag().code,'filtered');assert.equal(r.diag().filterReason,'html-accept');assert.equal(r.diag().filtered,1);assert.equal(r.diag().fields,undefined);r.privacy();
});

test('official transport constants and known template common metadata survive without old auth alternatives', () => {
  const s=session();Object.assign(s.headers,{source:'app',cSystem:'ios',h5Get:'1',gameOpenid:'game-open',areaId:'1',serverId:'2',customPath:'DO_NOT_COPY',token:OLD});
  const r=run({store:storeFor(s)}),h=r.calls[0].headers;
  assert.equal(h['accept-encrypt'],'');assert.equal(h.noencrypt,'1');assert.equal(h['x-client-proto'],'https');
  for(const k of ['source','csystem','h5get','gameopenid','areaid','serverid'])assert.ok(h[k]);
  assert.equal(h.custompath,undefined);assert.ok(!JSON.stringify(r.calls[0]).includes(OLD));r.reply();r.privacy();
});

test('template query keeps only bounded routing and still removes all old URL authentication', () => {
  const s=session();s.url+=`?routing=operation-v1&token=${OLD}&sig=${OLD}&arbitrary=${OLD}`;
  const r=run({store:storeFor(s)});assert.equal(r.calls[0].url,INFO+'?routing=operation-v1');assert.ok(!JSON.stringify(r.calls[0]).includes(OLD));r.reply();
  const bad=session();bad.url+='?routing=https%3A%2F%2Fevil.invalid%2F&token='+OLD;
  const no=run({store:storeFor(bad)});assert.equal(no.calls[0].url,INFO);
});

test('query signature decode follows official qs: encoded plus, literal plus and encoded percent', () => {
  for(const [encoded,expected] of [['a%2Bb%2Fc%3D','a+b/c='],['a+b','a b'],['a%252Bb','a%2Bb']]){
    const r=run({req:page('userId=camp-user&msdkEncodeParam='+encoded+'&sig=s&timestamp=200')});assert.equal(r.calls[0].headers.msdkencodeparam,expected);r.reply();
  }
});

test('safe result diagnostics distinguish network, HTTP, JSON, business, missing code and missing map', () => {
  for(const [reply,expected,status,code] of [
    [{status:503,headers:{},body:'anything'},'http',503,null],
    [{status:200,headers:{},body:'<html>PRIVATE '+NEW+'</html>'},'nonjson',200,null],
    [success({returnCode:-30314,message:NEW}),'business',200,-30314],
    [success({returnCode:NEW}),'codeformat',200,null],
    [success({data:{weekSignMap:'0000000'}}),'nocode',200,null],
    [success({returnCode:0,data:{}}),'map',200,0],
  ]) {const r=run();r.reply(reply);assert.equal(r.diag().code,expected);assert.equal(r.diag().validation.httpStatus,status);assert.equal(r.diag().validation.businessCode,code);const d=run({store:r.store,type:'generic'});d.privacy();}
});

test('new response tokens are saved only following strict same-account pure-candidate success', () => {
  const r=run();r.reply(success(undefined,{msdktoken:'NEW_RESPONSE_TOKEN',gametoken:'NEW_GAME_TOKEN'}));
  assert.equal(r.saved().headers.msdktoken,'NEW_RESPONSE_TOKEN');assert.equal(r.saved().headers.gametoken,'NEW_GAME_TOKEN');assert.equal(r.saved().headers.token,undefined);assert.equal(r.diag().code,'updated');r.privacy();
  const failed=run(),before=failed.store.get(KEY);failed.reply(success({returnCode:-30314},{msdktoken:NEW,gametoken:NEW}));assert.equal(failed.store.get(KEY),before);assert.equal(failed.diag().code,'business');
});

test('same candidate with renewed response token reports an actual update', () => {
  const s=session();s.headers.token=NEW;delete s.headers.msdkencodeparam;delete s.headers.sig;delete s.headers.timestamp;delete s.headers.encode;
  const r=run({store:storeFor(s),req:page('userId=camp-user&token='+NEW)});r.reply(success(undefined,{msdktoken:'NEW_RESPONSE_TOKEN'}));assert.equal(r.diag().code,'updated');assert.equal(r.saved().headers.msdktoken,'NEW_RESPONSE_TOKEN');
});
