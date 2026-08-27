/**
 * app.js —— 独立主网页的交互控制器
 *
 * 负责：
 * 1. 产品首页与个人中心之间的切换；
 * 2. “概览 / 我的代理 / 观点记忆 / 对话记录 / 创作草稿”五个视图的渲染；
 * 3. CloudBase 真实登录、注册、短信验证和会话恢复；
 * 4. 手动导入回答、确认观点等原型交互；
 * 5. 在云端数据库接入前，继续使用 localStorage 暂存观点和对话数据。
 *
 * 不负责：云端业务数据库和真实模型调用。这些能力接入后应由后端 API 替换。
 */

import {
  beginPhoneBinding,
  beginRegistration,
  beginSmsSignIn,
  completeOtpVerification,
  getAuthenticatedAccount,
  setNickname,
  signInWithPassword,
  signOutAccount,
  toLocalProfile
} from './cloudbase-auth.js';

// ---------- 本地数据键：app.js 与 study.js 通过这些键共享原型数据 ----------
const USER_KEY = 'viewpointAgentUser';
const MEMORY_KEY = 'viewpointAgentMemories';
const SESSION_KEY = 'viewpointAgentSessions';

// ---------- 页面外壳：这些节点在 index.html 中定义 ----------
const landing = document.querySelector('#landing');
const dashboard = document.querySelector('#dashboard');
const authDialog = document.querySelector('#auth-dialog');
const bindPhoneDialog = document.querySelector('#bind-phone-dialog');
const dialogueDialog = document.querySelector('#dialogue-dialog');
const extensionDialog = document.querySelector('#extension-dialog');
const viewContainer = document.querySelector('#view-container');
const viewTitle = document.querySelector('#view-title');
const toast = document.querySelector('#toast');

// 验证码回调只在当前页面内短暂保留，不写入 localStorage。
const pendingVerifications = {
  smsLogin: null,
  emailRegister: null,
  phoneRegister: null,
  phoneBinding: null
};

// ---------- 演示数据：首次进入原型时用于填充个人中心 ----------
const sampleMemories = [
  {
    id: 'memory-1',
    topic: '工作方式',
    claim: '自由需要以清晰的协作边界为前提',
    rationale: '你支持灵活办公，但认为团队必须先建立异步沟通规则，不能把协调成本全部交给个人。',
    sources: 3,
    status: 'confirmed',
    updatedAt: '2026-08-25'
  },
  {
    id: 'memory-2',
    topic: '技术伦理',
    claim: '工具效率不能替代人的最终判断',
    rationale: '你愿意使用 AI 扩展表达能力，但最终责任和公开表达必须保留在人身上。',
    sources: 2,
    status: 'confirmed',
    updatedAt: '2026-08-24'
  },
  {
    id: 'memory-3',
    topic: '学习成长',
    claim: '真正有效的学习需要有可以被检验的输出',
    rationale: '相比收藏更多资料，你更看重能否形成自己的解释并用于解决真实问题。',
    sources: 1,
    status: 'confirmed',
    updatedAt: '2026-08-22'
  },
  {
    id: 'memory-4',
    topic: '待确认',
    claim: '你可能更重视长期能力，而不是短期结果',
    rationale: '这个判断来自一次关于职业选择的讨论，还需要你进一步确认适用边界。',
    sources: 1,
    status: 'candidate',
    updatedAt: '2026-08-26'
  }
];

const sampleSessions = [
  {
    id: 'remote-work',
    question: '远程办公会成为未来的主流工作方式吗？',
    author: '理性的乐观派',
    summary: '你更关注协作规则，而不是办公地点本身',
    updatedAt: '今天 14:32',
    turns: 8,
    artifact: '已形成观点'
  },
  {
    id: 'ai-writing',
    question: '使用 AI 辅助写作，会削弱人的表达能力吗？',
    author: '纸上建筑师',
    summary: '你把 AI 看作表达镜子，而不是表达替身',
    updatedAt: '昨天 21:08',
    turns: 11,
    artifact: '已有草稿'
  },
  {
    id: 'career-choice',
    question: '年轻人应该优先选择热爱还是稳定？',
    author: '山和答案',
    summary: '你倾向先建立选择能力，再讨论唯一答案',
    updatedAt: '8月24日',
    turns: 6,
    artifact: '待确认'
  }
];

// ---------- 通用工具与本地数据访问 ----------

// 所有写入 innerHTML 的用户数据都先转义，避免把输入当成 HTML 执行。
function escapeHTML(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  })[character]);
}

function getUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

