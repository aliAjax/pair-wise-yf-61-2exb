import { createReducer, on } from '@ngrx/store';
import type { AuditEntry, CommandType, DeviceGroup, ReleaseBatch, ReleaseCommand, ReleaseState } from './release.models';
import { groupOccupancy, isPendingCommand, OCCUPYING_STATUSES } from './release.models';
import {
  connectivityChanged,
  flushRequested,
  groupCompatibilityChanged,
  handoverLogged,
  persistenceFailed,
  persistenceSynced,
  stageCommand,
  telemetryTick
} from './release.actions';
import { loadReleaseState } from './release.persistence';

const COMMAND_TYPE_LABEL: Record<CommandType, string> = {
  create: '创建批次',
  approve: '审批',
  pause: '暂停',
  resume: '继续',
  rollback: '紧急回滚'
};

const MAX_COMMANDS = 300;
const MAX_AUDITS = 300;
const MAX_APPLIED_IDS = 500;

const initialState = loadReleaseState();

function audit(state: ReleaseState, actor: string, kind: AuditEntry['kind'], message: string, commandId?: string): AuditEntry[] {
  const entry: AuditEntry = { id: crypto.randomUUID(), at: new Date().toISOString(), actor, kind, message, ...(commandId ? { commandId } : {}) };
  return [entry, ...state.audits].slice(0, MAX_AUDITS);
}

function replaceCommand(commands: ReleaseCommand[], updated: ReleaseCommand): ReleaseCommand[] {
  return commands.map((command) => (command.id === updated.id ? updated : command));
}

/** 命令账只保留最近的终态命令，暂存/排队命令永不淘汰 */
function capCommands(commands: ReleaseCommand[]): ReleaseCommand[] {
  const pending = commands.filter(isPendingCommand);
  const terminal = commands.filter((command) => !isPendingCommand(command));
  return [...pending, ...terminal.slice(0, MAX_COMMANDS)].sort((a, b) => a.seq - b.seq);
}

function conflict(state: ReleaseState, command: ReleaseCommand, reason: string): ReleaseState {
  const commands = replaceCommand(state.commands, { ...command, status: 'conflicted', reason });
  const message = `#${command.seq} ${COMMAND_TYPE_LABEL[command.type]} 冲突退回：${reason}`;
  return { ...state, commands, audits: audit(state, command.actor, 'command', message, command.id) };
}

function queue(state: ReleaseState, command: ReleaseCommand, reason: string): ReleaseState {
  if (command.status === 'queued' && command.reason === reason) return state;
  const commands = replaceCommand(state.commands, { ...command, status: 'queued', reason });
  const message = `#${command.seq} ${COMMAND_TYPE_LABEL[command.type]} 排队等待：${reason}`;
  return { ...state, commands, audits: audit(state, command.actor, 'command', message, command.id) };
}

function commit(state: ReleaseState, command: ReleaseCommand, batches: ReleaseBatch[], message: string): ReleaseState {
  const applied: ReleaseCommand = { ...command, status: 'committed', appliedAt: new Date().toISOString(), reason: undefined };
  return {
    ...state,
    batches,
    commands: capCommands(replaceCommand(state.commands, applied)),
    appliedIds: [...state.appliedIds, command.id].slice(-MAX_APPLIED_IDS),
    audits: audit(state, command.actor, 'command', `#${command.seq} ${message}`, command.id)
  };
}

function findBatch(state: ReleaseState, id: string): ReleaseBatch | undefined {
  return state.batches.find((batch) => batch.id === id);
}

function bumpBatch(batch: ReleaseBatch, status: ReleaseBatch['status']): ReleaseBatch {
  return { ...batch, status, version: batch.version + 1, updatedAt: new Date().toISOString() };
}

