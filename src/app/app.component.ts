import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngrx/store';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTableModule } from '@angular/material/table';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  connectivityChanged,
  flushRequested,
  groupCompatibilityChanged,
  handoverLogged,
  stageCommand,
  telemetryTick
} from './state/release.actions';
import {
  selectAudits,
  selectBatchRows,
  selectCommandsDesc,
  selectConflictedCount,
  selectGroups,
  selectOccupancy,
  selectOnline,
  selectPendingCommands,
  selectPendingCount,
  selectPersistence
} from './state/release.selectors';
import { ReleasePersistenceService } from './state/release.persistence.service';
import type { CommandStatus, CommandType, DeviceGroup, ReleaseCommand } from './state/release.models';

const COMMAND_TYPE_LABEL: Record<CommandType, string> = { create: '创建批次', approve: '审批', pause: '暂停', resume: '继续', rollback: '紧急回滚' };
const COMMAND_STATUS_LABEL: Record<CommandStatus, string> = { staged: '暂存', queued: '排队', committed: '已入账', conflicted: '冲突退回', voided: '已作废' };

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, MatButtonModule, MatCardModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, MatSelectModule, MatSlideToggleModule, MatTableModule, TranslocoPipe],
  template: `
    <header class="hero">
      <div><span class="eyebrow">OTA CONTROL</span><h1>{{ 'title' | transloco }}</h1><p>{{ 'subtitle' | transloco }}</p></div>
      <mat-chip-set>
        <mat-chip [color]="online() ? 'primary' : 'warn'" highlighted>{{ online() ? '在线' : '断网·仅本机暂存' }}</mat-chip>
        <mat-chip [color]="pendingCount() ? 'accent' : 'primary'" highlighted>待入账 {{ pendingCount() }}</mat-chip>
        <mat-chip [color]="conflictedCount() ? 'warn' : 'primary'" highlighted>冲突 {{ conflictedCount() }}</mat-chip>
        <mat-chip [color]="persistence().ok ? 'primary' : 'warn'" highlighted>{{ persistence().ok ? '写入正常' : '写入失败' }}</mat-chip>
      </mat-chip-set>
    </header>

    <main>
      <section class="stats">
        <mat-card appearance="outlined"><span>批次数</span><strong>{{ (batchRows$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>分组占用</span><strong>{{ occupiedTotal() }}/{{ capacityTotal() }}</strong></mat-card>
        <mat-card appearance="outlined"><span>待入账命令</span><strong>{{ pendingCount() }}</strong></mat-card>
        <mat-card appearance="outlined"><span>冲突待处理</span><strong>{{ conflictedCount() }}</strong></mat-card>
      </section>

      <section class="grid">
        <div class="side">
          <mat-card appearance="outlined">
            <mat-card-header><mat-card-title>{{ 'newBatch' | transloco }}</mat-card-title></mat-card-header>
            <mat-card-content class="form-grid">
              <mat-form-field><mat-label>批次名称</mat-label><input matInput [(ngModel)]="draft.name"></mat-form-field>
              <mat-form-field><mat-label>目标版本</mat-label><input matInput [(ngModel)]="draft.firmware"></mat-form-field>
              <mat-form-field><mat-label>回滚版本</mat-label><input matInput [(ngModel)]="draft.rollbackVersion"></mat-form-field>
              <mat-form-field><mat-label>设备分组</mat-label><mat-select [(ngModel)]="draft.groupId"><mat-option *ngFor="let group of groups$ | async" [value]="group.id" [disabled]="!group.compatible">{{ group.name }} · {{ group.region }}</mat-option></mat-select></mat-form-field>
              <mat-form-field><mat-label>灰度比例 %</mat-label><input matInput type="number" [(ngModel)]="draft.rolloutPercent"></mat-form-field>
              <mat-form-field><mat-label>失败阈值 %</mat-label><input matInput type="number" [(ngModel)]="draft.failureThreshold"></mat-form-field>
              <button mat-flat-button color="primary" (click)="create()">暂存创建命令</button>
            </mat-card-content>
          </mat-card>

          <mat-card appearance="outlined">
            <mat-card-header><mat-card-title>{{ 'sync' | transloco }}</mat-card-title></mat-card-header>
            <mat-card-content class="sync-panel">
              <mat-slide-toggle [checked]="online()" (change)="toggleOnline($event.checked)">链路{{ online() ? '在线' : '断开' }}</mat-slide-toggle>
              <mat-slide-toggle [checked]="failWrites" (change)="toggleWriteFailure($event.checked)">模拟写入失败</mat-slide-toggle>
              <div class="sync-actions">
                <button mat-stroked-button [disabled]="!online() || !pendingCount()" (click)="flush()">合并补传</button>
                <button mat-stroked-button color="warn" *ngIf="!persistence().ok" (click)="retryPersist()">从断点 #{{ persistence().persistedCursor }} 重试</button>
              </div>
              <small>账本头 #{{ headSeq() }} · 已持久化到 #{{ persistence().persistedCursor }}<span *ngIf="persistence().lastError"> · {{ persistence().lastError }}</span></small>
            </mat-card-content>
          </mat-card>

          <mat-card appearance="outlined">
            <mat-card-header><mat-card-title>{{ 'groups' | transloco }}</mat-card-title></mat-card-header>
            <mat-card-content class="group-list">
              <div class="group" *ngFor="let group of groups$ | async">
                <div class="row"><b>{{ group.name }}</b><mat-chip [color]="group.compatible ? 'primary' : 'warn'" highlighted>{{ group.compatible ? '兼容' : '不兼容' }}</mat-chip></div>
                <small>{{ group.region }} · {{ group.count }} 台 · 占用 {{ occupancy()[group.id] }}/{{ group.capacity }} · 离线网关 {{ group.offlineGateways }}</small>
                <mat-slide-toggle [checked]="group.compatible" (change)="toggleCompatible(group, $event.checked)">兼容条件</mat-slide-toggle>
              </div>
            </mat-card-content>
          </mat-card>
        </div>

        <mat-card appearance="outlined" class="batch-panel">
          <mat-card-header><mat-card-title>{{ 'batches' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content>
            <cdk-virtual-scroll-viewport itemSize="168" class="viewport">
              <article class="batch" *cdkVirtualFor="let batch of batchRows$ | async">
                <div class="row"><div><b>{{ batch.name }}</b><small>{{ batch.groupName }} · {{ batch.firmware }} → 回滚 {{ batch.rollbackVersion }} · 分组占用 {{ batch.occupied }}/{{ batch.capacity }}</small></div><mat-chip [color]="batch.status === 'paused' || batch.status === 'rolled_back' ? 'warn' : 'primary'" highlighted>{{ batch.status }} · v{{ batch.version }}</mat-chip></div>
                <mat-progress-bar mode="determinate" [value]="batch.progress"></mat-progress-bar>
                <div class="row"><span>{{ batch.downloaded }} 台已更新 · 失败 {{ batch.failed }} · 阈值 {{ batch.failureThreshold }}%</span><span>{{ batch.progress }}%</span></div>
                <div class="actions">
                  <button mat-stroked-button *ngIf="batch.status === 'draft'" (click)="submit('approve', batch.id, batch.version)">审批</button>
                  <button mat-stroked-button *ngIf="batch.status === 'approved'" (click)="submit('resume', batch.id, batch.version)">开始发布</button>
                  <button mat-stroked-button *ngIf="batch.status === 'running'" (click)="submit('pause', batch.id, batch.version)">暂停</button>
                  <button mat-stroked-button *ngIf="batch.status === 'paused'" (click)="submit('resume', batch.id, batch.version)">继续</button>
                  <button mat-flat-button color="warn" [disabled]="batch.status === 'completed' || batch.status === 'rolled_back'" (click)="submit('rollback', batch.id, batch.version)">紧急回滚</button>
                </div>
              </article>
            </cdk-virtual-scroll-viewport>
          </mat-card-content>
        </mat-card>
      </section>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>{{ 'ledger' | transloco }}</mat-card-title></mat-card-header>
        <mat-card-content class="ledger-list">
          <div class="ledger ledger-head"><span>序号</span><span>命令</span><span>批次</span><span>基线</span><span>状态</span><span>操作人</span><span>时间</span><span>说明 / 操作</span></div>
          <div class="ledger" *ngFor="let command of commands$ | async">
            <span>#{{ command.seq }}</span>
            <span>{{ typeLabel(command.type) }}</span>
            <span>{{ batchName(command) }}</span>
            <span>v{{ command.baseVersion }}</span>
            <span><mat-chip [color]="command.status === 'conflicted' || command.status === 'voided' ? 'warn' : command.status === 'committed' ? 'primary' : 'accent'" highlighted>{{ statusLabel(command.status) }}</mat-chip></span>
            <span>{{ command.actor }}</span>
            <span>{{ command.createdAt | date:'MM-dd HH:mm:ss' }}</span>
            <span class="reason">{{ command.reason }}<button mat-stroked-button *ngIf="command.status === 'conflicted' || command.status === 'voided'" (click)="reissue(command)">按当前版本重发</button></span>
          </div>
          <p class="empty" *ngIf="!(commands$ | async)?.length">暂无命令，操作会先暂存到本机命令账。</p>
        </mat-card-content>
      </mat-card>

      <mat-card appearance="outlined">
        <mat-card-header>
          <mat-card-title>{{ 'handoverLog' | transloco }}</mat-card-title>
        </mat-card-header>
        <mat-card-content>
          <div class="handover-bar">
            <span>当前值班：<b>{{ actor }}</b></span>
            <mat-form-field><mat-label>交接给</mat-label><mat-select [(ngModel)]="nextActor"><mat-option *ngFor="let name of actors" [value]="name">{{ name }}</mat-option></mat-select></mat-form-field>
            <button mat-flat-button color="primary" (click)="handover()">交接班</button>
          </div>
          <div class="audit-list"><div class="audit" *ngFor="let item of audits$ | async"><span>{{ item.at | date:'MM-dd HH:mm:ss' }}</span><b>{{ item.actor }}</b><mat-chip class="kind" [color]="item.kind === 'handover' ? 'accent' : item.kind === 'system' ? 'warn' : 'primary'" highlighted>{{ item.kind === 'handover' ? '交接' : item.kind === 'system' ? '系统' : '命令' }}</mat-chip><p>{{ item.message }}</p></div></div>
        </mat-card-content>
      </mat-card>
    </main>
  `,
  styles: [`
    :host { display:block; min-height:100vh; background:#edf4f5; }
    .hero { padding:36px max(24px,6vw) 28px; color:#fff; background:linear-gradient(125deg,#053b46,#0f6f6c 62%,#2a9d8f); display:flex; justify-content:space-between; gap:24px; align-items:end; flex-wrap:wrap; }
    .hero h1 { margin:8px 0; font-size:clamp(30px,4vw,52px); letter-spacing:-.04em; } .hero p { margin:0; opacity:.8 } .eyebrow { letter-spacing:.2em; font-size:12px; opacity:.7 }
    main { padding:22px max(18px,5vw) 60px; display:grid; gap:20px; } .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; } .stats span { display:block;color:#607d86 } .stats strong { font-size:30px }
    .grid { display:grid; grid-template-columns:minmax(300px,.8fr) minmax(420px,1.2fr); gap:20px; align-items:start; } .side { display:grid; gap:20px } .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding-top:16px }
    .sync-panel { display:grid; gap:10px; padding-top:12px } .sync-actions { display:flex; gap:10px; flex-wrap:wrap } .sync-panel small { color:#607d86 }
    .group-list { display:grid; gap:14px; padding-top:12px } .group { border-bottom:1px solid #e5ecee; padding-bottom:10px; display:grid; gap:4px } .group small { color:#71858c }
    .viewport { height:560px; } .batch { min-height:150px; border-bottom:1px solid #dde7e8; padding:12px 4px; display:grid; gap:10px } .row { display:flex;justify-content:space-between;gap:12px;align-items:center } small { display:block;color:#71858c } .actions { display:flex;gap:8px;flex-wrap:wrap }
    .ledger-list { max-height:360px; overflow:auto } .ledger { display:grid;grid-template-columns:56px 88px 1.4fr 52px 96px 96px 110px 1.6fr;gap:8px;align-items:center;border-bottom:1px solid #e5ecee;padding:8px 4px } .ledger-head { font-weight:600;color:#607d86;position:sticky;top:0;background:#fff } .reason { display:flex;gap:8px;align-items:center;flex-wrap:wrap;color:#8a5a5a } .empty { color:#71858c }
    .handover-bar { display:flex;gap:16px;align-items:center;margin-bottom:12px;flex-wrap:wrap } .handover-bar mat-form-field { width:180px }
    .audit-list { max-height:320px; overflow:auto } .audit { display:grid;grid-template-columns:120px 110px 64px 1fr;gap:8px;border-bottom:1px solid #e5ecee;padding:10px 4px;align-items:center } .audit p { margin:0 }
    @media(max-width:1100px){ .ledger{grid-template-columns:48px 80px 1fr 48px 88px 1fr} } @media(max-width:900px){ .hero{align-items:flex-start;flex-direction:column}.stats{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.audit{grid-template-columns:1fr}.viewport{height:400px}.ledger{grid-template-columns:1fr 1fr} }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly store = inject(Store);
  private readonly persistenceService = inject(ReleasePersistenceService);

  readonly groups$ = this.store.select(selectGroups);
  readonly batchRows$ = this.store.select(selectBatchRows);
  readonly audits$ = this.store.select(selectAudits);
  readonly commands$ = this.store.select(selectCommandsDesc);
  readonly occupancy = this.store.selectSignal(selectOccupancy);
  readonly online = this.store.selectSignal(selectOnline);
  readonly persistence = this.store.selectSignal(selectPersistence);
  readonly pendingCount = this.store.selectSignal(selectPendingCount);
  readonly conflictedCount = this.store.selectSignal(selectConflictedCount);
  private readonly groups = this.store.selectSignal(selectGroups);
  private readonly pending = this.store.selectSignal(selectPendingCommands);
  private readonly batchRows = this.store.selectSignal(selectBatchRows);
  private readonly commands = this.store.selectSignal(selectCommandsDesc);

  readonly actors = ['夜班·赵', '夜班·钱', '白班·孙', '白班·李'];
  actor = this.actors[0];
  nextActor = this.actors[1];
  failWrites = false;
  private timer?: number;
  draft = { name: '', firmware: '3.0.0', rollbackVersion: '2.9.2', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 3 };

  ngOnInit() {
    this.persistenceService.init();
    this.timer = window.setInterval(() => this.store.dispatch(telemetryTick()), 1400);
  }
  ngOnDestroy() { if (this.timer) window.clearInterval(this.timer); }

  occupiedTotal() { return Object.values(this.occupancy()).reduce((sum, value) => sum + value, 0); }
  capacityTotal() { return this.groups().reduce((sum, group) => sum + group.capacity, 0); }
  headSeq() { return this.commands()[0]?.seq ?? 0; }

  create() {
    if (!this.draft.name || !this.draft.firmware || !this.draft.groupId) return;
    this.dispatchCommand('create', crypto.randomUUID(), 0, { ...this.draft });
    this.draft = { ...this.draft, name: '' };
  }

  submit(type: CommandType, batchId: string, baseVersion: number) {
    this.dispatchCommand(type, batchId, baseVersion);
  }

  /** 冲突/作废命令按当前批次版本重新暂存（新命令、新序号，旧记录保留在账上） */
  reissue(command: ReleaseCommand) {
    const batch = this.batchRows().find((row) => row.id === command.batchId);
    this.dispatchCommand(command.type, command.batchId, batch?.version ?? 0, command.payload);
  }

  toggleOnline(online: boolean) { this.store.dispatch(connectivityChanged({ online })); }
  toggleWriteFailure(fail: boolean) { this.failWrites = fail; this.persistenceService.setWriteFailure(fail); }
  flush() { this.store.dispatch(flushRequested()); }
  retryPersist() { this.persistenceService.retry(); }
  toggleCompatible(group: DeviceGroup, compatible: boolean) { this.store.dispatch(groupCompatibilityChanged({ groupId: group.id, compatible, actor: this.actor })); }

  handover() {
    if (this.nextActor === this.actor) return;
    const staged = this.pending().filter((command) => command.status === 'staged').length;
    const queued = this.pending().filter((command) => command.status === 'queued').length;
    const summary = `暂存 ${staged} 条、排队 ${queued} 条、冲突待处理 ${this.conflictedCount()} 条`;
    this.store.dispatch(handoverLogged({ from: this.actor, to: this.nextActor, summary }));
    this.actor = this.nextActor;
    this.nextActor = this.actors[(this.actors.indexOf(this.actor) + 1) % this.actors.length];
  }

  typeLabel(type: CommandType) { return COMMAND_TYPE_LABEL[type]; }
  statusLabel(status: CommandStatus) { return COMMAND_STATUS_LABEL[status]; }
  batchName(command: ReleaseCommand) {
    if (command.type === 'create') return command.payload?.name ?? command.batchId;
    return this.batchRows().find((row) => row.id === command.batchId)?.name ?? command.batchId;
  }

  private dispatchCommand(type: CommandType, batchId: string, baseVersion: number, payload?: ReleaseCommand['payload']) {
    const command: ReleaseCommand = {
      id: crypto.randomUUID(),
      seq: 0,
      type,
      batchId,
      baseVersion,
      actor: this.actor,
      status: 'staged',
      createdAt: new Date().toISOString(),
      ...(payload ? { payload } : {})
    };
    this.store.dispatch(stageCommand({ command }));
  }
}