function getMemories() {
  try {
    const memories = JSON.parse(localStorage.getItem(MEMORY_KEY) || 'null');
    return Array.isArray(memories) ? memories : sampleMemories;
  } catch {
    return sampleMemories;
  }
}

function saveMemories(memories) {
  localStorage.setItem(MEMORY_KEY, JSON.stringify(memories));
}

function getSessions() {
  try {
    const sessions = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return Array.isArray(sessions) ? sessions : sampleSessions;
  } catch {
    return sampleSessions;
  }
}

function saveSessions(sessions) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(sessions));
}

// 轻量提示条，用于反馈“保存成功”“功能尚未接入”等状态。
function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function openModal(dialog) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeModal(dialog) {
  if (dialog.open && typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function setToday() {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  });
  document.querySelector('#today-label').textContent = formatter.format(new Date());
}

// 同步侧边栏用户信息和顶部问候语。
function updateUserUI(user) {
  const name = user?.name || '体验用户';
  const safeName = escapeHTML(name);
  document.querySelector('#sidebar-name').textContent = name;
  document.querySelector('#sidebar-avatar').textContent = [...name][0] || '观';
  viewTitle.innerHTML = `${greeting()}，<span id="welcome-name">${safeName}</span>`;
}

// ---------- 首页 / 个人中心外壳切换 ----------
function showLanding() {
  landing.hidden = false;
  dashboard.hidden = true;
  document.body.style.overflow = '';
}

function showDashboard(user, view = 'overview') {
  landing.hidden = true;
  dashboard.hidden = false;
  document.body.style.overflow = 'hidden';
  updateUserUI(user);
  setToday();
  renderView(view);
}

function confirmedMemoryCount() {
  return getMemories().filter((memory) => memory.status === 'confirmed').length;
}

// ---------- 五个个人中心视图的 HTML 渲染函数 ----------

// 概览：代理成长卡、统计数据、最近对话、待确认记忆和主题理解度。
function renderOverview() {
  const sessions = getSessions();
  const memories = getMemories();
  const user = getUser();
  const confirmed = memories.filter((memory) => memory.status === 'confirmed');
  const candidate = memories.find((memory) => memory.status === 'candidate');
  const sessionRows = sessions.slice(0, 3).map((session, index) => `
    <button class="conversation-row" type="button" data-session-id="${escapeHTML(session.id)}">
      <span class="conversation-source">${['◌', '✦', '↗'][index % 3]}</span>
      <span class="conversation-info">
        <strong>${escapeHTML(session.question)}</strong>
        <span>${escapeHTML(session.summary || `来自 ${session.author || '知乎用户'} 的回答`)}</span>
      </span>
      <span class="conversation-meta">
        <span>${escapeHTML(session.updatedAt || '刚刚')} · ${Number(session.turns || 0)} 轮</span>
        <small>${escapeHTML(session.artifact || '讨论中')}</small>
      </span>
    </button>
  `).join('');

  const candidateMarkup = candidate ? `
    <article class="pending-memory" data-memory-id="${escapeHTML(candidate.id)}">
      <div class="pending-label"><span>${escapeHTML(candidate.topic)}</span><span>需要你的判断</span></div>
      <blockquote>“${escapeHTML(candidate.claim)}”</blockquote>
      <p>${escapeHTML(candidate.rationale)}</p>
      <div class="pending-actions">
        <button class="button button-soft" type="button" data-memory-action="edit">先修改</button>
        <button class="button button-primary" type="button" data-memory-action="confirm">确认是我</button>
      </div>
    </article>
  ` : `
    <article class="pending-memory">
      <div class="pending-label"><span>全部完成</span><span>已整理</span></div>
      <blockquote>暂时没有需要确认的新观点。</blockquote>
      <p>继续进行真实讨论，代理才会提出新的理解。</p>
    </article>
  `;

  const securityPrompt = user && !user.phone ? `
    <section class="security-nudge">
      <span class="security-nudge-icon" aria-hidden="true">⌁</span>
      <div><strong>给账号多一层安全保障</strong><p>绑定手机号后可使用短信快捷登录。暂时不绑定也不影响使用。</p></div>
      <button class="button button-soft" type="button" data-bind-phone>绑定手机号</button>
    </section>
  ` : '';

  viewContainer.innerHTML = `
    ${securityPrompt}
    <section class="dashboard-hero">
      <div class="dashboard-hero-copy">
        <span class="section-kicker">你的代理正在成长</span>
        <h2>它已经开始理解：你如何处理自由、效率与人的最终判断。</h2>
        <p>目前在“工作方式”和“技术伦理”两个主题上最了解你。再完成 2 条确认观点，即可解锁用户代理试运行。</p>
        <div class="level-progress">
          <div class="level-progress-head"><span>L2 · 正在成形</span><span>68%</span></div>
          <div class="level-progress-bar"><span></span></div>
          <p class="level-hint">距离 L3 · 辩手，还需确认 2 条观点</p>
        </div>
      </div>
      <div class="dashboard-agent">
        <div class="agent-orb"><span class="orb-ring ring-one"></span><span class="orb-core"></span></div>
        <div class="dashboard-agent-meta"><span>表达还原度 82%</span><span>4 个主题</span></div>
      </div>
    </section>

    <section class="stats-grid" aria-label="代理数据概览">
      <article class="stat-card"><div class="stat-card-head"><span>已确认观点</span><span class="stat-icon">✦</span></div><strong>${confirmed.length}<small>条</small></strong></article>
      <article class="stat-card"><div class="stat-card-head"><span>有效对话</span><span class="stat-icon">◌</span></div><strong>${sessions.length}<small>次</small></strong></article>
      <article class="stat-card"><div class="stat-card-head"><span>主题覆盖</span><span class="stat-icon">⌁</span></div><strong>4<small>个领域</small></strong></article>
      <article class="stat-card"><div class="stat-card-head"><span>草稿采纳率</span><span class="stat-icon">↗</span></div><strong>67<small>%</small></strong></article>
    </section>

    <section class="content-grid">
      <article class="panel">
        <div class="panel-head"><h3>最近的观点对话</h3><button class="panel-link" type="button" data-jump-view="conversations">查看全部 →</button></div>
        <div class="conversation-list">${sessionRows || '<p>还没有对话记录。</p>'}</div>
      </article>
      <div>
        <article class="panel">
          <div class="panel-head"><h3>待确认记忆</h3><button class="panel-link" type="button" data-jump-view="memories">观点库 →</button></div>
          ${candidateMarkup}
        </article>
        <article class="panel" style="margin-top:18px">
          <div class="panel-head"><h3>主题理解度</h3><button class="panel-link" type="button" data-jump-view="agent">代理档案 →</button></div>
          <div class="topic-bars">
            <div><div class="topic-bar-head"><span>工作方式</span><span>82%</span></div><div class="topic-bar-line"><span style="width:82%"></span></div></div>
            <div><div class="topic-bar-head"><span>技术伦理</span><span>74%</span></div><div class="topic-bar-line"><span style="width:74%;background:#7654d8"></span></div></div>
            <div><div class="topic-bar-head"><span>学习成长</span><span>48%</span></div><div class="topic-bar-line"><span style="width:48%;background:#8baa2e"></span></div></div>
          </div>
        </article>
      </div>
    </section>
  `;
}

