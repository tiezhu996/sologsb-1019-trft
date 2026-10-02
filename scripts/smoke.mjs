/* 冒烟测试：内存 IndexedDB/localStorage 桩，验证工作区/方案库分离的关键行为。
 * 运行：node scripts/smoke.mjs
 */
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------- 最小内存 IndexedDB 桩 ----------
class FakeRequest {
  constructor(result) { this.result = result; queueMicrotask(() => { this.onsuccess?.(); }); }
}
class FakeTx {
  constructor(db) { this.db = db; }
  objectStore(name) {
    const map = this.db.data.get(name);
    return {
      get: (key) => new FakeRequest(structuredClone(map.get(key))),
      put: (value, key) => { map.set(key, structuredClone(value)); return new FakeRequest(value); },
      delete: (key) => { map.delete(key); return new FakeRequest(undefined); }
    };
  }
  get oncomplete() { return this._oncomplete; }
  set oncomplete(fn) { this._oncomplete = fn; queueMicrotask(() => fn()); }
  get onerror() { return this._onerror; }
  set onerror(fn) { this._onerror = fn; }
}
const dbs = new Map();
globalThis.indexedDB = {
  open(name) {
    const req = { result: undefined, onsuccess: null, onerror: null, onupgradeneeded: null };
    queueMicrotask(() => {
      if (!dbs.has(name)) {
        const data = new Map();
        ['snapshots', 'projects', 'codebook', 'meta', 'checkpoint'].forEach((n) => data.set(n, new Map()));
        dbs.set(name, { name, data, objectStoreNames: { contains: (n) => data.has(n) }, transaction: () => new FakeTx(dbs.get(name)), close() {} });
        req.result = dbs.get(name);
        req.onupgradeneeded?.();
        req.onsuccess?.();
      } else {
        req.result = dbs.get(name);
        req.onsuccess?.();
      }
    });
    return req;
  }
};

// localStorage 桩
const lsData = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsData.has(k) ? lsData.get(k) : null),
  setItem: (k, v) => lsData.set(k, String(v)),
  removeItem: (k) => lsData.delete(k)
};
let counter = 1;
if (!globalThis.crypto) globalThis.crypto = {};
globalThis.crypto.randomUUID = () => `id-${Math.random().toString(36).slice(2)}-${counter++}`;
class FakeBC { postMessage() {} close() {} }
globalThis.BroadcastChannel = FakeBC;
globalThis.window = { setTimeout, clearTimeout, indexedDB: globalThis.indexedDB, BroadcastChannel: FakeBC };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 在模块求值（bootstrap）之前注入旧版 v1 数据 ----------
const legacy = {
  revision: 7, updatedAt: '2026-09-01T08:00:00.000Z',
  activeTranscriptId: 'tr-x', activeSegmentId: 's-x', activeThemeId: 't1',
  coderA: '王编码', coderB: '李编码',
  transcripts: [{ id: 'tr-x', title: '旧项目访谈', participant: '受访者', importedAt: '2026-08-01T00:00:00.000Z', sourceName: '旧文件' }],
  segments: [{ id: 's-x', transcriptId: 'tr-x', order: 0, speaker: '受访者', time: '00:01', text: '旧片段正文', assignments: { A: ['t1'], B: ['t1', 't2'] }, note: '旧备忘' }],
  themes: [
    { id: 't1', name: '旧主题一', parentId: null, color: '#000', definition: '定义一', memo: '', examples: [] },
    { id: 't2', name: '旧主题二', parentId: null, color: '#fff', definition: '', memo: '', examples: [] }
  ],
  audit: [{ id: 'a-old', at: '2026-09-01T08:00:00.000Z', action: '旧操作', detail: '旧审计' }]
};
lsData.set('sologsb-1019-state-v1', JSON.stringify(legacy));

