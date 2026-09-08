# AGENTS.md — x-really 开发约定

面向 AI 编码代理与本仓库的协作规范。改代码前请先读完本文件。

## 项目是什么

X-Really：Chrome 扩展（Manifest V3），在 X (Twitter) 上对推文做 AI 事实核查（谣言检测）。
技术栈：**纯原生 JavaScript，无构建步骤、无打包器、无依赖、无框架**。改完即生效（浏览器重新加载扩展即可），不要引入 npm/bundler/TS。

## 目录与职责

```
manifest.json            # MV3 清单；版本号在这里 bump
background/service-worker.js  # 核心：搜索（4引擎竞速）+ LLM 调用 + 提示词 + 缓存 + 历史
content/content.js       # X 页面注入：操作栏按钮 + 结果卡片容器（文本/引用/配图提取）
content/content.css      # 注入样式
shared/ui.js             # 判定元数据 + 结果卡片 DOM 构建（content 与 popup 共用）
shared/providers.js       # 服务商预设 + 多模态静态识别
popup/                   # 工具栏弹窗：手动文本检查 + 历史
options/                 # 设置页：API 配置 / 模型拉取 / 多模态实测
tools/generate_icons.py  # 图标生成（无第三方依赖）
```

改判定逻辑 → `service-worker.js`；改卡片展示 → `shared/ui.js`（注意 popup 也用它）。

## 关键设计决策（不要轻易推翻）

### 1. 提示词必须"证据中立、双向防误判"

`XR_SYSTEM_PROMPT` 是本项目的灵魂，经过多轮线上误判迭代（v0.4→v0.8）：

- **双向护栏**："无媒体报道 ≠ 谣言" 与 "表述可信 ≠ 事实" 必须同时存在。
  v0.5 曾单边强调"严禁判谣言"，导致真谣言被压成 not_rumor/suspected（与 Gemini/ChatGPT/DeepSeek 平台结论相反）——这是已踩过的坑，改提示词时两个方向都要顾。
- 谣言复核关（`XR_VERIFY_PROMPT`）：搜索失败时判 rumor 必须复核，模型给不出"确切的矛盾事实"就降级 suspected。保留此机制。
- 搜索失败路径允许模型用"确切知识为假（含常识）"判 rumor，但不允许"没听说过"式判定。

### 2. 搜索：并行竞速 + 收集窗口

`webSearch` 四引擎（Google/Bing/DDG/百度）**并行发起**，`Promise.any` 等首个成功，再等 1.5s（`XR_COLLECT_WINDOW`）收集其余引擎结果合并。失败引擎进 30 分钟冷却（内存 Map，SW 重启即清空，属预期）。
不要改回串行降级——那是"查询慢"的根因之一。

### 3. 解析搜索引擎 HTML 用正则，不引依赖

各引擎解析函数（`searchGoogle` 等）用正则锚定稳定结构（Google 以 `<h3>` 为锚）。引擎改版导致失配时修正则，不引入 cheerio/jsdom。

### 4. 配图：压缩后再送模型

`downloadImageAsDataUrl` 并行下载 + `OffscreenCanvas` 压到最长边 768px JPEG（q0.78），压缩失败降级原图 data URL。不要直接送原图 base64（payload 过大）。

### 5. 结果缓存与存储

- 核查结果缓存：`chrome.storage.local` 的 `xrResultCache`，TTL 30 分钟，上限 50 条，key = 文本 hash + 配图数
- API Key 与配置：`chrome.storage.sync`；历史记录：`chrome.storage.local`（`xrHistory`，上限 20）
- 多模态能力实测缓存：`xrCaps`

## 隐私红线

- **任何密钥/凭据不得写入仓库文件**（历史已验证干净，保持）。配置只存在于浏览器 storage。
- 新增网络请求仅限"用户主动点击检查"时触发；不要加遥测/统计。
- `host_permissions` 已是 `https://*/*`，无需扩权。

## 兼容性约束

- 目标：任意 OpenAI 兼容接口（OpenAI/DeepSeek/GLM/Kimi/通义/硅基流动/OpenRouter/Ollama 本地）。
- `response_format: {type:"json_object"}` 只在非 `maxTokens` 场景启用，且必须保留 400/相关报错时自动去掉重试的降级路径（部分中转不支持）。
- 本地服务（Ollama）允许无 API Key（`requireEndpoint` 里的 localhost 判断）。
- 判定输出是 JSON 但要容错解析（`parseVerdict` 会剥 ```json 围栏），因为不是所有模型都守规矩。

## 提交与版本规范

- 版本号三处同步：`manifest.json` 的 `version`、`service-worker.js` 顶部注释（追加一行 vX.Y 说明）、README 的特性描述。
- 提交信息格式：`feat|fix: vX.Y 一句话中文描述`（见 git log 先例）。
- 遵循 `/commit` 流程，不 `--no-verify`。

## 验证方式（没有自动化测试）

1. 语法：`node --check background/service-worker.js`（以及改动的每个 js）
2. 竞速/异步逻辑：写临时 mock 引擎脚本用 node 跑通再删（先例见 2026-09-09 的优化）
3. 手动：`chrome://extensions` → 重新加载扩展 → x.com 实测检查按钮；设置页"测试连接"
4. 边界用例：搜索全部失败、模型不支持图片（自动降级纯文本）、`response_format` 不支持的服务商

## 测试账号/环境

无后端、无服务端部署。开发即改本地文件 + 浏览器重载。