// 我的代理：展示代理形象、表达特征、覆盖主题和下一阶段能力。
function renderAgent() {
  viewContainer.innerHTML = `
    <header class="view-header"><h2>我的代理</h2><p>它不是一份固定人格测试，而是你在真实问题中的表达轨迹。</p></header>
    <section class="agent-profile-grid">
      <article class="panel agent-card-large">
        <div class="agent-orb"><span class="orb-ring ring-one"></span><span class="orb-ring ring-two"></span><span class="orb-core"></span></div>
        <h3>L2 · 正在成形</h3>
        <p>观点覆盖逐渐清晰，表达方式仍在学习</p>
        <div class="agent-badges"><span>条件式思考</span><span>重视边界</span><span>克制表达</span></div>
      </article>
      <div class="agent-details">
        <article class="panel">
          <div class="panel-head"><h3>代理如何理解你</h3><span class="memory-topic">基于已确认内容</span></div>
          <div class="agent-trait-grid">
            <article class="trait-card"><span>思考方式</span><strong>先寻找适用条件</strong><p>你较少接受没有边界的绝对结论。</p></article>
            <article class="trait-card"><span>表达偏好</span><strong>温和但直接</strong><p>你愿意承认对方合理的部分，再指出分歧。</p></article>
            <article class="trait-card"><span>高覆盖主题</span><strong>工作与技术</strong><p>这两个领域拥有相对稳定的确认观点。</p></article>
            <article class="trait-card"><span>当前空白</span><strong>关系与公共议题</strong><p>信息不足时，代理会先向你追问。</p></article>
          </div>
        </article>
        <article class="panel">
          <div class="panel-head"><h3>下一阶段能力</h3><span class="memory-topic">L3 · 辩手</span></div>
          <p style="color:#6f747c;font-size:12px;line-height:1.7">再确认 2 条高质量观点后，可以让代理针对新问题先给出“我的可能回答”，并显示它引用了哪些记忆。</p>
          <div class="level-progress" style="max-width:none"><div class="level-progress-head" style="color:#747a83"><span>成长进度</span><span>68%</span></div><div class="level-progress-bar" style="background:#edf0f2"><span></span></div></div>
        </article>
      </div>
    </section>
  `;
}

