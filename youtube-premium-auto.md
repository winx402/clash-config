# YouTube Premium 自动选路（Surge）

安装地址：

```text
https://raw.githubusercontent.com/winx402/clash-config/main/youtube-premium-auto.sgmodule
```

## 配置

模块只有两个参数：

```text
TARGET_GROUP: Youtube
REGION_ORDER: sg,jp,us,other
```

- `TARGET_GROUP`：顶层策略组的精确名称，默认 `Youtube`。
- `REGION_ORDER`：YouTube 响应国家代码的优先级，默认 `sg,jp,us,other`。

地区代码不区分大小写，支持任意两位国家代码。`other` 表示没有单独列出的其他国家。模块不会通过节点名或策略组名判断地区。

`TARGET_GROUP` 必须是 `select` 策略组。如果找不到该组，或该组是 `fallback`、`smart`、`url-test`、`load-balance`、`subnet` 等自动类型，脚本会通知兼容性错误并终止，不修改策略选择。

仅完成 URL 安装不会自动启用模块。安装后需要在 Surge 的“模块”页面勾选“启用”并应用；启用成功后，“脚本”页面会出现“立即检测 YouTube Premium”。

## 工作方式

1. 动态读取顶层 `select` 策略组的有序子项，并递归处理嵌套的 `select` 策略组。
2. 遇到自动策略组时跳过整棵子树并继续后续选项，不检测或修改该自动组。
3. 每一层的子策略组保持原顺序；所有直属节点合并为一个虚拟检测组，位置取第一个直属节点的位置。
4. 每个节点只请求 `https://www.youtube.com/premium?hl=en`，从同一个响应判断 Premium、国家代码和总耗时。
5. 每个检测组内先按 `REGION_ORDER` 排序，再选择总耗时最低的节点；当前组有结果后不再检查后续组。
6. 获胜后逐层设置 `顶层组 -> select 子策略组 -> 节点`，所有原始选择都会被记录。
7. 可控节点全部明确不可用且没有跳过项时恢复模块接管前的选择；存在跳过组、验证码、限流、网络错误或无法解析的响应时保留上次选择。

脚本每 15 分钟运行一次。也可以在 Surge 的脚本页面运行“立即检测 YouTube Premium”。Surge 自带的策略组重新测速按钮仍使用原生测速逻辑，模块无法替换它。

## Surge 限制

Surge 的脚本 API 只能切换 `select` 策略组，无法替代 UI 对自动策略组的临时覆盖。本模块因此不会进入或修改任何自动组，也不会修改用户配置中的策略组类型。

全局代理可以并发检测 5 个。通过组级 `policy-path`、`include-other-group` 等方式出现在 `select` 组中、但不是全局策略的节点，Surge 不允许直接用于 `$httpClient.policy`；脚本会临时切换所属 `select` 组后串行检测，并在检测单元结束时恢复原选择。响应耗时是 Premium 页面从请求开始到完整响应结束的时间，不是单纯 TCP RTT。

如果子策略组同时被 Netflix、TikTok 等策略引用，最终选中的节点也会影响这些共享场景。

模块不使用 `generate_204`、MITM、节点名称中的 `[YTP]` 标签或 Sub-Store 缓存。
