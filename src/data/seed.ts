import type {
  AuditEntry,
  LegacyCodingState,
  LibraryState,
  ProjectMeta,
  ProjectState,
  RegistryState,
  Theme
} from '../types';

export const SEED_SCHEME_ID = 'scheme-demo';
export const SEED_PROJECT_ID = 'p-default';

export const seedThemes = (): Theme[] => [
  { id: 't-education', name: '1. 教育经历', parentId: null, color: '#267365', definition: '正式或非正式的学习经历、学校与教师记忆。', memo: '注意区分入学选择和家庭影响。', examples: ['小学时老师让我第一次接触地图'] },
  { id: 't-school-choice', name: '1.1 学校选择', parentId: 't-education', color: '#4d9b8f', definition: '关于进入哪所学校、为何选择及其决策者的陈述。', memo: '家长和个人的理由要分别编码。', examples: [] },
  { id: 't-teacher', name: '1.2 教师影响', parentId: 't-education', color: '#78b7ac', definition: '教师对学习兴趣、职业方向或自我认知的影响。', memo: '', examples: ['他总能把课文讲成故事'] },
  { id: 't-work', name: '2. 工作与迁徙', parentId: null, color: '#b65d38', definition: '职业选择、工作变化以及由此产生的地域迁移。', memo: '', examples: [] },
  { id: 't-migration', name: '2.1 迁徙决定', parentId: 't-work', color: '#d2845f', definition: '搬家、跨地区工作背后的家庭与经济决策。', memo: '', examples: [] },
  { id: 't-family', name: '3. 家庭支持', parentId: null, color: '#3b6f95', definition: '家庭成员在教育、工作和生活转型中的支持。', memo: '', examples: [] }
];

const seedLines: Array<[string, string, string]> = [
  ['00:00:08', '访谈者', '李老师，您小时候是在县城还是乡下长大的？'],
  ['00:00:14', '李岚', '我是在临河镇长大的。小学四年级以前都在村里，后来家里觉得镇上的学校更好，就把我转过去了。'],
  ['00:00:31', '访谈者', '这个转学是谁提出来的？'],
  ['00:00:35', '李岚', '主要是我母亲。她认识镇上学校的王老师，说那边图书室有很多书。我当时其实不太愿意，因为要离开熟悉的朋友。'],
  ['00:00:53', '访谈者', '到了新学校以后，有哪个老师对您影响很大吗？'],
  ['00:00:59', '李岚', '班主任周老师。他没有只盯着成绩，常拿旧地图给我们讲河流和城市。我第一次觉得知识不是背出来的。'],
  ['00:01:20', '访谈者', '后来选择师范专业，也和这段经历有关吗？'],
  ['00:01:26', '李岚', '有关系。我原本想读贸易，是周老师和我母亲一起劝我，说我很适合教书。父亲那时更希望我去厂里上班，家里还争论过。'],
  ['00:01:48', '访谈者', '毕业以后一直留在本市吗？'],
  ['00:01:53', '李岚', '先在县中教了六年，后来丈夫工作调动，我才搬到省城。刚开始很不适应，母亲每周寄菜，也提醒我不要因为调动就放弃进修。'],
  ['00:02:17', '访谈者', '回看这些选择，您觉得家庭支持起了什么作用？'],
  ['00:02:23', '李岚', '不是替我做决定，而是在我犹豫的时候把可能性讲清楚。有时他们的建议并不对，但至少让我知道可以商量。']
];

export const seedSegments = (): ProjectState['segments'] => seedLines.map((line, index) => ({
  id: `s-${String(index + 1).padStart(3, '0')}`,
  transcriptId: 'tr-001',
  order: index,
  time: line[0],
  speaker: line[1],
  text: line[2],
  assignments: {
    A: index === 1 ? ['t-school-choice'] : index === 5 ? ['t-teacher'] : index === 7 ? ['t-teacher', 't-family'] : index === 8 ? ['t-migration'] : index === 9 ? ['t-family'] : [],
    B: index === 1 ? ['t-school-choice', 't-family'] : index === 5 ? ['t-teacher'] : index === 7 ? ['t-teacher'] : index === 8 ? ['t-migration', 't-work'] : []
  },
  note: ''
}));

export const seedLibrary = (now: string): LibraryState => ({
  kind: 'library',
  id: 'library',
  revision: 1,
  updatedAt: now,
  schemes: [{
    id: SEED_SCHEME_ID,
    name: '示例方案：生命历程访谈',
    createdAt: now,
    updatedAt: now,
    revision: 1,
    themes: seedThemes()
  }]
});

