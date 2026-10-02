// 端到端逻辑验证：在 jsdom + fake-indexeddb 下直接驱动 store 与 db 层。
const { JSDOM } = require('jsdom');
const { IDBFactory, IDBKeyRange: FakeIDBKeyRange } = require('fake-indexeddb');

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Event = dom.window.Event;
globalThis.MessageEvent = dom.window.MessageEvent;
globalThis.BroadcastChannel = class { postMessage() {}; close() {} };
globalThis.IDBKeyRange = FakeIDBKeyRange;
globalThis.localStorage = dom.window.localStorage;
if (!globalThis.crypto) globalThis.crypto = require('node:crypto').webcrypto;
window.crypto = globalThis.crypto;

// 每个场景使用全新的 IDBFactory，模拟干净的浏览器存储
const resetIndexedDb = () => {
  globalThis.indexedDB = new IDBFactory();
  window.indexedDB = globalThis.indexedDB;
  window.IDBKeyRange = globalThis.IDBKeyRange;
};
resetIndexedDb();

const assert = require('node:assert/strict');

async function flush(ms = 260) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadStore() {
  const mod = require(require('path').resolve(__dirname, '../dist-test/store-bundle.cjs'));
  return mod.useCodingStore();
}

async function resetStorage() {
  resetIndexedDb();
  window.localStorage.clear();
  // 清空已打包 bundle 的模块缓存，使 store 单例重建
  delete require.cache[require.resolve(require('path').resolve(__dirname, '../dist-test/store-bundle.cjs'))];
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('场景 1：全新启动 — 方案库 + 默认项目快照');
  await resetStorage();
  let store = await loadStore();
  await store.initialize();
  await flush();
  await test('方案库内置一个演示方案', () => {
    assert.equal(store.library.schemes.length, 1);
    assert.equal(store.library.schemes[0].themes.length, 6);
  });
  await test('项目复制的快照与库是两份独立副本', () => {
    assert.equal(store.state.themes.length, 6);
    assert.notStrictEqual(store.state.themes, store.library.schemes[0].themes);
    assert.notEqual(store.state.themes[0], store.library.schemes[0].themes[0]);
  });

  console.log('场景 2：库方案改版不影响已开始的项目');
  const schemeId = store.library.schemes[0].id;
  const firstTheme = store.library.schemes[0].themes[0];
  store.addSchemeTheme(schemeId, '新增的库主题（不应出现在项目）', null);
  store.updateSchemeTheme(schemeId, firstTheme.id, { definition: '库中更新后的定义 XYZ' });
  await flush();
  await test('库修订增长、项目快照保持原样', () => {
    assert.equal(store.library.schemes[0].themes.length, 7);
    assert.equal(store.state.themes.length, 6);
    const projectTheme = store.state.themes.find((t) => t.id === firstTheme.id);
    assert.ok(!projectTheme.definition.includes('XYZ'));
    assert.equal(store.state.snapshotSchemeRevision, 1);
    assert.ok(store.sourceScheme().revision >= 2);
  });

  console.log('场景 3：新项目复制的是库当前版本快照，旧项目仍不动');
  await store.createProjectFromScheme('第二个研究', schemeId);
  await flush();
  const newProjectId = store.state.id;
  const oldProjectId = store.registry.projects.find((p) => p.name === '李岚访谈研究').id;
  await test('新项目包含 7 个主题、快照修订号为最新', () => {
    assert.equal(store.state.themes.length, 7);
    assert.equal(store.state.snapshotSchemeRevision, store.library.schemes[0].revision);
    assert.ok(store.state.themes.some((t) => t.name.includes('新增的库主题')));
  });
  await test('切回旧项目仍是 6 个主题', async () => {
    await store.switchProject(oldProjectId);
    await flush();
    assert.equal(store.state.themes.length, 6);
    assert.equal(store.state.id, oldProjectId);
  });

  console.log('场景 4：回写前列差异，按勾选合并且不重复');
  store.addTheme('项目本地新主题', null);
  await flush();
  const localId = store.state.themes.find((t) => t.name === '项目本地新主题').id;
  store.updateTheme(store.state.themes[0].id, { definition: '项目内修改的定义' }, '主题定义');
  await flush();
  const diff = store.computeWriteBackDiff();
  await test('差异包含新增与修改', () => {
    assert.ok(diff.some((c) => c.type === 'added' && c.themeId === localId));
    assert.ok(diff.some((c) => c.type === 'changed' && c.fields.includes('操作定义')));
  });
  const beforeCount = store.library.schemes[0].themes.length;
  await store.writeBackToScheme(diff.filter((c) => c.type !== 'removed'));
  await flush();
  await test('回写后库新增 1 主题、基线重置（差异归零）', () => {
    assert.equal(store.library.schemes[0].themes.length, beforeCount + 1);
    assert.equal(store.computeWriteBackDiff().length, 0);
    assert.equal(store.state.snapshotSchemeRevision, store.library.schemes[0].revision);
  });
  // 再次执行同样的回写不应再增加主题（幂等性：基线已更新，diff 为空）
  await test('无差异时回写不产生重复主题', async () => {
    const result = await store.runWriteBack(store.computeWriteBackDiff());
    assert.equal(result, 'ok');
    assert.equal(store.library.schemes[0].themes.length, beforeCount + 1);
  });

  console.log('场景 5：检查点失败后重试不产生重复项目（预分配 ID）');
  const { armWriteFailure } = require(require('path').resolve(__dirname, '../dist-test/store-bundle.cjs'));
  const projectCount = store.registry.projects.length;
  armWriteFailure(1);
  const r1 = await store.createProjectFromScheme('会失败的项目', schemeId);
  await flush();
  await test('首次创建返回 error 并留下检查点', () => {
    assert.equal(r1, 'error');
    assert.ok(store.pendingCheckpoint());
  });
  // 界面已回滚：项目数不变
  await test('回滚后登记簿没有多出项目', () => {
    assert.equal(store.registry.projects.length, projectCount);
  });
  const checkpointId = store.pendingCheckpoint().project.id;
  const r2 = await store.resumePendingCheckpoint();
  await flush();
  await test('重试成功，只多出一个项目且 ID 与检查点一致', () => {
    assert.equal(r2, 'ok');
    assert.equal(store.registry.projects.length, projectCount + 1);
    assert.ok(store.registry.projects.some((p) => p.id === checkpointId));
    assert.equal(store.state.id, checkpointId);
    assert.equal(store.pendingCheckpoint(), null);
  });

  console.log('场景 6：旧版数据首次打开迁移，判断/人员/审计不丢');
  await resetStorage();
  // 构造旧格式数据
  const legacyState = {
    revision: 7,
    updatedAt: new Date().toISOString(),
    activeTranscriptId: 'tr-old',
    activeSegmentId: 's-old-1',
    activeThemeId: 't-old-1',
    coderA: '旧编码员甲',
    coderB: '旧编码员乙',
    transcripts: [{ id: 'tr-old', title: '旧访谈', participant: '旧受访者', importedAt: new Date().toISOString(), sourceName: 'old.txt' }],
    segments: [{ id: 's-old-1', transcriptId: 'tr-old', order: 0, speaker: '旧受访者', time: '00:00:01', text: '旧原文内容', assignments: { A: ['t-old-1'], B: ['t-old-2'] }, note: '旧备忘' }],
    themes: [
      { id: 't-old-1', name: '旧主题一', parentId: null, color: '#000', definition: '旧定义', memo: '', examples: [] },
      { id: 't-old-2', name: '旧主题二', parentId: null, color: '#111', definition: '', memo: '', examples: [] }
    ],
    audit: [{ id: 'a-old', at: new Date().toISOString(), action: '旧操作', detail: '旧审计详情' }]
  };
  window.localStorage.setItem('sologsb-1019-state-v1', JSON.stringify(legacyState));
  store = await loadStore();
  await store.initialize();
  await flush();
  await test('迁移为默认项目且保留全部旧数据', () => {
    assert.equal(store.registry.projects.length, 1);
    assert.equal(store.state.name, '默认研究项目');
    assert.equal(store.state.coderA, '旧编码员甲');
    assert.equal(store.state.coderB, '旧编码员乙');
    assert.equal(store.state.segments.length, 1);
    assert.equal(store.state.segments[0].text, '旧原文内容');
    assert.deepEqual(store.state.segments[0].assignments, { A: ['t-old-1'], B: ['t-old-2'] });
    assert.equal(store.state.segments[0].note, '旧备忘');
    assert.equal(store.state.themes.length, 2);
    assert.ok(store.state.audit.some((a) => a.detail === '旧审计详情'));
    assert.ok(store.state.audit.some((a) => a.action === '迁移旧数据'));
    assert.equal(store.library.schemes.length, 1);
    assert.equal(store.library.schemes[0].themes.length, 2);
  });
  await test('旧 localStorage 键迁移后被清理', () => {
    assert.equal(window.localStorage.getItem('sologsb-1019-state-v1'), null);
  });
  await test('迁移后库改版不影响迁移项目', () => {
    store.addSchemeTheme(store.library.schemes[0].id, '迁移后库新增', null);
    assert.equal(store.state.themes.length, 2);
    assert.equal(store.library.schemes[0].themes.length, 3);
  });

  console.log('场景 7：刷新后（重建 store）数据仍在，且不重复迁移');
  const projectIdBefore = store.state.id;
  delete require.cache[require.resolve(require('path').resolve(__dirname, '../dist-test/store-bundle.cjs'))];
  store = await loadStore();
  await store.initialize();
  await flush();
  await test('重新载入后仍是迁移项目、只有一个项目', () => {
    assert.equal(store.state.id, projectIdBefore);
    assert.equal(store.registry.projects.length, 1);
    assert.equal(store.library.schemes[0].themes.length, 3);
  });

  console.log('场景 8：纯函数 — 移除父主题回写时子主题提升、新增祖先标记必选');
  const { diffThemes, mergeChangesIntoLibrary } = require(require('path').resolve(__dirname, '../dist-test/store-bundle.cjs'));
  const baseline = [
    { id: 'p', name: '父', parentId: null, color: '#000', definition: '', memo: '', examples: [] },
    { id: 'c', name: '子', parentId: 'p', color: '#111', definition: '', memo: '', examples: [] }
  ];
  // 当前项目：删除父主题，子主题保留
  const current = [
    { id: 'c', name: '子', parentId: null, color: '#111', definition: '已补充定义', memo: '', examples: [] }
  ];
  const changes = diffThemes(baseline, current);
  await test('差异包含 1 项移除、1 项修改', () => {
    assert.equal(changes.filter((c) => c.type === 'removed').length, 1);
    assert.equal(changes.filter((c) => c.type === 'changed').length, 1);
  });
  // 只回写移除项：库里的子主题应提升为顶层，不产生悬空父级
  const merged = mergeChangesIntoLibrary(baseline, current, changes.filter((c) => c.type === 'removed'));
  await test('回写移除后子主题提升为一级主题', () => {
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 'c');
    assert.equal(merged[0].parentId, null);
  });
  // 新增子主题时若父主题也是新增，父主题应被标记必选
  const base2 = [];
  const current2 = [
    { id: 'p2', name: '新父', parentId: null, color: '#000', definition: '', memo: '', examples: [] },
    { id: 'c2', name: '新子', parentId: 'p2', color: '#111', definition: '', memo: '', examples: [] }
  ];
  const changes2 = diffThemes(base2, current2);
  await test('新增子主题时其新增父主题被标记为必选', () => {
    const child = changes2.find((c) => c.themeId === 'c2');
    const parent = changes2.find((c) => c.themeId === 'p2');
    assert.equal(child.required, undefined);
    assert.equal(parent.required, true);
  });

  console.log(`\n${passed} 项断言通过`);
})();
