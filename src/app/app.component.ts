import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
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
import { TranslocoPipe } from '@jsverse/transloco';
import { handover, setGroupCompatibility, telemetryTick } from './state/release.actions';
import { selectAudits, selectBatches, selectGroups, selectHandovers, selectLedger, selectOccupancy, selectRelease } from './state/release.selectors';
import type { DeviceGroup, ReleaseBatch } from './state/release.models';
import { CommandLedgerService } from './command-ledger.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, MatButtonModule, MatCardModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, MatSelectModule, MatSlideToggleModule, TranslocoPipe],
  template: `
    <header class="hero">
      <div><span class="eyebrow">OTA CONTROL</span><h1>{{ 'title' | transloco }}</h1><p>{{ 'subtitle' | transloco }}</p></div>
      <mat-chip-set><mat-chip highlighted>命令账可接续</mat-chip><mat-chip>版本冲突退回</mat-chip><mat-chip>断网补传·断点续传</mat-chip></mat-chip-set>
    </header>

    <main>
      <section class="stats">
        <mat-card appearance="outlined"><span>批次数</span><strong>{{ (batches$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>兼容分组</span><strong>{{ (groups$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>发布中</span><strong>{{ runningCount() }}</strong></mat-card>
        <mat-card appearance="outlined"><span>待执行命令</span><strong>{{ ledger.pendingCount() }}</strong></mat-card>
        <mat-card appearance="outlined"><span>链路状态</span><strong [class.offline]="!ledger.online()">{{ ledger.online() ? '在线' : '断网' }}</strong></mat-card>
        <mat-card appearance="outlined"><span>审计记录</span><strong>{{ (audits$ | async)?.length ?? 0 }}</strong></mat-card>
      </section>

      <section class="grid">
        <div class="col">
          <mat-card appearance="outlined">
            <mat-card-header><mat-card-title>{{ 'newBatch' | transloco }}</mat-card-title></mat-card-header>
            <mat-card-content class="form-grid">
              <mat-form-field><mat-label>批次名称</mat-label><input matInput [(ngModel)]="draft.name"></mat-form-field>
              <mat-form-field><mat-label>目标版本</mat-label><input matInput [(ngModel)]="draft.firmware"></mat-form-field>
              <mat-form-field><mat-label>回滚版本</mat-label><input matInput [(ngModel)]="draft.rollbackVersion"></mat-form-field>
              <mat-form-field><mat-label>设备分组</mat-label><mat-select [(ngModel)]="draft.groupId"><mat-option *ngFor="let group of groups$ | async" [value]="group.id" [disabled]="!group.compatible">{{ group.name }} · {{ group.region }}</mat-option></mat-select></mat-form-field>
              <mat-form-field><mat-label>灰度比例 %</mat-label><input matInput type="number" [(ngModel)]="draft.rolloutPercent"></mat-form-field>
              <mat-form-field><mat-label>失败阈值 %</mat-label><input matInput type="number" [(ngModel)]="draft.failureThreshold"></mat-form-field>
              <button mat-flat-button color="primary" (click)="create()">创建兼容批次</button>
            </mat-card-content>
          </mat-card>

          <mat-card appearance="outlined">
            <mat-card-header><mat-card-title>设备分组 · 容量占用</mat-card-title></mat-card-header>
            <mat-card-content class="group-list">
              <div class="group" *ngFor="let group of groups$ | async">
                <div class="row">
                  <div><b>{{ group.name }}</b><small>{{ group.region }} · {{ group.count }} 台 · 离线网关 {{ group.offlineGateways }}</small></div>
                  <mat-chip [color]="group.compatible ? 'primary' : 'warn'" highlighted>{{ group.compatible ? '兼容' : '不兼容' }}</mat-chip>
                </div>
                <div class="row">
                  <span class="occ">占用 {{ occupancyCount(group.id) }} / {{ group.capacity }}</span>
                  <button mat-stroked-button (click)="toggleCompat(group)">{{ group.compatible ? '标记兼容变化' : '恢复兼容' }}</button>
                </div>
              </div>
            </mat-card-content>
          </mat-card>
        </div>

        <mat-card appearance="outlined" class="batch-panel">
          <mat-card-header><mat-card-title>{{ 'batches' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content>
            <cdk-virtual-scroll-viewport itemSize="158" class="viewport">
              <article class="batch" *cdkVirtualFor="let batch of batches$ | async">
                <div class="row">
                  <div><b>{{ batch.name }}</b><small>{{ batch.firmware }} → 回滚 {{ batch.rollbackVersion }}</small></div>
                  <div class="chips">
                    <mat-chip highlighted>v{{ batch.version }}</mat-chip>
                    <mat-chip [color]="batch.status === 'paused' || batch.status === 'rolled_back' ? 'warn' : 'primary'" highlighted>{{ batch.status }}</mat-chip>
                  </div>
                </div>
                <mat-progress-bar mode="determinate" [value]="batch.progress"></mat-progress-bar>
                <div class="row"><span>{{ batch.downloaded }} 台已更新 · 失败 {{ batch.failed }} · 阈值 {{ batch.failureThreshold }}%</span><span>{{ batch.progress }}%</span></div>
                <div class="actions">
                  <button mat-stroked-button *ngIf="batch.status === 'draft'" (click)="approve(batch)">审批</button>
                  <button mat-stroked-button *ngIf="batch.status === 'approved'" (click)="resume(batch)">开始发布</button>
                  <button mat-stroked-button *ngIf="batch.status === 'running'" (click)="pause(batch)">暂停</button>
                  <button mat-stroked-button *ngIf="batch.status === 'paused'" (click)="resume(batch)">继续</button>
                  <button mat-flat-button color="warn" [disabled]="batch.status === 'completed' || batch.status === 'rolled_back'" (click)="rollback(batch)">紧急回滚</button>
                </div>
              </article>
            </cdk-virtual-scroll-viewport>
          </mat-card-content>
        </mat-card>
      </section>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>命令账 · 每条命令记下操作时看到的批次版本</mat-card-title></mat-card-header>
        <mat-card-content>
          <table class="ledger">
            <thead><tr><th>序</th><th>命令</th><th>批次</th><th>所见版本</th><th>状态</th><th>班次</th><th>操作人</th><th>原因</th><th>时间</th></tr></thead>
            <tbody>
              <tr *ngFor="let item of ledger$ | async">
                <td>{{ item.seq }}</td>
                <td>{{ commandTypeLabel(item.type) }}</td>
                <td>{{ batchName(item.batchId) }}</td>
                <td>{{ item.expectedVersion === null ? '—' : 'v' + item.expectedVersion }}</td>
                <td><mat-chip [color]="commandStatusColor(item.status)" highlighted>{{ commandStatusLabel(item.status) }}</mat-chip></td>
                <td>{{ item.shift }}</td>
                <td>{{ item.actor }}</td>
                <td class="reason">{{ item.reason ?? '—' }}</td>
                <td>{{ item.createdAt | date:'MM-dd HH:mm:ss' }}</td>
              </tr>
            </tbody>
          </table>
        </mat-card-content>
      </mat-card>

      <section class="grid">
        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>断网补传 · 本机 outbox</mat-card-title></mat-card-header>
          <mat-card-content class="outbox">
            <div class="row"><span>链路</span><mat-chip [color]="ledger.online() ? 'primary' : 'warn'" highlighted>{{ ledger.online() ? '在线' : '断网' }}</mat-chip></div>
            <div class="row"><span>待补传命令</span><b>{{ ledger.pendingCount() }}</b></div>
            <div class="row"><span>断点位置（已处理顺序号）</span><b>{{ ledger.checkpoint() || '—' }}</b></div>
            <div class="row"><span>重放次数（写入失败重试）</span><b>{{ totalAttempts() }}</b></div>
            <mat-slide-toggle [ngModel]="ledger.simulateFail()" (ngModelChange)="ledger.simulateFail.set($event)">模拟写入失败（首次写入必失败，验证断点重试）</mat-slide-toggle>
            <div class="actions">
              <button mat-stroked-button (click)="ledger.setOnline(!ledger.online())">{{ ledger.online() ? '模拟断网' : '恢复联网' }}</button>
              <button mat-stroked-button (click)="ledger.kick()">手动补传</button>
            </div>
          </mat-card-content>
        </mat-card>

        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>交接日志 · 未完成命令接续到下一班</mat-card-title></mat-card-header>
          <mat-card-content>
            <div class="form-grid handover-form">
              <mat-form-field><mat-label>交班班次</mat-label><input matInput [(ngModel)]="handoverDraft.from"></mat-form-field>
              <mat-form-field><mat-label>接班班次</mat-label><input matInput [(ngModel)]="handoverDraft.to"></mat-form-field>
              <mat-form-field class="handover-note"><mat-label>交接备注</mat-label><input matInput [(ngModel)]="handoverDraft.note"></mat-form-field>
              <button mat-flat-button color="primary" (click)="submitHandover()">记录交接</button>
            </div>
            <div class="handover" *ngFor="let item of handovers$ | async">
              <div class="row"><b>{{ item.from }} → {{ item.to }}</b><span>{{ item.at | date:'MM-dd HH:mm:ss' }}</span></div>
              <p>{{ item.note }} · 接续未完成命令 {{ item.pendingCommands }} 条</p>
            </div>
          </mat-card-content>
        </mat-card>
      </section>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>{{ 'audit' | transloco }}</mat-card-title></mat-card-header>
        <mat-card-content class="audit-list"><div class="audit" *ngFor="let item of audits$ | async"><span>{{ item.at | date:'MM-dd HH:mm:ss' }}</span><b>{{ item.actor }}</b><p>{{ item.message }}</p></div></mat-card-content>
      </mat-card>
    </main>
  `,
  styles: [`
    :host { display:block; min-height:100vh; background:#edf4f5; }
    .hero { padding:36px max(24px,6vw) 28px; color:#fff; background:linear-gradient(125deg,#053b46,#0f6f6c 62%,#2a9d8f); display:flex; justify-content:space-between; gap:24px; align-items:end; flex-wrap:wrap; }
    .hero h1 { margin:8px 0; font-size:clamp(30px,4vw,52px); letter-spacing:-.04em; } .hero p { margin:0; opacity:.8 } .eyebrow { letter-spacing:.2em; font-size:12px; opacity:.7 }
    main { padding:22px max(18px,5vw) 60px; display:grid; gap:20px; } .stats { display:grid; grid-template-columns:repeat(6,1fr); gap:16px; } .stats span { display:block;color:#607d86 } .stats strong { font-size:28px } .stats strong.offline { color:#c62828 }
    .grid { display:grid; grid-template-columns:minmax(300px,.8fr) minmax(420px,1.2fr); gap:20px; align-items:start; } .col { display:grid; gap:20px; }
    .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding-top:16px }
    .viewport { height:560px; } .batch { min-height:140px; border-bottom:1px solid #dde7e8; padding:12px 4px; display:grid; gap:10px } .row { display:flex;justify-content:space-between;gap:12px;align-items:center } small { display:block;color:#71858c } .actions { display:flex;gap:8px;flex-wrap:wrap } .chips { display:flex;gap:6px }
    .group-list { display:grid; gap:14px; padding-top:8px } .group { border:1px solid #dde7e8; border-radius:8px; padding:10px 12px; display:grid; gap:8px } .occ { color:#607d86; font-variant-numeric:tabular-nums }
    .ledger { width:100%; border-collapse:collapse; font-size:13px } .ledger th { text-align:left; color:#607d86; font-weight:600; padding:6px 8px; border-bottom:1px solid #cfd8dc; white-space:nowrap } .ledger td { padding:6px 8px; border-bottom:1px solid #e5ecee; white-space:nowrap } .ledger .reason { white-space:normal; color:#c62828; max-width:260px }
    .outbox { display:grid; gap:12px; padding-top:12px } .outbox .row span { color:#607d86 } .outbox b { font-variant-numeric:tabular-nums }
    .handover-form { padding-top:0; margin-bottom:14px } .handover-note { grid-column:1 / -1 } .handover { border-top:1px solid #e5ecee; padding:10px 2px; display:grid; gap:4px } .handover p { margin:0; color:#455a64; font-size:13px }
    .audit-list { max-height:320px; overflow:auto } .audit { display:grid;grid-template-columns:120px 110px 1fr;border-bottom:1px solid #e5ecee;padding:10px 4px } .audit p { margin:0 }
    @media(max-width:900px){ .hero{align-items:flex-start;flex-direction:column}.stats{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.audit{grid-template-columns:1fr}.viewport{height:400px} }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly store = inject(Store);
  readonly ledger = inject(CommandLedgerService);
  readonly groups$ = this.store.select(selectGroups);
  readonly batches$ = this.store.select(selectBatches);
  readonly audits$ = this.store.select(selectAudits);
  readonly ledger$ = this.store.select(selectLedger);
  readonly handovers$ = this.store.select(selectHandovers);
  private readonly occupancy = signal<Record<string, string[]>>({});
  private readonly batchNames = signal<Record<string, string>>({});
  private timer?: number;
  draft = { name: '', firmware: '3.0.0', rollbackVersion: '2.9.2', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 3 };
  handoverDraft = { from: '首班', to: '二班', note: '' };

  constructor() {
    this.store.select(selectOccupancy).subscribe((value) => this.occupancy.set(value));
    this.store.select(selectBatches).subscribe((batches) => {
      const names: Record<string, string> = {};
      for (const batch of batches) names[batch.id] = batch.name;
      this.batchNames.set(names);
    });
  }

  ngOnInit() {
    this.timer = window.setInterval(() => this.store.dispatch(telemetryTick()), 1400);
    this.store.select(selectRelease).subscribe((state) => localStorage.setItem('firmware-release-v1', JSON.stringify(state)));
  }

  ngOnDestroy() { if (this.timer) window.clearInterval(this.timer); }

  runningCount(): number {
    let count = 0;
    this.batches$.subscribe((items) => { count = 0; for (const item of items) if (item.status === 'running') count += 1; });
    return count;
  }

  occupancyCount(groupId: string): number {
    return this.occupancy()[groupId]?.length ?? 0;
  }

  batchName(batchId: string | null): string {
    if (!batchId) return '—';
    return this.batchNames()[batchId] ?? batchId.slice(0, 8);
  }

  totalAttempts(): number {
    let total = 0;
    for (const entry of this.ledger.outbox()) total += entry.attempts;
    return total;
  }

  commandTypeLabel(type: string): string {
    return ({ create: '创建', approve: '审批', pause: '暂停', resume: '继续/发布', rollback: '紧急回滚' } as Record<string, string>)[type] ?? type;
  }

  commandStatusLabel(status: string): string {
    return ({ queued: '排队中', pending: '待执行', applied: '已执行', conflict: '冲突退回', voided: '作废' } as Record<string, string>)[status] ?? status;
  }

  commandStatusColor(status: string): string {
    if (status === 'applied') return 'primary';
    if (status === 'queued' || status === 'pending') return 'accent';
    return 'warn';
  }

  create() {
    if (!this.draft.name || !this.draft.firmware || !this.draft.groupId) return;
    const batch: ReleaseBatch = { ...this.draft, id: crypto.randomUUID(), status: 'draft', progress: 0, downloaded: 0, failed: 0, updatedAt: new Date().toISOString(), version: 1 };
    this.ledger.submit({ type: 'create', payload: { batch }, actor: '发布负责人' });
    this.draft = { ...this.draft, name: '' };
  }

  approve(batch: ReleaseBatch) { this.ledger.submit({ type: 'approve', batchId: batch.id, expectedVersion: batch.version, actor: '发布负责人' }); }
  pause(batch: ReleaseBatch) { this.ledger.submit({ type: 'pause', batchId: batch.id, expectedVersion: batch.version, actor: '值班人员' }); }
  resume(batch: ReleaseBatch) { this.ledger.submit({ type: 'resume', batchId: batch.id, expectedVersion: batch.version, actor: '运维人员' }); }
  rollback(batch: ReleaseBatch) { this.ledger.submit({ type: 'rollback', batchId: batch.id, expectedVersion: batch.version, actor: '发布负责人' }); }

  toggleCompat(group: DeviceGroup) {
    this.store.dispatch(setGroupCompatibility({ groupId: group.id, compatible: !group.compatible }));
  }

  submitHandover() {
    if (!this.handoverDraft.to) return;
    this.store.dispatch(handover({ from: this.handoverDraft.from, to: this.handoverDraft.to, note: this.handoverDraft.note || '继续处理未完成批次' }));
    this.handoverDraft = { from: this.handoverDraft.to, to: '', note: '' };
  }
}
