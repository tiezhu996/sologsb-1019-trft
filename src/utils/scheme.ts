import type { Theme } from '../types';

export type ThemeChangeType = 'added' | 'changed' | 'removed';

export interface ThemeChange {
  themeId: string;
  type: ThemeChangeType;
  name: string;
  parentId: string | null;
  fields: string[];
  required?: boolean;
}

const FIELD_LABELS: Record<string, string> = {
  name: '名称',
  parentId: '层级',
  color: '颜色',
  definition: '操作定义',
  memo: '备忘录',
  examples: '示例'
};

const THEME_FIELDS: Array<keyof Theme> = ['name', 'parentId', 'color', 'definition', 'memo', 'examples'];

/** 对比项目快照基线与本地当前主题，列出新增 / 修改 / 移除。 */
export function diffThemes(baseline: Theme[], current: Theme[]): ThemeChange[] {
  const baseMap = new Map(baseline.map((theme) => [theme.id, theme]));
  const currentMap = new Map(current.map((theme) => [theme.id, theme]));
  const changes: ThemeChange[] = [];

  current.forEach((theme) => {
    const base = baseMap.get(theme.id);
    if (!base) {
      changes.push({ themeId: theme.id, type: 'added', name: theme.name, parentId: theme.parentId, fields: [] });
      return;
    }
    const fields = THEME_FIELDS.filter((field) => JSON.stringify(base[field]) !== JSON.stringify(theme[field])).map((field) => FIELD_LABELS[field]);
    if (fields.length) changes.push({ themeId: theme.id, type: 'changed', name: theme.name, parentId: theme.parentId, fields });
  });

  baseline.forEach((theme) => {
    if (!currentMap.has(theme.id)) {
      changes.push({ themeId: theme.id, type: 'removed', name: theme.name, parentId: theme.parentId, fields: [] });
    }
  });

  return markRequired(changes);
}

/** 新增子主题依赖新增的父主题；回写时把这些祖先标记为必选，避免入库后出现悬空父级。 */
function markRequired(changes: ThemeChange[]): ThemeChange[] {
  const byId = new Map(changes.map((change) => [change.themeId, change]));
  const required = new Set<string>();
  changes.filter((change) => change.type === 'added').forEach((change) => {
    let parentId = change.parentId;
    while (parentId) {
      const parent = byId.get(parentId);
      if (!parent || parent.type !== 'added' || required.has(parentId)) break;
      required.add(parentId);
      parentId = parent.parentId;
    }
  });
  return changes.map((change) => (required.has(change.themeId) ? { ...change, required: true } : change));
}

/** 把勾选的本地差异合并进方案库副本，返回新主题数组（不修改入参）。 */
export function mergeChangesIntoLibrary(libraryThemes: Theme[], currentThemes: Theme[], selected: ThemeChange[]): Theme[] {
  const selectedIds = new Set(selected.map((change) => change.themeId));
  const currentMap = new Map(currentThemes.map((theme) => [theme.id, theme]));
  let result = structuredClone(libraryThemes).filter((theme) => {
    const change = selected.find((item) => item.themeId === theme.id);
    return change?.type !== 'removed';
  });
  const resultIds = new Set(result.map((theme) => theme.id));

  selected.forEach((change) => {
    const latest = currentMap.get(change.themeId);
    if (change.type === 'added' && latest) {
      if (!resultIds.has(change.themeId)) {
        result.push(structuredClone(latest));
        resultIds.add(change.themeId);
      }
    } else if (change.type === 'changed' && latest) {
      const target = result.find((theme) => theme.id === change.themeId);
      if (target) Object.assign(target, structuredClone(latest));
    }
  });

  // 被移除主题的子主题提升为顶层主题，避免悬空父级。
  const remaining = new Set(result.map((theme) => theme.id));
  result.forEach((theme) => { if (theme.parentId && !remaining.has(theme.parentId)) theme.parentId = null; });

  const collidingParents = new Set(selected.filter((change) => change.type === 'removed').map((change) => change.themeId));
  result.forEach((theme) => { if (theme.parentId && collidingParents.has(theme.parentId)) theme.parentId = null; });

  return result;
}

export const snapshotThemes = (themes: Theme[]): Theme[] => structuredClone(themes);
