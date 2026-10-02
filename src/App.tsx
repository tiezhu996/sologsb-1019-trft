import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { AppBar, Button, Chip, Paper, Toolbar, Typography } from '@suid/material';
import TranscriptPanel from './components/TranscriptPanel';
import ThemeTree from './components/ThemeTree';
import Inspector from './components/Inspector';
import ImportDialog from './components/ImportDialog';
import { CreateThemeDialog, MergeThemeDialog, SplitThemeDialog } from './components/ThemeDialogs';
import { NewProjectDialog, ProjectMenuDialog, SaveErrorBanner, SchemeLibraryDialog, WriteBackDialog } from './components/ProjectDialogs';
import { useCodingStore } from './store/coding-store';

export default function App() {
  const store = useCodingStore();
  const [importOpen, setImportOpen] = createSignal(false);
  const [createOpen, setCreateOpen] = createSignal(false);
  const [createParent, setCreateParent] = createSignal<string | undefined>();
  const [mergeOpen, setMergeOpen] = createSignal(false);
  const [splitOpen, setSplitOpen] = createSignal(false);
  const [shortcutsOpen, setShortcutsOpen] = createSignal(false);
  const [newProjectOpen, setNewProjectOpen] = createSignal(false);
  const [projectsOpen, setProjectsOpen] = createSignal(false);
  const [libraryOpen, setLibraryOpen] = createSignal(false);
  const [writeBackOpen, setWriteBackOpen] = createSignal(false);

  const hasProject = createMemo(() => !!store.registry.projects.some((item) => item.id === store.state.id));
  const diffCount = createMemo(() => (hasProject() ? store.computeWriteBackDiff().length : 0));
  const sourceScheme = createMemo(() => store.sourceScheme());

  const activeSegments = createMemo(() => store.state.segments
    .filter((segment) => segment.transcriptId === store.state.activeTranscriptId)
    .sort((a, b) => a.order - b.order));

  const moveSegment = (delta: number) => {
    const segments = activeSegments();
    const index = segments.findIndex((segment) => segment.id === store.state.activeSegmentId);
    const next = segments[Math.max(0, Math.min(segments.length - 1, index + delta))];
    if (next) {
      store.selectSegment(next.id);
      document.querySelector('.segment-card.active')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const handleKeys = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    const editing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? store.redo() : store.undo();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      store.redo();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      store.downloadExport('json');
      return;
    }
    if (editing || !hasProject()) return;
    if (event.key.toLowerCase() === 'j') { event.preventDefault(); moveSegment(1); }
    if (event.key.toLowerCase() === 'k') { event.preventDefault(); moveSegment(-1); }
    if (event.key === '/') {
      event.preventDefault();
      document.querySelector<HTMLInputElement>('.transcript-panel .native-input')?.focus();
    }
    if (event.key === '?') setShortcutsOpen((open) => !open);
    if (/^[1-9]$/.test(event.key)) {
      const theme = store.orderedThemes()[Number(event.key) - 1];
      if (theme) store.selectTheme(theme.id);
    }
    if (event.altKey && event.key.toLowerCase() === 'a' && store.state.activeThemeId) {
      event.preventDefault();
      store.toggleAssignment(store.state.activeSegmentId, 'A', store.state.activeThemeId, true);
    }
    if (event.altKey && event.key.toLowerCase() === 'b' && store.state.activeThemeId) {
      event.preventDefault();
      store.toggleAssignment(store.state.activeSegmentId, 'B', store.state.activeThemeId, true);
    }
  };

  onMount(() => {
    void store.initialize();
    window.addEventListener('keydown', handleKeys);
  });
  onCleanup(() => window.removeEventListener('keydown', handleKeys));

  const conflictLabel = () => {
    const incoming = store.remoteEnvelope();
    if (!incoming) return '';
    if (incoming.key === 'library') return '共享方案库';
    if (incoming.key === 'registry') return '项目清单';
    return '当前研究项目';
  };

  return (
    <div class="app-shell">
      <AppBar position="static" class="topbar">
        <Toolbar class="toolbar">
          <div class="brand">
            <div class="brand-mark">码</div>
            <div><Typography variant="h6" component="div">访谈主题编码台</Typography><span>PROJECT WORKSPACE · SHARED CODE LIBRARY</span></div>
          </div>
          <div class="top-actions">
            <select
              class="topbar-select"
              aria-label="切换研究项目"
              value={store.state.id}
              onChange={(event) => void store.switchProject(event.currentTarget.value)}
            >
              <For each={store.registry.projects}>{(meta) => <option value={meta.id}>{meta.name}</option>}</For>
            </select>
            <Button color="inherit" size="small" onClick={() => setNewProjectOpen(true)}>＋ 新项目</Button>
            <Button color="inherit" size="small" onClick={() => setLibraryOpen(true)}>方案库</Button>
            <Button color="inherit" size="small" onClick={() => setProjectsOpen(true)}>管理</Button>
            <div class="save-state"><span classList={{ pulsing: !store.storageReady() }} />{store.remoteEnvelope() ? '检测到其他标签页修订' : store.storageReady() ? `已保存 · r${store.state.revision}` : '正在载入本地库'}</div>
            <Button color="inherit" size="small" disabled={!store.canUndo()} onClick={store.undo}>撤销</Button>
            <Button color="inherit" size="small" disabled={!store.canRedo()} onClick={store.redo}>重做</Button>
          </div>
        </Toolbar>
      </AppBar>

      <SaveErrorBanner store={store} />

      <Show when={store.remoteEnvelope()}>
        {(remote) => (
          <div class="conflict-banner" role="alert">
            <div><strong>另一个标签页写入了较新的“{conflictLabel()}”版本（r{remote().revision}）</strong><span>系统没有自动覆盖任何数据，请明确选择保留哪一份。</span></div>
            <div><Button size="small" color="inherit" onClick={store.applyRemoteVersion}>载入其他标签页版本</Button><Button size="small" variant="contained" color="warning" onClick={store.keepLocalVersion}>保留本页并建立新修订</Button></div>
          </div>
        )}
      </Show>

      <Show when={!store.registry.projects.length && store.storageReady()} fallback={
        <>
          <section class="project-strip">
            <div>
              <span class="eyebrow">CODING PROJECT · 独立工作区</span>
              <h1>{store.state.name}</h1>
              <div class="project-scheme-line">
                <Chip size="small" label={`方案快照：${store.state.sourceSchemeName} · r${store.state.snapshotSchemeRevision}`} />
                <Show when={sourceScheme() && sourceScheme()!.revision !== store.state.snapshotSchemeRevision}>
                  <Chip size="small" color="warning" label={`库方案已改版至 r${sourceScheme()!.revision}（不影响本项目）`} />
                </Show>
                <Button size="small" onClick={() => setWriteBackOpen(true)}>本地调整回写方案库</Button>
                <Show when={diffCount()}><span class="writeback-count">{diffCount()} 项差异待处理</span></Show>
              </div>
              <div class="coder-line">
                <label>编码者 A<input class="native-input" value={store.state.coderA} onInput={(event) => store.setCoder('A', event.currentTarget.value)} /></label>
                <label>编码者 B<input class="native-input" value={store.state.coderB} onInput={(event) => store.setCoder('B', event.currentTarget.value)} /></label>
              </div>
            </div>
            <div class="project-metrics">
              <div><strong>{store.state.segments.length}</strong><span>转写片段</span></div>
              <div><strong>{store.state.themes.length}</strong><span>本项目主题</span></div>
              <div><strong>{store.state.segments.filter((segment) => segment.assignments.A.join('|') !== segment.assignments.B.join('|')).length}</strong><span>编码分歧</span></div>
              <div><strong>{store.state.revision}</strong><span>本地修订</span></div>
            </div>
            <div class="strip-actions">
              <Button variant="outlined" color="primary" size="small" onClick={() => setImportOpen(true)}>导入转写</Button>
              <Button variant="contained" color="secondary" size="small" onClick={() => store.downloadExport('json')}>导出编码</Button>
            </div>
          </section>

          <main class="workspace-grid">
            <TranscriptPanel store={store} />
            <ThemeTree store={store} onCreate={(parentId) => { setCreateParent(parentId); setCreateOpen(true); }} onMerge={() => setMergeOpen(true)} onSplit={() => setSplitOpen(true)} />
            <Inspector store={store} />
          </main>

          <section class="lower-grid">
            <Paper class="panel codebook-panel" elevation={0}>
              <div class="panel-heading"><div><span class="eyebrow">CODEBOOK HEALTH</span><h3>编码册质量检查（本项目）</h3></div><Chip label="实时" size="small" /></div>
              <div class="health-grid">
                <div class="health-item"><strong>{store.state.segments.filter((segment) => !segment.assignments.A.length && !segment.assignments.B.length).length}</strong><span>未编码片段</span><small>可批量选择后重新编码</small></div>
                <div class="health-item"><strong>{store.state.themes.filter((theme) => !theme.definition).length}</strong><span>缺少定义的主题</span><small>定义会帮助后续编码保持一致</small></div>
                <div class="health-item"><strong>{store.state.segments.filter((segment) => segment.assignments.A.join('|') !== segment.assignments.B.join('|')).length}</strong><span>双编码分歧</span><small>使用双人比较逐条处理</small></div>
              </div>
            </Paper>
            <Paper class="panel export-panel" elevation={0}>
              <div class="panel-heading"><div><span class="eyebrow">EXPORT & BACKUP</span><h3>研究数据出口</h3></div></div>
              <p>导出包含项目方案快照、完整主题路径、双编码者判断、备忘录、主题示例和审计记录。CSV 适合表格复核，JSON 可完整回档。</p>
              <div class="button-row"><Button variant="contained" onClick={() => store.downloadExport('json')}>下载 JSON 完整包</Button><Button variant="outlined" onClick={() => store.downloadExport('csv')}>下载 CSV 编码表</Button></div>
            </Paper>
          </section>
        </>
      }>
        <section class="empty-workspace">
          <div class="empty-card">
            <span class="eyebrow">NO OPEN PROJECT</span>
            <h2>从共享编码方案开始一个新研究项目</h2>
            <p>研究项目工作区与共享编码方案库是分开的：项目保存本项目的转写、两位编码者的判断和审计记录；方案库保存可复用的主题定义。新建项目会复制一份方案快照，之后方案改版不会影响已开始的项目。</p>
            <div class="button-row" style={{ 'justify-content': 'center' }}>
              <Button variant="contained" onClick={() => setNewProjectOpen(true)}>＋ 新建研究项目</Button>
              <Button variant="outlined" onClick={() => setLibraryOpen(true)}>打开共享方案库</Button>
            </div>
          </div>
        </section>
      </Show>

      <footer class="app-footer">
        <span>快捷键 J / K 切换片段 · 1–9 选择主题 · Alt+A / Alt+B 编码 · Ctrl+Z 撤销 · ? 查看帮助</span>
        <span>IndexedDB 本地保存 · 项目与方案库分开存储 · 多标签页显式冲突处理</span>
      </footer>

      <ImportDialog open={importOpen()} onClose={() => setImportOpen(false)} onImport={store.importTranscript} />
      <CreateThemeDialog store={store} open={createOpen()} parentId={createParent()} onClose={() => { setCreateOpen(false); setCreateParent(undefined); }} />
      <MergeThemeDialog store={store} open={mergeOpen()} onClose={() => setMergeOpen(false)} />
      <SplitThemeDialog store={store} open={splitOpen()} onClose={() => setSplitOpen(false)} />
      <NewProjectDialog store={store} open={newProjectOpen()} onClose={() => setNewProjectOpen(false)} />
      <ProjectMenuDialog store={store} open={projectsOpen()} onClose={() => setProjectsOpen(false)} />
      <SchemeLibraryDialog store={store} open={libraryOpen()} onClose={() => setLibraryOpen(false)} />
      <WriteBackDialog store={store} open={writeBackOpen()} onClose={() => setWriteBackOpen(false)} />

      <div class="modal-backdrop" classList={{ hidden: !shortcutsOpen() }} onClick={() => setShortcutsOpen(false)}>
        <section class="modal-card" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
          <header><div><span class="eyebrow">KEYBOARD</span><h2>键盘操作</h2></div><button class="modal-close" onClick={() => setShortcutsOpen(false)}>×</button></header>
          <div class="shortcut-list">
            <For each={[['J / K', '下一条 / 上一条片段'], ['1–9', '选择主题树中的主题'], ['Alt+A / Alt+B', '将当前主题分配给编码者'], ['/', '聚焦正文搜索'], ['Ctrl+Z / Ctrl+Y', '撤销 / 重做'], ['Ctrl+E', '导出 JSON'], ['?', '显示或隐藏此面板']]}>{([key, text]) => <div><kbd>{key}</kbd><span>{text}</span></div>}</For>
          </div>
        </section>
      </div>
    </div>
  );
}
