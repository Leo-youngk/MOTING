import type { PlayerVoice } from "./types";

/** 云端音色的 voiceURI 统一加前缀，好和系统语音区分开。 */
export const EDGE_VOICE_PREFIX = "edge:";

export const DEFAULT_EDGE_VOICE = "zh-CN-XiaoxiaoNeural";

export const EDGE_VOICES: PlayerVoice[] = [
  { voiceURI: `${EDGE_VOICE_PREFIX}zh-CN-XiaoxiaoNeural`, name: "晓晓 · 云端女声", lang: "zh-CN 温柔知性" },
  { voiceURI: `${EDGE_VOICE_PREFIX}zh-CN-XiaoyiNeural`, name: "晓伊 · 云端女声", lang: "zh-CN 明亮活泼" },
  { voiceURI: `${EDGE_VOICE_PREFIX}zh-CN-YunxiNeural`, name: "云希 · 云端男声", lang: "zh-CN 清朗阳光" },
  { voiceURI: `${EDGE_VOICE_PREFIX}zh-CN-YunjianNeural`, name: "云健 · 云端男声", lang: "zh-CN 浑厚沉稳" },
  { voiceURI: `${EDGE_VOICE_PREFIX}zh-CN-YunyangNeural`, name: "云扬 · 云端男声", lang: "zh-CN 播音腔" },
  { voiceURI: `${EDGE_VOICE_PREFIX}zh-CN-YunxiaNeural`, name: "云夏 · 云端男声", lang: "zh-CN 少年感" },
  { voiceURI: `${EDGE_VOICE_PREFIX}zh-TW-HsiaoChenNeural`, name: "晓臻 · 云端女声", lang: "zh-TW 台湾国语" },
  { voiceURI: `${EDGE_VOICE_PREFIX}zh-HK-HiuMaanNeural`, name: "晓曼 · 云端女声", lang: "zh-HK 粤语" },
];

export function isEdgeVoiceURI(voiceURI: string): boolean {
  return voiceURI.startsWith(EDGE_VOICE_PREFIX);
}

export function edgeVoiceName(voiceURI: string): string {
  return isEdgeVoiceURI(voiceURI)
    ? voiceURI.slice(EDGE_VOICE_PREFIX.length)
    : DEFAULT_EDGE_VOICE;
}
