export type BatchStatus = 'draft' | 'approved' | 'running' | 'paused' | 'completed' | 'rolled_back';

/** 命令账中的命令类型 */
export type CommandType = 'create' | 'approve' | 'pause' | 'resume' | 'rollback';

/**
 * 命令在账中的状态：
 * - pending   已入账，等待补传执行
 * - queued    分组容量已满，排队等容量
 * - applied   已执行（重放幂等，不再执行）
 * - conflict  版本对不上或状态不允许，退回冲突
 * - voided    兼容条件变化，未执行的命令作废重算
 */
export type CommandStatus = 'queued' | 'pending' | 'applied' | 'conflict' | 'voided';

export interface DeviceGroup {
  id: string;
  name: string;
  region: string;
  count: number;
  compatible: boolean;
  offlineGateways: number;
  /** 同时占用容量（可并行发布的批次数） */
  capacity: number;
}

export interface ReleaseBatch {
  id: string;
  name: string;
  firmware: string;
  rollbackVersion: string;
  groupId: string;
  rolloutPercent: number;
  failureThreshold: number;
  status: BatchStatus;
  progress: number;
  downloaded: number;
  failed: number;
  updatedAt: string;
  /** 批次版本：每条命令记下操作时看到的版本，对不上即冲突 */
  version: number;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  message: string;
  commandId?: string;
}

/** 交接日志：换班时未完成命令接续给下一班 */
export interface HandoverEntry {
  id: string;
  at: string;
  from: string;
  to: string;
  note: string;
  /** 交接时未完成（待执行/排队）的命令数 */
  pendingCommands: number;
}

/**
 * 命令账条目。发布批次、设备分组、交接日志通过命令账接成可接续的一本账：
 * 每条命令记录操作时看到的批次版本，重放只执行一次。
 */
export interface CommandEntry {
  id: string;
  /** 入账顺序号，断网补传按此顺序合并 */
  seq: number;
  type: CommandType;
  /** 目标批次 id；create 命令在 payload.batch 中携带新批次 */
  batchId: string | null;
  /** 操作时看到的批次版本；create 无版本 */
  expectedVersion: number | null;
  payload: Record<string, unknown>;
  actor: string;
  /** 交接班次，标识命令由哪一班接续 */
  shift: string;
  status: CommandStatus;
  /** 冲突 / 作废 / 排队原因 */
  reason?: string;
  attempts: number;
  createdAt: string;
  appliedAt?: string;
}

export interface ReleaseState {
  groups: DeviceGroup[];
  batches: ReleaseBatch[];
  audits: AuditEntry[];
  /** 命令账：所有操作以命令为准，顺序追加、不覆盖 */
  ledger: CommandEntry[];
  /** 分组占用：groupId -> 占用中的 batchId 列表（暂停/完成/回滚必须释放） */
  occupancy: Record<string, string[]>;
  /** 交接日志 */
  handovers: HandoverEntry[];
  /** 下一条命令的顺序号 */
  nextSeq: number;
}