// 观点记忆：展示已确认和待确认的结构化观点。
function renderMemories() {
  const memories = getMemories();
  const cards = memories.map((memory) => `
    <article class="memory-card ${memory.status === 'candidate' ? 'pending' : ''}" data-memory-id="${escapeHTML(memory.id)}">
      <span class="memory-topic">${escapeHTML(memory.topic)}</span>
      <h3>${escapeHTML(memory.claim)}</h3>
      <p>${escapeHTML(memory.rationale)}</p>
      <div class="memory-card-footer">
        <span>${memory.sources} 次讨论 · ${escapeHTML(memory.updatedAt)}</span>
        <span class="memory-status ${memory.status === 'candidate' ? 'pending' : ''}">${memory.status === 'candidate' ? '待确认' : '已确认'}</span>
      </div>
    </article>
  `).join('');

  viewContainer.innerHTML = `
    <header class="view-header"><h2>观点记忆</h2><p>只有经过你确认的内容，才可以被用户代理用于后续创作。</p></header>
    <div class="filter-row"><button class="filter-chip active" type="button">全部</button><button class="filter-chip" type="button">已确认</button><button class="filter-chip" type="button">待确认</button><button class="filter-chip" type="button">工作方式</button><button class="filter-chip" type="button">技术伦理</button></div>
    <section class="memory-grid">${cards}</section>
  `;
}

// 对话记录：汇总所有回答代理会话，并提供继续对话入口。
function renderConversations() {
  const sessions = getSessions();
  const rows = sessions.map((session) => `
    <div class="list-table-row">
      <div class="list-title"><strong>${escapeHTML(session.question)}</strong><span>${escapeHTML(session.summary || `基于 ${session.author || '知乎用户'} 的回答`)}</span></div>
      <span>${escapeHTML(session.updatedAt || '刚刚')}</span>
      <span class="status-pill">${escapeHTML(session.artifact || '讨论中')}</span>
      <button class="row-action" type="button" data-session-id="${escapeHTML(session.id)}">继续对话</button>
    </div>
  `).join('');
  viewContainer.innerHTML = `
    <header class="view-header"><h2>对话记录</h2><p>回到任何一次讨论，查看观点是怎样一步步形成的。</p></header>
    <section class="panel table-panel">
      <div class="list-table-head"><span>问题与讨论结果</span><span>最近更新</span><span>产出状态</span><span>操作</span></div>
      ${rows || '<div class="list-table-row"><div class="list-title"><strong>还没有对话</strong><span>从一次真实问题开始</span></div></div>'}
    </section>
  `;
}

// 创作草稿：当前为演示数据，后续连接真实草稿 API。
function renderDrafts() {
  viewContainer.innerHTML = `
    <header class="view-header"><h2>创作草稿</h2><p>AI 负责整理，你负责判断、修改和最终发布。</p></header>
    <section class="panel table-panel">
      <div class="list-table-head"><span>草稿标题</span><span>类型</span><span>状态</span><span>操作</span></div>
      <div class="list-table-row"><div class="list-title"><strong>远程办公真正需要解决的不是地点，而是规则</strong><span>来自 8 轮观点讨论 · 386 字</span></div><span>结构化回复</span><span class="status-pill draft">已修改</span><button class="row-action" type="button" data-draft>打开草稿</button></div>
      <div class="list-table-row"><div class="list-title"><strong>AI 辅助表达是否会让我们失去自己的声音？</strong><span>来自 11 轮观点讨论 · 821 字</span></div><span>完整回答</span><span class="status-pill">已采用</span><button class="row-action" type="button" data-draft>查看终稿</button></div>
    </section>
  `;
}

// 视图名称到渲染函数的映射，相当于这个无框架单页应用的迷你路由表。
const viewRenderers = {
  overview: renderOverview,
  agent: renderAgent,
  memories: renderMemories,
  conversations: renderConversations,
  drafts: renderDrafts
};

const viewLabels = {
  overview: null,
  agent: '我的代理',
  memories: '观点记忆',
  conversations: '对话记录',
  drafts: '创作草稿'
};