function checkVersionAndStatus(state: ReleaseState, command: ReleaseCommand, batch: ReleaseBatch, allowed: ReleaseBatch['status'][]): ReleaseState | null {
  if (batch.version !== command.baseVersion) {
    return conflict(state, command, `版本对不上，命令基于 v${command.baseVersion}，当前 v${batch.version}`);
  }
  if (!allowed.includes(batch.status)) {
    return conflict(state, command, `状态已变化（当前 ${batch.status}），操作过期不可执行`);
  }
  return null;
}

function commitCreate(state: ReleaseState, command: ReleaseCommand): ReleaseState {
  const payload = command.payload;
  if (!payload) return conflict(state, command, '缺少批次参数');
  const group = state.groups.find((item) => item.id === payload.groupId);
  if (!group) return conflict(state, command, `分组 ${payload.groupId} 不存在`);
  if (!group.compatible) return conflict(state, command, `分组 ${group.name} 不满足兼容条件`);
  if (findBatch(state, command.batchId)) return conflict(state, command, '批次已存在');
  const batch: ReleaseBatch = {
    id: command.batchId,
    ...payload,
    status: 'draft',
    progress: 0,
    downloaded: 0,
    failed: 0,
    version: 1,
    updatedAt: new Date().toISOString()
  };
  return commit(state, command, [batch, ...state.batches], `创建批次 ${payload.name}（草稿，v1）`);
}

function commitApprove(state: ReleaseState, command: ReleaseCommand, batch: ReleaseBatch): ReleaseState {
  const rejected = checkVersionAndStatus(state, command, batch, ['draft']);
  if (rejected) return rejected;
  const group = state.groups.find((item) => item.id === batch.groupId);
  if (group && !group.compatible) return conflict(state, command, `分组 ${group.name} 不满足兼容条件`);
  if (group && groupOccupancy(state.batches, group.id) >= group.capacity) {
    return queue(state, command, `分组 ${group.name} 占用已满 ${groupOccupancy(state.batches, group.id)}/${group.capacity}`);
  }
  const batches = state.batches.map((item) => (item.id === batch.id ? bumpBatch(item, 'approved') : item));
  return commit(state, command, batches, `批次 ${batch.name} 审批通过（v${batch.version + 1}）`);
}

function commitPause(state: ReleaseState, command: ReleaseCommand, batch: ReleaseBatch): ReleaseState {
  const rejected = checkVersionAndStatus(state, command, batch, ['running']);
  if (rejected) return rejected;
  const batches = state.batches.map((item) => (item.id === batch.id ? bumpBatch(item, 'paused') : item));
  return commit(state, command, batches, `批次 ${batch.name} 已暂停（v${batch.version + 1}）`);
}

function commitResume(state: ReleaseState, command: ReleaseCommand, batch: ReleaseBatch): ReleaseState {
  const rejected = checkVersionAndStatus(state, command, batch, ['paused', 'approved']);
  if (rejected) return rejected;
  const batches = state.batches.map((item) => (item.id === batch.id ? bumpBatch(item, 'running') : item));
  return commit(state, command, batches, `批次 ${batch.name} 恢复发布（v${batch.version + 1}）`);
}

/** 让出风险最低的占用批次：未开始的优先，其次灰度比例低、已下发少的 */
function lowestRiskOccupant(batches: ReleaseBatch[], groupId: string, excludeId: string): ReleaseBatch | undefined {
  const statusWeight = (batch: ReleaseBatch) => (batch.status === 'approved' ? 0 : batch.status === 'paused' ? 1 : 2);
  return batches
    .filter((batch) => batch.groupId === groupId && batch.id !== excludeId && OCCUPYING_STATUSES.includes(batch.status))
    .sort((a, b) => statusWeight(a) - statusWeight(b) || a.rolloutPercent - b.rolloutPercent || a.downloaded - b.downloaded)[0];
}

