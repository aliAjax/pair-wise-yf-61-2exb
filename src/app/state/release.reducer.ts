import { createReducer, on } from '@ngrx/store';
import type { AuditEntry, CommandEntry, CommandStatus, DeviceGroup, HandoverEntry, ReleaseBatch, ReleaseState } from './release.models';
import { applyCommand, enqueueCommand, handover, setGroupCompatibility, telemetryTick } from './release.actions';

const defaultCapacity = 2;

const initialGroups: DeviceGroup[] = [
  { id: 'g-edge', name: '华东边缘网关', region: '华东', count: 680, compatible: true, offlineGateways: 4, capacity: 2 },
  { id: 'g-plant', name: '工业采集终端', region: '华南', count: 1240, compatible: false, offlineGateways: 12, capacity: 1 },
  { id: 'g-clinic', name: '远程诊疗终端', region: '新加坡', count: 310, compatible: true, offlineGateways: 2, capacity: 2 }
];

function buildInitialState(): ReleaseState {
  const now = new Date().toISOString();
  const batches: ReleaseBatch[] = [
    { id: 'batch-demo', name: '边缘网关安全补丁 2.8.1', firmware: '2.8.1', rollbackVersion: '2.7.9', groupId: 'g-edge', rolloutPercent: 20, failureThreshold: 5, status: 'approved', progress: 0, downloaded: 0, failed: 0, updatedAt: now, version: 1 }
  ];
  return {
    groups: initialGroups,
    batches,
    audits: [{ id: 'audit-1', at: now, actor: '运维值班', message: '批次 batch-demo 完成兼容性检查并进入已审批' }],
    ledger: [],
    occupancy: {},
    handovers: [],
    nextSeq: 1
  };
}

/** 旧数据迁移：缺少版本的批次补成初始版本，缺少账本科目补空账 */
function migrate(raw: Partial<ReleaseState> | null): ReleaseState {
  if (!raw) return buildInitialState();
  const groups = (raw.groups && raw.groups.length ? raw.groups : initialGroups).map((group) => ({ ...group, capacity: group.capacity ?? defaultCapacity }));
  const batches = (raw.batches ?? []).map((batch) => ({ ...batch, version: batch.version ?? 1 }));
  const ledger = raw.ledger ?? [];
  return {
    groups,
    batches,
    audits: raw.audits ?? [],
    ledger,
    occupancy: raw.occupancy ?? {},
    handovers: raw.handovers ?? [],
    nextSeq: raw.nextSeq ?? ledger.length + 1
  };
}

const STORAGE_KEY = 'firmware-release-v1';
function loadState(): ReleaseState {
  if (typeof localStorage === 'undefined') return buildInitialState();
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<ReleaseState> | null;
    return migrate(raw);
  } catch {
    return buildInitialState();
  }
}

function audit(state: ReleaseState, actor: string, message: string, commandId?: string): AuditEntry[] {
  return [{ id: crypto.randomUUID(), at: new Date().toISOString(), actor, message, commandId }, ...state.audits];
}

/* ---------- 分组占用：暂停/完成/回滚必须释放 ---------- */

function isCapacityFull(state: ReleaseState, groupId: string): boolean {
  const group = state.groups.find((item) => item.id === groupId);
  return (state.occupancy[groupId]?.length ?? 0) >= (group?.capacity ?? defaultCapacity);
}

function addOccupancy(state: ReleaseState, groupId: string, batchId: string): ReleaseState['occupancy'] {
  const current = state.occupancy[groupId] ?? [];
  return { ...state.occupancy, [groupId]: [...new Set([...current, batchId])] };
}

function releaseOccupancy(state: ReleaseState, groupId: string, batchId: string): ReleaseState['occupancy'] {
  return { ...state.occupancy, [groupId]: (state.occupancy[groupId] ?? []).filter((id) => id !== batchId) };
}

interface ExecResult {
  state: ReleaseState;
  status: CommandStatus;
  reason?: string;
}

