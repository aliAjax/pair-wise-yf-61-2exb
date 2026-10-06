import { Injectable, inject, signal } from '@angular/core';
import { Store } from '@ngrx/store';
import { Subject, concatMap, debounceTime, filter, firstValueFrom, fromEvent, merge } from 'rxjs';
import { applyCommand, enqueueCommand } from './state/release.actions';
import { selectHandovers, selectLedger } from './state/release.selectors';
import type { CommandEntry, CommandType } from './state/release.models';

interface OutboxEntry {
  command: CommandEntry;
  /** 本机补传状态：applied 表示已对账完成，重放时跳过 */
  status: 'pending' | 'applied' | 'failed';
  attempts: number;
}

interface OutboxSnapshot {
  entries: OutboxEntry[];
  /** 断点位置：已连续处理到的顺序号，重连后从断点继续 */
  checkpoint: number;
}

const OUTBOX_KEY = 'firmware-outbox-v1';

/**
 * 命令账服务：所有操作先写本机 outbox（断网也不丢），
 * 联网后按顺序合并补传；同一条命令重放只执行一次，
 * 写入失败从断点重试，紧急回滚优先补传。
 */
@Injectable({ providedIn: 'root' })
export class CommandLedgerService {
  private readonly store = inject(Store);

  readonly online = signal(typeof navigator === 'undefined' ? true : navigator.onLine);
  /** 演示用：模拟写入失败，验证断点重试 */
  readonly simulateFail = signal(false);
  readonly checkpoint = signal(0);
  readonly pendingCount = signal(0);
  readonly outbox = signal<OutboxEntry[]>([]);

  private readonly flushTrigger$ = new Subject<void>();
  private seq = 1;
  private currentShift = '首班';
  private flushing = false;
  private flushRequested = false;

  constructor() {
    const snapshot = this.loadOutbox();
    this.outbox.set(snapshot.entries);
    this.checkpoint.set(snapshot.checkpoint);
    this.seq = snapshot.entries.reduce((max, entry) => Math.max(max, entry.command.seq), 0) + 1;
    this.recomputePending();

    // 实际联网/断网事件
    fromEvent(window, 'online').subscribe(() => { this.online.set(true); this.kick(); });
    fromEvent(window, 'offline').subscribe(() => this.online.set(false));

    // 交接后命令自动记到新班次
    this.store.select(selectHandovers).subscribe((handovers) => {
      this.currentShift = handovers[0]?.to ?? '首班';
    });

    // 联网时，或账本有变化（排队命令被自动提升）时，触发补传；
    // 同一时刻的重复触发（kick + 账本变更）合并成一次补传
    merge(this.flushTrigger$, this.store.select(selectLedger)).pipe(
      debounceTime(0),
      filter(() => this.online()),
      concatMap(() => this.runFlushLoop())
    ).subscribe({
      error: (err) => console.error('命令账补传失败', err)
    });

    this.kick();
  }

  /** 合并重叠的补传请求：一次失败/排队后不自动重试，等下一次明确触发 */
  private async runFlushLoop(): Promise<void> {
    if (this.flushing) {
      this.flushRequested = true;
      return;
    }
    this.flushing = true;
    try {
      do {
        this.flushRequested = false;
        const result = await this.flush();
        if (result === 'blocked') break; // 容量满，等容量释放后的账本变化再续传
      } while (this.flushRequested);
    } finally {
      this.flushing = false;
    }
  }

  /** 提交命令：先落本机 outbox，再入命令账，然后尝试补传 */
  submit(input: {
    type: CommandType;
    batchId?: string | null;
    expectedVersion?: number | null;
    payload?: Record<string, unknown>;
    actor: string;
  }): string {
    const command: CommandEntry = {
      id: crypto.randomUUID(),
      seq: this.seq++,
      type: input.type,
      batchId: input.batchId ?? null,
      expectedVersion: input.expectedVersion ?? null,
      payload: input.payload ?? {},
      actor: input.actor,
      shift: this.currentShift,
      status: 'pending',
      attempts: 0,
      createdAt: new Date().toISOString()
    };
    this.outbox.update((entries) => [...entries, { command, status: 'pending', attempts: 0 }]);
    this.persist();
    this.store.dispatch(enqueueCommand({ command }));
    this.recomputePending();
    this.kick();
    return command.id;
  }

  /** 演示用：手动切换联网状态 */
  setOnline(value: boolean): void {
    this.online.set(value);
    if (value) this.kick();
  }

  kick(): void {
    this.flushTrigger$.next();
  }

  /** 按顺序补传：紧急回滚优先，其余按入账顺序；失败/排队即停在断点 */
  private async flush(): Promise<'done' | 'blocked' | 'failed'> {
    const entries = [...this.outbox()].sort((a, b) => {
      const priority = (entry: OutboxEntry) => entry.command.type === 'rollback' ? 0 : 1;
      return priority(a) - priority(b) || a.command.seq - b.command.seq;
    });

    for (const entry of entries) {
      if (entry.status === 'applied') continue; // 已对账，重放跳过
      try {
        if (this.simulateFail() && entry.attempts === 0) {
          entry.attempts += 1;
          entry.status = 'failed';
          this.persist();
          throw new Error('模拟写入失败：断点未推进，稍后从断点重试');
        }
        this.store.dispatch(applyCommand({ id: entry.command.id }));
        const ledger = await firstValueFrom(this.store.select(selectLedger));
        const command = ledger.find((item) => item.id === entry.command.id);
        if (command?.status === 'queued') {
          this.persist();
          return 'blocked'; // 容量满，等释放后由账本变化触发续传
        }
        entry.status = 'applied';
        entry.command = { ...entry.command, status: command?.status ?? 'applied', appliedAt: command?.appliedAt };
        this.checkpoint.set(Math.max(this.checkpoint(), entry.command.seq));
        this.persist();
      } catch (err) {
        entry.status = 'failed';
        entry.attempts += 1;
        this.persist();
        this.recomputePending();
        console.warn('命令账写入失败，从断点重试：', err);
        return 'failed';
      }
    }
    this.recomputePending();
    return 'done';
  }

  private recomputePending(): void {
    this.pendingCount.set(this.outbox().filter((entry) => entry.status !== 'applied').length);
  }

  private persist(): void {
    const snapshot: OutboxSnapshot = { entries: this.outbox(), checkpoint: this.checkpoint() };
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(snapshot));
  }

  private loadOutbox(): OutboxSnapshot {
    try {
      const raw = localStorage.getItem(OUTBOX_KEY);
      if (!raw) return { entries: [], checkpoint: 0 };
      const parsed = JSON.parse(raw) as Partial<OutboxSnapshot>;
      return { entries: parsed.entries ?? [], checkpoint: parsed.checkpoint ?? 0 };
    } catch {
      return { entries: [], checkpoint: 0 };
    }
  }
}
