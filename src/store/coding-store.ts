import { createEffect, createSignal } from 'solid-js';
import { createStore, reconcile, unwrap } from 'solid-js/store';
import { migrateLegacyProject, seedCodebook, seedProject, type LegacyCodingState } from '../data/seed';
import type { CoderId, Codebook, PersistedEnvelope, Project, PublishCheckpoint, Segment, Theme, WorkspaceKind, WorkspaceMeta } from '../types';
import { buildTreeOrder, diffCodebook, type CodebookDiff } from '../utils/codebook';
import { dbDelete, dbRead, dbReadLegacySnapshot, dbWrite, dbWriteBatch } from '../utils/db';

const TAB_ID = crypto.randomUUID();
const LS_PROJECTS_KEY = 'sologsb-1019-projects-v2';
const LS_CODEBOOK_KEY = 'sologsb-1019-codebook-v2';
const LS_META_KEY = 'sologsb-1019-meta-v2';
const LS_CHECKPOINT_KEY = 'sologsb-1019-checkpoint-v2';
const LEGACY_STORAGE_KEY = 'sologsb-1019-state-v1';
const CHANNEL_NAME = 'sologsb-1019-coding';

interface BroadcastMessage {
  kind: WorkspaceKind;
  key: string;
  revision: number;
  updatedAt: string;
  writerId: string;
}

interface Bootstrap {
  codebook: Codebook;
  projects: Project[];
  meta: WorkspaceMeta;
  checkpoint: PublishCheckpoint | null;
  /** true 表示首屏数据来自旧版单库，需要在启动后落盘为 v2。 */
  needsPersist: boolean;
  migrationSource: 'idb' | 'local' | null;
}

const readLS = <T,>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
};

const readLegacyLocal = (): LegacyCodingState | null => {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? JSON.parse(raw) as LegacyCodingState : null;
  } catch {
    return null;
  }
};

const buildFreshBootstrap = (): Bootstrap => {
  const codebook = seedCodebook();
  const project = seedProject(codebook);
  return {
    codebook,
    projects: [project],
    meta: { revision: 1, updatedAt: new Date().toISOString(), activeProjectId: project.id },
    checkpoint: null,
    needsPersist: !readLS<Codebook>(LS_CODEBOOK_KEY),
    migrationSource: null
  };
};

const fromLegacy = (legacy: LegacyCodingState, source: 'idb' | 'local'): Bootstrap => {
  const codebook = seedCodebook();
  const project = migrateLegacyProject(legacy);
  // 项目里的主题就是迁移前唯一一套主题；共享库以它为准，避免出现两套。
  codebook.themes = structuredClone(project.themes);
  codebook.updatedAt = new Date().toISOString();
  return {
    codebook,
    projects: [project],
    meta: { revision: 1, updatedAt: new Date().toISOString(), activeProjectId: project.id },
    checkpoint: null,
    needsPersist: true,
    migrationSource: source
  };
};

/** 同步准备首屏数据：优先 v2；无 v2 则从旧版单库迁移到默认项目；再无则演示种子。 */
const bootstrap = (): Bootstrap => {
  const lsCodebook = readLS<Codebook>(LS_CODEBOOK_KEY);
  const lsProjects = readLS<Project[]>(LS_PROJECTS_KEY);
  const lsMeta = readLS<WorkspaceMeta>(LS_META_KEY);
  if (lsCodebook && lsProjects?.length && lsMeta) {
    return { codebook: lsCodebook, projects: lsProjects, meta: lsMeta, checkpoint: readLS<PublishCheckpoint>(LS_CHECKPOINT_KEY), needsPersist: false, migrationSource: null };
  }
  const legacyLocal = readLegacyLocal();
  if (legacyLocal) return fromLegacy(legacyLocal, 'local');
  return buildFreshBootstrap();
};

const initial = bootstrap();

