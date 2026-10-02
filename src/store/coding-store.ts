import { createEffect, createSignal } from 'solid-js';
import { createStore, reconcile, unwrap } from 'solid-js/store';
import {
  metaFromProject,
  migrateLegacyState,
  seedLibrary,
  seedProject,
  seedRegistry
} from '../data/seed';
import type {
  CoderId,
  Checkpoint,
  LibraryState,
  PersistedEnvelope,
  ProjectState,
  RegistryState,
  Scheme,
  Segment,
  StoreRecord,
  Theme
} from '../types';
import {
  LEGACY_STORAGE_KEY,
  LIBRARY_KEY,
  REGISTRY_KEY,
  clearCheckpoint,
  deleteLegacySnapshot,
  deleteRecord,
  projectKey,
  readCheckpoint,
  readEnvelope,
  readLegacySnapshot,
  readRecord,
  writeCheckpoint,
  writeEnvelope
} from '../utils/db';
import { diffThemes, mergeChangesIntoLibrary, snapshotThemes } from '../utils/scheme';
import type { ThemeChange } from '../utils/scheme';

const TAB_ID = crypto.randomUUID();
const CHANNEL_NAME = 'sologsb-1019-coding-v2';

/* ---- 本地 localStorage 双写（IndexedDB 之外的第二份副本） ---- */
const lsKeyFor = (key: string) => `sologsb-1019-v2:${key}`;
const CHECKPOINT_LS_KEY = 'sologsb-1019-v2:checkpoint';

const lsRead = <T extends StoreRecord>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(lsKeyFor(key));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

const lsWrite = (key: string, value: unknown) => {
  try {
    localStorage.setItem(lsKeyFor(key), JSON.stringify(value));
  } catch {
    /* 配额或隐私模式：以 IndexedDB 为准，不阻断主流程 */
  }
};

const lsRemove = (key: string) => {
  try { localStorage.removeItem(lsKeyFor(key)); } catch { /* ignore */ }
};

/* ---- 模块级单例状态 ---- */
const nowIso = () => new Date().toISOString();

const [state, setState] = createStore<ProjectState>(seedProject(nowIso()));
const [library, setLibrary] = createStore<LibraryState>(seedLibrary(nowIso()));
const [registry, setRegistry] = createStore<RegistryState>(seedRegistry(nowIso(), seedProject(nowIso())));

const [undoStack, setUndoStack] = createSignal<ProjectState[]>([]);
const [redoStack, setRedoStack] = createSignal<ProjectState[]>([]);
const [storageReady, setStorageReady] = createSignal(false);
const [lastSavedAt, setLastSavedAt] = createSignal<Date | null>(null);
const [saveError, setSaveError] = createSignal<string | null>(null);
const [pendingCheckpoint, setPendingCheckpoint] = createSignal<Checkpoint | null>(null);
const [remoteConflict, setRemoteConflict] = createSignal<PersistedEnvelope | null>(null);
const [migrationNotice, setMigrationNotice] = createSignal(false);
const [saveKey, setSaveKey] = createSignal(0);

let channel: BroadcastChannel | null = null;
let hydrating = false;
let saveTimer: number | undefined;
let writeChain: Promise<unknown> = Promise.resolve();

const keyOf = (record: StoreRecord) => record.kind === 'project' ? projectKey(record.id) : record.kind === 'library' ? LIBRARY_KEY : REGISTRY_KEY;

const envelopeFor = (record: StoreRecord): PersistedEnvelope => ({
  key: keyOf(record),
  revision: record.revision,
  updatedAt: record.updatedAt,
  writerId: TAB_ID,
  state: record
});

const clone = <T>(value: T): T => structuredClone(unwrap(value as never) as T) as T;
const cloneProject = () => clone(state) as ProjectState;

/** 串行化所有持久化写入，避免多记录写入相互竞态。 */
const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => undefined);
  return run;
};

const persistRecordNow = (record: StoreRecord): Promise<void> => enqueue(async () => {
  const envelope = envelopeFor(record);
  await writeEnvelope(envelope);
  lsWrite(envelope.key, record);
  channel?.postMessage(envelope);
});

/* ---- 项目编辑的防抖自动保存 ---- */
const persistProjectDebounced = (snapshot: ProjectState) => {
  const key = saveKey();
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    if (saveKey() !== key) return;
    void enqueue(async () => {
      const envelope: PersistedEnvelope = {
        key: projectKey(snapshot.id),
        revision: snapshot.revision,
        updatedAt: snapshot.updatedAt,
        writerId: TAB_ID,
        state: snapshot
      };
      try {
        await writeEnvelope(envelope);
        lsWrite(envelope.key, snapshot);
        setLastSavedAt(new Date());
        setSaveError(null);
        channel?.postMessage(envelope);
      } catch (error) {
        console.error('自动保存失败', error);
        setSaveError('自动保存失败，数据仍保留在本页，请点击“重试保存”。');
      }
    }).catch(() => undefined);
  }, 180);
};

createEffect(() => {
  const snapshot = cloneProject();
  saveKey();
  if (!storageReady() || hydrating) return;
  persistProjectDebounced(snapshot);
});