// 切换个人中心视图，并同步导航选中状态与浏览器地址参数。
function renderView(view) {
  const safeView = viewRenderers[view] ? view : 'overview';
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.view === safeView);
  });
  const user = getUser() || { name: '体验用户' };
  if (safeView === 'overview') {
    updateUserUI(user);
  } else {
    viewTitle.textContent = viewLabels[safeView];
  }
  viewRenderers[safeView]();
  document.querySelector('#memory-count').textContent = String(confirmedMemoryCount());
  document.querySelector('.app-main').scrollTop = 0;
  const nextParams = new URLSearchParams({ view: safeView });
  if (new URLSearchParams(window.location.search).get('extension') === 'connect') nextParams.set('extension', 'connect');
  history.replaceState(null, '', `/?${nextParams.toString()}`);
}

// ---------- CloudBase 真实注册 / 登录 ----------
let currentAuthFlow = 'login';
let currentLoginMethod = 'password';
let currentRegisterMethod = 'email';

function setFeedback(element, message = '', state = 'error') {
  element.textContent = message;
  element.dataset.state = state;
  element.hidden = !message;
}

function friendlyAuthError(error) {
  const message = String(error?.message || '操作失败，请稍后重试');
  if (/network|fetch|Failed to fetch|网络/i.test(message)) return '网络连接失败，请检查安全来源配置后重试。';
  if (/password|credential|账号|密码|invalid login/i.test(message)) return '账号或密码不正确，请重新输入。';
  if (/provider.*not found|not enabled|未启用/i.test(message)) return '这种登录方式尚未正确启用，请检查 CloudBase 登录方式配置。';
  if (/code|otp|token|验证码/i.test(message)) return '验证码不正确或已经过期，请重新获取。';
  if (/already|exist|已存在|占用/i.test(message)) return '该用户名、邮箱或手机号已经被使用，请直接登录或更换后重试。';
  if (/frequent|limit|too many|频繁/i.test(message)) return '操作过于频繁，请稍后再试。';
  return message;
}

function setButtonBusy(button, busy, busyLabel = '处理中…') {
  if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyLabel : button.dataset.defaultLabel;
}

function normalizePhone(value) {
  return value.replace(/\D/g, '').replace(/^86(?=1\d{10}$)/, '');
}

function requireMainlandPhone(value) {
  const phone = normalizePhone(value);
  if (!/^1\d{10}$/.test(phone)) throw new Error('请输入正确的 11 位中国大陆手机号。');
  return phone;
}

function requireUsername(value) {
  const username = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:+@-]{4,23}$/.test(username)) {
    throw new Error('用户名需为 5–24 位英文、数字或 -_.:+@，并以英文或数字开头。');
  }
  return username;
}

function showAuthPanel() {
  document.querySelector('#login-method-tabs').hidden = currentAuthFlow !== 'login';
  document.querySelector('#register-method-tabs').hidden = currentAuthFlow !== 'register';
  document.querySelectorAll('[data-auth-panel]').forEach((panel) => {
    const expected = currentAuthFlow === 'login'
      ? `${currentLoginMethod}-login`
      : `${currentRegisterMethod}-register`;
    panel.hidden = panel.dataset.authPanel !== expected;
  });
}

function setAuthFlow(flow) {
  currentAuthFlow = flow === 'register' ? 'register' : 'login';
  const login = currentAuthFlow === 'login';
  document.querySelector('#auth-kicker').textContent = login ? '欢迎回来' : '开始建立你的观点档案';
  document.querySelector('#auth-title').textContent = login ? '登录观点分身' : '创建我的观点分身';
  document.querySelector('#auth-description').textContent = login
    ? '进入你的观点档案，继续尚未完成的讨论。'
    : '可选择邮箱或手机号验证，不强制要求绑定手机。';
  document.querySelectorAll('[data-auth-flow]').forEach((button) => {
    const active = button.dataset.authFlow === currentAuthFlow;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  setFeedback(document.querySelector('#auth-feedback'));
  showAuthPanel();
}

function openAuth(mode = 'login') {
  setAuthFlow(mode);
  openModal(authDialog);
}

function seedLocalPrototypeData() {
  if (!localStorage.getItem(MEMORY_KEY)) saveMemories(sampleMemories);
  if (!localStorage.getItem(SESSION_KEY)) saveSessions(sampleSessions);
}

async function finishAccountAccess(nickname = '', successMessage = '登录成功，欢迎回来') {
  if (nickname) {
    try {
      await setNickname(nickname);
    } catch (error) {
      console.warn('昵称暂时未同步到 CloudBase：', error);
    }
  }

  const account = await getAuthenticatedAccount();
  if (!account?.user) throw new Error('登录完成，但没有读取到有效账户，请刷新后重试。');
  const user = toLocalProfile(account.user);
  if (nickname && !user.nickname) user.name = nickname;
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  seedLocalPrototypeData();
  window.dispatchEvent(new CustomEvent('viewpoint-agent-user-ready', { detail: { uid: user.uid } }));
  closeModal(authDialog);
  showDashboard(user);
  showToast(user.phone ? successMessage : `${successMessage}；建议随后绑定手机号`);
}

function startResendCountdown(button, seconds = 60) {
  clearInterval(button.countdownTimer);
  let remaining = seconds;
  button.disabled = true;
  button.textContent = `${remaining} 秒后重发`;
  button.countdownTimer = setInterval(() => {
    remaining -= 1;
    button.textContent = remaining > 0 ? `${remaining} 秒后重发` : '重新发送';
    if (remaining <= 0) {
      clearInterval(button.countdownTimer);
      button.disabled = false;
    }
  }, 1000);
}

document.querySelectorAll('[data-auth-mode]').forEach((button) => {
  button.addEventListener('click', () => openAuth(button.dataset.authMode));
});

document.querySelectorAll('[data-auth-flow]').forEach((button) => {
  button.addEventListener('click', () => setAuthFlow(button.dataset.authFlow));
});

document.querySelectorAll('[data-auth-method]').forEach((button) => {
  button.addEventListener('click', () => {
    currentLoginMethod = button.dataset.authMethod;
    document.querySelectorAll('[data-auth-method]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
    });
    setFeedback(document.querySelector('#auth-feedback'));
    showAuthPanel();
  });
});

document.querySelectorAll('[data-register-method]').forEach((button) => {
  button.addEventListener('click', () => {
    currentRegisterMethod = button.dataset.registerMethod;
    document.querySelectorAll('[data-register-method]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
    });
    setFeedback(document.querySelector('#auth-feedback'));
    showAuthPanel();
  });
});

