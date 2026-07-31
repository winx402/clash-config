# AI 视频网站 Surge 规则集

更新时间：2026-07-31

站点规则按网站拆分，每个 `.list` 都是无策略列的 Surge 域名规则集，可单独订阅。新增文件收纳在本目录；HeyGen 沿用仓库根目录已有的 `heygen.list`，避免维护两份相同规则。规则同时沿用仓库现有 `DOMAIN` / `DOMAIN-SUFFIX` 写法；没有把统计、广告、客服等非必要第三方域名纳入。

## 使用方式

如需全部站点统一走名为 `proxy` 的策略，在 Surge 主配置的 `[Rule]` 段靠后位置手动加入以下规则：

```ini
RULE-SET,https://raw.githubusercontent.com/winx402/clash-config/main/ai-video/all.list,proxy
```

Surge 模块不能引用自定义策略组，只能使用内置策略，因此这里保留主配置规则，确保能准确指向 `proxy`。

若只需要个别站点，仍可按下例分别引用并指定自己的策略组：

```ini
RULE-SET,https://raw.githubusercontent.com/winx402/clash-config/main/ai-video/krea.list,AI视频
```

格式遵循 [Surge External Ruleset 官方规范](https://manual.nssurge.com/rule/ruleset.html)：远端文件为纯文本，每行是一条不带策略列的子规则；策略统一写在主配置的 `RULE-SET` 引用行中。

建议按实际使用的网站逐个引用，不要无差别导入全部文件。`条件代理` 表示存在中国站、可直连入口或服务地区限制；代理只能改变网络出口，不能替代账号地区、手机号、支付方式或服务资格。

## 网站与代理判断

“建议代理”不是对中国大陆所有运营商的永久封锁断言，而是基于国际站入口、公开代理规则、官方 SDK 域名及生成链路作出的默认路由建议。不同地区、运营商和账号地区的结果可能不同，因此没有把一次网络请求当作全国可达性结论。

| 网站 | 建议 | 规则文件 | 主要域名 |
| --- | --- | --- | --- |
| Krea | 建议代理 | `krea.list` | `krea.ai` |
| PixVerse | 建议代理 | `pixverse.list` | `pixverse.ai`, `pixverseai.ai` |
| Leonardo.Ai | 建议代理 | `leonardo.list` | `leonardo.ai` |
| Pika | 建议代理 | `pika.list` | `pika.art` |
| Luma Dream Machine | 建议代理 | `luma.list` | `lumalabs.ai` |
| HeyGen | 建议代理 | `../heygen.list` | `heygen.com`, `heygen.ai` |
| Synthesia | 建议代理 | `synthesia.list` | `synthesia.io` |
| InVideo AI | 建议代理 | `invideo.list` | `invideo.io` |
| Runway | 建议代理 | `runway.list` | `runwayml.com`, `runway.ml` |
| LTX Studio | 建议代理 | `ltx-studio.list` | `ltx.studio`, `ltx.io`, `ltx.video` |
| DomoAI | 建议代理 | `domoai.list` | `domoai.app`, `domoai.com` |
| Pollo AI | 建议代理 | `pollo.list` | `pollo.ai` |
| Higgsfield | 建议代理 | `higgsfield.list` | `higgsfield.ai`, `higgs.ai` |
| Freepik AI | 建议代理 | `freepik.list` | `freepik.com`, `cdnpk.net` |
| VEED | 建议代理 | `veed.list` | `veed.io`, `veed.com` |
| Gemini / Veo | 建议代理 | `gemini-veo.list` | Gemini、AI Studio 与生成 API 精确域名 |
| fal.ai | 建议代理 | `fal.list` | `fal.ai`, `fal.run`, `fal.media` |
| Replicate | 建议代理 | `replicate.list` | `replicate.com`, `replicate.delivery` |
| Dreamina 国际站 | 条件代理 | `dreamina.list` | Dreamina、CapCut API 与必要静态资源域名 |
| Adobe Firefly | 条件代理 | `adobe-firefly.list` | Firefly Web、API 与 Adobe 登录域名 |
| Canva AI | 条件代理 | `canva.list` | `canva.com` |
| Kling 国际站 | 条件代理 | `kling.list` | `klingai.com`, `kling.ai`, `kechuangai.com` |
| Hailuo 国际站 | 条件代理 | `hailuo.list` | `hailuoai.video`, `minimax.io` 等 |
| Vidu 国际/旧入口 | 条件代理 | `vidu.list` | `vidu.com`, `vidu.studio`；不含 `vidu.cn` |

## 暂不加入

- 腾讯混元、阿里 Wan：面向中国大陆的服务，不需要独立代理规则。
- Vidu 中国站：`vidu.com` 当前会跳转到 `vidu.cn`，中国站保持直连；`vidu.list` 只保留国际/旧入口。
- Kling/Hailuo 中国站：存在中国入口；本目录对应的文件只用于需要国际站或国际账号链路时。
- Haiper：截至本次核对只能确认到长期未更新的静态页面，未确认仍有可用的视频生成入口，暂不把它当作有效平台提交。
- Sora：OpenAI 已于 2026-04-26 停止 Web 与 App，API 也将在 2026-09-24 停止，因此不新增规则。

## 域名来源

域名先从 GitHub 公开资料收集，再与平台官网入口及当前页面资源交叉核对：

- [ShadowLens AI domain intelligence](https://github.com/iamsparshgupta/shadowlens/blob/5d56473eb6fb197ac604e3f28e04b29e3399fb9b/extension/src/domains.ts)：Krea、Leonardo、Firefly、Pika、Luma、Runway、HeyGen、Synthesia、InVideo、VEED、Canva、Gemini、Replicate 等站点及 API 子域名。
- [AI Blocklist](https://github.com/laylavish/uBlockOrigin-HUGE-AI-Blocklist/blob/9bb188e2701138e03f73bacebd6b19b181ca0012/list_uBlacklist.txt)：多家 AI 视频网站根域名的第二来源。
- [v2fly domain-list-community](https://github.com/v2fly/domain-list-community/blob/c2aeccd66385a149515d7498008e5100f74ab8cf/data/category-ai-cn)：Kling、Hailuo/MiniMax 的品牌域名。
- [PixVerse 官方 MCP](https://github.com/PixVerseAI/PixVerse-MCP/tree/943b1148e33d20b24ec5bd3dfaf48ac24c3f1693)：`pixverse.ai`、`pixverseai.ai`、`pixverseai.cn` 的 Web/API 入口。
- [Runway 官方 Python SDK](https://github.com/runwayml/sdk-python/tree/c604e0ea1e4a51a4063f2d638839ce3b6ff71023)：`api.dev.runwayml.com`。
- [fal 官方 JavaScript SDK](https://github.com/fal-ai/fal-js/tree/fc1df9fff048c0905ed04f6054b45c6b1719e17c)：`fal.ai`、`fal.run`、`fal.media`。
- [Replicate 官方 Python SDK](https://github.com/replicate/replicate-python/tree/d2956ff9c3e26ef434bc839cc5c87a50c49dfe20)：API、流式传输与输出交付域名。
- [LTX 官方仓库](https://github.com/Lightricks/LTX-Video)：`ltx.video` 文档与产品链路。
- [MiniMax 官方 MCP](https://github.com/MiniMax-AI/MiniMax-MCP-JS)：Hailuo 视频模型与 MiniMax 国际 API 链路。
- [DuckDuckGo Tracker Radar](https://github.com/duckduckgo/tracker-radar/blob/6253f5a053513120c61ad8221dc30a0e2cdbfeb9/domains/US/capcutapi.us.json)：Dreamina 页面观测到的 CapCut API/CDN 域名。
- [rekryt/iplist Pollo 配置](https://github.com/rekryt/iplist/blob/7568ba006454891e4264e4cecb8d7983303b7dce/config/ai/pollo.ai.json)：Pollo 自有 API、CDN 与视频交付子域名。

`DOMAIN-SUFFIX` 已覆盖同一根域名下的 API、App、CDN 子域名；只有跨根域名的必要依赖才单独列出。共享的 Cloudflare、CloudFront、客服和统计域名默认不扩大收录；Gemini 文件为保证登录与媒体交付，明确保留了少量 Google 共享域名。
