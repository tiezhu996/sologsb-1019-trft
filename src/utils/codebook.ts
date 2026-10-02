import type { Theme } from '../types';

/** 按层级 + 名称排序主题树，名称前填充全角空格表示层级（供下拉与列表使用）。 */
export const buildTreeOrder = (themes: Theme[]) => {
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

export type ThemeDiffKind = 'added' | 'removed' | 'changed';

export interface ThemeDiffEntry {
  kind: ThemeDiffKind;
  themeId: string;
  name: string;
  fields: Array<{ field: string; before: string; after: string }>;
}

export interface CodebookDiff {
  added: ThemeDiffEntry[];
  removed: ThemeDiffEntry[];
  changed: ThemeDiffEntry[];
  get isEmpty(): boolean;
}

const THEME_FIELDS: Array<{ key: keyof Theme; label: string }> = [
  { key: 'name', label: '名称' },
  { key: 'parentId', label: '上级主题' },
  { key: 'color', label: '颜色' },
  { key: 'definition', label: '操作定义' },
  { key: 'memo', label: '备忘录' },
  { key: 'examples', label: '示例' }
];

const fieldValueText = (theme: Theme, key: keyof Theme, byId: Map<string, Theme>): string => {
  const value = theme[key];
  if (key === 'parentId') {
    const parentId = value as string | null;
    return parentId ? (byId.get(parentId)?.name ?? parentId) : '（一级主题）';
  }
  if (key === 'examples') return (value as string[]).join(' / ') || '（空）';
  return String(value) || '（空）';
};

/**
 * 比较项目内调整过的主题快照与共享方案库，生成回写前需要确认的差异。
 * 以主题 id 对齐：新增、删除、字段变更（含层级调整）分别列出。
 */
export const diffCodebook = (projectThemes: Theme[], library: Theme[]): CodebookDiff => {
  const projectById = new Map(projectThemes.map((theme) => [theme.id, theme]));
  const libraryById = new Map(library.map((theme) => [theme.id, theme]));
  const added: ThemeDiffEntry[] = [];
  const removed: ThemeDiffEntry[] = [];
  const changed: ThemeDiffEntry[] = [];

  projectThemes.forEach((theme) => {
    if (!libraryById.has(theme.id)) {
      added.push({ kind: 'added', themeId: theme.id, name: theme.name, fields: [] });
      return;
    }
    const base = libraryById.get(theme.id)!;
    const fields: ThemeDiffEntry['fields'] = [];
    THEME_FIELDS.forEach(({ key, label }) => {
      const before = fieldValueText(base, key, libraryById);
      const after = fieldValueText(theme, key, projectById);
      if (before !== after) fields.push({ field: label, before, after });
    });
    if (fields.length) changed.push({ kind: 'changed', themeId: theme.id, name: theme.name, fields });
  });

  library.forEach((theme) => {
    if (!projectById.has(theme.id)) removed.push({ kind: 'removed', themeId: theme.id, name: theme.name, fields: [] });
  });

  return { added, removed, changed, get isEmpty() { return !added.length && !removed.length && !changed.length; } };
};
