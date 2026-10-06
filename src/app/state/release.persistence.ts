import type { AuditEntry, DeviceGroup, ReleaseBatch, ReleaseState } from './release.models';

export const SCHEMA_VERSION = 2;
export const STORAGE_KEY = 'firmware-release-v2';
export const LEGACY_STORAGE_KEY = 'firmware-release-v1';

const seedGroups: DeviceGroup[] = [
  { id: 'g-edge', name: '华东边缘网关', region: '华东', count: 680, compatible: true, offlineGateways: 4, capacity: 1 },
  { id: 'g-plant', name: '工业采集终端', region: '华南', count: 1240, compatible: false, offlineGateways: 12, capacity: 2 },
  { id: 'g-clinic', name: '远程诊疗终端', region: '新加坡', count: 310, compatible: true, offlineGateways: 2, capacity: 1 }
];

function seedState(): ReleaseState {
  const now = new Date().toISOString();
  const batches: ReleaseBatch[] = [
    { id: 'batch-demo', name: '边缘网关安全补丁 2.8.1', firmware: '2.8.1', rollbackVersion: '2.7.9', groupId: 'g-edge', rolloutPercent: 20, failureThreshold: 5, status: 'approved', progress: 0, downloaded: 0, failed: 0, version: 1, updatedAt: now }
  ];
  const audits: AuditEntry[] = [{ id: crypto.randomUUID(), at: now, actor: '运维值班', kind: 'system', message: '批次 batch-demo 完成兼容性检查并进入已审批' }];
  return { schemaVersion: SCHEMA_VERSION, groups: seedGroups, batches, commands: [], audits, appliedIds: [], nextSeq: 1, online: true, persistence: { ok: true, persistedCursor: 0 } };
}

interface LegacyShape {
  schemaVersion?: number;
  groups?: Array<Partial<DeviceGroup> & { id: string }>;
  batches?: Array<Partial<ReleaseBatch> & { id: string }>;
  audits?: Array<Partial<AuditEntry> & { id: string }>;
}

/** 旧数据升级：缺少版本的批次补成初始版本 v1，分组补默认容量，账本从空开始 */
function migrateLegacy(raw: LegacyShape): ReleaseState {
  const base = seedState();
  const batches: ReleaseBatch[] = (raw.batches ?? []).map((batch) => ({ ...batch, version: typeof batch.version === 'number' ? batch.version : 1 }) as ReleaseBatch);
  const groups: DeviceGroup[] = (raw.groups ?? seedGroups).map((group) => ({ ...group, capacity: typeof group.capacity === 'number' ? group.capacity : 1 }) as DeviceGroup);
  const audits: AuditEntry[] = (raw.audits ?? []).map((entry) => ({ ...entry, kind: 'system' as const }) as AuditEntry);
  const upgraded = (raw.batches ?? []).filter((batch) => typeof batch.version !== 'number').length;
  const migrationEntry: AuditEntry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    actor: '系统',
    kind: 'system',
    message: `旧数据升级：为 ${upgraded} 个批次补齐初始版本 v1，分组容量缺省为 1，命令账从 #1 开始`
  };
  return { ...base, groups, batches, audits: [migrationEntry, ...audits] };
}

function normalize(raw: LegacyShape): ReleaseState {
  const needsMigration = raw.schemaVersion !== SCHEMA_VERSION || (raw.batches ?? []).some((batch) => typeof batch.version !== 'number');
  if (needsMigration) return migrateLegacy(raw);
  const state = raw as unknown as ReleaseState;
  return {
    ...state,
    commands: state.commands ?? [],
    appliedIds: state.appliedIds ?? [],
    nextSeq: state.nextSeq ?? 1,
    online: state.online ?? true,
    persistence: state.persistence ?? { ok: true, persistedCursor: 0 }
  };
}

export function loadReleaseState(): ReleaseState {
  if (typeof localStorage === 'undefined') return seedState();
  const parse = (key: string): LegacyShape | null => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null') as LegacyShape | null;
    } catch {
      return null;
    }
  };
  const current = parse(STORAGE_KEY);
  if (current) return normalize(current);
  const legacy = parse(LEGACY_STORAGE_KEY);
  if (legacy) return migrateLegacy(legacy);
  return seedState();
}

export function saveReleaseState(state: ReleaseState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/** 已入账命令的最大序号：持久化断点 */
export function committedCursor(state: ReleaseState): number {
  return state.commands.reduce((cursor, command) => (command.status === 'committed' && command.seq > cursor ? command.seq : cursor), 0);
}