const syncRegistryMeta = (project: ProjectState, bumpRevision = false) => {
  const updatedMeta = metaFromProject(project, project.updatedAt);
  const current = registry.projects.find((item) => item.id === project.id);
  // 清单元数据未变（普通编码操作只改片段）时不重写登记簿，避免多余写入与广播。
  if (current
    && current.name === updatedMeta.name
    && current.updatedAt === updatedMeta.updatedAt
    && current.segmentCount === updatedMeta.segmentCount
    && current.snapshotSchemeRevision === updatedMeta.snapshotSchemeRevision
    && !bumpRevision) {
    return;
  }
  const list = registry.projects.map((item) => (item.id === project.id ? updatedMeta : item));
  const next: RegistryState = {
    ...clone(registry),
    projects: list,
    updatedAt: bumpRevision ? nowIso() : registry.updatedAt,
    revision: bumpRevision ? registry.revision + 1 : registry.revision
  };
  hydrating = true;
  setRegistry(reconcile(next, { merge: false }));
  hydrating = false;
  void persistRecordNow(next).catch(() => setSaveError('项目清单保存失败，可稍后重试保存。'));
};

/* ---- 项目内事务（保留原有撤销 / 审计行为） ---- */
const transaction = (action: string, detail: string, mutator: (draft: ProjectState) => void) => {
  setUndoStack((items) => [...items.slice(-49), cloneProject()]);
  setRedoStack([]);
  const next = cloneProject();
  mutator(next);
  next.revision = state.revision + 1;
  next.updatedAt = nowIso();
  next.audit.unshift({ id: crypto.randomUUID(), at: next.updatedAt, action, detail });
  next.audit = next.audit.slice(0, 250);
  setState(reconcile(next, { merge: false }));
  syncRegistryMeta(next, false);
  persistProjectDebounced(next);
};

/* ---- 检查点 ---- */
const persistCheckpoint = async (checkpoint: Checkpoint) => {
  try { localStorage.setItem(CHECKPOINT_LS_KEY, JSON.stringify(checkpoint)); } catch { /* 以 IndexedDB 兜底 */ }
  await writeCheckpoint(checkpoint);
};

const removeCheckpoint = async () => {
  await clearCheckpoint();
  try { localStorage.removeItem(CHECKPOINT_LS_KEY); } catch { /* ignore */ }
  setPendingCheckpoint(null);
};

const loadCheckpoint = async (): Promise<Checkpoint | null> => {
  const fromDb = await readCheckpoint();
  if (fromDb) return fromDb;
  try {
    const raw = localStorage.getItem(CHECKPOINT_LS_KEY);
    return raw ? (JSON.parse(raw) as Checkpoint) : null;
  } catch {
    return null;
  }
};

type CheckpointTarget = { key: string; record: StoreRecord }[];

const checkpointTargets = (checkpoint: Checkpoint): CheckpointTarget => {
  if (checkpoint.kind === 'create-project') {
    return [{ key: projectKey(checkpoint.project.id), record: checkpoint.project }, { key: REGISTRY_KEY, record: checkpoint.registry }];
  }
  if (checkpoint.kind === 'write-back-scheme') {
    return [{ key: projectKey(checkpoint.projectId), record: checkpoint.project }, { key: LIBRARY_KEY, record: checkpoint.library }];
  }
  return [{ key: LIBRARY_KEY, record: checkpoint.library }, { key: projectKey(checkpoint.project.id), record: checkpoint.project }, { key: REGISTRY_KEY, record: checkpoint.registry }];
};

const applyRecords = (targets: CheckpointTarget, options: { broadcast: boolean }) => {
  hydrating = true;
  targets.forEach(({ key, record }) => {
    if (record.kind === 'library') setLibrary(reconcile(record as LibraryState, { merge: false }));
    else if (record.kind === 'registry') {
      setRegistry(reconcile(record as RegistryState, { merge: false }));
    } else if (record.id === state.id) {
      setState(reconcile(record as ProjectState, { merge: false }));
      setUndoStack([]);
      setRedoStack([]);
    }
  });
  hydrating = false;
  if (options.broadcast) targets.forEach(({ record }) => channel?.postMessage(envelopeFor(record)));
};

const snapshotAll = () => ({
  library: clone(library) as LibraryState,
  registry: clone(registry) as RegistryState,
  activeProjectId: state.id,
  project: cloneProject()
});

const rollbackAll = (snapshot: { library: LibraryState; registry: RegistryState; activeProjectId: string; project: ProjectState }) => {
  hydrating = true;
  setLibrary(reconcile(snapshot.library, { merge: false }));
  setRegistry(reconcile(snapshot.registry, { merge: false }));
  if (state.id === snapshot.activeProjectId) setState(reconcile(snapshot.project, { merge: false }));
  hydrating = false;
};

/**
 * 从检查点恢复（幂等）。
 * - ok：检查点记录已确认落库（或与当前库完全一致，无需重复写入——绝不会多出一套主题）；
 * - stale：当前库修订更新，需要研究者明确是否覆盖；
 * - error：写入仍失败，可再次重试。
 */
const resumeCheckpoint = async (checkpoint: Checkpoint, force = false): Promise<'ok' | 'stale' | 'error'> => {
  try {
    const targets = checkpointTargets(checkpoint);
    const fresh = await Promise.all(targets.map(async ({ key, record }) => {
      const existing = await readEnvelope(key);
      return { key, record, existing };
    }));

    const sameAsCheckpoint = fresh.every(({ record, existing }) =>
      !!existing && existing.revision === record.revision && existing.updatedAt === record.updatedAt);
    if (sameAsCheckpoint) {
      applyRecords(targets, { broadcast: false });
      await activateCheckpointProject(checkpoint);
      await removeCheckpoint();
      return 'ok';
    }

    const isNewer = ({ record, existing }: { record: StoreRecord; existing: PersistedEnvelope | null }) =>
      !existing || force || existing.revision <= record.revision;

    if (!fresh.every(isNewer)) return 'stale';

    // 预分配 ID + 整记录覆盖：重试不会产生重复主题或重复项目。
    await enqueue(async () => {
      for (const { record } of targets) await writeEnvelope(envelopeFor(record));
    });
    targets.forEach(({ key, record }) => lsWrite(key, record));
    applyRecords(targets, { broadcast: true });
    await activateCheckpointProject(checkpoint);

    if (checkpoint.kind === 'migrate') {
      await deleteLegacySnapshot();
      try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* ignore */ }
    }
    await removeCheckpoint();
    return 'ok';
  } catch {
    // 写入失败属预期可恢复路径：检查点保留，调用方提示研究者重试。
    return 'error';
  }
};