export const seedProject = (now: string): ProjectState => ({
  kind: 'project',
  id: SEED_PROJECT_ID,
  revision: 1,
  updatedAt: now,
  name: '李岚访谈研究',
  sourceSchemeId: SEED_SCHEME_ID,
  sourceSchemeName: '示例方案：生命历程访谈',
  snapshotSchemeRevision: 1,
  snapshotAt: now,
  activeTranscriptId: 'tr-001',
  activeSegmentId: 's-001',
  activeThemeId: 't-school-choice',
  coderA: '林研究员',
  coderB: '赵研究员',
  transcripts: [{ id: 'tr-001', title: '李岚访谈：教育与职业选择', participant: '李岚', importedAt: now, sourceName: '示例转写' }],
  segments: seedSegments(),
  themes: seedThemes(),
  baselineThemes: seedThemes(),
  audit: [{ id: 'a-seed', at: now, action: '初始化', detail: '从“示例方案：生命历程访谈”复制快照，载入演示访谈与两个编码者的判断' }]
});

export const seedRegistry = (now: string, project: ProjectState): RegistryState => ({
  kind: 'registry',
  id: 'registry',
  revision: 1,
  updatedAt: now,
  activeProjectId: project.id,
  projects: [metaFromProject(project, now)]
});

export function metaFromProject(project: ProjectState, now: string): ProjectMeta {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.audit.find((entry) => entry.action === '初始化' || entry.action === '迁移旧数据')?.at ?? now,
    updatedAt: project.updatedAt,
    sourceSchemeId: project.sourceSchemeId,
    sourceSchemeName: project.sourceSchemeName,
    snapshotSchemeRevision: project.snapshotSchemeRevision,
    snapshotAt: project.snapshotAt,
    segmentCount: project.segments.length
  };
}

/** 旧版单一工作区数据 → 默认项目 + 同名共享方案；原判断、人员、审计全部保留。 */
export function migrateLegacyState(legacy: LegacyCodingState, now: string): { library: LibraryState; project: ProjectState; registry: RegistryState } {
  const schemeId = `scheme-${crypto.randomUUID()}`;
  const projectId = `p-${crypto.randomUUID()}`;
  const themes = structuredClone(legacy.themes);
  const baselineThemes = structuredClone(legacy.themes);
  const audit: AuditEntry[] = [
    { id: `a-${crypto.randomUUID()}`, at: now, action: '迁移旧数据', detail: '旧版单一工作区已迁移为默认研究项目，原主题转为该项目的方案快照并在共享方案库保留一份可复用定义' },
    ...structuredClone(legacy.audit)
  ];
  const project: ProjectState = {
    kind: 'project',
    id: projectId,
    revision: legacy.revision + 1,
    updatedAt: now,
    name: '默认研究项目',
    sourceSchemeId: schemeId,
    sourceSchemeName: '默认方案（由旧工作区迁移）',
    snapshotSchemeRevision: 1,
    snapshotAt: now,
    activeTranscriptId: legacy.activeTranscriptId,
    activeSegmentId: legacy.activeSegmentId,
    activeThemeId: legacy.activeThemeId,
    coderA: legacy.coderA,
    coderB: legacy.coderB,
    transcripts: structuredClone(legacy.transcripts),
    segments: structuredClone(legacy.segments),
    themes,
    baselineThemes,
    audit: audit.slice(0, 251)
  };
  const library: LibraryState = {
    kind: 'library',
    id: 'library',
    revision: 1,
    updatedAt: now,
    schemes: [{
      id: schemeId,
      name: '默认方案（由旧工作区迁移）',
      createdAt: legacy.updatedAt,
      updatedAt: legacy.updatedAt,
      revision: 1,
      themes: structuredClone(legacy.themes)
    }]
  };
  const registry: RegistryState = {
    kind: 'registry',
    id: 'registry',
    revision: 1,
    updatedAt: now,
    activeProjectId: projectId,
    projects: [{
      id: projectId,
      name: '默认研究项目',
      createdAt: legacy.updatedAt,
      updatedAt: now,
      sourceSchemeId: schemeId,
      sourceSchemeName: '默认方案（由旧工作区迁移）',
      snapshotSchemeRevision: 1,
      snapshotAt: now,
      segmentCount: legacy.segments.length
    }]
  };
  return { library, project, registry };
}
