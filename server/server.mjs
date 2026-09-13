import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { root, configuration } from './config.mjs';
import { createCommunityStore } from './community-store.mjs';

const cookies = request => Object.fromEntries(String(request.headers.cookie || '').split(';').map(item => item.trim().split('=').map(decodeURIComponent)).filter(parts => parts.length === 2));
const sessionCookie = (token, clear = false) => `qm_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 2592000}`;
const safeReturnTo = value => /^\/(?!\/)/.test(value || '') ? value : '/';

export function createServer(config, communityStore = createCommunityStore()) {
  const oauthStates = new Map();
  const collideBase = config.collideBase || 'http://127.0.0.1:3311';
  const files = new Map([
    ['/', 'web/index.html'],
    ['/question.html', 'web/question.html'],
    ['/web/site.js', 'web/site.js'],
    ['/web/styles.css', 'web/styles.css'],
    ['/web/collision.css', 'web/collision.css'],
    ['/web/collision.js', 'web/collision.js'],
    ['/web/collision-core.js', 'web/collision-core.js']
  ]);
  const privateFiles = new Map([
    ['/content/data.js', ['data.js', 'web/data.empty.js']],
    ['/content/collision-maps.js', ['collision-maps.js', 'web/collision-maps.empty.js']]
  ]);
  const allowedHosts = new Set((config.allowedHosts || []).map(value => value.toLowerCase()));
  const allowedOrigins = new Set(config.allowedOrigins || []);
  const hostName = value => {
    try { return new URL(`http://${value}`).hostname.toLowerCase(); } catch { return ''; }
  };
  const sessionInfo = user => ({ user, provider: 'zhihu', configured: Boolean(config.zhihuAuth?.configured), demoMode: Boolean(config.zhihuAuth?.demoMode) });
  const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };

  const srv = http.createServer(async (req, res) => {
    try {
      const requestHost = hostName(req.headers.host || '');
      if (!requestHost || (!allowedHosts.has('*') && !allowedHosts.has(requestHost))) return send(res, 403, { error: 'Host denied' });
      const origin = req.headers.origin;
      let sameOrigin = false;
      try { sameOrigin = new URL(origin).host === req.headers.host; } catch {}
      if (origin && !sameOrigin && !allowedOrigins.has(origin)) return send(res, 403, { error: 'Origin denied' });
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
      const path = new URL(req.url, 'http://127.0.0.1').pathname;

      if (req.method === 'GET' && path === '/api/health') return send(res, 200, { ok: true, app: 'zhihu-mock-site', configSource: config.configSource });

      // ---- 碰撞链路：转发到 Python 碰撞服务 ----
      // Node 不重写判定逻辑。evidence 回查闸门（quote 三级定位 + 两道关卡）
      // 已在 401 个节点上实测验证，重写等于把已验证算法再实现一遍，风险大于收益。
      if (req.method === 'GET' && path === '/api/collide/health') {
        try {
          const upstream = await fetch(`${collideBase}/health`);
          return send(res, 200, { ...(await upstream.json()), connected: true });
        } catch (error) {
          return send(res, 200, { ok: false, connected: false, error: '碰撞服务未启动。请先运行 启动碰撞服务.cmd' });
        }
      }

      if (req.method === 'GET' && path === '/api/collide/maps') {
        const qid = new URL(req.url, 'http://127.0.0.1').searchParams.get('qid') || '';
        try {
          const upstream = await fetch(`${collideBase}/maps?qid=${encodeURIComponent(qid)}`);
          return send(res, 200, await upstream.json());
        } catch (error) {
          return send(res, 503, { error: '碰撞服务未启动，无法获取结构图。' });
        }
      }

      if (req.method === 'POST' && path === '/api/collide') {
        if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, { error: 'JSON required' });
        let bytes = 0, buffers = [];
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 20000) return send(res, 413, { error: '请求过大。' }); buffers.push(chunk); }
        try {
          // 免费档模型 429 频繁，单次调用最多重试 12 次，需显式放宽超时（默认会早于模型返回就断开）
          const upstream = await fetch(`${collideBase}/collide`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: Buffer.concat(buffers),
            signal: AbortSignal.timeout(300000)
          });
          return send(res, 200, await upstream.json());
        } catch (error) {
          return send(res, 200, { status: 'blocked', reason: `碰撞服务未响应：${error.message}。请确认「启动碰撞服务.cmd」正在运行，或稍后重试（免费额度拥塞时较慢）。` });
        }
      }

      if (req.method === 'GET' && path === '/api/auth/session') {
        const user = await communityStore.session(cookies(req).qm_session);
        return send(res, 200, sessionInfo(user));
      }

      if (req.method === 'GET' && path === '/auth/zhihu') {
        const returnTo = safeReturnTo(new URL(req.url, 'http://127.0.0.1').searchParams.get('return_to'));
        if (config.zhihuAuth?.configured) {
          const state = randomUUID(); oauthStates.set(state, { returnTo, createdAt: Date.now() });
          const target = new URL(config.zhihuAuth.authorizationUrl);
          target.searchParams.set('response_type', 'code');
          target.searchParams.set('client_id', config.zhihuAuth.clientId);
          target.searchParams.set('redirect_uri', config.zhihuAuth.redirectUri);
          target.searchParams.set('scope', config.zhihuAuth.scope);
          target.searchParams.set('state', state);
          res.writeHead(302, { Location: target.href, 'Cache-Control': 'no-store' }); return res.end();
        }
        if (config.zhihuAuth?.demoMode) {
          const suffix = randomUUID().slice(0, 6);
          const user = { id: `zhihu-demo-${suffix}`, name: `知乎试用用户 ${suffix.toUpperCase()}`, avatar: '', provider: 'zhihu-demo' };
          const token = await communityStore.createSession(user);
          res.writeHead(302, { Location: returnTo, 'Set-Cookie': sessionCookie(token), 'Cache-Control': 'no-store' }); return res.end();
        }
        return send(res, 503, { error: '知乎登录尚未配置，请先取得知乎授权应用并填写服务端配置。' });
      }

      if (req.method === 'GET' && path === '/auth/zhihu/callback') {
        try {
          const query = new URL(req.url, 'http://127.0.0.1').searchParams;
          const state = query.get('state'), code = query.get('code'), pending = oauthStates.get(state);
          oauthStates.delete(state);
          if (!code || !pending || Date.now() - pending.createdAt > 10 * 60 * 1000) throw new Error('知乎登录状态已过期，请重试。');
          const tokenResponse = await fetch(config.zhihuAuth.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: config.zhihuAuth.clientId, client_secret: config.zhihuAuth.clientSecret, redirect_uri: config.zhihuAuth.redirectUri }) });
          if (!tokenResponse.ok) throw new Error('知乎授权码交换失败。');
          const tokenData = await tokenResponse.json();
          if (!tokenData.access_token) throw new Error('知乎未返回访问令牌。');
          const profileResponse = await fetch(config.zhihuAuth.profileUrl, { headers: { Authorization: `Bearer ${tokenData.access_token}`, 'Accept': 'application/json' } });
          if (!profileResponse.ok) throw new Error('无法读取知乎用户资料。');
          const profile = await profileResponse.json();
          const id = String(profile.id || profile.uid || profile.url_token || '').trim();
          if (!id) throw new Error('知乎用户资料缺少账号编号。');
          const user = { id: `zhihu-${id}`, name: String(profile.name || profile.fullname || '知乎用户').slice(0, 80), avatar: String(profile.avatar_url || profile.avatar || '').slice(0, 500), provider: 'zhihu' };
          const token = await communityStore.createSession(user);
          res.writeHead(302, { Location: pending.returnTo, 'Set-Cookie': sessionCookie(token), 'Cache-Control': 'no-store' }); return res.end();
        } catch (error) { return send(res, 502, { error: error.message }); }
      }

      if (req.method === 'POST' && path === '/api/auth/logout') {
        await communityStore.deleteSession(cookies(req).qm_session);
        res.setHeader('Set-Cookie', sessionCookie('', true));
        return send(res, 200, { ok: true });
      }

      if (req.method === 'GET' && path === '/api/community') {
        const user = await communityStore.session(cookies(req).qm_session);
        const snapshot = await communityStore.snapshot(user?.id || '');
        return send(res, 200, { ...snapshot, session: sessionInfo(user) });
      }

      if (req.method === 'POST' && /^\/api\/community\/(action|comment)$/.test(path)) {
        const user = await communityStore.session(cookies(req).qm_session);
        if (!user) return send(res, 401, { error: '请先使用知乎账号登录。' });
        if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, { error: 'JSON required' });
        let bytes = 0, buffers = [];
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 20000) return send(res, 413, { error: '请求过大。' }); buffers.push(chunk); }
        let input;
        try { input = JSON.parse(Buffer.concat(buffers).toString('utf8')); } catch { return send(res, 400, { error: 'JSON 格式不正确。' }); }
        try {
          const snapshot = path.endsWith('/action') ? await communityStore.act(user, input) : await communityStore.comment(user, input);
          return send(res, 200, { ...snapshot, session: sessionInfo(user) });
        } catch (error) { return send(res, 400, { error: error.message }); }
      }

      const vendorFile = /^\/web\/vendor\/katex\/(?:katex\.min\.(?:js|css)|fonts\/KaTeX_[\w-]+\.(?:woff2?|ttf))$/.test(path) ? path.slice(1) : '';
      if (req.method === 'GET' && (privateFiles.has(path) || files.has(path) || /^\/question\/[\w-]+$/.test(path) || vendorFile)) {
        let file = vendorFile || files.get(path) || 'web/question.html';
        let data;
        if (privateFiles.has(path)) {
          const [privateName, fallback] = privateFiles.get(path);
          file = privateName;
          try { data = await readFile(resolve(config.privateDataDir, privateName)); }
          catch (error) { if (error.code !== 'ENOENT') throw error; file = fallback; data = await readFile(resolve(root, fallback)); }
        } else data = await readFile(resolve(root, file));
        const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' }[extname(file)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.zhimg.com; connect-src 'self'; frame-ancestors 'none'" });
        return res.end(data);
      }

      send(res, 404, { error: 'Not found' });
    } catch { if (!res.headersSent) send(res, 500, { error: '本地服务处理失败。' }); else res.end(); }
  });
  return srv;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = await configuration();
  const server = createServer(config);
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `端口 ${config.port} 已被占用，请先检查已有服务。` : e.message); process.exitCode = 1; });
  server.listen(config.port, config.host, () => console.log(`知乎页面模拟 http://${config.host}:${config.port} | 配置来源 ${config.configSource}`));
}
