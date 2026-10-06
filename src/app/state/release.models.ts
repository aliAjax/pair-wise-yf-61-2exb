export type BatchStatus = 'draft' | 'approved' | 'running' | 'paused' | 'completed' | 'rolled_back';

export interface DeviceGroup {
  id: string;
  name: string;
  region: string;
  count: number;
  compatible: boolean;
  offlineGateways: number;
  /** 分组并发占用上限：处于占用态的批次数超过该值时，新命令排队 */
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
  /** 乐观并发版本：仅命令提交或状态变更时递增，遥测进度不影响版本 */
  version: number;
  updatedAt: string;
}

export type CommandType = 'create' | 'approve' | 'pause' | 'resume' | 'rollback';

/** staged=本机暂存 queued=容量排队 committed=已入账 conflicted=版本/状态冲突退回 voided=兼容条件变化作废 */
export type CommandStatus = 'staged' | 'queued' | 'committed' | 'conflicted' | 'voided';

export interface CreateBatchPayload {
  name: string;
  firmware: string;
  rollbackVersion: string;
  groupId: string;
  rolloutPercent: number;
  failureThreshold: number;
}

export interface ReleaseCommand {
  /** 幂等键：同一命令重放只执行一次 */
  id: string;
  /** 账本顺序号，暂存时由账本分配 */
  seq: number;
  type: CommandType;
  batchId: string;
  /** 操作时看到的批次版本，入账时与当前版本比对，不一致即冲突退回 */
  baseVersion: number;
  actor: string;
  status: CommandStatus;
  /** 排队/冲突/作废原因 */
  reason?: string;
  createdAt: string;
  appliedAt?: string;
  payload?: CreateBatchPayload;
}

export type AuditKind = 'command' | 'handover' | 'system';

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  kind: AuditKind;
  message: string;
  commandId?: string;
}

export interface PersistenceState {
  ok: boolean;
  lastError?: string;
  /** 已持久化到的命令序号（断点），写入失败后从这里重试 */
  persistedCursor: number;
}

export interface ReleaseState {
  schemaVersion: number;
  groups: DeviceGroup[];
  batches: ReleaseBatch[];
  /** 命令账：暂存、排队与历史命令的 append-only 记录 */
  commands: ReleaseCommand[];
  /** 交接日志 */
  audits: AuditEntry[];
  /** 幂等注册表：已入账命令 id */
  appliedIds: string[];
  nextSeq: number;
  online: boolean;
  persistence: PersistenceState;
}

/** 占用分组容量的批次状态；其余状态（草稿/完成/回滚）自动释放占用 */
export const OCCUPYING_STATUSES: readonly BatchStatus[] = ['approved', 'running', 'paused'];

export function groupOccupancy(batches: ReleaseBatch[], groupId: string): number {
  return batches.filter((batch) => batch.groupId === groupId && OCCUPYING_STATUSES.includes(batch.status)).length;
}

export function isPendingCommand(command: ReleaseCommand): boolean {
  return command.status === 'staged' || command.status === 'queued';
}
