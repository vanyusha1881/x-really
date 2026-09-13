# X-Really · 工程架构

> 纯原生 JavaScript · 无构建步骤 · 无打包器 · 无依赖 · 无框架。改完即生效（浏览器重新加载扩展即可）。

## 模块与职责

| 目录 / 文件 | 职责 |
| --- | --- |
| `manifest.json` | MV3 清单；版本号在此 bump |
| `background/service-worker.js` | 核心：搜索（4 引擎竞速）+ LLM 调用 + 判定提示词 + 缓存 + 历史 |
| `content/content.js` | X 页面注入：操作栏按钮 + 结果卡片容器（文本/引用/配图提取） |
| `content/content.css` | 注入样式 |
| `shared/ui.js` | 判定元数据 + 结果卡片 DOM 构建（content 与 popup 共用） |
| `shared/providers.js` | 服务商预设 + 多模态静态识别 |
| `popup/` | 工具栏弹窗：手动文本检查 + 历史 |
| `options/` | 设置页：预设 / 模型拉取 / 多模态实测 / 配置概览仪表盘 |
| `tools/generate_icons.py` | 程序化绘制图标（纯标准库，旧方案） |
| `tools/build_icons.py` | 从 `icons/source-logo.jpg` 生成图标集（需 Pillow；`SHAPE = "circle"` 圆形为当前方案） |
| `icons/` | 扩展图标（16/32/48/128）+ `source-logo.jpg` 设计稿源文件 |

改判定逻辑 → `service-worker.js`；改卡片展示 → `shared/ui.js`（注意 popup 也用它）；改图标 → 改设计稿后跑 `tools/build_icons.py`。

## 关键设计决策

### 1. 提示词必须「证据中立、双向防误判」

`XR_SYSTEM_PROMPT` 是项目灵魂，经过多轮线上误判迭代（v0.4→v0.8）：

- **双向护栏**：「无媒体报道 ≠ 谣言」与「表述可信 ≠ 事实」必须同时存在。
  曾单边强调「严禁判谣言」，导致真谣言被压成 `not_rumor` / `suspected`（与平台结论相反）——改提示词时两个方向都要顾。
- **谣言复核关**（`XR_VERIFY_PROMPT`）：搜索失败时判 rumor 必须复核，模型给不出「确切的矛盾事实」就降级 suspected。
- 搜索失败路径允许模型用「确切知识为假（含常识）」判 rumor，但不允许「没听说过」式判定。

### 2. 搜索：偏好引擎优先 + 竞速兜底 + 按权重合并

`webSearch` 四引擎（Google/Bing/DDG/百度）**始终并行发起**，收口规则分三档：

1. 偏好引擎（`XR_ENGINE_META.preferred`，当前为 Google）在可用集合中：自发起时刻起最多等它 `XR_PREFERRED_WAIT`（1.5s 绝对窗口）；它明确失败则立即回落，不空等。
2. 偏好引擎超时/失败：回落到纯竞速 —— `Promise.any` 等首个成功，再等 `XR_COLLECT_WINDOW`（1.5s）收集其余引擎结果；偏好引擎胜出时只等 `XR_PREFERRED_COLLECT`（0.4s，其余结果多半已在途）。
3. 偏好引擎不在可用集合（未授权 / 冷却中）：直接竞速，零额外等待。

合并阶段 `searchMulti` 按**引擎可信度权重**排序（`XR_ENGINE_META.weight`：Google 100 > Bing 70 > DDG 60 > 百度 40），同权重再按查询顺序（原文 → 去年份 → 实体组合），最后 URL 去重并截断到 `XR_SEARCH_MAX_RESULTS`（12 条）。**不按返回先后排序**——那会让先到的引擎吃满名额、权威信源被截断。

引擎健康度落地在 `chrome.storage.local` 的 `xrEngineHealth`（失败引擎 30 分钟冷却）。**不要再退回纯内存 Map**：MV3 的 SW 空闲 30s 即回收，内存记录丢失会让被墙引擎每次核查都被重新探测、重复白等超时（实测 Google/DDG 各 7s）。

> 不要改回串行降级——那是「查询慢」的根因之一。

### 3. 解析搜索引擎 HTML 用正则，不引依赖

各引擎解析函数（`searchGoogle` 等）用正则锚定稳定结构（Google 以 `<h3>` 为锚）。引擎改版导致失配时修正则，不引入 cheerio / jsdom。

### 4. 配图：压缩后再送模型

`downloadImageAsDataUrl` 并行下载 + `OffscreenCanvas` 压到最长边 768px JPEG（q0.78），压缩失败降级原图 data URL。不要直接送原图 base64（payload 过大）。

### 5. 结果缓存与存储

- 核查结果缓存：`chrome.storage.local` 的 `xrResultCache`，TTL 30 分钟，上限 50 条，key = 文本 hash + 配图数
- API Key 与配置：`chrome.storage.sync`；历史记录：`chrome.storage.local`（`xrHistory`，上限 20）
- 多模态能力实测缓存：`xrCaps`（模型名 → { vision, note, ts }）

## 数据流

```
content （操作栏按钮 + 配图提取）
   │ chrome.runtime.sendMessage({type:"CHECK"})
   ▼
service-worker
   ① 检索与配图**并行**（两条独立的 I/O 链，不要改回串行）
        · webSearch 四引擎并行 + 偏好优先 → searchMulti 按权重合并
        · 配图并行下载 + 压缩
   ② 组装 text + 配图 + 资料   ──► 调 OpenAI 兼容 /chat/completions（45s 超时上限）
   ③ parseVerdict 容错解析 JSON（剥离 ```json 围栏）
   ④ 谣言复核关（**本次未取到资料** + 初判 rumor 时）
   ⑤ 写历史 + 结果缓存 + 分段耗时（result.timing）
   │ sendResponse
   ▼
content 渲染卡片（shared/ui.js 的 xrBuildCard）
```

## 兼容性约束

- 目标：任意 OpenAI 兼容接口（OpenAI/DeepSeek/GLM/Kimi/通义/硅基流动/OpenRouter/Ollama 本地）。
- `response_format: {type:"json_object"}` 只在非 `maxTokens` 场景启用，且必须保留 400/相关报错时自动去掉重试的降级路径（部分中转不支持）。
- 本地服务（Ollama）允许无 API Key（`requireEndpoint` 里的 localhost 判断）。
- 判定输出是 JSON 但要求容错解析（`parseVerdict` 会剥 ```json 围栏）。

## 权限模型

- 必需权限仅 `https://x.com/*`（注入）。
- 接口域名 / 搜索引擎 / 推文配图域（`pbs.twimg.com`）均为**可选权限**，在设置页点击手势（保存 / 测试 / 拉取 / 实测）中按需申请，见 `options/options.js` 的 `ensureHostPermissions`。

## 验证方式（无自动化测试）

1. 语法：`node --check background/service-worker.js`（以及改动的每个 js）
2. 竞速 / 异步逻辑：写临时 mock 引擎脚本用 node 跑通再删
3. 手动：`chrome://extensions` → 重新加载扩展 → x.com 实测检查按钮；设置页「测试连接」
4. 边界用例：搜索全部失败、模型不支持图片（自动降级纯文本）、`response_format` 不支持的服务商