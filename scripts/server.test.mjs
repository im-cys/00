import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommunityStore } from '../server/community-store.mjs';
import { createServer, publicMapError } from '../server/server.mjs';
import { configuration } from '../server/config.mjs';

test('优先识别知乎黑客松标准回调变量名', async () => {
  const previous = process.env.ZHIHU_OAUTH_REDIRECT_URI;
  const previousLegacy = process.env.ZHIHU_REDIRECT_URI;
  const previousCloudbaseKey = process.env.CLOUDBASE_APIKEY;
  const previousSecretId = process.env.CLOUDBASE_SECRETID;
  const previousSecretKey = process.env.CLOUDBASE_SECRETKEY;
  process.env.ZHIHU_OAUTH_REDIRECT_URI = 'https://example.test/new-callback';
  process.env.ZHIHU_REDIRECT_URI = 'https://example.test/legacy-callback';
  process.env.CLOUDBASE_APIKEY = 'server-api-key';
  process.env.CLOUDBASE_SECRETID = 'secret-id';
  process.env.CLOUDBASE_SECRETKEY = 'secret-key';
  try {
    const config = await configuration();
    assert.equal(config.zhihuAuth.redirectUri, 'https://example.test/new-callback');
    assert.equal(config.cloudbaseApiKey, 'server-api-key');
    assert.equal(config.cloudbaseSecretId, 'secret-id');
    assert.equal(config.cloudbaseSecretKey, 'secret-key');
    assert.equal(config.cloudbaseDatabaseInstance, 'default');
    assert.equal(config.cloudbaseDatabaseSchema, 'public');
  }
  finally {
    if (previous === undefined) delete process.env.ZHIHU_OAUTH_REDIRECT_URI; else process.env.ZHIHU_OAUTH_REDIRECT_URI = previous;
    if (previousLegacy === undefined) delete process.env.ZHIHU_REDIRECT_URI; else process.env.ZHIHU_REDIRECT_URI = previousLegacy;
    if (previousCloudbaseKey === undefined) delete process.env.CLOUDBASE_APIKEY; else process.env.CLOUDBASE_APIKEY = previousCloudbaseKey;
    if (previousSecretId === undefined) delete process.env.CLOUDBASE_SECRETID; else process.env.CLOUDBASE_SECRETID = previousSecretId;
    if (previousSecretKey === undefined) delete process.env.CLOUDBASE_SECRETKEY; else process.env.CLOUDBASE_SECRETKEY = previousSecretKey;
  }
});

