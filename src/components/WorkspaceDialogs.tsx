import { For, Show, createMemo, createSignal } from 'solid-js';
import type { useCodingStore } from '../store/coding-store';
import { buildTreeOrder, type CodebookDiff } from '../utils/codebook';

type Store = ReturnType<typeof useCodingStore>;

const DialogShell = (props: { wide?: boolean; eyebrow: string; title: string; onClose: () => void; children: unknown }) => (
  <div class="modal-backdrop" onClick={props.onClose}>
    <section class="modal-card" classList={{ wide: props.wide }} onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
      <header><div><span class="eyebrow">{props.eyebrow}</span><h2>{props.title}</h2></div><button class="modal-close" onClick={props.onClose}>×</button></header>
      {props.children as never}
    </section>
  </div>
);

export function NewProjectDialog(props: { store: Store; open: boolean; onClose: () => void }) {
  const [name, setName] = createSignal('');
  const library = () => props.store.codebook();
  const submit = () => {
    if (!name().trim()) return;
    void props.store.createProject(name()).then(() => {
      setName('');
      props.onClose();
    });
  };
  return (
    <Show when={props.open}>
      <DialogShell eyebrow="NEW WORKSPACE" title="新建研究项目" onClose={props.onClose}>
        <p class="modal-intro">新项目会<strong>复制一份当前共享编码方案的快照</strong>（{library().themes.length} 个主题，v{library().version}）。此后在本项目内增删改主题只影响本项目；共享方案将来改版也不会改动已开始的项目。</p>
        <label class="field-label">项目名称
          <input autofocus class="native-input full" value={name()} onInput={(event) => setName(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && submit()} placeholder={`例如：${new Date().getFullYear()} 教师访谈系列`} />
        </label>
        <footer><button class="button secondary" onClick={props.onClose}>取消</button><button class="button primary" onClick={submit}>复制方案并创建</button></footer>
      </DialogShell>
    </Show>
  );
}

export function RenameProjectDialog(props: { store: Store; open: boolean; onClose: () => void }) {
  const [name, setName] = createSignal(props.store.state.name);
  const submit = () => {
    props.store.renameProject(name());
    props.onClose();
  };
  return (
    <Show when={props.open}>
      <DialogShell eyebrow="WORKSPACE" title="重命名研究项目" onClose={props.onClose}>
        <label class="field-label">项目名称
          <input autofocus class="native-input full" value={name()} onInput={(event) => setName(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && submit()} />
        </label>
        <footer><button class="button secondary" onClick={props.onClose}>取消</button><button class="button primary" disabled={!name().trim() || name().trim() === props.store.state.name} onClick={submit}>保存</button></footer>
      </DialogShell>
    </Show>
  );
}

export function CodebookDialog(props: { store: Store; open: boolean; onClose: () => void; onPublish: () => void }) {
  const library = () => props.store.codebook();
  const ordered = createMemo(() => buildTreeOrder(library().themes));
  const projectVersion = () => props.store.state.codebookVersion;
  return (
    <Show when={props.open}>
      <DialogShell wide eyebrow="SHARED CODEBOOK" title="共享编码方案库" onClose={props.onClose}>
        <p class="modal-intro">方案库保存可复用的主题定义。每个新项目在立项时复制快照，因此<strong>方案改版不会动到已开始的项目</strong>；项目里打磨成熟的本地调整，可经差异确认后回写为新版本。</p>
        <div class="codebook-meta">
          <div><strong>{library().name}</strong><span>当前版本 v{library().version} · 更新于 {new Date(library().updatedAt).toLocaleString('zh-CN')}</span></div>
          <div><strong>{library().themes.length}</strong><span>个主题</span></div>
          <div><strong>v{projectVersion()}</strong><span>当前项目快照{library().version > projectVersion() ? '（库已有新版）' : '（与库同版）'}</span></div>
        </div>
        <div class="codebook-theme-list">
          <For each={ordered()}>{(theme) => <div class="codebook-theme-row"><span class="theme-color" style={{ background: theme.color }} />{theme.name}</div>}</For>
        </div>
        <div class="project-version-list">
          <span class="eyebrow">PROJECT SNAPSHOTS</span>
          <For each={props.store.projects()}>{(project) => (
            <div><strong>{project.name}</strong><span>快照 v{project.codebookVersion} · {project.segments.length} 段 · {project.transcripts.length} 份转写</span></div>
          )}</For>
        </div>
        <footer><button class="button secondary" onClick={props.onClose}>关闭</button><button class="button primary" onClick={props.onPublish}>回写当前项目的调整…</button></footer>
      </DialogShell>
    </Show>
  );
}

const DiffSection = (props: { title: string; tone: 'add' | 'remove' | 'change'; entries: CodebookDiff['added']; renderFields?: boolean }) => (
  <Show when={props.entries.length}>
    <div class={`diff-section ${props.tone}`}>
      <div class="diff-section-title">{props.title}（{props.entries.length}）</div>
      <For each={props.entries}>{(entry) => (
        <div class="diff-entry">
          <strong>{entry.name}</strong>
          <Show when={props.renderFields}>
            <For each={entry.fields}>{(field) => (
              <div class="diff-field"><span>{field.field}</span><div><del>{field.before}</del><ins>{field.after}</ins></div></div>
            )}</For>
          </Show>
        </div>
      )}</For>
    </div>
  </Show>
);

export function PublishCodebookDialog(props: { store: Store; open: boolean; onClose: () => void }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const diff = createMemo(() => props.store.codebookDiff());
  const cp = () => {
    const current = props.store.checkpoint();
    return current && current.projectId === props.store.state.id ? current : null;
  };
  const otherCheckpoint = () => {
    const current = props.store.checkpoint();
    return current && current.projectId !== props.store.state.id ? current : null;
  };
  const libraryAhead = () => props.store.codebook().version > props.store.state.codebookVersion;

  const runCommit = async (checkpoint: NonNullable<ReturnType<typeof cp>>) => {
    setBusy(true);
    setError('');
    try {
      await props.store.commitPublish(checkpoint);
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '写入失败，可从检查点重试');
    } finally {
      setBusy(false);
    }
  };

  const prepare = async () => {
    setBusy(true);
    setError('');
    try {
      const checkpoint = await props.store.preparePublish();
      await runCommit(checkpoint);
    } catch (err) {
      setError(err instanceof Error ? err.message : '写入检查点失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  const abort = async () => {
    const current = cp();
    if (!current) return;
    setBusy(true);
    try {
      await props.store.abortPublish(current);
      setError('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={props.open}>
      <DialogShell wide eyebrow="PUBLISH CODEBOOK" title="把本项目调整回写共享方案库" onClose={props.onClose}>
        <Show when={cp()} fallback={
          <>
            <p class="modal-intro">回写会先记录检查点，再把当前项目的主题快照发布为共享方案库的新版本。<strong>已开始的其他项目继续使用各自的旧快照，不受影响。</strong></p>
            <Show when={libraryAhead()}>
              <div class="warning-box">共享方案库已是 v{props.store.codebook().version}，本项目基于 v{props.store.state.codebookVersion} 的快照。继续回写将以本项目当前的主题整体成为新版本；如需先吸收库中新版的改动，请放弃并另建项目处理。</div>
            </Show>
            <Show when={otherCheckpoint()}>
              <div class="warning-box">另一个项目存在未完成的方案回写检查点，请先在该项目中重试或放弃。</div>
            </Show>
            <div class="diff-overview">
              <span class="diff-count add">新增 {diff().added.length}</span>
              <span class="diff-count change">变更 {diff().changed.length}</span>
              <span class="diff-count remove">删除 {diff().removed.length}</span>
            </div>
            <div class="diff-scroll">
              <DiffSection tone="add" title="项目中有、方案库没有的主题（将加入方案库）" entries={diff().added} />
              <DiffSection tone="change" title="字段或层级有变化的主题" entries={diff().changed} renderFields />
              <DiffSection tone="remove" title="方案库有、项目中已删除的主题（将从方案库删除）" entries={diff().removed} />
              <Show when={diff().isEmpty}><div class="empty-state">当前项目快照与共享方案库完全一致，没有需要回写的差异。</div></Show>
            </div>
            <Show when={error()}><div class="disagreement">{error()}</div></Show>
            <footer>
              <button class="button secondary" onClick={props.onClose}>取消</button>
              <button class="button primary" disabled={busy() || diff().isEmpty || !!otherCheckpoint()} onClick={prepare}>
                {busy() ? '正在写入…' : `差异无误，发布为 v${props.store.codebook().version + 1}`}
              </button>
            </footer>
          </>
        }>
          {(checkpoint) => (
            <>
              <div class="warning-box">
                上次回写在写入过程中中断，检查点已保留（目标版本 v{checkpoint().newCodebookVersion}）。
                重试会按同一批主题 id 覆盖写入，<strong>不会产生重复的一套主题</strong>；也可以放弃回写，恢复到回写前的项目快照。
              </div>
              <Show when={error()}><div class="disagreement">{error()}</div></Show>
              <footer>
                <button class="button secondary" disabled={busy()} onClick={abort}>放弃并恢复</button>
                <button class="button primary" disabled={busy()} onClick={() => void runCommit(checkpoint())}>{busy() ? '正在重试…' : '从检查点重试'}</button>
              </footer>
            </>
          )}
        </Show>
      </DialogShell>
    </Show>
  );
}
