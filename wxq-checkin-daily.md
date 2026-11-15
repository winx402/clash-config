# 万象棋日常页面刷新（独立实验模块）

这是在原签到模块之外自选开启的尝试：日常打开营地网页时，若同一请求带有可证明属于已存账号的认证字段，就用纯候选凭证向官方 `signinfo` 做一次只读查询。仅明确业务成功且返回七位签到图时，才刷新本机原有会话。它不发起登录、不生成票据、不提交签到。原主模块、脚本地址、定时任务、手动任务及持久键均保持兼容。

**它不能覆盖所有日常交互。** 原生界面、离线缓存、没有参数的页面，以及不携带可比账号字段的页面都可能无法刷新。开启后是否能减少手动捕获次数，需在这台 iPhone 的实际页面和跨日使用中验证，不能据模拟测试承诺长期有效。

## 安装与手机诊断

保留[原签到模块](https://raw.githubusercontent.com/winx402/clash-config/main/wxq-checkin.sgmodule)，另安装并启用[日常页面刷新模块](https://raw.githubusercontent.com/winx402/clash-config/main/wxq-checkin-daily.sgmodule)。脚本为[独立 daily.js](https://raw.githubusercontent.com/winx402/clash-config/main/wxq-checkin-daily.js)。无需更换旧版主脚本；临时捕获模块仍仅在先完成登录后短暂使用，捕获后停用。

本模块需要 Surge MITM 已配置且证书已被 iOS 信任。**MITM 的 TLS 解密覆盖整个 `camp.qq.com`，脚本只处理其中 `/h5/` 的 HTML 文档路径；不会将 `kohcamp.qq.com` 加入 MITM。** 若网页或登录出现异常，停用本独立模块并应用配置即可回退；原已存凭证保留。其他配置来源若仍启用 `kohcamp.qq.com` MITM，需要单独核对来源。

先在 Surge 手动运行“万象棋日常刷新诊断”，再日常浏览营地，最后重跑该诊断。此任务只读取本地静态诊断，**不访问网络、不更改凭证、不签到**。它显示以下有限信息：

- 是否看到了符合条件的网页文档、文档计数；匹配 HTML 路径但被过滤的次数和固定原因（例如文档类型、导航元数据、HTML Accept）。
- query 签名组/token、请求头签名组/token、白名单 Cookie token、账号字段是否存在，仅“有/无”，不显示值或 URL。
- 无参数、缺模板、账号不可证明/不匹配、签名较旧、候选开始验证、网络失败、HTTP 状态不成功、非 JSON、纯数字业务错误码、无业务码、缺七日图或超时、验证通过已更新、验证通过但凭证相同。
- 最近一次验证进度及时间。后来的空页面不会遮掉此前验证结果。

若仍是“尚未看到符合条件的营地网页文档入口”，可能未发生匹配网页请求、走了离线缓存、TLS 未解密、脚本未下载，或其他规则抢先匹配；仅靠这个负结果无法区分原因。不要因此把 MITM 扩大到其他域。若能看到匹配路径但被过滤的固定原因，可反馈该诊断文字；无需提供参数、Cookie、认证头或完整 URL。

同一凭证第一次也会真正查询，并明确显示“验证通过，凭证相同；未伪报更新”。一分钟内同一份已验证凭证可跳过重复网络验证；会明确显示“近期已验证；本次未发起查询”。更新后可再运行原模块“万象棋只查状态”，在旧任务路径上独立验证。

## 边界与保护

普通营地页的 `userId` / `openid` 需要能与原模板的同名账号字段匹配；已有字段若冲突直接拒绝。`roleId` 和 `uniqueRoleId` 是角色标识，绝不会当成 `userId`。普通页面可能展示其他游戏角色，账号匹配时仍保留原万象棋的角色和任务绑定。如果页面明确声明 `gameId/mGameId=30001`，其中的角色字段也必须与原模板一致；仅当这个万象棋页面的 `uniqueRoleId` 与模板 `campRoleId` 确实相同，才允许角色锚点证明身份。

旧模板如果只有万象棋角色、没有 `userId/openid`，普通非游戏页面不能证明同号，本模块会保守拒绝。它不会凭一个成功状态图就把其他账号的 token 写进去，也不从不透明认证值中臆测账号。

认证候选只来自这一次网页请求的 query、请求头或白名单 Cookie token。query 与请求头的伴随字段可按官方映射组合，冲突拒绝；签名组必须带完整 `msdkEncodeParam/sig/timestamp`，只有 `encode` 数字不算凭证。Cookie 只识别 `token/msdkToken` 的值，且必须先有同请求的账号证明；不会转发原始 Cookie、Authorization、未知认证头或游戏专用 `gametoken`。如果 query/header 已有主认证，Cookie 不作为备用认证叠加。

验证请求的 URL 固定为官方 `https://kohcamp.qq.com/operation/action/signinfo`，没有旧 URL 的 query；请求体只保留查询所需 `gameId`、公共包装及原来存在的角色字段；请求头只保留明确身份、角色、元数据和本次候选认证。旧 token、Cookie、Authorization、签名参数和未知认证字段的替代路径全部移除，禁止旧凭证掩盖新候选失败。关闭自动 Cookie 和自动跳转。可比的十位秒/十三位毫秒签名时间戳会统一单位，阻止旧签名覆盖较新签名；不猜测不透明 token 的新旧。

文档筛选：`GET`、`/h5/` 下 `.html/.htm` 或目录入口；HTTP 200 的 HTML 响应还需 `Sec-Fetch-Dest=document` 或 HTML Accept，已提供的目的/模式必须是 `document/navigate`。部分 iOS WebView 不提供 Fetch Metadata，200 时使用 HTML Accept + HTML 响应作为文档证据，缺少元数据时不能绝对证明顶层；这是已知识别边界。有条件支持 HTTP 304：只接受明确的 `document+navigate` 和 HTML Accept，且已知网页路径；不会把任意 304 当作页面。资源、XHR、已知 iframe 和无关路径不进入认证处理。

响应钩子不缓冲 HTML 正文，收到响应头即运行。官方只读验证的网络超时为 3 秒，本地截止约 3.5 秒，之后页面原样继续、晚到的 callback 不可写凭证；Surge 调度可能产生额外误差。由于验证在 `$done` 前完成，首次命中可能有短暂可感知等待，无法承诺零延时。

异步结果写入前重读原始会话和最新页面票据；清除、重新捕获、新页面与乱序响应会使旧结果失效。最终重读与写入之间没有异步等待；Surge 的 `$persistentStore` 未提供跨脚本原子 CAS，不能声称存在进程间事务保证。旧主脚本清除凭证后，日常诊断的静态计数可能保留，但凭证已无模板时不会被旧 callback 恢复。

## 当前验证

运行 `node --check wxq-checkin-daily.js` 与 `node --test wxq-checkin-daily.test.cjs wxq-checkin.test.cjs`。当前 65 组模拟测试通过，包括新旧 ABI 兼容（含角色仅在旧请求体中的模板）、纯候选、多账号、字段冲突、200/304、字段诊断隐私、同凭证首次真实验证、清除/乱序、迟到 callback、跨单位旧签名拒绝、存储失败及原签到回归。

这些是静态检查和模拟验证。iPhone 实际页面的字段分布、签名是否可跨页复用、成功更新后的官方重放、微信登录影响、页面等待、跨日自动运行和持续有效期均仍待真机验收。

依据：[Surge 响应脚本](https://manual.nssurge.com/scripting/http-response.html)明确无正文缓冲时收到响应头即运行、`$done({})` 原样透传；[官方福利中心前端](https://camp.qq.com/h5/webdist/welfare-center/static/js/index.dd24932b.js)的普通营地字段映射为 `userId → userId`、`uniqueRoleId → campRoleId`、`roleId → roleId`，认证组为 `msdkEncodeParam/sig/timestamp`。这里只使用本机已有的该官方源码快照核对字段；未把快照当作手机运行证据。

## 第二版 20261115d

针对第一版真机已经命中页面且候选失败的现象，对照官方 transport 补入固定公共头 `Accept-Encrypt: 空值`、`noencrypt: 1`、`X-Client-Proto: https`，并继承模板中的白名单 `source/cSystem/h5Get/gameOpenid/areaId/serverId/cClientVersionName`。这证明旧版存在包装差异，尚不能据此认定真机根因。签名中的 `+` 按官方 qs 行为解码：字面 `+` 为空格，`%2B` 为加号，不做二次解码。

模板 URL 若含 `routing`，仅允许原模板中的 1～64 位字母、数字、点、横线、下划线值继续作为查询参数；其余 query 全部丢弃。官方快照没有出现 routing，不能宣称其必需；保留这个有界路由提示用于避免破坏已捕获的真实路径。`customPath`、动态目标 URL 等路由重定向字段不继承。

官方响应可能返回新的 `msdktoken/gametoken`。只在本次同账号纯候选通过 HTTP、业务码与七日图严格验证后才保存这些响应凭证；失败响应中的 token 一律忽略。原生 token 可能确实是签名外的额外认证，网页没有它时不从旧会话借用。若只是公共包装修正、凭证本身相同，会明确报告“凭证相同；已修正请求公共包装”。

诊断现在保留安全的 HTTP 三位状态与最多九位纯数字业务码，区分网络/HTTP/非 JSON/业务错误/码格式错误/缺码/缺图。不会输出响应正文、错误原文或认证值。