document.querySelectorAll('[data-close-modal]').forEach((button) => {
  button.addEventListener('click', () => closeModal(button.closest('dialog')));
});

document.querySelector('#password-login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  const feedback = document.querySelector('#auth-feedback');
  setFeedback(feedback);
  setButtonBusy(button, true, '正在登录…');
  try {
    await signInWithPassword(
      document.querySelector('#login-identifier').value,
      document.querySelector('#login-password').value
    );
    await finishAccountAccess();
  } catch (error) {
    setFeedback(feedback, friendlyAuthError(error));
  } finally {
    setButtonBusy(button, false);
  }
});

async function sendSmsLoginCode() {
  const phone = requireMainlandPhone(document.querySelector('#sms-login-phone').value);
  pendingVerifications.smsLogin = await beginSmsSignIn(phone);
  document.querySelector('#sms-login-code-row').hidden = false;
  document.querySelector('#sms-login-code').required = true;
  document.querySelector('#sms-login-submit').textContent = '验证并登录';
  document.querySelector('#sms-login-submit').dataset.defaultLabel = '验证并登录';
  startResendCountdown(document.querySelector('#sms-login-resend'));
  setFeedback(document.querySelector('#auth-feedback'), '验证码已发送，请查看手机短信。', 'success');
}

document.querySelector('#sms-login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.querySelector('#sms-login-submit');
  const feedback = document.querySelector('#auth-feedback');
  setFeedback(feedback);
  setButtonBusy(button, true, pendingVerifications.smsLogin ? '正在验证…' : '正在发送…');
  try {
    if (!pendingVerifications.smsLogin) await sendSmsLoginCode();
    else {
      const code = document.querySelector('#sms-login-code').value.trim();
      if (!code) throw new Error('请输入短信验证码。');
      await completeOtpVerification(pendingVerifications.smsLogin, code);
      pendingVerifications.smsLogin = null;
      await finishAccountAccess('', '手机号验证成功');
    }
  } catch (error) {
    setFeedback(feedback, friendlyAuthError(error));
  } finally {
    setButtonBusy(button, false);
  }
});

document.querySelector('#sms-login-resend').addEventListener('click', async () => {
  const feedback = document.querySelector('#auth-feedback');
  try {
    pendingVerifications.smsLogin = null;
    await sendSmsLoginCode();
  } catch (error) {
    setFeedback(feedback, friendlyAuthError(error));
  }
});

