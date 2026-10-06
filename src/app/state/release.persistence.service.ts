import { Injectable, inject } from '@angular/core';
import { Store } from '@ngrx/store';
import { take } from 'rxjs';
import { persistenceFailed, persistenceSynced } from './release.actions';
import { committedCursor, saveReleaseState } from './release.persistence';
import { selectRelease } from './release.selectors';
import type { ReleaseState } from './release.models';

/**
 * 命令账持久化：每次状态变化整体落盘；写入失败时持久化游标停在断点，
 * 恢复后从断点重试直到游标追上账本头。
 */
@Injectable({ providedIn: 'root' })
export class ReleasePersistenceService {
  private readonly store = inject(Store);
  private failWrites = false;
  private started = false;

  init(): void {
    if (this.started) return;
    this.started = true;
    this.store.select(selectRelease).subscribe((state) => this.persist(state));
  }

  /** 故障注入：模拟写入失败，验证断点重试 */
  setWriteFailure(enabled: boolean): void {
    this.failWrites = enabled;
    if (!enabled) this.retry();
  }

  retry(): void {
    this.store.select(selectRelease).pipe(take(1)).subscribe((state) => this.persist(state));
  }

  private persist(state: ReleaseState): void {
    try {
      if (this.failWrites) throw new Error('模拟写入失败（故障注入已开启）');
      saveReleaseState(state);
      const cursor = committedCursor(state);
      if (!state.persistence.ok || state.persistence.persistedCursor !== cursor) {
        this.store.dispatch(persistenceSynced({ cursor }));
      }
    } catch (error) {
      if (state.persistence.ok) {
        this.store.dispatch(persistenceFailed({ error: error instanceof Error ? error.message : String(error) }));
      }
    }
  }
}
