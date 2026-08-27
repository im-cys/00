/**
 * study.js —— 回答代理对话页的交互控制器
 *
 * 负责：
 * 1. 根据 URL 中的会话 id 读取目标问题和回答；
 * 2. 渲染多轮对话、观点线索和代理理解度；
 * 3. 在原型阶段用规则模拟回答代理回复；
 * 4. 对话结束后生成候选观点与可复制回复；
 * 5. 把用户确认的观点写回主网页使用的 localStorage。
 *
 * generateAgentReply() 目前只是演示规则。接入真实 AI 后，应替换为后端流式接口。
 */

// ---------- 与主网页共享的本地数据键 ----------
const SESSION_KEY = 'viewpointAgentSessions';
const MEMORY_KEY = 'viewpointAgentMemories';

// 直接访问 /study 或找不到会话时使用的兜底演示内容。
const fallbackSession = {
  id: 'remote-work',
  question: '远程办公会成为未来的主流工作方式吗？',
  author: '理性的乐观派',
  answer: '远程办公当然会越来越普遍，因为它降低了通勤成本，也让公司能够招聘不同城市的人。但它并不会完全取代办公室。真正决定远程办公效果的，不是员工在什么地方，而是团队有没有建立清晰的异步沟通方式、目标和责任边界。没有这些规则，所谓自由只会变成随时在线。',
  summary: '你更关注协作规则，而不是办公地点本身',
  updatedAt: '今天 14:32',
  turns: 0,
  artifact: '讨论中',
  messages: []
};

// ---------- 读取会话参数与缓存页面节点 ----------
const params = new URLSearchParams(window.location.search);
const sessionId = params.get('id') || fallbackSession.id;
const messagesElement = document.querySelector('#messages');
const introElement = document.querySelector('#chat-intro');
const form = document.querySelector('#conversation-form');
const input = document.querySelector('#conversation-input');
const counter = document.querySelector('#input-counter');
const sourcePanel = document.querySelector('#source-panel');
const insightEmpty = document.querySelector('#insight-empty');
const insightContent = document.querySelector('#insight-content');
const summaryDialog = document.querySelector('#summary-dialog');
const toast = document.querySelector('#toast');

// ---------- 数据安全与本地持久化 ----------
function escapeHTML(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function getSessions() {
  try {
    const sessions = JSON.parse(localStorage.getItem(SESSION_KEY) || '[]');
    return Array.isArray(sessions) ? sessions : [];
  } catch {
    return [];
  }
}

function saveSession(session) {
  const sessions = getSessions();
  const index = sessions.findIndex((item) => item.id === session.id);
  if (index >= 0) sessions[index] = session;
  else sessions.unshift(session);
  localStorage.setItem(SESSION_KEY, JSON.stringify(sessions));
}

let session = getSessions().find((item) => item.id === sessionId) || { ...fallbackSession, id: sessionId };
session.answer ||= fallbackSession.answer;
session.messages ||= [];

// ---------- 基础界面反馈 ----------
function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2400);
}

// 将当前会话的问题、作者和原回答填入左侧来源面板。
function initializeSource() {
  document.title = `${session.question} · 回答代理`;
  document.querySelector('#page-question').textContent = session.question;
  document.querySelector('#source-question').textContent = session.question;
  document.querySelector('#source-author').textContent = session.author || '知乎用户';
  document.querySelector('#source-avatar').textContent = [...(session.author || '知')][0];
  document.querySelector('#source-answer').textContent = session.answer;
}

// ---------- 对话渲染 ----------
function renderMessages() {
  introElement.hidden = session.messages.length > 0;
  messagesElement.replaceChildren();

  session.messages.forEach((message) => {
    const article = document.createElement('article');
    article.className = `chat-message ${message.role}`;
    const user = message.role === 'user';
    article.innerHTML = `
      <span class="message-avatar">${user ? '我' : '代'}</span>
      <div class="message-content">
        <div class="message-label">
          <span>${user ? '你的表达' : '回答代理'}</span>
          ${message.inferred ? '<span class="inference-tag">AI 推演</span>' : '<span>基于原回答</span>'}
        </div>
        <p>${escapeHTML(message.content)}</p>
      </div>
    `;
    messagesElement.appendChild(article);
  });
  messagesElement.scrollTop = messagesElement.scrollHeight;
  updateInsights();
}

