/**
 * 命令账逻辑验证：在 node 中用纯 reducer 跑交接班并发场景。
 * 运行：node_modules/esbuild/bin/esbuild scripts/ledger-check.ts --bundle --format=esm --platform=node --outfile=/tmp/ledger-check.mjs && node /tmp/ledger-check.mjs
 */
import '@angular/compiler';
import { releaseReducer } from '../src/app/state/release.reducer';
import {
  connectivityChanged,
  flushRequested,
  groupCompatibilityChanged,
  stageCommand,
  telemetryTick
} from '../src/app/state/release.actions';
import { groupOccupancy, isPendingCommand } from '../src/app/state/release.models';
import type { CommandType, ReleaseCommand, ReleaseState } from '../src/app/state/release.models';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`, detail ?? '');
  }
}

let seq = 0;
function cmd(type: CommandType, batchId: string, baseVersion: number, actor = '夜班·赵', payload?: ReleaseCommand['payload']): ReleaseCommand {
  return { id: `cmd-${++seq}`, seq: 0, type, batchId, baseVersion, actor, status: 'staged', createdAt: new Date().toISOString(), ...(payload ? { payload } : {}) };
}

function reduce(state: ReleaseState | undefined, action: { type: string } & Record<string, unknown>): ReleaseState {
  return releaseReducer(state as never, action as never) as ReleaseState;
}

// 初始状态：batch-demo 已审批 v1，占用 g-edge 1/1
let state = reduce(undefined, { type: '@ngrx/store/init' });
check('初始：demo 批次 v1 已审批', state.batches[0]?.version === 1 && state.batches[0]?.status === 'approved');
check('初始：g-edge 占用 1/1', groupOccupancy(state.batches, 'g-edge') === 1);

// 1) 交接班并发：两人同时基于 v1 提交操作
const createPayload = { name: '夜班补丁 3.0.0', firmware: '3.0.0', rollbackVersion: '2.9.2', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 3 };
state = reduce(state, stageCommand({ command: cmd('create', 'batch-night', 0, '夜班·钱', createPayload) }));
check('创建命令入账，新批次 v1 草稿', state.batches.find((b) => b.id === 'batch-night')?.version === 1);

// 容量满：g-edge 1/1 被 demo 占用，审批新批次应排队
state = reduce(state, stageCommand({ command: cmd('approve', 'batch-night', 1, '夜班·钱') }));
const queuedApprove = state.commands.find((c) => c.type === 'approve' && c.batchId === 'batch-night');
check('容量满时审批命令排队', queuedApprove?.status === 'queued', queuedApprove?.status);
check('排队不改动批次状态', state.batches.find((b) => b.id === 'batch-night')?.status === 'draft');

// 紧急回滚优先：回滚 demo（自身占用随回滚释放），随后排队的审批被唤醒
state = reduce(state, stageCommand({ command: cmd('rollback', 'batch-demo', 1, '白班·孙') }));
check('紧急回滚入账', state.batches.find((b) => b.id === 'batch-demo')?.status === 'rolled_back');
check('回滚释放占用后排队审批自动入账', state.commands.find((c) => c.type === 'approve')?.status === 'committed');
check('审批后批次 v2 已批准', state.batches.find((b) => b.id === 'batch-night')?.status === 'approved');

// 2) 版本冲突：两人同看 v2，一个先入账，另一个应冲突退回
state = reduce(state, stageCommand({ command: cmd('resume', 'batch-night', 2, '夜班·赵') })); // v2 -> v3 running
const stalePause = cmd('pause', 'batch-night', 2, '夜班·钱'); // 仍基于 v2
state = reduce(state, stageCommand({ command: stalePause }));
const conflicted = state.commands.find((c) => c.id === stalePause.id);
check('版本对不上退回冲突', conflicted?.status === 'conflicted' && (conflicted.reason ?? '').includes('v2'), conflicted?.reason);
check('冲突不改动批次', state.batches.find((b) => b.id === 'batch-night')?.status === 'running');

// 3) 断网暂存 → 重连按序补传
state = reduce(state, connectivityChanged({ online: false }));
const offlinePause = cmd('pause', 'batch-night', 3, '夜班·赵');
state = reduce(state, stageCommand({ command: offlinePause }));
check('断网时命令仅暂存', state.commands.find((c) => c.id === offlinePause.id)?.status === 'staged');
check('断网时批次不变', state.batches.find((b) => b.id === 'batch-night')?.status === 'running');
const offlineResume = cmd('resume', 'batch-night', 3, '夜班·钱'); // 基于旧版本 v3
state = reduce(state, stageCommand({ command: offlineResume }));
state = reduce(state, connectivityChanged({ online: true }));
check('重连后第一条按序入账', state.commands.find((c) => c.id === offlinePause.id)?.status === 'committed');
check('后续命令版本过期被退回', state.commands.find((c) => c.id === offlineResume.id)?.status === 'conflicted');

// 4) 同一命令重放只执行一次
const before = state.commands.filter((c) => c.status === 'committed').length;
state = reduce(state, stageCommand({ command: offlinePause }));
check('重复暂存同 id 命令被忽略', state.commands.filter((c) => c.id === offlinePause.id).length === 1);
state = reduce(state, flushRequested());
check('重放不产生重复入账', state.commands.filter((c) => c.status === 'committed').length === before);

// 5) 兼容条件变化：未执行命令作废，已下发设备保留结果
// 先让批次进入 running 并产生下发数据
state = reduce(state, stageCommand({ command: cmd('resume', 'batch-night', 4, '夜班·赵') }));
for (let i = 0; i < 3; i += 1) state = reduce(state, telemetryTick());
const dispatched = state.batches.find((b) => b.id === 'batch-night');
check('遥测已下发设备', (dispatched?.downloaded ?? 0) > 0, dispatched?.downloaded);
// 断网暂存一条命令，随后在断网状态下变更兼容条件
state = reduce(state, connectivityChanged({ online: false }));
const voidable = cmd('pause', 'batch-night', dispatched?.version ?? 0, '夜班·赵');
state = reduce(state, stageCommand({ command: voidable }));
check('待作废命令处于暂存', state.commands.find((c) => c.id === voidable.id)?.status === 'staged');
state = reduce(state, groupCompatibilityChanged({ groupId: 'g-edge', compatible: false, actor: '运维' }));
check('未执行命令作废', state.commands.find((c) => c.id === voidable.id)?.status === 'voided');
const afterVoid = state.batches.find((b) => b.id === 'batch-night');
check('已下发设备结果保留', afterVoid !== undefined && dispatched !== undefined && afterVoid.downloaded === dispatched.downloaded);
check('不兼容分组运行中批次自动暂停', afterVoid?.status === 'paused' || afterVoid?.status === 'completed');
state = reduce(state, connectivityChanged({ online: true }));

// 6) 占用派生不泄漏：完成/回滚后占用归零
const occupancyAfter = groupOccupancy(state.batches, 'g-edge');
check('占用由状态派生，暂停仍占用、回滚已释放', occupancyAfter === (afterVoid?.status === 'paused' ? 1 : 0), occupancyAfter);

// 7) 无待处理命令时 flush 是幂等空操作（防订阅回环）
const stable = reduce(state, flushRequested());
check('空 flush 返回原状态引用', stable === state);

// 8) 旧数据升级：v1 数据缺少版本，加载时补成初始版本 v1
const { loadReleaseState, STORAGE_KEY, LEGACY_STORAGE_KEY } = await import('../src/app/state/release.persistence');
const v1 = {
  groups: [{ id: 'g-edge', name: '华东边缘网关', region: '华东', count: 680, compatible: true, offlineGateways: 4 }],
  batches: [{ id: 'batch-old', name: '旧批次', firmware: '2.8.1', rollbackVersion: '2.7.9', groupId: 'g-edge', rolloutPercent: 20, failureThreshold: 5, status: 'approved', progress: 0, downloaded: 0, failed: 0, updatedAt: new Date().toISOString() }],
  audits: [{ id: 'a1', at: new Date().toISOString(), actor: '运维值班', message: '旧审计' }]
};
const store = new Map<string, string>([[LEGACY_STORAGE_KEY, JSON.stringify(v1)]]);
(globalThis as Record<string, unknown>)['localStorage'] = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key)
};
const migrated = loadReleaseState();
check('迁移：批次补成初始版本 v1', migrated.batches[0]?.version === 1, migrated.batches[0]);
check('迁移：分组补默认容量', migrated.groups[0]?.capacity === 1);
check('迁移：账本与幂等表初始化', migrated.commands.length === 0 && migrated.nextSeq === 1 && migrated.appliedIds.length === 0);
check('迁移：交接日志保留并追加升级记录', migrated.audits.some((a) => a.message.includes('补齐初始版本')) && migrated.audits.some((a) => a.message === '旧审计'));
// v2 键优先于 v1
store.set(STORAGE_KEY, JSON.stringify({ ...migrated, batches: [{ ...migrated.batches[0], id: 'batch-v2', version: 7 }] }));
check('迁移：v2 数据优先且保留版本', loadReleaseState().batches[0]?.version === 7);

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
