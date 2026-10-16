import type { AiProvider, ReaderSettings } from "./types.ts";

/** 仅预填接口，不写死模型：使用服务商实际返回的列表，也允许手填。 */
export const AI_PROVIDER_PRESETS = [
  { name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com" },
  { name: "通义千问（北京）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1" },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { name: "自定义", baseUrl: "" },
] as const;

export function getAiProviders(settings: ReaderSettings): AiProvider[] {
  if (settings.aiProviders?.length) return settings.aiProviders;
  if (!settings.aiBaseUrl && !settings.aiApiKey && !settings.aiModel && !settings.aiFallbackModel) return [];
  return [{
    id: "legacy", name: "原有配置", baseUrl: settings.aiBaseUrl,
    apiKey: settings.aiApiKey, model: settings.aiModel, fallbackModel: settings.aiFallbackModel,
  }];
}

export function activeAiProvider(settings: ReaderSettings): AiProvider | undefined {
  const providers = getAiProviders(settings);
  return providers.find(provider => provider.id === settings.aiActiveProviderId) ?? providers[0];
}

export function fallbackAiProvider(settings: ReaderSettings): AiProvider | undefined {
  return getAiProviders(settings).find(provider =>
    provider.id === settings.aiFallbackProviderId && provider.id !== activeAiProvider(settings)?.id &&
    provider.baseUrl.trim() && provider.model.trim());
}

/** 同步保留旧字段，旧版客户端和既有调用方仍能读到当前配置。 */
export function withAiProviders(
  settings: ReaderSettings,
  providers: AiProvider[],
  activeId = settings.aiActiveProviderId,
): ReaderSettings {
  const active = providers.find(provider => provider.id === activeId) ?? providers[0];
  return {
    ...settings,
    aiProviders: providers,
    aiActiveProviderId: active?.id ?? "",
    aiFallbackProviderId: providers.some(provider => provider.id === settings.aiFallbackProviderId && provider.id !== active?.id)
      ? settings.aiFallbackProviderId : "",
    aiBaseUrl: active?.baseUrl ?? "",
    aiApiKey: active?.apiKey ?? "",
    aiModel: active?.model ?? "",
    aiFallbackModel: active?.fallbackModel ?? "",
  };
}

export function normalizeAiSettings(settings: ReaderSettings): ReaderSettings {
  return withAiProviders(settings, getAiProviders(settings));
}