// 在模拟回复的等待时间里显示三个跳动圆点。
function addTyping() {
  const article = document.createElement('article');
  article.className = 'chat-message';
  article.id = 'typing-message';
  article.innerHTML = `
    <span class="message-avatar">代</span>
    <div class="message-content"><div class="message-label"><span>回答代理</span><span>正在理解</span></div><div class="typing-dots"><span></span><span></span><span></span></div></div>
  `;
  messagesElement.appendChild(article);
  messagesElement.scrollTop = messagesElement.scrollHeight;
}

// ---------- 原型回复生成器 ----------
// 根据用户输入关键词和当前轮次返回示例回复；生产版应删除并调用后端模型。
function generateAgentReply(userText) {
  const normalized = userText.toLowerCase();
  const turn = session.messages.filter((message) => message.role === 'user').length;

  if (normalized.includes('概括') || normalized.includes('核心')) {
    return {
      content: '这篇回答的核心立场可以概括为三点：第一，远程办公会继续普及；第二，它不会完全取代办公室；第三，真正影响结果的不是地点，而是异步沟通、目标与责任边界。\n\n你对哪一点最有反应？',
      inferred: false
    };
  }

  if (normalized.includes('不同意') || normalized.includes('反驳')) {
    return {
      content: '先不急着替原回答辩护。你不同意的是“远程办公会继续普及”这个判断，还是不同意它把问题主要归因于协作规则？这两个分歧需要不同的论证。',
      inferred: true
    };
  }

  if (normalized.includes('赞同') || normalized.includes('同意')) {
    return {
      content: '你已经表达了基本认同，但似乎仍然觉得原回答少了一个条件。这个条件更接近管理能力、员工自律，还是行业本身是否适合远程？',
      inferred: true
    };
  }

  if (turn <= 1) {
    return {
      content: `我听到你更在意“${userText.slice(0, 30)}${userText.length > 30 ? '……' : ''}”。这与原回答强调协作规则有一点关联，但还不能确定你是在赞同、补充，还是改变它的因果关系。你愿意再说说为什么这点最重要吗？`,
      inferred: true
    };
  }

  if (turn === 2) {
    return {
      content: '这让你的立场更清楚了：你并不是简单支持或反对远程办公，而是在追问“组织是否为自由建立了足够的基础设施”。如果团队没有这些规则，你认为应该回到办公室，还是应该先改变管理方式？',
      inferred: true
    };
  }

  return {
    content: '我试着把你的观点压缩成一句话：办公地点不是决定因素，真正需要被评价的是团队是否建立了与自由相匹配的协作责任。这个表述符合你吗？如果不符合，最需要修改的是哪一个词？',
    inferred: true
  };
}

// 从用户最近表达中生成右侧“观点线索”，但不会自动写入长期记忆。
function updateInsights() {
  const userMessages = session.messages.filter((message) => message.role === 'user');
  if (!userMessages.length) return;
  insightEmpty.hidden = true;
  insightContent.hidden = false;

  const latest = userMessages[userMessages.length - 1].content;
  document.querySelector('#insight-stance').textContent = userMessages.length > 1
    ? '你更关注自由背后的协作规则，而不是简单选择远程或办公室。'
    : `你正在强调：${latest.slice(0, 38)}${latest.length > 38 ? '……' : ''}`;
  document.querySelector('#insight-difference').textContent = userMessages.length > 2
    ? '原回答强调趋势判断，你更在意组织是否承担相应的管理责任。'
    : '还需要更多表达，才能区分你是在补充还是反驳。';

  const understanding = Math.min(86, 18 + userMessages.length * 17);
  document.querySelector('#understanding-value').textContent = `${understanding}%`;
  document.querySelector('#understanding-bar').style.width = `${understanding}%`;
}

// 发送一条消息：先保存用户消息，再延迟加入模拟代理回复。
function sendMessage(content) {
  const trimmed = content.trim();
  if (!trimmed) return;
  session.messages.push({ role: 'user', content: trimmed, createdAt: new Date().toISOString() });
  session.turns = session.messages.filter((message) => message.role === 'user').length;
  session.updatedAt = '刚刚';
  saveSession(session);
  renderMessages();
  input.value = '';
  autoResizeInput();
  counter.textContent = '0 / 1200';
  addTyping();

  setTimeout(() => {
    document.querySelector('#typing-message')?.remove();
    const reply = generateAgentReply(trimmed);
    session.messages.push({ role: 'assistant', ...reply, createdAt: new Date().toISOString() });
    saveSession(session);
    renderMessages();
  }, 650);
}

