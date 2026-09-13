import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { root, configuration } from './config.mjs';
import { createStore } from './store.mjs';

const PROMPT_VERSION = 'answer-map-v1';
const COLLISION_VERSION = 'collision-v1';
const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const safeReturnTo = value => /^\/(?!\/)/.test(value || '') ? value : '/';
const cookies = request => Object.fromEntries(String(request.headers.cookie || '').split(';').map(item => item.trim().split('=').map(decodeURIComponent)).filter(parts => parts.length === 2));
const secureFor = config => String(config.zhihuAuth?.redirectUri || '').startsWith('https:');
const cookie = (name, value, { clear = false, secure = false, maxAge = 2592000 } = {}) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : maxAge}${secure ? '; Secure' : ''}`;

async function jsonBody(req, maximum = 20000) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw Object.assign(new Error('JSON required'), { status: 415 });
  let bytes = 0; const buffers = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > maximum) throw Object.assign(new Error('请求过大。'), { status: 413 }); buffers.push(chunk); }
  try { return JSON.parse(Buffer.concat(buffers).toString('utf8')); }
  catch { throw Object.assign(new Error('JSON 格式不正确。'), { status: 400 }); }
}

function datasetValue(record) { return record?.payload ?? record ?? null; }
function answerFrom(dataset, answerId) {
  for (const question of dataset?.questions || []) {
    const answer = (question.answers || []).find(item => String(item.id) === String(answerId));
    if (answer) return { question, answer, content: (answer.paragraphs || []).filter(item => !String(item).includes('〔图片〕') && !String(item).includes('〔视频〕')).join('\n') };
  }
  return null;
}
function publicMapScript(maps) { return `window.COLLISION_MAPS = ${JSON.stringify(maps || {})};\n`; }
function privateDataScript(dataset) { return `window.ZHIHU_DEMO_DATA = ${JSON.stringify(dataset || { questions: [] })};\n`; }
function rawJsonId(text, key) {
  const match = String(text).match(new RegExp(`"${key}"\\s*:\\s*(?:"([^"]+)"|(\\d+))`));
  return match ? (match[1] || match[2]) : '';
}