// ---------- 打包并加载被测模块（加载即触发 bootstrap 迁移） ----------
const entry = join(mkdtempSync(join(tmpdir(), 'smoke-')), 'entry.ts');
writeFileSync(entry, `
export { useCodingStore } from '/workspace/src/store/coding-store.ts';
export { diffCodebook } from '/workspace/src/utils/codebook.ts';
`);
const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  external: ['solid-js', 'solid-js/store']
});
const outFile = join(process.cwd(), 'node_modules', `.smoke-${Date.now()}.mjs`);
writeFileSync(outFile, result.outputFiles[0].text);
const { useCodingStore } = await import(pathToFileURL(outFile).href);

let passed = 0;
const assert = (cond, message) => {
  if (!cond) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ✓ ${message}`);
};

// ---------- 场景 1：旧版数据迁移 ----------
console.log('场景 1：旧版单库数据首次打开迁移为默认项目');
{
  const store = useCodingStore();
  await store.initialize();
  await sleep(300);
  const s = store.state;
  assert(s.id === 'p-default', '迁移到默认项目');
  assert(s.name === '旧项目访谈', '项目名取自首份转写标题');
  assert(s.coderA === '王编码' && s.coderB === '李编码', '编码人员姓名保留');
  assert(s.segments.length === 1 && s.segments[0].assignments.B.join(',') === 't1,t2', '双编码者判断原样保留');
  assert(s.segments[0].note === '旧备忘', '片段备忘保留');
  assert(s.themes.length === 2 && s.themes[0].id === 't1', '只有原来一套主题，没有复制出第二套');
  assert(s.audit.some((a) => a.action === '数据迁移') && s.audit.some((a) => a.action === '旧操作'), '迁移记录与原有审计都在');
  assert(store.codebook().themes.length === 2, '共享方案库以迁移前主题为准');
  assert(localStorage.getItem('sologsb-1019-state-v1') === null, '旧版 localStorage 键已清理');
  assert(localStorage.getItem('sologsb-1019-projects-v2') !== null, 'v2 项目数据已写入 localStorage');
  assert(JSON.parse(localStorage.getItem('sologsb-1019-projects-v2'))[0].segments[0].text === '旧片段正文', 'v2 持久化内容正确');
}

// ---------- 场景 2：新项目快照隔离 ----------
console.log('场景 2：新项目复制方案快照，之后改版互不影响');
{
  const store = useCodingStore();
  const before = store.codebook().version;
  const newId = await store.createProject('新研究');
  await sleep(300);
  assert(store.state.id === newId, '切换到新项目');
  assert(store.state.themes.length === 2, '新项目复制了 2 个主题快照');
  assert(store.state.codebookVersion === before, `新项目记录快照版本 v${before}`);
  assert(store.state.segments.length === 0 && store.state.transcripts.length === 0, '新项目转写为空，不携带旧项目语料');
  assert(store.state.coderA === '编码者 A', '新项目使用默认编码者');

  // 新项目里改主题
  store.addTheme('项目专属主题', null);
  await sleep(300);
  assert(store.state.themes.length === 3, '项目内新增主题生效');
  assert(store.codebook().themes.length === 2, '共享库不受项目内新增影响');

  // 切回旧项目，旧项目不受影响
  store.switchProject('p-default');
  await sleep(300);
  assert(store.state.themes.length === 2, '旧项目仍是旧快照，没有混入新项目主题');
}

// ---------- 场景 3：差异计算与回写 ----------
console.log('场景 3：回写前差异 + 检查点发布 + 其他项目不动');
{
  const store = useCodingStore();
  store.switchProject('p-default');
  await sleep(300);
  // 三处本地调整：新增、修改、删除
  store.addTheme('本地新主题', null);
  await sleep(300);
  store.updateTheme('t1', { definition: '更新后的定义' }, '主题定义');
  await sleep(300);
  store.deleteTheme('t2');
  await sleep(300);

  const diff = store.codebookDiff();
  assert(diff.added.length === 1 && diff.added[0].name === '本地新主题', '差异识别新增主题');
  assert(diff.removed.length === 1 && diff.removed[0].themeId === 't2', '差异识别删除主题');
  assert(diff.changed.length === 1 && diff.changed[0].fields.some((f) => f.field === '操作定义'), '差异识别定义变更');
  assert(!diff.isEmpty, '差异非空');

  const cp = await store.preparePublish();
  assert(!!store.checkpoint(), '检查点在数据变更前落库');
  assert(cp.status === 'pending', '检查点为待提交状态');
  assert(cp.preProject.revision === store.state.revision, '检查点记录回写前项目');

  await store.commitPublish(cp);
  await sleep(300);
  const library = store.codebook();
  assert(library.version === 2, '共享库发布为 v2');
  assert(library.themes.length === 2 && library.themes.some((t) => t.name === '本地新主题'), '库主题为项目快照内容（无重复）');
  assert(store.state.codebookVersion === 2, '发布项目对齐到 v2');
  assert(store.state.audit[0].action === '回写共享方案库', '项目审计记录回写');
  assert(store.checkpoint() === null, '成功后检查点已清除');
  const ids = library.themes.map((t) => t.id);
  assert(new Set(ids).size === ids.length, '方案库没有重复主题 id');

  // 重复提交同一检查点：幂等，不产生第二套主题
  await store.commitPublish({ ...cp, status: 'committed' }).catch(() => undefined);
  await sleep(300);
  assert(store.codebook().version === 2 && store.codebook().themes.length === 2, '重复提交检查点幂等，不新增主题');

  // 新立项复制新版；v1 时期建立的“新研究”保持旧快照
  const v2ProjectId = await store.createProject('第三个项目');
  await sleep(300);
  assert(store.state.themes.length === 2 && store.state.themes.some((t) => t.name === '本地新主题'), '新立项项目复制 v2 快照');
  const v1ProjectId = store.projects().find((p) => p.name === '新研究').id;
  store.switchProject(v1ProjectId);
  await sleep(300);
  assert(store.state.themes.length === 3, 'v1 时期建立的项目仍保留自己的旧快照');
  assert(store.state.codebookVersion === 1, '旧项目快照版本号不变');
  void v2ProjectId;
}

// ---------- 场景 4：刷新后检查点恢复 ----------
console.log('场景 4：刷新后检查点恢复（已提交但收尾中断）');
{
  const cpRaw = JSON.parse(localStorage.getItem('sologsb-1019-checkpoint-v2') ?? 'null');
  assert(cpRaw === null, '前置：无活动检查点');
  const projects = JSON.parse(localStorage.getItem('sologsb-1019-projects-v2'));
  const target = projects.find((p) => p.id === 'p-default');
  target.codebookVersion = 1; // 伪装成尚未收尾
  localStorage.setItem('sologsb-1019-projects-v2', JSON.stringify(projects));
  const post = structuredClone(target);
  post.codebookVersion = 2;
  const pre = structuredClone(target);
  const cp = {
    id: 'cp-crash', projectId: 'p-default', createdAt: new Date().toISOString(), status: 'committed',
    baseCodebookVersion: 1, newCodebookVersion: 2, preProject: pre, postProject: post
  };
  localStorage.setItem('sologsb-1019-checkpoint-v2', JSON.stringify(cp));
  const meta = JSON.parse(localStorage.getItem('sologsb-1019-meta-v2'));
  meta.activeProjectId = 'p-default';
  localStorage.setItem('sologsb-1019-meta-v2', JSON.stringify(meta));

  // 重新加载模块，模拟一次全新页面引导
  const reloadFile = join(process.cwd(), 'node_modules', `.smoke-reload-${Date.now()}.mjs`);
  writeFileSync(reloadFile, result.outputFiles[0].text);
  const reloaded = await import(pathToFileURL(reloadFile).href + `?t=${Date.now()}`);
  const store = reloaded.useCodingStore();
  await store.initialize();
  await sleep(300);
  assert(store.state.codebookVersion === 2, '启动时自动完成已提交检查点的收尾');
  assert(store.checkpoint() === null, '恢复后检查点被清除');
  assert(store.codebook().version === 2, '方案库仍是 v2，没有多出主题');
  assert(store.state.coderA === '王编码', '迁移人员数据在恢复后仍然保留');
}

console.log(`\n全部通过：${passed} 项断言`);
