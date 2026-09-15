import http from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { root, configuration } from './config.mjs';
import { createStore } from './store.mjs';

const PROMPT_VERSION = 'answer-tree-v2.10-onboarding-quota-reset';
const APP_RELEASE = '2026-09-15.10-consistent-header';
// v2：碰撞判定改为「零成本预检闸门 + 两步模型判定（关系判定带举证责任 → 提问）」。
// 判定口径变了，旧缓存必须失效，否则同一对节点会继续命中 v1 的误判结果。
const COLLISION_VERSION = 'collision-v6-related-perspectives';
const ANSWER_MAP_SCHEMA = 'answer-tree-v2';
const MAP_GENERATION_TIMEOUT_MS = 15 * 60 * 1000;
const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const safeReturnTo = value => /^\/(?!\/)/.test(value || '') ? value : '/';
const cookies = request => Object.fromEntries(String(request.headers.cookie || '').split(';').map(item => item.trim().split('=').map(decodeURIComponent)).filter(parts => parts.length === 2));
const secureFor = (config, request) => String(config.zhihuAuth?.redirectUri || '').startsWith('https:') || String(request?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
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
function currentAnswerMaps(maps) { return Object.fromEntries(Object.entries(maps || {}).filter(([, map]) => map?.schemaVersion === ANSWER_MAP_SCHEMA)); }
function privateDataScript(dataset) { return `window.ZHIHU_DEMO_DATA = ${JSON.stringify(dataset || { questions: [] })};\n`; }
function rawJsonId(text, key) {
  const match = String(text).match(new RegExp(`"${key}"\\s*:\\s*(?:"([^"]+)"|(\\d+))`));
  return match ? (match[1] || match[2]) : '';
}

export function publicMapError(error) {
  const message = String(error?.message || error || '');
  if (/TimeoutError|aborted due to timeout|generation_timeout/i.test(message)) return '本次模型生成超过 15 分钟，任务已停止，请重新生成。';
  if (/缺少 EXTRACT_API_KEY|HTTP 401|unauthorized|invalid.?api.?key|authentication/i.test(message)) return '模型 API Key 无效或未生效，请检查 EXTRACT_API_KEY 并更新服务。';
  if (/HTTP 402|insufficient.?balance|余额不足|账户余额/i.test(message)) return 'DeepSeek 账户余额不足，请充值后重新生成。';
  if (/HTTP 403|forbidden|permission denied/i.test(message)) return '当前 API Key 没有调用该模型的权限，请检查模型权限。';
  if (/HTTP 404|model.?not.?found|unknown model/i.test(message)) return '模型名称或接口地址不正确，请检查 EXTRACT_MODEL 与 EXTRACT_BASE_URL。';
  if (/HTTP 400|invalid.?request|thinking|response_format|max_tokens/i.test(message)) return '模型请求参数不兼容，请更新服务后重新生成。';
  if (/10013|Failed to establish a new connection|ECONNREFUSED|ENETUNREACH|fetch failed|HTTPSConnectionPool|Read timed out|ConnectTimeout|ConnectionError|ProxyError|SSLError|RemoteDisconnected|NameResolutionError|Temporary failure/i.test(message)) return '无法连接模型接口。请检查云服务公网访问和 DeepSeek 接口连通性后重新生成。';
  if (/429|rate.?limit|额度|拥塞/i.test(message)) return '模型接口当前拥塞或额度受限，请稍后重新生成。';
  if (/空 content|empty content|非 JSON 响应|响应结构异常/i.test(message)) return '模型本次没有返回有效 JSON，系统已自动重试；请再次生成。';
  if (/JSON|校验|观点树|collision|support|display_text|root|节点|叶子/i.test(message)) return '模型已返回内容，但没有通过新版观点树校验，请重新生成。';
  return '结构图生成失败，请稍后重试。';
}

export function createServer(config, store) {
  const collideBase = config.collideBase || 'http://127.0.0.1:3311';
  const mapJobs = new Map();
  const traceEvents = new Set(['select_mode_entered', 'answer_selected', 'answer_unselected', 'workbench_opened', 'map_generate_started', 'map_generate_succeeded', 'map_generate_failed', 'map_generate_retried']);
  const audit = async (event, details = {}) => {
    if (!config.operationLogPath) return;
    const clean = {
      at: new Date().toISOString(), event,
      traceId: String(details.traceId || '').slice(0, 80),
      questionId: String(details.questionId || '').slice(0, 40),
      answerId: String(details.answerId || '').slice(0, 80),
      answerIds: Array.isArray(details.answerIds) ? details.answerIds.slice(0, 5).map(value => String(value).slice(0, 80)) : undefined,
      selectedCount: Number.isFinite(details.selectedCount) ? details.selectedCount : undefined,
      status: String(details.status || '').slice(0, 40),
      stage: String(details.stage || '').slice(0, 60),
      durationMs: Number.isFinite(details.durationMs) ? details.durationMs : undefined,
      nodeCount: Number.isFinite(details.nodeCount) ? details.nodeCount : undefined,
      errorCategory: String(details.errorCategory || '').slice(0, 60),
    };
    Object.keys(clean).forEach(key => clean[key] === undefined && delete clean[key]);
    try {
      await mkdir(dirname(config.operationLogPath), { recursive: true });
      await appendFile(config.operationLogPath, `${JSON.stringify(clean)}\n`, 'utf8');
    } catch (error) { console.error('[operation-trace]', error.message); }
  };
  const files = new Map([
    ['/', 'web/index.html'], ['/login', 'web/login.html'], ['/question.html', 'web/question.html'], ['/web/site.js', 'web/site.js'], ['/web/login.js', 'web/login.js'],
    ['/web/styles.css', 'web/styles.css'], ['/web/collision.css', 'web/collision.css'], ['/web/collision.js', 'web/collision.js'], ['/web/collision-core.js', 'web/collision-core.js'],
    ['/web/assets/liu-kanshan-collision-guide.png', 'web/assets/liu-kanshan-collision-guide.png'],
    ['/web/assets/liu-kanshan-onboarding-steps.png', 'web/assets/liu-kanshan-onboarding-steps.png']
  ]);
  const allowedHosts = new Set((config.allowedHosts || []).map(value => value.toLowerCase()));
  const allowedOrigins = new Set(config.allowedOrigins || []);
  const hostName = value => { try { return new URL(`http://${value}`).hostname.toLowerCase(); } catch { return ''; } };
  const sessionInfo = user => ({ user, provider: user?.provider || null, configured: Boolean(config.zhihuAuth?.configured) });
  const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const currentUser = req => store.session(cookies(req).qm_session);
  const validStoredMap = async answerId => {
    const dataset = datasetValue(await store.getDataset());
    const source = answerFrom(dataset, answerId);
    if (!source?.content) return { source: null, cached: null, sourceHash: '' };
    const sourceHash = sha256(source.content);
    const cached = await store.getAnswerMap(answerId);
    const valid = cached && (cached.source_hash || cached.sourceHash) === sourceHash && cached.model === config.aiModel && (cached.prompt_version || cached.promptVersion) === PROMPT_VERSION;
    return { source, cached: valid ? cached : null, sourceHash };
  };
  // 同一问题下已登记的争议对象。跨回答比对靠 axis 相等判断「是否在裁决同一件事」，
  // 所以生成新结构图时要把已有说法带给模型复用，措辞对不齐会退化成词重叠匹配。
  const knownAxesFor = async questionId => {
    try {
      const maps = currentAnswerMaps(await store.getAnswerMaps(questionId));
      const axes = [];
      for (const map of Object.values(maps)) {
        for (const axis of map?.axes || (map?.nodes || []).map(node => node?.axis)) {
          const value = String(axis || '').trim();
          if (value && !axes.includes(value)) axes.push(value);
        }
      }
      return axes.slice(0, 12);
    } catch { return []; }
  };
  const startMapJob = ({ answerId, source, sourceHash, user, traceId }) => {
    const job = { answerId, status: 'processing', startedAt: Date.now(), traceId };
    mapJobs.set(answerId, job);
    void audit('map_generate_started', { traceId, answerId, questionId: answerId.split('-')[0], status: 'processing', stage: 'node_to_extractor' });
    void (async () => {
      try {
        const knownAxes = await knownAxesFor(answerId.split('-')[0]);
        const upstream = await fetch(`${collideBase}/extract-map`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answerId, traceId, questionTitle: source.question.title || '', content: source.content, author: source.answer.author || '', knownAxes }),
          signal: AbortSignal.timeout(MAP_GENERATION_TIMEOUT_MS)
        });
        const upstreamText = await upstream.text();
        let result;
        try { result = JSON.parse(upstreamText); }
        catch { throw new Error(`抽取服务返回了非 JSON 响应（HTTP ${upstream.status}）。`); }
        if (!upstream.ok || result.error || !result.map) throw new Error(result.error || '结构图生成失败。');
        await store.saveAnswerMap({ answerId, questionId: answerId.split('-')[0], payload: result.map, sourceHash, model: config.aiModel, promptVersion: PROMPT_VERSION });
        await store.act(user, { questionId: answerId.split('-')[0], answerId, action: 'map' });
        Object.assign(job, { status: 'ready', map: result.map, finishedAt: Date.now() });
        void audit('map_generate_succeeded', { traceId, answerId, questionId: answerId.split('-')[0], status: 'ready', stage: 'saved', durationMs: job.finishedAt - job.startedAt, nodeCount: result.map.nodes?.length || 0 });
      } catch (error) {
        console.error(`[map:${answerId}]`, error);
        const shownError = publicMapError(error);
        Object.assign(job, { status: 'failed', error: shownError, finishedAt: Date.now() });
        const errorCategory = shownError.includes('超过 15 分钟') ? 'generation_timeout' : shownError.startsWith('无法连接') ? 'model_network' : shownError.startsWith('模型接口') ? 'model_rate_limit' : shownError.includes('校验') ? 'tree_validation' : 'unknown';
        void audit('map_generate_failed', { traceId, answerId, questionId: answerId.split('-')[0], status: 'failed', stage: 'extractor_or_model', durationMs: job.finishedAt - job.startedAt, errorCategory });
      }
    })();
    return job;
  };

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

      if (req.method === 'GET' && path === '/api/health') {
        const databaseCredentialMode = config.cloudbaseApiKey ? 'api-key' : config.cloudbaseSecretId && config.cloudbaseSecretKey ? 'secret-pair' : 'none';
        return send(res, 200, { ok: true, app: 'answer-collision', release: APP_RELEASE, answerMapSchema: ANSWER_MAP_SCHEMA, promptVersion: PROMPT_VERSION, database: config.useDatabase, databaseCredentialConfigured: Boolean(config.cloudbaseApiKey), databaseCredentialMode, model: config.aiModel, modelCredentialConfigured: Boolean(config.aiApiKeyConfigured) });
      }

      if (req.method === 'POST' && path === '/api/admin/import') {
        const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!config.dataImportToken || supplied !== config.dataImportToken) return send(res, 401, { error: '导入令牌无效。' });
        const input = await jsonBody(req, 25 * 1024 * 1024);
        if (!input.data?.questions || !Array.isArray(input.data.questions)) return send(res, 400, { error: 'data.questions 缺失。' });
        const contentHash = sha256(input.data);
        try {
          await store.importDataset(input.data, contentHash);
          let mapCount = 0;
          for (const [answerId, payload] of Object.entries(input.maps || {})) {
            if (payload?.schemaVersion !== ANSWER_MAP_SCHEMA) continue;
            const source = answerFrom(input.data, answerId);
            await store.saveAnswerMap({ answerId, questionId: answerId.split('-')[0], payload, sourceHash: sha256(source?.content || ''), model: input.mapModel || 'imported', promptVersion: input.mapPromptVersion || 'imported-v1' });
            mapCount++;
          }
          return send(res, 200, { ok: true, contentHash, questions: input.data.questions.length, maps: mapCount });
        } catch (error) {
          console.error('[import]', error);
          return send(res, 500, { error: `私有数据导入失败：${String(error?.message || error).slice(0, 500)}` });
        }
      }

      if (req.method === 'POST' && path === '/api/local/trace' && !config.useDatabase) {
        const input = await jsonBody(req, 4000);
        const event = String(input.event || '');
        if (!traceEvents.has(event)) return send(res, 400, { error: '不支持的本地轨迹事件。' });
        await audit(event, input);
        return send(res, 200, { ok: true });
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
          res.writeHead(302, { Location: target.href, 'Set-Cookie': cookie('qm_oauth_nonce', browserNonce, { secure: secureFor(config, req), maxAge: 600 }), 'Cache-Control': 'no-store' }); return res.end();
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
        res.writeHead(302, { Location: pending.returnTo, 'Set-Cookie': [cookie('qm_session', token, { secure: secureFor(config, req) }), cookie('qm_oauth_nonce', '', { clear: true, secure: secureFor(config, req) })], 'Cache-Control': 'no-store' }); return res.end();
      }

      if (req.method === 'POST' && path === '/api/auth/logout') {
        await store.deleteSession(cookies(req).qm_session);
        res.setHeader('Set-Cookie', cookie('qm_session', '', { clear: true, secure: secureFor(config, req) }));
        return send(res, 200, { ok: true });
      }

      // 兼容旧书签和浏览器历史记录：站内登录页不再停留，直接进入知乎授权。
      if (req.method === 'GET' && path === '/login') {
        const returnTo = safeReturnTo(url.searchParams.get('return_to'));
        if (await currentUser(req)) {
          res.writeHead(302, { Location: returnTo, 'Cache-Control': 'no-store' }); return res.end();
        }
        res.writeHead(302, { Location: `/auth/zhihu?return_to=${encodeURIComponent(returnTo)}`, 'Cache-Control': 'no-store' }); return res.end();
      }

      if (req.method === 'GET' && path === '/api/community') {
        const user = await currentUser(req);
        const [snapshot, collisionQuota] = await Promise.all([store.snapshot(user?.id || ''), store.getCollisionQuota(user?.id || '')]);
        return send(res, 200, { ...snapshot, collisionQuota, session: sessionInfo(user) });
      }
      if (req.method === 'POST' && /^\/api\/community\/(action|comment)$/.test(path)) {
        const user = await currentUser(req); if (!user) return send(res, 401, { error: '请先使用知乎账号登录。' });
        const input = await jsonBody(req);
        const snapshot = path.endsWith('/action') ? await store.act(user, input) : await store.comment(user, input);
        return send(res, 200, { ...snapshot, collisionQuota: await store.getCollisionQuota(user.id), session: sessionInfo(user) });
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
      if (req.method === 'GET' && path === '/api/collide/maps') return send(res, 200, { questionId: url.searchParams.get('qid') || '', answers: currentAnswerMaps(await store.getAnswerMaps(url.searchParams.get('qid') || '')) });

      if (req.method === 'GET' && path === '/api/maps/generate') {
        const user = await currentUser(req); if (!user) return send(res, 401, { error: '请先使用知乎账号登录。' });
        const answerId = String(url.searchParams.get('answerId') || '');
        if (!answerId) return send(res, 400, { error: '回答编号不能为空。' });
        const job = mapJobs.get(answerId);
        if (job?.status === 'processing') return send(res, 202, { answerId, status: 'processing' });
        if (job?.status === 'ready') return send(res, 200, { answerId, status: 'ready', map: job.map });
        if (job?.status === 'failed') return send(res, 502, { answerId, status: 'failed', error: job.error });
        const { cached } = await validStoredMap(answerId);
        if (cached) return send(res, 200, { answerId, status: 'ready', map: cached.payload });
        // 云托管可能把轮询分发到另一个实例；该实例看不到内存任务，但能在
        // 任务完成后从数据库读到结果，因此在此期间继续返回处理中。
        return send(res, 202, { answerId, status: 'processing' });
      }

      if (req.method === 'POST' && path === '/api/maps/generate') {
        const user = await currentUser(req); if (!user) return send(res, 401, { error: '请先使用知乎账号登录。' });
        const input = await jsonBody(req); const answerId = String(input.answerId || ''); const traceId = String(input.traceId || '').slice(0, 80);
        if (!answerId) return send(res, 400, { error: '回答编号不能为空。' });
        const { source, cached, sourceHash } = await validStoredMap(answerId);
        if (!source?.content) return send(res, 404, { error: '没有找到这篇回答的私有正文。' });
        if (cached) return send(res, 200, { answerId, status: 'ready', map: cached.payload });
        const existing = mapJobs.get(answerId);
        if (existing?.status === 'processing') return send(res, 202, { answerId, status: 'processing' });
        if (existing) mapJobs.delete(answerId);
        startMapJob({ answerId, source, sourceHash, user, traceId });
        return send(res, 202, { answerId, status: 'processing' });
      }

      if (req.method === 'POST' && path === '/api/collide') {
        const user = await currentUser(req); if (!user) return send(res, 401, { error: '请先使用知乎账号登录。' });
        const input = await jsonBody(req);
        // 点击“开始碰撞”即计一次：缓存命中、模型无结果和生成失败都不能退回次数。
        const collisionQuota = await store.consumeCollisionAttempt(user);
        if (!collisionQuota.allowed) return send(res, 429, { status: 'blocked', code: 'DAILY_COLLISION_LIMIT', error: '今日 10 次碰撞机会已用完，请明天再来。', reason: '今日 10 次碰撞机会已用完，请明天再来。', collisionQuota });
        const refs = input.refs || [];
        if (refs.length !== 2) return send(res, 400, { status: 'blocked', error: '需要恰好两个节点。', reason: '需要恰好两个节点。', collisionQuota });
        const normalized = refs.map(ref => ({ answerId: String(ref.answerId), nodeId: String(ref.nodeId) })).sort((a, b) => `${a.answerId}:${a.nodeId}`.localeCompare(`${b.answerId}:${b.nodeId}`));
        const questionId = input.questionId || normalized[0].answerId.split('-')[0];
        const cacheKey = sha256({ questionId, refs: normalized, model: config.aiModel, version: COLLISION_VERSION });
        const cached = await store.getCollisionCache(cacheKey); if (cached) return send(res, 200, { ...cached, cacheHit: true, collisionQuota });
        const dataset = datasetValue(await store.getDataset()); const contexts = [];
        for (const ref of refs) { const source = answerFrom(dataset, ref.answerId); const map = await store.getAnswerMap(ref.answerId); if (!source || !map?.payload) return send(res, 400, { status: 'blocked', reason: '所选回答缺少正文或结构图。', collisionQuota }); contexts.push({ answerId: ref.answerId, author: source.answer.author || '', questionTitle: source.question.title || '', content: source.content, map: map.payload }); }
        let result;
        try {
          const upstream = await fetch(`${collideBase}/collide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, questionId, answerContexts: contexts }), signal: AbortSignal.timeout(300000) });
          result = await upstream.json();
        } catch {
          return send(res, 502, { status: 'blocked', reason: '碰撞服务暂时不可用，本次尝试仍计入今日次数。', collisionQuota });
        }
        await store.saveCollisionCache({ cacheKey, questionId, answerIds: normalized.map(item => item.answerId), nodeIds: normalized.map(item => item.nodeId), result, model: config.aiModel, promptVersion: COLLISION_VERSION });
        return send(res, 200, { ...result, cacheHit: false, collisionQuota });
      }

      if (req.method === 'GET' && (path === '/content/data.js' || path === '/content/collision-maps.js')) {
        const body = path.endsWith('data.js') ? privateDataScript(datasetValue(await store.getDataset())) : publicMapScript(currentAnswerMaps(await store.getAnswerMaps()));
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(body);
      }

      const vendorFile = /^\/web\/vendor\/katex\/(?:katex\.min\.(?:js|css)|fonts\/KaTeX_[\w-]+\.(?:woff2?|ttf))$/.test(path) ? path.slice(1) : '';
      const pageRequest = path === '/' || path === '/question.html' || /^\/question\/[\w-]+$/.test(path);
      if (req.method === 'GET' && pageRequest && !await currentUser(req)) {
        const returnTo = safeReturnTo(req.url);
        res.writeHead(302, { Location: `/auth/zhihu?return_to=${encodeURIComponent(returnTo)}`, 'Cache-Control': 'no-store' }); return res.end();
      }
      if (req.method === 'GET' && (files.has(path) || /^\/question\/[\w-]+$/.test(path) || vendorFile)) {
        const file = vendorFile || files.get(path) || 'web/question.html'; const data = await readFile(resolve(root, file));
        const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' }[extname(file)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', Pragma: 'no-cache', Expires: '0', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.zhimg.com; connect-src 'self'; frame-ancestors 'none'" }); return res.end(data);
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
  if (config.pruneObsoleteMaps && store.pruneAnswerMaps) {
    const removed = await store.pruneAnswerMaps(ANSWER_MAP_SCHEMA, PROMPT_VERSION);
    if (removed) console.log(`已删除 ${removed} 份旧版回答结构图及其相关碰撞缓存（保留原文、社区数据与当前版本缓存）。`);
  }
  const server = createServer(config, store);
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${config.port} 已被占用。` : error.message); process.exitCode = 1; });
  server.listen(config.port, config.host, () => console.log(`回答节点碰撞站 http://${config.host}:${config.port} | database=${config.useDatabase} | model=${config.aiModel}`));
}