/** 执行单条命令：版本对不上退回冲突；容量满排队；紧急回滚可优先并让出低风险批次 */
function executeCommand(state: ReleaseState, command: CommandEntry): ExecResult {
  const now = new Date().toISOString();
  const touched = (patch: Partial<ReleaseState>, message: string): ReleaseState => ({
    ...state,
    ...patch,
    audits: audit({ ...state, ...patch }, command.actor, message, command.id)
  });

  switch (command.type) {
    case 'create': {
      const batch = command.payload['batch'] as ReleaseBatch | undefined;
      if (!batch) return { state, status: 'conflict', reason: '创建命令缺少批次数据' };
      const created: ReleaseBatch = { ...batch, version: 1, status: 'draft', progress: 0, downloaded: 0, failed: 0, updatedAt: now };
      return {
        state: touched({ batches: [created, ...state.batches] }, `创建批次 ${created.name}（命令 ${command.id.slice(0, 8)}）`),
        status: 'applied'
      };
    }
    case 'approve': {
      const batch = state.batches.find((item) => item.id === command.batchId);
      if (!batch) return { state, status: 'conflict', reason: '批次不存在' };
      if (batch.version !== command.expectedVersion) return { state, status: 'conflict', reason: `版本冲突：操作时看到 v${command.expectedVersion ?? '?'}，实际 v${batch.version}` };
      if (batch.status !== 'draft') return { state, status: 'conflict', reason: `仅草稿批次可审批，当前为 ${batch.status}` };
      const batches = state.batches.map((item) => item.id === batch.id ? { ...item, status: 'approved' as const, version: item.version + 1, updatedAt: now } : item);
      return { state: touched({ batches }, `批次 ${batch.name} 审批通过（v${batch.version} → v${batch.version + 1}）`), status: 'applied' };
    }
    case 'pause': {
      const batch = state.batches.find((item) => item.id === command.batchId);
      if (!batch) return { state, status: 'conflict', reason: '批次不存在' };
      if (batch.version !== command.expectedVersion) return { state, status: 'conflict', reason: `版本冲突：操作时看到 v${command.expectedVersion ?? '?'}，实际 v${batch.version}` };
      if (batch.status !== 'running') return { state, status: 'conflict', reason: `仅发布中的批次可暂停，当前为 ${batch.status}` };
      const batches = state.batches.map((item) => item.id === batch.id ? { ...item, status: 'paused' as const, version: item.version + 1, updatedAt: now } : item);
      const occupancy = releaseOccupancy(state, batch.groupId, batch.id);
      return { state: touched({ batches, occupancy }, `批次 ${batch.name} 已暂停并释放分组容量（v${batch.version} → v${batch.version + 1}）`), status: 'applied' };
    }
    case 'resume': {
      const batch = state.batches.find((item) => item.id === command.batchId);
      if (!batch) return { state, status: 'conflict', reason: '批次不存在' };
      if (batch.version !== command.expectedVersion) return { state, status: 'conflict', reason: `版本冲突：操作时看到 v${command.expectedVersion ?? '?'}，实际 v${batch.version}` };
      if (batch.status !== 'approved' && batch.status !== 'paused') return { state, status: 'conflict', reason: `仅已审批/已暂停批次可发布，当前为 ${batch.status}` };
      if (isCapacityFull(state, batch.groupId)) return { state, status: 'queued', reason: '分组容量已满，命令排队等容量' };
      const batches = state.batches.map((item) => item.id === batch.id ? { ...item, status: 'running' as const, version: item.version + 1, updatedAt: now } : item);
      const occupancy = addOccupancy(state, batch.groupId, batch.id);
      return { state: touched({ batches, occupancy }, `批次 ${batch.name} 开始发布并占用分组容量（v${batch.version} → v${batch.version + 1}）`), status: 'applied' };
    }
    case 'rollback': {
      const batch = state.batches.find((item) => item.id === command.batchId);
      if (!batch) return { state, status: 'conflict', reason: '批次不存在' };
      if (batch.version !== command.expectedVersion) return { state, status: 'conflict', reason: `版本冲突：操作时看到 v${command.expectedVersion ?? '?'}，实际 v${batch.version}` };
      if (batch.status === 'completed' || batch.status === 'rolled_back') return { state, status: 'conflict', reason: `已终态批次不可回滚，当前为 ${batch.status}` };

      let batches = state.batches;
      let occupancy = state.occupancy;
      let audits = state.audits;

      // 紧急回滚优先：分组容量满且目标未占用时，让出低风险批次（进度最低、无失败）并释放其容量
      const occupying = occupancy[batch.groupId]?.includes(batch.id) ?? false;
      if (!occupying && isCapacityFull(state, batch.groupId)) {
        const victim = batches
          .filter((item) => item.groupId === batch.groupId && item.status === 'running' && item.id !== batch.id)
          .sort((a, b) => a.progress - b.progress || a.failed - b.failed)[0];
        if (victim) {
          const victimNow = new Date().toISOString();
          batches = batches.map((item) => item.id === victim.id ? { ...item, status: 'paused' as const, version: item.version + 1, updatedAt: victimNow } : item);
          occupancy = releaseOccupancy({ ...state, occupancy }, batch.groupId, victim.id);
          audits = audit({ ...state, batches, occupancy }, '系统', `紧急回滚优先：低风险批次 ${victim.name} 已让出容量并暂停`, command.id);
        }
      }

      occupancy = releaseOccupancy({ ...state, occupancy }, batch.groupId, batch.id);
      batches = batches.map((item) => item.id === batch.id ? { ...item, status: 'rolled_back' as const, version: item.version + 1, updatedAt: now } : item);
      const next: ReleaseState = { ...state, batches, occupancy, audits };
      return { state: touched({ batches, occupancy, audits: next.audits }, `批次 ${batch.name} 已紧急回滚并释放分组容量（v${batch.version} → v${batch.version + 1}）`), status: 'applied' };
    }
  }
}

