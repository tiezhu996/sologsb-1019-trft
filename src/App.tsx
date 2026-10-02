import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { AppBar, Button, Paper, Toolbar, Typography } from '@suid/material';
import TranscriptPanel from './components/TranscriptPanel';
import ThemeTree from './components/ThemeTree';
import Inspector from './components/Inspector';
import ImportDialog from './components/ImportDialog';
import { CreateThemeDialog, MergeThemeDialog, SplitThemeDialog } from './components/ThemeDialogs';
import { CodebookDialog, NewProjectDialog, PublishCodebookDialog, RenameProjectDialog } from './components/WorkspaceDialogs';
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
  const [renameOpen, setRenameOpen] = createSignal(false);
  const [codebookOpen, setCodebookOpen] = createSignal(false);
  const [publishOpen, setPublishOpen] = createSignal(false);

  const activeTranscriptTitle = () => store.state.transcripts.find((item) => item.id === store.state.activeTranscriptId)?.title;
  const activeSegments = createMemo(() => store.state.segments
    .filter((segment) => segment.transcriptId === store.state.activeTranscriptId)
    .sort((a, b) => a.order - b.order));
  const disagreementCount = createMemo(() => store.state.segments.filter((segment) => segment.assignments.A.join('|') !== segment.assignments.B.join('|')).length);
  const snapshotDiverged = () => store.codebookDiff().isEmpty === false;
  const activeCheckpoint = () => {
    const cp = store.checkpoint();
    return cp && cp.projectId === store.state.id ? cp : null;
  };

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
    if (editing) return;
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

  return (
    <div class="app-shell">
      <AppBar position="static" class="topbar">
        <Toolbar class="toolbar">
          <div class="brand">
            <div class="brand-mark">码</div>
            <div><Typography variant="h6" component="div">访谈主题编码台</Typography><span>INTERPRETIVE CODING WORKBENCH</span></div>
          </div>
          <div class="top-actions">
            <div class="save-state"><span classList={{ pulsing: !store.storageReady() }} />{store.remoteEnvelope() ? '检测到其他标签页修订' : store.storageReady() ? `已保存 · r${store.state.revision}` : '正在载入本地库'}</div>
            <Button color="inherit" size="small" disabled={!store.canUndo()} onClick={store.undo}>撤销</Button>
            <Button color="inherit" size="small" disabled={!store.canRedo()} onClick={store.redo}>重做</Button>
            <Button variant="outlined" color="inherit" size="small" onClick={() => setImportOpen(true)}>导入转写</Button>
            <Button variant="contained" color="secondary" size="small" onClick={() => store.downloadExport('json')}>导出编码</Button>
          </div>
        </Toolbar>
      </AppBar>

      <Show when={store.remoteEnvelope()}>
        {(remote) => (
          <div class="conflict-banner" role="alert">
            <div><strong>另一个标签页写入了较新的项目修订</strong><span>本地数据库修订 r{remote().revision}。系统没有自动覆盖任何数据，请明确选择保留哪一份。</span></div>
            <div><Button size="small" color="inherit" onClick={store.applyRemoteVersion}>载入其他标签页版本</Button><Button size="small" variant="contained" color="warning" onClick={store.keepLocalVersion}>保留本页并建立新修订</Button></div>
          </div>
        )}
      </Show>

      <Show when={store.remoteNotice()}>
        <div class="notice-banner" role="status">
          <span>{store.remoteNotice()}</span>
          <button class="icon-text" onClick={store.dismissRemoteNotice}>知道了</button>
        </div>
      </Show>

      <section class="workspace-bar">
        <div class="workspace-controls">
          <label class="workspace-select-label">研究项目
            <select class="native-select" value={store.state.id} onChange={(event) => void store.switchProject(event.currentTarget.value)}>
              <For each={store.projects()}>{(project) => <option value={project.id}>{project.name}</option>}</For>
            </select>
          </label>
          <Button size="small" variant="outlined" onClick={() => setNewProjectOpen(true)}>＋ 新项目</Button>
          <Button size="small" onClick={() => setRenameOpen(true)}>重命名</Button>
          <Button size="small" onClick={() => setCodebookOpen(true)}>共享方案库</Button>
          <Button size="small" classList={{ 'publish-armed': snapshotDiverged() }} onClick={() => setPublishOpen(true)}>回写方案库</Button>
        </div>
        <div class="snapshot-badge">
          方案快照 v{store.state.codebookVersion}
          <Show when={store.codebook().version > store.state.codebookVersion}><span class="badge-muted">（库已至 v{store.codebook().version}）</span></Show>
          <Show when={snapshotDiverged()}><span class="badge-warn">本地有调整</span></Show>
        </div>
      </section>

      <Show when={activeCheckpoint()}>
        {(cp) => (
          <div class="checkpoint-banner" role="alert">
            <div>
              <strong>方案回写在写入过程中中断</strong>
              <span>检查点已保留，目标版本 v{cp().newCodebookVersion}。重试不会产生重复主题；也可以放弃并恢复回写前的项目。</span>
            </div>
            <div class="button-row">
              <Button size="small" color="inherit" onClick={() => setPublishOpen(true)}>处理检查点</Button>
            </div>
          </div>
        )}
      </Show>

      <section class="project-strip">
        <div><span class="eyebrow">CODING PROJECT</span><h1>{activeTranscriptTitle() ?? store.state.name}</h1></div>
        <div class="project-metrics">
          <div><strong>{store.state.segments.length}</strong><span>转写片段</span></div>
          <div><strong>{store.state.themes.length}</strong><span>层级主题</span></div>
          <div><strong>{disagreementCount()}</strong><span>编码分歧</span></div>
          <div><strong>{store.state.revision}</strong><span>本地修订</span></div>
        </div>
      </section>

      <main class="workspace-grid">
        <TranscriptPanel store={store} onRequestImport={() => setImportOpen(true)} />
        <ThemeTree store={store} onCreate={(parentId) => { setCreateParent(parentId); setCreateOpen(true); }} onMerge={() => setMergeOpen(true)} onSplit={() => setSplitOpen(true)} onPublish={() => setPublishOpen(true)} />
        <Inspector store={store} />
      </main>

      <section class="lower-grid">
        <Paper class="panel codebook-health-panel" elevation={0}>
          <div class="panel-heading"><div><span class="eyebrow">CODEBOOK HEALTH</span><h3>编码册质量检查</h3></div></div>
          <div class="health-grid">
            <div class="health-item"><strong>{store.state.segments.filter((segment) => !segment.assignments.A.length && !segment.assignments.B.length).length}</strong><span>未编码片段</span><small>可批量选择后重新编码</small></div>
            <div class="health-item"><strong>{store.state.themes.filter((theme) => !theme.definition).length}</strong><span>缺少定义的主题</span><small>定义会帮助后续编码保持一致</small></div>
            <div class="health-item"><strong>{disagreementCount()}</strong><span>双编码分歧</span><small>使用双人比较逐条处理</small></div>
          </div>
        </Paper>
        <Paper class="panel export-panel" elevation={0}>
          <div class="panel-heading"><div><span class="eyebrow">EXPORT & BACKUP</span><h3>研究数据出口</h3></div></div>
          <p>导出包含本项目方案快照、完整主题路径、双编码者判断、备忘录、主题示例和审计记录。CSV 适合表格复核，JSON 可完整回档。</p>
          <div class="button-row"><Button variant="contained" onClick={() => store.downloadExport('json')}>下载 JSON 完整包</Button><Button variant="outlined" onClick={() => store.downloadExport('csv')}>下载 CSV 编码表</Button></div>
        </Paper>
      </section>

      <footer class="app-footer">
        <span>快捷键 J / K 切换片段 · 1–9 选择主题 · Alt+A / Alt+B 编码 · Ctrl+Z 撤销 · ? 查看帮助</span>
        <span>工作区与共享方案库分离保存 · IndexedDB 本地保存 · 多标签页显式冲突处理</span>
      </footer>

      <ImportDialog open={importOpen()} onClose={() => setImportOpen(false)} onImport={store.importTranscript} />
      <CreateThemeDialog store={store} open={createOpen()} parentId={createParent()} onClose={() => { setCreateOpen(false); setCreateParent(undefined); }} />
      <MergeThemeDialog store={store} open={mergeOpen()} onClose={() => setMergeOpen(false)} />
      <SplitThemeDialog store={store} open={splitOpen()} onClose={() => setSplitOpen(false)} />
      <NewProjectDialog store={store} open={newProjectOpen()} onClose={() => setNewProjectOpen(false)} />
      <RenameProjectDialog store={store} open={renameOpen()} onClose={() => setRenameOpen(false)} />
      <CodebookDialog store={store} open={codebookOpen()} onClose={() => setCodebookOpen(false)} onPublish={() => { setCodebookOpen(false); setPublishOpen(true); }} />
      <PublishCodebookDialog store={store} open={publishOpen()} onClose={() => setPublishOpen(false)} />

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
