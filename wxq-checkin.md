# 王者万象棋 Surge iOS 签到模块

测试版。目标是在 iPhone 内复用王者营地当前登录凭证，定时完成万象棋每日签到。常驻签到模块不启用 MITM、不拦截 App 请求；凭证捕获拆为可选临时模块。两者复用同一份 Surge 本机凭证，不发起新的微信登录，也不依赖 Mac 营地。

2026-11-15 已将常驻 MITM 与捕获脚本移至独立临时模块，避免常驻模块继续解密营地登录流量。此权限拆分已通过静态和模拟测试，微信登录恢复及手机行为仍需真机验收。此前已根据真实 iPhone 万象棋福利页请求校正游戏 ID 与认证字段，并对照新版官方福利中心修正提交接口。已验证的是实际请求字段、响应结构与 Node 模拟测试；修正版的手机捕获、已登录查询重放、真实签到提交、凭证有效期和跨日定时运行仍待验收。

## 已定位的接口

| 用途 | 请求 |
| --- | --- |
| 查询签到状态 | `POST https://kohcamp.qq.com/operation/action/signinfo` |
| 提交每日签到 | `POST https://kohcamp.qq.com/operation/action/newsignin` |

[当前官方福利中心前端代码](https://camp.qq.com/h5/webdist/welfare-center/static/js/index.dd24932b.js)中，查询参数为 `{gameId}`，每日签到接口为 `newsignin`，参数为 `{gameId, roleId}`。提交的 `roleId` 优先取当前游戏角色 ID；它与请求头 `campRoleId` 不应混用。

[万象棋官网](https://wxq.qq.com/m.html)跳转营地的入口为 `multiGameId=30001`，真实 iPhone 查询请求头也为 `gameid=30001`（王者荣耀为 `20001`）。旧版根据枚举名误用 `AUTO_CHESS=40001`，因此漏捕获；修正版使用真实映射 `30001`。真实请求包含 `encode=2`、`msdkencodeparam`、`token`、`campRoleId`、`roleId`；不再强制要求 `userId/openId`，也不再将 `encode` 数字本身当作凭证。

真机查询体为 `{"cSystem":"ios","h5Get":1,"gameId":"30001"}`，原生角色头 `roleid` 与 `camproleid` 在本次样本中同值。模块保留原查询 JSON 与认证头重放；提交时保留公共包装字段 `cSystem/h5Get` 及查询中 `gameId` 的原始类型，使用捕获到的原生 `roleId`，缺少它时可以只查、不会提交。成功响应通过 `returnCode=0` 与 `data.weekSignMap` 确认；真实 `data.weekList[].gift[].icon` 为 `OS-*` 奖励。签到位图支持 `0/1/2`（未签/已签/已补签），模块不发起补签。
2026-11-13 对查询接口发送无凭证的 JSON POST，得到 HTTP 200，但响应业务码为 `-30314`、消息为“登录态参数不全”。这验证了地址可访问，不能证明有凭证请求可以成功重放。

`msdkEncodeParam`、`sig`、`timestamp` 或相关 token 来自营地登录会话。官方代码存在原生凭证刷新逻辑，本模块不生成签名、不修改签名时间戳。凭证过期时需要临时捕获；若营地自身也已掉线，必须先停用临时捕获模块并恢复手机登录，然后才启用临时模块、重开福利页，捕获后立即停用。

## 安装与首次验证

需要支持本文脚本选项的 Surge iOS，建议使用当前版本。`auto-redirect` 和 `auto-cookie` 选项最低要求 Surge iOS 5.9.0。

1. 在 Surge 的模块页面通过 URL 安装并启用[常驻签到模块](https://raw.githubusercontent.com/winx402/clash-config/main/wxq-checkin.sgmodule)。它只包含原来的 cron 与三个手动任务，不需要 MITM。
2. **从旧版升级：先更新主模块并应用配置，确认主模块已无 MITM 和两条捕获脚本。** 重新下载/更新[配套脚本](https://raw.githubusercontent.com/winx402/clash-config/main/wxq-checkin.js)，避免继续使用缓存旧版 JS。已保存凭证仍可直接使用，不必清除。仅切换账号/角色或凭证损坏时，才先运行“万象棋清除凭证”。若主配置或其他模块仍对 `kohcamp.qq.com` 启用 MITM，单独更新本模块不会撤销那些设置，需核对来源。
3. **先保持临时捕获模块停用，在 iPhone 王者营地完成微信登录。** 已有可用凭证时可直接跳到第 6 步。不要为了登录而启用捕获模块。
4. 登录成功后，才通过 URL 安装并临时启用[凭证捕获模块](https://raw.githubusercontent.com/winx402/clash-config/main/wxq-checkin-capture.sgmodule)。此模块需 Surge 已配置且 iOS 已信任 MITM 证书，并已开启 MITM；模块只追加 `kohcamp.qq.com`，不配置或替换证书。**MITM 影响整个该域名的 TLS，而非仅签到 URL，可能干扰微信登录。** 脚本仅匹配 `signinfo` 的请求与响应，没有定时任务，也不提交签到。若此前安装流程已将其启用，先停用再登录。
5. 在已登录的营地进入“游戏”→王者万象棋→“每日福利”，触发 `signinfo` 查询。收到“已捕获当前万象棋角色的凭证，请立即停用临时捕获模块”后，**立即停用该捕获模块并应用配置**，保留常驻签到模块启用。脚本无法替用户自动停用模块。若无法解密或捕获失败，也先停用临时模块，再核对证书和请求；不要带着临时 MITM 反复尝试微信登录。
6. 在 Surge 手动运行常驻模块的“万象棋只查状态”，验证已保存凭证。本操作不提交签到，今天已签到也可验证。停用/删除临时捕获模块不会清除已保存凭证；常驻模块发送自己的 HTTPS 请求，无需解密 App 流量。
7. 在未签到的一天手动运行“万象棋立即签到”，并回到营地核对今日奖励。模块只有在再次查询确认当日签到位变为已签到后才报告成功。
8. 常驻模块启用且成功捕获凭证后，定时任务会在每日 09:05、18:05 执行；无需另行启用自动模式。首次使用时请先完成前面的手动验证。**凭证失效时重复第 3～6 步，保持“先登录、再临时捕获、捕获后立即停用”的顺序。**

相关规则见 [Surge 脚本文档](https://manual.nssurge.com/scripting/overview.html)。

定时触发按 iPhone 当前时区运行，签到日期判断固定使用上海时间。模块设置了 `wake-system=true`，但锁屏唤醒、网络和系统限制仍需实际观察，不能保证准点运行。第二次执行用于当日补充尝试，已签到时只查询并跳过，不会执行历史补签。

若其它脚本也匹配同一查询 URL，Surge 每个请求阶段只运行第一个匹配脚本，应核对冲突。仅在临时捕获期间，请求和响应两条捕获脚本需要同时启用；完成后一起随临时模块停用。

## 凭证与异常处理

凭证保存在 Surge 本机 `$persistentStore`，不写入模块文件，也不上传到额外服务器。运行时只向 `kohcamp.qq.com` 发送签到所需请求；模块关闭自动重定向。Surge 自身的请求记录仍可能包含认证头，分享抓包或备份前应自行处理。

捕获必须同时符合游戏 ID、角色字段、认证字段和可识别的成功签到状态；请求与响应须按请求 ID（如有）及相同 URL、游戏、角色、身份配对。请求阶段没有提供 ID 时，会保留最近一条无 ID 请求并校验对应身份。模块绑定首次捕获的账号和角色，后续同角色打开福利页可更新凭证。切换账号或角色时，先运行“万象棋清除凭证”，再按安装步骤临时捕获目标角色的福利页，完成后立即停用临时捕获模块。

若没有捕获通知，先手动运行“万象棋只查状态”：没有凭证时，它会显示是否从未触发查询、已记录请求但等待响应、响应无法配对，或可识别的业务错误等诊断，仅输出固定提示和业务错误码，不输出凭证值。仅在登录成功后的短暂捕获期间，在 Surge 请求记录筛选 `kohcamp.qq.com` 和 `signinfo`，核对是否成功解密、临时捕获模块的两条脚本是否均启用、请求 JSON 和 `gameId=30001` 是否一致，是否含 `campRoleId`、`roleId` 与认证字段。可反馈通知文字、HTTP 状态、业务返回码和字段名，不需要发送凭证值。

模块只处理每日签到，不调用补签、兑换、抽奖、任务奖励领取或登录接口。凭证失效、返回格式变化和网络错误都不会报告签到成功。

## 开发验证

在本目录运行：

```sh
node --check wxq-checkin.js
node --test wxq-checkin.test.cjs
```

模拟测试覆盖常驻模块无 MITM/无 HTTP 拦截、临时模块仅限定域名与查询端点、首次与刷新捕获均提醒立即停用、停用捕获后使用已有凭证，以及真实 iPhone 字段、30001 游戏映射、newsignin 参数与原始类型、缺少原生角色的提交保护、诊断隐私、无请求 ID 的配对、补签位图、错误游戏与域名、凭证失效、账号切换保护、重复执行、签到后确认、重定向、网络失败、上海日期跨日和存储失败等场景。模拟测试不替代 iPhone 的真实请求及签到验收。

Surge 参考：[模块格式](https://manual.nssurge.com/profile/module.html)、[JavaScript API](https://manual.nssurge.com/scripting/api.html)、[请求脚本](https://manual.nssurge.com/scripting/http-request.html)、[响应脚本](https://manual.nssurge.com/scripting/http-response.html)、[定时脚本](https://manual.nssurge.com/scripting/cron.html)。