export function createServer(config, store) {
  const collideBase = config.collideBase || 'http://127.0.0.1:3311';
  const files = new Map([
    ['/', 'web/index.html'], ['/question.html', 'web/question.html'], ['/web/site.js', 'web/site.js'],
    ['/web/styles.css', 'web/styles.css'], ['/web/collision.css', 'web/collision.css'], ['/web/collision.js', 'web/collision.js'], ['/web/collision-core.js', 'web/collision-core.js']
  ]);
  const allowedHosts = new Set((config.allowedHosts || []).map(value => value.toLowerCase()));
  const allowedOrigins = new Set(config.allowedOrigins || []);
  const hostName = value => { try { return new URL(`http://${value}`).hostname.toLowerCase(); } catch { return ''; } };
  const sessionInfo = user => ({ user, provider: 'zhihu', configured: Boolean(config.zhihuAuth?.configured), demoMode: Boolean(config.zhihuAuth?.demoMode) });
  const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const currentUser = req => store.session(cookies(req).qm_session);

  return http.createServer(async (req, res) => {
    try {
      const requestHost = hostName(req.headers.host || '');
      if (!requestHost || (!allowedHosts.has('*') && !allowedHosts.has(requestHost))) return send(res, 403, { error: 'Host denied' });
      const origin = req.headers.origin;
      let sameOrigin = false; try { sameOrigin = new URL(origin).host === req.headers.host; } catch {}
      if (origin && !sameOrigin && !allowedOrigins.has(origin)) return send(res, 403, { error: 'Origin denied' });
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }); return res.end(); }
      const url = new URL(req.url, 'http://127.0.0.1');
      const path = url.pathname;

      if (req.method === 'GET' && path === '/api/health') return send(res, 200, { ok: true, app: 'answer-collision', database: config.useDatabase, model: config.aiModel });

      if (req.method === 'POST' && path === '/api/admin/import') {
        const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!config.dataImportToken || supplied !== config.dataImportToken) return send(res, 401, { error: '导入令牌无效。' });
        const input = await jsonBody(req, 25 * 1024 * 1024);
        if (!input.data?.questions || !Array.isArray(input.data.questions)) return send(res, 400, { error: 'data.questions 缺失。' });
        const contentHash = sha256(input.data);
        await store.importDataset(input.data, contentHash);
        let mapCount = 0;
        for (const [answerId, payload] of Object.entries(input.maps || {})) {
          const source = answerFrom(input.data, answerId);
          await store.saveAnswerMap({ answerId, questionId: answerId.split('-')[0], payload, sourceHash: sha256(source?.content || ''), model: input.mapModel || 'imported', promptVersion: input.mapPromptVersion || 'imported-v1' });
          mapCount++;
        }
        return send(res, 200, { ok: true, contentHash, questions: input.data.questions.length, maps: mapCount });
      }

      if (req.method === 'GET' && path === '/api/auth/session') return send(res, 200, sessionInfo(await currentUser(req)));

      if (req.method === 'GET' && path === '/auth/zhihu') {
        const returnTo = safeReturnTo(url.searchParams.get('return_to'));
        if (config.zhihuAuth?.configured) {
          const state = randomBytes(32).toString('base64url');
          const browserNonce = randomBytes(32).toString('base64url');
          await store.saveOAuthState(state, browserNonce, returnTo);
          const target = new URL(config.zhihuAuth.authorizationUrl);
          target.searchParams.set('response_type', 'code');
          target.searchParams.set('app_id', config.zhihuAuth.appId);
          target.searchParams.set('redirect_uri', config.zhihuAuth.redirectUri);
          target.searchParams.set('state', state);
          if (config.zhihuAuth.scope) target.searchParams.set('scope', config.zhihuAuth.scope);
          res.writeHead(302, { Location: target.href, 'Set-Cookie': cookie('qm_oauth_nonce', browserNonce, { secure: secureFor(config), maxAge: 600 }), 'Cache-Control': 'no-store' }); return res.end();
        }
        if (config.zhihuAuth?.demoMode) {
          const suffix = randomBytes(3).toString('hex');
          const user = { id: `zhihu-demo-${suffix}`, name: `知乎试用用户 ${suffix.toUpperCase()}`, avatar: '', provider: 'zhihu-demo' };
          const token = await store.createSession(user);
          res.writeHead(302, { Location: returnTo, 'Set-Cookie': cookie('qm_session', token, { secure: secureFor(config) }), 'Cache-Control': 'no-store' }); return res.end();
        }
        return send(res, 503, { error: '知乎登录尚未配置。' });
      }

      if (req.method === 'GET' && path === '/auth/zhihu/callback') {
        const state = url.searchParams.get('state');
        const code = url.searchParams.get('authorization_code') || url.searchParams.get('code');
        const pending = await store.consumeOAuthState(state, cookies(req).qm_oauth_nonce);
        if (!code || !pending) return send(res, 400, { error: '知乎登录状态已过期或浏览器校验失败，请重试。' });
        const tokenResponse = await fetch(config.zhihuAuth.tokenUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ app_id: config.zhihuAuth.appId, app_key: config.zhihuAuth.appKey, grant_type: 'authorization_code', redirect_uri: config.zhihuAuth.redirectUri, code }), signal: AbortSignal.timeout(30000)
        });
        const tokenText = await tokenResponse.text();
        let tokenData; try { tokenData = JSON.parse(tokenText); } catch { tokenData = {}; }
        tokenData = tokenData.data || tokenData;
        if (!tokenResponse.ok || !tokenData.access_token) return send(res, 502, { error: '知乎授权码交换失败。' });
        const profileResponse = await fetch(config.zhihuAuth.profileUrl, { headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
        const profileText = await profileResponse.text();
        let parsed; try { parsed = JSON.parse(profileText); } catch { parsed = {}; }
        const profile = parsed.data || parsed;
        const rawUid = rawJsonId(profileText, 'uid');
        const id = String(profile.hash_id || profile.id || profile.url_token || rawUid || '').trim();
        if (!profileResponse.ok || !id) return send(res, 502, { error: '无法读取有效的知乎用户资料。' });
        const user = { id: `zhihu-${id}`, name: String(profile.fullname || profile.name || '知乎用户').slice(0, 80), avatar: String(profile.avatar_path || profile.avatar_url || profile.avatar || '').slice(0, 500), provider: 'zhihu' };
        const token = await store.createSession(user);
        res.writeHead(302, { Location: pending.returnTo, 'Set-Cookie': [cookie('qm_session', token, { secure: secureFor(config) }), cookie('qm_oauth_nonce', '', { clear: true, secure: secureFor(config) })], 'Cache-Control': 'no-store' }); return res.end();
      }

      if (req.method === 'POST' && path === '/api/auth/logout') {
        await store.deleteSession(cookies(req).qm_session);
        res.setHeader('Set-Cookie', cookie('qm_session', '', { clear: true, secure: secureFor(config) }));
        return send(res, 200, { ok: true });
      }

      if (req.method === 'GET' && path === '/api/community') {
        const user = await currentUser(req); return send(res, 200, { ...(await store.snapshot(user?.id || '')), session: sessionInfo(user) });
      }
      if (req.method === 'POST' && /^\/api\/community\/(action|comment)$/.test(path)) {
        const user = await currentUser(req); if (!user) return send(res, 401, { error: '请先使用知乎账号登录。' });
        const input = await jsonBody(req);
        const snapshot = path.endsWith('/action') ? await store.act(user, input) : await store.comment(user, input);
        return send(res, 200, { ...snapshot, session: sessionInfo(user) });
      }

      if (req.method === 'GET' && path === '/api/discoveries') return send(res, 200, await store.listDiscoveries(url.searchParams.get('questionId') || ''));
      if (req.method === 'POST' && path === '/api/discoveries') {
        const user = await currentUser(req); if (!user) return send(res, 401, { error: '请先使用知乎账号登录。' });
        const item = await store.saveDiscovery(user, await jsonBody(req, 100000)); return send(res, 200, { item });
      }
      if (req.method === 'POST' && path === '/api/discoveries/comment') {
        const user = await currentUser(req); if (!user) return send(res, 401, { error: '请先使用知乎账号登录。' });
        const input = await jsonBody(req); const item = await store.commentDiscovery(user, String(input.discoveryId || ''), input.text); return send(res, 200, { item });
      }
      if (req.method === 'POST' && path === '/api/discoveries/status') {
        const user = await currentUser(req); if (!user) return send(res, 401, { error: '请先使用知乎账号登录。' });
        const input = await jsonBody(req); const item = await store.updateDiscoveryStatus(user, String(input.discoveryId || ''), input.status); return send(res, 200, { item });
      }
      if (req.method === 'POST' && path === '/api/discoveries/comment/status') {
        const user = await currentUser(req); if (!user) return send(res, 401, { error: '请先使用知乎账号登录。' });
        const input = await jsonBody(req); const item = await store.withdrawDiscoveryComment(user, String(input.discoveryId || ''), String(input.commentId || '')); return send(res, 200, { item });
      }

      if (req.method === 'GET' && path === '/api/collide/health') {
        try { const upstream = await fetch(`${collideBase}/health`, { signal: AbortSignal.timeout(5000) }); return send(res, 200, { ...(await upstream.json()), connected: true }); }
        catch { return send(res, 200, { ok: false, connected: false, error: '碰撞服务未启动。' }); }
      }
      if (req.method === 'GET' && path === '/api/collide/maps') return send(res, 200, { questionId: url.searchParams.get('qid') || '', answers: await store.getAnswerMaps(url.searchParams.get('qid') || '') });

      if (req.method === 'POST' && path === '/api/maps/generate') {
        const user = await currentUser(req); if (!user) return send(res, 401, { error: '请先使用知乎账号登录。' });
        const input = await jsonBody(req); const answerId = String(input.answerId || '');
        const dataset = datasetValue(await store.getDataset()); const source = answerFrom(dataset, answerId);
        if (!source?.content) return send(res, 404, { error: '没有找到这篇回答的私有正文。' });
        const sourceHash = sha256(source.content); const cached = await store.getAnswerMap(answerId);
        if (cached && (cached.source_hash || cached.sourceHash) === sourceHash && cached.model === config.aiModel && (cached.prompt_version || cached.promptVersion) === PROMPT_VERSION) return send(res, 200, { answerId, map: cached.payload, cacheHit: true });
        const upstream = await fetch(`${collideBase}/extract-map`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answerId, questionTitle: source.question.title || '', content: source.content, author: source.answer.author || '' }), signal: AbortSignal.timeout(300000) });
        const result = await upstream.json(); if (!upstream.ok || result.error) return send(res, 502, { error: result.error || '结构图生成失败。' });
        await store.saveAnswerMap({ answerId, questionId: answerId.split('-')[0], payload: result.map, sourceHash, model: config.aiModel, promptVersion: PROMPT_VERSION });
        await store.act(user, { questionId: answerId.split('-')[0], answerId, action: 'map' });
        return send(res, 200, { answerId, map: result.map, cacheHit: false });
      }

      if (req.method === 'POST' && path === '/api/collide') {
        const user = await currentUser(req); if (!user) return send(res, 401, { error: '请先使用知乎账号登录。' });
        const input = await jsonBody(req); const refs = input.refs || [];
        if (refs.length !== 2) return send(res, 400, { error: '需要恰好两个节点。' });
        const normalized = refs.map(ref => ({ answerId: String(ref.answerId), nodeId: String(ref.nodeId) })).sort((a, b) => `${a.answerId}:${a.nodeId}`.localeCompare(`${b.answerId}:${b.nodeId}`));
        const questionId = input.questionId || normalized[0].answerId.split('-')[0];
        const cacheKey = sha256({ questionId, refs: normalized, model: config.aiModel, version: COLLISION_VERSION });
        const cached = await store.getCollisionCache(cacheKey); if (cached) return send(res, 200, { ...cached, cacheHit: true });
        const dataset = datasetValue(await store.getDataset()); const contexts = [];
        for (const ref of refs) { const source = answerFrom(dataset, ref.answerId); const map = await store.getAnswerMap(ref.answerId); if (!source || !map?.payload) return send(res, 400, { status: 'blocked', reason: '所选回答缺少正文或结构图。' }); contexts.push({ answerId: ref.answerId, author: source.answer.author || '', questionTitle: source.question.title || '', content: source.content, map: map.payload }); }
        const upstream = await fetch(`${collideBase}/collide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, questionId, answerContexts: contexts }), signal: AbortSignal.timeout(300000) });
        const result = await upstream.json();
        await store.saveCollisionCache({ cacheKey, questionId, answerIds: normalized.map(item => item.answerId), nodeIds: normalized.map(item => item.nodeId), result, model: config.aiModel, promptVersion: COLLISION_VERSION });
        return send(res, 200, { ...result, cacheHit: false });
      }

      if (req.method === 'GET' && (path === '/content/data.js' || path === '/content/collision-maps.js')) {
        const body = path.endsWith('data.js') ? privateDataScript(datasetValue(await store.getDataset())) : publicMapScript(await store.getAnswerMaps());
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(body);
      }

      const vendorFile = /^\/web\/vendor\/katex\/(?:katex\.min\.(?:js|css)|fonts\/KaTeX_[\w-]+\.(?:woff2?|ttf))$/.test(path) ? path.slice(1) : '';
      if (req.method === 'GET' && (files.has(path) || /^\/question\/[\w-]+$/.test(path) || vendorFile)) {
        const file = vendorFile || files.get(path) || 'web/question.html'; const data = await readFile(resolve(root, file));
        const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' }[extname(file)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.zhimg.com; connect-src 'self'; frame-ancestors 'none'" }); return res.end(data);
      }
      return send(res, 404, { error: 'Not found' });
    } catch (error) {
      console.error('[server]', error);
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : '服务处理失败，请查看云托管日志。' }); else res.end();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = await configuration();
  const store = await createStore(config);
  const server = createServer(config, store);
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${config.port} 已被占用。` : error.message); process.exitCode = 1; });
  server.listen(config.port, config.host, () => console.log(`回答节点碰撞站 http://${config.host}:${config.port} | database=${config.useDatabase} | model=${config.aiModel}`));
}
