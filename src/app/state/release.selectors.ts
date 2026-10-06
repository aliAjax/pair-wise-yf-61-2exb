import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { ReleaseState } from './release.models';
import { groupOccupancy, isPendingCommand } from './release.models';

export const selectRelease = createFeatureSelector<ReleaseState>('release');
export const selectGroups = createSelector(selectRelease, (state) => state.groups);
export const selectBatches = createSelector(selectRelease, (state) => state.batches);
export const selectAudits = createSelector(selectRelease, (state) => state.audits);
export const selectCommands = createSelector(selectRelease, (state) => state.commands);
export const selectOnline = createSelector(selectRelease, (state) => state.online);
export const selectPersistence = createSelector(selectRelease, (state) => state.persistence);

export const selectPendingCommands = createSelector(selectCommands, (commands) => commands.filter(isPendingCommand));
export const selectPendingCount = createSelector(selectPendingCommands, (commands) => commands.length);
export const selectConflictedCount = createSelector(selectCommands, (commands) => commands.filter((command) => command.status === 'conflicted').length);
export const selectCommandsDesc = createSelector(selectCommands, (commands) => [...commands].sort((a, b) => b.seq - a.seq));

/** 分组占用表：占用数由批次状态派生，完成/回滚/退回草稿即自动释放 */
export const selectOccupancy = createSelector(selectBatches, selectGroups, (batches, groups) =>
  Object.fromEntries(groups.map((group) => [group.id, groupOccupancy(batches, group.id)]))
);

export interface BatchRow {
  id: string;
  name: string;
  firmware: string;
  rollbackVersion: string;
  status: ReleaseState['batches'][number]['status'];
  progress: number;
  downloaded: number;
  failed: number;
  failureThreshold: number;
  version: number;
  groupName: string;
  occupied: number;
  capacity: number;
}

export const selectBatchRows = createSelector(selectBatches, selectGroups, (batches, groups): BatchRow[] =>
  batches.map((batch) => {
    const group = groups.find((item) => item.id === batch.groupId);
    return {
      id: batch.id,
      name: batch.name,
      firmware: batch.firmware,
      rollbackVersion: batch.rollbackVersion,
      status: batch.status,
      progress: batch.progress,
      downloaded: batch.downloaded,
      failed: batch.failed,
      failureThreshold: batch.failureThreshold,
      version: batch.version,
      groupName: group?.name ?? batch.groupId,
      occupied: group ? groupOccupancy(batches, group.id) : 0,
      capacity: group?.capacity ?? 0
    };
  })
);
