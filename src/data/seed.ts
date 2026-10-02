import type { AuditEntry, Codebook, Project, Theme } from '../types';

const seedThemes = (): Theme[] => [
  { id: 't-education', name: '1. 教育经历', parentId: null, color: '#267365', definition: '正式或非正式的学习经历、学校与教师记忆。', memo: '注意区分入学选择和家庭影响。', examples: ['小学时老师让我第一次接触地图'] },
  { id: 't-school-choice', name: '1.1 学校选择', parentId: 't-education', color: '#4d9b8f', definition: '关于进入哪所学校、为何选择及其决策者的陈述。', memo: '家长和个人的理由要分别编码。', examples: [] },
  { id: 't-teacher', name: '1.2 教师影响', parentId: 't-education', color: '#78b7ac', definition: '教师对学习兴趣、职业方向或自我认知的影响。', memo: '', examples: ['他总能把课文讲成故事'] },
  { id: 't-work', name: '2. 工作与迁徙', parentId: null, color: '#b65d38', definition: '职业选择、工作变化以及由此产生的地域迁移。', memo: '', examples: [] },
  { id: 't-migration', name: '2.1 迁徙决定', parentId: 't-work', color: '#d2845f', definition: '搬家、跨地区工作背后的家庭与经济决策。', memo: '', examples: [] },
  { id: 't-family', name: '3. 家庭支持', parentId: null, color: '#3b6f95', definition: '家庭成员在教育、工作和生活转型中的支持。', memo: '', examples: [] }
];

export const seedCodebook = (): Codebook => ({
  version: 1,
  updatedAt: new Date().toISOString(),
  name: '通用访谈研究方案',
  themes: seedThemes()
});

/** 首次使用（没有任何旧数据）时的演示项目，快照复制自默认共享方案库。 */
export const seedProject = (codebook: Codebook): Project => {
  const now = new Date().toISOString();
  const lines: Array<[string, string, string]> = [
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
  return {
    id: 'p-demo',
    name: '李岚访谈：教育与职业选择',
    createdAt: now,
    codebookVersion: codebook.version,
    codebookCopiedAt: now,
    revision: 1,
    updatedAt: now,
    activeTranscriptId: 'tr-001',
    activeSegmentId: 's-001',
    activeThemeId: 't-school-choice',
    coderA: '林研究员',
    coderB: '赵研究员',
    transcripts: [{ id: 'tr-001', title: '李岚访谈：教育与职业选择', participant: '李岚', importedAt: now, sourceName: '示例转写' }],
    segments: lines.map((line, index) => ({
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
    })),
    themes: structuredClone(codebook.themes),
    audit: [{ id: 'a-seed', at: now, action: '初始化', detail: '载入演示访谈与两个编码者的判断' }]
  };
};

/** 旧版 CodingState（v1，单库）的形状，仅迁移时使用。 */
export interface LegacyCodingState {
  revision: number;
  updatedAt: string;
  activeTranscriptId: string;
  activeSegmentId: string;
  activeThemeId: string;
  coderA: string;
  coderB: string;
  transcripts: Project['transcripts'];
  segments: Project['segments'];
  themes: Theme[];
  audit: AuditEntry[];
}

/**
 * 首次打开 v2 时把旧版单库数据迁移为“默认项目”。
 * 原转写、双编码者判断、人员姓名与审计记录全部保留，不复制出第二套主题。
 */
export const migrateLegacyProject = (legacy: LegacyCodingState): Project => {
  const now = new Date().toISOString();
  const firstTitle = legacy.transcripts[0]?.title ?? '默认研究项目';
  return {
    id: 'p-default',
    name: firstTitle,
    createdAt: now,
    codebookVersion: 1,
    codebookCopiedAt: now,
    revision: legacy.revision,
    updatedAt: legacy.updatedAt || now,
    activeTranscriptId: legacy.activeTranscriptId,
    activeSegmentId: legacy.activeSegmentId,
    activeThemeId: legacy.activeThemeId,
    coderA: legacy.coderA,
    coderB: legacy.coderB,
    transcripts: structuredClone(legacy.transcripts ?? []),
    segments: structuredClone(legacy.segments ?? []),
    themes: structuredClone(legacy.themes ?? []),
    audit: [
      { id: `a-migrate-${crypto.randomUUID()}`, at: now, action: '数据迁移', detail: '旧版数据迁移到默认研究项目，原判断、编码人员与审计记录已保留' },
      ...structuredClone(legacy.audit ?? [])
    ]
  };
};
