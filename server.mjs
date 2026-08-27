/**
 * server.mjs —— 原型的最小 Node.js HTTP 服务器
 *
 * 负责：
 * 1. 提供 index.html、study.html、CSS 和 JavaScript 静态资源；
 * 2. 把 /dashboard 指向主网页，把 /conversation 指向对话页；
 * 3. 提供 /api/health，便于部署平台检查服务是否在线；
 * 4. 为浏览器扩展提供规则型回答代理与观点整理接口。
 *
 * 当前不负责账户、数据库或真实模型请求。接入真实后端时，可保留接口形状，
 * 再用模型和数据库替换 generatePrototypeReply() 等原型函数。
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';

// 部署平台通常会注入 PORT；本地运行时默认使用 3000。
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

// 只允许访问清单中的静态文件，避免把工作目录中的其他文件暴露出去。
const staticFiles = new Map([
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/study.js', { file: 'study.js', type: 'text/javascript; charset=utf-8' }],
  ['/downloads/viewpoint-agent-extension.zip', { file: 'viewpoint-agent-extension.zip', type: 'application/zip' }]
]);

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    // 原型允许本地扩展访问；正式部署时应限制为自己的扩展和网页来源。
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  response.end(JSON.stringify(value));
}

// 限制请求体大小，避免扩展意外把整张网页发送到服务端。
async function readJson(request, maxBytes = 120_000) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

// 根据用户最近一句表达生成演示回复；未来由真实模型接口替换。
function generatePrototypeReply({ question = '', answer = '', messages = [] }) {
  const userMessages = messages.filter((message) => message.role === 'user');
  const latest = String(userMessages.at(-1)?.content || '').trim();
  const latestPoint = latest.replace(/[。！？!?]+$/, '');
  const turn = userMessages.length;

  if (/概括|核心|总结/.test(latest)) {
    const excerpt = answer.replace(/\s+/g, ' ').slice(0, 110);
    return `这篇回答的核心判断可以先概括为：${excerpt}${answer.length > 110 ? '……' : ''}\n\n其中哪一个前提最值得你继续追问？`;
  }

  if (/不同意|反驳|不认同/.test(latest)) {
    return '先不急着替原回答辩护。你不同意的是它的结论、推理过程，还是它遗漏了重要条件？把分歧放到这三层中的一层，会更容易形成有力回应。';
  }

  if (/赞同|同意|认同/.test(latest)) {
    return '你表达了基本认同，但似乎还想补充一个适用条件。这个条件影响的是结论是否成立，还是只影响结论适用的范围？';
  }

  if (turn <= 1) {
    return `我听到你更在意“${latestPoint.slice(0, 36)}${latestPoint.length > 36 ? '……' : ''}”。这可能是在补充原回答，也可能是在改变它的判断标准。你为什么认为这一点最重要？`;
  }

  if (turn === 2) {
    return `你的立场开始清楚了。围绕“${question.slice(0, 34)}${question.length > 34 ? '……' : ''}”，你并不是简单赞同或反对，而是在追问原回答没有展开的条件。什么情况会让你改变现在的判断？`;
  }

  return '我试着压缩你的观点：你接受原回答的一部分判断，但认为它必须补充条件和责任边界。这个表述符合你吗？如果不符合，最需要修改的是哪一个词？';
}

function generatePrototypeSummary({ question = '', messages = [] }) {
  const userMessages = messages.filter((message) => message.role === 'user');
  const latest = String(userMessages.at(-1)?.content || '').trim();
  const point = latest.replace(/[。！？!?]+$/, '');
  const claim = latest
    ? `在“${question.slice(0, 28)}${question.length > 28 ? '……' : ''}”这个问题上，我更在意结论成立的条件与责任边界。`
    : '我还需要更多讨论，才能形成稳定观点。';
  const draft = userMessages.length
    ? `我理解这篇回答的主要判断，但想补充一个容易被忽略的部分：${point}。如果不把适用条件和责任边界说清楚，一个看似合理的结论也可能在现实中产生完全不同的结果。因此，我更愿意先讨论这个判断在什么情况下成立，再决定是否接受最终结论。`
    : '请先完成至少一轮讨论，再生成回复草稿。';

  return { claim, draft };
}

// 统一读取与返回静态文件；原型阶段关闭缓存，方便修改后立即刷新查看。
async function sendFile(response, filename, contentType) {
  try {
    const content = await readFile(new URL(`./${filename}`, import.meta.url));
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store'
    });
    response.end(content);
  } catch {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('页面资源读取失败');
  }
}

// ---------- 路由入口 ----------
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {});
    return;
  }

  // 服务健康检查，不读取任何用户数据。
  if (url.pathname === '/api/health') {
    sendJson(response, 200, {
      ok: true,
      product: '观点分身',
      stage: 'interactive-prototype',
      serverTime: new Date().toISOString()
    });
    return;
  }

  // 浏览器扩展发送选中的问题、回答和本轮消息，得到一条规则型演示回复。
  if (request.method === 'POST' && url.pathname === '/api/agent/respond') {
    try {
      const payload = await readJson(request);
      sendJson(response, 200, {
        reply: generatePrototypeReply(payload),
        inferred: true,
        prototype: true
      });
    } catch (error) {
      const tooLarge = error.message === 'REQUEST_TOO_LARGE';
      sendJson(response, tooLarge ? 413 : 400, {
        error: tooLarge ? '请求内容过长' : '请求格式不正确'
      });
    }
    return;
  }

  // 对话结束后生成候选观点和回复草稿，仍需用户本人确认。
  if (request.method === 'POST' && url.pathname === '/api/agent/summarize') {
    try {
      const payload = await readJson(request);
      sendJson(response, 200, {
        ...generatePrototypeSummary(payload),
        prototype: true
      });
    } catch (error) {
      const tooLarge = error.message === 'REQUEST_TOO_LARGE';
      sendJson(response, tooLarge ? 413 : 400, {
        error: tooLarge ? '请求内容过长' : '请求格式不正确'
      });
    }
    return;
  }

  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  // 产品首页与个人中心共用 index.html，由 app.js 决定显示哪一层。
  if (url.pathname === '/' || url.pathname === '/dashboard') {
    await sendFile(response, 'index.html', 'text/html; charset=utf-8');
    return;
  }

  // 单次回答代理对话页。
  if (url.pathname === '/study' || url.pathname === '/conversation') {
    await sendFile(response, 'study.html', 'text/html; charset=utf-8');
    return;
  }

  const staticEntry = staticFiles.get(url.pathname);
  if (staticEntry) {
    await sendFile(response, staticEntry.file, staticEntry.type);
    return;
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Page not found');
});

server.listen(port, host, () => {
  console.log(`观点分身原型已启动：http://localhost:${port}`);
});