async function handleRegistration(event, method) {
  event.preventDefault();
  const prefix = `${method}-register`;
  const button = document.querySelector(`#${prefix}-submit`);
  const feedback = document.querySelector('#auth-feedback');
  const pendingKey = method === 'email' ? 'emailRegister' : 'phoneRegister';
  setFeedback(feedback);
  setButtonBusy(button, true, pendingVerifications[pendingKey] ? '正在验证…' : '正在发送…');

  try {
    const nickname = document.querySelector(`#${prefix}-nickname`).value.trim();
    const username = requireUsername(document.querySelector(`#${prefix}-username`).value);
    const password = document.querySelector(`#${prefix}-password`).value;
    if (password.length < 8) throw new Error('密码至少需要 8 位。');

    if (!pendingVerifications[pendingKey]) {
      const credential = method === 'email'
        ? { email: document.querySelector('#email-register-email').value.trim() }
        : { phone: requireMainlandPhone(document.querySelector('#phone-register-phone').value) };
      const verifyOtp = await beginRegistration({ ...credential, password, username });
      pendingVerifications[pendingKey] = { verifyOtp, nickname };
      document.querySelector(`#${prefix}-code-row`).hidden = false;
      document.querySelector(`#${prefix}-code`).required = true;
      button.textContent = '验证并完成注册';
      button.dataset.defaultLabel = '验证并完成注册';
      startResendCountdown(document.querySelector(`#${prefix}-resend`));
      setFeedback(feedback, `验证码已发送到你的${method === 'email' ? '邮箱' : '手机'}。`, 'success');
    } else {
      const code = document.querySelector(`#${prefix}-code`).value.trim();
      if (!code) throw new Error('请输入收到的验证码。');
      const pending = pendingVerifications[pendingKey];
      await completeOtpVerification(pending.verifyOtp, code);
      pendingVerifications[pendingKey] = null;
      await finishAccountAccess(pending.nickname, '账号创建成功');
    }
  } catch (error) {
    setFeedback(feedback, friendlyAuthError(error));
  } finally {
    setButtonBusy(button, false);
  }
}

document.querySelector('#email-register-form').addEventListener('submit', (event) => handleRegistration(event, 'email'));
document.querySelector('#phone-register-form').addEventListener('submit', (event) => handleRegistration(event, 'phone'));

async function resendRegistration(method) {
  const pendingKey = method === 'email' ? 'emailRegister' : 'phoneRegister';
  const codeInput = document.querySelector(`#${method}-register-code`);
  pendingVerifications[pendingKey] = null;
  // requestSubmit 会先执行浏览器表单校验；重发时暂时不要求填写旧验证码。
  codeInput.required = false;
  const form = document.querySelector(`#${method}-register-form`);
  form.requestSubmit();
  setTimeout(() => { codeInput.required = true; }, 0);
}

document.querySelector('#email-register-resend').addEventListener('click', () => resendRegistration('email'));
document.querySelector('#phone-register-resend').addEventListener('click', () => resendRegistration('phone'));

// ---------- 主导航与手动发起对话 ----------
document.querySelectorAll('.nav-item').forEach((button) => {
  button.addEventListener('click', () => renderView(button.dataset.view));
});

document.querySelector('#new-dialogue').addEventListener('click', () => openModal(dialogueDialog));

document.querySelector('#dialogue-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const question = document.querySelector('#dialogue-question').value.trim();
  const author = document.querySelector('#dialogue-author').value.trim() || '知乎用户';
  const answer = document.querySelector('#dialogue-answer').value.trim();
  if (!question || !answer) return;

  const session = {
    id: `session-${Date.now()}`,
    question,
    author,
    answer,
    summary: `准备与 ${author} 的回答展开讨论`,
    updatedAt: '刚刚',
    turns: 0,
    artifact: '讨论中',
    messages: []
  };
  const sessions = getSessions();
  sessions.unshift(session);
  saveSessions(sessions);
  closeModal(dialogueDialog);
  window.location.href = `/study?id=${encodeURIComponent(session.id)}`;
});

document.querySelector('#install-extension').addEventListener('click', () => {
  openModal(extensionDialog);
});

document.querySelector('#profile-button').addEventListener('click', async () => {
  const shouldLogout = window.confirm('要退出当前账号并回到产品首页吗？');
  if (!shouldLogout) return;
  try {
    await signOutAccount();
    localStorage.removeItem(USER_KEY);
    showLanding();
    showToast('已经安全退出登录');
  } catch (error) {
    showToast(friendlyAuthError(error));
  }
});

