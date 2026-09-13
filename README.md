# X-Really · 推文谣言检查器

**X 上发的，到底是不是真的？** 一款在 X（Twitter）上用 AI 多模态 + 联网双核查，一键判断推文字是否谣言的 Chrome 插件（Manifest V3，兼容 Edge / Arc / Brave）。

[**安装**](#-安装) · [**使用教程**](#-使用教程) · [**工作原理**](#-工作原理) · [**隐私**](#-隐私) · [**目录结构**](#-目录结构) · [**免责声明**](#-免责声明)

## 📦 安装

```bash
git clone https://github.com/vanyusha1881/x-really.git
```

1. 打开 `chrome://extensions/` → 开启「开发者模式」
2. 点「加载已解压的扩展程序」，选择仓库根目录（含 `manifest.json` 的那层）
3. 桌面工具栏图标 → **固定**，便于使用

## 🚀 使用教程

- **在 X 上**：打开 [x.com](https://x.com)，点击每条推文操作栏末尾的 🛡 按钮 → 正文下方弹出结果卡片（判定 / 结论 / 依据 / 来源）。按钮按判定结果着色，悬停可看结论，点 `×` 关闭。
- **手动检查**：点击工具栏图标 → 粘贴任意文本 → 点「开始检查」（或 `Ctrl+Enter`）。
- 首次使用需在**设置页**配置一个 AI 接口（内置 DeepSeek / GLM / Kimi / 通义 / 硅基流动 / OpenRouter / Ollama 等预设，也支持任意 OpenAI 兼容地址）。

## 🧠 工作原理

点检查 → ① 四引擎（Google / Bing / DDG / 百度）并行搜索（Google 优先，结果按信源权重合并）+ 并行抓取推文配图（≤4 张）→ ② 文本、资料、配图一并交给你配置的 AI → ③ 输出结构化 JSON 判定 → ④ 卡片展示。

- **判定三档**：`谣言` / `不是谣言` / `存疑`（禁止用「存疑」回避结论）
- **双向防误判**：无媒体报道 ≠ 谣言；表述可信 ≠ 事实
- **谣言复核关**：搜索失败时判谣言须复核，给不出确切矛盾事实则降级为存疑
- **结果缓存**：相同内容 30 分钟内秒回

## 🔒 隐私

无自有服务器，无统计 / 追踪 / 广告。必需权限仅 `x.com`；接口 / 搜索引擎 / 配图域为可选权限，按需授权。Key 与配置仅存浏览器本地，网络请求只在**用户主动检查**时发出。完整政策见 [privacy.html](privacy.html)。

## 📁 目录结构

```
x-really/
├── manifest.json              # MV3 清单
├── README.md · LICENSE · privacy.html
├── docs/                      # ARCHITECTURE.md · CHANGELOG.md
├── icons/                     # 扩展图标（16/32/48/128，圆形）+ source-logo.jpg 设计稿
├── tools/generate_icons.py    # 程序化绘制图标（纯标准库，旧方案）
├── tools/build_icons.py       # 从设计稿生成图标集（需 Pillow：抠图 + 圆形裁切 + 多尺寸锐化）
├── background/service-worker.js  # 检索调度（引擎优先级/权重合并）/ AI 调用 / 解析 / 历史 / 能力实测
├── content/                   # X 页面：操作栏按钮 + 结果卡片
├── popup/                     # 手动检查 + 历史
├── options/                   # 设置页（预设 / 模型拉取 / 能力检测）
└── shared/                    # common.css · providers.js · ui.js
```

## ⚠️ 免责声明

判定结果由大语言模型生成，**无法替代事实核查**，仅供辅助参考。请勿作为事实认定的唯一依据。

## 📄 License

MIT