/** 检查点涉及新项目 / 切换项目时，确保该项目记录已载入为当前工作区。 */
const activateCheckpointProject = async (checkpoint: Checkpoint) => {
  if (checkpoint.kind === 'write-back-scheme') {
    if (checkpoint.projectId !== state.id) return;
    return;
  }
  const targetId = checkpoint.registry.activeProjectId;
  if (targetId && targetId !== state.id) {
    const project = checkpoint.kind === 'create-project'
      ? checkpoint.project
      : checkpoint.kind === 'migrate'
        ? checkpoint.project
        : (await readRecord<ProjectState>(projectKey(targetId))) as ProjectState | null;
    if (project) {
      hydrating = true;
      setState(reconcile(project, { merge: false }));
      setUndoStack([]);
      setRedoStack([]);
      setSaveKey((value) => value + 1);
      hydrating = false;
    }
  }
};

const beginCheckpoint = async (checkpoint: Checkpoint): Promise<'ok' | 'stale' | 'error'> => {
  const before = snapshotAll();
  await persistCheckpoint(checkpoint);
  setPendingCheckpoint(checkpoint);
  // 先在界面上应用操作结果；落库失败则回滚到操作前，检查点仍可重试。
  applyRecords(checkpointTargets(checkpoint), { broadcast: false });
  await activateCheckpointProject(checkpoint);
  const result = await resumeCheckpoint(checkpoint);
  if (result === 'error') rollbackAll(before);
  return result;
};

const discardCheckpoint = async () => {
  const checkpoint = pendingCheckpoint();
  if (!checkpoint) return;
  // 放弃的是未落库的操作：只移除检查点，不写任何主题记录，因此不会多出方案。
  await removeCheckpoint();
  if (checkpoint.kind === 'create-project' && checkpoint.project.id === state.id && checkpoint.registry.projects.some((item) => item.id !== checkpoint.project.id)) {
    const fallback = checkpoint.registry.projects.find((item) => item.id !== checkpoint.project.id);
    if (fallback) await switchProject(fallback.id);
  }
};

/* ---- 主题树工具（沿用原逻辑） ---- */
const buildTreeOrder = (themes: Theme[]) => {
  const children = new Map<string | null, Theme[]>();
  themes.forEach((theme) => children.set(theme.parentId, [...(children.get(theme.parentId) ?? []), theme]));
  const result: Theme[] = [];
  const visit = (parentId: string | null, depth: number) => {
    [...(children.get(parentId) ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).forEach((theme) => {
      result.push({ ...theme, name: `${'　'.repeat(depth)}${theme.name}` });
      visit(theme.id, depth + 1);
    });
  };
  visit(null, 0);
  return result;
};

const parseTranscript = (raw: string, speakerFallback: string): Array<Pick<Segment, 'time' | 'speaker' | 'text'>> => {
  const rows = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return rows.map((line, index) => {
    const timed = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(?:[-—])?\s*([^:：]{1,24})[:：]\s*(.+)$/);
    if (timed) return { time: timed[1], speaker: timed[2].trim(), text: timed[3].trim() };
    return { time: `${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}`, speaker: index % 2 === 0 ? speakerFallback : '访谈者', text: line };
  });
};

/* ---- 启动：载入记录、迁移旧数据、恢复检查点 ---- */
const bootstrapRecords = async () => {
  const [idbRegistry, idbLibrary] = await Promise.all([
    readRecord<RegistryState>(REGISTRY_KEY),
    readRecord<LibraryState>(LIBRARY_KEY)
  ]);

  const localRegistry = lsRead<RegistryState>(REGISTRY_KEY);
  const localLibrary = lsRead<LibraryState>(LIBRARY_KEY);

  let registryState = idbRegistry ?? localRegistry;
  let libraryState = idbLibrary ?? localLibrary;

  if (!registryState || !libraryState) {
    const legacyIdb = await readLegacySnapshot();
    let legacyLocal: ReturnType<typeof JSON.parse> = null;
    try {
      const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      legacyLocal = raw ? JSON.parse(raw) : null;
    } catch { /* ignore */ }
    const legacy = legacyIdb
      ?? (legacyLocal && Array.isArray(legacyLocal.themes) ? legacyLocal as unknown as import('../types').LegacyCodingState : null);

    const ts = nowIso();
    if (legacy) {
      const migrated = migrateLegacyState(legacy, ts);
      const checkpoint: Checkpoint = {
        id: `cp-${crypto.randomUUID()}`,
        kind: 'migrate',
        createdAt: ts,
        label: '迁移旧版工作区到默认研究项目',
        ...migrated
      };
      hydrating = true;
      setLibrary(reconcile(migrated.library, { merge: false }));
      setRegistry(reconcile(migrated.registry, { merge: false }));
      setState(reconcile(migrated.project, { merge: false }));
      hydrating = false;
      setUndoStack([]); setRedoStack([]);
      setMigrationNotice(true);
      await persistCheckpoint(checkpoint);
      setPendingCheckpoint(checkpoint);
      const migrationResult = await resumeCheckpoint(checkpoint);
      if (migrationResult === 'error') setSaveError('旧数据迁移尚未完全写入，已保留检查点，可在顶部横幅重试；不会重复迁移。');
      return;
    }

    // 全新安装：演示方案 + 示例项目
    const freshProject = seedProject(ts);
    const freshRegistry = seedRegistry(ts, freshProject);
    const freshLibrary = seedLibrary(ts);
    try {
      await Promise.all([
        persistRecordNow(freshLibrary),
        persistRecordNow(freshProject),
        persistRecordNow(freshRegistry)
      ]);
    } catch (error) {
      console.error('初始数据写入失败', error);
      setSaveError('初始数据尚未写入本地库，请点击“重试保存”。');
    }
    registryState = freshRegistry;
    libraryState = freshLibrary;
    hydrating = true;
    setState(reconcile(freshProject, { merge: false }));
    hydrating = false;
    setUndoStack([]); setRedoStack([]);
  }

  hydrating = true;
  if (libraryState) setLibrary(reconcile(libraryState, { merge: false }));
  if (registryState) setRegistry(reconcile(registryState, { merge: false }));
  hydrating = false;

  const activeId = registryState?.activeProjectId ?? registryState?.projects[0]?.id ?? null;
  if (activeId) await loadProjectIntoState(activeId);
};