test('文件回退存储可持久化 OAuth、私有数据、结构图、发现与评论', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'answer-collision-'));
  try {
    const store = createCommunityStore(join(dir, 'store.json'));
    const user = { id: 'zhihu-test', name: '测试用户', avatar: '', provider: 'zhihu' };
    const token = await store.createSession(user);
    assert.equal((await store.session(token)).id, user.id);
    await store.saveOAuthState('state', 'nonce', '/question/10001');
    assert.deepEqual(await store.consumeOAuthState('state', 'nonce'), { returnTo: '/question/10001' });
    assert.equal(await store.consumeOAuthState('state', 'nonce'), null, 'state 必须只能消费一次');
    await store.importDataset({ questions: [{ id: '10001', answers: [] }] }, 'hash');
    assert.equal((await store.getDataset()).contentHash, 'hash');
    await store.saveAnswerMap({ answerId: '10001-01', questionId: '10001', payload: { nodes: [] }, sourceHash: 's', model: 'deepseek-v4-pro', promptVersion: 'v1' });
    assert.deepEqual((await store.getAnswerMap('10001-01')).payload, { nodes: [] });
    await store.saveAnswerMap({ answerId: '10001-02', questionId: '10001', payload: { schemaVersion: 'answer-tree-v2', tree: {}, nodes: [] }, sourceHash: 's2', model: 'deepseek-v4-pro', promptVersion: 'answer-tree-v2' });
    // 清理必须只影响过期图引用的缓存：10001-01 过期，10001-02 仍是当前版本，它的缓存不能被连带删掉。
    await store.saveCollisionCache({ cacheKey: 'stale', questionId: '10001', answerIds: ['10001-01', '10001-02'], nodeIds: ['n1', 'n2'], result: { status: 'published' }, model: 'deepseek-v4-pro', promptVersion: 'collision-v6' });
    await store.saveCollisionCache({ cacheKey: 'fresh', questionId: '10001', answerIds: ['10001-02'], nodeIds: ['n3', 'n4'], result: { status: 'published' }, model: 'deepseek-v4-pro', promptVersion: 'collision-v6' });
    assert.equal(await store.pruneAnswerMaps('answer-tree-v2'), 1);
    assert.equal(await store.getAnswerMap('10001-01'), null);
    assert.ok(await store.getAnswerMap('10001-02'));
    assert.equal(await store.getCollisionCache('stale'), null, '引用了被删结构图的缓存要清掉');
    assert.ok(await store.getCollisionCache('fresh'), '只引用当前版本结构图的缓存必须保留');
    assert.equal(await store.pruneAnswerMaps('answer-tree-v2'), 0, '重复清理必须幂等，不再删除任何内容');
    assert.ok(await store.getCollisionCache('fresh'), '幂等清理不得误删有效缓存');
    assert.equal(await store.pruneAnswerMaps('answer-tree-v2', 'answer-tree-v2.1-density'), 1);
    assert.equal(await store.getAnswerMap('10001-02'), null);
    const discovery = await store.saveDiscovery(user, { id: 'd1', pairKey: 'pair', questionId: '10001', status: 'published' });
    const comment = await store.commentDiscovery(user, discovery.id, '公开评论');
    const publicData = await store.listDiscoveries('10001');
    assert.equal(publicData.items.length, 1);
    assert.equal(publicData.comments.d1[0].text, '公开评论');
    await store.withdrawDiscoveryComment(user, discovery.id, comment.id);
    assert.equal((await store.listDiscoveries('10001')).comments.d1[0].status, 'withdrawn');
    await store.updateDiscoveryStatus(user, discovery.id, 'withdrawn');
    assert.equal((await store.listDiscoveries('10001')).items.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('知乎授权跳转使用官方 app_id 参数并把 state 绑定到浏览器 nonce', async () => {
  let saved;
  const store = { saveOAuthState: async (...args) => { saved = args; } };
  const config = {
    allowedHosts: ['127.0.0.1'], allowedOrigins: [], collideBase: 'http://127.0.0.1:3311', useDatabase: false, aiModel: 'deepseek-v4-pro',
    zhihuAuth: { configured: true, appId: 'app-123', appKey: 'secret', authorizationUrl: 'https://openapi.zhihu.com/authorize', redirectUri: 'https://example.test/auth/zhihu/callback', scope: '' }
  };
  const server = createServer(config, store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/auth/zhihu?return_to=%2Fquestion%2F10001`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    const target = new URL(response.headers.get('location'));
    assert.equal(target.searchParams.get('app_id'), 'app-123');
    assert.equal(target.searchParams.has('client_id'), false);
    assert.equal(target.searchParams.get('redirect_uri'), config.zhihuAuth.redirectUri);
    assert.equal(saved[0], target.searchParams.get('state'));
    assert.equal(saved[2], '/question/10001');
    assert.match(response.headers.get('set-cookie'), /qm_oauth_nonce=.*HttpOnly.*SameSite=Lax.*Secure/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('未登录访问页面时先进入登录选择页，登录用户可直接进入', async () => {
  let loggedIn = false;
  const store = { session: async () => loggedIn ? { id: 'zhihu-test', name: '测试用户' } : null };
  const config = {
    allowedHosts: ['127.0.0.1'], allowedOrigins: [], collideBase: 'http://127.0.0.1:3311', useDatabase: false, aiModel: 'deepseek-v4-pro',
    zhihuAuth: { configured: true, redirectUri: 'https://example.test/auth/zhihu/callback' }
  };
  const server = createServer(config, store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address(); const base = `http://127.0.0.1:${port}`;
    const guarded = await fetch(`${base}/question/10001?from=home`, { redirect: 'manual' });
    assert.equal(guarded.status, 302);
    assert.equal(guarded.headers.get('location'), '/login?return_to=%2Fquestion%2F10001%3Ffrom%3Dhome');
    const loginPage = await fetch(`${base}${guarded.headers.get('location')}`);
    assert.equal(loginPage.status, 200);
    const loginHtml = await loginPage.text();
    assert.match(loginHtml, /使用知乎授权登录/);
    assert.doesNotMatch(loginHtml, /创建账号|name="password"|临时测试入口/);
    const asset = await fetch(`${base}/web/styles.css`, { redirect: 'manual' });
    assert.equal(asset.status, 200, '静态资源不能被登录守卫拦截');
    loggedIn = true;
    const allowed = await fetch(`${base}/question/10001?from=home`, { headers: { Cookie: 'qm_session=test' }, redirect: 'manual' });
    assert.equal(allowed.status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('两个知乎用户的互动状态按账号隔离并持久化，临时登录接口已移除', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'answer-collision-auth-'));
  const file = join(dir, 'store.json');
  const store = createCommunityStore(file);
  const config = {
    allowedHosts: ['127.0.0.1'], allowedOrigins: [], collideBase: 'http://127.0.0.1:3311', useDatabase: false, aiModel: 'deepseek-v4-pro',
    zhihuAuth: { configured: true, redirectUri: 'http://127.0.0.1/auth/zhihu/callback' }
  };
  const server = createServer(config, store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const alice = { id: 'zhihu-alice', name: '知乎账号A', avatar: '', provider: 'zhihu' };
    const bob = { id: 'zhihu-bob', name: '知乎账号B', avatar: '', provider: 'zhihu' };
    const aliceCookie = `qm_session=${await store.createSession(alice)}`;
    const bobCookie = `qm_session=${await store.createSession(bob)}`;
    const removedLogin = await fetch(`${base}/api/auth/test/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: '旧账号', password: 'password-123' })
    });
    assert.equal(removedLogin.status, 404);
    const actionBody = { action: 'like', questionId: '10001', answerId: '10001-01' };
    const aliceLike = await fetch(`${base}/api/community/action`, { method: 'POST', headers: { Cookie: aliceCookie, 'Content-Type': 'application/json' }, body: JSON.stringify(actionBody) });
    assert.equal(aliceLike.status, 200);
    assert.equal((await aliceLike.json()).answers['10001-01'].mine.like, true);
    const bobSnapshot = await (await fetch(`${base}/api/community`, { headers: { Cookie: bobCookie } })).json();
    assert.equal(bobSnapshot.answers['10001-01'].likes, 1);
    assert.equal(bobSnapshot.answers['10001-01'].mine.like, false, '总数共享，但不能把 A 的点赞记到 B 名下');
    const bobLike = await fetch(`${base}/api/community/action`, { method: 'POST', headers: { Cookie: bobCookie, 'Content-Type': 'application/json' }, body: JSON.stringify(actionBody) });
    assert.equal((await bobLike.json()).answers['10001-01'].likes, 2);
    const discoveryPayload = { id: 'multi-account-discovery', pairKey: '10001|multi-account-pair', questionId: '10001', refs: [], newQuestion: '多账号能否看到同一条发现？', status: 'published' };
    const published = await fetch(`${base}/api/discoveries`, { method: 'POST', headers: { Cookie: aliceCookie, 'Content-Type': 'application/json' }, body: JSON.stringify(discoveryPayload) });
    assert.equal(published.status, 200);
    assert.equal((await published.json()).item.author, '知乎账号A');
    const commented = await fetch(`${base}/api/discoveries/comment`, { method: 'POST', headers: { Cookie: bobCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ discoveryId: discoveryPayload.id, text: 'B 账号的公开评论' }) });
    assert.equal(commented.status, 200);
    assert.equal((await commented.json()).item.author, '知乎账号B');
    const answerComment = await fetch(`${base}/api/community/comment`, { method: 'POST', headers: { Cookie: bobCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: '10001', answerId: '10001-01', text: 'B 账号的回答评论' }) });
    assert.equal(answerComment.status, 200);
    const publicDiscoveries = await (await fetch(`${base}/api/discoveries?questionId=10001`)).json();
    assert.equal(publicDiscoveries.items[0].creatorId, alice.id);
    assert.equal(publicDiscoveries.comments[discoveryPayload.id][0].author, '知乎账号B');
    const restartedStore = createCommunityStore(file);
    assert.equal((await restartedStore.snapshot(alice.id)).answers['10001-01'].mine.like, true);
    assert.equal((await restartedStore.snapshot(alice.id)).answers['10001-01'].comments, 1);
    assert.equal((await restartedStore.listDiscoveries('10001')).comments[discoveryPayload.id][0].author, '知乎账号B');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('受保护导入接口写入存储后，网页内容脚本从存储读取', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'answer-collision-import-'));
  const store = createCommunityStore(join(dir, 'store.json'));
  const config = {
    allowedHosts: ['127.0.0.1'], allowedOrigins: [], collideBase: 'http://127.0.0.1:3311', useDatabase: false, aiModel: 'deepseek-v4-pro', dataImportToken: 'test-import-token',
    zhihuAuth: { configured: false, redirectUri: 'http://127.0.0.1/callback' }
  };
  const server = createServer(config, store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address(); const base = `http://127.0.0.1:${port}`;
    const denied = await fetch(`${base}/api/admin/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { questions: [] } }) });
    assert.equal(denied.status, 401);
    const imported = await fetch(`${base}/api/admin/import`, { method: 'POST', headers: { Authorization: 'Bearer test-import-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { questions: [{ id: '10001', title: '仅用于测试', answers: [] }] } }) });
    assert.equal(imported.status, 200);
    const script = await (await fetch(`${base}/content/data.js`)).text();
    assert.match(script, /window\.ZHIHU_DEMO_DATA/);
    assert.match(script, /仅用于测试/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('已通过令牌校验的导入请求返回可操作的数据库错误', async () => {
  const store = { importDataset: async () => { throw new Error('permission denied for table private_datasets'); } };
  const config = {
    allowedHosts: ['127.0.0.1'], allowedOrigins: [], collideBase: 'http://127.0.0.1:3311', useDatabase: true, aiModel: 'deepseek-v4-pro', dataImportToken: 'test-import-token',
    zhihuAuth: { configured: false, redirectUri: 'http://127.0.0.1/callback' }
  };
  const server = createServer(config, store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/import`, {
      method: 'POST', headers: { Authorization: 'Bearer test-import-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { questions: [] } })
    });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /permission denied for table private_datasets/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('结构图生成立即返回任务状态，并可轮询到实际生成结果', async () => {
  let upstreamCalls = 0; let storedMap = null;
  const upstream = createHttpServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/extract-map') { res.writeHead(404).end(); return; }
    upstreamCalls++;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    await new Promise(resolve => setTimeout(resolve, 120));
    const body = JSON.stringify({ map: { answerId: input.answerId, groups: [], nodes: [{ id: 'n1', role: 'thesis', text: '测试观点' }] } });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }); res.end(body);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const store = {
    session: async () => ({ id: 'zhihu-test', name: '测试用户' }),
    getDataset: async () => ({ payload: { questions: [{ id: '10001', title: '测试问题', answers: [{ id: '10001-01', author: '测试作者', paragraphs: ['回答正文'] }] }] } }),
    getAnswerMap: async () => storedMap,
    saveAnswerMap: async value => { storedMap = { ...value, source_hash: value.sourceHash, prompt_version: value.promptVersion }; },
    act: async () => ({})
  };
  const config = {
    allowedHosts: ['127.0.0.1'], allowedOrigins: [], collideBase: `http://127.0.0.1:${upstream.address().port}`, useDatabase: false, aiModel: 'deepseek-v4-pro',
    zhihuAuth: { configured: false, redirectUri: 'http://127.0.0.1/callback' }
  };
  const server = createServer(config, store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const options = { method: 'POST', headers: { Cookie: 'qm_session=test', 'Content-Type': 'application/json' }, body: JSON.stringify({ answerId: '10001-01' }) };
    const started = await fetch(`${base}/api/maps/generate`, options);
    assert.equal(started.status, 202);
    assert.deepEqual(await started.json(), { answerId: '10001-01', status: 'processing' });
    const duplicate = await fetch(`${base}/api/maps/generate`, options);
    assert.equal(duplicate.status, 202, '处理中重复请求不能再启动一次模型调用');
    let finished;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      finished = await fetch(`${base}/api/maps/generate?answerId=10001-01`, { headers: { Cookie: 'qm_session=test' } });
      if (finished.status === 200) break;
    }
    assert.equal(finished.status, 200);
    const result = await finished.json();
    assert.equal(result.status, 'ready');
    assert.equal(result.map.nodes[0].text, '测试观点');
    assert.equal(upstreamCalls, 1);
    assert.ok(storedMap, '实际生成结果必须写入存储');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('结构图列表只返回 answer-tree-v2，旧扁平缓存不会混入前端', async () => {
  const store = {
    getAnswerMaps: async () => ({
      '10001-01': { answerId: '10001-01', nodes: [{ id: 'old' }] },
      '10001-02': { schemaVersion: 'answer-tree-v2', answerId: '10001-02', tree: { id: 'root' }, nodes: [] }
    })
  };
  const config = {
    allowedHosts: ['127.0.0.1'], allowedOrigins: [], collideBase: 'http://127.0.0.1:3311', useDatabase: false, aiModel: 'deepseek-v4-pro',
    zhihuAuth: { configured: false, redirectUri: 'http://127.0.0.1/callback' }
  };
  const server = createServer(config, store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/collide/maps?qid=10001`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(Object.keys(result.answers), ['10001-02']);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('本地操作轨迹只记录定位字段，不写回答正文和密钥', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'answer-collision-trace-'));
  const operationLogPath = join(dir, 'operation-trace.jsonl');
  const store = {};
  const config = {
    allowedHosts: ['127.0.0.1'], allowedOrigins: [], useDatabase: false, operationLogPath,
    aiModel: 'test-model', zhihuAuth: { configured: false, redirectUri: 'http://127.0.0.1/callback' }
  };
  const server = createServer(config, store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/local/trace`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'answer_selected', traceId: 'trace-1', questionId: '10006', answerId: '10006-02', selectedCount: 1, content: '不得写入的回答正文', apiKey: '不得写入的密钥' })
    });
    assert.equal(response.status, 200);
    const log = await readFile(operationLogPath, 'utf8');
    assert.match(log, /answer_selected/);
    assert.match(log, /10006-02/);
    assert.doesNotMatch(log, /回答正文|密钥/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('生成失败会区分模型网络、限流和观点树校验错误', () => {
  assert.match(publicMapError(new Error('WinError 10013')), /无法连接模型接口/);
  assert.match(publicMapError(new Error('HTTP 429 rate limit')), /拥塞或额度/);
  assert.match(publicMapError(new Error('HTTP 401 invalid api key')), /API Key 无效/);
  assert.match(publicMapError(new Error('缺少 EXTRACT_API_KEY')), /API Key 无效/);
  assert.match(publicMapError(new Error('HTTP 402 insufficient balance')), /余额不足/);
  assert.match(publicMapError(new Error('HTTP 404 model_not_found')), /模型名称或接口地址/);
  assert.match(publicMapError(new Error('HTTP 400 invalid request: thinking')), /请求参数不兼容/);
  assert.match(publicMapError(new Error('模型返回空 content')), /没有返回有效 JSON/);
  assert.match(publicMapError(new Error('display_text 不是完整短总结')), /观点树校验/);
  assert.match(publicMapError(new Error('HTTPSConnectionPool: Read timed out')), /无法连接模型接口/);
  assert.match(publicMapError(new Error('观点树校验失败')), /没有通过新版观点树校验/);
  assert.match(publicMapError(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), /超过 15 分钟/);
});
