/**
 * content.js —— 注入普通网页的悬浮交互主体
 *
 * 负责悬浮球、菜单、回答选择、跨页面会话、可拖动缩放窗口、代理对话和观点整理。
 * 商店版悬浮球会出现在普通 HTTPS 页面；知乎内容只在用户主动选择回答后提取。
 */

(async () => {
  if (window.top !== window || document.querySelector('#viewpoint-agent-extension-root')) return;

  const root = document.createElement('div');
  root.id = 'viewpoint-agent-extension-root';
  document.documentElement.appendChild(root);

  const shadow = root.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  try {
    style.textContent = await fetch(chrome.runtime.getURL('overlay.css')).then((response) => response.text());
  } catch {
    style.textContent = ':host{all:initial}.vp-orb{position:fixed;right:28px;bottom:120px;width:54px;height:54px;border-radius:50%;background:#171a1f;color:white;z-index:2147483647}';
  }
  shadow.appendChild(style);

  const shell = document.createElement('div');
  shell.className = 'vp-shell';
  shell.innerHTML = `
    <div class="vp-selection-banner" hidden>
      <span><strong>选择一个回答</strong>移动鼠标预览，单击确认</span>
      <button type="button" data-action="cancel-selection">退出 Esc</button>
    </div>
    <div class="vp-answer-highlight" hidden><span>选择这条回答</span></div>

    <div class="vp-orb-dock">
      <div class="vp-orb-menu" hidden>
        <button type="button" data-action="select-answer"><span>⌁</span><div><strong>选择一个回答</strong><small>和当前观点聊聊</small></div></button>
        <button type="button" data-action="continue-chat"><span>◌</span><div><strong>继续上次对话</strong><small>跨页面保留讨论进度</small></div></button>
        <div class="vp-menu-divider"></div>
        <button type="button" data-action="open-dashboard"><span>↗</span><div><strong>登录 / 打开个人中心</strong><small>绑定账号并查看观点档案</small></div></button>
      </div>
      <button class="vp-orb" type="button" aria-label="打开观点分身" aria-expanded="false">
        <span class="vp-orb-core"></span><span class="vp-orb-ring"></span>
      </button>
    </div>

    <section class="vp-window" hidden aria-label="观点分身对话窗口">
      <header class="vp-window-header">
        <button class="vp-window-brand" type="button" data-action="home" aria-label="返回首页"><span class="vp-mini-orb"></span><span><strong>观点分身</strong><small>你的观点工作台</small></span></button>
        <div class="vp-window-actions">
          <button class="vp-session-toggle" type="button" data-action="toggle-sessions" aria-label="切换缓存会话">☷<span class="vp-session-count">0</span></button>
          <button type="button" data-action="minimize" aria-label="最小化">−</button>
          <button type="button" data-action="close-window" aria-label="关闭">×</button>
        </div>
      </header>

      <div class="vp-consent-view" hidden>
        <div class="vp-consent-orb"><span></span></div>
        <span class="vp-consent-kicker">首次使用说明</span>
        <h2>由你决定读取哪一条回答</h2>
        <p>观点分身只会在你主动选择回答后，读取该问题标题、回答者、回答全文和来源链接。开始讨论后，这些内容与你输入的文字会通过 HTTPS 发送到观点分身服务器，用于生成本轮回复和草稿。</p>
        <ul>
          <li>不会读取知乎密码、Cookie 或私信。</li>
          <li>不会自动点赞、评论、关注或替你发布。</li>
          <li>未完成讨论目前保存在这台浏览器本地，可随时通过移除扩展清除。</li>
        </ul>
        <div class="vp-consent-links">
          <button type="button" data-action="open-privacy">隐私政策</button>
          <button type="button" data-action="open-support">联系支持</button>
        </div>
        <div class="vp-consent-actions">
          <button type="button" data-action="decline-consent">暂不使用</button>
          <button class="primary" type="button" data-action="accept-consent">同意并继续</button>
        </div>
      </div>

      <div class="vp-home-view">
        <section class="vp-home-hero">
          <div><span class="vp-home-kicker">随时带走一场讨论</span><h2>从一条回答，开始形成自己的观点</h2><p>选择回答、继续追问、确认观点。未完成的讨论会自动留在这里。</p></div>
          <button class="vp-home-capture" type="button" data-action="select-answer"><span>⌁</span><strong>截取知乎回答</strong><small>在问题详情页选择</small></button>
        </section>

        <section class="vp-home-pending">
          <div class="vp-home-section-head"><div><span>未完成整理</span><strong>缓存的问题与回答</strong></div><button type="button" data-action="toggle-sessions">查看全部</button></div>
          <div class="vp-home-session-list"></div>
          <div class="vp-home-session-empty"><span>○</span><strong>还没有缓存讨论</strong><p>截取第一条回答后，它会自动出现在这里。</p></div>
        </section>

        <section class="vp-howto">
          <div class="vp-howto-card"><div class="vp-howto-visual vp-howto-capture-visual"><span></span><i></i><b>选择</b></div><div><span>01</span><strong>截取一个回答</strong><p>只读取你主动选择的内容。</p></div></div>
          <div class="vp-howto-card"><div class="vp-howto-visual vp-howto-chat-visual"><span></span><i></i><b></b></div><div><span>02</span><strong>聊清楚再整理</strong><p>讨论会缓存，确认后才进入观点档案。</p></div></div>
        </section>
        <div class="vp-home-legal"><button type="button" data-action="open-privacy">隐私政策</button><span>·</span><button type="button" data-action="open-support">联系支持</button><span>·</span><span>非知乎官方产品</span></div>
      </div>

      <div class="vp-chat-view" hidden>
        <section class="vp-source-card">
          <div class="vp-source-question-row">
            <span class="vp-source-icon">知</span>
            <strong class="vp-source-question">尚未选择回答</strong>
            <button type="button" data-action="change-answer">换一个</button>
          </div>
          <button class="vp-source-answer-toggle" type="button" data-action="toggle-source" aria-expanded="false">
            <span><strong class="vp-source-author">选择后开始讨论</strong><small>回答原文</small></span>
            <span class="vp-source-chevron" aria-hidden="true">⌄</span>
          </button>
          <div class="vp-source-answer-wrap"><p class="vp-source-answer-text"></p></div>
        </section>
        <div class="vp-messages"></div>
        <div class="vp-composer-wrap">
          <form class="vp-composer">
            <textarea rows="1" maxlength="1200" placeholder="说说你最赞同、困惑或想反驳的地方……"></textarea>
            <div class="vp-composer-prompts">
              <button type="button" data-prompt="先概括这篇回答的核心立场。">概括立场</button>
              <button type="button" data-prompt="我基本赞同，但有一个前提没有说清楚。">我赞同，但……</button>
              <button type="button" data-prompt="我不同意这个结论，请先问我为什么。">我想反驳</button>
            </div>
            <div><span class="vp-connection-state">观点分身服务</span><button type="submit" aria-label="发送">↑</button></div>
          </form>
          <button class="vp-finish" type="button" data-action="finish">结束并整理我的观点</button>
        </div>
      </div>

      <div class="vp-summary-view" hidden>
        <div class="vp-summary-head"><span>✦</span><strong>你的观点开始清晰了</strong><p>请修改并确认，系统不会自动替你发布。</p></div>
        <label>候选观点<textarea class="vp-summary-claim" rows="4"></textarea></label>
        <article class="vp-reply-card"><div><span>可带走的回复</span><button type="button" data-action="copy-draft">复制</button></div><p class="vp-reply-draft"></p></article>
        <div class="vp-summary-actions"><button type="button" data-action="back-chat">返回讨论</button><button class="primary" type="button" data-action="save-summary">保存本轮</button></div>
      </div>

      <aside class="vp-session-panel" hidden>
        <div class="vp-session-panel-head"><div><span>自动缓存</span><strong>未完成的讨论</strong></div><button type="button" data-action="close-sessions" aria-label="关闭缓存列表">×</button></div>
        <div class="vp-session-list"></div>
        <div class="vp-session-empty"><span>○</span><strong>暂无未完成讨论</strong><p>在知乎问题页截取回答后，会自动保存在这里。</p></div>
        <button class="vp-session-new" type="button" data-action="select-answer">＋ 截取新回答</button>
      </aside>

      <span class="vp-resize-handle vp-resize-n" data-resize="n" aria-hidden="true"></span>
      <span class="vp-resize-handle vp-resize-e" data-resize="e" aria-hidden="true"></span>
      <span class="vp-resize-handle vp-resize-s" data-resize="s" aria-hidden="true"></span>
      <span class="vp-resize-handle vp-resize-w" data-resize="w" aria-hidden="true"></span>
      <span class="vp-resize-handle vp-resize-ne" data-resize="ne" aria-hidden="true"></span>
      <span class="vp-resize-handle vp-resize-se" data-resize="se" aria-hidden="true"></span>
      <span class="vp-resize-handle vp-resize-sw" data-resize="sw" aria-hidden="true"></span>
      <span class="vp-resize-handle vp-resize-nw" data-resize="nw" aria-hidden="true"></span>
    </section>

    <div class="vp-toast" role="status" aria-live="polite"></div>
  `;
  shadow.appendChild(shell);

  const elements = {
    orbDock: shadow.querySelector('.vp-orb-dock'),
    orb: shadow.querySelector('.vp-orb'),
    menu: shadow.querySelector('.vp-orb-menu'),
    banner: shadow.querySelector('.vp-selection-banner'),
    highlight: shadow.querySelector('.vp-answer-highlight'),
    window: shadow.querySelector('.vp-window'),
    windowHeader: shadow.querySelector('.vp-window-header'),
    consentView: shadow.querySelector('.vp-consent-view'),
    homeView: shadow.querySelector('.vp-home-view'),
    homeSessionList: shadow.querySelector('.vp-home-session-list'),
    homeSessionEmpty: shadow.querySelector('.vp-home-session-empty'),
    sourceCard: shadow.querySelector('.vp-source-card'),
    sourceQuestion: shadow.querySelector('.vp-source-question'),
    sourceAuthor: shadow.querySelector('.vp-source-author'),
    sourceAnswer: shadow.querySelector('.vp-source-answer-text'),
    sourceToggle: shadow.querySelector('.vp-source-answer-toggle'),
    chatView: shadow.querySelector('.vp-chat-view'),
    summaryView: shadow.querySelector('.vp-summary-view'),
    messages: shadow.querySelector('.vp-messages'),
    composer: shadow.querySelector('.vp-composer'),
    input: shadow.querySelector('.vp-composer textarea'),
    connectionState: shadow.querySelector('.vp-connection-state'),
    claim: shadow.querySelector('.vp-summary-claim'),
    draft: shadow.querySelector('.vp-reply-draft'),
    sessionPanel: shadow.querySelector('.vp-session-panel'),
    sessionList: shadow.querySelector('.vp-session-list'),
    sessionEmpty: shadow.querySelector('.vp-session-empty'),
    sessionCount: shadow.querySelector('.vp-session-count'),
    toast: shadow.querySelector('.vp-toast')
  };

  const stored = await chrome.storage.local.get({
    vpWindowState: null,
    vpWindowOpen: false,
    vpOrbState: null,
    vpCurrentSession: null,
    vpSessions: [],
    vpActiveSessionId: null,
    vpLinkedAccount: null,
    vpSavedMemories: [],
    vpPrivacyConsent: null
  });

  // 从旧版单会话数据平滑迁移到多会话队列，避免用户升级扩展后丢失讨论。
  const migratedSessions = Array.isArray(stored.vpSessions) ? stored.vpSessions.filter((session) => session?.id && session?.source) : [];
  if (stored.vpCurrentSession?.id && !migratedSessions.some((session) => session.id === stored.vpCurrentSession.id)) {
    migratedSessions.unshift(stored.vpCurrentSession);
  }
  const initialActiveId = stored.vpActiveSessionId || stored.vpCurrentSession?.id || migratedSessions[0]?.id || null;

  const state = {
    selecting: false,
    currentCandidate: null,
    sessions: migratedSessions,
    activeSessionId: initialActiveId,
    session: migratedSessions.find((session) => session.id === initialActiveId) || null,
    view: 'home',
    busy: false,
    menuCloseTimer: null,
    drag: null,
    resize: null,
    orbDrag: null,
    suppressOrbClick: false,
    resizeSaveTimer: null,
    privacyConsent: stored.vpPrivacyConsent?.accepted === true,
    pendingConsentAction: null
  };

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => elements.toast.classList.remove('show'), 2600);
  }

  function setMenu(open) {
    clearTimeout(state.menuCloseTimer);
    if (open) positionOrbMenu();
    elements.menu.hidden = !open;
    elements.orb.setAttribute('aria-expanded', String(open));
  }

  function isZhihuQuestionPage() {
    return /(^|\.)zhihu\.com$/i.test(location.hostname) && /^\/question\/\d+/.test(location.pathname);
  }

  function pageQuestion() {
    const element = document.querySelector('h1.QuestionHeader-title, h1[class*="QuestionHeader"], main h1, h1');
    const text = element?.textContent?.trim();
    return (text || document.title.replace(/\s*[-–—|].*$/, '')).slice(0, 240);
  }

  const answerSelectors = [
    '.AnswerItem',
    '.List-item .ContentItem',
    '[itemprop="answer"]',
    'article[class*="Answer"]'
  ];

  function findAnswerElement(target) {
    if (!(target instanceof Element)) return null;
    for (const selector of answerSelectors) {
      const candidate = target.closest(selector);
      if (candidate && (candidate.innerText || '').trim().length >= 80) return candidate;
    }
    return null;
  }

  function answerBody(answerElement) {
    const body = answerElement.querySelector('.RichContent-inner, .RichText, [itemprop="text"], [class*="RichContent"]');
    return (body?.innerText || answerElement.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 12_000);
  }

  function answerAuthor(answerElement) {
    const author = answerElement.querySelector('.AuthorInfo-name, .UserLink-link, [itemprop="name"], [class*="AuthorInfo"] a');
    return (author?.textContent || '知乎用户').trim().slice(0, 60);
  }

  function answerUrl(answerElement) {
    const link = answerElement.querySelector('a[href*="/answer/"]');
    return link?.href || location.href;
  }

  function updateHighlight(answerElement) {
    if (!answerElement) {
      elements.highlight.hidden = true;
      return;
    }
    const rect = answerElement.getBoundingClientRect();
    elements.highlight.hidden = false;
    Object.assign(elements.highlight.style, {
      left: `${Math.max(6, rect.left)}px`,
      top: `${Math.max(6, rect.top)}px`,
      width: `${Math.min(rect.width, innerWidth - 12)}px`,
      height: `${Math.min(rect.height, innerHeight - Math.max(6, rect.top) - 6)}px`
    });
  }

  function onSelectionMove(event) {
    const candidate = findAnswerElement(event.target);
    state.currentCandidate = candidate;
    updateHighlight(candidate);
  }

  function onSelectionScroll() {
    updateHighlight(state.currentCandidate);
  }

  function onSelectionKey(event) {
    if (event.key === 'Escape') cancelSelection();
  }

  function onSelectionClick(event) {
    const candidate = findAnswerElement(event.target) || state.currentCandidate;
    if (!candidate) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const source = {
      question: pageQuestion(),
      answer: answerBody(candidate),
      author: answerAuthor(candidate),
      url: answerUrl(candidate),
      capturedAt: new Date().toISOString()
    };

    if (source.answer.length < 80) {
      showToast('没有读取到完整回答，请点击回答正文区域');
      return;
    }

    state.session = {
      id: `zhihu-${Date.now()}`,
      source,
      messages: [],
      status: 'pending',
      updatedAt: new Date().toISOString()
    };
    state.sessions.unshift(state.session);
    state.activeSessionId = state.session.id;
    persistSession();
    cancelSelection();
    renderSession();
    openWindow();
    showToast('回答已选择，可以开始讨论');
  }

  function beginSelection() {
    if (!state.privacyConsent) {
      state.pendingConsentAction = 'select-answer';
      openWindow({ home: true });
      return;
    }
    if (!isZhihuQuestionPage()) {
      setMenu(false);
      showToast(state.session?.source
        ? '当前页可以继续讨论；如需更换回答，请回到知乎问题详情页'
        : '请先打开一个知乎问题详情页，再选择回答');
      return;
    }
    setMenu(false);
    closeWindow(false);
    state.selecting = true;
    state.currentCandidate = null;
    elements.banner.hidden = false;
    document.addEventListener('pointermove', onSelectionMove, true);
    document.addEventListener('click', onSelectionClick, true);
    document.addEventListener('keydown', onSelectionKey, true);
    window.addEventListener('scroll', onSelectionScroll, true);
    showToast('移动到想讨论的回答，单击完成选择');
  }

  function cancelSelection() {
    state.selecting = false;
    state.currentCandidate = null;
    elements.banner.hidden = true;
    elements.highlight.hidden = true;
    document.removeEventListener('pointermove', onSelectionMove, true);
    document.removeEventListener('click', onSelectionClick, true);
    document.removeEventListener('keydown', onSelectionKey, true);
    window.removeEventListener('scroll', onSelectionScroll, true);
  }

  function persistSession() {
    if (state.session) {
      state.session.updatedAt = new Date().toISOString();
      const index = state.sessions.findIndex((session) => session.id === state.session.id);
      if (index >= 0) state.sessions[index] = state.session;
      else state.sessions.unshift(state.session);
      state.activeSessionId = state.session.id;
    }
    chrome.storage.local.set({
      vpSessions: state.sessions.slice(0, 60),
      vpActiveSessionId: state.activeSessionId,
      // 保留旧键，兼容已经安装的 0.1/0.2 版本。
      vpCurrentSession: state.session
    });
    renderSessionLists();
  }

  function unfinishedSessions() {
    return state.sessions
      .filter((session) => session?.source && session.status !== 'completed')
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  function formatSessionTime(value) {
    const time = new Date(value || Date.now());
    if (Number.isNaN(time.getTime())) return '刚刚';
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(time);
  }

  function createSessionButton(session, compact = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `vp-session-item${compact ? ' compact' : ''}${session.id === state.activeSessionId ? ' active' : ''}`;
    button.dataset.sessionId = session.id;

    const icon = document.createElement('span');
    icon.className = 'vp-session-item-icon';
    icon.textContent = '知';
    const content = document.createElement('span');
    content.className = 'vp-session-item-content';
    const question = document.createElement('strong');
    question.textContent = session.source.question;
    const meta = document.createElement('small');
    meta.textContent = `${session.source.author || '知乎用户'} · ${formatSessionTime(session.updatedAt)}`;
    content.append(question, meta);
    const arrow = document.createElement('span');
    arrow.className = 'vp-session-item-arrow';
    arrow.textContent = '›';
    button.append(icon, content, arrow);
    return button;
  }

  function renderSessionLists() {
    const sessions = unfinishedSessions();
    elements.sessionCount.textContent = String(sessions.length);
    elements.sessionCount.hidden = sessions.length === 0;
    elements.sessionList.replaceChildren(...sessions.map((session) => createSessionButton(session)));
    elements.sessionEmpty.hidden = sessions.length > 0;

    const homeSessions = sessions.slice(0, 3);
    elements.homeSessionList.replaceChildren(...homeSessions.map((session) => createSessionButton(session, true)));
    elements.homeSessionEmpty.hidden = homeSessions.length > 0;
  }

  // 本地原型绑定：用户从扩展主动打开本地个人中心后，把扩展会话映射到网页面板。
  // 正式公网版本必须由后端账号与令牌替代，不能依赖页面 localStorage。
  async function syncToPrototypeDashboard() {
    const isLocalDashboard = ['127.0.0.1', 'localhost'].includes(location.hostname) && (location.pathname === '/dashboard' || location.pathname === '/');
    if (!isLocalDashboard) return;
    let user;
    try {
      user = JSON.parse(localStorage.getItem('viewpointAgentUser') || 'null');
    } catch {
      user = null;
    }
    if (!user?.email) return;

    const wantsBinding = new URLSearchParams(location.search).get('extension') === 'connect';
    const linkedEmail = stored.vpLinkedAccount?.email;
    if (!wantsBinding && linkedEmail !== user.email) return;

    let existing = [];
    try {
      const parsed = JSON.parse(localStorage.getItem('viewpointAgentSessions') || '[]');
      existing = Array.isArray(parsed) ? parsed : [];
    } catch {
      existing = [];
    }

    const extensionSessions = state.sessions.map((session) => ({
      id: session.id,
      question: session.source.question,
      author: session.source.author || '知乎用户',
      answer: session.source.answer,
      sourceUrl: session.source.url,
      messages: session.messages || [],
      summary: session.summary || `与 ${session.source.author || '知乎用户'} 的回答讨论中`,
      updatedAt: formatSessionTime(session.updatedAt),
      turns: (session.messages || []).length,
      artifact: session.status === 'completed' ? '已形成观点' : '未完成整理',
      source: 'browser-extension'
    }));
    const extensionIds = new Set(extensionSessions.map((session) => session.id));
    const merged = [...extensionSessions, ...existing.filter((session) => !extensionIds.has(session.id))];
    localStorage.setItem('viewpointAgentSessions', JSON.stringify(merged));
    await chrome.storage.local.set({ vpLinkedAccount: { name: user.name, email: user.email, linkedAt: new Date().toISOString(), prototype: true } });
    window.dispatchEvent(new CustomEvent('viewpoint-agent-extension-synced'));
  }

  function setActiveSession(sessionId) {
    const next = state.sessions.find((session) => session.id === sessionId);
    if (!next) return;
    state.activeSessionId = next.id;
    state.session = next;
    chrome.storage.local.set({ vpActiveSessionId: next.id, vpCurrentSession: next });
    elements.sessionPanel.hidden = true;
    renderSession();
  }

  function applyOrbState() {
    const saved = stored.vpOrbState || {};
    const size = 58;
    const left = Math.min(Math.max(Number(saved.left) || innerWidth - size - 28, 10), innerWidth - size - 10);
    const top = Math.min(Math.max(Number(saved.top) || innerHeight - size - 118, 10), innerHeight - size - 10);
    Object.assign(elements.orbDock.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
    positionOrbMenu();
  }

  function saveOrbState() {
    const rect = elements.orbDock.getBoundingClientRect();
    chrome.storage.local.set({ vpOrbState: { left: rect.left, top: rect.top } });
  }

  function clampOrb() {
    const rect = elements.orbDock.getBoundingClientRect();
    const left = Math.min(Math.max(rect.left, 10), innerWidth - rect.width - 10);
    const top = Math.min(Math.max(rect.top, 10), innerHeight - rect.height - 10);
    Object.assign(elements.orbDock.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
    positionOrbMenu();
    saveOrbState();
  }

  function positionOrbMenu() {
    const rect = elements.orbDock.getBoundingClientRect();
    const opensRight = rect.left < 260;
    const opensBelow = rect.top < 250;
    elements.orbDock.classList.toggle('menu-opens-right', opensRight);
    elements.orbDock.classList.toggle('menu-opens-below', opensBelow);
  }

  function applyWindowState() {
    const saved = stored.vpWindowState || {};
    const width = Math.min(Math.max(Number(saved.width) || 500, 400), innerWidth - 24);
    const height = Math.min(Math.max(Number(saved.height) || 680, 440), innerHeight - 24);
    const left = Math.min(Math.max(Number(saved.left) || innerWidth - width - 28, 12), innerWidth - width - 12);
    const top = Math.min(Math.max(Number(saved.top) || 92, 12), innerHeight - height - 12);
    Object.assign(elements.window.style, {
      width: `${width}px`,
      height: `${height}px`,
      left: `${left}px`,
      top: `${top}px`
    });
  }

  function saveWindowState() {
    clearTimeout(state.resizeSaveTimer);
    state.resizeSaveTimer = setTimeout(() => {
      const rect = elements.window.getBoundingClientRect();
      chrome.storage.local.set({
        vpWindowState: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      });
    }, 120);
  }

  function clampWindow() {
    const rect = elements.window.getBoundingClientRect();
    const width = Math.min(rect.width, innerWidth - 24);
    const height = Math.min(rect.height, innerHeight - 24);
    const left = Math.min(Math.max(rect.left, 12), innerWidth - width - 12);
    const top = Math.min(Math.max(rect.top, 12), innerHeight - height - 12);
    Object.assign(elements.window.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    saveWindowState();
  }

  function openWindow({ home = false } = {}) {
    elements.window.hidden = false;
    setMenu(false);
    if (!state.privacyConsent) showConsent();
    else if (home || !state.session?.source) showHome();
    clampWindow();
    chrome.storage.local.set({ vpWindowOpen: true });
  }

  function closeWindow(clear = false) {
    elements.window.hidden = true;
    elements.sessionPanel.hidden = true;
    chrome.storage.local.set({ vpWindowOpen: false });
    if (clear) {
      state.session = null;
      state.activeSessionId = null;
      chrome.storage.local.remove(['vpCurrentSession', 'vpActiveSessionId']);
      showHome();
    }
  }

  function showHome() {
    state.view = 'home';
    elements.consentView.hidden = true;
    elements.homeView.hidden = false;
    elements.chatView.hidden = true;
    elements.summaryView.hidden = true;
    elements.sessionPanel.hidden = true;
    renderSessionLists();
  }

  function showConsent() {
    state.view = 'consent';
    elements.consentView.hidden = false;
    elements.homeView.hidden = true;
    elements.chatView.hidden = true;
    elements.summaryView.hidden = true;
    elements.sessionPanel.hidden = true;
  }

  function renderSession() {
    const source = state.session?.source;
    if (!source) {
      showHome();
      return;
    }
    // 每次载入或更换回答都回到对话视图，避免残留上一轮的总结页面。
    state.view = 'chat';
    elements.homeView.hidden = true;
    elements.chatView.hidden = false;
    elements.summaryView.hidden = true;
    elements.sourceQuestion.textContent = source?.question || '尚未选择回答';
    elements.sourceAuthor.textContent = source ? source.author : '选择后开始讨论';
    elements.sourceAnswer.textContent = source?.answer || '在知乎问题详情页选择一条回答后，原文会显示在这里。';
    elements.sourceCard.classList.remove('expanded');
    elements.sourceToggle.setAttribute('aria-expanded', 'false');
    elements.messages.replaceChildren();

    const messages = state.session?.messages || [];
    messages.forEach((message) => appendMessage(message));
    elements.messages.scrollTop = elements.messages.scrollHeight;
    renderSessionLists();
  }

  function appendMessage(message, pending = false) {
    const item = document.createElement('article');
    item.className = `vp-message ${message.role}${pending ? ' pending' : ''}`;
    const avatar = document.createElement('span');
    avatar.className = 'vp-message-avatar';
    avatar.textContent = message.role === 'user' ? '我' : '代';
    const body = document.createElement('div');
    body.className = 'vp-message-body';
    const label = document.createElement('span');
    label.className = 'vp-message-label';
    label.textContent = message.role === 'user' ? '你的表达' : (message.inferred ? '回答代理 · AI 推演' : '回答代理');
    const paragraph = document.createElement('p');
    paragraph.textContent = pending ? '正在理解你的观点……' : message.content;
    body.append(label, paragraph);
    item.append(avatar, body);
    elements.messages.appendChild(item);
    elements.messages.scrollTop = elements.messages.scrollHeight;
    return item;
  }

  async function sendUserMessage(content) {
    if (!state.privacyConsent) {
      showConsent();
      return;
    }
    const text = content.trim();
    if (!text || state.busy || !state.session?.source) return;
    state.busy = true;
    elements.connectionState.textContent = '正在连接回答代理…';
    state.session.messages.push({ role: 'user', content: text, createdAt: new Date().toISOString() });
    appendMessage(state.session.messages.at(-1));
    const pending = appendMessage({ role: 'assistant', content: '' }, true);
    elements.input.value = '';
    elements.input.style.height = 'auto';
    persistSession();

    const response = await chrome.runtime.sendMessage({
      type: 'AGENT_REPLY',
      payload: {
        question: state.session.source.question,
        answer: state.session.source.answer,
        messages: state.session.messages
      }
    }).catch((error) => ({ ok: false, error: error.message }));

    pending.remove();
    if (response?.ok) {
      const reply = {
        role: 'assistant',
        content: response.data.reply,
        inferred: response.data.inferred,
        createdAt: new Date().toISOString()
      };
      state.session.messages.push(reply);
      appendMessage(reply);
      elements.connectionState.textContent = response.data.prototype ? '原型代理 · 规则模拟' : '回答代理已连接';
      persistSession();
    } else {
      elements.connectionState.textContent = '代理服务未连接';
      showToast(response?.error || '无法连接观点分身服务，请稍后重试');
    }
    state.busy = false;
  }

  async function finishConversation() {
    if (!state.privacyConsent) {
      showConsent();
      return;
    }
    const userMessages = state.session?.messages?.filter((message) => message.role === 'user') || [];
    if (!userMessages.length) {
      showToast('先表达一点真实想法，再整理本轮观点');
      return;
    }
    if (state.busy) return;
    state.busy = true;
    showToast('正在整理本轮观点…');
    const response = await chrome.runtime.sendMessage({
      type: 'AGENT_SUMMARY',
      payload: {
        question: state.session.source.question,
        answer: state.session.source.answer,
        messages: state.session.messages
      }
    }).catch((error) => ({ ok: false, error: error.message }));
    state.busy = false;
    if (!response?.ok) {
      showToast(response?.error || '整理失败，请检查代理服务');
      return;
    }
    elements.claim.value = response.data.claim;
    elements.draft.textContent = response.data.draft;
    state.view = 'summary';
    elements.homeView.hidden = true;
    elements.chatView.hidden = true;
    elements.summaryView.hidden = false;
  }

  async function saveSummary() {
    const claim = elements.claim.value.trim();
    if (!claim) {
      showToast('请先确认或修改候选观点');
      return;
    }
    const data = await chrome.storage.local.get({ vpSavedMemories: [] });
    const memories = Array.isArray(data.vpSavedMemories) ? data.vpSavedMemories : [];
    memories.unshift({
      id: `memory-${Date.now()}`,
      claim,
      question: state.session.source.question,
      sourceUrl: state.session.source.url,
      createdAt: new Date().toISOString()
    });
    state.session.summary = claim;
    state.session.draft = elements.draft.textContent;
    state.session.status = 'completed';
    persistSession();
    await chrome.storage.local.set({ vpSavedMemories: memories });
    showToast('本轮观点已保存在扩展本地');
  }

  elements.orbDock.addEventListener('mouseenter', () => {
    if (!state.orbDrag) setMenu(true);
  });
  elements.orbDock.addEventListener('mouseleave', () => {
    state.menuCloseTimer = setTimeout(() => setMenu(false), 320);
  });
  elements.orb.addEventListener('click', () => {
    if (state.suppressOrbClick) {
      state.suppressOrbClick = false;
      return;
    }
    setMenu(false);
    if (elements.window.hidden) openWindow({ home: true });
    else closeWindow(false);
  });

  // 悬浮球可以拖到视口中的任意位置；位置保存在扩展本地，切换页面后继续使用。
  elements.orb.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const rect = elements.orbDock.getBoundingClientRect();
    state.orbDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
    elements.orb.setPointerCapture(event.pointerId);
    elements.orb.classList.add('dragging');
  });
  elements.orb.addEventListener('pointermove', (event) => {
    if (!state.orbDrag || state.orbDrag.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.orbDrag.x;
    const dy = event.clientY - state.orbDrag.y;
    if (Math.hypot(dx, dy) > 4) state.orbDrag.moved = true;
    if (!state.orbDrag.moved) return;
    setMenu(false);
    const left = Math.min(Math.max(state.orbDrag.left + dx, 10), innerWidth - elements.orbDock.offsetWidth - 10);
    const top = Math.min(Math.max(state.orbDrag.top + dy, 10), innerHeight - elements.orbDock.offsetHeight - 10);
    Object.assign(elements.orbDock.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
    positionOrbMenu();
  });
  const finishOrbDrag = (event) => {
    if (!state.orbDrag || state.orbDrag.pointerId !== event.pointerId) return;
    state.suppressOrbClick = state.orbDrag.moved;
    state.orbDrag = null;
    elements.orb.classList.remove('dragging');
    saveOrbState();
  };
  elements.orb.addEventListener('pointerup', finishOrbDrag);
  elements.orb.addEventListener('pointercancel', finishOrbDrag);

  shadow.addEventListener('click', async (event) => {
    const sessionId = event.target.closest('[data-session-id]')?.dataset.sessionId;
    if (sessionId) {
      setActiveSession(sessionId);
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'select-answer' || action === 'change-answer') beginSelection();
    if (action === 'cancel-selection') cancelSelection();
    if (action === 'continue-chat') state.session?.source ? (renderSession(), openWindow()) : openWindow({ home: true });
    if (action === 'open-dashboard') chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
    if (action === 'open-privacy') chrome.runtime.sendMessage({ type: 'OPEN_PRIVACY' });
    if (action === 'open-support') chrome.runtime.sendMessage({ type: 'OPEN_SUPPORT' });
    if (action === 'accept-consent') {
      state.privacyConsent = true;
      await chrome.storage.local.set({ vpPrivacyConsent: { accepted: true, version: '2026-08-27', acceptedAt: new Date().toISOString() } });
      const pendingAction = state.pendingConsentAction;
      state.pendingConsentAction = null;
      showHome();
      if (pendingAction === 'select-answer') beginSelection();
    }
    if (action === 'decline-consent') {
      state.pendingConsentAction = null;
      closeWindow(false);
      showToast('你尚未同意读取内容，观点分身不会采集或发送网页数据');
    }
    if (action === 'home') showHome();
    if (action === 'toggle-sessions') {
      renderSessionLists();
      elements.sessionPanel.hidden = !elements.sessionPanel.hidden;
    }
    if (action === 'close-sessions') elements.sessionPanel.hidden = true;
    if (action === 'toggle-source') {
      const expanded = elements.sourceCard.classList.toggle('expanded');
      elements.sourceToggle.setAttribute('aria-expanded', String(expanded));
    }
    if (action === 'minimize') closeWindow(false);
    if (action === 'close-window') closeWindow(false);
    if (action === 'finish') finishConversation();
    if (action === 'back-chat') {
      renderSession();
    }
    if (action === 'copy-draft') {
      await navigator.clipboard.writeText(elements.draft.textContent).then(
        () => showToast('回复草稿已复制'),
        () => showToast('复制失败，请手动选择文本')
      );
    }
    if (action === 'save-summary') saveSummary();
  });

  shadow.querySelectorAll('[data-prompt]').forEach((button) => {
    button.addEventListener('click', () => sendUserMessage(button.dataset.prompt));
  });

  elements.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    sendUserMessage(elements.input.value);
  });
  elements.input.addEventListener('input', () => {
    elements.input.style.height = 'auto';
    elements.input.style.height = `${Math.min(elements.input.scrollHeight, 130)}px`;
  });

  elements.windowHeader.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    const rect = elements.window.getBoundingClientRect();
    state.drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    elements.windowHeader.setPointerCapture(event.pointerId);
    elements.window.classList.add('dragging');
  });
  elements.windowHeader.addEventListener('pointermove', (event) => {
    if (!state.drag) return;
    const rect = elements.window.getBoundingClientRect();
    const left = Math.min(Math.max(state.drag.left + event.clientX - state.drag.x, 12), innerWidth - rect.width - 12);
    const top = Math.min(Math.max(state.drag.top + event.clientY - state.drag.y, 12), innerHeight - rect.height - 12);
    elements.window.style.left = `${left}px`;
    elements.window.style.top = `${top}px`;
  });
  const finishDrag = () => {
    if (!state.drag) return;
    state.drag = null;
    elements.window.classList.remove('dragging');
    saveWindowState();
  };
  elements.windowHeader.addEventListener('pointerup', finishDrag);
  elements.windowHeader.addEventListener('pointercancel', finishDrag);

  // 八个缩放把手覆盖四条边和四个角；从左侧或上侧缩放时会同步修正窗口位置。
  shadow.querySelectorAll('[data-resize]').forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = elements.window.getBoundingClientRect();
      state.resize = {
        pointerId: event.pointerId,
        direction: handle.dataset.resize,
        x: event.clientX,
        y: event.clientY,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom
      };
      handle.setPointerCapture(event.pointerId);
      elements.window.classList.add('resizing');
    });

    handle.addEventListener('pointermove', (event) => {
      const resize = state.resize;
      if (!resize || resize.pointerId !== event.pointerId) return;
      const dx = event.clientX - resize.x;
      const dy = event.clientY - resize.y;
      const minWidth = Math.min(400, innerWidth - 24);
      const minHeight = Math.min(440, innerHeight - 24);
      let left = resize.left;
      let top = resize.top;
      let right = resize.right;
      let bottom = resize.bottom;

      if (resize.direction.includes('w')) left = Math.min(Math.max(resize.left + dx, 12), resize.right - minWidth);
      if (resize.direction.includes('e')) right = Math.max(Math.min(resize.right + dx, innerWidth - 12), resize.left + minWidth);
      if (resize.direction.includes('n')) top = Math.min(Math.max(resize.top + dy, 12), resize.bottom - minHeight);
      if (resize.direction.includes('s')) bottom = Math.max(Math.min(resize.bottom + dy, innerHeight - 12), resize.top + minHeight);

      Object.assign(elements.window.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${right - left}px`,
        height: `${bottom - top}px`
      });
    });

    const finishResize = (event) => {
      if (!state.resize || state.resize.pointerId !== event.pointerId) return;
      state.resize = null;
      elements.window.classList.remove('resizing');
      saveWindowState();
    };
    handle.addEventListener('pointerup', finishResize);
    handle.addEventListener('pointercancel', finishResize);
  });

  new ResizeObserver(() => {
    if (!elements.window.hidden) saveWindowState();
  }).observe(elements.window);
  window.addEventListener('resize', () => {
    clampWindow();
    clampOrb();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'TOGGLE_ORB_MENU') {
      if (elements.window.hidden) openWindow({ home: true });
      else closeWindow(false);
    }
  });

  window.addEventListener('viewpoint-agent-user-ready', syncToPrototypeDashboard);

  // 多标签页共享同一份缓存。其他页面新增或更新会话时，当前页面的首页列表同步刷新。
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.vpSessions) return;
    const nextSessions = Array.isArray(changes.vpSessions.newValue) ? changes.vpSessions.newValue : [];
    state.sessions = nextSessions;
    const refreshedActive = nextSessions.find((session) => session.id === state.activeSessionId);
    if (refreshedActive && !state.busy) state.session = refreshedActive;
    renderSessionLists();
    syncToPrototypeDashboard();
  });

  applyWindowState();
  applyOrbState();
  showHome();
  chrome.storage.local.set({ vpSessions: state.sessions, vpActiveSessionId: state.activeSessionId });
  syncToPrototypeDashboard();
  if (stored.vpWindowOpen) openWindow({ home: true });
})();