const loadProjectIntoState = async (id: string): Promise<ProjectState | null> => {
  const fromDb = await readRecord<ProjectState>(projectKey(id));
  const project = fromDb ?? lsRead<ProjectState>(projectKey(id));
  if (!project) return null;
  hydrating = true;
  setState(reconcile(project, { merge: false }));
  setUndoStack([]);
  setRedoStack([]);
  setSaveKey((value) => value + 1);
  hydrating = false;
  return project;
};

async function switchProject(id: string) {
  if (id === state.id && registry.activeProjectId === id) return;
  const project = await loadProjectIntoState(id);
  if (!project) {
    setSaveError(`无法载入项目 ${id}，本地数据库中缺少该项目记录。`);
    return;
  }
  const next: RegistryState = { ...clone(registry), activeProjectId: id, revision: registry.revision + 1, updatedAt: nowIso() };
  hydrating = true;
  setRegistry(reconcile(next, { merge: false }));
  hydrating = false;
  await persistRecordNow(next).catch(() => setSaveError('项目切换记录保存失败。'));
}

/* ---- 新项目：复制方案快照（预分配 ID，失败可从检查点重试） ---- */
const createProjectFromScheme = async (name: string, schemeId: string | null): Promise<'ok' | 'stale' | 'error'> => {
  const ts = nowIso();
  const id = `p-${crypto.randomUUID()}`;
  const scheme = schemeId ? library.schemes.find((item) => item.id === schemeId) ?? null : null;
  const themes = scheme ? snapshotThemes(scheme.themes) : [];
  const project: ProjectState = {
    kind: 'project',
    id,
    revision: 1,
    updatedAt: ts,
    name: name.trim() || '未命名研究项目',
    sourceSchemeId: scheme?.id ?? null,
    sourceSchemeName: scheme?.name ?? '空白方案',
    snapshotSchemeRevision: scheme?.revision ?? 0,
    snapshotAt: ts,
    activeTranscriptId: '',
    activeSegmentId: '',
    activeThemeId: themes[0]?.id ?? '',
    coderA: '编码者 A',
    coderB: '编码者 B',
    transcripts: [],
    segments: [],
    themes,
    baselineThemes: snapshotThemes(themes),
    audit: [{ id: `a-${crypto.randomUUID()}`, at: ts, action: '初始化', detail: scheme ? `从“${scheme.name}”（r${scheme.revision}）复制方案快照` : '以空白方案创建项目' }]
  };
  const meta = metaFromProject(project, ts);
  const nextRegistry: RegistryState = {
    ...clone(registry),
    projects: [...registry.projects, meta],
    activeProjectId: id,
    revision: registry.revision + 1,
    updatedAt: ts
  };
  const checkpoint: Checkpoint = {
    id: `cp-${crypto.randomUUID()}`,
    kind: 'create-project',
    createdAt: ts,
    label: `创建项目“${project.name}”`,
    project,
    registry: nextRegistry
  };
  return beginCheckpoint(checkpoint);
};

/* ---- 本地主题调整回写共享方案：先列差异，确认后再写 ---- */
const computeWriteBackDiff = (): ThemeChange[] => diffThemes(state.baselineThemes, state.themes);

const writeBackToScheme = async (selected: ThemeChange[]): Promise<'ok' | 'stale' | 'error'> => runWriteBack(selected);

