import type { PlayerVoice } from "./types";

/** 云端音色的 voiceURI 统一加前缀，好和系统语音区分开。 */
export const EDGE_VOICE_PREFIX = "edge:";

/**
 * 默认音色：云健。2026-09-24 用户逐个听过 Edge 的中文音色，只认它（浑厚沉稳），
 * 其余几个（晓晓、晓伊、云希、云扬、云夏、台湾腔、粤语）都判了不行，所以列表里只留它。
 * 要加新音色，先合成样音给用户听过再加，别凭感觉往里塞。
 */
export const DEFAULT_EDGE_VOICE = "zh-CN-YunjianNeural";

/**
 * 听书面板和设置里能选的音色。系统自带语音不进这张表：
 * 它们只在云端不可用时自动顶上，界面上会明确提示「已切换到系统朗读」。
 */
export const EDGE_VOICES: PlayerVoice[] = [
  { voiceURI: `${EDGE_VOICE_PREFIX}zh-CN-YunjianNeural`, name: "云健 · 云端男声", lang: "zh-CN 浑厚沉稳" },
];

const OFFERED = new Set(EDGE_VOICES.map((voice) => voice.voiceURI));

export function isEdgeVoiceURI(voiceURI: string): boolean {
  return voiceURI.startsWith(EDGE_VOICE_PREFIX);
}

/**
 * 设置里存的音色不在可选列表里（旧版本选过已经下架的音色、或者选过系统语音），
 * 一律当成默认。空串本来就表示默认。
 */
export function normalizeVoiceURI(voiceURI: string): string {
  return OFFERED.has(voiceURI) ? voiceURI : "";
}

export function edgeVoiceName(voiceURI: string): string {
  const normalized = normalizeVoiceURI(voiceURI);
  return normalized ? normalized.slice(EDGE_VOICE_PREFIX.length) : DEFAULT_EDGE_VOICE;
}

/**
 * 「默认」和显式选中云健其实是同一个音色。要显示「正在播放的是谁」「选中的是谁」时
 * 得先折算成具体音色，否则默认模式下这一栏永远是空的。
 */
export function resolvedEdgeVoiceURI(voiceURI: string): string {
  return `${EDGE_VOICE_PREFIX}${edgeVoiceName(voiceURI)}`;
}