function commitRollback(state: ReleaseState, command: ReleaseCommand, batch: ReleaseBatch): ReleaseState {
  const rejected = checkVersionAndStatus(state, command, batch, ['draft', 'approved', 'running', 'paused']);
  if (rejected) return rejected;
  const group = state.groups.find((item) => item.id === batch.groupId);
  let working = state;
  if (group) {
    // 回滚自身会释放目标批次的占用；剩余占用仍满时，让低风险批次退回草稿释放容量
    const targetHolds = OCCUPYING_STATUSES.includes(batch.status) ? 1 : 0;
    for (;;) {
      const occupied = groupOccupancy(working.batches, group.id) - targetHolds;
      if (occupied < group.capacity) break;
      const candidate = lowestRiskOccupant(working.batches, group.id, batch.id);
      if (!candidate) return queue(working, command, `分组 ${group.name} 占用已满，等待低风险批次让出`);
      const batches = working.batches.map((item) => (item.id === candidate.id ? bumpBatch(item, 'draft') : item));
      working = {
        ...working,
        batches,
        audits: audit(working, command.actor, 'command', `批次 ${candidate.name} 为 #${command.seq} 紧急回滚让出，退回草稿并释放分组占用（v${candidate.version + 1}）`, command.id)
      };
    }
  }
  const batches = working.batches.map((item) => (item.id === batch.id ? bumpBatch(item, 'rolled_back') : item));
  return commit(working, command, batches, `批次 ${batch.name} 紧急回滚到 ${batch.rollbackVersion}（v${batch.version + 1}），分组占用已释放`);
}

function tryCommit(state: ReleaseState, commandId: string): ReleaseState {
  const command = state.commands.find((item) => item.id === commandId);
  if (!command || !isPendingCommand(command)) return state;
  // 幂等：同一命令重放只执行一次
  if (state.appliedIds.includes(command.id)) {
    const commands = replaceCommand(state.commands, { ...command, status: 'committed', reason: '重放忽略：命令已入账' });
    return { ...state, commands, audits: audit(state, '系统', 'system', `#${command.seq} 重放被忽略，同一命令只执行一次`, command.id) };
  }
  if (command.type === 'create') return commitCreate(state, command);
  const batch = findBatch(state, command.batchId);
  if (!batch) return conflict(state, command, `批次 ${command.batchId} 不存在`);
  switch (command.type) {
    case 'approve': return commitApprove(state, command, batch);
    case 'pause': return commitPause(state, command, batch);
    case 'resume': return commitResume(state, command, batch);
    case 'rollback': return commitRollback(state, command, batch);
    default: return state;
  }
}

/** 按账本顺序合并补传：紧急回滚优先，其余按序号；一轮无进展即停，排队命令留待容量释放 */
function flush(state: ReleaseState): ReleaseState {
  if (!state.online) return state;
  let current = state;
  for (;;) {
    const pending = current.commands
      .filter(isPendingCommand)
      .sort((a, b) => (a.type === 'rollback' ? 0 : 1) - (b.type === 'rollback' ? 0 : 1) || a.seq - b.seq);
    if (!pending.length) return current;
    let progressed = false;
    for (const command of pending) {
      const next = tryCommit(current, command.id);
      if (next !== current) {
        current = next;
        progressed = true;
      }
    }
    if (!progressed) return current;
  }
}