const runWriteBack = async (selected: ThemeChange[]): Promise<'ok' | 'stale' | 'error'> => {
  if (!selected.length) return 'ok';
  const ts = nowIso();
  const schemeId = state.sourceSchemeId;
  const scheme = schemeId ? library.schemes.find((item) => item.id === schemeId) ?? null : null;
  let targetScheme: Scheme;
  let nextLibrary: LibraryState;

  if (scheme) {
    const mergedThemes = mergeChangesIntoLibrary(scheme.themes, state.themes, selected);
    targetScheme = { ...structuredClone(scheme), themes: mergedThemes, revision: scheme.revision + 1, updatedAt: ts };
    nextLibrary = {
      ...clone(library),
      schemes: library.schemes.map((item) => item.id === scheme.id ? targetScheme : item),
      revision: library.revision + 1,
      updatedAt: ts
    };
  } else {
    // 项目原本基于空白方案：把所选本地主题另存为新的共享方案。
    const newId = `scheme-${crypto.randomUUID()}`;
    const keptIds = new Set(selected.filter((change) => change.type !== 'removed').map((change) => change.themeId));
    const themes = state.themes.filter((theme) => keptIds.has(theme.id)).map((theme) => structuredClone(theme));
    targetScheme = { id: newId, name: `${state.name}方案`, createdAt: ts, updatedAt: ts, revision: 1, themes };
    nextLibrary = { ...clone(library), schemes: [...library.schemes, targetScheme], revision: library.revision + 1, updatedAt: ts };
  }

  const nextProject: ProjectState = {
    ...cloneProject(),
    themes: snapshotThemes(state.themes),
    baselineThemes: snapshotThemes(state.themes),
    sourceSchemeId: targetScheme.id,
    sourceSchemeName: targetScheme.name,
    snapshotSchemeRevision: targetScheme.revision,
    snapshotAt: ts,
    revision: state.revision + 1,
    updatedAt: ts,
    audit: [
      { id: `a-${crypto.randomUUID()}`, at: ts, action: '回写共享方案', detail: `${selected.length} 项本地主题调整写回“${targetScheme.name}”（新增 ${selected.filter((c) => c.type === 'added').length}、修改 ${selected.filter((c) => c.type === 'changed').length}、移除 ${selected.filter((c) => c.type === 'removed').length}）；项目快照不受方案库后续改版影响` },
      ...cloneProject().audit
    ].slice(0, 251)
  };

  const checkpoint: Checkpoint = {
    id: `cp-${crypto.randomUUID()}`,
    kind: 'write-back-scheme',
    createdAt: ts,
    label: `回写 ${selected.length} 项差异到“${targetScheme.name}”`,
    projectId: nextProject.id,
    project: nextProject,
    library: nextLibrary
  };
  return beginCheckpoint(checkpoint);
};

/* ---- 共享方案库的直接维护（只影响库，不动任何已开始的项目） ---- */
const bumpLibrary = (mutator: (draft: LibraryState) => void, scheme: Scheme, detail: string) => {
  const ts = nowIso();
  const next = clone(library);
  mutator(next);
  next.schemes = next.schemes.map((item) => item.id === scheme.id ? { ...item, updatedAt: ts } : item);
  const updatedScheme = next.schemes.find((item) => item.id === scheme.id);
  if (updatedScheme) updatedScheme.revision = scheme.revision + 1;
  next.revision = library.revision + 1;
  next.updatedAt = ts;
  setLibrary(reconcile(next, { merge: false }));
  void persistRecordNow(next).catch(() => setSaveError(`共享方案库保存失败：${detail}`));
};

const createScheme = (name: string) => {
  const trimmed = name.trim();
  if (!trimmed) return;
  const ts = nowIso();
  const scheme: Scheme = { id: `scheme-${crypto.randomUUID()}`, name: trimmed, createdAt: ts, updatedAt: ts, revision: 1, themes: [] };
  const next: LibraryState = { ...clone(library), schemes: [...library.schemes, scheme], revision: library.revision + 1, updatedAt: ts };
  setLibrary(reconcile(next, { merge: false }));
  void persistRecordNow(next).catch(() => setSaveError('新方案保存失败。'));
};

const renameScheme = (schemeId: string, name: string) => {
  const trimmed = name.trim();
  const scheme = library.schemes.find((item) => item.id === schemeId);
  if (!trimmed || !scheme || trimmed === scheme.name) return;
  bumpLibrary((draft) => {
    draft.schemes = draft.schemes.map((item) => item.id === schemeId ? { ...item, name: trimmed } : item);
  }, scheme, '重命名');
};

const updateSchemeTheme = (schemeId: string, themeId: string, patch: Partial<Theme>) => {
  const scheme = library.schemes.find((item) => item.id === schemeId);
  if (!scheme) return;
  bumpLibrary((draft) => {
    draft.schemes = draft.schemes.map((item) => item.id === schemeId ? {
      ...item,
      themes: item.themes.map((theme) => theme.id === themeId ? { ...theme, ...patch } : theme)
    } : item);
  }, scheme, '编辑主题定义');
};

const addSchemeTheme = (schemeId: string, name: string, parentId: string | null) => {
  const scheme = library.schemes.find((item) => item.id === schemeId);
  if (!scheme) return;
  const id = `t-${crypto.randomUUID()}`;
  bumpLibrary((draft) => {
    const target = draft.schemes.find((item) => item.id === schemeId);
    target?.themes.push({ id, name: name.trim(), parentId, color: parentId ? '#57978c' : '#267365', definition: '', memo: '', examples: [] });
  }, scheme, '新增主题');
};

const deleteSchemeTheme = (schemeId: string, themeId: string) => {
  const scheme = library.schemes.find((item) => item.id === schemeId);
  if (!scheme) return;
  bumpLibrary((draft) => {
    const target = draft.schemes.find((item) => item.id === schemeId);
    if (!target) return;
    target.themes = target.themes.filter((theme) => theme.id !== themeId);
    target.themes.forEach((theme) => { if (theme.parentId === themeId) theme.parentId = null; });
  }, scheme, '删除主题');
};

