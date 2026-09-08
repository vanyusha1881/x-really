// X-Really 服务商预设与模型能力静态识别（options 页使用）
// 参考 cc-switch / Cherry Studio 的预设思路：点击卡片即完成 baseUrl + 推荐模型填充

const XR_PROVIDERS = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "o4-mini"],
    keyUrl: "https://platform.openai.com/api-keys",
    accent: "#10a37f",
    tag: "国际",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    keyUrl: "https://platform.deepseek.com/api_keys",
    accent: "#4d6bfe",
    tag: "国内",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4.5-flash",
    models: ["glm-4.5-flash", "glm-4-flash", "glm-4-plus", "glm-4v-flash"],
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    accent: "#2f5cff",
    tag: "国内",
  },
  {
    id: "moonshot",
    name: "Moonshot · Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-8k",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "kimi-latest", "kimi-k2-0711-preview"],
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    accent: "#0d9488",
    tag: "国内",
  },
  {
    id: "qwen",
    name: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-turbo",
    models: ["qwen-turbo", "qwen-plus", "qwen-max", "qwen-vl-plus"],
    keyUrl: "https://bailian.console.aliyun.com/",
    accent: "#7c3aed",
    tag: "国内",
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "deepseek-ai/DeepSeek-V3",
    models: [
      "deepseek-ai/DeepSeek-V3",
      "deepseek-ai/DeepSeek-R1",
      "Qwen/Qwen2.5-72B-Instruct",
      "THUDM/glm-4-9b-chat",
    ],
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    accent: "#8b5cf6",
    tag: "国内",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    models: ["openai/gpt-4o-mini", "google/gemini-2.0-flash-001", "anthropic/claude-3.5-haiku"],
    keyUrl: "https://openrouter.ai/keys",
    accent: "#f59e0b",
    tag: "国际",
  },
  {
    id: "ollama",
    name: "Ollama 本地",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen2.5",
    models: [],
    keyUrl: "",
    accent: "#64748b",
    tag: "本地",
    note: "需本机运行 Ollama，无需 API Key",
  },
  {
    id: "custom",
    name: "自定义",
    baseUrl: "",
    defaultModel: "",
    models: [],
    keyUrl: "",
    accent: "#8b98a5",
    tag: "",
  },
];

// 静态多模态（图片理解）能力识别：按模型命名特征判断
const XR_VISION_YES_RE = [
  /gpt-4o/, /gpt-4\.1/, /gpt-4-turbo/, /^o[34]/, /chatgpt-4o/, /gemini/, /claude-[3-9]/,
  /glm-4v/, /glm-[45][\d.]*v/, /qvq/, /qwen.*vl/, /doubao.*vision/, /-vision/, /kimi-latest/,
  /kimi.*vision/, /internvl/, /llava/, /deepseek-vl/, /step-1v/, /step-1o/, /yi-vision/,
  /pixtral/, /grok-[24].*vision/, /llama-3\.2.*vision/, /hunyuan-vision/, /minimonkey/,
];
const XR_VISION_NO_RE = [
  /deepseek-(chat|reasoner|v3|r1)/, /^glm-4-(flash|air|plus|long)$/, /qwen-(turbo|plus|max)$/,
  /moonshot-v1-\d+k$/, /o1-mini/, /gpt-3\.5/, /mistral/, /yi-6b/, /yi-9b/,
];

/**
 * 静态判断模型是否支持多模态（图片理解）
 * @returns {"yes"|"no"|"unknown"}
 */
function xrDetectVisionStatic(model) {
  const m = String(model || "").toLowerCase().trim();
  if (!m) return "unknown";
  if (XR_VISION_NO_RE.some((re) => re.test(m))) return "no";
  if (XR_VISION_YES_RE.some((re) => re.test(m))) return "yes";
  return "unknown";
}

/** 按 baseUrl 反查预设（用于回显选中状态） */
function xrFindProvider(baseUrl) {
  const norm = String(baseUrl || "").replace(/\/+$/, "").toLowerCase();
  return (
    XR_PROVIDERS.find((p) => p.baseUrl && p.baseUrl.replace(/\/+$/, "").toLowerCase() === norm) ||
    null
  );
}
