import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommunityStore } from '../server/community-store.mjs';
import { createServer } from '../server/server.mjs';
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
    zhihuAuth: { configured: true, demoMode: false, appId: 'app-123', appKey: 'secret', authorizationUrl: 'https://openapi.zhihu.com/authorize', redirectUri: 'https://example.test/auth/zhihu/callback', scope: '' }
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

test('未登录访问页面时先跳转知乎授权，登录用户可直接进入', async () => {
  let loggedIn = false;
  const store = { session: async () => loggedIn ? { id: 'zhihu-test', name: '测试用户' } : null };
  const config = {
    allowedHosts: ['127.0.0.1'], allowedOrigins: [], collideBase: 'http://127.0.0.1:3311', useDatabase: false, aiModel: 'deepseek-v4-pro',
    zhihuAuth: { configured: true, demoMode: false, redirectUri: 'https://example.test/auth/zhihu/callback' }
  };
  const server = createServer(config, store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address(); const base = `http://127.0.0.1:${port}`;
    const guarded = await fetch(`${base}/question/10001?from=home`, { redirect: 'manual' });
    assert.equal(guarded.status, 302);
    assert.equal(guarded.headers.get('location'), '/auth/zhihu?return_to=%2Fquestion%2F10001%3Ffrom%3Dhome');
    const asset = await fetch(`${base}/web/styles.css`, { redirect: 'manual' });
    assert.equal(asset.status, 200, '静态资源不能被登录守卫拦截');
    loggedIn = true;
    const allowed = await fetch(`${base}/question/10001?from=home`, { headers: { Cookie: 'qm_session=test' }, redirect: 'manual' });
    assert.equal(allowed.status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('受保护导入接口写入存储后，网页内容脚本从存储读取', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'answer-collision-import-'));
  const store = createCommunityStore(join(dir, 'store.json'));
  const config = {
    allowedHosts: ['127.0.0.1'], allowedOrigins: [], collideBase: 'http://127.0.0.1:3311', useDatabase: false, aiModel: 'deepseek-v4-pro', dataImportToken: 'test-import-token',
    zhihuAuth: { configured: false, demoMode: false, redirectUri: 'http://127.0.0.1/callback' }
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
    zhihuAuth: { configured: false, demoMode: false, redirectUri: 'http://127.0.0.1/callback' }
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
