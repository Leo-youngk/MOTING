/** 阅读、听书的确认协议。设备时间只用于显示，不参与新协议的冲突胜负。 */
export type ProgressKind = "positions" | "listening";

export interface ProgressRecord {
  key: string;
  data: unknown;
  updatedAt: number;
  serverAt: number;
  mutationId?: string;
}

export interface ProgressReceipt {
  kind: ProgressKind;
  key: string;
  mutationId?: string;
  status: "accepted" | "conflict" | "upgrade";
  record?: ProgressRecord;
}

/** 同一键的最新位置与待上传状态同事务保存；确认只能清理对应 mutation。 */
export interface QueuedProgress {
  id: string;
  kind: ProgressKind;
  key: string;
  data: string;
  updatedAt: number;
  seq: number;
  mutationId: string;
  baseServerRev: number;
  serverRev: number;
  pending: boolean;
  /** 仅旧库第一次对账使用原时间，不能把旧位置改成当前时间强推。 */
  bootstrap: boolean;
  conflict?: { data: string; updatedAt: number };
  rejection?: string;
}

export function progressId(kind: ProgressKind, key: string): string {
  return `${kind}:${key}`;
}

/** 网络返回旧确认时，保留上传期间产生的新位置，并接续自己刚提交的版本。 */
export function acknowledgeProgress(current: QueuedProgress, receipt: ProgressReceipt): QueuedProgress {
  const record = receipt.record;
  if (!record || record.serverAt < current.serverRev || receipt.status === "upgrade") return current;
  if (receipt.status === "accepted" && current.pending && current.mutationId !== receipt.mutationId) {
    return { ...current, serverRev: record.serverAt, baseServerRev: record.serverAt };
  }
  return {
    ...current,
    serverRev: record.serverAt,
    baseServerRev: record.serverAt,
    pending: false,
    bootstrap: false,
    data: JSON.stringify(record.data),
    updatedAt: record.updatedAt,
    conflict: receipt.status === "conflict"
      ? { data: current.data, updatedAt: current.updatedAt }
      : undefined,
  };
}
