# 王者万象棋 Surge iOS 签到模块

测试版。目标是在 iPhone 内复用王者营地当前登录凭证，定时完成万象棋每日签到。模块不发起新的微信登录，也不依赖 Mac 营地。

目前完成了官方前端接口定位、一次无凭证查询验证和 Node 模拟测试；尚未取得 iPhone 的真实请求，也未验证真实签到提交、凭证有效期和跨日定时运行。

## 已定位的接口

| 用途 | 请求 |
| --- | --- |
| 查询签到状态 | `POST https://kohcamp.qq.com/operation/action/signinfo` |
| 提交每日签到 | `POST https://kohcamp.qq.com/operation/action/signin` |

[官方活动页前端代码](https://camp.qq.com/h5/webdist/act-center/static/js/index.3a514fc9.js)中，查询业务参数为空对象，签到业务参数为 `{roleId: uniqueRoleId}`。请求层将角色、游戏和登录参数放入 HTTP 头；其中 `campRoleId` 来自 `uniqueRoleId`。官方枚举 `AUTO_CHESS` 的值为 `40001`，本模块仅接受该游戏 ID。

2026-11-13 对查询接口发送无凭证的 JSON POST，得到 HTTP 200，但响应业务码为 `-30314`、消息为“登录态参数不全”。这验证了地址可访问，不能证明有凭证请求可以成功重放。

`msdkEncodeParam`、`sig`、`timestamp` 或相关 token 来自营地登录会话。官方代码存在原生凭证刷新逻辑，本模块不生成签名、不修改签名时间戳。凭证过期时需要重新打开 iPhone 营地福利页捕获；若营地自身也已掉线，需要先恢复手机登录。

## 安装与首次验证

需要支持本文脚本选项的 Surge iOS，建议使用当前版本。`auto-redirect` 和 `auto-cookie` 选项最低要求 Surge iOS 5.9.0。

1. 在 Surge 的模块页面通过 URL 安装：`https://raw.githubusercontent.com/winx402/clash-config/main/wxq-checkin.sgmodule`。
2. 启用该模块并应用配置。模块自动下载[配套脚本](https://raw.githubusercontent.com/winx402/clash-config/main/wxq-checkin.js)，无需手动复制 JS 文件。相关规则见 [Surge 脚本文档](https://manual.nssurge.com/scripting/overview.html)。
3. Surge 必须已配置 MITM 证书并在 iOS 信任该证书，且已开启 MITM。模块只追加 `kohcamp.qq.com`，不会配置或替换证书。若证书固定导致无法解密，本模块无法捕获，需停下核对，不能视作普通网络成功。
4. 在 iPhone 王者营地恢复微信登录，进入“游戏”→王者万象棋→“每日福利”。等待页面加载或返回后重新进入，触发 `signinfo` 查询。
5. 收到“已捕获当前万象棋角色的凭证”后，在 Surge 手动运行“万象棋只查状态”。此操作不提交签到。今天已签到也可以完成捕获和查询验证。
6. 在未签到的一天手动运行“万象棋立即签到”，并回到营地核对今日奖励。模块只有在再次查询确认当日签到位变为 `1` 后才报告成功。
7. 模块启用且成功捕获凭证后，定时任务会在每日 09:05、18:05 执行；无需另行启用自动模式。首次使用时请先完成前面的手动验证。

定时触发按 iPhone 当前时区运行，签到日期判断固定使用上海时间。模块设置了 `wake-system=true`，但锁屏唤醒、网络和系统限制仍需实际观察，不能保证准点运行。第二次执行用于当日补充尝试，已签到时只查询并跳过，不会执行历史补签。

若其它脚本也匹配同一查询 URL，Surge 每个请求阶段只运行第一个匹配脚本，应核对冲突。请求和响应两条捕获脚本需要同时启用。

## 凭证与异常处理

凭证保存在 Surge 本机 `$persistentStore`，不写入模块文件，也不上传到额外服务器。运行时只向 `kohcamp.qq.com` 发送签到所需请求；模块关闭自动重定向。Surge 自身的请求记录仍可能包含认证头，分享抓包或备份前应自行处理。

捕获必须同时符合游戏 ID、角色字段、身份字段和可识别的成功签到状态。模块绑定首次捕获的账号和角色，后续同角色打开福利页可更新凭证。切换账号或角色时，先运行“万象棋清除凭证”，再打开目标角色的福利页。

若没有捕获通知，先在 Surge 请求记录中筛选 `kohcamp.qq.com` 和 `signinfo`，核对是否成功解密、请求是否为 JSON、头部是否包含 `mGameId` 或 `gameId`、`campRoleId` 和身份字段。当前字段要求来自官方前端，真实 iOS 请求若不同，需要调整适配。可反馈通知文字、HTTP 状态、业务返回码和字段名，不需要发送凭证值。

模块只处理每日签到，不调用补签、兑换、抽奖、任务奖励领取或登录接口。凭证失效、返回格式变化和网络错误都不会报告签到成功。

## 开发验证

在本目录运行：

```sh
node --check wxq-checkin.js
node --test wxq-checkin.test.cjs
```

模拟测试覆盖捕获配对、错误游戏与域名、凭证失效、账号切换保护、重复执行、签到后确认、重定向、网络失败、上海日期跨日和存储失败等场景。模拟测试不替代 iPhone 的真实请求及签到验收。

Surge 参考：[模块格式](https://manual.nssurge.com/profile/module.html)、[JavaScript API](https://manual.nssurge.com/scripting/api.html)、[请求脚本](https://manual.nssurge.com/scripting/http-request.html)、[响应脚本](https://manual.nssurge.com/scripting/http-response.html)、[定时脚本](https://manual.nssurge.com/scripting/cron.html)。