export const releaseReducer = createReducer(
  initialState,
  on(stageCommand, (state, { command }) => {
    // 暂存命令按到达顺序追加，同 id 重放直接忽略，绝不覆盖
    if (state.commands.some((item) => item.id === command.id)) return state;
    const staged: ReleaseCommand = { ...command, seq: state.nextSeq, status: 'staged' };
    const next: ReleaseState = {
      ...state,
      nextSeq: state.nextSeq + 1,
      commands: [...state.commands, staged],
      audits: audit(state, command.actor, 'command', `#${staged.seq} ${COMMAND_TYPE_LABEL[command.type]} 已暂存（基于 v${command.baseVersion}）`, command.id)
    };
    return flush(next);
  }),
  on(flushRequested, (state) => flush(state)),
  on(connectivityChanged, (state, { online }) => {
    if (state.online === online) return state;
    const next: ReleaseState = {
      ...state,
      online,
      audits: audit(state, '系统', 'system', online ? '链路恢复，按账本顺序合并补传暂存命令' : '链路断开，后续命令仅暂存本机')
    };
    return online ? flush(next) : next;
  }),
  on(groupCompatibilityChanged, (state, { groupId, compatible, actor }) => {
    const group = state.groups.find((item) => item.id === groupId);
    if (!group || group.compatible === compatible) return state;
    const groups: DeviceGroup[] = state.groups.map((item) => (item.id === groupId ? { ...item, compatible } : item));
    const batchIds = new Set(state.batches.filter((batch) => batch.groupId === groupId).map((batch) => batch.id));
    let voided = 0;
    const commands = state.commands.map((command) => {
      const affected = batchIds.has(command.batchId) || command.payload?.groupId === groupId;
      if (!affected || !isPendingCommand(command)) return command;
      voided += 1;
      return { ...command, status: 'voided' as const, reason: '兼容条件变化，未执行命令作废，请按新条件重算后重发' };
    });
    // 已下发设备保留结果：运行中的批次自动暂停止损，进度与失败计数不清零
    let paused = 0;
    const batches = compatible
      ? state.batches
      : state.batches.map((batch) => {
          if (batch.groupId !== groupId || batch.status !== 'running') return batch;
          paused += 1;
          return bumpBatch(batch, 'paused');
        });
    const details = [`作废未执行命令 ${voided} 条`];
    if (paused) details.push(`自动暂停运行中批次 ${paused} 个，已下发设备结果保留`);
    const audits = audit(state, actor, 'system', `分组 ${group.name} 兼容条件变更为「${compatible ? '兼容' : '不兼容'}」：${details.join('；')}`);
    return { ...state, groups, commands, batches, audits };
  }),
  on(handoverLogged, (state, { from, to, summary }) => ({
    ...state,
    audits: audit(state, to, 'handover', `交接班 ${from} → ${to}：${summary}`)
  })),
  on(persistenceFailed, (state, { error }) =>
    state.persistence.ok ? { ...state, persistence: { ...state.persistence, ok: false, lastError: error } } : state
  ),
  on(persistenceSynced, (state, { cursor }) =>
    state.persistence.ok && state.persistence.persistedCursor === cursor
      ? state
      : { ...state, persistence: { ok: true, persistedCursor: cursor } }
  ),
  on(telemetryTick, (state) => {
    if (!state.batches.some((batch) => batch.status === 'running') && !state.commands.some(isPendingCommand)) return state;
    let autoPaused = 0;
    const batches = state.batches.map((batch) => {
      if (batch.status !== 'running') return batch;
      const group = state.groups.find((item) => item.id === batch.groupId);
      const target = Math.round((group?.count ?? 0) * batch.rolloutPercent / 100);
      const increment = Math.max(4, Math.round(target * 0.055));
      const downloaded = Math.min(target, batch.downloaded + increment);
      const failed = batch.failed + (Math.random() < 0.08 ? 1 : 0);
      const failureRate = downloaded ? failed / downloaded * 100 : 0;
      // 状态变更才递增版本；进度推进不影响命令版本
      if (failureRate > batch.failureThreshold) {
        autoPaused += 1;
        return { ...bumpBatch(batch, 'paused'), downloaded, failed, progress: target ? Math.round(downloaded / target * 100) : 0 };
      }
      if (downloaded >= target) {
        return { ...bumpBatch(batch, 'completed'), downloaded, failed, progress: 100 };
      }
      return { ...batch, downloaded, failed, progress: target ? Math.round(downloaded / target * 100) : 0, updatedAt: new Date().toISOString() };
    });
    const audits = autoPaused ? audit(state, '系统', 'system', '失败率超过阈值，已自动暂停发布') : state.audits;
    // 批次完成会释放分组占用，顺势唤醒排队命令
    return flush({ ...state, batches, audits });
  })
);
