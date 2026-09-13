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
tools/generate_icons.py  # 程序化绘制图标（纯标准库，旧盾牌方案，留作参考）
tools/build_icons.py     # 从 icons/source-logo.jpg 生成图标集（需 Pillow：抠图 + 形态裁切 + 多尺寸锐化）
                         #   SHAPE = "circle"（当前，圆形）| "rounded"（旧圆角方形，轮廓与原设计一致）
                         #   圆形方案按尺寸分档内缩：CIRCLE_PLAN = {128:0.90, 48:0.90, 32:1.00, 16:1.06}
                         #   （直接圆裁会切掉卡片左下角与底部互动图标，故大尺寸留边、小尺寸放大）
                         #   改设计稿后：python tools/build_icons.py 重新生成 icon16/32/48/128 + icon.png
                         #   注意：icons/icon.png 与 source-logo.jpg 仅作源文件，不打进商店 zip
```

改判定逻辑 → `service-worker.js`；改卡片展示 → `shared/ui.js`（注意 popup 也用它）。

## 关键设计决策（不要轻易推翻）

### 1. 提示词必须"证据中立、双向防误判"

`XR_SYSTEM_PROMPT` 是本项目的灵魂，经过多轮线上误判迭代（v0.4→v0.8）：

- **双向护栏**："无媒体报道 ≠ 谣言" 与 "表述可信 ≠ 事实" 必须同时存在。
  v0.5 曾单边强调"严禁判谣言"，导致真谣言被压成 not_rumor/suspected（与 Gemini/ChatGPT/DeepSeek 平台结论相反）——这是已踩过的坑，改提示词时两个方向都要顾。
- 谣言复核关（`XR_VERIFY_PROMPT`）：搜索失败时判 rumor 必须复核，模型给不出"确切的矛盾事实"就降级 suspected。保留此机制。
- 搜索失败路径允许模型用"确切知识为假（含常识）"判 rumor，但不允许"没听说过"式判定。

### 2. 搜索：偏好引擎优先 + 竞速兜底 + 按权重合并

`webSearch` 四引擎（Google/Bing/DDG/百度）**始终并行发起**，收口分三档：

1. 偏好引擎（`XR_ENGINE_META.preferred`，当前 Google）可用时：自发起时刻起最多等 `XR_PREFERRED_WAIT`（1.5s 绝对窗口）；它明确失败立即回落，不空等。
2. 超时/失败 → 回落纯竞速：`Promise.any` 首个成功 + `XR_COLLECT_WINDOW`（1.5s）收集窗口；偏好引擎胜出时只等 `XR_PREFERRED_COLLECT`（0.4s）。
3. 偏好引擎不可用（未授权 / 冷却中）→ 直接竞速，零额外等待。

合并由 `searchMulti` 完成：按**引擎可信度权重**排序（Google 100 > Bing 70 > DDG 60 > 百度 40），同权重按查询顺序（原文 → 去年份 → 实体组合），再 URL 去重、截断到 `XR_SEARCH_MAX_RESULTS`（12 条）。**不要按返回先后排序**——先到的引擎会吃满名额，权威信源反被截断。

引擎健康度落地 `chrome.storage.local` 的 `xrEngineHealth`（失败 30 分钟冷却）。**不要退回纯内存 Map**：MV3 SW 空闲 30s 即回收，记录丢失会让被墙引擎每次核查都重新探测、重复白等 7s。

不要改回串行降级——那是"查询慢"的根因之一。

### 2.1 检索与配图必须并行

`checkText` 里检索（`searchTask`）与配图（`imageTask`）是两条互不依赖的 I/O 链，用 `Promise.all` 并行。**不要改回"先 await 搜索、再下载配图"的串行写法**（白等一段）。

### 2.2 模型调用必须有超时上限

`callLLM` 用 `AbortController` + `XR_LLM_TIMEOUT`（45s）包住"请求 + 重试 + 读响应"，超时转 `TIMEOUT` 错误。**不要去掉**：没有上限时接口卡住会表现为"永远转圈"。

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
- 权限面保持最小：必需 `host_permissions` 仅 `https://x.com/*`；接口域名 / 搜索引擎 / `pbs.twimg.com` 一律走 `optional_host_permissions`，只在用户手势（设置页保存/测试/拉取/实测）中申请，不要塞回必需权限。

## 兼容性约束

- 目标：任意 OpenAI 兼容接口（OpenAI/DeepSeek/GLM/Kimi/通义/硅基流动/OpenRouter/Ollama 本地）。
- `response_format: {type:"json_object"}` 只在非 `maxTokens` 场景启用，且必须保留 400/相关报错时自动去掉重试的降级路径（部分中转不支持）。
- 本地服务（Ollama）允许无 API Key（`requireEndpoint` 里的 localhost 判断）。
- 判定输出是 JSON 但要容错解析（`parseVerdict` 会剥 ```json 围栏），因为不是所有模型都守规矩。

## 本地加载与打包（踩过的坑）

- 开发时「加载已解压的扩展程序」指向**项目根目录**，因此根目录（及所有子目录）里**不能有任何以 `_` 开头的文件或目录名**——Chrome 会直接报 `Cannot load extension with file or directory name _xxx` 并拒绝加载。
- 打包暂存目录一律放 `.workbuddy/release/`（点开头，Chrome 忽略，且已在 .gitignore）。**不要**在项目根建 `_release/` 之类的目录。
- 验证扩展目录是否合法（走与"加载已解压扩展"相同的校验）：
  `chrome.exe --pack-extension="<目录>"` —— 返回码 0 且生成 `.crx` 即通过。
- 商店包（`x-really-v*.zip`）放在根目录无妨（Chrome 只对 `_` 前缀敏感），需保证 manifest.json 在 zip 根。

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
