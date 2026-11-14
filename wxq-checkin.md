# 王者万象棋 Surge iOS 签到模块

测试版。目标是在 iPhone 内复用王者营地当前登录凭证，定时完成万象棋每日签到。模块不发起新的微信登录，也不依赖 Mac 营地。

2026-11-15 已根据真实 iPhone 万象棋福利页请求校正游戏 ID 与认证字段，并对照新版官方福利中心修正提交接口。已验证的是实际请求字段、响应结构与 Node 模拟测试；修正版的手机捕获、已登录查询重放、真实签到提交、凭证有效期和跨日定时运行仍待验收。

## 已定位的接口

| 用途 | 请求 |
| --- | --- |
| 查询签到状态 | `POST https://kohcamp.qq.com/operation/action/signinfo` |
| 提交每日签到 | `POST https://kohcamp.qq.com/operation/action/newsignin` |

[当前官方福利中心前端代码](https://camp.qq.com/h5/webdist/welfare-center/static/js/index.dd24932b.js)中，查询参数为 `{gameId}`，每日签到接口为 `newsignin`，参数为 `{gameId, roleId}`。提交的 `roleId` 优先取当前游戏角色 ID；它与请求头 `campRoleId` 不应混用。

[万象棋官网](https://wxq.qq.com/m.html)跳转营地的入口为 `multiGameId=30001`，真实 iPhone 查询请求头也为 `gameid=30001`（王者荣耀为 `20001`）。旧版根据枚举名误用 `AUTO_CHESS=40001`，因此漏捕获；修正版使用真实映射 `30001`。真实请求包含 `encode=2`、`msdkencodeparam`、`token`、`campRoleId`、`roleId`；不再强制要求 `userId/openId`，也不再将 `encode` 数字本身当作凭证。

真机查询体为 `{"cSystem":"ios","h5Get":1,"gameId":"30001"}`，原生角色头 `roleid` 与 `camproleid` 在本次样本中同值。模块保留原查询 JSON 与认证头重放；提交时保留公共包装字段 `cSystem/h5Get` 及查询中 `gameId` 的原始类型，使用捕获到的原生 `roleId`，缺少它时可以只查、不会提交。成功响应通过 `returnCode=0` 与 `data.weekSignMap` 确认；真实 `data.weekList[].gift[].icon` 为 `OS-*` 奖励。签到位图支持 `0/1/2`（未签/已签/已补签），模块不发起补签。
2026-11-13 对查询接口发送无凭证的 JSON POST，得到 HTTP 200，但响应业务码为 `-30314`、消息为“登录态参数不全”。这验证了地址可访问，不能证明有凭证请求可以成功重放。

`msdkEncodeParam`、`sig`、`timestamp` 或相关 token 来自营地登录会话。官方代码存在原生凭证刷新逻辑，本模块不生成签名、不修改签名时间戳。凭证过期时需要重新打开 iPhone 营地福利页捕获；若营地自身也已掉线，需要先恢复手机登录。

## 安装与首次验证

需要支持本文脚本选项的 Surge iOS，建议使用当前版本。`auto-redirect` 和 `auto-cookie` 选项最低要求 Surge iOS 5.9.0。

1. 在 Surge 的模块页面通过 URL 安装：`https://raw.githubusercontent.com/winx402/clash-config/main/wxq-checkin.sgmodule`。
2. 启用该模块并应用配置。模块自动下载[配套脚本](https://raw.githubusercontent.com/winx402/clash-config/main/wxq-checkin.js)，无需手动复制 JS 文件。更新旧模块后，需在 Surge 重新下载/更新配套脚本，避免继续使用缓存旧版 JS；可先运行“万象棋清除凭证”再捕获。相关规则见 [Surge 脚本文档](https://manual.nssurge.com/scripting/overview.html)。
3. Surge 必须已配置 MITM 证书并在 iOS 信任该证书，且已开启 MITM。模块只追加 `kohcamp.qq.com`，不会配置或替换证书。若证书固定导致无法解密，本模块无法捕获，需停下核对，不能视作普通网络成功。
4. 在 iPhone 王者营地恢复微信登录，进入“游戏”→王者万象棋→“每日福利”。等待页面加载或返回后重新进入，触发 `signinfo` 查询。
5. 收到“已捕获当前万象棋角色的凭证”后，在 Surge 手动运行“万象棋只查状态”。此操作不提交签到。今天已签到也可以完成捕获和查询验证。
6. 在未签到的一天手动运行“万象棋立即签到”，并回到营地核对今日奖励。模块只有在再次查询确认当日签到位变为已签到 后才报告成功。
7. 模块启用且成功捕获凭证后，定时任务会在每日 09:05、18:05 执行；无需另行启用自动模式。首次使用时请先完成前面的手动验证。

定时触发按 iPhone 当前时区运行，签到日期判断固定使用上海时间。模块设置了 `wake-system=true`，但锁屏唤醒、网络和系统限制仍需实际观察，不能保证准点运行。第二次执行用于当日补充尝试，已签到时只查询并跳过，不会执行历史补签。

若其它脚本也匹配同一查询 URL，Surge 每个请求阶段只运行第一个匹配脚本，应核对冲突。请求和响应两条捕获脚本需要同时启用。

## 凭证与异常处理

凭证保存在 Surge 本机 `$persistentStore`，不写入模块文件，也不上传到额外服务器。运行时只向 `kohcamp.qq.com` 发送签到所需请求；模块关闭自动重定向。Surge 自身的请求记录仍可能包含认证头，分享抓包或备份前应自行处理。

捕获必须同时符合游戏 ID、角色字段、认证字段和可识别的成功签到状态；请求与响应须按请求 ID（如有）及相同 URL、游戏、角色、身份配对。请求阶段没有提供 ID 时，会保留最近一条无 ID 请求并校验对应身份。模块绑定首次捕获的账号和角色，后续同角色打开福利页可更新凭证。切换账号或角色时，先运行“万象棋清除凭证”，再打开目标角色的福利页。

若没有捕获通知，先手动运行“万象棋只查状态”：没有凭证时，它会显示是否从未触发查询、已记录请求但等待响应、响应无法配对，或可识别的业务错误等诊断，仅输出固定提示和业务错误码，不输出凭证值。再在 Surge 请求记录筛选 `kohcamp.qq.com` 和 `signinfo`，核对是否成功解密、两条捕获脚本是否均启用、请求 JSON 和 `gameId=30001` 是否一致，是否含 `campRoleId`、`roleId` 与认证字段。可反馈通知文字、HTTP 状态、业务返回码和字段名，不需要发送凭证值。

模块只处理每日签到，不调用补签、兑换、抽奖、任务奖励领取或登录接口。凭证失效、返回格式变化和网络错误都不会报告签到成功。

## 开发验证

在本目录运行：

```sh
node --check wxq-checkin.js
node --test wxq-checkin.test.cjs
```

模拟测试覆盖真实 iPhone 字段、30001 游戏映射、newsignin 参数与原始类型、缺少原生角色的提交保护、诊断隐私、无请求 ID 的配对、补签位图、错误游戏与域名、凭证失效、账号切换保护、重复执行、签到后确认、重定向、网络失败、上海日期跨日和存储失败等场景。模拟测试不替代 iPhone 的真实请求及签到验收。

Surge 参考：[模块格式](https://manual.nssurge.com/profile/module.html)、[JavaScript API](https://manual.nssurge.com/scripting/api.html)、[请求脚本](https://manual.nssurge.com/scripting/http-request.html)、[响应脚本](https://manual.nssurge.com/scripting/http-response.html)、[定时脚本](https://manual.nssurge.com/scripting/cron.html)。