/** 容量释放后，排队中的 resume 命令按入账顺序自动提升 */
function promoteQueued(state: ReleaseState): ReleaseState {
  let current = state;
  for (;;) {
    const nextCommand = [...current.ledger]
      .sort((a, b) => a.seq - b.seq)
      .find((item) => item.status === 'queued');
    if (!nextCommand) return current;
    const result = executeCommand(current, nextCommand);
    if (result.status !== 'applied') return current;
    current = {
      ...result.state,
      ledger: current.ledger.map((item) => item.id === nextCommand.id
        ? { ...item, status: 'applied', appliedAt: new Date().toISOString(), reason: undefined }
        : item)
    };
  }
}

export const releaseReducer = createReducer(
  loadState(),
  on(enqueueCommand, (state, { command }) => {
    if (state.ledger.some((item) => item.id === command.id)) return state; // 入账幂等
    const seq = state.nextSeq;
    return { ...state, ledger: [...state.ledger, { ...command, seq }], nextSeq: seq + 1 };
  }),
  on(applyCommand, (state, { id }) => {
    const command = state.ledger.find((item) => item.id === id);
    if (!command) return state;
    if (command.status === 'applied') return state; // 重放只执行一次
    if (command.status === 'conflict' || command.status === 'voided') return state; // 已退单/作废，终态
    const result = executeCommand(state, command);
    if (result.status === command.status) return state; // 排队中且无变化，不产生无效状态
    let next: ReleaseState = {
      ...result.state,
      ledger: state.ledger.map((item) => item.id === id
        ? { ...item, status: result.status, reason: result.reason, attempts: item.attempts + 1, appliedAt: result.status === 'applied' ? new Date().toISOString() : item.appliedAt }
        : item)
    };
    if (result.status === 'applied') next = promoteQueued(next);
    return next;
  }),
  on(telemetryTick, (state) => {
    const now = new Date().toISOString();
    let occupancy = state.occupancy;
    let autoPaused = false;
    const batches = state.batches.map((batch) => {
      if (batch.status !== 'running') return batch;
      const group = state.groups.find((item) => item.id === batch.groupId);
      const target = Math.round((group?.count ?? 0) * batch.rolloutPercent / 100);
      const increment = Math.max(4, Math.round(target * 0.055));
      const downloaded = Math.min(target, batch.downloaded + increment);
      const failed = batch.failed + (Math.random() < 0.08 ? 1 : 0);
      const failureRate = downloaded ? failed / downloaded * 100 : 0;
      const status: ReleaseBatch['status'] = failureRate > batch.failureThreshold ? 'paused' : downloaded >= target ? 'completed' : 'running';
      if (status === 'paused' || status === 'completed') {
        occupancy = releaseOccupancy({ ...state, occupancy }, batch.groupId, batch.id);
        if (status === 'paused') autoPaused = true;
      }
      return { ...batch, downloaded, failed, progress: target ? Math.round(downloaded / target * 100) : 0, status, updatedAt: now };
    });
    let next: ReleaseState = {
      ...state,
      batches,
      occupancy,
      audits: autoPaused ? audit(state, '系统', '失败率超过阈值，已自动暂停发布并释放分组容量') : state.audits
    };
    next = promoteQueued(next);
    return next;
  }),
  on(setGroupCompatibility, (state, { groupId, compatible }) => {
    const groups = state.groups.map((group) => group.id === groupId ? { ...group, compatible } : group);
    let ledger = state.ledger;
    let audits = state.audits;
    if (!compatible) {
      const batchIds = new Set(state.batches.filter((batch) => batch.groupId === groupId).map((batch) => batch.id));
      const affected = ledger.filter((item) => batchIds.has(item.batchId ?? '') && (item.status === 'pending' || item.status === 'queued'));
      if (affected.length) {
        ledger = ledger.map((item) => affected.some((target) => target.id === item.id)
          ? { ...item, status: 'voided', reason: '兼容条件变化，未执行命令作废重算' }
          : item);
        audits = audit(state, '系统', `分组兼容条件变化：${affected.length} 条未执行命令作废重算，已下发设备保留结果`);
      }
    }
    return { ...state, groups, ledger, audits };
  }),
  on(handover, (state, { from: fromShift, to: toShift, note }) => {
    const pendingCommands = state.ledger.filter((item) => item.status === 'pending' || item.status === 'queued').length;
    const entry: HandoverEntry = { id: crypto.randomUUID(), at: new Date().toISOString(), from: fromShift, to: toShift, note, pendingCommands };
    return {
      ...state,
      handovers: [entry, ...state.handovers],
      audits: audit(state, fromShift, `交接给 ${toShift}：${note}（${pendingCommands} 条未完成命令已接续）`)
    };
  })
);
