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

/** 研究项目工作区：本项目的转写、判断、审计，以及立项时复制的编码方案快照。 */
export interface Project {
  id: string;
  name: string;
  createdAt: string;
  /** 立项时复制的方案版本；之后项目内的主题调整不会影响共享库。 */
  codebookVersion: number;
  codebookCopiedAt: string;
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

/** 共享编码方案库：保存可复用的主题定义，供新项目复制快照。 */
export interface Codebook {
  version: number;
  updatedAt: string;
  name: string;
  themes: Theme[];
}

export interface WorkspaceMeta {
  revision: number;
  updatedAt: string;
  activeProjectId: string;
}

export type PublishCheckpointStatus = 'pending' | 'committed';

/** 方案回写检查点：变更前落库，失败后可据此重试或放弃，保证不产生重复主题。 */
export interface PublishCheckpoint {
  id: string;
  projectId: string;
  createdAt: string;
  status: PublishCheckpointStatus;
  /** 检查点基于的方案库版本，用于检测库是否已被他处改版。 */
  baseCodebookVersion: number;
  /** 提交成功后的方案库版本。 */
  newCodebookVersion: number;
  preProject: Project;
  postProject: Project;
}

export type WorkspaceKind = 'project' | 'codebook' | 'meta' | 'checkpoint';

export interface PersistedEnvelope<T = unknown> {
  kind: WorkspaceKind;
  /** project 为项目 id，codebook/meta/checkpoint 为固定键。 */
  key: string;
  revision: number;
  updatedAt: string;
  writerId: string;
  payload: T;
}
