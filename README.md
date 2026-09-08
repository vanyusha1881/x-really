# x-really · 推文谣言检查器

在 X（Twitter）上一键检查推文是否为谣言的浏览器插件。基于 AI 分析，给出 **判定 / 置信度 / 理由 / 给读者的建议**。

> 名称含义：**X-Really** —— "X 上发的，到底是不是真的？"（Is it **really** true?）

## ✨ 功能特性

- 🛡 **在推文旁一键检查**：每条推文下方自动出现「检查谣言」按钮，点击即可分析
- 📋 **手动文本检查**：点击工具栏图标，粘贴任意文本也能分析
- 🎯 **四档判定 + 置信度**：谣言 / 存疑 / 未见谣言特征 / 无法判断，并给出 0–100 置信度
- 💡 **理由 + 建议**：除结论外，列出 2–4 条依据与一条可操作建议
- 🧠 **兼容任意 OpenAI 协议**：默认 OpenAI，也支持 DeepSeek、Moonshot(Kimi)、通义千问等
- 🕘 **最近 20 条历史**：自动保存，Popup 内可回看
- 🌗 **明暗双主题兼容**：注入卡片为深色面板，适配 X 的暗/亮主题
- 🔒 **本地优先**：API Key 仅存于浏览器 `chrome.storage.sync`，不上传任何第三方

## 📦 安装

> 本项目使用 Chrome Manifest V3（兼容 Edge、Arc、Brave 等 Chromium 浏览器）

1. 下载或克隆本仓库
   ```bash
   git clone https://github.com/vanyusha1881/x-really.git
   ```
2. 打开浏览器，访问 `chrome://extensions/`
3. 打开右上角「**开发者模式**」
4. 点击「**加载已解压的扩展程序**」，选择本仓库根目录（含 `manifest.json` 的那一层）
5. 安装完成后，右键工具栏图标 → **固定**到工具栏，方便使用

## ⚙️ 配置 API

点击工具栏图标 → 右上角齿轮按钮，进入设置页，填写：

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| **接口地址 (Base URL)** | `https://api.openai.com/v1` | OpenAI 兼容协议的入口 |
| **API Key** | `sk-...` | 你的服务商密钥 |
| **模型名称** | `gpt-4o-mini` | 支持该服务商下任意 chat 模型 |

**国内常用服务**（同样兼容 OpenAI 协议）：

| 服务 | Base URL | 模型示例 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Moonshot(Kimi) | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| 阿里通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-turbo` |

填写后点击「**测试连接**」，看到 ✅ 表示配置成功。

## 🚀 使用

### 方式一：在 X 上检查推文

打开 [x.com](https://x.com)，每条推文下方会出现「🛡 检查谣言」按钮：

1. 点击按钮 → 出现「AI 分析中…」加载态
2. 几秒后，弹出深色结果卡片：
   - **判定标签**（含 emoji 与颜色：🚫 谣言 / ⚠️ 存疑 / ✅ 未见谣言特征 / ❔ 无法判断）
   - **置信度**
   - **一句话结论**
   - **理由列表**（2–4 条）
   - **💡 给读者的建议**
3. 点击卡片右上角 `×` 可关闭

> 推文文本变化（点赞、转发后重排）会自动重置结果。

### 方式二：手动检查任意文本

点击工具栏的 X-Really 图标：

- 顶部状态栏：显示当前配置与是否就绪
- 文本框：粘贴任意推文 / 新闻 / 聊天记录
- 点击「开始检查」（或 `Ctrl+Enter`）
- 下方显示历史检测列表，可一键清空

## 🧠 工作原理

```
┌──────────────┐    chrome.runtime     ┌─────────────────────┐
│ Content 脚本  │  ── sendMessage ──>   │ Background Service  │
│ (推文旁按钮)  │                       │   Worker            │
└──────────────┘                       └──────────┬──────────┘
                                                  │ fetch
                                                  ▼
                                       ┌─────────────────────┐
                                       │ OpenAI 兼容 API      │
                                       │ (Chat Completions)   │
                                       └──────────┬──────────┘
                                                  │
                                          JSON: {verdict,
                                          confidence, summary,
                                          reasons, advice}
                                                  │
┌──────────────┐                       ┌──────────▼──────────┐
│ Content 脚本  │  <── sendResponse ── │ 后台解析 + 历史记录  │
│ 渲染判定卡片  │                       │                     │
└──────────────┘                       └─────────────────────┘
```

- **判定 prompt**：内置中文系统提示，要求模型按「事实性 / 可疑信号 / 常识逻辑 / 谣言模式」四维分析，并 **严格输出 JSON**（容错解析，自动剥离 ```json 围栏）
- **判定档位**：
  - `rumor` 谣言 —— 明显虚假、已被证伪
  - `suspected` 存疑 —— 存在可疑信号但证据不足
  - `credible` 未见谣言特征 —— 与已知事实不冲突
  - `unknown` 无法判断 —— 过短 / 模糊 / 超出判断能力
- **历史记录**：最近 20 条检查结果，仅存于 `chrome.storage.local`（不跨设备同步）
- **文本长度**：单次检查截断 4000 字符

## 🔒 隐私

- ✅ API Key 与所有配置仅保存在浏览器本地（`chrome.storage.sync`）
- ✅ 历史记录仅保存在浏览器本地（`chrome.storage.local`）
- ✅ 本扩展**不向任何第三方服务器**发送数据；所有网络请求**仅**发生在「用户主动点击检查」时，且**仅**发往用户自己配置的 API 接口
- ❌ 不收集任何分析、统计、用户行为数据

## 📁 目录结构

```
x-really/
├── manifest.json              # MV3 清单
├── README.md
├── LICENSE
├── icons/                     # 自定义图标（纯 Python 生成）
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── tools/
│   └── generate_icons.py      # 图标生成脚本（无第三方依赖）
├── background/
│   └── service-worker.js      # 后台：AI 调用 / 解析 / 历史
├── content/
│   ├── content.js             # 推文旁按钮与结果卡片
│   └── content.css
├── popup/
│   ├── popup.html / css / js  # 工具栏弹出页
├── options/
│   └── options.html / css / js # 设置页
└── shared/
    ├── common.css             # 通用深色主题样式
    └── ui.js                  # 判定元数据 + 结果卡片构建
```

## 🗓 后续规划

- [ ] 多语言：英文 / 繁体（按浏览器语言自动切换）
- [ ] 推文级缓存：相同文本 30 分钟内复用历史结果
- [ ] 一键展开查看引用推文/链接
- [ ] 汇总面板：个人时间线可信度分布
- [ ] 打包发布到 Chrome Web Store

## ⚠️ 免责声明

本工具的判定结果由大语言模型基于其训练知识生成，**无法替代事实核查**，仅供辅助参考。
请勿将其作为事实认定的唯一依据，重要信息请以官方权威信源为准。

## 📄 License

MIT