const deleteScheme = (schemeId: string) => {
  const ts = nowIso();
  const next: LibraryState = {
    ...clone(library),
    schemes: library.schemes.filter((item) => item.id !== schemeId),
    revision: library.revision + 1,
    updatedAt: ts
  };
  setLibrary(reconcile(next, { merge: false }));
  void persistRecordNow(next).catch(() => setSaveError('删除方案的保存失败。'));
};

/* ---- 删除项目 ---- */
const deleteProject = async (projectId: string) => {
  const remaining = registry.projects.filter((item) => item.id !== projectId);
  const ts = nowIso();
  const next: RegistryState = {
    ...clone(registry),
    projects: remaining,
    activeProjectId: registry.activeProjectId === projectId ? remaining[0]?.id ?? null : registry.activeProjectId,
    revision: registry.revision + 1,
    updatedAt: ts
  };
  try {
    await persistRecordNow(next);
    await enqueue(() => deleteRecord(projectKey(projectId)));
    lsRemove(projectKey(projectId));
  } catch {
    setSaveError('项目删除失败，记录仍保留，请重试。');
    return;
  }
  hydrating = true;
  setRegistry(reconcile(next, { merge: false }));
  hydrating = false;
  if (next.activeProjectId) await loadProjectIntoState(next.activeProjectId);
};

const renameProject = (name: string) => {
  const trimmed = name.trim();
  if (!trimmed || trimmed === state.name) return;
  const next = cloneProject();
  next.name = trimmed;
  next.revision = state.revision + 1;
  next.updatedAt = nowIso();
  next.audit.unshift({ id: crypto.randomUUID(), at: next.updatedAt, action: '重命名项目', detail: trimmed });
  setState(reconcile(next, { merge: false }));
  syncRegistryMeta(next, true);
  persistProjectDebounced(next);
};