// 输入框随内容增高，但最多增长到 150px。
function autoResizeInput() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
}

// ---------- 对话成果整理 ----------
// 生成可编辑的候选观点和可复制回复，最终是否保存由用户决定。
function buildSummary() {
  const userMessages = session.messages.filter((message) => message.role === 'user');
  const last = userMessages[userMessages.length - 1]?.content || '';
  const claim = userMessages.length >= 2
    ? '相比办公地点本身，我更在意组织是否建立了与灵活工作相匹配的协作规则和责任边界。'
    : last || '我还需要更多讨论，才能形成稳定观点。';
  const draft = `我基本认同远程办公的效果取决于协作方式，但我想再补充一点：问题不只是员工能否自律，也在于组织是否为异步沟通、目标确认和责任边界建立了明确规则。没有这些基础，所谓自由很容易变成个人承担额外的协调成本。因此，比起争论远程或办公室哪一个更好，我更愿意先看团队有没有与这种工作方式相匹配的管理能力。`;
  document.querySelector('#summary-claim').value = claim;
  document.querySelector('#reply-draft').textContent = draft;
}

// ---------- 页面事件绑定 ----------
form.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage(input.value);
});

input.addEventListener('input', () => {
  counter.textContent = `${[...input.value].length} / 1200`;
  autoResizeInput();
});

document.querySelectorAll('[data-prompt]').forEach((button) => {
  button.addEventListener('click', () => sendMessage(button.dataset.prompt));
});

document.querySelector('#toggle-source').addEventListener('click', () => {
  if (window.innerWidth <= 780) sourcePanel.classList.toggle('mobile-open');
  else {
    sourcePanel.classList.toggle('collapsed');
    document.querySelector('.conversation-layout').style.gridTemplateColumns = sourcePanel.classList.contains('collapsed')
      ? '0 minmax(480px,1fr) 270px'
      : '';
  }
});

document.querySelector('#source-close').addEventListener('click', () => {
  if (window.innerWidth <= 780) sourcePanel.classList.remove('mobile-open');
  else {
    sourcePanel.classList.add('collapsed');
    document.querySelector('.conversation-layout').style.gridTemplateColumns = '0 minmax(480px,1fr) 270px';
  }
});

// 打开成果弹窗前，至少需要一条用户表达。
document.querySelector('#finish-dialogue').addEventListener('click', () => {
  if (!session.messages.some((message) => message.role === 'user')) {
    showToast('先说出一点真实想法，再整理本次观点');
    return;
  }
  buildSummary();
  summaryDialog.showModal();
});

document.querySelector('#summary-close').addEventListener('click', () => summaryDialog.close());

document.querySelector('#copy-draft').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(document.querySelector('#reply-draft').textContent);
    showToast('回复草稿已复制');
  } catch {
    showToast('复制失败，请手动选择文本');
  }
});

document.querySelector('#save-conversation-only').addEventListener('click', () => {
  session.summary = '本轮讨论已保存，尚未写入长期观点';
  session.artifact = '待确认';
  saveSession(session);
  window.location.href = '/?view=conversations';
});

// 用户明确确认后，才把候选观点写入长期观点记忆。
document.querySelector('#confirm-memory').addEventListener('click', () => {
  const claim = document.querySelector('#summary-claim').value.trim();
  if (!claim) return;
  let memories = [];
  try {
    memories = JSON.parse(localStorage.getItem(MEMORY_KEY) || '[]');
  } catch {
    memories = [];
  }
  memories.unshift({
    id: `memory-${Date.now()}`,
    topic: '工作方式',
    claim,
    rationale: `来自关于“${session.question}”的讨论，由你本人确认。`,
    sources: 1,
    status: 'confirmed',
    updatedAt: '刚刚'
  });
  localStorage.setItem(MEMORY_KEY, JSON.stringify(memories));
  session.summary = claim;
  session.artifact = '已形成观点';
  saveSession(session);
  window.location.href = '/?view=memories';
});

summaryDialog.addEventListener('click', (event) => {
  if (event.target === summaryDialog) summaryDialog.close();
});

// ---------- 对话页启动入口 ----------
initializeSource();
renderMessages();