const [projects, setProjects] = createSignal<Project[]>(initial.projects);
const [codebook, setCodebook] = createSignal<Codebook>(initial.codebook);
const [meta, setMeta] = createSignal<WorkspaceMeta>(initial.meta);
const [checkpoint, setCheckpoint] = createSignal<PublishCheckpoint | null>(initial.checkpoint);
const initialActiveProject = initial.projects.find((item) => item.id === initial.meta.activeProjectId) ?? initial.projects[0];
// 深拷贝断开与 projects 数组的对象别名：store 的 reconcile 会就地改写其代理目标。
const [state, setState] = createStore<Project>(structuredClone(initialActiveProject));

// 撤销/重做栈按项目隔离，切换项目时随之切换。
const undoByProject = new Map<string, Project[]>();
const redoByProject = new Map<string, Project[]>();
const [undoVersion, setUndoVersion] = createSignal(0);
const [remoteProject, setRemoteProject] = createSignal<PersistedEnvelope<Project> | null>(null);
const [remoteNotice, setRemoteNotice] = createSignal('');
const [storageReady, setStorageReady] = createSignal(false);
const [lastSavedAt, setLastSavedAt] = createSignal<Date | null>(null);
let channel: BroadcastChannel | null = null;
let saveTimer: number | undefined;
let codebookSaveTimer: number | undefined;
let saveGeneration = 0;
// 已持久化的活动项目签名，用于跳过 reconcile 引发的重复保存。
let savedSignature = '';

const cloneProject = (project: Project): Project => structuredClone(unwrap(project));
const signatureOf = (project: Project) => JSON.stringify({ r: project.revision, t: project.updatedAt, a: project.activeTranscriptId, g: project.activeSegmentId, h: project.activeThemeId, c: [project.coderA, project.coderB] });
const nowIso = () => new Date().toISOString();

const envelopeFor = <T,>(kind: WorkspaceKind, key: string, revision: number, updatedAt: string, payload: T): PersistedEnvelope<T> =>
  ({ kind, key, revision, updatedAt, writerId: TAB_ID, payload });

const broadcast = (message: BroadcastMessage) => channel?.postMessage(message);

const writeLocalProjects = (items: Project[]) => { localStorage.setItem(LS_PROJECTS_KEY, JSON.stringify(items)); };
const writeLocalCodebook = (value: Codebook) => { localStorage.setItem(LS_CODEBOOK_KEY, JSON.stringify(value)); };
const writeLocalMeta = (value: WorkspaceMeta) => { localStorage.setItem(LS_META_KEY, JSON.stringify(value)); };
const writeLocalCheckpoint = (value: PublishCheckpoint | null) => {
  if (value) localStorage.setItem(LS_CHECKPOINT_KEY, JSON.stringify(value));
  else localStorage.removeItem(LS_CHECKPOINT_KEY);
};

const persistMetaNow = (next: WorkspaceMeta) => {
  setMeta(next);
  writeLocalMeta(next);
  void dbWrite('meta', 'current', envelopeFor('meta', 'current', next.revision, next.updatedAt, next));
  broadcast({ kind: 'meta', key: 'current', revision: next.revision, updatedAt: next.updatedAt, writerId: TAB_ID });
};

const persistActiveProject = (snapshot: Project) => {
  window.clearTimeout(saveTimer);
  const generation = ++saveGeneration;
  saveTimer = window.setTimeout(async () => {
    // 切换项目会使旧的挂起保存作废，避免旧快照覆盖新活动项目。
    if (generation !== saveGeneration || state.id !== snapshot.id) return;
    setProjects((items) => items.map((item) => item.id === snapshot.id ? structuredClone(snapshot) : item));
    writeLocalProjects(projects());
    await dbWrite('projects', snapshot.id, envelopeFor('project', snapshot.id, snapshot.revision, snapshot.updatedAt, snapshot));
    if (generation !== saveGeneration || state.id !== snapshot.id) return;
    savedSignature = signatureOf(snapshot);
    setLastSavedAt(new Date());
    broadcast({ kind: 'project', key: snapshot.id, revision: snapshot.revision, updatedAt: snapshot.updatedAt, writerId: TAB_ID });
  }, 180);
};