export function useCodingStore() {
  const initialize = async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    try {
      await bootstrapRecords();
      const checkpoint = await loadCheckpoint();
      if (checkpoint) {
        setPendingCheckpoint(checkpoint);
        const result = await resumeCheckpoint(checkpoint);
        if (result === 'error') setSaveError(`操作“${checkpoint.label}”此前未能完成，可从检查点重试。`);
      }
    } catch (error) {
      console.error('初始化失败', error);
      setSaveError('本地数据库打开失败，请检查浏览器存储权限后刷新。');
    } finally {
      setStorageReady(true);
    }

    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = (event: MessageEvent<PersistedEnvelope>) => {
        const incoming = event.data;
        if (!incoming || incoming.writerId === TAB_ID) return;
        if (incoming.key.startsWith('project:') && incoming.key !== projectKey(state.id)) return;

        const currentRevision = incoming.key === LIBRARY_KEY ? library.revision
          : incoming.key === REGISTRY_KEY ? registry.revision
            : incoming.key === projectKey(state.id) ? state.revision
              : -1;
        if (incoming.revision === currentRevision && incoming.updatedAt === incoming.state.updatedAt) return;
        setRemoteConflict(incoming);
      };
    }
  };

  const retrySave = async () => {
    try {
      // 根记录（库 / 登记簿）也一并补写，覆盖首次启动写入失败的场景。
      const existingLibrary = await readEnvelope(LIBRARY_KEY);
      const existingRegistry = await readEnvelope(REGISTRY_KEY);
      if (!existingLibrary || existingLibrary.revision !== library.revision) await persistRecordNow(clone(library));
      if (!existingRegistry || existingRegistry.revision !== registry.revision) await persistRecordNow(clone(registry));
      await persistRecordNow(cloneProject());
      setSaveError(null);
      setLastSavedAt(new Date());
    } catch (error) {
      console.error(error);
      setSaveError('保存仍然失败，数据仍保留在本页。');
    }
  };

  const resumePendingCheckpoint = async (force = false) => {
    const checkpoint = pendingCheckpoint();
    if (!checkpoint) return;
    const before = snapshotAll();
    applyRecords(checkpointTargets(checkpoint), { broadcast: false });
    await activateCheckpointProject(checkpoint);
    const result = await resumeCheckpoint(checkpoint, force);
    if (result === 'ok') setSaveError(null);
    if (result === 'error') {
      rollbackAll(before);
      setSaveError(`操作“${checkpoint.label}”重试后仍失败，可再次重试。`);
    }
    return result;
  };

  /* ---- 撤销 / 重做（仅当前项目） ---- */
  const undo = () => {
    const items = undoStack();
    if (!items.length) return;
    const previous = items[items.length - 1];
    setUndoStack(items.slice(0, -1));
    setRedoStack((redo) => [...redo, cloneProject()]);
    setState(reconcile(previous, { merge: false }));
    syncRegistryMeta(previous, false);
    persistProjectDebounced(previous);
  };

  const redo = () => {
    const items = redoStack();
    if (!items.length) return;
    const next = items[items.length - 1];
    setRedoStack(items.slice(0, -1));
    setUndoStack((undoItems) => [...undoItems, cloneProject()]);
    setState(reconcile(next, { merge: false }));
    syncRegistryMeta(next, false);
    persistProjectDebounced(next);
  };

  const selectSegment = (id: string) => setState('activeSegmentId', id);
  const selectTranscript = (id: string) => setState('activeTranscriptId', id);
  const selectTheme = (id: string) => setState('activeThemeId', id);
  const setCoder = (coder: CoderId, name: string) => {
    if (coder === 'A') setState('coderA', name);
    else setState('coderB', name);
    persistProjectDebounced(cloneProject());
  };

  const toggleAssignment = (segmentId: string, coder: CoderId, themeId: string, enabled: boolean) => {
    transaction('调整编码', `${coder === 'A' ? state.coderA : state.coderB} ${enabled ? '添加' : '移除'}主题`, (draft) => {
      const segment = draft.segments.find((item) => item.id === segmentId);
      if (!segment) return;
      const codes = new Set(segment.assignments[coder]);
      if (enabled) codes.add(themeId);
      else codes.delete(themeId);
      segment.assignments[coder] = [...codes];
    });
  };

  const batchAssign = (segmentIds: string[], coder: CoderId, themeId: string) => {
    if (!segmentIds.length) return;
    transaction('批量重编码', `将 ${segmentIds.length} 个片段分配给主题`, (draft) => {
      draft.segments.forEach((segment) => {
        if (segmentIds.includes(segment.id) && !segment.assignments[coder].includes(themeId)) segment.assignments[coder].push(themeId);
      });
    });
  };

  const addTheme = (name: string, parentId: string | null) => {
    const id = `t-${crypto.randomUUID()}`;
    transaction('新建主题', name, (draft) => {
      draft.themes.push({ id, name, parentId, color: parentId ? '#57978c' : '#267365', definition: '', memo: '', examples: [] });
      draft.activeThemeId = id;
    });
    return id;
  };

  const updateTheme = (themeId: string, patch: Partial<Theme>, fieldLabel: string) => {
    transaction('编辑主题', fieldLabel, (draft) => {
      const theme = draft.themes.find((item) => item.id === themeId);
      if (theme) Object.assign(theme, patch);
    });
  };

  const deleteTheme = (themeId: string) => {
    const theme = state.themes.find((item) => item.id === themeId);
    if (!theme) return;
    transaction('删除项目主题', theme.name, (draft) => {
      draft.themes = draft.themes.filter((item) => item.id !== themeId);
      draft.themes.forEach((item) => { if (item.parentId === themeId) item.parentId = null; });
      draft.segments.forEach((segment) => {
        segment.assignments.A = segment.assignments.A.filter((id) => id !== themeId);
        segment.assignments.B = segment.assignments.B.filter((id) => id !== themeId);
      });
      if (draft.activeThemeId === themeId) draft.activeThemeId = draft.themes[0]?.id ?? '';
    });
  };

  const mergeThemes = (sourceId: string, targetId: string) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    transaction('合并主题', `${state.themes.find((item) => item.id === sourceId)?.name ?? sourceId} → ${state.themes.find((item) => item.id === targetId)?.name ?? targetId}`, (draft) => {
      draft.segments.forEach((segment) => {
        (['A', 'B'] as CoderId[]).forEach((coder) => {
          const codes = new Set(segment.assignments[coder].filter((id) => id !== sourceId));
          if (segment.assignments[coder].includes(sourceId)) codes.add(targetId);
          segment.assignments[coder] = [...codes];
        });
      });
      draft.themes.forEach((theme) => { if (theme.parentId === sourceId) theme.parentId = targetId; });
      draft.themes = draft.themes.filter((theme) => theme.id !== sourceId);
      draft.activeThemeId = targetId;
    });
  };

  const splitTheme = (sourceId: string, newName: string, segmentIds: string[]) => {
    const newId = `t-${crypto.randomUUID()}`;
    transaction('拆分主题', newName, (draft) => {
      const source = draft.themes.find((theme) => theme.id === sourceId);
      if (!source) return;
      draft.themes.push({ ...source, id: newId, name: newName, examples: [] });
      draft.segments.forEach((segment) => {
        if (!segmentIds.includes(segment.id)) return;
        (['A', 'B'] as CoderId[]).forEach((coder) => {
          if (segment.assignments[coder].includes(sourceId)) {
            segment.assignments[coder] = segment.assignments[coder].map((id) => id === sourceId ? newId : id);
          }
        });
      });
      draft.activeThemeId = newId;
    });
    return newId;
  };

  const updateSegment = (segmentId: string, patch: Pick<Segment, 'speaker' | 'time' | 'text' | 'note'>) => {
    transaction('编辑片段', `片段 ${segmentId}`, (draft) => {
      const segment = draft.segments.find((item) => item.id === segmentId);
      if (segment) Object.assign(segment, patch);
    });
  };

  const importTranscript = (raw: string, title: string, participant: string, sourceName: string) => {
    const transcriptId = `tr-${crypto.randomUUID()}`;
    const rows = parseTranscript(raw, participant);
    transaction('导入转写', `${title}（${rows.length} 个片段）`, (draft) => {
      draft.transcripts.push({ id: transcriptId, title, participant, importedAt: new Date().toISOString(), sourceName });
      const start = draft.segments.length;
      const segments: Segment[] = rows.map((row, index) => ({
        id: `s-${crypto.randomUUID()}`,
        transcriptId,
        order: start + index,
        speaker: row.speaker,
        time: row.time,
        text: row.text,
        assignments: { A: [], B: [] },
        note: ''
      }));
      draft.segments.push(...segments);
      draft.activeTranscriptId = transcriptId;
      draft.activeSegmentId = segments[0]?.id ?? draft.activeSegmentId;
    });
  };

  const addExample = (themeId: string, example: string) => {
    const trimmed = example.trim();
    if (!trimmed) return;
    transaction('添加主题示例', trimmed, (draft) => {
      const theme = draft.themes.find((item) => item.id === themeId);
      if (theme && !theme.examples.includes(trimmed)) theme.examples.push(trimmed);
    });
  };

  const exportCoding = (format: 'json' | 'csv') => {
    const snapshot = cloneProject();
    const themeMap = new Map(snapshot.themes.map((theme) => [theme.id, theme]));
    if (format === 'json') {
      return JSON.stringify({
        exportedAt: nowIso(),
        project: {
          id: snapshot.id,
          name: snapshot.name,
          sourceSchemeId: snapshot.sourceSchemeId,
          sourceSchemeName: snapshot.sourceSchemeName,
          snapshotSchemeRevision: snapshot.snapshotSchemeRevision,
          snapshotAt: snapshot.snapshotAt
        },
        ...snapshot
      }, null, 2);
    }
    const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const rows = [['项目', '片段编号', '时间', '发言人', '原文', '编码者', '主题路径', '备忘录'].map(escape).join(',')];
    snapshot.segments.forEach((segment) => {
      (['A', 'B'] as CoderId[]).forEach((coder) => {
        const name = coder === 'A' ? snapshot.coderA : snapshot.coderB;
        const themeIds = segment.assignments[coder];
        const paths = themeIds.length ? themeIds.map((id) => {
          const names: string[] = [];
          let current = themeMap.get(id);
          while (current) {
            names.unshift(current.name);
            current = current.parentId ? themeMap.get(current.parentId) : undefined;
          }
          return names.join(' / ');
        }) : ['未编码'];
        rows.push([snapshot.name, segment.id, segment.time, segment.speaker, segment.text, name, paths.join(' | '), segment.note].map(escape).join(','));
      });
    });
    return `﻿${rows.join('\n')}`;
  };

  const downloadExport = (format: 'json' | 'csv') => {
    const content = exportCoding(format);
    const blob = new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${state.name}-编码结果-${nowIso().slice(0, 10)}.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  /* ---- 多标签页冲突（沿用显式选择） ---- */
  const keepLocalVersion = () => {
    const incoming = remoteConflict();
    if (!incoming) return;
    setRemoteConflict(null);
    if (incoming.key === LIBRARY_KEY) {
      const next: LibraryState = { ...clone(library), revision: Math.max(library.revision, incoming.revision) + 1, updatedAt: nowIso() };
      setLibrary(reconcile(next, { merge: false }));
      void persistRecordNow(next);
    } else if (incoming.key === REGISTRY_KEY) {
      const next: RegistryState = { ...clone(registry), revision: Math.max(registry.revision, incoming.revision) + 1, updatedAt: nowIso() };
      setRegistry(reconcile(next, { merge: false }));
      void persistRecordNow(next);
    } else {
      const next = cloneProject();
      next.revision = Math.max(state.revision, incoming.revision) + 1;
      next.updatedAt = nowIso();
      next.audit.unshift({ id: crypto.randomUUID(), at: next.updatedAt, action: '处理多标签冲突', detail: '保留当前标签页版本并生成新修订' });
      setState(reconcile(next, { merge: false }));
      persistProjectDebounced(next);
    }
  };

  const applyRemoteVersion = () => {
    const incoming = remoteConflict();
    if (!incoming) return;
    hydrating = true;
    if (incoming.state.kind === 'library') setLibrary(reconcile(incoming.state as LibraryState, { merge: false }));
    else if (incoming.state.kind === 'registry') {
      const nextRegistry = incoming.state as RegistryState;
      setRegistry(reconcile(nextRegistry, { merge: false }));
      if (nextRegistry.activeProjectId && nextRegistry.activeProjectId !== state.id) {
        hydrating = false;
        void switchProject(nextRegistry.activeProjectId);
        setRemoteConflict(null);
        return;
      }
    } else if (incoming.key === projectKey(state.id)) {
      setState(reconcile(incoming.state as ProjectState, { merge: false }));
    }
    hydrating = false;
    lsWrite(incoming.key, incoming.state);
    setRemoteConflict(null);
  };

  const orderedThemes = () => buildTreeOrder(state.themes);
  const orderedSchemeThemes = (schemeId: string) => {
    const scheme = library.schemes.find((item) => item.id === schemeId);
    return scheme ? buildTreeOrder(scheme.themes) : [];
  };
  const sourceScheme = () => state.sourceSchemeId ? library.schemes.find((item) => item.id === state.sourceSchemeId) ?? null : null;

  return {
    // 状态
    state,
    library,
    registry,
    // 项目
    switchProject,
    createProjectFromScheme,
    deleteProject,
    renameProject,
    // 共享方案库
    createScheme,
    renameScheme,
    deleteScheme,
    updateSchemeTheme,
    addSchemeTheme,
    deleteSchemeTheme,
    orderedSchemeThemes,
    sourceScheme,
    // 回写
    computeWriteBackDiff,
    writeBackToScheme,
    runWriteBack,
    // 检查点
    pendingCheckpoint,
    resumePendingCheckpoint,
    discardCheckpoint,
    // 生命周期 / 保存
    initialize,
    retrySave,
    saveError,
    storageReady,
    lastSavedAt,
    migrationNotice,
    dismissMigrationNotice: () => setMigrationNotice(false),
    // 撤销重做
    undo,
    redo,
    canUndo: () => undoStack().length > 0,
    canRedo: () => redoStack().length > 0,
    // 原有编辑操作
    selectSegment,
    selectTranscript,
    selectTheme,
    setCoder,
    toggleAssignment,
    batchAssign,
    addTheme,
    updateTheme,
    deleteTheme,
    mergeThemes,
    splitTheme,
    updateSegment,
    importTranscript,
    addExample,
    exportCoding,
    downloadExport,
    orderedThemes,
    remoteEnvelope: remoteConflict,
    keepLocalVersion,
    applyRemoteVersion
  };
}

export type CodingStore = ReturnType<typeof useCodingStore>;
