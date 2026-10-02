import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import type { CodingStore } from '../store/coding-store';
import type { ThemeChange } from '../utils/scheme';

/* ============ 新建研究项目：从共享方案复制快照 ============ */
export function NewProjectDialog(props: { store: CodingStore; open: boolean; onClose: () => void }) {
  const [name, setName] = createSignal('');
  const [schemeId, setSchemeId] = createSignal<string | null>('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  const submit = async () => {
    if (!name().trim() || busy()) return;
    setBusy(true);
    setError('');
    const result = await props.store.createProjectFromScheme(name(), schemeId() || null);
    setBusy(false);
    if (result === 'error' || result === 'stale') {
      setError(result === 'stale' ? '方案库刚刚被其他标签页修改，请先处理上方的冲突提示。' : '创建项目时写入失败，已保留检查点，可在顶部横幅重试，不会重复创建。');
      return;
    }
    setName('');
    setSchemeId('');
    props.onClose();
  };

  return (
    <div class="modal-backdrop" classList={{ hidden: !props.open }} onClick={props.onClose}>
      <section class="modal-card wide" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <header><div><span class="eyebrow">NEW PROJECT</span><h2>新建研究项目</h2></div><button class="modal-close" onClick={props.onClose}>×</button></header>
        <p class="modal-intro">新项目会把所选共享方案<strong>完整复制一份快照</strong>：主题定义成为本项目的独立副本。之后方案库改版不会改动本项目，项目内的主题调整也不会影响其他项目，直到你明确回写。</p>
        <label class="field-label">项目名称
          <input autofocus class="native-input full" value={name()} onInput={(event) => setName(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && submit()} placeholder="例如：第二轮教师访谈编码" />
        </label>
        <div class="field-label">选择编码方案（复制快照）</div>
        <div class="scheme-pick-list">
          <label class="scheme-pick" classList={{ active: schemeId() === '' }}>
            <input type="radio" name="scheme" checked={schemeId() === ''} onChange={() => setSchemeId('')} />
            <div><strong>空白方案</strong><span>不预置任何主题，在项目中从头建立主题树。</span></div>
          </label>
          <For each={props.store.library.schemes}>{(scheme) => (
            <label class="scheme-pick" classList={{ active: schemeId() === scheme.id }}>
              <input type="radio" name="scheme" checked={schemeId() === scheme.id} onChange={() => setSchemeId(scheme.id)} />
              <div><strong>{scheme.name}</strong><span>{scheme.themes.length} 个主题 · 方案修订 r{scheme.revision} · {new Date(scheme.updatedAt).toLocaleDateString('zh-CN')}</span></div>
            </label>
          )}</For>
        </div>
        <Show when={error()}><div class="disagreement" style={{ margin: '12px 0 0' }}>{error()}</div></Show>
        <footer><button class="button secondary" onClick={props.onClose}>取消</button><button class="button primary" disabled={!name().trim() || busy()} onClick={submit}>{busy() ? '正在创建…' : '复制方案并创建'}</button></footer>
      </section>
    </div>
  );
}

/* ============ 项目管理（重命名 / 删除） ============ */
export function ProjectMenuDialog(props: { store: CodingStore; open: boolean; onClose: () => void }) {
  const [renaming, setRenaming] = createSignal(false);
  const [name, setName] = createSignal(props.store.state.name);
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);

  const submitRename = () => {
    props.store.renameProject(name());
    setRenaming(false);
    props.onClose();
  };

  return (
    <div class="modal-backdrop" classList={{ hidden: !props.open }} onClick={props.onClose}>
      <section class="modal-card" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <header><div><span class="eyebrow">PROJECTS</span><h2>研究项目</h2></div><button class="modal-close" onClick={props.onClose}>×</button></header>
        <p class="modal-intro">每个浏览器可保存多个研究项目，互相独立。当前项目：<strong>{props.store.state.name}</strong>（方案快照 r{props.store.state.snapshotSchemeRevision}）。</p>
        <div class="project-manage-list">
          <For each={props.store.registry.projects}>{(meta) => (
            <div class="project-manage-item" classList={{ active: meta.id === props.store.state.id }}>
              <button class="project-manage-main" onClick={() => { void props.store.switchProject(meta.id); props.onClose(); }}>
                <strong>{meta.name}</strong>
                <span>{meta.sourceSchemeName} · 快照 r{meta.snapshotSchemeRevision} · {meta.segmentCount} 片段 · 更新 {new Date(meta.updatedAt).toLocaleDateString('zh-CN')}</span>
              </button>
              <Show when={confirmDelete() === meta.id} fallback={
                <button class="icon-text danger-text" title="删除项目" onClick={() => setConfirmDelete(meta.id)}>删除</button>
              }>
                <span class="confirm-inline">确认？
                  <button class="link-button danger-text" onClick={() => { void props.store.deleteProject(meta.id).then(() => { setConfirmDelete(null); if (meta.id !== props.store.state.id) props.onClose(); }); }}>是</button>
                  <button class="link-button" onClick={() => setConfirmDelete(null)}>否</button>
                </span>
              </Show>
            </div>
          )}</For>
        </div>
        <Show when={renaming()}>
          <label class="field-label">重命名当前项目
            <input class="native-input full" value={name()} onInput={(event) => setName(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && submitRename()} />
          </label>
        </Show>
        <footer>
          <button class="button secondary" onClick={() => { setRenaming(true); setName(props.store.state.name); }}>重命名当前项目</button>
          <button class="button primary" onClick={props.onClose}>完成</button>
        </footer>
      </section>
    </div>
  );
}

/* ============ 共享编码方案库 ============ */
export function SchemeLibraryDialog(props: { store: CodingStore; open: boolean; onClose: () => void }) {
  const [selectedId, setSelectedId] = createSignal('');
  const [newSchemeName, setNewSchemeName] = createSignal('');
  const [newThemeName, setNewThemeName] = createSignal('');
  const [newThemeParent, setNewThemeParent] = createSignal('');
  const [confirmDeleteScheme, setConfirmDeleteScheme] = createSignal(false);

  const schemes = () => props.store.library.schemes;
  const selected = createMemo(() => {
    const list = schemes();
    return list.find((scheme) => scheme.id === selectedId()) ?? list[0] ?? null;
  });

  const ordered = createMemo(() => {
    const scheme = selected();
    if (!scheme) return [];
    const byParent = new Map<string | null, typeof scheme.themes>();
    scheme.themes.forEach((theme) => byParent.set(theme.parentId, [...(byParent.get(theme.parentId) ?? []), theme]));
    const out: Array<{ id: string; name: string; parentId: string | null; depth: number; definition: string; memo: string; color: string }> = [];
    const visit = (parentId: string | null, depth: number) => {
      [...(byParent.get(parentId) ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).forEach((theme) => {
        out.push({ id: theme.id, name: theme.name, parentId: theme.parentId, depth, definition: theme.definition, memo: theme.memo, color: theme.color });
        visit(theme.id, depth + 1);
      });
    };
    visit(null, 0);
    return out;
  });

  const createScheme = () => {
    if (!newSchemeName().trim()) return;
    props.store.createScheme(newSchemeName());
    setNewSchemeName('');
  };

  const addTheme = () => {
    const scheme = selected();
    if (!scheme || !newThemeName().trim()) return;
    props.store.addSchemeTheme(scheme.id, newThemeName(), newThemeParent() || null);
    setNewThemeName('');
    setNewThemeParent('');
  };

  return (
    <div class="modal-backdrop" classList={{ hidden: !props.open }} onClick={props.onClose}>
      <section class="modal-card wide library-card" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <header><div><span class="eyebrow">CODE SCHEME LIBRARY</span><h2>共享编码方案库</h2></div><button class="modal-close" onClick={props.onClose}>×</button></header>
        <p class="modal-intro">这里保存<strong>可复用的主题定义</strong>。在此改版只会影响<strong>之后新建</strong>的项目；已经开始的项目持有自己的方案快照，不会被改动。</p>

        <div class="library-layout">
          <aside class="library-sidebar">
            <div class="inline-input">
              <input class="native-input" placeholder="新方案名称" value={newSchemeName()} onInput={(event) => setNewSchemeName(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && createScheme()} />
              <button class="button primary" disabled={!newSchemeName().trim()} onClick={createScheme}>新建</button>
            </div>
            <For each={schemes()}>{(scheme) => (
              <button class="library-scheme" classList={{ active: selected()?.id === scheme.id }} onClick={() => { setSelectedId(scheme.id); setConfirmDeleteScheme(false); }}>
                <strong>{scheme.name}</strong>
                <span>{scheme.themes.length} 主题 · r{scheme.revision}</span>
              </button>
            )}</For>
          </aside>

          <div class="library-main">
            <Show when={selected()} fallback={<div class="empty-state">先在左侧新建一个共享方案。</div>}>
              {(scheme) => <>
                <div class="library-scheme-head">
                  <div class="inline-input">
                    <input class="native-input" value={scheme().name} onChange={(event) => props.store.renameScheme(scheme().id, event.currentTarget.value)} />
                    <Show when={confirmDeleteScheme()} fallback={
                      <button class="button secondary danger-text" onClick={() => setConfirmDeleteScheme(true)}>删除方案</button>
                    }>
                      <button class="button danger" onClick={() => { props.store.deleteScheme(scheme().id); setConfirmDeleteScheme(false); }}>确认删除</button>
                    </Show>
                  </div>
                  <small>当前修订 r{scheme().revision} · {new Date(scheme().updatedAt).toLocaleString('zh-CN')} · 改版不影响已建项目</small>
                </div>

                <div class="library-add-theme">
                  <select class="native-select" value={newThemeParent()} onChange={(event) => setNewThemeParent(event.currentTarget.value)}>
                    <option value="">作为一级主题</option>
                    <For each={ordered()}>{(theme) => <option value={theme.id}>{'　'.repeat(theme.depth)}└ {theme.name}</option>}</For>
                  </select>
                  <input class="native-input" placeholder="新主题名称" value={newThemeName()} onInput={(event) => setNewThemeName(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && addTheme()} />
                  <button class="button primary" disabled={!newThemeName().trim()} onClick={addTheme}>添加主题</button>
                </div>

                <div class="library-theme-list">
                  <For each={ordered()} fallback={<div class="empty-state">该方案暂无主题。</div>}>{(row) => {
                    const theme = () => scheme().themes.find((item) => item.id === row.id)!;
                    return (
                      <div class="library-theme-row" style={{ '--depth': row.depth }}>
                        <div class="library-theme-title">
                          <span class="theme-color" style={{ background: row.color }} />
                          <input class="native-input library-theme-name" value={row.name} onBlur={(event) => event.currentTarget.value.trim() !== row.name && props.store.updateSchemeTheme(scheme().id, row.id, { name: event.currentTarget.value.trim() })} />
                          <button class="icon-text danger-text" title="从库中删除该主题（不影响已建项目）" onClick={() => props.store.deleteSchemeTheme(scheme().id, row.id)}>×</button>
                        </div>
                        <textarea class="native-textarea" value={theme().definition} placeholder="操作定义" onBlur={(event) => event.currentTarget.value !== theme().definition && props.store.updateSchemeTheme(scheme().id, row.id, { definition: event.currentTarget.value })} />
                      </div>
                    );
                  }}</For>
                </div>
              </>}</Show>
          </div>
        </div>
        <footer><button class="button primary" onClick={props.onClose}>完成</button></footer>
      </section>
    </div>
  );
}

/* ============ 本地调整回写共享方案：先列差异 ============ */
export function WriteBackDialog(props: { store: CodingStore; open: boolean; onClose: () => void }) {
  const diff = createMemo(() => props.store.computeWriteBackDiff());
  const initial = () => new Set(diff().filter((change) => change.type !== 'removed' || change.required).map((change) => change.themeId));
  const [checked, setChecked] = createSignal<Set<string>>(initial());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  const sourceScheme = () => props.store.sourceScheme();
  const libraryChanged = () => {
    const source = sourceScheme();
    return !!source && source.revision !== props.store.state.snapshotSchemeRevision;
  };

  const toggle = (change: ThemeChange) => {
    if (change.required) return;
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(change.themeId)) next.delete(change.themeId);
      else next.add(change.themeId);
      return next;
    });
  };

  const counts = () => ({
    added: diff().filter((change) => change.type === 'added' && checked().has(change.themeId)).length,
    changed: diff().filter((change) => change.type === 'changed' && checked().has(change.themeId)).length,
    removed: diff().filter((change) => change.type === 'removed' && checked().has(change.themeId)).length
  });

  const submit = async () => {
    const selected = diff().filter((change) => checked().has(change.themeId));
    if (!selected.length || busy()) return;
    setBusy(true);
    setError('');
    const result = await props.store.writeBackToScheme(selected);
    setBusy(false);
    if (result === 'error' || result === 'stale') {
      setError(result === 'stale' ? '方案库刚刚被其他标签页更新，请先处理冲突后重试。' : '回写失败，已保留检查点，可在顶部横幅重试，主题不会重复。');
      return;
    }
    props.onClose();
  };

  const typeLabel = (type: ThemeChange['type']) => type === 'added' ? '新增' : type === 'changed' ? '修改' : '移除';

  // 每次打开对话框时按最新差异重置勾选状态（组件常驻挂载）。
  createEffect(() => {
    if (!props.open) return;
    const current = diff();
    setChecked(new Set(current.filter((change) => change.type !== 'removed' || change.required).map((change) => change.themeId)));
    setError('');
    setBusy(false);
  });

  return (
    <div class="modal-backdrop" classList={{ hidden: !props.open }} onClick={props.onClose}>
      <section class="modal-card wide" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <header><div><span class="eyebrow">WRITE BACK</span><h2>回写差异到共享方案</h2></div><button class="modal-close" onClick={props.onClose}>×</button></header>
        <p class="modal-intro">
          以下是项目快照（{props.store.state.sourceSchemeName} · r{props.store.state.snapshotSchemeRevision}）与本地主题工作副本的差异。勾选要写回的内容后确认；<strong>不回写的调整只留在本项目</strong>。
        </p>
        <Show when={libraryChanged()}>
          <div class="warning-box">共享方案库中的“{sourceScheme()?.name}”已改版到 r{sourceScheme()?.revision}（本项目快照为 r{props.store.state.snapshotSchemeRevision}）。回写按当前库版本合并，不会降低库修订。</div>
        </Show>
        <div class="diff-summary">
          <span class="diff-tag added">待新增 {counts().added}</span>
          <span class="diff-tag changed">待修改 {counts().changed}</span>
          <span class="diff-tag removed">待移除 {counts().removed}</span>
        </div>
        <div class="diff-list">
          <For each={diff()} fallback={<div class="empty-state">本地主题与项目快照没有差异，无需回写。</div>}>{(change) => (
            <label class="diff-item" classList={{ [change.type]: true, disabled: !!change.required }}>
              <input type="checkbox" checked={checked().has(change.themeId)} disabled={change.required} onChange={() => toggle(change)} />
              <span class={`diff-tag ${change.type}`}>{typeLabel(change.type)}</span>
              <div>
                <strong>{change.name}{change.required ? <em>（新增子主题依赖，必选）</em> : ''}</strong>
                <Show when={change.type === 'changed'}><small>变更字段：{change.fields.join('、')}</small></Show>
                <Show when={change.type === 'removed'}><small>从共享方案移除；其子主题将提升为顶层。本项目内的主题与历史判断不受影响。</small></Show>
              </div>
            </label>
          )}</For>
        </div>
        <Show when={error()}><div class="disagreement" style={{ margin: '12px 0 0' }}>{error()}</div></Show>
        <footer><button class="button secondary" onClick={props.onClose}>取消</button><button class="button primary" disabled={!checked().size || busy()} onClick={submit}>{busy() ? '正在回写…' : `回写所选差异（${checked().size}）`}</button></footer>
      </section>
    </div>
  );
}

/* ============ 顶部状态横幅：保存失败 / 检查点 / 迁移提示 ============ */
export function SaveErrorBanner(props: { store: CodingStore }) {
  const checkpoint = () => props.store.pendingCheckpoint();
  const [resuming, setResuming] = createSignal(false);
  const [force, setForce] = createSignal(false);

  const retry = async () => {
    setResuming(true);
    const result = await props.store.resumePendingCheckpoint(force());
    setResuming(false);
    if (result === 'stale') setForce(true);
  };

  return (
    <>
      <Show when={checkpoint()}>
        {(cp) => (
          <div class="status-banner checkpoint" role="alert">
            <div>
              <strong>有一项操作未完成：{cp().label}</strong>
              <span>检查点已保存在浏览器本地。重试使用原操作的预分配 ID 与整记录覆盖，不会多出一套主题或项目。{force() ? '当前库已有更新：继续将以本检查点覆盖，请确认。' : ''}</span>
            </div>
            <div class="banner-actions">
              <button class="banner-btn" disabled={resuming()} onClick={() => void retry()}>{resuming() ? '重试中…' : force() ? '强制以检查点覆盖' : '从检查点重试'}</button>
              <button class="banner-btn ghost" onClick={() => void props.store.discardCheckpoint()}>放弃该操作</button>
            </div>
          </div>
        )}
      </Show>
      <Show when={props.store.saveError() && !checkpoint()}>
        <div class="status-banner error" role="alert">
          <div><strong>本地保存遇到问题</strong><span>{props.store.saveError()}</span></div>
          <div class="banner-actions"><button class="banner-btn" onClick={() => void props.store.retrySave()}>重试保存</button></div>
        </div>
      </Show>
      <Show when={props.store.migrationNotice()}>
        <div class="status-banner migrated" role="status">
          <div><strong>旧数据已迁移为默认研究项目</strong><span>原有转写、两位编码者判断、人员姓名和操作记录均已保留；原主题同时存入共享编码方案库，新项目的方案改版不会影响本项目。</span></div>
          <div class="banner-actions"><button class="banner-btn ghost" onClick={props.store.dismissMigrationNotice}>知道了</button></div>
        </div>
      </Show>
    </>
  );
}
