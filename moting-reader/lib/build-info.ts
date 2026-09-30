declare const __MOTING_BUILD__: string;

export const SYNC_PROTOCOL = 4;
export const APP_BUILD = typeof __MOTING_BUILD__ === "string" ? __MOTING_BUILD__ : "development";
