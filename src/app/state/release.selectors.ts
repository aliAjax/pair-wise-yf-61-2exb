import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { ReleaseState } from './release.models';

export const selectRelease = createFeatureSelector<ReleaseState>('release');
export const selectGroups = createSelector(selectRelease, (state) => state.groups);
export const selectBatches = createSelector(selectRelease, (state) => state.batches);
export const selectAudits = createSelector(selectRelease, (state) => state.audits);
export const selectLedger = createSelector(selectRelease, (state) => state.ledger);
export const selectOccupancy = createSelector(selectRelease, (state) => state.occupancy);
export const selectHandovers = createSelector(selectRelease, (state) => state.handovers);