document.querySelector('#bind-phone-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.querySelector('#bind-phone-submit');
  const feedback = document.querySelector('#bind-phone-feedback');
  setFeedback(feedback);
  setButtonBusy(button, true, pendingVerifications.phoneBinding ? '正在验证…' : '正在发送…');

  try {
    if (!pendingVerifications.phoneBinding) {
      const phone = requireMainlandPhone(document.querySelector('#bind-phone-number').value);
      pendingVerifications.phoneBinding = await beginPhoneBinding(phone);
      document.querySelector('#bind-phone-code-row').hidden = false;
      document.querySelector('#bind-phone-code').required = true;
      button.textContent = '验证并绑定';
      button.dataset.defaultLabel = '验证并绑定';
      setFeedback(feedback, '验证码已经发送，请查看手机短信。', 'success');
    } else {
      const code = document.querySelector('#bind-phone-code').value.trim();
      if (!code) throw new Error('请输入短信验证码。');
      await completeOtpVerification(pendingVerifications.phoneBinding, code);
      pendingVerifications.phoneBinding = null;
      const account = await getAuthenticatedAccount();
      const user = toLocalProfile(account.user);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      closeModal(bindPhoneDialog);
      updateUserUI(user);
      renderOverview();
      showToast('手机号绑定成功');
    }
  } catch (error) {
    setFeedback(feedback, friendlyAuthError(error));
  } finally {
    setButtonBusy(button, false);
  }
});

// ---------- 个人中心内的事件委托 ----------
// 动态视图由 innerHTML 渲染，所以统一在稳定的 viewContainer 上监听点击。
viewContainer.addEventListener('click', (event) => {
  if (event.target.closest('[data-bind-phone]')) {
    setFeedback(document.querySelector('#bind-phone-feedback'));
    openModal(bindPhoneDialog);
    return;
  }

  const jump = event.target.closest('[data-jump-view]');
  if (jump) {
    renderView(jump.dataset.jumpView);
    return;
  }

  const sessionButton = event.target.closest('[data-session-id]');
  if (sessionButton) {
    window.location.href = `/study?id=${encodeURIComponent(sessionButton.dataset.sessionId)}`;
    return;
  }

  const memoryAction = event.target.closest('[data-memory-action]');
  if (memoryAction) {
    const memoryElement = memoryAction.closest('[data-memory-id]');
    const memoryId = memoryElement?.dataset.memoryId;
    if (!memoryId) return;
    if (memoryAction.dataset.memoryAction === 'edit') {
      const memories = getMemories();
      const memory = memories.find((item) => item.id === memoryId);
      const revised = window.prompt('修改成更符合你的表达：', memory?.claim || '');
      if (!revised?.trim()) return;
      memory.claim = revised.trim();
      memory.status = 'confirmed';
      memory.updatedAt = '刚刚';
      saveMemories(memories);
      renderOverview();
      showToast('修改后的观点已确认');
      return;
    }
    const memories = getMemories();
    const memory = memories.find((item) => item.id === memoryId);
    if (memory) {
      memory.status = 'confirmed';
      memory.topic = '价值选择';
      memory.updatedAt = '刚刚';
      saveMemories(memories);
      renderOverview();
      document.querySelector('#memory-count').textContent = String(confirmedMemoryCount());
      showToast('观点已加入你的长期记忆');
    }
    return;
  }

  if (event.target.closest('[data-draft]')) {
    showToast('草稿编辑器将在回答生成能力接入后开放。');
  }
});

authDialog.addEventListener('click', (event) => {
  if (event.target === authDialog) closeModal(authDialog);
});

bindPhoneDialog.addEventListener('click', (event) => {
  if (event.target === bindPhoneDialog) closeModal(bindPhoneDialog);
});

dialogueDialog.addEventListener('click', (event) => {
  if (event.target === dialogueDialog) closeModal(dialogueDialog);
});

extensionDialog.addEventListener('click', (event) => {
  if (event.target === extensionDialog) closeModal(extensionDialog);
});

// 本地扩展在用户主动绑定后会把会话写入当前网页原型，并通过事件请求面板刷新。
// 公网正式版应改为登录账户下的后端 API 推送，而不是依赖 localStorage。
window.addEventListener('viewpoint-agent-extension-synced', () => {
  if (dashboard.hidden) return;
  const currentView = new URLSearchParams(window.location.search).get('view') || 'conversations';
  renderView(currentView);
  showToast('扩展中的缓存讨论已同步到当前账号面板');
});

// ---------- 页面启动入口 ----------
// localStorage 只用于界面缓存；是否真正登录始终以 CloudBase getSession() 为准。
const requestedView = new URLSearchParams(window.location.search).get('view') || 'overview';

async function bootstrapAccount() {
  showLanding();
  try {
    const account = await getAuthenticatedAccount();
    if (!account?.user) {
      localStorage.removeItem(USER_KEY);
      if (window.location.pathname === '/dashboard') openAuth('login');
      return;
    }
    const user = toLocalProfile(account.user);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    seedLocalPrototypeData();
    showDashboard(user, requestedView);
  } catch (error) {
    console.error('CloudBase 登录状态初始化失败：', error);
    localStorage.removeItem(USER_KEY);
    showLanding();
    showToast(friendlyAuthError(error));
  }
}

bootstrapAccount();
