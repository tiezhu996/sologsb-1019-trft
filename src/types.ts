export type CoderId = 'A' | 'B';

export interface Theme {
  id: string;
  name: string;
  parentId: string | null;
  color: string;
  definition: string;
  memo: string;
  examples: string[];
}

export interface Segment {
  id: string;
  transcriptId: string;
  order: number;
  speaker: string;
  time: string;
  text: string;
  assignments: Record<CoderId, string[]>;
  note: string;
}

export interface Transcript {
  id: string;
  title: string;
  participant: string;
  importedAt: string;
  sourceName: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
}

/** 共享编码方案：可复用的主题定义，存放在方案库中，可独立改版。 */
export interface Scheme {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** 方案自身的修订号；改版只增长此号，不影响已复制快照的项目。 */
  revision: number;
  themes: Theme[];
}

/** 项目元数据：只保存在登记簿里，供项目切换列表使用。 */
export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** 建项目时复制的来源方案。 */
  sourceSchemeId: string | null;
  sourceSchemeName: string;
  /** 快照当时的方案修订号。 */
  snapshotSchemeRevision: number;
  snapshotAt: string;
  segmentCount: number;
}

/** 研究项目工作区：本项目的转写、判断、人员、审计，外加不可变方案快照。 */
export interface ProjectState {
  kind: 'project';
  id: string;
  revision: number;
  updatedAt: string;
  name: string;
  sourceSchemeId: string | null;
  sourceSchemeName: string;
  snapshotSchemeRevision: number;
  snapshotAt: string;
  activeTranscriptId: string;
  activeSegmentId: string;
  activeThemeId: string;
  coderA: string;
  coderB: string;
  transcripts: Transcript[];
  segments: Segment[];
  /** 建项目（或上次回写）时复制的方案快照工作副本；方案库改版不会改动这里。 */
  themes: Theme[];
  /** 快照基线：回写差异时与 themes 对比；回写成功后重置为当前工作副本。 */
  baselineThemes: Theme[];
  audit: AuditEntry[];
}

/** 项目登记簿：项目清单与当前打开的项目。 */
export interface RegistryState {
  kind: 'registry';
  id: 'registry';
  revision: number;
  updatedAt: string;
  activeProjectId: string | null;
  projects: ProjectMeta[];
}

/** 共享编码方案库：保存所有可复用方案。 */
export interface LibraryState {
  kind: 'library';
  id: 'library';
  revision: number;
  updatedAt: string;
  schemes: Scheme[];
}

export type StoreRecord = ProjectState | RegistryState | LibraryState;

export interface PersistedEnvelope {
  /** 记录键：library / registry / project:<id>。 */
  key: string;
  revision: number;
  updatedAt: string;
  writerId: string;
  state: StoreRecord;
}

/** 旧版本（单工作区）信封，用于首次打开迁移。 */
export interface LegacyEnvelope {
  revision: number;
  updatedAt: string;
  writerId: string;
  state: LegacyCodingState;
}

export interface LegacyCodingState {
  revision: number;
  updatedAt: string;
  activeTranscriptId: string;
  activeSegmentId: string;
  activeThemeId: string;
  coderA: string;
  coderB: string;
  transcripts: Transcript[];
  segments: Segment[];
  themes: Theme[];
  audit: AuditEntry[];
}

/** 可从检查点重试的多记录操作。 */
export type Checkpoint =
  | {
      id: string;
      kind: 'create-project';
      createdAt: string;
      label: string;
      project: ProjectState;
      registry: RegistryState;
    }
  | {
      id: string;
      kind: 'write-back-scheme';
      createdAt: string;
      label: string;
      projectId: string;
      project: ProjectState;
      library: LibraryState;
    }
  | {
      id: string;
      kind: 'migrate';
      createdAt: string;
      label: string;
      library: LibraryState;
      project: ProjectState;
      registry: RegistryState;
    };

export type CheckpointKind = Checkpoint['kind'];
