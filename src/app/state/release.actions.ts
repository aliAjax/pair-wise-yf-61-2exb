import { createAction, props } from '@ngrx/store';
import type { CommandEntry } from './release.models';

/** 命令入账：追加到命令账（顺序号由 reducer 分配），不覆盖已有命令 */
export const enqueueCommand = createAction('[Release] Enqueue command', props<{ command: CommandEntry }>());

/**
 * 补传执行：断网重连后按顺序重放。
 * 幂等：已 applied 的命令不再执行；版本对不上退回 conflict。
 */
export const applyCommand = createAction('[Release] Apply command', props<{ id: string }>());

/** 遥测推进：内部状态变化，不产生命令版本 */
export const telemetryTick = createAction('[Release] Telemetry tick');

/** 兼容条件变化：分组变为不兼容时，未执行的命令作废重算 */
export const setGroupCompatibility = createAction('[Release] Set group compatibility', props<{ groupId: string; compatible: boolean }>());

/** 交接：把未完成命令接续给下一班，写入交接日志 */
export const handover = createAction('[Release] Handover', props<{ from: string; to: string; note: string }>());
