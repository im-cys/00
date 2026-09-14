(() => {
  const data = window.ZHIHU_DEMO_DATA || { questions: [] };
  if (!Array.isArray(data.questions)) data.questions = [];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const initials = name => [...String(name || '知')][0];
  const numeric = value => Number(String(value ?? '').replaceAll(',', '')) || 0;
  const displayCount = value => typeof value === 'number' ? value.toLocaleString('zh-CN') : (value || '0');
  const longAnswer = answer => answer.paragraphs.join('').length > 720 || answer.paragraphs.length > 8;
  const latexCommand = /\\(?:begin|boldsymbol|mathbf|mathbb|mathcal|text|operatorname|underset|stackrel|arg|max|min|Delta|nabla|lambda|kappa|sigma|epsilon|ell|sum|frac|sqrt|left|right|doteq|approx|cdot|otimes|vdots|ldots|cdots|longrightarrow|rightarrow|log|det|mid|quad|geq|in|ReLU)\b/;
  const languageBoundary = /[\u3400-\u9fff，。；：！？（）]/g;
  const expandedAnswers = new Set();
  const openCommentPanels = new Set();
  const requestedComments = new URLSearchParams(location.search).get('comments');
  const ONBOARDING_VERSION = 'collision-onboarding-v1';
  if (requestedComments) openCommentPanels.add(requestedComments);
  let community = { answers: {}, questions: {}, session: { user: null, configured: false } };

  function answerStats(answer) {
    const live = community.answers[answer.id] || {};
    return {
      upvotes: numeric(answer.votes) + numeric(live.upvotes),
      likes: numeric(answer.likes) + numeric(live.likes),
      favorites: numeric(answer.favorites) + numeric(live.favorites),
      comments: numeric(answer.comments) + numeric(live.comments),
      mapGenerations: numeric(live.mapGenerations),
      recentComments: live.recentComments || [],
      mine: live.mine || {}
    };
  }

  function actionButton(action, icon, label, count, answer, active = false) {
    return `<button class="answer-action ${action === 'upvote' ? 'vote' : ''} ${active ? 'is-active' : ''}" type="button" data-action="${action}" data-question-id="${escape(answer.id.split('-')[0])}" data-answer-id="${escape(answer.id)}"><span>${icon}</span>${escape(label)} ${displayCount(count)}</button>`;
  }

  function engagement(answer, compact = false) {
    const stats = answerStats(answer);
    return `<div class="engagement${compact ? ' feed-engagement' : ' sticky-actions'}">
      ${actionButton('upvote', '▲', '赞同', stats.upvotes, answer, stats.mine.upvote)}
      ${actionButton('like', '♥', '点赞', stats.likes, answer, stats.mine.like)}
      <button class="answer-action" type="button" data-comments-for="${escape(answer.id)}"><span>●</span>评论 ${displayCount(stats.comments)}</button>
      ${actionButton('favorite', '★', '收藏', stats.favorites, answer, stats.mine.favorite)}
      ${compact ? '' : '<button class="collapse" type="button" data-scroll-top>回到顶部 ↑</button>'}
    </div>`;
  }

  function feedExcerpt(question, answer, hasImage) {
    const body = (answer.paragraphs || [])
      .filter(paragraph => !/^〔(?:图片|视频)〕/.test(paragraph.trim()))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const source = body || question.excerpt || '';
    const limit = hasImage ? 136 : 76;
    const characters = [...source];
    return characters.length > limit ? `${characters.slice(0, limit).join('')}…` : source;
  }

  function feedCard(question) {
    const answer = question.answers[0];
    if (!answer) return '';
    const imageUrl = answer.images?.[0] || question.firstImage || '';
    const excerpt = feedExcerpt(question, answer, Boolean(imageUrl));
    return `<article class="feed-item" data-question-id="${escape(question.id)}">
      <a class="feed-title" href="/question/${escape(question.id)}" target="_blank" rel="noopener">${escape(question.title)}</a>
      <div class="feed-summary ${imageUrl ? 'with-image' : 'no-image'}">
        ${imageUrl ? `<a class="feed-visual" href="/question/${escape(question.id)}" target="_blank" rel="noopener" aria-label="在新标签页打开问题"><img src="${escape(imageUrl)}" alt="${escape(question.title)}的首篇回答配图" loading="lazy" decoding="async" referrerpolicy="no-referrer"></a>` : ''}
        <p><strong>${escape(answer.author)}：</strong>${escape(excerpt)} <a class="read-more" href="/question/${escape(question.id)}" target="_blank" rel="noopener">阅读全文 ⌄</a></p>
      </div>
      ${engagement(answer, true)}
    </article>`;
  }

  function heatBoard() {
    const ranked = data.questions.map((question, index) => ({ question, index, stats: community.questions[question.id] || { likes: 0, favorites: 0, comments: 0, mapGenerations: 0, heat: 0 } }))
      .sort((left, right) => right.stats.heat - left.stats.heat || left.index - right.index);
    return ranked.map((item, index) => `<li>
      <b class="heat-rank rank-${index + 1}">${index + 1}</b>
      <div><a href="/question/${escape(item.question.id)}" target="_blank" rel="noopener">${escape(item.question.title)}</a><small>点赞 ${displayCount(item.stats.likes)} · 地图 ${displayCount(item.stats.mapGenerations)} · 收藏 ${displayCount(item.stats.favorites)} · 评论 ${displayCount(item.stats.comments)}</small></div>
      <strong class="heat-score">${displayCount(item.stats.heat)}</strong>
    </li>`).join('');
  }

  function renderHome() {
    document.querySelector('#feed').innerHTML = data.questions.length
      ? data.questions.map(feedCard).join('')
      : '<article class="feed-item"><h2>内容数据尚未配置</h2><p>请在服务器上挂载私有内容目录后刷新页面。</p></article>';
    document.querySelector('#trends').innerHTML = data.questions.length ? heatBoard() : '<li><div><small>暂无公开内容</small></div></li>';
    bindImageFallbacks();
    window.dispatchEvent(new Event('zhihu:render'));
  }

  function normalizeMathSource(source) {
    return source
      .replace(/\\boldsymbol\{U\}\{\[K\]\}/g, '\\boldsymbol{U}_{[K]}')
      .replace(/\u00a0/g, ' ')
      .trim();
  }

  function renderFormula(source, displayMode = false) {
    const tex = normalizeMathSource(source);
    if (!tex) return '';
    if (!window.katex) return `<span class="math-fallback">${escape(tex)}</span>`;
    const rendered = window.katex.renderToString(tex, { displayMode, throwOnError: false, strict: 'ignore', output: 'htmlAndMathml' });
    return `<span class="math-fragment ${displayMode ? 'math-display' : 'math-inline'}" data-math-tex="${escape(tex)}" role="img" aria-label="数学公式">${rendered}</span>`;
  }

  function renderDollarMath(text) {
    const parts = String(text).split(/\$([^$\n]+)\$/g);
    return parts.map((part, index) => index % 2 ? renderFormula(part) : escape(part)).join('');
  }

  function sourceStart(text, commandIndex, segmentStart) {
    const prefix = text.slice(segmentStart, commandIndex);
    const suffixes = [
      /Attention\s*\([^)]*\)\s*=\s*softmax\s*\($/i,
      /E\s*\[[^\]]+\]\s*=\s*$/,
      /(?:R\^c|R|f)\s*(?:\(|:\s*)$/,
      /\|\s*$/
    ];
    for (const pattern of suffixes) {
      const match = prefix.match(pattern);
      if (match) return commandIndex - match[0].length;
    }
    return commandIndex;
  }

  function renderRichParagraph(value) {
    const text = String(value ?? '');
    const first = text.match(latexCommand);
    if (!first) return renderDollarMath(text);
    const firstIndex = first.index;
    if (!/[\u3400-\u9fff]/.test(text)) {
      const start = sourceStart(text, firstIndex, 0);
      return renderFormula(text.slice(start), true);
    }

    let html = '';
    let cursor = 0;
    let searchAt = 0;
    while (searchAt < text.length) {
      const match = text.slice(searchAt).match(latexCommand);
      if (!match) break;
      const commandIndex = searchAt + match.index;
      let artifactStart = cursor;
      languageBoundary.lastIndex = cursor;
      let boundary;
      while ((boundary = languageBoundary.exec(text)) && boundary.index < commandIndex) artifactStart = boundary.index + boundary[0].length;
      languageBoundary.lastIndex = 0;
      while (/\s/.test(text[artifactStart] || '')) artifactStart += 1;
      const texStart = sourceStart(text, commandIndex, artifactStart);
      const remainder = text.slice(commandIndex);
      const nextBoundary = remainder.search(/[\u3400-\u9fff，。；！？（）]/);
      const formulaEnd = nextBoundary < 0 ? text.length : commandIndex + nextBoundary;
      html += renderDollarMath(text.slice(cursor, artifactStart));
      html += renderFormula(text.slice(texStart, formulaEnd));
      cursor = formulaEnd;
      searchAt = Math.max(formulaEnd, commandIndex + match[0].length);
    }
    html += renderDollarMath(text.slice(cursor));
    return html;
  }

  function answerContent(answer) {
    let imageIndex = 0;
    return answer.paragraphs.map((paragraph, paragraphIndex) => {
      if (paragraph.includes('〔图片〕')) {
        const caption = paragraph.replaceAll('〔图片〕', '').trim();
        const sourceUrl = answer.images?.[imageIndex++] || '';
        if (!sourceUrl) return caption ? `<p>${escape(caption)}</p>` : '';
        return `<figure class="answer-media"><img src="${escape(sourceUrl)}" alt="${escape(caption || `${answer.author} 的回答图片`)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">${caption ? `<figcaption>${escape(caption)}</figcaption>` : ''}</figure>`;
      }
      if (paragraph.includes('〔视频〕')) return `<p class="answer-media-note">原回答包含视频：${escape(paragraph.replaceAll('〔视频〕', '').trim())}</p>`;
      return `<p data-paragraph-index="${paragraphIndex}">${renderRichParagraph(paragraph)}</p>`;
    }).join('');
  }

  function commentsPanel(answer) {
    if (!openCommentPanels.has(answer.id)) return '';
    const stats = answerStats(answer);
    const comments = stats.recentComments.length ? stats.recentComments.map(comment => `<li><strong>${escape(comment.author)}</strong><p>${escape(comment.text)}</p></li>`).join('') : '<li class="no-comments">还没有评论，来写第一条吧。</li>';
    const composer = community.session.user
      ? `<form class="comment-form" data-question-id="${escape(answer.id.split('-')[0])}" data-answer-id="${escape(answer.id)}"><input name="comment" maxlength="500" autocomplete="off" placeholder="写下你的评论…" required><button type="submit">发布</button></form>`
      : '<button class="comment-login" type="button" data-login>使用知乎账号登录后评论</button>';
    return `<section class="comment-panel"><ol>${comments}</ol>${composer}</section>`;
  }

  function answerCard(answer, index) {
    const isLong = longAnswer(answer);
    const expanded = expandedAnswers.has(answer.id);
    return `<article id="answer-${escape(answer.id)}" class="AnswerItem answer-card card ${isLong && !expanded ? 'is-collapsed' : ''}" data-answer-id="${escape(answer.id)}">
      <header class="answer-author"><span class="author-avatar hue-${index % 3}">${escape(initials(answer.author))}</span><div><strong class="AuthorInfo-name">${escape(answer.author)}</strong></div><button type="button">＋ 关注</button></header>
      <div class="RichContent-inner"><div class="RichText"><div class="answer-content-body">${answerContent(answer)}</div>${isLong ? `<button class="ContentItem-expandButton read-full" type="button" data-expand-answer="${escape(answer.id)}">${expanded ? '收起回答' : '阅读全文'} ${expanded ? '⌃' : '⌄'}</button>` : ''}</div></div>
      ${engagement(answer)}
      ${commentsPanel(answer)}
    </article>`;
  }

  function renderQuestion() {
    const id = location.pathname.match(/\/question\/(\w+)/)?.[1] || new URLSearchParams(location.search).get('id') || '10001';
    const foundIndex = data.questions.findIndex(item => item.id === id);
    const index = foundIndex >= 0 ? foundIndex : 0;
    const question = data.questions[index];
    if (!question) {
      document.body.dataset.questionId = '';
      document.title = '内容数据尚未配置 - 知乎模拟站';
      document.querySelector('#questionHeader').innerHTML = '<div class="question-header-inner"><div class="question-main"><h1 class="QuestionHeader-title">内容数据尚未配置</h1><p>请在服务器上挂载私有内容目录后刷新页面。</p></div></div>';
      document.querySelector('#answerCount').textContent = '查看全部 0 个回答';
      document.querySelector('#answers').innerHTML = '';
      window.dispatchEvent(new Event('zhihu:render'));
      return;
    }
    document.body.dataset.questionId = question.id;
    document.title = `${question.title} - 知乎模拟站`;
    document.querySelector('#questionHeader').innerHTML = `<div class="question-header-inner">
      <div class="question-main">
        <div class="tag-row">${question.tags.map(tag => `<span>${escape(tag)}</span>`).join('')}</div><h1 class="QuestionHeader-title">${escape(question.title)}</h1>${question.description ? `<p>${escape(question.description)}</p>` : ''}
        <div class="question-actions"><button class="primary" type="button">关注问题</button><button type="button">✎ 写回答</button><button type="button">邀请回答</button></div>
      </div>
      <dl class="question-stats"><div><dt>关注者</dt><dd>${displayCount(question.followers)}</dd></div><div><dt>被浏览</dt><dd>${displayCount(question.views)}</dd></div></dl>
    </div>`;
    document.querySelector('#answerCount').textContent = `查看全部 ${question.answers.length} 个回答`;
    document.querySelector('#answers').innerHTML = question.answers.map(answerCard).join('');
    bindImageFallbacks();
    window.dispatchEvent(new Event('zhihu:render'));
  }

  function bindImageFallbacks() {
    document.querySelectorAll('img').forEach(image => image.addEventListener('error', () => {
      const feedVisual = image.closest('.feed-visual');
      if (feedVisual) {
        const summary = feedVisual.closest('.feed-summary');
        feedVisual.remove();
        summary?.classList.remove('with-image');
        summary?.classList.add('no-image');
      } else image.closest('.answer-media')?.remove();
    }, { once: true }));
  }

  function renderAccount() {
    const button = document.querySelector('#authButton');
    if (!button) return;
    const user = community.session.user;
    button.textContent = user ? `${initials(user.name)} ${user.name}` : '知乎登录';
    button.classList.toggle('is-signed-in', Boolean(user));
    button.title = user ? '点击退出当前账号' : '使用知乎账号登录';
    renderCollisionQuota();
  }

  function renderCollisionQuota() {
    const badge = document.querySelector('#collisionQuota');
    if (!badge) return;
    const quota = community.collisionQuota || { limit: 10, used: 0, remaining: 10 };
    const signedIn = Boolean(community.session.user);
    badge.hidden = !signedIn;
    badge.classList.toggle('is-low', signedIn && quota.remaining > 0 && quota.remaining <= 3);
    badge.classList.toggle('is-empty', signedIn && quota.remaining === 0);
    badge.innerHTML = `<span>今日碰撞</span><strong>${escape(quota.remaining)}/${escape(quota.limit)}</strong>`;
    badge.title = `今天已使用 ${quota.used} 次；失败或无结果也计入，每天 0 点重置。`;
  }

  function onboardingKey(user) {
    return `${ONBOARDING_VERSION}:${String(user?.id || '')}`;
  }

  function showOnboardingIfNeeded() {
    const user = community.session.user;
    if (!user || document.querySelector('#collisionOnboarding')) return;
    try { if (localStorage.getItem(onboardingKey(user)) === 'seen') return; } catch {}
    const quota = community.collisionQuota || { limit: 10 };
    document.body.insertAdjacentHTML('beforeend', `<div class="onboarding-overlay" id="collisionOnboarding">
      <section class="onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="onboardingTitle">
        <button class="onboarding-close" type="button" data-onboarding-close aria-label="关闭使用说明">×</button>
        <div class="onboarding-hero"><img src="/web/assets/liu-kanshan-collision-guide.png" alt="刘看山把两张观点卡碰撞成新问题的示意图"></div>
        <div class="onboarding-content">
          <p class="onboarding-eyebrow">欢迎回来，${escape(user.name)}</p>
          <h2 id="onboardingTitle">四步发现回答之间的新问题</h2>
          <ol class="onboarding-steps">
            <li><b>1</b><span><strong>选择两篇回答</strong>在同一个问题下挑选值得比较的回答。</span></li>
            <li><b>2</b><span><strong>生成观点结构图</strong>蓝色末层卡片是可以参与碰撞的观点。</span></li>
            <li><b>3</b><span><strong>拖动两张观点卡</strong>把来自不同回答的相关观点放到一起。</span></li>
            <li><b>4</b><span><strong>查看并参与讨论</strong>AI 会说明关系并提出新的延申问题。</span></li>
          </ol>
          <aside class="onboarding-quota"><span>每日额度</span><strong>每人每天 ${escape(quota.limit)} 次碰撞</strong><p>点击“开始碰撞”就会计 1 次，<em>失败、无结果、缓存命中也计入总次数</em>；北京时间每天 0 点重置。</p></aside>
          <button class="onboarding-start" type="button" data-onboarding-close>我知道了，开始探索</button>
        </div>
      </section>
    </div>`);
    requestAnimationFrame(() => document.querySelector('.onboarding-start')?.focus());
  }

  function dismissOnboarding() {
    const user = community.session.user;
    if (user) { try { localStorage.setItem(onboardingKey(user), 'seen'); } catch {} }
    document.querySelector('#collisionOnboarding')?.remove();
  }

  function renderPage() {
    renderAccount();
    if (document.body.dataset.page === 'home') renderHome();
    if (document.body.dataset.page === 'question') renderQuestion();
  }

  async function loadCommunity() {
    const [communityResult, sessionResult] = await Promise.allSettled([
      fetch('/api/community').then(async response => response.ok ? response.json() : Promise.reject(new Error(`community ${response.status}`))),
      fetch('/api/auth/session').then(async response => response.ok ? response.json() : Promise.reject(new Error(`session ${response.status}`)))
    ]);
    if (communityResult.status === 'fulfilled') community = communityResult.value;
    // 登录状态独立读取：社区统计接口偶发失败时，不能把它误报成“知乎登录未配置”。
    if (sessionResult.status === 'fulfilled') community.session = sessionResult.value;
    if (!community.session.user) {
      location.replace(`/auth/zhihu?return_to=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }
    renderPage();
    showOnboardingIfNeeded();
  }

  function startLogin() {
    if (community.session.user) return true;
    location.href = `/auth/zhihu?return_to=${encodeURIComponent(location.pathname + location.search)}`;
    return false;
  }

  async function post(path, body) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (response.status === 401) { startLogin(); throw new Error('请先登录。'); }
    if (!response.ok) throw new Error(result.error || '操作失败。');
    community = result;
    renderPage();
    return result;
  }

  document.addEventListener('click', async event => {
    if (event.target.closest('[data-onboarding-close]')) { dismissOnboarding(); return; }
    const expand = event.target.closest('[data-expand-answer]');
    if (expand) {
      const answerId = expand.dataset.expandAnswer;
      if (expandedAnswers.has(answerId)) expandedAnswers.delete(answerId); else expandedAnswers.add(answerId);
      renderQuestion();
      document.querySelector(`[data-answer-id="${CSS.escape(answerId)}"]`)?.scrollIntoView({ block: 'start' });
      return;
    }
    if (event.target.closest('[data-scroll-top]')) { scrollTo({ top: 0, behavior: 'smooth' }); return; }
    const comments = event.target.closest('[data-comments-for]');
    if (comments) {
      const answerId = comments.dataset.commentsFor;
      if (document.body.dataset.page === 'home') {
        window.open(`/question/${answerId.split('-')[0]}?comments=${encodeURIComponent(answerId)}`, '_blank', 'noopener');
        return;
      }
      if (openCommentPanels.has(answerId)) openCommentPanels.delete(answerId); else openCommentPanels.add(answerId);
      renderQuestion();
      return;
    }
    const action = event.target.closest('[data-action]');
    if (action) {
      if (!community.session.user) { startLogin(); return; }
      action.disabled = true;
      try { await post('/api/community/action', { action: action.dataset.action, questionId: action.dataset.questionId, answerId: action.dataset.answerId }); }
      catch (error) { action.disabled = false; if (error.message !== '请先登录。') alert(error.message); }
      return;
    }
    if (event.target.closest('[data-login]')) { startLogin(); return; }
    const auth = event.target.closest('#authButton');
    if (auth) {
      if (!community.session.user) startLogin();
      else if (confirm(`当前账号：${community.session.user.name}\n是否退出登录？`)) { await fetch('/api/auth/logout', { method: 'POST' }); location.reload(); }
    }
  });

  document.addEventListener('submit', async event => {
    const form = event.target.closest('.comment-form');
    if (!form) return;
    event.preventDefault();
    const input = form.elements.comment;
    const text = input.value.trim();
    if (!text) return;
    form.querySelector('button').disabled = true;
    try { await post('/api/community/comment', { questionId: form.dataset.questionId, answerId: form.dataset.answerId, text }); }
    catch (error) { form.querySelector('button').disabled = false; if (error.message !== '请先登录。') alert(error.message); }
  });

  window.ZhihuDemoCommunity = {
    requireAccount: startLogin,
    isAuthenticated() { return Boolean(community.session.user); },
    currentUser() {
      const user = community.session.user;
      return user ? { id: user.id, name: user.name } : { id: 'local-guest', name: '本地体验者' };
    },
    updateCollisionQuota(value) {
      if (!value) return;
      community.collisionQuota = value;
      renderCollisionQuota();
    },
    recordMap(answerId) {
      if (!answerId || !community.session.user) return Promise.resolve(false);
      return post('/api/community/action', { action: 'map', questionId: answerId.split('-')[0], answerId }).then(() => true).catch(() => false);
    }
  };

  window.ZhihuDemoView = {
    answerContent,
    expandAnswer(answerId) { expandedAnswers.add(answerId); renderQuestion(); }
  };

  document.querySelector('.search input')?.addEventListener('focus', event => event.target.select());
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.querySelector('#collisionOnboarding')) dismissOnboarding(); });
  renderPage();
  loadCommunity();
})();