/** 立即把某个项目快照写入本地（切换/新建项目前先冲刷，避免挂起保存丢失）。 */
const saveProjectNow = async (snapshot: Project) => {
  window.clearTimeout(saveTimer);
  saveGeneration += 1;
  setProjects((items) => items.some((item) => item.id === snapshot.id)
    ? items.map((item) => item.id === snapshot.id ? structuredClone(snapshot) : item)
    : [...items, structuredClone(snapshot)]);
  writeLocalProjects(projects());
  await dbWrite('projects', snapshot.id, envelopeFor('project', snapshot.id, snapshot.revision, snapshot.updatedAt, snapshot));
  if (state.id === snapshot.id) savedSignature = signatureOf(snapshot);
  setLastSavedAt(new Date());
  broadcast({ kind: 'project', key: snapshot.id, revision: snapshot.revision, updatedAt: snapshot.updatedAt, writerId: TAB_ID });
};

// 活动项目的任何变更（含撤销/重做、reconcile）统一由此防抖双写。
createEffect(() => {
  const snapshot = cloneProject(state);
  if (!storageReady()) return;
  if (signatureOf(snapshot) === savedSignature) return;
  persistActiveProject(snapshot);
});

const persistCodebookSoon = (next: Codebook) => {
  setCodebook(next);
  window.clearTimeout(codebookSaveTimer);
  codebookSaveTimer = window.setTimeout(() => {
    writeLocalCodebook(next);
    void dbWrite('codebook', 'current', envelopeFor('codebook', 'current', next.version, next.updatedAt, next));
    broadcast({ kind: 'codebook', key: 'current', revision: next.version, updatedAt: next.updatedAt, writerId: TAB_ID });
  }, 120);
};

const persistCheckpoint = async (value: PublishCheckpoint | null) => {
  setCheckpoint(value);
  writeLocalCheckpoint(value);
  if (value) await dbWrite('checkpoint', 'current', envelopeFor('checkpoint', 'current', 1, value.createdAt, value));
  else await dbDelete('checkpoint', 'current');
};

const transaction = (action: string, detail: string, mutator: (draft: Project) => void) => {
  const stack = undoByProject.get(state.id) ?? [];
  undoByProject.set(state.id, [...stack.slice(-49), cloneProject(state)]);
  redoByProject.delete(state.id);
  setUndoVersion((v) => v + 1);
  const next = cloneProject(state);
  mutator(next);
  next.revision = state.revision + 1;
  next.updatedAt = nowIso();
  next.audit.unshift({ id: crypto.randomUUID(), at: next.updatedAt, action, detail });
  next.audit = next.audit.slice(0, 250);
  setState(reconcile(next, { merge: false }));
  persistActiveProject(next);
};

const parseTranscript = (raw: string, speakerFallback: string): Array<Pick<Segment, 'time' | 'speaker' | 'text'>> => {
  const rows = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return rows.map((line, index) => {
    const timed = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(?:[-—])?\s*([^:：]{1,24})[:：]\s*(.+)$/);
    if (timed) return { time: timed[1], speaker: timed[2].trim(), text: timed[3].trim() };
    return { time: `${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}`, speaker: index % 2 === 0 ? speakerFallback : '访谈者', text: line };
  });
};

