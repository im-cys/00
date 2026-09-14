/* MVP interaction layer for the design in MVP页面流程与数据对象.md. */
(() => {
  'use strict';
  const questions = window.ZHIHU_DEMO_DATA?.questions || [];
  const maps = window.COLLISION_MAPS || {};
  // 前端回答编号（10002-09）↔ 抽取产物编号（q2_a9）。
  // 后端碰撞服务按抽取编号索引原文，两者必须显式映射，不能靠下标推算：
  // q3/q6 的抽取产物存在整体偏移一位的真实错位，已由 quote 回原文反查校正。
  const legacyOf = answerId => maps[answerId]?.legacyId || null;
  let liveMaps = false;
  const core = window.CollisionCore;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const qById = id => questions.find(q => q.id === id);
  const answer = id => qById(id?.split('-')[0])?.answers.find(a => a.id === id);
  const findTreeNode = (rootNode,id) => {
    if(!rootNode||!id)return null;
    if(rootNode.id===id)return rootNode;
    for(const child of rootNode.children||[]){const found=findTreeNode(child,id);if(found)return found;}
    return null;
  };
  const node = ref => maps[ref?.answerId]?.nodes?.find(n => n.id === ref.nodeId)||findTreeNode(maps[ref?.answerId]?.tree,ref?.nodeId);
  const nodeQuote = value => value?.quote||value?.sourceAnchors?.[0]?.quote||'';
  const isCollidable = value => value?.collidable===true||value?.kind==='collision';
  // statement 是当前字段名；text / claim_text 只为读取旧缓存保留。
  const nodeText = value => value?.statement||value?.text||value?.claim_text||'';
  // displayText 只负责卡片扫读；完整 statement 始终保留给详情与碰撞判断。
  // 旧结构的 branch 没有 displayText 时优先使用完整 summary，不再把「信息与后路」类目录 title 放到卡片上。
  const nodeDisplayText = value => value?.displayText||value?.display_text||value?.summary||nodeText(value)||value?.title||'';
  const CONDITION_LABEL = {audience:'人群',stage:'阶段',premise:'前提'};
  function conditionText(value){
    const conditions=value?.conditions;
    if(conditions&&typeof conditions==='object'){
      const parts=Object.keys(CONDITION_LABEL)
        .filter(key=>Array.isArray(conditions[key])&&conditions[key].length)
        .map(key=>`${CONDITION_LABEL[key]}：${conditions[key].join('、')}`);
      if(parts.length)return parts.join('；');
    }
    return Array.isArray(value?.scopes)?value.scopes.join('；'):(value?.scope||'');
  }
  const paragraphsOf = answerId => answer(answerId)?.paragraphs?.filter(p => !p.includes('〔图片〕') && !p.includes('〔视频〕')) || [];
  const cut = (s, n = 46) => [...String(s || '')].slice(0, n).join('') + ([...String(s || '')].length > n ? '…' : '');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const traceId = (()=>{try{const old=sessionStorage.getItem('answer-tree-trace-id');if(old)return old;const value=crypto.randomUUID();sessionStorage.setItem('answer-tree-trace-id',value);return value;}catch{return '';}})();
  function trace(event,details={}){
    const payload={event,traceId,questionId:document.body.dataset.questionId||'',...details};
    void fetch('/api/local/trace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),keepalive:true}).catch(()=>{});
  }
  async function apiJson(response, fallback = '服务暂时不可用，请稍后重试。') {
    const text = await response.text();
    try { return text ? JSON.parse(text) : {}; }
    catch { throw new Error(fallback); }
  }
  async function generateMap(answerId) {
    let response=await fetch('/api/maps/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({answerId,traceId})});
    let result=await apiJson(response,'生成服务响应超时，请稍后重试。');
    if(response.status===401){window.ZhihuDemoCommunity?.requireAccount?.();throw new Error('请先登录。');}
    if(!response.ok&&response.status!==202)throw new Error(result.error||'结构图生成失败。');
    for(let attempt=0;(response.status===202||result.status==='processing')&&attempt<450;attempt++){
      await wait(2000);
      response=await fetch(`/api/maps/generate?answerId=${encodeURIComponent(answerId)}`);
      result=await apiJson(response,'无法读取生成进度，请稍后重试。');
      if(response.status===401){window.ZhihuDemoCommunity?.requireAccount?.();throw new Error('请先登录。');}
      if(!response.ok&&response.status!==202)throw new Error(result.error||'结构图生成失败。');
    }
    if(!result.map)throw new Error('本次生成超过 15 分钟，请重新生成。');
    return result;
  }
  const when = value => value ? new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
  const names = {draft:'私有草稿',pending:'待审核',returned:'已退回',published:'已公开',withdrawn:'已撤回',hidden:'已下架',discarded:'已放弃'};
  const actions = {contrast:'交锋',synthesize:'合流'};
  // 动作内化后，卡片上展示 AI 判定的关系类型；旧数据回退到动作名。
  const tagOf = item => item.relationType || actions[item.action] || '碰撞';
  const L = core.LIMITS;
  const MAX_FLOATING_ANSWERS = 5;
  const icons = {
    nodes:'<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="9" y="15" width="6" height="6" rx="1"/><path d="M6 9v3h12V9M12 12v3"/>',
    close:'<path d="m6 6 12 12M18 6 6 18"/>',
    spark:'<path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6Z"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
    book:'<path d="M12 5c-4-3-9-2-9-2v16s5-1 9 2c4-3 9-2 9-2V3s-5-1-9 2v16"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    trash:'<path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    alert:'<path d="M12 4 2.5 20h19Z"/><path d="M12 10v4m0 3v.5"/>',
    shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6Z"/><path d="m8 12 3 3 5-6"/>'
  };
  const icon = name => `<svg class="co-icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.nodes}</svg>`;
  const btn = (text, action, cls = '', attrs = '') => `<button type="button" class="co-btn ${cls}" data-co="${action}" ${attrs}>${text}</button>`;
  const badge = (text, cls = '') => `<span class="co-badge ${cls}">${esc(text)}</span>`;

  const KEY = 'zhihu-collision-mvp-v3';
  const STALE_KEYS = ['zhihu-collision-mvp-v1','zhihu-collision-mvp-v2'];
  let storageError = false;
  let state = {version:3,items:[],comments:{},workspaces:{},follows:[],jobs:[],issues:[],opened:[]};
  function loadState() {
    let saved = null;
    try {
      STALE_KEYS.forEach(key => localStorage.removeItem(key));
      saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    }
    catch { storageError = true; return; }
    if(!saved || typeof saved !== 'object') return;
    state = {version:3,
      items:Array.isArray(saved.items)?saved.items:[],
      comments:saved.comments&&typeof saved.comments==='object'?saved.comments:{},
      workspaces:saved.workspaces&&typeof saved.workspaces==='object'?saved.workspaces:{},
      follows:Array.isArray(saved.follows)?saved.follows:[],
      jobs:Array.isArray(saved.jobs)?saved.jobs:[],
      issues:Array.isArray(saved.issues)?saved.issues:[],
      opened:Array.isArray(saved.opened)?saved.opened:[]};
    state.items = state.items.filter(i => i && qById(i.questionId) && Array.isArray(i.refs) && i.refs.length === 2 && i.refs.every(r => node(r)) && names[i.status])
      .map(i => ({eligibility:'eligible',revisions:[],reviews:[],...i}));
    for(const [id,list] of Object.entries(state.comments))
      state.comments[id] = (Array.isArray(list)?list:[]).map(c => ({status:'visible',author:c.author||'本地体验者',authorId:c.authorId||'local-guest',...c}));
  }
  loadState();
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); return true; }
    catch { toast('浏览器存储不可用，本次内容仅在当前页面保留，请勿刷新。'); return false; }
  }
  const uid = prefix => `${prefix}-${crypto.randomUUID().slice(0,12)}`;
  const me = () => window.ZhihuDemoCommunity?.currentUser?.() || {id:'local-guest',name:'本地体验者'};

  const root = document.createElement('div'); root.className = 'co-root'; document.body.append(root);
  const dialog = document.createElement('dialog'); dialog.className = 'co-dialog'; document.body.append(dialog);
  const toastEl = document.createElement('div'); toastEl.className = 'co-toast'; toastEl.setAttribute('role','status'); toastEl.hidden = true; document.body.append(toastEl);
  let toastTimer, wb = null, pair = [], selection = new Set(), selectedQuestion = null, collisionRefs = [], collisionAction = 'contrast',
      editor = null, dirty = false, modalKind = '', lastFocus = null, shelfTab = 'draft', sourceReturn = null, dragRef = null, dropReject = null, draggedAnswerId = null, ballPointerDrag = null, canvasPointerDrag = null, suppressBallClickId = null, nodeClickTimer = null, reviewerMode = false, selectMode = false, firstFind = false;
  const mapViews = new Map();
  const mapGeneration = new Map();
  const expandedDiscoveries = new Set();
  // 碰撞已接入真实模型链路（关系判定 + 提问 + evidence 回查），不再是模板规则。
  // “公开”是本站公开，不会自动发布到知乎。
  const demoNote = '<div class="co-demo-note">本站功能试用 · 碰撞由 AI 生成并经 evidence 回原文校验；公开内容仅展示在本站，不会自动发布到知乎。</div>';
  function toast(message) { clearTimeout(toastTimer); toastEl.textContent=message; toastEl.hidden=false; toastTimer=setTimeout(()=>toastEl.hidden=true,4600); }
  function openModal(title, subtitle, body, footer='', wide=false, kind='') {
    if(!dialog.open)lastFocus=document.activeElement;
    modalKind=kind; dirty=false;
    dialog.className=`co-dialog ${wide?'wide':''}${firstFind?' is-first-find':''}`;
    dialog.innerHTML=`<header class="co-dialog-head"><div><h2 id="co-modal-title">${esc(title)}</h2><div class="co-muted">${esc(subtitle)}</div></div><button class="co-iconbtn" data-co="close-modal" aria-label="关闭弹窗">${icon('close')}</button></header><div class="co-dialog-body">${body}</div>${footer?`<footer class="co-dialog-footer">${footer}</footer>`:''}`;
    dialog.setAttribute('aria-labelledby','co-modal-title');
    if(!dialog.open)dialog.showModal();
    document.body.style.overflow='hidden';
  }
  function closeModal(force=false) {
    if(!force && dirty && !confirm('还没有保存修改。确定放弃这些修改吗？'))return false;
    dialog.close(); dirty=false; modalKind=''; document.body.style.overflow='';
    if(lastFocus?.isConnected)lastFocus.focus({preventScroll:true}); return true;
  }
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeModal();});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeModal();}});

  /* ---------- 数据读取：Insight、评论、异议 ---------- */
  const allItems=()=>state.items;
  function homePreviewItems(qid) {
    return allItems().filter(i=>i.questionId===qid&&i.status==='published')
      .sort((a,b)=>(b.publishedAt||0)-(a.publishedAt||0)).slice(0,2);
  }
  const itemById=id=>allItems().find(i=>i.id===id);
  const publicItems=qid=>allItems().filter(i=>i.questionId===qid&&i.status==='published');
  const visibleComments=id=>(Array.isArray(state.comments[id])?state.comments[id]:[]).filter(c=>c.status==='visible');
  const allComments=id=>Array.isArray(state.comments[id])?state.comments[id]:[];
  const countComments=id=>visibleComments(id).length;
  const openIssues=id=>state.issues.filter(x=>x.insightId===id&&x.status==='open');
  const myItems=qid=>state.items.filter(i=>i.questionId===qid&&i.creatorId===me().id);

  /* ---------- 页面装饰：首页卡片、问题聚合条、回答关联区 ---------- */
  function insightCard(item,compact=false) {
    return `<button class="co-feed-insight" data-co="detail" data-id="${esc(item.id)}">${icon('spark')}<strong>${esc(item.title)}</strong><span class="co-muted">本站公开 · ${tagOf(item)} · ${item.refs.map(r=>esc(answer(r.answerId)?.author)).join(' × ')} · ${countComments(item.id)} 条讨论${compact?'':'　查看发现 →'}</span></button>`;
  }
  // 延申问题的统一说明文案：首页与问题页共用，避免两处叫法不一致。
  const DISCOVERY_HINT='延申问题：由同一问题下两篇不同回答的观点碰撞后，延申生成的新问题。';
  // 来源行统一写成“基于 XX 答主与 XX 答主回答延申出来的 · 首次发现人：XXX”，答主可点击直达其回答。
  function discoveryMeta(item){
    const links=item.refs.map(r=>{
      const a=answer(r.answerId);
      if(!a)return '';
      return `<button type="button" class="co-author-link" data-co="jump-answer" data-aid="${esc(r.answerId)}" title="前往 ${esc(a.author)} 的回答">${esc(a.author)}</button> 答主`;
    }).filter(Boolean);
    const base=links.length?`基于 ${links.join(' 与 ')} 回答延申出来的`:'基于本问题下的回答延申出来的';
    return `<small class="co-discovery-meta"><span>${base}</span><i>首次发现人：${esc(item.author)}</i></small>`;
  }
  function homeInsightPanel(items) {
    return `<section class="co-feed-discoveries" aria-label="延申问题">
      <header class="co-feed-discoveries-head">
        <div><span class="co-feed-discoveries-icon">${icon('spark')}</span><strong>延申问题</strong><span class="co-muted">由两篇回答碰撞延申出的新问题</span></div>
        <span class="co-feed-discoveries-count">${items.length} 条</span>
      </header>
      <div class="co-feed-discoveries-list">${items.map((item,index)=>{const anchor=`insight-${item.id}-${item.refs[0]?.answerId||''}`;const href=`/question/${esc(item.questionId)}?focusInsight=${encodeURIComponent(item.id)}#${esc(anchor)}`;return `<div class="co-feed-question"><span class="co-feed-question-index">${index+1}</span><span><a class="co-discovery-title" href="${href}">${esc(item.title)}</a>${discoveryMeta(item)}<a class="co-discovery-go" href="${href}">前往问题 →</a></span></div>`;}).join('')}</div>
    </section>`;
  }
  function questionDiscoveryItems(qid){
    return publicItems(qid).sort((a,b)=>(b.publishedAt||0)-(a.publishedAt||0));
  }
  function inlineDiscoveryDetail(item){
    const comments=visibleComments(item.id);
    const analysis=item.relationText||item.rationale||'这个问题来自两篇回答中不同的判断前提。';
    // 外层 summary 已经显示过问题标题，展开里再重复一次没有信息量。
    // 没有详情说明时整段不渲染——降级回标题等于把要替换掉的重复内容又放回来。
    const detail=questionDetailHtml(item,'co-inline-question-detail');
    return `<div class="co-inline-detail" ${expandedDiscoveries.has(item.id)?'':'hidden'}>
      <section class="co-inline-analysis"><strong>AI 分析</strong>${collisionAnalysisHtml(analysis)}</section>
      ${detail?`<section class="co-inline-question"><span>关于这个问题</span>${detail}</section>`:''}
      <section class="co-inline-comments"><div class="co-between"><strong>围绕这个问题讨论 · ${comments.length}</strong></div><ol>${comments.slice(0,3).map(c=>`<li><b>${esc(c.author)}</b><span>${esc(c.text)}</span></li>`).join('')||'<li class="co-muted">还没有讨论，可以补充回答或指出前提。</li>'}</ol><form class="co-comment-form co-inline-comment-form" data-inline="true" data-insight="${esc(item.id)}"><textarea class="co-comment-input" name="comment" rows="2" maxlength="${L.comment}" placeholder="围绕这个问题评论…" aria-label="发现评论" required></textarea><button type="submit" class="co-btn primary">发布</button></form></section>
    </div>`;
  }
  function inlineDiscoveryItem(item,contextId='question'){
    const expanded=expandedDiscoveries.has(item.id);
    const domId=`insight-${item.id}-${contextId}`;
    return `<article class="co-discovery-item${expanded?' is-expanded':''}" id="${esc(domId)}" data-insight-id="${esc(item.id)}"><div class="co-discovery-summary"><span class="co-discovery-spark">${icon('spark')}</span><span><strong>${esc(item.title)}</strong>${discoveryMeta(item)}</span><b><button type="button" class="co-discovery-act" data-co="toggle-discovery" data-id="${esc(item.id)}" aria-expanded="${expanded}">${expanded?'收起':'展开'} ›</button></b></div>${inlineDiscoveryDetail(item)}</article>`;
  }
  function discoveryJumpItem(item){
    const aid=item.refs[0]?.answerId||'';
    const href=`/question/${esc(item.questionId)}?focusInsight=${encodeURIComponent(item.id)}#insight-${esc(item.id)}-${esc(aid)}`;
    return `<div class="co-discovery-summary co-discovery-jump"><span class="co-discovery-spark">${icon('spark')}</span><span><a class="co-discovery-title" href="${href}">${esc(item.title)}</a>${discoveryMeta(item)}</span><b><a class="co-discovery-act" href="${href}">前往 ›</a></b></div>`;
  }
  function decorate() {
    document.querySelectorAll('.feed-item').forEach(card=>{
      card.querySelector('.co-feed-discoveries')?.remove();
      const items=homePreviewItems(card.dataset.questionId);
      if(items.length)card.querySelector('.engagement')?.insertAdjacentHTML('beforebegin',homeInsightPanel(items));
    });
    const qid=document.body.dataset.questionId, q=qById(qid);
    document.querySelector('.co-question-discoveries')?.remove();
    if(q) {
      const items=questionDiscoveryItems(qid);
      document.querySelector('#answerCount')?.insertAdjacentHTML('beforebegin',`<section class="co-question-discoveries co-root" id="collision-insights"><div class="co-between"><h2 class="co-section-title">${icon('spark')}延申问题 · ${items.length} 条</h2><span class="co-muted">点击标题前往对应的延申条目</span></div><p class="co-section-hint">${DISCOVERY_HINT}</p>${items.length?`<div class="co-discovery-list co-discovery-scroll">${items.map(discoveryJumpItem).join('')}</div>`:'<div class="co-muted" style="margin-top:12px">还没有公开的延申问题，试着选两篇回答碰撞。</div>'}</section>`);
      document.querySelectorAll('.AnswerItem').forEach(card=>{
        card.querySelector('.co-association')?.remove(); card.querySelector('.co-pick')?.remove(); card.querySelector('.co-pick-hint')?.remove();
        const aid=card.dataset.answerId;
        // 选择模式下才出现选取控件；平时阅读页面只保留轻量的插件入口。
        const picked=selectMode&&selection.has(aid);
        card.classList.toggle('co-pickable',selectMode);
        card.classList.toggle('co-picked',picked);
        if(selectMode){
          card.querySelector('.answer-author')?.insertAdjacentHTML('beforeend',
            `<button type="button" class="co-pick${picked?' is-picked':''}" data-co="toggle-pick" data-aid="${aid}" aria-pressed="${picked}">${picked?icon('check')+'已选择':'选择这篇'}</button>`);
          return;
        }
        const linked=items.filter(i=>i.refs.some(r=>r.answerId===aid));
        if(linked.length)card.insertAdjacentHTML('beforeend',`<section class="co-association co-root"><div class="co-between"><strong style="font-size:13px">${icon('spark')}由这篇回答延申出的问题 · ${linked.length} 条</strong><span class="co-muted">点击展开</span></div><div class="co-discovery-list">${linked.map(i=>inlineDiscoveryItem(i,aid)).join('')}</div></section>`);
      });
      if(!document.querySelector('.co-question-aside'))document.querySelector('.question-layout')?.insertAdjacentHTML('beforeend',`<aside class="co-question-aside co-root"><section class="co-side-card"><h3>也可以看看</h3><ul class="co-side-links">${questions.filter(x=>x.id!==qid).slice(0,4).map(x=>`<li><a href="/question/${x.id}">${esc(x.title)}</a></li>`).join('')}</ul></section><p class="co-side-note">知乎页面模拟 · 与知乎官方无关</p></aside>`);
      focusLinkedDiscovery();
    }
    document.querySelectorAll('.answer-author>button:not([data-co])').forEach(b=>{b.dataset.co='follow';b.dataset.follow=b.closest('.AnswerItem').dataset.answerId;paintFollow(b);});
    document.querySelectorAll('.question-actions button').forEach((b,i)=>{b.dataset.co=['follow','compose','invite'][i];if(i===0){b.dataset.follow=qid;paintFollow(b);}});
    renderPickBar();
    renderSelectFab();
  }
  function paintFollow(button){const followed=state.follows.includes(button.dataset.follow);button.textContent=followed?'已关注':button.dataset.follow?.includes('-')?'＋ 关注':'关注问题';button.classList.toggle('co-followed',followed);button.setAttribute('aria-pressed',String(followed));}
  function focusLinkedDiscovery(){
    if(document.body.dataset.discoveryFocusScheduled)return;
    const id=location.hash.slice(1);
    if(!id.startsWith('insight-'))return;
    if(!document.getElementById(id))return;
    document.body.dataset.discoveryFocusScheduled='true';
    setTimeout(()=>{const target=document.getElementById(id);if(!target)return;target.scrollIntoView({block:'center'});target.classList.add('is-targeted');setTimeout(()=>target.classList.remove('is-targeted'),2200);},450);
  }
  function renderSelectFab(){
    root.querySelector('.co-select-fab')?.remove();
    const qid=document.body.dataset.questionId;
    if(!qid||selectMode)return;
    // 每次生成后都恢复成初始入口。已打开/最小化的浮窗不改变入口文案。
    root.insertAdjacentHTML('beforeend',`<button class="co-select-fab" data-co="select" data-qid="${esc(qid)}">${icon('nodes')}<span><strong>选择回答探索</strong><small>生成双节点地图</small></span></button>`);
  }
  /* 选择模式：用户仍在原页上下浏览，选好后直接打开右侧节点浮窗。 */
  function renderPickBar(){
    root.querySelector('.co-pickbar')?.remove();
    if(!selectMode)return;
    const qid=document.body.dataset.questionId;
    const names=[...selection].map(id=>cut(answer(id)?.author,8)).join('、');
    root.insertAdjacentHTML('beforeend',`<div class="co-pickbar co-root" role="region" aria-label="选择回答">
      <div class="co-pickbar-info"><strong>选择回答探索 <em>已选 ${selection.size}</em></strong><span class="co-muted">${selection.size?esc(names):'继续浏览，点击回答卡片即可选中'}${selection.size===1?' · 再选 1 篇即可碰撞':''}</span></div>
      <div class="co-row">${btn('退出选择','exit-select','small')}${btn('点击生成','start-workbench','primary'+(selection.size?'':' '),selection.size?'':'disabled')}</div>
    </div>`);
  }
  function enterSelectMode(qid,aid){
    const target=qid||document.body.dataset.questionId;
    if(target&&document.body.dataset.questionId!==target){
      location.href=`/question/${target}?explore=1${aid?`&pick=${encodeURIComponent(aid)}`:''}`;return;
    }
    selectedQuestion=qById(document.body.dataset.questionId)||questions[0];
    // 每次打开选择器都创建全新的临时会话。节点窗/本地存储中的历史回答
    // 不能反向预选当前页面的回答，否则关页再进仍会残留“已选”。
    selection=new Set();
    const previous=workspace(selectedQuestion.id);
    if(aid&&(previous.selected.includes(aid)||previous.selected.length<MAX_FLOATING_ANSWERS))selection.add(aid);
    selectMode=true;
    trace('select_mode_entered',{answerId:aid||'',selectedCount:selection.size});
    decorate();
    toast(`已进入选择模式：向下浏览回答，点击卡片选择，最多 ${MAX_FLOATING_ANSWERS} 篇。`);
  }
  function exitSelectMode(){selectMode=false;selection=new Set();selectedQuestion=null;decorate();toast('已退出选择模式，选择已清空。');}
  function togglePick(aid){
    if(!answer(aid))return;
    if(selection.has(aid)){selection.delete(aid);trace('answer_unselected',{answerId:aid,selectedCount:selection.size});}
    else if(new Set([...(wb?.questionId===document.body.dataset.questionId?wb.selected:workspace(document.body.dataset.questionId).selected),...selection,aid]).size>MAX_FLOATING_ANSWERS)return toast(`插件最多保留 ${MAX_FLOATING_ANSWERS} 篇，请先移除一篇。`);
    else {selection.add(aid);trace('answer_selected',{answerId:aid,selectedCount:selection.size});}
    decorate();
  }

  /* ---------- P03：回答选择器 ---------- */
  function workspace(qid) {
    const stored=state.workspaces[qid]||{};
    const selected=[...new Set((stored.selected||[]).filter(id=>answer(id)&&id.split('-')[0]===qid))].slice(0,MAX_FLOATING_ANSWERS);
    const slots=(stored.slots||[]).filter(id=>selected.includes(id));
    return {questionId:qid,selected,slots:[...new Set(slots)].concat([null,null]).slice(0,2),reader:selected.includes(stored.reader)?stored.reader:selected[0],groups:stored.groups||{},mobile:stored.mobile||'maps'};
  }
  function saveWorkspace(){if(wb){state.workspaces[wb.questionId]={...wb};persist();}}
  async function runMapGeneration(answerId){
    mapGeneration.set(answerId,{status:'processing',error:''});
    trace('map_generate_started',{answerId});
    if(wb?.selected.includes(answerId))renderWorkbench();
    try{
      const result=await generateMap(answerId);
      maps[result.answerId]=result.map;
      mapGeneration.set(answerId,{status:'ready',error:''});
      trace('map_generate_succeeded',{answerId,nodeCount:result.map?.nodes?.length||0});
    }catch(error){
      mapGeneration.set(answerId,{status:'failed',error:error.message||'结构图生成失败，请稍后重试。'});
      trace('map_generate_failed',{answerId,status:'failed'});
    }
    if(wb?.selected.includes(answerId))renderWorkbench();
  }
  function retryMapGeneration(answerId){
    if(!answer(answerId)||mapGeneration.get(answerId)?.status==='processing')return;
    if(!window.ZhihuDemoCommunity?.isAuthenticated?.()){window.ZhihuDemoCommunity?.requireAccount?.();return;}
    trace('map_generate_retried',{answerId});
    void runMapGeneration(answerId);
  }
  function startWorkbench(){
    if(!selection.size)return;
    selectedQuestion=qById(document.body.dataset.questionId)||selectedQuestion||questions[0];
    const previous=wb?.questionId===selectedQuestion.id?wb:workspace(selectedQuestion.id);
    const incoming=[...selection];
    let next;
    try{next=core.mergeAnswers(previous,incoming,MAX_FLOATING_ANSWERS);}catch(error){toast(error.message);return;}
    const missing=incoming.filter(id=>!maps[id]&&mapGeneration.get(id)?.status!=='processing');
    if(missing.length){
      if(!window.ZhihuDemoCommunity?.isAuthenticated?.()){ window.ZhihuDemoCommunity?.requireAccount?.(); return; }
    }
    wb={...next,questionId:selectedQuestion.id};pair=[];
    trace('workbench_opened',{answerIds:wb.selected,addedAnswerIds:incoming,selectedCount:wb.selected.length,visibleAnswerIds:wb.slots.filter(Boolean)});
    missing.forEach(id=>mapGeneration.set(id,{status:'processing',error:''}));
    selectMode=false;
    selection=new Set();
    selectedQuestion=null;
    if(dialog.open)closeModal(true);
    saveWorkspace();decorate();renderWorkbench();
    if(missing.length){
      toast(`浮窗已打开，正在生成 ${missing.length} 篇回答的结构图。可以先最小化浮窗。`);
      missing.forEach(id=>void runMapGeneration(id));
    }else toast('文章观点树已打开。树的末层蓝色节点可以跨回答碰撞。');
  }

  /* ---------- P05：原页上的右侧节点浮窗 ---------- */
  function treeGraphHtml(aid,m){
    const cardW=176,cardH=64,gapX=58,gapY=22,padX=28,padY=30;
    const placed=[],edges=[];
    let leafIndex=0,maxDepth=0;
    function place(item,depth=0){
      maxDepth=Math.max(maxDepth,depth);
      const children=(item.children||[]).map(child=>place(child,depth+1));
      const y=children.length?(children[0].y+children[children.length-1].y)/2:padY+(leafIndex++)*(cardH+gapY);
      const entry={item,depth,x:padX+depth*(cardW+gapX),y};
      placed.push(entry);
      for(const child of children)edges.push({from:entry,to:child});
      return entry;
    }
    place(m.tree);
    const canvasW=padX*2+(maxDepth+1)*cardW+maxDepth*gapX;
    const canvasH=Math.max(220,padY*2+Math.max(1,leafIndex)*cardH+Math.max(0,leafIndex-1)*gapY);
    const paths=edges.map(({from,to})=>{
      const sx=from.x+cardW,sy=from.y+cardH/2,ex=to.x,ey=to.y+cardH/2,mx=(sx+ex)/2;
      return `<path d="M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ey}, ${ex} ${ey}"/>`;
    }).join('');
    const cards=placed.map(({item,x,y})=>{
      const full=item.kind==='collision'?(node({answerId:aid,nodeId:item.id})||item):item;
      const collidable=item.kind==='collision';
      const selected=collidable&&pair.some(ref=>core.keyOf(ref)===core.keyOf({answerId:aid,nodeId:item.id}));
      /* 统一圆角卡片：所有卡片都可查看详情和定位原文；只有蓝色末层卡可拖起碰撞。
         拖拽改由 pointer 事件接管，不再用 HTML5 draggable（默认拖影会破坏卡牌质感）。 */
      const kindName=item.kind==='root'?'总观点':item.kind==='branch'?'结构分支':'可碰撞观点';
      const text=nodeDisplayText(full||item);
      const hint=collidable?'单击查看详情，双击定位原文；拖起卡牌可与另一篇回答碰撞':'单击查看详情，双击定位原文';
      return `<article class="co-node co-graph-node is-${esc(item.kind)} ${collidable?'is-collision':''} ${selected?'selected':''}" style="left:${x}px;top:${y}px" data-node="${esc(item.id)}" data-aid="${aid}" data-collidable="${collidable}" aria-label="${esc(kindName)}：${esc(cut(text,40))}"><button class="co-node-main" data-co="node-detail" data-aid="${aid}" data-nid="${esc(item.id)}" aria-pressed="${selected}" title="${hint}">${esc(text)}</button></article>`;
    }).join('');
    return `<div class="co-network co-tree-network" data-map-aid="${aid}" style="--canvas-w:${canvasW}px;--canvas-h:${canvasH}px;--node-w:${cardW}px;--node-h:${cardH}px"><svg class="co-network-lines" viewBox="0 0 ${canvasW} ${canvasH}" aria-hidden="true">${paths}</svg>${cards}</div>`;
  }
  function networkHtml(aid,m){
    if(m?.tree)return treeGraphHtml(aid,m);
    return `<div class="co-generation-state is-failed" role="alert">${icon('alert')}<strong>结构数据不兼容</strong><p>这份结果不是新版观点树，请重新生成。</p>${btn('重新生成','retry-map','primary','data-aid="'+esc(aid)+'"')}</div>`;
  }
  async function loadPublicDiscoveries(){
    const qid=document.body.dataset.questionId||'';
    try{
      const response=await fetch(`/api/discoveries${qid?`?questionId=${encodeURIComponent(qid)}`:''}`);
      if(!response.ok)return;
      const result=await response.json();
      for(const item of result.items||[]){
        const index=state.items.findIndex(existing=>existing.id===item.id||existing.pairKey===item.pairKey);
        if(index>=0)state.items[index]=item;else state.items.push(item);
      }
      for(const [id,comments] of Object.entries(result.comments||{}))state.comments[id]=comments;
      persist();decorate();if(wb)renderWorkbench();
    }catch{/* 公共列表短暂不可用时仍允许阅读已加载页面 */}
  }
  function applyMapView(aid){
    const net=root.querySelector(`.co-network[data-map-aid="${CSS.escape(aid)}"]`);
    if(!net)return;
    let view=mapViews.get(aid);
    if(!view&&net.classList.contains('co-tree-network')){
      const viewport=net.closest('.co-map-scroll');
      const canvasW=parseFloat(net.style.getPropertyValue('--canvas-w'))||net.offsetWidth;
      const canvasH=parseFloat(net.style.getPropertyValue('--canvas-h'))||net.offsetHeight;
      const fitX=Math.max(0.1,(viewport.clientWidth-24)/canvasW);
      const fitY=Math.max(0.1,(viewport.clientHeight-44)/canvasH);
      const zoom=Math.min(1,Math.max(.48,Math.min(fitX,fitY)));
      view={x:12,y:Math.max(12,(viewport.clientHeight-canvasH*zoom)/2),zoom};
      mapViews.set(aid,view);
    }
    view=view||{x:0,y:0,zoom:1};
    net.style.setProperty('--pan-x',`${view.x}px`);
    net.style.setProperty('--pan-y',`${view.y}px`);
    net.style.setProperty('--map-zoom',view.zoom);
  }
  function mapSlot(aid,index){
    const m=maps[aid],a=answer(aid),task=mapGeneration.get(aid),slotName=index?'下方':'上方',thesis=m?.tree||m?.nodes.find(n=>n.role==='thesis')||m?.nodes[0];
    const title=task?.status==='processing'?'正在生成结构图…':task?.status==='failed'?'结构图生成失败':thesis?nodeDisplayText(thesis):'等待生成结构图';
    const content=m
      ?`<div class="co-map-note">单击节点看详情 · 双击定位原文 · 蓝色卡牌可拖起碰撞</div>${networkHtml(aid,m)}`
      :task?.status==='failed'
        ?`<div class="co-generation-state is-failed" role="alert">${icon('alert')}<strong>生成失败</strong><p>${esc(task.error||'结构图生成失败，请稍后重试。')}</p>${btn('重新生成','retry-map','primary','data-aid="'+esc(aid)+'"')}</div>`
        :task?.status==='processing'
          ?`<div class="co-generation-state" role="status" aria-live="polite"><span class="co-spinner" aria-hidden="true"></span><strong>正在生成结构图</strong><p>可以最小化浮窗，生成会在后台继续。</p></div>`
          :`<div class="co-generation-state is-idle">${icon('nodes')}<strong>尚未生成结构图</strong><p>点击生成后，结果会显示在这个浮窗中。</p>${btn('点击生成','retry-map','primary','data-aid="'+esc(aid)+'"')}</div>`;
    return `<section class="co-map co-float-window${task?.status==='processing'?' is-generating':''}" aria-label="${slotName}回答节点浮窗" data-slot-index="${index}" data-aid="${aid}"><header class="co-map-head"><span class="co-slot-letter">${esc([...a.author][0])}</span><button class="co-float-identity" data-co="reader" data-aid="${aid}" title="点击跳到这篇回答开头"><span>${esc(a.author)}</span><strong>${esc(title)}</strong></button><button class="co-iconbtn co-minimize-slot" data-co="close-slot" data-slot="${index}" aria-label="最小化为作者圆球" title="最小化">−</button><button class="co-iconbtn co-close-answer" data-co="remove-answer" data-aid="${aid}" aria-label="关闭${esc(a.author)}的回答浮窗" title="关闭浮窗">×</button></header><div class="co-map-scroll${m?.tree?' is-tree':''}">${content}</div></section>`;
  }
  function shelfHtml(){
    const mine=myItems(wb.questionId);
    const items=mine.filter(i=>shelfTab==='draft'?['draft','returned'].includes(i.status):shelfTab==='pending'?i.status==='pending':['published','withdrawn','hidden'].includes(i.status));
    return `<div class="co-wb-shelf-head"><div class="co-between"><strong>我的发现</strong>${badge(mine.filter(i=>i.status!=='discarded').length,'gray')}</div><div class="co-tabs">${[['draft','草稿'],['pending','待审核'],['published','已公开']].map(([id,label])=>{const n=mine.filter(i=>id==='draft'?['draft','returned'].includes(i.status):id==='pending'?i.status==='pending':['published','withdrawn','hidden'].includes(i.status)).length;return `<button data-co="shelf-tab" data-tab="${id}" class="${id===shelfTab?'active':''}">${label}${n?`<span class="co-tab-count">${n}</span>`:''}</button>`;}).join('')}</div></div>${items.length?items.map(i=>`<button class="co-shelf-item" data-co="${['draft','returned'].includes(i.status)?'edit':'detail'}" data-id="${i.id}">${badge(names[i.status],i.status==='pending'?'amber':i.status==='published'?'green':'gray')}<strong>${esc(i.title)}</strong><div class="co-muted">${tagOf(i)} · ${i.refs.map(r=>esc(answer(r.answerId).author)).join(' × ')}</div>${i.status==='returned'?`<div class="co-muted">退回意见：${esc(cut(i.reviewNote,40))}</div>`:''}</button>`).join(''):`<div class="co-empty">${icon('spark')}<strong>${shelfTab==='draft'?'你的下一条发现，从连接开始':'这里还没有发现'}</strong>在两篇回答中各选一个观点，看看它们会带来什么新问题。</div>`}`;
  }
  function readerHtml(){
    const a=answer(wb.reader);
    if(!a)return `<div class="co-empty">${icon('book')}<strong>还没有选择阅读的回答</strong>点击结构图上的书本图标即可阅读原文。</div>`;
    return `<header class="co-reader-head"><div class="co-row"><span class="co-avatar">${esc([...a.author][0])}</span><div><strong>${esc(a.author)}</strong><div class="co-muted">原回答 · 阅读区</div></div></div>${btn('回答开头 ↑','reader-top','small')}</header><div class="co-reader-body"><div class="co-reading-note">原回答保留其上下文。点击结构图的“查看原文”可追溯节点出处。</div>${window.ZhihuDemoView.answerContent(a)}</div>`;
  }
  function renderWorkbench(){
    if(!wb)return;
    const old=root.querySelector('.co-floating-stack');
    const mapScroll=[...(old?.querySelectorAll('.co-map-scroll')||[])].map(e=>e.scrollTop);
    old?.remove(); root.querySelector('.co-pickbar')?.remove();
    const openIds=wb.slots.filter(Boolean),collapsed=wb.selected.filter(id=>!openIds.includes(id));
    root.insertAdjacentHTML('beforeend',`<section class="co-floating-stack ${openIds.length?'':'is-all-collapsed'}" aria-label="回答节点浮窗">${openIds.length?`<div class="co-float-windows">${wb.slots.map((id,index)=>id?mapSlot(id,index):'').join('')}</div><div class="co-pair-bar" id="co-pair-bar">${pairBar()}</div>`:''}<div class="co-collapsed" aria-label="已最小化的回答">${collapsed.map(id=>{const status=mapGeneration.get(id)?.status||'';const statusText=status==='processing'?'（结构图生成中）':status==='failed'?'（结构图生成失败）':'';return `<button class="co-miniball${status?' is-'+status:''}" type="button" draggable="true" data-co="open-slot" data-aid="${id}" title="${esc(answer(id).author)}${statusText}：左键恢复或拖动替换，右键可删除窗口">${esc([...answer(id).author][0])}</button>`;}).join('')}</div></section>`);
    root.querySelectorAll('.co-map-scroll').forEach((e,i)=>e.scrollTop=mapScroll[i]||0);
    openIds.forEach(applyMapView);
    renderSelectFab();
  }
  function pairBar(){
    const tasks=wb?.selected.map(id=>mapGeneration.get(id)).filter(Boolean)||[];
    const processing=tasks.filter(task=>task.status==='processing').length;
    if(processing)return `<span class="co-spinner" aria-hidden="true"></span><span>${processing} 篇回答的结构图正在生成<br>可继续阅读或最小化浮窗</span>`;
    const failed=tasks.filter(task=>task.status==='failed').length;
    if(failed)return `${icon('alert')}<span>${failed} 篇回答生成失败<br>请在对应浮窗中查看并重试</span>`;
    if(!pair.length)return `${icon('spark')}<span>拖起一张蓝色卡牌，靠到另一篇回答的蓝色卡牌上<br>单击查看详情，双击定位原文</span>`;
    return `${icon('spark')}<span>已选：${esc(cut(nodeText(node(pair[0])),28))}<br>再选另一篇回答的观点，开始碰撞</span><button class="co-link" data-co="clear-pair">取消</button>`;
  }
  function updatePair(){
    root.querySelectorAll('.co-node').forEach(el=>{const yes=pair.some(r=>r.answerId===el.dataset.aid&&r.nodeId===el.dataset.node);el.classList.toggle('selected',yes);el.querySelector('.co-node-main').setAttribute('aria-pressed',String(yes));});
    const bar=root.querySelector('#co-pair-bar');if(bar)bar.innerHTML=pairBar();
  }
  function nodeKindName(value){return value?.kind==='root'?'总观点':value?.kind==='branch'?'结构分支':'观点';}
  function rejectNonCollidable(ref,gesture){
    const target=node(ref);
    const name=nodeKindName(target);
    toast(gesture==='drag'
      ?`${name}是白色结构卡，不能参与碰撞。请拖动蓝色的观点卡牌。`
      :`${name}是白色结构卡，不参与碰撞，已为你定位到对应原文。可碰撞的是蓝色观点卡牌。`);
  }
  function pick(ref){
    if(!isCollidable(node(ref))){rejectNonCollidable(ref,'click');locate(ref);return;}
    if(pair.some(r=>core.keyOf(r)===core.keyOf(ref))){pair=[];updatePair();return;}
    if(!pair.length){pair=[ref];updatePair();return;}
    const error=core.validatePair(wb.questionId,[pair[0],ref],node);
    if(error){toast(error);return;}
    collisionRefs=[pair[0],ref];showCollision();
  }

  /* ---------- 来源卡片与证据校验 ---------- */
  function sourceCards(refs,evidence){
    return `<div class="co-source-grid">${refs.map((r,i)=>{
      const n=node(r),a=answer(r.answerId),hit=evidence?.details?.[i],quote=nodeQuote(n);
      const quoteHtml=quote?`<blockquote>${esc(quote)}</blockquote>`:'<blockquote class="co-noquote">这条是全文归纳，没有单一对应原句，请查看它的下级观点。</blockquote>';
      const mark=!hit?'':hit.found?badge(hit.method==='exact'?'原文可定位':'原文可定位（归一化匹配）','green'):badge(quote?'未能在原文中找到该引用':'无单一原文引用','amber');
      const scopes=conditionText(n);
      const supports=(n.supports||[]).length?`<details class="co-support-details"><summary>查看全部支撑材料（${n.supports.length}）</summary>${n.supports.map(item=>`<div><b>${esc(item.summary||'原文依据')}</b><blockquote>${esc(item.quote)}</blockquote><button class="co-link" data-co="locate-quote" data-aid="${r.answerId}" data-quote="${esc(item.quote)}">定位这段原文 ↗</button></div>`).join('')}</details>`:'';
      return `<section class="co-source">${badge(i?'来源 B':'来源 A')} <strong>${esc(a.author)}</strong> ${mark}<p>${esc(nodeText(n))}</p>${n.reasonSummary?`<div class="co-muted">论证摘要：${esc(n.reasonSummary)}</div>`:''}${quoteHtml}<div class="co-muted">适用条件：${scopes?esc(scopes):'原文未明确标注范围'}</div>${supports}<div class="co-row" style="margin-top:8px">${quote?`<button class="co-link" data-co="locate" data-aid="${r.answerId}" data-nid="${esc(r.nodeId)}">定位主要原文 ↗</button>`:''}<button class="co-link" data-co="read-answer" data-aid="${r.answerId}">查看全文 ↗</button></div></section>`;
    }).join('')}</div>`;
  }
  function showNodeSource(ref){
    const n=node(ref);
    sourceReturn=modalKind==='detail'?sourceReturn:null;
    const path=(n.ancestorPath||[]).map(item=>item.text).filter(Boolean).join(' › ');
    openModal('核对观点依据','观点摘要用于帮助理解；支撑材料仍需回到原文语境中核对。',sourceCards([ref],core.evidenceCheck([ref],node,paragraphsOf))+`${path?`<div class="co-note-box"><strong>所在结构</strong><br>${esc(path)}</div>`:''}<div class="co-note-box">这是观点树最末层的可碰撞节点。它下面的原文、案例和条件不会继续显示成独立节点。</div>`,btn('返回观点树','close-modal'),false,'source');
  }

  function showTreeNodeDetail(ref){
    const n=node(ref),a=answer(ref.answerId);
    if(!n||!a)return;
    const kind=nodeKindName(n),display=nodeDisplayText(n),full=nodeText(n)||n.summary||n.title||display;
    /* root / branch 只是结构导航，详情只给原文依据。collision 才需要观点解释。
       旧缓存没有 explanation 时不重新调模型，用已有的完整观点、论证摘要和
       适用条件组合成兼容解释，保证老数据也不留空白。 */
    const generatedExplanation=String(n.explanation||'').trim();
    const legacyExplanation=[
      full?`这个观点的核心意思是：${String(full).replace(/[。！？]+$/,'')}。`:'',
      n.reasonSummary?`它的主要理由是：${String(n.reasonSummary).replace(/[。！？]+$/,'')}。`:'',
      conditionText(n)?`它的适用范围是：${conditionText(n)}。`:''
    ].filter(Boolean).join('');
    const explanation=generatedExplanation||legacyExplanation;
    const statementBlock=isCollidable(n)&&explanation
      ?`<section class="co-node-detail-statement is-explanation"><h3>观点解释</h3>${explanation.split(/\n\s*\n/).filter(Boolean).slice(0,2).map(p=>`<p>${esc(p)}</p>`).join('')}</section>`
      :'';
    const supports=(Array.isArray(n.supports)&&n.supports.length?n.supports:(n.sourceAnchors||[]).map(anchor=>({summary:'原文依据',quote:anchor.quote})))
      .filter(item=>item?.quote).slice(0,4);
    const supportHtml=supports.length?`<section class="co-node-detail-evidence"><h3>原文依据</h3>${supports.map((item,index)=>`<blockquote><span class="co-node-detail-evidence-index">${index+1}</span><p>${esc(item.quote)}</p><button class="co-link" data-co="locate-quote" data-aid="${ref.answerId}" data-quote="${esc(item.quote)}">定位这段原文 ↗</button></blockquote>`).join('')}</section>`:`<div class="co-note-box">这是对全文的归纳，当前没有可单独列出的原文摘录。可以通过下方按钮回到回答对应位置。</div>`;
    trace('node_detail_opened',{answerId:ref.answerId,nodeId:ref.nodeId});
    openModal(display,`${a.author} · ${kind}`,`${statementBlock}${supportHtml}`,`<span class="co-muted">双击结构图节点也可直接定位</span><div class="co-row">${btn('关闭','close-modal')}${btn('定位网页原文','locate','primary',`data-aid="${ref.answerId}" data-nid="${esc(ref.nodeId)}"`)}</div>`,false,'node-detail');
  }

  /* ---------- P06：碰撞确认（动作已内化，用户不选动作） ---------- */
  function showCollision(){
    const evidence=core.evidenceCheck(collisionRefs,node,paragraphsOf);
    collisionAction='contrast';
    const warn=evidence.eligibility==='needs_evidence'?`<div class="co-warn-box">${icon('alert')}至少有一侧没有可在原文中定位的引用，AI 可能无法产出有据的问题。仍可尝试，但更容易被复审拦下。</div>`:'';
    openModal('让两个观点碰撞','AI 会判断这两处是什么关系，并由此提出一个新问题。',demoNote+sourceCards(collisionRefs,evidence)+warn+`<div class="co-note-box"><strong>你不需要选择「怎么碰」。</strong>关系类型由 AI 读完两处原文后判定并告诉你——那正是你想知道的答案。你的贡献是发现这两处值得碰。</div><div class="co-note-box">产物包含两部分：<strong>关系说明</strong>（这两个观点是什么关系）和<strong>新问题</strong>（由该关系引申出的具体问题）。问题里的每个具体元素都会被拿回原文校验，对不上则整条丢弃。</div>`,`<span class="co-muted">通过复审后默认公开</span>${btn(`${icon('spark')}开始碰撞`,'generate','primary')}`,false,'collision');
  }

  function recordJob(kind,payload){
    state.jobs.unshift({id:uid('job'),kind,createdAt:Date.now(),...payload});
    state.jobs=state.jobs.slice(0,50);
  }
  function generate(){
    const rect=dialog.getBoundingClientRect();
    const origin=rect.width?{x:rect.left+rect.width/2,y:rect.top+rect.height/2}:null;
    closeModal(true);
    startCollision(origin);
  }
  /* 统一的碰撞入口：拖拽合成与弹窗确认都走这里。
     origin 是合成发生的屏幕坐标，用于让新卡牌从碰撞点飞向左侧产物栏。 */
  function startCollision(origin){
    const error=core.validatePair(wb.questionId,collisionRefs,node);
    if(error){toast(error);return;}
    const key=core.pairKey(wb.questionId,collisionRefs,collisionAction);
    const existing=state.items.find(i=>i.pairKey===key&&!['discarded','withdrawn'].includes(i.status));
    if(existing){
      const known=results.find(r=>r.itemId===existing.id);
      if(known){toast('这组节点已经有一张卡牌，可在左侧点开。');pair=[];updatePair();return;}
      const id=addResult(collisionRefs,existing.newQuestion||existing.title);
      const entry=resultById(id);
      entry.status='ready';entry.itemId=existing.id;entry.title=existing.newQuestion||existing.title;
      renderResultRail();peekRail();flyToRail(id,origin);
      toast('这组节点已经有一条发现，卡牌已放到左侧。');
      pair=[];updatePair();return;
    }
    const published=allItems().find(i=>i.pairKey===key&&i.status==='published');
    if(published){showDuplicate(published);return;}
    const resultId=addResult(collisionRefs,'');
    flyToRail(resultId,origin);
    pair=[];updatePair();
    void runRealCollide(key,resultId);
  }

  /* ---------- 真实碰撞：调用后端 AI 链路 ---------- */
  // 产物为两段式（关系说明 + 新问题），动作完全内化：
  // 用户只负责选哪两个节点，关系类型由模型判定后呈现，不作为选项要求用户输入。
  // 碰撞结果不再用「思考中」弹窗打断阅读，而是先在页面左侧落一张加载中的新卡牌，
  // 生成完成后原地变成「已经生成好」，判定不可碰撞则整张卡置灰并给出删除入口。
  async function runRealCollide(key,resultId){
    const refs=collisionRefs.map(r=>({...r}));
    const result=resultById(resultId);
    let data;
    try{
      const resp=await fetch('/api/collide',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({questionId:wb.questionId,questionTitle:qById(wb.questionId)?.title||'',
          refs:refs.map(r=>({answerId:r.answerId,nodeId:r.nodeId}))})});
      data=await resp.json();
      if(resp.status===401){window.ZhihuDemoCommunity?.requireAccount?.();failResult(resultId,'需要先登录本站才能碰撞。');return;}
    }catch(err){
      data={status:'blocked',reason:'无法连接碰撞服务。请确认「启动碰撞服务.cmd」正在运行。'};
    }
    const now=Date.now(), jobId=uid('job');

    if(data.status==='no_result'){
      recordJob('collide',{status:'succeeded',outcome:'no_result',reason:data.reason||'',refs,action:collisionAction});
      persist();failResult(resultId,data.reason||'这两个观点讨论的不是同一件事，无法碰撞。','no_result');return;
    }
    if(data.status!=='published'){
      recordJob('collide',{status:'succeeded',outcome:'blocked',reason:data.reason||'',refs,action:collisionAction});
      persist();failResult(resultId,data.reason||'产物未通过引用回查，已整条丢弃。','blocked');return;
    }

    // 通过 AI 复审（evidence 回查 + 具体元素扫描）→ 默认发布进入公共视野
    const item={id:uid('ins'),questionId:wb.questionId,refs,action:collisionAction,pairKey:key,
      answerPairKey:`${wb.questionId}|${refs.map(r=>r.answerId).sort().join('|')}`,
      relationType:data.relation_type,relationText:data.relation_text,
      newQuestion:data.question,questionDetail:data.question_detail,whoCanAnswer:data.who_can_answer,
      aiEvidence:data.evidence_located||[],
      title:data.question,rationale:data.relation_text,
      limitations:'由 AI 基于两篇回答的原文推导，已通过引用回查校验；不代表来源作者认可。',
      status:'published',eligibility:'eligible',origin:'ai_generated',collisionJobId:jobId,
      evidence:core.evidenceCheck(refs,node,paragraphsOf),
      creatorId:me().id,author:me().name,revision:1,createdAt:now,updatedAt:now,
      publishedAt:now,lastPublishedAt:now,
      reviewer:'AI 复审',reviewMode:'ai_review',
      original:{title:data.question,rationale:data.relation_text},
      revisions:[{number:1,origin:'ai_generated',editorId:null,title:data.question,rationale:data.relation_text,createdAt:now}],
      reviews:[{number:1,result:'passed',reviewer:'AI 复审',note:'evidence 全部可回原文定位',createdAt:now}]};
    try{
      const publish=await fetch('/api/discoveries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(item)});
      const saved=await publish.json();
      if(publish.status===401){window.ZhihuDemoCommunity?.requireAccount?.();failResult(resultId,'需要先登录本站才能保存结果。');return;}
      if(!publish.ok)throw new Error(saved.error||'公开保存失败。');
      Object.assign(item,saved.item||{});
    }catch(error){failResult(resultId,`AI 已生成结果，但保存到公共列表失败：${error.message}`,'blocked');return;}
    state.items.unshift(item);
    state.jobs.unshift({id:jobId,kind:'collide',status:'succeeded',outcome:'published',createdAt:now,refs,action:collisionAction,resultRef:item.id});
    persist();pair=[];shelfTab='published';renderWorkbench();decorate();
    if(result){result.status='ready';result.itemId=item.id;result.title=item.newQuestion||item.title;result.reason='';result.isNew=true;}
    renderResultRail();peekRail(3600);
    toast('新节点已经生成好，点击左侧卡牌即可查看。');
  }

  /* 碰撞过程已改由左侧卡牌承载（加载中 / 已生成好 / 失败置灰），
     原来的「思考中」「无结果」「未通过复审」三个打断式弹窗不再使用。
     失败原因通过卡牌文案与 toast 呈现，用户可用卡牌上的垃圾桶删除。 */

  function showNoResult(verdict){
    openModal('这一次没有得到可靠的新判断','任务已完成，但结果是“无有效碰撞”，不会生成任何发现。',demoNote+`<div class="co-empty">${icon('alert')}<strong>${esc(verdict.message)}</strong>本版按本地规则判断，不调用模型，也不会因此创建空的公开节点。</div>${sourceCards(collisionRefs,core.evidenceCheck(collisionRefs,node,paragraphsOf))}<div class="co-note-box">对应设计：<code>job.status=succeeded</code>、<code>outcome=no_result</code>、<code>reason=${esc(verdict.code)}</code>；节点配对已保留，可换动作或换节点重试。</div>`,`${btn('换一个动作','back-to-action')}${btn('重新选择节点','close-modal','primary')}`,false,'no-result');
  }
  function showDuplicate(item){
    openModal('这个配对已经有公开发现','同一问题、同一对节点和同一动作，本版只保留一条有效公开记录。',demoNote+`<div class="co-note-box">已有人公开了这个配对的发现。你可以打开它并参与讨论，而不是再创建一条重复内容。</div>${insightCard(item)}`,`${btn('打开已有发现','detail','primary',`data-id="${item.id}"`)}${btn('返回','close-modal')}`,false,'duplicate');
  }

  /* ---------- P07：草稿核对与提交 ---------- */
  function counterHtml(id,value,max,min){const n=core.size(value);return `<small id="${id}" class="${n>max||(min&&n<min)?'over':''}">${n}/${max}${min?` · 至少 ${min}`:''}</small>`;}
  function showEditor(id){
    const item=itemById(id);
    if(!item||!['draft','returned'].includes(item.status))return toast('这条发现当前不可编辑。');
    editor={...item};
    const evidence=item.evidence||core.evidenceCheck(item.refs,node,paragraphsOf);
    const blocked=evidence.eligibility==='needs_evidence';
    openModal('整理你的新发现','先核对来源，再用自己的话写清发现和边界。',demoNote+`${item.status==='returned'?`<div class="co-warn-box">${icon('alert')}审核退回：${esc(item.reviewNote)}</div>`:''}${blocked?`<div class="co-warn-box">${icon('alert')}两侧证据不完整（public_eligibility=needs_evidence），本版只允许保存为私有草稿，不能提交公开审核。</div>`:''}<div class="co-editor-grid"><div><label class="co-field"><span>新判断 <span>${counterHtml('co-count-title',item.title,L.title)}</span></span><input name="title" value="${esc(item.title)}" required></label><label class="co-field"><span>推导依据 <span>${counterHtml('co-count-rationale',item.rationale,L.rationaleMax,L.rationaleMin)}</span></span><textarea name="rationale" rows="8" required>${esc(item.rationale)}</textarea></label><label class="co-field"><span>局限 <span>${counterHtml('co-count-limitations',item.limitations,L.limitations)}</span></span><textarea name="limitations" rows="3" placeholder="没有额外局限可以留空">${esc(item.limitations||'')}</textarea></label><div class="co-note-box">系统始终附加：基于两篇回答的推导，不代表来源作者认可。</div><label class="co-check"><input type="checkbox" id="co-author-confirm">我已核对两处来源，确认文字没有冒充原作者结论，并愿意将这一版本提交演示审核。</label></div><aside><strong style="font-size:14px">不可改写的来源</strong>${sourceCards(item.refs,evidence)}<details class="co-note-box"><summary>查看模板初稿（保留不删）</summary><p><b>${esc(item.original?.title||item.title)}</b></p><p>${esc(item.original?.rationale||item.rationale)}</p></details><div class="co-muted">来源内容只读。若节点本身歪曲原文，应返回更换节点，而不是改写摘录。</div></aside></div>`,`<span class="co-muted">${badge('仅自己可见','gray')} 不会自动公开</span><div class="co-row">${item.status!=='pending'?btn('放弃草稿','discard','danger',`data-id="${item.id}"`):''}${btn('仅保存草稿','save-draft')}${btn('提交审核','submit-review','primary','disabled')}</div>`,true,'editor');
    dialog.querySelector('.co-editor-grid aside .co-source-grid').style.gridTemplateColumns='1fr';
    if(blocked)dialog.querySelector('[data-co="submit-review"]').title='两侧证据不足，无法提交公开审核。';
  }
  function readEditor(){return Object.fromEntries(['title','rationale','limitations'].map(k=>[k,dialog.querySelector(`[name="${k}"]`).value.trim()]));}
  function saveEditor(submit=false){
    const item=state.items.find(i=>i.id===editor?.id);
    if(!item||!['draft','returned'].includes(item.status))return toast('记录已变化，请重新打开。');
    const fields=readEditor();
    const invalid=core.validateDraft(fields);
    if(invalid)return toast(invalid);
    if(submit){
      if(!dialog.querySelector('#co-author-confirm').checked)return toast('请先勾选“我已核对两处来源”。');
      const evidence=core.evidenceCheck(item.refs,node,paragraphsOf);
      item.evidence=evidence;item.eligibility=evidence.eligibility;
      if(evidence.eligibility==='needs_evidence'){persist();return toast('两侧证据不足，本版拒绝提交公开审核（EVIDENCE_REQUIRED）。可返回更换节点。');}
    }
    const changed=fields.title!==item.title||fields.rationale!==item.rationale||(fields.limitations||'')!==(item.limitations||'');
    Object.assign(item,fields,{updatedAt:Date.now()});
    if(changed){
      item.revision+=1;
      item.revisions=[...(item.revisions||[]),{number:item.revision,origin:'user_edited',editorId:me().id,title:fields.title,rationale:fields.rationale,limitations:fields.limitations,createdAt:Date.now()}];
    }
    if(submit)Object.assign(item,core.transition(item,'pending'),{submittedAt:Date.now(),submittedRevision:item.revision,authorConfirmation:{userId:me().id,confirmedAt:Date.now(),revision:item.revision}});
    else if(item.status==='returned')Object.assign(item,core.transition(item,'draft'));
    persist();dirty=false;closeModal(true);shelfTab=submit?'pending':'draft';renderWorkbench();decorate();
    toast(submit?'已提交演示审核。':'草稿已保存到本浏览器。');
  }

  /* ---------- P08：审核台 ---------- */
  const CHECKS=[['source_fidelity','来源引用与原文相符，没有断章取义'],['no_invented_facts','没有把推测写成已被证明的事实'],['limitations_clear','保留必要条件、分歧和不确定性'],['added_value','相对两篇回答有信息增量，不只是并列复述']];
  function showReviewList(){
    const list=state.items.filter(i=>i.status==='pending').sort((a,b)=>(a.submittedAt||0)-(b.submittedAt||0));
    const issues=state.issues.filter(x=>x.status==='open');
    openModal('演示审核台','这是产品流程的角色切换，不是真实权限系统，也不代表专业审核。',demoNote+
      `<h3 style="font-size:15px;margin:0 0 12px">待审核 · ${list.length}</h3>`+
      (list.length?list.map(i=>`<article class="co-review-item"><div class="co-between">${badge('待审核','amber')}<span class="co-muted">提交版本 v${i.revision} · ${when(i.submittedAt)}</span></div><h3>${esc(i.title)}</h3><div class="co-between"><span class="co-muted">${esc(qById(i.questionId).title)} · ${tagOf(i)} · ${i.refs.map(r=>esc(answer(r.answerId).author)).join(' × ')} · 提交人 ${esc(i.author)}</span>${btn('核对并审核','review','small primary',`data-id="${i.id}"`)}</div></article>`).join(''):`<div class="co-empty">${icon('check')}<strong>暂无待审核发现</strong>先将私有草稿提交审核，再回到这里。</div>`)+
      `<hr class="co-divider"><h3 style="font-size:15px;margin:0 0 12px">内容异议 · ${issues.length}</h3>`+
      (issues.length?issues.map(x=>{const item=itemById(x.insightId);return `<article class="co-review-item"><div class="co-between">${badge('待处理','amber')}<span class="co-muted">${when(x.createdAt)}</span></div><h3>${esc(item?.title||'已删除的发现')}</h3><p class="co-muted">异议理由：${esc(x.reason)}</p><div class="co-row" style="justify-content:flex-end">${btn('保留内容','resolve-issue','small',`data-id="${x.id}" data-resolution="keep"`)}${btn('下架该发现','resolve-issue','small danger',`data-id="${x.id}" data-resolution="hidden"`)}</div></article>`;}).join(''):'<div class="co-muted">没有待处理的异议。</div>'),
      btn('返回节点浮窗','close-modal'),false,'review-list');
  }
  function showReview(id){
    const i=state.items.find(x=>x.id===id);
    if(i?.status!=='pending')return showReviewList();
    const selfReview=i.creatorId===me().id;
    const evidence=i.evidence||core.evidenceCheck(i.refs,node,paragraphsOf);
    openModal('审核这条发现',`审核演示 · 仅处理当前提交版本 v${i.revision}`,demoNote+
      `${selfReview?`<div class="co-warn-box">${icon('alert')}发起者与审核员是同一账号，本条将被记录为“演示自审”，公开详情中可见。</div>`:''}<h3 class="co-detail-title">${esc(i.title)}</h3><p class="co-detail-rationale" style="white-space:pre-wrap">${esc(i.rationale)}</p><p class="co-detail-limits">局限：${esc(i.limitations||'提交者未填写额外局限。')}</p>${sourceCards(i.refs,evidence)}<div class="co-note-box">请实际对照原文逐项检查。自动定位成功不免除人工核对；演示审核不等于事实认证。</div>${CHECKS.map(([key,text])=>`<label class="co-check"><input type="checkbox" data-review-check="${key}">${text}</label>`).join('')}<label class="co-field"><span>退回意见 <small>退回时必填</small></span><textarea id="co-review-note" rows="2" maxlength="300" placeholder="指出哪一处需要补充或改写"></textarea></label>`,
      `<span class="co-muted">通过后出现在两篇来源回答下方</span><div class="co-row">${btn('退回修改','return-review','',`data-id="${i.id}" data-revision="${i.revision}"`)}${btn('通过并本站公开','approve-review','primary',`data-id="${i.id}" data-revision="${i.revision}" disabled`)}</div>`,false,'review');
  }
  function review(id,revision,approve){
    const i=state.items.find(x=>x.id===id);
    if(i?.status!=='pending'||i.revision!==revision){toast('审核版本已变化，请重新打开。');return showReviewList();}
    const boxes=[...dialog.querySelectorAll('[data-review-check]')];
    const note=dialog.querySelector('#co-review-note').value.trim();
    if(approve&&!boxes.every(e=>e.checked))return toast('通过前需要逐项确认所有检查点。');
    if(!approve&&!note)return toast('请填写具体的退回意见。');
    if(approve){
      const duplicate=allItems().find(x=>x.id!==i.id&&x.pairKey===i.pairKey&&x.status==='published');
      if(duplicate){toast('同一配对已有公开发现（DUPLICATE_PUBLIC_PAIR），无法重复公开。');return showDuplicate(duplicate);}
      const evidence=core.evidenceCheck(i.refs,node,paragraphsOf);
      if(evidence.eligibility==='needs_evidence'){i.evidence=evidence;i.eligibility='needs_evidence';persist();return toast('两侧证据已不可用，本条不能公开（EVIDENCE_REQUIRED）。');}
    }
    const reviewMode=i.creatorId===me().id?'demo_self_review':'demo_curator';
    const record={id:uid('rev'),revision,reviewerId:me().id,reviewer:me().name,decision:approve?'approve':'return',reviewMode,
      checks:Object.fromEntries(boxes.map(b=>[b.dataset.reviewCheck,b.checked])),note,createdAt:Date.now()};
    Object.assign(i,core.transition(i,approve?'published':'returned',revision),
      {reviewNote:note,reviewedAt:Date.now(),reviewer:me().name,reviewMode,reviews:[...(i.reviews||[]),record]});
    persist();decorate();shelfTab=approve?'published':'draft';renderWorkbench();
    approve?showDetail(id):showReviewList();
    toast(approve?'已在本浏览器公开；两个来源回答展示的是同一条发现。':'已退回草稿箱，修改后可以重新提交。');
  }

  /* ---------- P09：公开详情、评论与异议 ---------- */
  function statusPlaceholder(i){
    return `<div class="co-empty">${icon('alert')}<strong>该发现暂不可见</strong>这条发现已${i.status==='withdrawn'?'被发起者撤回':'被演示审核员下架'}。按设计，正文、摘录和评论不再展示，后台记录保留。</div>${btn('返回问题','close-modal','primary')}`;
  }
  function collisionAnalysisHtml(value){
    const paragraphs=String(value||'AI 从两篇回答的判断中找到了值得继续追问的差异。').trim().split(/\n\s*\n/).filter(Boolean).slice(0,2);
    return paragraphs.map(text=>`<p>${esc(text)}</p>`).join('');
  }
  /* 问题详情说明：讲清这个问题落在谁身上、为什么两篇回答都答不了它。
     旧数据没有 questionDetail 时用 whoCanAnswer 做本地兼容，不为补历史数据额外消耗模型额度。 */
  function questionDetailHtml(item,className){
    const saved=String(item?.questionDetail||'').trim();
    const audience=String(item?.whoCanAnswer||'').trim();
    const text=saved||(audience
      ?`这个问题具体落在${audience}身上。两篇原回答提供了相关判断，但没有直接说明在这种处境中该如何区分或取舍；回答它需要进一步讲清适用条件、判断标准和可能代价。`
      :'两篇原回答提供了相关判断，但还没有直接说明这些判断在同一现实处境中该如何区分或取舍。回答它需要补充具体适用条件、判断标准和可能代价。');
    const paragraphs=text.split(/\n\s*\n/).filter(Boolean).slice(0,2);
    return `<div class="${className}">${paragraphs.map(p=>`<p>${esc(p)}</p>`).join('')}</div>`;
  }
  function showDetail(id){
    const i=itemById(id);
    if(!i)return toast('本浏览器没有这条发现。');
    if(['draft','returned'].includes(i.status)&&i.creatorId===me().id)return showEditor(id);
    if(['withdrawn','hidden','discarded'].includes(i.status))return openModal('该发现暂不可见','状态占位 · 内容不再公开展示',statusPlaceholder(i),'',false,'placeholder');
    sourceReturn=id;
    const comments=visibleComments(id), hidden=allComments(id).length-comments.length;
    const sourceNames=[...new Set(i.refs.map(ref=>answer(ref.answerId)?.author).filter(Boolean))];
    const sourceTitle=sourceNames.length>1?`来自 ${sourceNames.join(' 与 ')} 的回答`:`来自 ${sourceNames[0]||'两位作者'} 的回答`;
    const analysis=i.relationText||i.rationale;
    const question=i.newQuestion||i.title;
    openModal(sourceTitle,qById(i.questionId).title,
      `${firstFind?`<div class="co-first-ribbon">${icon('spark')}首次发现 · 这条问题是刚刚由你碰撞出来的</div>`:''}<section class="co-collision-analysis"><span>AI 分析</span>${collisionAnalysisHtml(analysis)}</section><section class="co-collision-question"><span>由此提出的深入问题</span><h3>${esc(question)}</h3>${questionDetailHtml(i,'co-question-detail')}</section><hr class="co-divider"><div class="co-between"><strong>围绕这个问题讨论 · ${comments.length}</strong></div><ol class="co-comment-list">${comments.map(c=>`<li><span class="co-avatar">${esc([...(c.author||'我')][0])}</span><div><strong>${esc(c.author)}</strong> <span class="co-muted">${when(c.createdAt)}</span><p>${esc(c.text)}</p>${c.authorId===me().id?`<button class="co-link" data-co="withdraw-comment" data-id="${esc(id)}" data-cid="${esc(c.id)}">撤回这条评论</button>`:''}</div></li>`).join('')||'<li><div class="co-muted">还没有讨论。可以直接回答这个问题，或指出它的前提问题。</div></li>'}${hidden?`<li><div class="co-muted">另有 ${hidden} 条评论已被撤回或隐藏，仅保留占位。</div></li>`:''}</ol>${i.status==='published'?`<form class="co-comment-form" data-insight="${esc(id)}"><textarea class="co-comment-input" name="comment" rows="2" maxlength="${L.comment}" placeholder="回答这个问题，或指出它的前提问题…" aria-label="发现评论" required></textarea><button type="submit" class="co-btn primary">发布</button></form><div style="margin-top:10px"><button class="co-link" data-co="issue" data-id="${esc(id)}">对此节点有异议</button></div>`:'<p class="co-muted">待审核或已撤回的发现不开放新增评论。</p>'}`,
      '',false,'detail');
  }
  function showPublicList(qid){
    const list=publicItems(qid);
    openModal('这个问题的碰撞发现',qById(qid).title,`<div class="co-note-box">这些发现连接了同一问题下的不同回答；数量按唯一发现计数，不按两个来源累加。</div>${list.map(i=>insightCard(i)).join('')||'<div class="co-empty">还没有公开发现。</div>'}`,btn('自己试一次','select','primary',`data-qid="${qid}"`),false,'public-list');
  }
  function showIssue(id){
    openModal('对这条发现提出异议','用于错误归因、来源丢失或明显误导等需要处理的问题。',`<div class="co-note-box">一般学术分歧建议直接评论。异议会进入演示审核台，由审核员决定保留或下架，单个异议不会自动下架内容。</div><label class="co-field"><span>异议理由 <small>1—${L.issue} 字</small></span><textarea id="co-issue-reason" rows="4" maxlength="${L.issue}" placeholder="请说明具体问题，例如引用与原文不符、结论超出来源支持范围"></textarea></label>`,`${btn('取消','close-modal')}${btn('提交异议','submit-issue','primary',`data-id="${esc(id)}"`)}`,false,'issue');
  }

  /* ---------- P10：定位原文与返回 ---------- */
  function jumpToAnswer(aid){
    if(!aid)return;
    const qid=aid.split('-')[0];
    if(document.body.dataset.questionId!==qid){location.href=`/question/${qid}#answer-${aid}`;return;}
    window.ZhihuDemoView.expandAnswer(aid);
    const card=document.querySelector(`.AnswerItem[data-answer-id="${CSS.escape(aid)}"]`);
    card?.scrollIntoView({block:'start',behavior:'smooth'});
    card?.classList.add('co-answer-pulse');
    setTimeout(()=>card?.classList.remove('co-answer-pulse'),1300);
  }
  function locate(ref){
    if(dirty&&!confirm('定位原文会离开编辑器。未保存的修改将丢失，继续吗？'))return;
    const n=node(ref);if(!n)return;
    const returnId=modalKind==='detail'?sourceReturn:null;
    closeModal(true);
    const qid=ref.answerId.split('-')[0];
    if(document.body.dataset.questionId!==qid){location.href=`/question/${qid}?source=${encodeURIComponent(core.keyOf(ref))}${returnId?`&backInsight=${encodeURIComponent(returnId)}`:''}`;return;}
    window.ZhihuDemoView.expandAnswer(ref.answerId);
    highlight(document.querySelector(`.AnswerItem[data-answer-id="${CSS.escape(ref.answerId)}"]`),nodeQuote(n));
    if(returnId){
      document.querySelector('.co-returnbar')?.remove();
      document.querySelector('.question-header').insertAdjacentHTML('afterend',`<div class="co-returnbar co-root">正在核对来源：${esc(answer(ref.answerId).author)} ${btn('返回发现与讨论','detail','small',`data-id="${returnId}"`)}</div>`);
    }
  }
  function highlight(container,quote){
    if(!container)return;
    document.querySelectorAll('.co-highlight').forEach(e=>e.classList.remove('co-highlight'));
    const squeeze=s=>String(s||'').replace(/\s/g,'');
    const target=squeeze(quote);
    const paragraphs=[...container.querySelectorAll('p')];
    let hit=target.length>4?paragraphs.find(p=>squeeze(p.textContent).includes(target)):null;
    let exact=Boolean(hit);
    if(!hit&&target.length>4){
      const loose=s=>squeeze(s).replace(/[，。、；：！？,.;:!?"'“”‘’（）()【】\[\]…—\-～~]/g,'');
      const loosened=loose(quote);
      if(loosened.length>4)hit=paragraphs.find(p=>loose(p.textContent).includes(loosened));
    }
    if(hit){
      hit.classList.add('co-highlight');hit.scrollIntoView({block:'center',behavior:'smooth'});
      if(!exact)toast('原文与生成时的文本略有差异，已按归一化匹配定位，请核对完整上下文。');
    }else{
      container.scrollIntoView({block:'start'});container.scrollTop=0;
      toast(quote?'无法精确定位，已回到回答开头。以下是生成时保留的引用，请人工核对。':'这条节点是全文归纳，没有原文引用，已回到回答开头。');
    }
  }

  /* ---------- 通用弹窗 ---------- */
  function showSearch(query=''){
    const list=questions.filter(q=>(q.title+q.tags.join('')+q.answers.map(a=>a.author).join('')).toLowerCase().includes(query.toLowerCase()));
    openModal(query?`搜索“${cut(query,25)}”`:'探索问题','当前演示站包含 6 个问题，搜索问题标题、话题或答主。',`<label><span class="sr-only">搜索问题</span><input class="co-search" id="co-question-search" value="${esc(query)}" placeholder="输入问题、话题或答主"></label><div id="co-search-results">${searchRows(list)}</div>`,btn('关闭','close-modal'),false,'search');
  }
  function searchRows(list){return list.map(q=>`<a class="co-selection-item" href="/question/${q.id}"><div class="co-selection-info"><strong>${esc(q.title)}</strong><p>${q.answers.length} 篇回答 · ${q.tags.map(esc).join(' / ')} · ${publicItems(q.id).length} 条碰撞发现</p></div>${icon('arrow')}</a>`).join('')||'<div class="co-empty">没有匹配的问题，试试“创业”或“专业”。</div>';}
  function info(title,text){openModal(title,'知乎页面模拟 · 前端交互预览',`<div class="co-onboarding">${esc(text)}</div>`,btn('知道了','close-modal','primary'),false,'info');}

  function closeBallMenu(){root.querySelector('.co-ball-menu')?.remove();}
  function openBallMenu(ball,event){
    closeBallMenu();
    const aid=ball.dataset.aid,a=answer(aid);
    if(!a)return;
    root.insertAdjacentHTML('beforeend',`<div class="co-ball-menu" role="menu" aria-label="${esc(a.author)}的窗口操作"><span>${esc(a.author)}</span><button type="button" role="menuitem" data-co="remove-answer" data-aid="${aid}">删除窗口</button></div>`);
    const menu=root.querySelector('.co-ball-menu'),rect=menu.getBoundingClientRect();
    menu.style.left=`${Math.max(8,Math.min(event.clientX,window.innerWidth-rect.width-8))}px`;
    menu.style.top=`${Math.max(8,Math.min(event.clientY,window.innerHeight-rect.height-8))}px`;
    menu.querySelector('button')?.focus({preventScroll:true});
  }
  function locateQuoted(answerId,quote){
    if(!answerId||!quote)return;
    closeModal(true);
    if(document.body.dataset.questionId!==answerId.split('-')[0]){jumpToAnswer(answerId);return;}
    window.ZhihuDemoView.expandAnswer(answerId);
    highlight(document.querySelector(`.AnswerItem[data-answer-id="${CSS.escape(answerId)}"]`),quote);
  }

  /* ---------- 卡牌产物栏：合成后的新节点卡落在页面左侧 ---------- */
  // 三态：loading（正在加载）→ ready（已经生成好）/ failed（判定不能碰撞，置灰并可删除）。
  const results=[];
  const resultById=id=>results.find(r=>r.id===id);
  const reduceMotion=()=>window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches===true;
  function addResult(refs,titleHint){
    const entry={id:uid('res'),refs:refs.map(r=>({...r})),status:'loading',itemId:null,
      title:titleHint||'正在由两个观点合成新问题…',reason:'',kind:'',createdAt:Date.now(),isNew:false};
    results.unshift(entry);
    renderResultRail();peekRail();
    return entry.id;
  }
  function failResult(id,reason,kind='blocked'){
    const entry=resultById(id);
    if(!entry)return;
    entry.status='failed';entry.kind=kind;entry.reason=reason||'这两个观点无法碰撞。';
    entry.title=kind==='no_result'?'这两个观点碰不出新问题':'产物未通过原文校验';
    renderResultRail();peekRail();
    toast(kind==='no_result'?'判定为不能碰撞：'+entry.reason:'碰撞失败：'+entry.reason);
  }
  function resultCardHtml(entry){
    const authors=entry.refs.map(r=>cut(answer(r.answerId)?.author,6)).filter(Boolean).join(' × ');
    if(entry.status==='loading')
      return `<article class="co-result-card is-loading" data-result="${esc(entry.id)}" aria-busy="true"><b>${esc(entry.title)}</b><small>${esc(authors)}</small><span class="co-result-state"><span class="co-spinner" aria-hidden="true"></span>正在加载…</span></article>`;
    if(entry.status==='failed')
      return `<article class="co-result-card is-failed" data-result="${esc(entry.id)}"><button type="button" class="co-result-trash" data-co="discard-result" data-id="${esc(entry.id)}" aria-label="删除这张失败的卡牌" title="删除">${icon('trash')}</button><b>${esc(entry.title)}</b><small>${esc(authors)}　${esc(cut(entry.reason,40))}</small><span class="co-result-state">${icon('alert')}碰撞失败</span></article>`;
    return `<button type="button" class="co-result-card is-ready${entry.isNew?' is-new':''}" data-result="${esc(entry.id)}" data-co="open-result" data-id="${esc(entry.id)}" title="点击查看这个新问题"><b>${esc(cut(entry.title,52))}</b><small>${esc(authors)}</small><span class="co-result-state">${icon('check')}已经生成好</span></button>`;
  }
  function renderResultRail(){
    const old=root.querySelector('.co-result-rail');
    if(!results.length){old?.remove();return;}
    const peeking=old?.classList.contains('is-peeking')?' is-peeking':'';
    const html=`<section class="co-result-rail co-root${peeking}" aria-label="碰撞生成的新节点"><div class="co-result-rail-head"><strong>新节点</strong><span>${results.filter(r=>r.status==='ready').length}/${results.length} 已生成</span></div>${results.map(resultCardHtml).join('')}</section>`;
    if(old)old.outerHTML=html;else root.insertAdjacentHTML('beforeend',html);
  }
  // 窄屏下产物栏收成抽屉，新卡落位或状态变化时先自动探出，让用户看见，再收回。
  let peekTimer;
  function peekRail(duration=2600){
    const rail=root.querySelector('.co-result-rail');
    if(!rail)return;
    rail.classList.add('is-peeking');
    clearTimeout(peekTimer);
    peekTimer=setTimeout(()=>root.querySelector('.co-result-rail')?.classList.remove('is-peeking'),duration);
  }
  function railCardEl(id){return root.querySelector(`.co-result-card[data-result="${CSS.escape(id)}"]`);}
  /* 合成出的新卡牌从碰撞点出发，一路飞到左侧产物栏对应的位置。 */
  function flyToRail(id,origin){
    const card=railCardEl(id);
    if(!card)return;
    if(!origin||reduceMotion())return;
    // 抽屉形态下先展开再量位置：临时关掉过渡，避免量到动画中间态导致落点偏移。
    const rail=root.querySelector('.co-result-rail');
    if(rail){rail.style.transition='none';peekRail();void rail.offsetWidth;}
    const target=card.getBoundingClientRect();
    if(rail)rail.style.transition='';
    card.style.visibility='hidden';
    const fly=document.createElement('div');
    fly.className='co-fly-card is-born';
    fly.textContent='新节点';
    fly.style.left=`${origin.x}px`;fly.style.top=`${origin.y}px`;
    fly.style.width='120px';fly.style.height='58px';
    document.body.append(fly);
    requestAnimationFrame(()=>{
      fly.classList.remove('is-born');
      fly.style.left=`${target.left+target.width/2}px`;
      fly.style.top=`${target.top+target.height/2}px`;
      fly.style.width=`${target.width}px`;fly.style.height=`${target.height}px`;
    });
    const done=()=>{fly.remove();const now=railCardEl(id);if(now)now.style.visibility='';};
    fly.addEventListener('transitionend',done,{once:true});
    setTimeout(done,900);
  }
  function flash(x,y){
    if(reduceMotion())return;
    const el=document.createElement('div');
    el.className='co-merge-flash';el.style.left=`${x}px`;el.style.top=`${y}px`;
    document.body.append(el);setTimeout(()=>el.remove(),600);
  }
  function firstFindBurst(x,y){
    if(reduceMotion())return;
    const burst=document.createElement('div');
    burst.className='co-first-burst';burst.style.left=`${x}px`;burst.style.top=`${y}px`;
    burst.innerHTML=Array.from({length:14},(_,i)=>{
      const angle=(Math.PI*2*i)/14,distance=58+Math.random()*46;
      return `<i style="--dx:${Math.round(Math.cos(angle)*distance)}px;--dy:${Math.round(Math.sin(angle)*distance)}px;animation-delay:${(i%5)*26}ms"></i>`;
    }).join('');
    document.body.append(burst);setTimeout(()=>burst.remove(),1100);
  }
  function openResult(id){
    const entry=resultById(id);
    if(!entry||entry.status!=='ready'||!entry.itemId)return;
    entry.isNew=false;
    const card=railCardEl(id);
    const firstTime=!state.opened.includes(entry.itemId);
    if(firstTime){
      state.opened.push(entry.itemId);persist();
      if(card){const rect=card.getBoundingClientRect();firstFindBurst(rect.left+rect.width/2,rect.top+rect.height/2);}
    }
    firstFind=firstTime;
    setTimeout(()=>{showDetail(entry.itemId);firstFind=false;renderResultRail();},firstTime&&!reduceMotion()?420:0);
  }

  /* ---------- 把可碰撞节点当卡牌拿起来 ---------- */
  let cardDrag=null,suppressNodeClick=false;
  const nodeTextOf=el=>el.querySelector('.co-node-main')?.textContent||'';
  function clearCharging(){root.querySelectorAll('.co-graph-node.is-charging').forEach(el=>el.classList.remove('is-charging'));}
  function startCardDrag(event,el){
    clearTimeout(nodeClickTimer);nodeClickTimer=null;
    const ref={answerId:el.dataset.aid,nodeId:el.dataset.node};
    const rect=el.getBoundingClientRect();
    const ghost=document.createElement('div');
    ghost.className='co-drag-card';
    ghost.style.width=`${Math.round(rect.width)}px`;
    ghost.style.height=`${Math.round(rect.height)}px`;
    ghost.style.setProperty('--tilt',`${(Math.random()*4-2-3).toFixed(1)}deg`);
    ghost.innerHTML=`<span>${esc(cut(nodeTextOf(el),70))}</span>`;
    document.body.append(ghost);
    el.classList.add('is-dragging-source');
    document.body.classList.add('co-card-dragging');
    cardDrag={ref,source:el,ghost,target:null,origin:{x:rect.left+rect.width/2,y:rect.top+rect.height/2}};
    moveGhost(event.clientX,event.clientY);
  }
  function moveGhost(x,y){
    if(!cardDrag)return;
    cardDrag.ghost.style.left=`${x}px`;
    cardDrag.ghost.style.top=`${y}px`;
  }
  function updateCardTarget(x,y){
    if(!cardDrag)return;
    const under=document.elementFromPoint(x,y)?.closest('.co-graph-node');
    const valid=under&&under!==cardDrag.source&&under.dataset.collidable==='true'
      &&!core.validatePair(wb.questionId,[cardDrag.ref,{answerId:under.dataset.aid,nodeId:under.dataset.node}],node);
    if(valid&&under===cardDrag.target)return;
    clearCharging();
    cardDrag.target=valid?under:null;
    cardDrag.ghost.classList.toggle('is-locked',Boolean(valid));
    // 只要还没松手，靠近的目标卡就一直保持微微的充能动画。
    if(valid)under.classList.add('is-charging');
  }
  function endCardDrag(commit){
    if(!cardDrag)return;
    const {source,ghost,target,ref}=cardDrag;
    cardDrag=null;
    document.body.classList.remove('co-card-dragging');
    clearCharging();
    source.classList.remove('is-dragging-source');
    if(!commit||!target){
      const back=source.getBoundingClientRect();
      ghost.classList.add('is-returning');
      ghost.style.left=`${back.left+back.width/2}px`;
      ghost.style.top=`${back.top+back.height/2}px`;
      setTimeout(()=>ghost.remove(),260);
      return;
    }
    ghost.remove();
    const targetRef={answerId:target.dataset.aid,nodeId:target.dataset.node};
    const a=source.getBoundingClientRect(),b=target.getBoundingClientRect();
    const midX=(a.left+a.width/2+b.left+b.width/2)/2,midY=(a.top+a.height/2+b.top+b.height/2)/2;
    // 两张卡吸到一起 → 闪光 → 生成一张新卡飞向左侧。
    source.classList.add('is-merging');target.classList.add('is-merging');
    flash(midX,midY);
    setTimeout(()=>{
      source.classList.remove('is-merging');target.classList.remove('is-merging');
      collisionRefs=[ref,targetRef];
      startCollision({x:midX,y:midY});
    },reduceMotion()?0:280);
  }
  root.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    const el=event.target.closest('.co-graph-node.is-collision');
    if(!el||event.target.closest('.co-graph-source'))return;
    if(!wb)return;
    const pending={el,startX:event.clientX,startY:event.clientY,pointerId:event.pointerId};
    const onMove=moveEvent=>{
      if(moveEvent.pointerId!==pending.pointerId)return;
      if(!cardDrag){
        if(Math.hypot(moveEvent.clientX-pending.startX,moveEvent.clientY-pending.startY)<6)return;
        startCardDrag(moveEvent,pending.el);
      }
      moveGhost(moveEvent.clientX,moveEvent.clientY);
      updateCardTarget(moveEvent.clientX,moveEvent.clientY);
      moveEvent.preventDefault();
    };
    const onUp=upEvent=>{
      if(upEvent.pointerId!==pending.pointerId)return;
      document.removeEventListener('pointermove',onMove);
      document.removeEventListener('pointerup',onUp);
      document.removeEventListener('pointercancel',onCancel);
      if(cardDrag){suppressNodeClick=true;setTimeout(()=>{suppressNodeClick=false;},0);endCardDrag(true);}
    };
    const onCancel=()=>{
      document.removeEventListener('pointermove',onMove);
      document.removeEventListener('pointerup',onUp);
      document.removeEventListener('pointercancel',onCancel);
      endCardDrag(false);
    };
    document.addEventListener('pointermove',onMove);
    document.addEventListener('pointerup',onUp);
    document.addEventListener('pointercancel',onCancel);
  });

  /* ---------- 事件 ---------- */
  document.addEventListener('dblclick',event=>{
    const card=event.target.closest('.co-graph-node');
    if(!card||!root.contains(card))return;
    event.preventDefault();event.stopPropagation();
    clearTimeout(nodeClickTimer);nodeClickTimer=null;
    trace('node_source_opened',{answerId:card.dataset.aid,nodeId:card.dataset.node});
    locate({answerId:card.dataset.aid,nodeId:card.dataset.node});
  });
  document.addEventListener('click',async event=>{
    if(root.querySelector('.co-ball-menu')&&!event.target.closest('.co-ball-menu'))closeBallMenu();
    // 刚刚完成一次卡牌拖拽合成时，抑制随之而来的 click，避免又打开一次配对。
    if(suppressNodeClick&&event.target.closest('.co-graph-node'))return;
    const el=event.target.closest('[data-co]');
    if(!el)return;
    event.preventDefault();
    const act=el.dataset.co,id=el.dataset.id,aid=el.dataset.aid,ref={answerId:aid,nodeId:el.dataset.nid};
    if(act==='close-modal')closeModal();
    else if(act==='open-result')openResult(id);
    else if(act==='discard-result'){
      const index=results.findIndex(r=>r.id===id);
      if(index<0)return;
      results.splice(index,1);renderResultRail();toast('已删除这张失败的卡牌。');
    }
    else if(act==='select'||act==='select-answer'){if(dirty&&!confirm('进入选择模式会放弃未保存修改，继续吗？'))return;enterSelectMode(el.dataset.qid||aid?.split('-')[0],aid);}
    else if(act==='exit-select')exitSelectMode();
    else if(act==='toggle-pick')togglePick(aid);
    else if(act==='start-workbench')startWorkbench();
    else if(act==='retry-map')retryMapGeneration(aid);
    else if(act==='close-workbench'){saveWorkspace();wb=null;pair=[];root.querySelector('.co-floating-stack')?.remove();decorate();}
    else if(act==='clear-pair'){pair=[];updatePair();}
    else if(act==='pair-node')pick(ref);
    else if(act==='node-detail'){
      clearTimeout(nodeClickTimer);nodeClickTimer=null;
      // 浏览器会在 dblclick 前先派发 click；短暂延后单击动作，确保双击只执行原文定位。
      if(event.detail>1)return;
      nodeClickTimer=setTimeout(()=>{nodeClickTimer=null;showTreeNodeDetail(ref);},280);
    }
    else if(act==='node-source')showNodeSource(ref);
    else if(act==='tree-source')locate(ref);
    else if(act==='locate-quote')locateQuoted(aid,el.dataset.quote);
    else if(act==='locate')locate(ref);
    else if(act==='jump-answer'){
      const qid=aid?.split('-')[0];
      if(qid&&document.body.dataset.questionId!==qid){location.href=`/question/${qid}#answer-${aid}`;return;}
      jumpToAnswer(aid);
    }
    else if(act==='read-answer'){closeModal(true);jumpToAnswer(aid);}
    else if(act==='reader')jumpToAnswer(aid);
    else if(act==='reader-top')jumpToAnswer(wb?.reader);
    else if(act==='close-slot'){const slot=Number(el.dataset.slot);wb=core.assignSlot(wb,slot,null);pair=pair.filter(r=>wb.slots.includes(r.answerId));saveWorkspace();renderWorkbench();toast('已最小化为右下方的作者圆球。');}
    else if(act==='open-slot'){
      if(suppressBallClickId===aid){suppressBallClickId=null;return;}
      const slot=core.preferredSlot(wb),replaced=wb.slots[slot];
      wb=core.assignSlot(wb,slot,aid);pair=[];saveWorkspace();renderWorkbench();toast(replaced?`已用 ${answer(aid).author} 替换${slot?'下方':'上方'}浮窗。`:`已展开 ${answer(aid).author} 的浮窗。`);
    }
    else if(act==='remove-answer'){
      closeBallMenu();
      if(!confirm(`将${answer(aid).author}的回答移出节点插件？\n共享结构图、已有草稿和公开发现都会保留。`))return;
      wb.selected=wb.selected.filter(x=>x!==aid);
      wb.slots=wb.slots.map(x=>x===aid?null:x);
      if(wb.reader===aid)wb.reader=wb.selected[0];
      pair=pair.filter(r=>r.answerId!==aid);
      saveWorkspace();renderWorkbench();toast('已移出节点插件。重新加入即可复用原结构图。');
    }
    else if(act==='shelf-tab'){shelfTab=el.dataset.tab;renderWorkbench();}
    else if(act==='toggle-shelf'){const grid=root.querySelector('.co-wb-grid');grid.classList.toggle('show-shelf');wb.mobile=wb.mobile==='shelf'?'maps':'shelf';grid.dataset.mobile=wb.mobile;saveWorkspace();}
    else if(act==='mobile-tab'){wb.mobile=el.dataset.tab;saveWorkspace();renderWorkbench();}
    else if(act==='choose-action'){collisionAction=el.dataset.kind;dialog.querySelectorAll('[data-co="choose-action"]').forEach(e=>{e.classList.toggle('selected',e===el);e.setAttribute('aria-pressed',String(e===el));});}
    else if(act==='generate')generate();
    else if(act==='back-to-action')showCollision();
    else if(act==='edit')showEditor(id);
    else if(act==='save-draft')saveEditor();
    else if(act==='submit-review')saveEditor(true);
    else if(act==='discard'){
      const i=state.items.find(x=>x.id===id);
      if(!i||!confirm('放弃这条草稿？本版会把它标记为已放弃，不再出现在列表中。'))return;
      Object.assign(i,core.transition(i,'discarded'));persist();closeModal(true);renderWorkbench();toast('草稿已标记为放弃。');
    }
    else if(act==='review-list')showReviewList();
    else if(act==='review')showReview(id);
    else if(act==='approve-review'||act==='return-review')review(id,Number(el.dataset.revision),act==='approve-review');
    else if(act==='resolve-issue'){
      const x=state.issues.find(y=>y.id===id);if(!x)return;
      const hide=el.dataset.resolution==='hidden';
      if(hide){
        const item=state.items.find(y=>y.id===x.insightId);
        if(item?.status==='published')Object.assign(item,core.transition(item,'hidden'),{hiddenReason:x.reason,hiddenAt:Date.now()});
      }
      Object.assign(x,{status:'resolved',resolution:hide?'hidden':'keep',resolvedBy:me().id,resolvedAt:Date.now()});
      persist();decorate();if(wb)renderWorkbench();showReviewList();
      toast(hide?'已下架该发现，公共列表不再展示，后台记录保留。':'已记录保留决定，异议关闭。');
    }
    else if(act==='toggle-discovery'){
      const expand=!expandedDiscoveries.has(id);
      if(expand)expandedDiscoveries.add(id);else expandedDiscoveries.delete(id);
      document.querySelectorAll(`.co-discovery-item[data-insight-id="${CSS.escape(id)}"]`).forEach(item=>{
        item.classList.toggle('is-expanded',expand);
        item.querySelector('.co-inline-detail').hidden=!expand;
        const button=item.querySelector('.co-discovery-summary');button.setAttribute('aria-expanded',String(expand));button.querySelector(':scope > b').textContent=expand?'收起 ›':'展开 ›';
      });
    }
    else if(act==='detail')showDetail(id);
    else if(act==='public-list')showPublicList(el.dataset.qid);
    else if(act==='issue')showIssue(id);
    else if(act==='submit-issue'){
      const reason=dialog.querySelector('#co-issue-reason').value.trim();
      if(!reason)return toast('请填写异议理由。');
      if(state.issues.some(x=>x.insightId===id&&x.reporterId===me().id&&x.status==='open'))return toast('你对这条发现已有一个待处理异议。');
      state.issues.unshift({id:uid('issue'),insightId:id,reporterId:me().id,reason,status:'open',resolution:null,createdAt:Date.now()});
      persist();closeModal(true);showDetail(id);toast('异议已提交到演示审核台，由审核员决定保留或下架。');
    }
    else if(act==='withdraw-comment'){
      const list=state.comments[id]||[];const c=list.find(x=>x.id===el.dataset.cid);
      if(!c||c.authorId!==me().id)return;
      if(!confirm('撤回这条评论？将保留占位，正文不再展示。'))return;
      try{const response=await fetch('/api/discoveries/comment/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({discoveryId:id,commentId:c.id,status:'withdrawn'})});const result=await response.json();if(!response.ok)throw new Error(result.error||'撤回失败。');}
      catch(error){toast(error.message);return;}
      c.status='withdrawn';c.moderatedAt=Date.now();persist();decorate();showDetail(id);toast('评论已撤回，占位保留。');
    }
    else if(act==='detail-explore'){const qid=el.dataset.qid;closeModal(true);if(wb?.questionId===qid)return;enterSelectMode(qid);}
    else if(act==='recall'||act==='withdraw'){
      const i=state.items.find(x=>x.id===id);if(!i)return;
      if(!confirm(act==='withdraw'?'撤回后，两个回答下都不再公开展示这条发现。继续吗？':'撤回到草稿后可以修改，继续吗？'))return;
      if(act==='withdraw'){
        try{const response=await fetch('/api/discoveries/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({discoveryId:id,status:'withdrawn'})});const result=await response.json();if(!response.ok)throw new Error(result.error||'撤回失败。');}
        catch(error){toast(error.message);return;}
      }
      Object.assign(i,core.transition(i,act==='withdraw'?'withdrawn':'draft'),act==='withdraw'?{withdrawnAt:Date.now()}:{});
      persist();closeModal(true);decorate();shelfTab=act==='withdraw'?'published':'draft';if(wb)renderWorkbench();
      toast(act==='withdraw'?'已撤回本站公开。评论与审核记录仍保留在后台。':'已撤回到私有草稿。');
    }
    else if(act==='copy-link'){
      const i=itemById(id);const url=`${location.origin}/question/${i.questionId}?insight=${encodeURIComponent(id)}`;
      try{await navigator.clipboard.writeText(url);toast('链接已复制；登录本站的其他用户也可以查看。');}
      catch{info('复制链接',url);}
    }
    else if(act==='follow'){const key=el.dataset.follow;state.follows=state.follows.includes(key)?state.follows.filter(x=>x!==key):[...state.follows,key];persist();paintFollow(el);toast('关注状态已在本浏览器保存。');}
    else if(act==='compose')info('写回答','这一轮先完善“已有回答之间的碰撞”。完整发文功能尚未接入，你可以通过“选择回答”体验拆解、碰撞、审核和讨论。');
    else if(act==='invite')info('邀请回答','当前是本地页面模拟，尚未连接知乎用户与通知系统，因此不会向任何人发送邀请。');
  });
  document.addEventListener('contextmenu',event=>{
    const ball=event.target.closest('.co-miniball');
    if(ball&&root.contains(ball)){event.preventDefault();openBallMenu(ball,event);return;}
    closeBallMenu();
  });
  document.addEventListener('change',event=>{
    const el=event.target;
    if(el.matches('[data-slot]')&&el.tagName==='SELECT'){wb=core.assignSlot(wb,Number(el.dataset.slot),el.value||null);pair=[];saveWorkspace();renderWorkbench();}
    if(el.id==='co-author-confirm'){
      const item=state.items.find(i=>i.id===editor?.id);
      const blocked=(item?.evidence||{}).eligibility==='needs_evidence';
      dialog.querySelector('[data-co="submit-review"]').disabled=!el.checked||blocked;
    }
    if(el.matches('[data-review-check]'))dialog.querySelector('[data-co="approve-review"]').disabled=![...dialog.querySelectorAll('[data-review-check]')].every(c=>c.checked);
  });
  // 选择模式下点击回答卡片任意位置即可选中；避开链接、按钮和正文取词等既有交互。
  document.addEventListener('click',event=>{
    if(!selectMode||dialog.open)return;
    if(event.target.closest('[data-co],a,button,input,textarea,select,summary'))return;
    const card=event.target.closest('.AnswerItem');
    if(!card)return;
    if(!getSelection()?.isCollapsed)return;
    togglePick(card.dataset.answerId);
  });
  dialog.addEventListener('input',event=>{
    const target=event.target;
    if(target.id==='co-question-search'){const query=target.value.toLowerCase();dialog.querySelector('#co-search-results').innerHTML=searchRows(questions.filter(q=>(q.title+q.tags.join('')+q.answers.map(a=>a.author).join('')).toLowerCase().includes(query)));}
    if(modalKind==='editor'&&target.matches('[name]')){
      dirty=true;
      const confirmBox=dialog.querySelector('#co-author-confirm');
      confirmBox.checked=false;
      dialog.querySelector('[data-co="submit-review"]').disabled=true;
      const limits={title:[L.title,0],rationale:[L.rationaleMax,L.rationaleMin],limitations:[L.limitations,0]}[target.name];
      const counter=dialog.querySelector(`#co-count-${target.name}`);
      if(limits&&counter){
        const n=core.size(target.value);
        counter.textContent=`${n}/${limits[0]}${limits[1]?` · 至少 ${limits[1]}`:''}`;
        counter.classList.toggle('over',n>limits[0]||(limits[1]&&n<limits[1]));
      }
    }
  });
  dialog.addEventListener('submit',async event=>{
    if(!event.target.matches('.co-comment-form'))return;
    event.preventDefault();
    const form=event.target,id=form.dataset.insight,text=form.elements.comment.value.trim();
    if(!text)return;
    if(core.size(text)>L.comment)return toast(`评论最多 ${L.comment} 字。`);
    if(itemById(id)?.status!=='published')return toast('这条发现已不可评论。');
    if(!window.ZhihuDemoCommunity?.isAuthenticated?.()){window.ZhihuDemoCommunity?.requireAccount?.();return;}
    let saved;
    try{
      const response=await fetch('/api/discoveries/comment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({discoveryId:id,text})});
      const result=await response.json();
      if(response.status===401){window.ZhihuDemoCommunity?.requireAccount?.();return;}
      if(!response.ok)throw new Error(result.error||'评论保存失败。');
      saved=result.item;
    }catch(error){toast(error.message);return;}
    if(!Array.isArray(state.comments[id]))state.comments[id]=[];
    state.comments[id].push(saved);
    persist();
    if(form.dataset.inline){expandedDiscoveries.add(id);decorate();document.querySelector(`.co-discovery-item[data-insight-id="${CSS.escape(id)}"]`)?.scrollIntoView({block:'nearest'});}
    else {decorate();showDetail(id);dialog.querySelector('.co-comment-form')?.scrollIntoView({block:'end'});}
    toast('评论已公开保存在本站。');
  });
  /* 观点卡牌已改为 pointer 拖拽，这里只保留最小化作者圆球的 HTML5 拖放。 */
  root.addEventListener('dragstart',event=>{
    const ball=event.target.closest('.co-miniball');
    if(!ball)return;
    draggedAnswerId=ball.dataset.aid;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',draggedAnswerId);ball.classList.add('is-dragging');
  });
  root.addEventListener('dragover',event=>{
    if(!draggedAnswerId)return;
    const slot=event.target.closest('.co-float-window');
    if(slot){event.preventDefault();event.dataTransfer.dropEffect='move';slot.classList.add('is-ball-target');}
  });
  root.addEventListener('dragleave',event=>{const slot=event.target.closest('.co-float-window');if(slot&&!slot.contains(event.relatedTarget))slot.classList.remove('is-ball-target');});
  root.addEventListener('drop',event=>{
    if(!draggedAnswerId)return;
    event.preventDefault();
    const slot=event.target.closest('.co-float-window');
    root.querySelectorAll('.is-ball-target').forEach(e=>e.classList.remove('is-ball-target'));
    if(slot){wb=core.assignSlot(wb,Number(slot.dataset.slotIndex),draggedAnswerId);pair=[];saveWorkspace();renderWorkbench();toast(`已用 ${answer(draggedAnswerId).author} 替换这个浮窗。`);}
    draggedAnswerId=null;
  });
  root.addEventListener('dragend',()=>{
    draggedAnswerId=null;
    root.querySelectorAll('.is-ball-target,.co-miniball.is-dragging').forEach(e=>e.classList.remove('is-ball-target','is-dragging'));
  });
  root.addEventListener('pointerdown',event=>{
    const ball=event.target.closest('.co-miniball');
    if(!ball||event.button!==0)return;
    ballPointerDrag={aid:ball.dataset.aid,startX:event.clientX,startY:event.clientY,moved:false,ball};
  });
  document.addEventListener('pointermove',event=>{
    if(!ballPointerDrag)return;
    if(!ballPointerDrag.moved&&Math.hypot(event.clientX-ballPointerDrag.startX,event.clientY-ballPointerDrag.startY)<7)return;
    ballPointerDrag.moved=true;
    ballPointerDrag.ball.classList.add('is-dragging');
    root.querySelectorAll('.co-float-window.is-ball-target').forEach(el=>el.classList.remove('is-ball-target'));
    document.elementFromPoint(event.clientX,event.clientY)?.closest('.co-float-window')?.classList.add('is-ball-target');
  });
  document.addEventListener('pointerup',event=>{
    if(!ballPointerDrag)return;
    const active=ballPointerDrag;ballPointerDrag=null;
    root.querySelectorAll('.co-float-window.is-ball-target,.co-miniball.is-dragging').forEach(el=>el.classList.remove('is-ball-target','is-dragging'));
    if(!active.moved)return;
    suppressBallClickId=active.aid;
    const slot=document.elementFromPoint(event.clientX,event.clientY)?.closest('.co-float-window');
    if(slot){wb=core.assignSlot(wb,Number(slot.dataset.slotIndex),active.aid);pair=[];saveWorkspace();renderWorkbench();toast(`已用 ${answer(active.aid).author} 替换这个浮窗。`);}
    setTimeout(()=>{if(suppressBallClickId===active.aid)suppressBallClickId=null;},0);
  });
  root.addEventListener('pointerdown',event=>{
    const viewport=event.target.closest('.co-map-scroll');
    if(!viewport||event.button!==0||event.target.closest('.co-node,.co-map-note,button,a'))return;
    const aid=viewport.closest('.co-float-window')?.dataset.aid;
    if(!aid)return;
    const view=mapViews.get(aid)||{x:0,y:0,zoom:1};
    canvasPointerDrag={aid,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,originX:view.x,originY:view.y,viewport};
    viewport.setPointerCapture?.(event.pointerId);viewport.classList.add('is-panning');event.preventDefault();
  });
  document.addEventListener('pointermove',event=>{
    if(!canvasPointerDrag||event.pointerId!==canvasPointerDrag.pointerId)return;
    const view=mapViews.get(canvasPointerDrag.aid)||{x:0,y:0,zoom:1};
    view.x=canvasPointerDrag.originX+event.clientX-canvasPointerDrag.startX;
    view.y=canvasPointerDrag.originY+event.clientY-canvasPointerDrag.startY;
    mapViews.set(canvasPointerDrag.aid,view);applyMapView(canvasPointerDrag.aid);event.preventDefault();
  });
  document.addEventListener('pointerup',event=>{
    if(!canvasPointerDrag||event.pointerId!==canvasPointerDrag.pointerId)return;
    canvasPointerDrag.viewport.classList.remove('is-panning');canvasPointerDrag=null;
  });
  root.addEventListener('wheel',event=>{
    const viewport=event.target.closest('.co-map-scroll'),slot=viewport?.closest('.co-float-window');
    if(!viewport||!slot?.dataset.aid)return;
    event.preventDefault();
    const aid=slot.dataset.aid,view=mapViews.get(aid)||{x:0,y:0,zoom:1},next=Math.min(1.8,Math.max(.55,view.zoom*Math.exp(-event.deltaY*.0015)));
    const rect=viewport.getBoundingClientRect(),cx=event.clientX-rect.left,cy=event.clientY-rect.top;
    const worldX=(cx-view.x)/view.zoom,worldY=(cy-view.y)/view.zoom;
    view.x=cx-worldX*next;view.y=cy-worldY*next;view.zoom=next;
    mapViews.set(aid,view);applyMapView(aid);
  },{passive:false});
  window.addEventListener('blur',()=>{dragRef=null;draggedAnswerId=null;canvasPointerDrag=null;closeBallMenu();root.querySelectorAll('.co-map-scroll.is-panning').forEach(el=>el.classList.remove('is-panning'));});
  document.addEventListener('keydown',event=>{
    if(event.key!=='Escape')return;
    if(root.querySelector('.co-ball-menu')){closeBallMenu();return;}
    if(dialog.open)return;
    if(pair.length){pair=[];updatePair();toast('已取消未提交的节点配对。');return;}
    if(selectMode&&!wb)exitSelectMode();
  });
  document.querySelector('.search button')?.addEventListener('click',()=>showSearch(document.querySelector('.search input').value.trim()));
  document.querySelector('.search input')?.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();showSearch(event.target.value.trim());}});
  document.querySelector('.zhida')?.addEventListener('click',()=>enterSelectMode());
  document.querySelectorAll('.main-nav a[href="#"]').forEach(link=>link.addEventListener('click',event=>{
    event.preventDefault();
    const label=link.textContent.trim();
    if(label==='热榜'){
      const html=questions.map((q,i)=>`<a class="co-selection-item" href="/question/${q.id}"><b class="co-slot-letter">${i+1}</b><div class="co-selection-info"><strong>${esc(q.title)}</strong><p>${q.answers.length} 篇回答 · 演示问题，不代表知乎实时热度</p></div></a>`).join('');
      openModal('试用问题榜','浏览这次演示中收录的问题',html,btn('关闭','close-modal'));
    }else if(label==='关注'){
      const qs=questions.filter(q=>state.follows.includes(q.id)||q.answers.some(a=>state.follows.includes(a.id)));
      openModal('我的关注','关注记录仅保存在本浏览器',searchRows(qs),btn('探索更多问题','browse','primary'));
      dialog.querySelector('[data-co="browse"]').onclick=()=>showSearch();
    }else if(label.startsWith('AI Works'))enterSelectMode();
    else info(label,`当前演示聚焦问题与回答，${label}内容尚未接入。可以从推荐页选择一个问题，开始碰撞不同回答。`);
  }));
  window.addEventListener('zhihu:render',decorate);
  window.ZhihuCollision={decorate};
  decorate();
  loadPublicDiscoveries();

  // 用后端校正后的结构图覆盖静态快照，保证前端看到的节点与碰撞时用的原文同源。
  // 静态快照是构建期产物，后端启动时会用 quote 回原文重算归属与 offset。
  (async () => {
    const qid=document.body.dataset.questionId;
    if(!qid)return;
    try{
      const resp=await fetch(`/api/collide/maps?qid=${encodeURIComponent(qid)}`);
      if(!resp.ok)return;
      const data=await resp.json();
      if(!data||!data.answers)return;
      let n=0;
      for(const [aid,payload] of Object.entries(data.answers)){maps[aid]=payload;n++;}
      if(n){liveMaps=true;decorate();if(wb)renderWorkbench();}
    }catch(err){/* 碰撞服务未启动时保持静态快照，页面仍可浏览 */}
  })();
  if(storageError)toast('未能读取旧的浏览器记录，当前以空白工作区打开。');
  const params=new URLSearchParams(location.search);
  if(params.has('insight'))showDetail(params.get('insight'));
  else if(params.has('draft'))showEditor(params.get('draft'));
  else if(params.has('workbench')){const qid=document.body.dataset.questionId||'10005';const saved=workspace(qid);if(saved.selected.length){wb=saved;renderWorkbench();}else enterSelectMode(qid);}
  else if(params.has('review'))showReviewList();
  else if(params.has('explore'))enterSelectMode(null,params.get('pick'));
  else if(params.has('source')){
    const [answerId,nodeId]=params.get('source').split(':');
    setTimeout(()=>{sourceReturn=params.get('backInsight');modalKind=sourceReturn?'detail':'';locate({answerId,nodeId});},500);
  }
})();
