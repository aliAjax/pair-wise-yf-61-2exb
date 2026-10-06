import { createAction, props } from '@ngrx/store';
import type { ReleaseCommand } from './release.models';

/** 值班人员提交操作：先记入本机命令账（暂存），在线时立即尝试入账 */
export const stageCommand = createAction('[Ledger] Stage command', props<{ command: ReleaseCommand }>());
/** 手动补传/重试：按账本顺序合并未入账命令 */
export const flushRequested = createAction('[Ledger] Flush requested');
export const connectivityChanged = createAction('[Ledger] Connectivity changed', props<{ online: boolean }>());
/** 运维变更兼容条件：未执行命令作废重算，已下发设备保留结果 */
export const groupCompatibilityChanged = createAction('[Release] Compatibility changed', props<{ groupId: string; compatible: boolean; actor: string }>());
export const handoverLogged = createAction('[Ledger] Handover', props<{ from: string; to: string; summary: string }>());
export const persistenceFailed = createAction('[Ledger] Persistence failed', props<{ error: string }>());
export const persistenceSynced = createAction('[Ledger] Persistence synced', props<{ cursor: number }>());
export const telemetryTick = createAction('[Release] Telemetry tick');