export function useCodingStore() {
  const initialize = async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    savedSignature = signatureOf(state);

    // 首屏来自旧版 localStorage 迁移，或全新安装的种子数据：先落盘 v2。
    if (initial.needsPersist) {
      if (initial.migrationSource === 'local') {
        // 若旧版 IndexedDB 也存在，localStorage 与 IDB 取较新者，避免覆盖较新的旧数据。
        try {
          const legacyIdb = await dbReadLegacySnapshot();
          const legacyLocal = readLegacyLocal();
          if (legacyIdb && legacyLocal && (legacyIdb.revision > legacyLocal.revision || legacyIdb.updatedAt > (legacyLocal.updatedAt ?? ''))) {
            const migrated = fromLegacy(legacyIdb.state as unknown as LegacyCodingState, 'idb');
            adoptBootstrap(migrated);
            await persistInitialData(migrated);
          } else {
            await persistInitialData(initial);
          }
        } catch {
          await persistInitialData(initial);
        }
      } else {
        // 全新安装：先确认旧版 IndexedDB 里没有待迁移数据。
        try {
          const legacyIdb = await dbReadLegacySnapshot();
          if (legacyIdb) {
            const migrated = fromLegacy(legacyIdb.state as unknown as LegacyCodingState, 'idb');
            adoptBootstrap(migrated);
            await persistInitialData(migrated);
          } else {
            await persistInitialData(initial);
          }
        } catch {
          await persistInitialData(initial);
        }
      }
    }

    // IDB 中的 v2 数据若比本地新，按实体提示，不静默覆盖。
    try {
      const [storedProject, storedCodebook, storedMeta, storedCheckpoint] = await Promise.all([
        dbRead<Project>('projects', state.id),
        dbRead<Codebook>('codebook', 'current'),
        dbRead<WorkspaceMeta>('meta', 'current'),
        dbRead<PublishCheckpoint>('checkpoint', 'current')
      ]);
      if (storedProject && (storedProject.revision > state.revision || storedProject.updatedAt > state.updatedAt)) {
        setRemoteProject(storedProject);
      }
      if (storedCodebook && storedCodebook.payload.version > codebook().version) {
        setRemoteNotice('共享方案库在其他标签页有较新版本');
      }
      if (storedMeta && storedMeta.payload.activeProjectId && storedMeta.payload.activeProjectId !== state.id && !initial.needsPersist) {
        setRemoteNotice('其他标签页切换了活动研究项目');
      }
      if (storedCheckpoint?.payload && (!checkpoint() || storedCheckpoint.payload.createdAt > checkpoint()!.createdAt)) {
        setCheckpoint(storedCheckpoint.payload);
      }
    } catch {
      // 忽略 IDB 读取失败，退化为仅 localStorage 模式。
    } finally {
      setStorageReady(true);
    }

    await resumeCheckpoint();

    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = (event: MessageEvent<BroadcastMessage>) => {
        const incoming = event.data;
        if (!incoming || incoming.writerId === TAB_ID) return;
        if (incoming.kind === 'project' && incoming.key === state.id) {
          if (incoming.revision !== state.revision || incoming.updatedAt !== state.updatedAt) {
            void dbRead<Project>('projects', state.id).then((envelope) => {
              if (envelope) setRemoteProject(envelope);
            });
          }
        } else if (incoming.kind === 'codebook') {
          if (incoming.revision > codebook().version) setRemoteNotice('共享方案库在其他标签页有较新版本');
          void dbRead<Codebook>('codebook', 'current').then((envelope) => {
            if (envelope && envelope.payload.version > codebook().version) setCodebook(envelope.payload);
          });
        } else if (incoming.kind === 'meta') {
          void dbRead<WorkspaceMeta>('meta', 'current').then((envelope) => { if (envelope) setMeta(envelope.payload); });
        } else if (incoming.kind === 'checkpoint') {
          void dbRead<PublishCheckpoint>('checkpoint', 'current').then((envelope) => setCheckpoint(envelope?.payload ?? null));
        }
      };
    }
  };

  const adoptBootstrap = (data: Bootstrap) => {
    setProjects(data.projects);
    setCodebook(data.codebook);
    setMeta(data.meta);
    setCheckpoint(data.checkpoint);
    const active = data.projects.find((item) => item.id === data.meta.activeProjectId) ?? data.projects[0];
    setState(reconcile(structuredClone(active), { merge: false }));
    savedSignature = signatureOf(active);
  };

  const persistInitialData = async (data: Bootstrap) => {
    writeLocalCodebook(data.codebook);
    writeLocalProjects(data.projects);
    writeLocalMeta(data.meta);
    writeLocalCheckpoint(data.checkpoint);
    const items: Array<{ store: 'projects' | 'codebook' | 'meta'; key: string; envelope: PersistedEnvelope }> = [
      { store: 'codebook', key: 'current', envelope: envelopeFor<Codebook>('codebook', 'current', data.codebook.version, data.codebook.updatedAt, data.codebook) },
      ...data.projects.map((project) => ({ store: 'projects' as const, key: project.id, envelope: envelopeFor<Project>('project', project.id, project.revision, project.updatedAt, project) })),
      { store: 'meta', key: 'current', envelope: envelopeFor<WorkspaceMeta>('meta', 'current', data.meta.revision, data.meta.updatedAt, data.meta) }
    ];
    try {
      await dbWriteBatch(items);
    } catch {
      // 批量失败时逐条兜底。
      await Promise.all(items.map((item) => dbWrite(item.store, item.key, item.envelope).catch(() => undefined)));
    }
    if (data.migrationSource) localStorage.removeItem(LEGACY_STORAGE_KEY);
    const active = data.projects.find((item) => item.id === data.meta.activeProjectId) ?? data.projects[0];
    savedSignature = signatureOf(active);
  };

  const switchProject = async (id: string) => {
    if (id === state.id) return;
    const target = projects().find((item) => item.id === id);
    if (!target) return;
    // 先冲刷当前项目可能尚未落盘的修订，再离开，避免快速切换丢数据。
    if (savedSignature !== signatureOf(state)) await saveProjectNow(cloneProject(state));
    const snapshot = structuredClone(target);
    saveGeneration += 1;
    setState(reconcile(snapshot, { merge: false }));
    savedSignature = signatureOf(snapshot);
    setRemoteProject(null);
    persistMetaNow({ ...meta(), revision: meta().revision + 1, updatedAt: nowIso(), activeProjectId: id });
  };

  const renameProject = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === state.name) return;
    transaction('重命名项目', trimmed, (draft) => { draft.name = trimmed; });
  };

  const createProject = async (name: string): Promise<string> => {
    // 离开当前项目前先冲刷其挂起修订。
    if (savedSignature !== signatureOf(state)) await saveProjectNow(cloneProject(state));
    const trimmed = name.trim() || `研究项目 ${projects().length + 1}`;
    const ts = nowIso();
    const id = `p-${crypto.randomUUID()}`;
    const base = codebook();
    const project: Project = {
      id,
      name: trimmed,
      createdAt: ts,
      codebookVersion: base.version,
      codebookCopiedAt: ts,
      revision: 1,
      updatedAt: ts,
      activeTranscriptId: '',
      activeSegmentId: '',
      activeThemeId: base.themes[0]?.id ?? '',
      coderA: '编码者 A',
      coderB: '编码者 B',
      transcripts: [],
      segments: [],
      // 立项时复制方案快照；保留主题 id 便于后续与共享库逐项比对。
      themes: structuredClone(base.themes),
      audit: [{ id: `a-${crypto.randomUUID()}`, at: ts, action: '创建项目', detail: `复制共享方案库 v${base.version} 快照：${base.name}` }]
    };
    await saveProjectNow(project);
    undoByProject.set(id, []);
    redoByProject.set(id, []);
    saveGeneration += 1;
    setState(reconcile(structuredClone(project), { merge: false }));
    savedSignature = signatureOf(project);
    setRemoteProject(null);
    persistMetaNow({ revision: meta().revision + 1, updatedAt: ts, activeProjectId: id });
    return id;
  };

  const undo = () => {
    const stack = undoByProject.get(state.id) ?? [];
    if (!stack.length) return;
    const previous = stack[stack.length - 1];
    undoByProject.set(state.id, stack.slice(0, -1));
    const redoStack = redoByProject.get(state.id) ?? [];
    redoByProject.set(state.id, [...redoStack, cloneProject(state)]);
    setUndoVersion((v) => v + 1);
    setState(reconcile(previous, { merge: false }));
    persistActiveProject(previous);
  };

  const redo = () => {
    const stack = redoByProject.get(state.id) ?? [];
    if (!stack.length) return;
    const next = stack[stack.length - 1];
    redoByProject.set(state.id, stack.slice(0, -1));
    const undoStack = undoByProject.get(state.id) ?? [];
    undoByProject.set(state.id, [...undoStack, cloneProject(state)]);
    setUndoVersion((v) => v + 1);
    setState(reconcile(next, { merge: false }));
    persistActiveProject(next);
  };

  const canUndo = () => { void undoVersion(); return (undoByProject.get(state.id)?.length ?? 0) > 0; };
  const canRedo = () => { void undoVersion(); return (redoByProject.get(state.id)?.length ?? 0) > 0; };

  const selectSegment = (id: string) => setState('activeSegmentId', id);
  const selectTranscript = (id: string) => setState('activeTranscriptId', id);
  const selectTheme = (id: string) => setState('activeThemeId', id);
  const setCoder = (coder: CoderId, name: string) => {
    const current = coder === 'A' ? state.coderA : state.coderB;
    if (current === name) return;
    transaction('设置编码人员', `${coder === 'A' ? 'A' : 'B'}：${name}`, (draft) => {
      if (coder === 'A') draft.coderA = name;
      else draft.coderB = name;
    });
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
    transaction('删除主题', theme.name, (draft) => {
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
      draft.transcripts.push({ id: transcriptId, title, participant, importedAt: nowIso(), sourceName });
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
    const segmentMap = new Map(state.segments.map((segment) => [segment.id, segment]));
    const themeMap = new Map(state.themes.map((theme) => [theme.id, theme]));
    if (format === 'json') return JSON.stringify({ exportedAt: nowIso(), project: { id: state.id, name: state.name, codebookVersion: state.codebookVersion }, ...cloneProject(state) }, null, 2);
    const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const rows = [['片段编号', '时间', '发言人', '原文', '编码者', '主题路径', '备忘录'].map(escape).join(',')];
    state.segments.forEach((segment) => {
      (['A', 'B'] as CoderId[]).forEach((coder) => {
        const name = coder === 'A' ? state.coderA : state.coderB;
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
        rows.push([segment.id, segment.time, segment.speaker, segment.text, name, paths.join(' | '), segmentMap.get(segment.id)?.note ?? ''].map(escape).join(','));
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
    anchor.download = `${state.name || '研究项目'}-${new Date().toISOString().slice(0, 10)}.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const keepLocalVersion = () => {
    setRemoteProject(null);
    transaction('处理多标签冲突', '保留当前标签页版本并生成新修订', () => undefined);
  };

  const applyRemoteVersion = () => {
    const remote = remoteProject();
    if (!remote) return;
    const undoStack = undoByProject.get(state.id) ?? [];
    undoByProject.set(state.id, [...undoStack, cloneProject(state)]);
    redoByProject.delete(state.id);
    setUndoVersion((v) => v + 1);
    setState(reconcile(structuredClone(remote.payload), { merge: false }));
    savedSignature = signatureOf(remote.payload);
    setProjects((items) => {
      const next = items.map((item) => item.id === remote.payload.id ? remote.payload : item);
      writeLocalProjects(next);
      return next;
    });
    setRemoteProject(null);
  };

  const orderedThemes = () => buildTreeOrder(state.themes);

  // ---------- 方案回写（本地调整 → 共享编码方案库） ----------

  /** 比较当前项目快照与共享库；回写前必须先让研究者过目这份差异。 */
  const codebookDiff = (): CodebookDiff => diffCodebook(structuredClone(unwrap(state.themes)), codebook().themes);

  /**
   * 第 1 步：在任何数据变更前持久化检查点。
   * 之后提交失败可从同一检查点重试（幂等），不会产生第二套主题。
   */
  const preparePublish = async (): Promise<PublishCheckpoint> => {
    const existing = checkpoint();
    if (existing) return existing;
    const library = codebook();
    const ts = nowIso();
    const newVersion = library.version + 1;
    const pre = cloneProject(state);
    const post = cloneProject(state);
    post.codebookVersion = newVersion;
    post.codebookCopiedAt = ts;
    post.revision = pre.revision + 1;
    post.updatedAt = ts;
    post.audit.unshift({ id: crypto.randomUUID(), at: ts, action: '回写共享方案库', detail: `本项目主题调整已发布为共享方案 v${newVersion}，其他项目不受影响` });
    post.audit = post.audit.slice(0, 250);
    const cp: PublishCheckpoint = {
      id: `cp-${crypto.randomUUID()}`,
      projectId: state.id,
      createdAt: ts,
      status: 'pending',
      baseCodebookVersion: library.version,
      newCodebookVersion: newVersion,
      preProject: pre,
      postProject: post
    };
    await persistCheckpoint(cp);
    return cp;
  };

  /** 第 2 步：按检查点原子提交。重复执行结果相同（同 id 覆盖，不新增主题）。 */
  const commitPublish = async (cp: PublishCheckpoint): Promise<void> => {
    const library = codebook();
    if (library.version >= cp.newCodebookVersion) {
      // 方案库已到达目标版本（上次提交实际已成功），只需完成项目快照收尾。
      await finishPublish(cp);
      return;
    }
    if (library.version !== cp.baseCodebookVersion) {
      throw new Error('共享方案库已被其他项目改版，请放弃本次回写后重新比对差异');
    }
    if (state.id !== cp.projectId || state.revision !== cp.preProject.revision) {
      throw new Error('项目在回写准备后又有新修改，请放弃本次回写后重新比对差异');
    }
    const nextLibrary: Codebook = {
      version: cp.newCodebookVersion,
      updatedAt: cp.createdAt,
      name: library.name,
      themes: structuredClone(cp.postProject.themes)
    };
    const projectItems = projects().map((item) => item.id === cp.postProject.id ? cp.postProject : item);
    await dbWriteBatch([
      { store: 'codebook', key: 'current', envelope: envelopeFor('codebook', 'current', nextLibrary.version, nextLibrary.updatedAt, nextLibrary) },
      { store: 'projects', key: cp.postProject.id, envelope: envelopeFor('project', cp.postProject.id, cp.postProject.revision, cp.postProject.updatedAt, cp.postProject) }
    ]);
    // IndexedDB 已原子提交；随后任何失败都可凭“已提交”检查点恢复。
    writeLocalCodebook(nextLibrary);
    writeLocalProjects(projectItems);
    await persistCheckpoint({ ...cp, status: 'committed' });
    await finishPublish(cp);
  };

  const finishPublish = async (cp: PublishCheckpoint) => {
    setCodebook((prev) => prev.version >= cp.newCodebookVersion ? prev : {
      version: cp.newCodebookVersion,
      updatedAt: cp.createdAt,
      name: prev.name,
      themes: structuredClone(cp.postProject.themes)
    });
    setState(reconcile(structuredClone(cp.postProject), { merge: false }));
    savedSignature = signatureOf(cp.postProject);
    setProjects((items) => {
      const next = items.map((item) => item.id === cp.postProject.id ? cp.postProject : item);
      writeLocalProjects(next);
      return next;
    });
    broadcast({ kind: 'codebook', key: 'current', revision: cp.newCodebookVersion, updatedAt: cp.createdAt, writerId: TAB_ID });
    await persistCheckpoint(null);
  };

  /** 放弃回写：恢复检查点前的项目快照并删除检查点。可安全重复调用。 */
  const abortPublish = async (cp: PublishCheckpoint): Promise<void> => {
    if (state.id === cp.projectId && (state.revision === cp.preProject.revision || state.revision === cp.postProject.revision)) {
      setState(reconcile(structuredClone(cp.preProject), { merge: false }));
      savedSignature = signatureOf(cp.preProject);
      setProjects((items) => {
        const next = items.map((item) => item.id === cp.preProject.id ? cp.preProject : item);
        writeLocalProjects(next);
        return next;
      });
      await dbWrite('projects', cp.preProject.id, envelopeFor('project', cp.preProject.id, cp.preProject.revision, cp.preProject.updatedAt, cp.preProject));
    }
    await persistCheckpoint(null);
  };

  /** 启动时恢复检查点：已提交则完成收尾；未提交则保留，等待研究者重试或放弃。 */
  const resumeCheckpoint = async () => {
    const cp = checkpoint();
    if (!cp) return;
    if (cp.status === 'committed' || codebook().version >= cp.newCodebookVersion) {
      try {
        await finishPublish(cp);
      } catch {
        /* 保留检查点，等待手动处理 */
      }
    }
  };

  return {
    state,
    projects,
    codebook,
    meta,
    checkpoint,
    initialize,
    switchProject,
    renameProject,
    createProject,
    undo,
    redo,
    canUndo,
    canRedo,
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
    codebookDiff,
    preparePublish,
    commitPublish,
    abortPublish,
    remoteEnvelope: remoteProject,
    remoteNotice,
    dismissRemoteNotice: () => setRemoteNotice(''),
    keepLocalVersion,
    applyRemoteVersion,
    storageReady,
    lastSavedAt
  };
}
