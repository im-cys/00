/* Local, explicitly labelled MVP prototype for the design in MVP页面流程与数据对象.md.
   No model requests, no real Zhihu publication. All state lives in this browser. */
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
  const node = ref => maps[ref?.answerId]?.nodes.find(n => n.id === ref.nodeId);
  const paragraphsOf = answerId => answer(answerId)?.paragraphs?.filter(p => !p.includes('〔图片〕') && !p.includes('〔视频〕')) || [];
  const cut = (s, n = 46) => [...String(s || '')].slice(0, n).join('') + ([...String(s || '')].length > n ? '…' : '');
  const when = value => value ? new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
  const names = {draft:'私有草稿',pending:'待审核',returned:'已退回',published:'已公开',withdrawn:'已撤回',hidden:'已下架',discarded:'已放弃'};
  const types = {claim:'观点',fact:'事实陈述',experience:'经验',method:'方法'};
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
    alert:'<path d="M12 4 2.5 20h19Z"/><path d="M12 10v4m0 3v.5"/>',
    shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6Z"/><path d="m8 12 3 3 5-6"/>'
  };
  const icon = name => `<svg class="co-icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.nodes}</svg>`;
  const btn = (text, action, cls = '', attrs = '') => `<button type="button" class="co-btn ${cls}" data-co="${action}" ${attrs}>${text}</button>`;
  const badge = (text, cls = '') => `<span class="co-badge ${cls}">${esc(text)}</span>`;

  const KEY = 'zhihu-collision-mvp-v3';
  const STALE_KEYS = ['zhihu-collision-mvp-v1','zhihu-collision-mvp-v2'];
  let storageError = false;
  let state = {version:3,items:[],comments:{},workspaces:{},follows:[],jobs:[],issues:[]};
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
      issues:Array.isArray(saved.issues)?saved.issues:[]};
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
      editor = null, dirty = false, modalKind = '', lastFocus = null, shelfTab = 'draft', sourceReturn = null, dragRef = null, draggedAnswerId = null, ballPointerDrag = null, canvasPointerDrag = null, suppressBallClickId = null, reviewerMode = false, selectMode = false;
  const mapViews = new Map();
  const expandedDiscoveries = new Set();
  // 碰撞已接入真实模型链路（关系判定 + 提问 + evidence 回查），不再是模板规则。
  // “公开”是本站公开，不会自动发布到知乎。
  const demoNote = '<div class="co-demo-note">本站功能试用 · 碰撞由 AI 生成并经 evidence 回原文校验；公开内容仅展示在本站，不会自动发布到知乎。</div>';
  function toast(message) { clearTimeout(toastTimer); toastEl.textContent=message; toastEl.hidden=false; toastTimer=setTimeout(()=>toastEl.hidden=true,4600); }
  function openModal(title, subtitle, body, footer='', wide=false, kind='') {
    if(!dialog.open)lastFocus=document.activeElement;
    modalKind=kind; dirty=false;
    dialog.className=`co-dialog ${wide?'wide':''}`;
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
  function homeInsightPanel(items) {
    return `<section class="co-feed-discoveries" aria-label="公开节点生成的新问题">
      <header class="co-feed-discoveries-head">
        <div><span class="co-feed-discoveries-icon">${icon('spark')}</span><strong>公开节点</strong><span class="co-muted">从不同回答中生成的新问题</span></div>
        <span class="co-feed-discoveries-count">2 个新节点</span>
      </header>
      <div class="co-feed-discoveries-list">${items.map((item,index)=>{const anchor=`insight-${item.id}-${item.refs[0]?.answerId||''}`;return `<a class="co-feed-question" href="/question/${esc(item.questionId)}?focusInsight=${encodeURIComponent(item.id)}#${esc(anchor)}"><span class="co-feed-question-index">${index+1}</span><span><strong>${esc(item.title)}</strong><small>${item.refs.map(r=>esc(answer(r.answerId)?.author)).join(' × ')} · 发现人 ${esc(item.author)} · 前往问题 →</small></span></a>`;}).join('')}</div>
    </section>`;
  }
  function questionDiscoveryItems(qid){
    return publicItems(qid).sort((a,b)=>(b.publishedAt||0)-(a.publishedAt||0));
  }
  function inlineDiscoveryDetail(item){
    const comments=visibleComments(item.id);
    const analysis=cut(item.relationText||item.rationale||'这个问题来自两篇回答中不同的判断前提。',180);
    return `<div class="co-inline-detail" ${expandedDiscoveries.has(item.id)?'':'hidden'}>
      <div class="co-inline-nodes">${item.refs.map((ref,index)=>{const n=node(ref),a=answer(ref.answerId);return `<section><span>节点 ${index?'B':'A'} · ${esc(a?.author||'未知作者')}</span><p>${esc(n?.text||'暂无节点摘要')}</p></section>`;}).join('')}</div>
      <section class="co-inline-analysis"><strong>AI 分析</strong><p>${esc(analysis)}</p></section>
      <section class="co-inline-comments"><div class="co-between"><strong>评论区 · ${comments.length}</strong><span class="co-muted">两个来源共用</span></div><ol>${comments.slice(0,3).map(c=>`<li><b>${esc(c.author)}</b><span>${esc(c.text)}</span></li>`).join('')||'<li class="co-muted">还没有评论，可以补充回答或指出前提。</li>'}</ol><form class="co-comment-form co-inline-comment-form" data-inline="true" data-insight="${esc(item.id)}"><textarea class="co-comment-input" name="comment" rows="2" maxlength="${L.comment}" placeholder="围绕这个问题评论…" aria-label="发现评论" required></textarea><button type="submit" class="co-btn primary">发布</button></form></section>
    </div>`;
  }
  function inlineDiscoveryItem(item,contextId='question'){
    const expanded=expandedDiscoveries.has(item.id);
    const authors=item.refs.map(r=>answer(r.answerId)?.author).filter(Boolean).join(' × ');
    const domId=`insight-${item.id}-${contextId}`;
    return `<article class="co-discovery-item${expanded?' is-expanded':''}" id="${esc(domId)}" data-insight-id="${esc(item.id)}"><button class="co-discovery-summary" data-co="toggle-discovery" data-id="${esc(item.id)}" aria-expanded="${expanded}"><span class="co-discovery-spark">${icon('spark')}</span><span><strong>${esc(item.title)}</strong><small>来源回答：${esc(authors)}<i>发现人：${esc(item.author)}</i></small></span><b>${expanded?'收起':'展开'} ›</b></button>${inlineDiscoveryDetail(item)}</article>`;
  }
  function discoveryJumpItem(item){
    const aid=item.refs[0]?.answerId||'';
    const authors=item.refs.map(r=>answer(r.answerId)?.author).filter(Boolean).join(' × ');
    return `<a class="co-discovery-summary co-discovery-jump" href="/question/${esc(item.questionId)}?focusInsight=${encodeURIComponent(item.id)}#insight-${esc(item.id)}-${esc(aid)}"><span class="co-discovery-spark">${icon('spark')}</span><span><strong>${esc(item.title)}</strong><small>来源回答：${esc(authors)}<i>发现人：${esc(item.author)}</i></small></span><b>前往 ›</b></a>`;
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
      document.querySelector('#answerCount')?.insertAdjacentHTML('beforebegin',`<section class="co-question-discoveries co-root" id="collision-insights"><div class="co-between"><h2 class="co-section-title">${icon('spark')}本问题的碰撞问题 · ${items.length} 条</h2><span class="co-muted">点击前往相关回答的碰撞条目</span></div>${items.length?`<div class="co-discovery-list">${items.map(discoveryJumpItem).join('')}</div>`:'<div class="co-muted" style="margin-top:12px">还没有公开发现，试着选两篇回答碰撞。</div>'}</section>`);
      document.querySelectorAll('.AnswerItem').forEach(card=>{
        card.querySelector('.co-association')?.remove(); card.querySelector('.co-pick')?.remove(); card.querySelector('.co-pick-hint')?.remove();
        const aid=card.dataset.answerId;
        // 选择模式下才出现选取控件；平时阅读页面只保留轻量的插件入口。
        const picked=selectMode&&selection.has(aid);
        card.classList.toggle('co-pickable',selectMode);
        card.classList.toggle('co-picked',picked);
        if(selectMode){
          const usable=Boolean(maps[aid]);
          card.querySelector('.answer-author')?.insertAdjacentHTML('beforeend',
            `<button type="button" class="co-pick${picked?' is-picked':''}" data-co="toggle-pick" data-aid="${aid}" aria-pressed="${picked}">${picked?icon('check')+'已选择':'选择这篇'}</button>`);
          card.insertAdjacentHTML('beforeend',`<div class="co-pick-hint co-root">${usable?(picked?'已加入节点浮窗，可继续向下挑选另一篇。':'点击卡片任意位置即可选择这篇回答。'):'这篇回答暂无结构图，选择后只能阅读原文，不能参与碰撞。'}</div>`);
          return;
        }
        const linked=items.filter(i=>i.refs.some(r=>r.answerId===aid));
        if(linked.length)card.insertAdjacentHTML('beforeend',`<section class="co-association co-root"><div class="co-between"><strong style="font-size:13px">${icon('spark')}由这篇回答参与形成的问题 · ${linked.length} 条</strong><span class="co-muted">点击展开</span></div><div class="co-discovery-list">${linked.map(i=>inlineDiscoveryItem(i,aid)).join('')}</div></section>`);
      });
      if(!document.querySelector('.co-question-aside'))document.querySelector('.question-layout')?.insertAdjacentHTML('beforeend',`<aside class="co-question-aside co-root"><section class="co-side-card"><h3>也可以看看</h3><ul class="co-side-links">${questions.filter(x=>x.id!==qid).slice(0,4).map(x=>`<li><a href="/question/${x.id}">${esc(x.title)}</a></li>`).join('')}</ul></section><p class="co-side-note">知乎页面模拟 · 与知乎官方无关<br>结构图来自已保存的抽取结果；摘要不等于事实核查。</p></aside>`);
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
    // 历史工作区只负责恢复已经打开的节点窗，不代表下一次选择会话。
    // 普通问题页重新进入后，入口不能继续显示上一次保存的选择数量。
    const count=wb?.questionId===qid?wb.selected.length:0;
    root.insertAdjacentHTML('beforeend',`<button class="co-select-fab" data-co="select" data-qid="${esc(qid)}">${icon('nodes')}<span><strong>选择回答探索</strong><small>${count?`已选择 ${count} 篇 · 点击继续管理`:'生成双节点地图'}</small></span></button>`);
  }
  /* 选择模式：用户仍在原页上下浏览，选好后直接打开右侧节点浮窗。 */
  function renderPickBar(){
    root.querySelector('.co-pickbar')?.remove();
    if(!selectMode)return;
    const qid=document.body.dataset.questionId;
    const ready=[...selection].filter(id=>maps[id]).length;
    const names=[...selection].map(id=>cut(answer(id)?.author,8)).join('、');
    root.insertAdjacentHTML('beforeend',`<div class="co-pickbar co-root" role="region" aria-label="选择回答">
      <div class="co-pickbar-info"><strong>选择回答探索 <em>已选 ${selection.size}</em></strong><span class="co-muted">${selection.size?esc(names):'继续浏览，点击回答卡片即可选中'}${selection.size===1?' · 再选 1 篇即可碰撞':''}${selection.size>=2&&ready<2?' · 可碰撞的结构图不足 2 张':''}</span></div>
      <div class="co-row">${btn('退出选择','exit-select','small')}${btn('打开节点浮窗 →','start-workbench','primary'+(selection.size?'':' '),selection.size?'':'disabled')}</div>
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
    if(aid&&selection.size<MAX_FLOATING_ANSWERS)selection.add(aid);
    selectMode=true;
    decorate();
    toast(`已进入选择模式：向下浏览回答，点击卡片选择，最多 ${MAX_FLOATING_ANSWERS} 篇。`);
  }
  function exitSelectMode(){selectMode=false;selection=new Set();selectedQuestion=null;decorate();toast('已退出选择模式，选择已清空。');}
  function togglePick(aid){
    if(!answer(aid))return;
    if(selection.has(aid))selection.delete(aid);
    else if(selection.size>=MAX_FLOATING_ANSWERS)return toast(`插件最多保留 ${MAX_FLOATING_ANSWERS} 篇，请先取消一篇。`);
    else selection.add(aid);
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
  async function startWorkbench(){
    if(!selection.size)return;
    selectedQuestion=qById(document.body.dataset.questionId)||selectedQuestion||questions[0];
    const previous=wb?.questionId===selectedQuestion.id?wb:workspace(selectedQuestion.id);
    const ids=[...selection];
    const missing=ids.filter(id=>!maps[id]);
    if(missing.length){
      if(!window.ZhihuDemoCommunity?.isAuthenticated?.()){ window.ZhihuDemoCommunity?.requireAccount?.(); return; }
      toast(`正在生成 ${missing.length} 篇回答的节点结构图；已有结果会直接复用。`);
      try{
        const generated=await Promise.all(missing.map(async answerId=>{
          const response=await fetch('/api/maps/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({answerId})});
          const result=await response.json();
          if(response.status===401){window.ZhihuDemoCommunity?.requireAccount?.();throw new Error('请先登录。');}
          if(!response.ok)throw new Error(result.error||'结构图生成失败。');
          return result;
        }));
        generated.forEach(result=>{maps[result.answerId]=result.map;});
      }catch(error){toast(error.message);return;}
    }
    const slots=previous.slots.map(id=>ids.includes(id)?id:null);
    const ready=ids.filter(id=>maps[id]);
    for(let i=0;i<2;i++)if(!slots[i])slots[i]=ready.find(id=>!slots.includes(id))||null;
    wb={...previous,questionId:selectedQuestion.id,selected:ids,slots,reader:ids.includes(previous.reader)?previous.reader:ids[0]};pair=[];
    selectMode=false;
    if(dialog.open)closeModal(true);
    saveWorkspace();decorate();renderWorkbench();
    toast(ready.length?'节点已在右侧浮窗打开。蓝色“观点”节点可跨回答碰撞。':'所选回答暂无可用结构图。');
  }

  /* ---------- P05：原页上的右侧节点浮窗 ---------- */
  function nodeCard(aid,n,position='',groupTitle=''){
    const ref={answerId:aid,nodeId:n.id},selected=pair.some(r=>core.keyOf(r)===core.keyOf(ref));
    return `<article class="co-node ${n.role==='thesis'?'thesis':''} ${selected?'selected':''}" style="${position}" draggable="${n.type==='claim'}" data-node="${esc(n.id)}" data-aid="${aid}"><button class="co-node-main" data-co="pair-node" data-aid="${aid}" data-nid="${esc(n.id)}" aria-pressed="${selected}" title="${n.type==='claim'?'点击选择，再点击另一篇回答的观点':'查看节点与原文'}">${esc(n.text)}</button><div class="co-node-meta">${badge(n.role==='thesis'?'总观点':types[n.type]||n.type,n.type==='claim'?'':'gray')}${groupTitle&&n.role!=='thesis'?`<span class="co-node-group">${esc(cut(groupTitle,10))}</span>`:''}<button class="co-link" data-co="node-source" data-aid="${aid}" data-nid="${esc(n.id)}">原文 ↗</button></div></article>`;
  }
  function networkHtml(aid,m){
    const thesis=m.nodes.find(n=>n.role==='thesis')||m.nodes[0];
    const satellites=m.nodes.filter(n=>n!==thesis);
    const cardW=124,cardH=76,canvasW=300,centerX=(canvasW-cardW)/2,centerY=22;
    const rows=Math.max(Math.ceil(satellites.length/2),1),canvasH=Math.max(330,142+rows*94);
    const points=satellites.map((n,i)=>{const left=i%2===0,row=Math.floor(i/2),jitter=((row%3)-1)*4;return {n,x:left?5+jitter:canvasW-cardW-5-jitter,y:138+row*94};});
    const groupOf=n=>m.groups.find(g=>g.id===n.groupId)?.title||'';
    const startX=centerX+cardW/2,startY=centerY+cardH;
    const paths=points.map(({x,y})=>{const endX=x+cardW/2,endY=y,bendY=Math.max(startY+26,(startY+endY)/2);return `<path d="M ${startX} ${startY} C ${startX} ${bendY}, ${endX} ${bendY-18}, ${endX} ${endY}"/>`;}).join('');
    return `<div class="co-network" data-map-aid="${aid}" style="--canvas-w:${canvasW}px;--canvas-h:${canvasH}px;--node-w:${cardW}px;--node-h:${cardH}px"><svg class="co-network-lines" viewBox="0 0 ${canvasW} ${canvasH}" aria-hidden="true">${paths}</svg>${nodeCard(aid,thesis,`left:${centerX}px;top:${centerY}px`)}${points.map(({n,x,y})=>nodeCard(aid,n,`left:${x}px;top:${y}px`,groupOf(n))).join('')}</div>`;
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
    const net=root.querySelector(`.co-network[data-map-aid="${CSS.escape(aid)}"]`),view=mapViews.get(aid)||{x:0,y:0,zoom:1};
    if(!net)return;
    net.style.setProperty('--pan-x',`${view.x}px`);
    net.style.setProperty('--pan-y',`${view.y}px`);
    net.style.setProperty('--map-zoom',view.zoom);
  }
  function mapSlot(aid,index){
    const m=maps[aid],a=answer(aid),slotName=index?'下方':'上方',thesis=m?.nodes.find(n=>n.role==='thesis')||m?.nodes[0];
    return `<section class="co-map co-float-window" aria-label="${slotName}回答节点浮窗" data-slot-index="${index}" data-aid="${aid}"><header class="co-map-head"><span class="co-slot-letter">${esc([...a.author][0])}</span><button class="co-float-identity" data-co="reader" data-aid="${aid}" title="点击跳到这篇回答开头"><span>${esc(a.author)}</span><strong>${thesis?esc(thesis.text):'暂未生成结构图'}</strong></button><button class="co-iconbtn co-minimize-slot" data-co="close-slot" data-slot="${index}" aria-label="最小化为作者圆球" title="最小化">−</button><button class="co-iconbtn co-close-answer" data-co="remove-answer" data-aid="${aid}" aria-label="关闭${esc(a.author)}的回答浮窗" title="关闭浮窗">×</button></header><div class="co-map-scroll">${
      !m?`<div class="co-empty">${icon('book')}<strong>这篇回答暂不支持拆解</strong>没有已保存的抽取结果。可在中间阅读原文，或切换其他回答。<br>本版不会把原文分段伪装成 AI 抽取结果。</div>`
      :`<div class="co-map-note">左键拖动画布 · 滚轮缩放 · 点击节点选取</div>${networkHtml(aid,m)}`}</div></section>`;
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
    root.insertAdjacentHTML('beforeend',`<section class="co-floating-stack ${openIds.length?'':'is-all-collapsed'}" aria-label="回答节点浮窗">${openIds.length?`<div class="co-float-windows">${wb.slots.map((id,index)=>id?mapSlot(id,index):'').join('')}</div><div class="co-pair-bar" id="co-pair-bar">${pairBar()}</div>`:''}<div class="co-collapsed" aria-label="已最小化的回答">${collapsed.map(id=>`<button class="co-miniball" type="button" draggable="true" data-co="open-slot" data-aid="${id}" title="${esc(answer(id).author)}：左键恢复或拖动替换，右键可删除窗口">${esc([...answer(id).author][0])}</button>`).join('')}</div></section>`);
    root.querySelectorAll('.co-map-scroll').forEach((e,i)=>e.scrollTop=mapScroll[i]||0);
    openIds.forEach(applyMapView);
    renderSelectFab();
  }
  function pairBar(){
    if(!pair.length)return `${icon('spark')}<span>将一个观点拖到另一篇回答的观点上<br>也可以依次点击两个节点；按 Esc 取消</span>`;
    return `${icon('spark')}<span>已选：${esc(cut(node(pair[0])?.text,28))}<br>再选另一篇回答的观点，开始碰撞</span><button class="co-link" data-co="clear-pair">取消</button>`;
  }
  function updatePair(){
    root.querySelectorAll('.co-node').forEach(el=>{const yes=pair.some(r=>r.answerId===el.dataset.aid&&r.nodeId===el.dataset.node);el.classList.toggle('selected',yes);el.querySelector('.co-node-main').setAttribute('aria-pressed',String(yes));});
    const bar=root.querySelector('#co-pair-bar');if(bar)bar.innerHTML=pairBar();
  }
  function pick(ref){
    if(node(ref)?.type!=='claim'){showNodeSource(ref);return;}
    if(pair.some(r=>core.keyOf(r)===core.keyOf(ref))){pair=[];updatePair();return;}
    if(!pair.length){pair=[ref];updatePair();return;}
    const error=core.validatePair(wb.questionId,[pair[0],ref],node);
    if(error){toast(error);return;}
    collisionRefs=[pair[0],ref];showCollision();
  }

  /* ---------- 来源卡片与证据校验 ---------- */
  function sourceCards(refs,evidence){
    return `<div class="co-source-grid">${refs.map((r,i)=>{
      const n=node(r),a=answer(r.answerId),hit=evidence?.details?.[i];
      const quoteHtml=n.quote?`<blockquote>${esc(n.quote)}</blockquote>`:'<blockquote class="co-noquote">这条是 AI 全文归纳，没有直接引用原句。请查看全文核对。</blockquote>';
      const mark=!hit?'':hit.found?badge(hit.method==='exact'?'原文可定位':'原文可定位（归一化匹配）','green'):badge(n.quote?'未能在原文中找到该引用':'无原文引用','amber');
      return `<section class="co-source">${badge(i?'来源 B':'来源 A')} <strong>${esc(a.author)}</strong> ${mark}<p>${esc(n.text)}</p>${quoteHtml}<div class="co-muted">适用条件：${n.scope?esc(n.scope):'原文未明确标注范围'}</div><div class="co-row" style="margin-top:8px">${n.quote?`<button class="co-link" data-co="locate" data-aid="${r.answerId}" data-nid="${esc(r.nodeId)}">定位原文 ↗</button>`:''}<button class="co-link" data-co="read-answer" data-aid="${r.answerId}">查看全文 ↗</button></div></section>`;
    }).join('')}</div>`;
  }
  function showNodeSource(ref){
    const n=node(ref);
    sourceReturn=modalKind==='detail'?sourceReturn:null;
    openModal('核对节点来源','摘要是抽取结果的转述；原文引用也不等于该观点已获证实。',sourceCards([ref],core.evidenceCheck([ref],node,paragraphsOf))+`<div class="co-note-box">节点类型：${esc(types[n.type]||n.type)}。${n.type==='claim'?'可与另一篇回答的观点节点碰撞。':'本版暂不支持此类型参与碰撞，可继续阅读与比较。'}</div>`,btn('返回节点浮窗','close-modal'),false,'source');
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
    const error=core.validatePair(wb.questionId,collisionRefs,node);
    if(error){toast(error);return;}
    const key=core.pairKey(wb.questionId,collisionRefs,collisionAction);
    const existing=state.items.find(i=>i.pairKey===key&&!['discarded','withdrawn'].includes(i.status));
    if(existing){
      toast('这组节点已经有一条发现，已打开原记录。');
      showDetail(existing.id);return;
    }
    const published=allItems().find(i=>i.pairKey===key&&i.status==='published');
    if(published){showDuplicate(published);return;}
    runRealCollide(key);
  }

  /* ---------- 真实碰撞：调用后端 AI 链路 ---------- */
  // 产物为两段式（关系说明 + 新问题），动作完全内化：
  // 用户只负责选哪两个节点，关系类型由模型判定后呈现，不作为选项要求用户输入。
  async function runRealCollide(key){
    const refs=collisionRefs.map(r=>({...r}));
    showThinking();
    let data;
    try{
      const resp=await fetch('/api/collide',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({questionId:wb.questionId,questionTitle:qById(wb.questionId)?.title||'',
          refs:refs.map(r=>({answerId:r.answerId,nodeId:r.nodeId}))})});
      data=await resp.json();
      if(resp.status===401){window.ZhihuDemoCommunity?.requireAccount?.();return;}
    }catch(err){
      data={status:'blocked',reason:'无法连接碰撞服务。请确认「启动碰撞服务.cmd」正在运行。'};
    }
    const now=Date.now(), jobId=uid('job');

    if(data.status==='no_result'){
      recordJob('collide',{status:'succeeded',outcome:'no_result',reason:data.reason||'',refs,action:collisionAction});
      persist();showAiNoResult(data);return;
    }
    if(data.status!=='published'){
      recordJob('collide',{status:'succeeded',outcome:'blocked',reason:data.reason||'',refs,action:collisionAction});
      persist();showBlocked(data);return;
    }

    // 通过 AI 复审（evidence 回查 + 具体元素扫描）→ 默认发布进入公共视野
    const item={id:uid('ins'),questionId:wb.questionId,refs,action:collisionAction,pairKey:key,
      answerPairKey:`${wb.questionId}|${refs.map(r=>r.answerId).sort().join('|')}`,
      relationType:data.relation_type,relationText:data.relation_text,
      newQuestion:data.question,whoCanAnswer:data.who_can_answer,
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
      if(publish.status===401){window.ZhihuDemoCommunity?.requireAccount?.();return;}
      if(!publish.ok)throw new Error(saved.error||'公开保存失败。');
      Object.assign(item,saved.item||{});
    }catch(error){showBlocked({reason:`AI 已生成结果，但保存到公共列表失败：${error.message}`});return;}
    state.items.unshift(item);
    state.jobs.unshift({id:jobId,kind:'collide',status:'succeeded',outcome:'published',createdAt:now,refs,action:collisionAction,resultRef:item.id});
    persist();pair=[];shelfTab='published';renderWorkbench();decorate();showDetail(item.id);
  }

  function showThinking(){
    openModal('正在碰撞','AI 正在读两处原文，判断它们的关系并提出新问题。',
      demoNote+sourceCards(collisionRefs,core.evidenceCheck(collisionRefs,node,paragraphsOf))
      +`<div class="co-empty">${icon('spark')}<strong>调用中，请稍候…</strong>免费额度下单次约 10–30 秒。产出会经过引用回查，引用对不上会被整条丢弃。</div>`,
      '',false,'thinking');
  }

  function showAiNoResult(data){
    openModal('这两个节点碰不出新问题','AI 判定它们讨论的不是同一件事，这是合法结果，不是失败。',
      demoNote+`<div class="co-empty">${icon('alert')}<strong>${esc(data.reason||'两个观点讨论的对象差距过大。')}</strong>没有创建任何公开节点。换一个节点再试。</div>`
      +sourceCards(collisionRefs,core.evidenceCheck(collisionRefs,node,paragraphsOf)),
      `${btn('重新选择节点','close-modal','primary')}`,false,'no-result');
  }

  function showBlocked(data){
    openModal('产物未通过复审','AI 生成了内容，但它没有通过引用回查，因此不予发布。',
      demoNote+`<div class="co-warn-box">${icon('alert')}${esc(data.reason||'未通过校验。')}</div>`
      +`<div class="co-note-box">这正是设计中的出口闸门：问题里的每个具体元素都必须能在原文找到出处，对不上就整条丢弃，宁可无结果也不放幻觉进公共区。</div>`
      +(data.relation_text?`<p class="co-detail-rationale">AI 判断的关系：${esc(data.relation_text)}</p>`:'')
      +sourceCards(collisionRefs,core.evidenceCheck(collisionRefs,node,paragraphsOf)),
      `${btn('重新选择节点','close-modal','primary')}`,false,'blocked');
  }

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
  function showDetail(id){
    const i=itemById(id);
    if(!i)return toast('本浏览器没有这条发现。');
    if(['draft','returned'].includes(i.status)&&i.creatorId===me().id)return showEditor(id);
    if(['withdrawn','hidden','discarded'].includes(i.status))return openModal('该发现暂不可见','状态占位 · 内容不再公开展示',statusPlaceholder(i),'',false,'placeholder');
    sourceReturn=id;
    const comments=visibleComments(id), hidden=allComments(id).length-comments.length;
    const evidence=i.evidence||core.evidenceCheck(i.refs,node,paragraphsOf);
    const mine=i.creatorId===me().id;
    openModal(i.status==='pending'?'待审核的发现':'回答之间的新问题',esc(qById(i.questionId).title),
      `${demoNote}<div class="co-detail-meta">${badge(names[i.status],i.status==='pending'?'amber':i.status==='published'?'green':'')}${badge(tagOf(i),'gray')}<span>由 ${esc(i.author)} 提出</span>${i.publishedAt?`<span>首次公开 ${when(i.publishedAt)}</span>`:''}${i.reviewer?`<span>${i.reviewMode==='ai_review'?'AI 复审已通过':i.reviewMode==='demo_self_review'?'演示自审':'演示审核'} · ${esc(i.reviewer)}</span>`:''}</div>${i.relationText&&i.newQuestion?`<div class="co-note-box" style="margin-top:14px"><strong>关系说明</strong><p style="margin:6px 0 0;white-space:pre-wrap">${esc(i.relationText)}</p></div><h3 class="co-detail-title" style="margin-top:18px">${esc(i.newQuestion)}</h3>${i.whoCanAnswer?`<p class="co-muted">适合回答的人：${esc(i.whoCanAnswer)}</p>`:''}`:`<h3 class="co-detail-title">${esc(i.title)}</h3><p class="co-detail-rationale" style="white-space:pre-wrap">${esc(i.rationale)}</p>`}${(i.aiEvidence&&i.aiEvidence.length)?`<div class="co-note-box" style="margin-top:14px"><strong>AI 引用的原文凭据（已逐条回查）</strong><ol style="margin:8px 0 0;padding-left:20px">${i.aiEvidence.map(e=>`<li><span class="co-muted">${esc(e.answer_id)}@${e.start} · ${esc(e.method)}</span><br>「${esc(e.text)}」</li>`).join('')}</ol></div>`:''}<p class="co-detail-limits">局限：${esc(i.limitations||'提交者未填写额外局限。')}<br>基于两篇回答的推导，不代表来源作者认可。</p><h3 style="font-size:15px;margin-top:24px">从这两个回答出发</h3>${sourceCards(i.refs,evidence)}<hr class="co-divider"><div class="co-between"><strong>围绕这个问题讨论 · ${comments.length}</strong><span class="co-muted">两个回答入口共用同一讨论区</span></div><ol class="co-comment-list">${comments.map(c=>`<li><span class="co-avatar">${esc([...(c.author||'我')][0])}</span><div><strong>${esc(c.author)}</strong> <span class="co-muted">${when(c.createdAt)}</span><p>${esc(c.text)}</p>${c.authorId===me().id?`<button class="co-link" data-co="withdraw-comment" data-id="${esc(id)}" data-cid="${esc(c.id)}">撤回这条评论</button>`:''}</div></li>`).join('')||'<li><div class="co-muted">还没有讨论。可以直接回答这个问题，或指出它的前提问题。</div></li>'}${hidden?`<li><div class="co-muted">另有 ${hidden} 条评论已被撤回或隐藏，仅保留占位。</div></li>`:''}</ol>${i.status==='published'?`<form class="co-comment-form" data-insight="${esc(id)}"><textarea class="co-comment-input" name="comment" rows="2" maxlength="${L.comment}" placeholder="回答这个问题，或指出它的前提问题…" aria-label="发现评论" required></textarea><button type="submit" class="co-btn primary">发布</button></form><div class="co-between" style="margin-top:10px"><button class="co-link" data-co="issue" data-id="${esc(id)}">对此节点有异议</button><span class="co-muted">一般学术分歧建议直接评论</span></div>`:'<p class="co-muted">待审核或已撤回的发现不开放新增评论。</p>'}`,
      `<button class="co-link" data-co="copy-link" data-id="${esc(id)}">复制发现链接</button><div class="co-row">${mine&&i.status==='published'?btn('撤回公开','withdraw','',`data-id="${id}"`):''}${mine&&i.status==='pending'?btn('撤回审核','recall','',`data-id="${id}"`):''}${btn('继续碰撞','detail-explore','primary',`data-qid="${i.questionId}"`)}</div>`,false,'detail');
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
    highlight(document.querySelector(`.AnswerItem[data-answer-id="${CSS.escape(ref.answerId)}"]`),n.quote);
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

  /* ---------- 事件 ---------- */
  document.addEventListener('click',async event=>{
    if(root.querySelector('.co-ball-menu')&&!event.target.closest('.co-ball-menu'))closeBallMenu();
    const el=event.target.closest('[data-co]');
    if(!el)return;
    event.preventDefault();
    const act=el.dataset.co,id=el.dataset.id,aid=el.dataset.aid,ref={answerId:aid,nodeId:el.dataset.nid};
    if(act==='close-modal')closeModal();
    else if(act==='select'||act==='select-answer'){if(dirty&&!confirm('进入选择模式会放弃未保存修改，继续吗？'))return;enterSelectMode(el.dataset.qid||aid?.split('-')[0],aid);}
    else if(act==='exit-select')exitSelectMode();
    else if(act==='toggle-pick')togglePick(aid);
    else if(act==='start-workbench')startWorkbench();
    else if(act==='close-workbench'){saveWorkspace();wb=null;pair=[];root.querySelector('.co-floating-stack')?.remove();decorate();}
    else if(act==='clear-pair'){pair=[];updatePair();}
    else if(act==='pair-node')pick(ref);
    else if(act==='node-source')showNodeSource(ref);
    else if(act==='locate')locate(ref);
    else if(act==='read-answer'){closeModal(true);jumpToAnswer(aid);}
    else if(act==='reader')jumpToAnswer(aid);
    else if(act==='reader-top')jumpToAnswer(wb?.reader);
    else if(act==='close-slot'){const slot=Number(el.dataset.slot);wb=core.assignSlot(wb,slot,null);pair=pair.filter(r=>wb.slots.includes(r.answerId));saveWorkspace();renderWorkbench();toast('已最小化为右下方的作者圆球。');}
    else if(act==='open-slot'){
      if(suppressBallClickId===aid){suppressBallClickId=null;return;}
      wb=core.assignSlot(wb,1,aid);pair=[];saveWorkspace();renderWorkbench();toast(`已用 ${answer(aid).author} 替换下方浮窗。`);
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
  root.addEventListener('dragstart',event=>{
    const ball=event.target.closest('.co-miniball');
    if(ball){draggedAnswerId=ball.dataset.aid;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',draggedAnswerId);ball.classList.add('is-dragging');return;}
    const el=event.target.closest('.co-node[draggable="true"]');
    if(!el)return;
    dragRef={answerId:el.dataset.aid,nodeId:el.dataset.node};
    event.dataTransfer.effectAllowed='copy';
    event.dataTransfer.setData('text/plain',core.keyOf(dragRef));
  });
  root.addEventListener('dragover',event=>{
    if(draggedAnswerId){const slot=event.target.closest('.co-float-window');if(slot){event.preventDefault();event.dataTransfer.dropEffect='move';slot.classList.add('is-ball-target');}return;}
    const el=event.target.closest('.co-node');
    if(!el||!dragRef)return;
    const ref={answerId:el.dataset.aid,nodeId:el.dataset.node};
    if(!core.validatePair(wb.questionId,[dragRef,ref],node)){event.preventDefault();event.dataTransfer.dropEffect='copy';el.classList.add('drop-target');}
  });
  root.addEventListener('dragleave',event=>{const slot=event.target.closest('.co-float-window');if(slot&&!slot.contains(event.relatedTarget))slot.classList.remove('is-ball-target');const el=event.target.closest('.co-node');if(el&&!el.contains(event.relatedTarget))el.classList.remove('drop-target');});
  root.addEventListener('drop',event=>{
    event.preventDefault();
    if(draggedAnswerId){const slot=event.target.closest('.co-float-window');root.querySelectorAll('.is-ball-target').forEach(e=>e.classList.remove('is-ball-target'));if(slot){wb=core.assignSlot(wb,Number(slot.dataset.slotIndex),draggedAnswerId);pair=[];saveWorkspace();renderWorkbench();toast(`已用 ${answer(draggedAnswerId).author} 替换这个浮窗。`);}draggedAnswerId=null;return;}
    const el=event.target.closest('.co-node');
    root.querySelectorAll('.drop-target').forEach(e=>e.classList.remove('drop-target'));
    if(!el||!dragRef)return;
    const refs=[dragRef,{answerId:el.dataset.aid,nodeId:el.dataset.node}];
    dragRef=null;
    const error=core.validatePair(wb.questionId,refs,node);
    if(error)return toast(error);
    collisionRefs=refs;showCollision();
  });
  root.addEventListener('dragend',()=>{dragRef=null;draggedAnswerId=null;root.querySelectorAll('.drop-target,.is-ball-target,.co-miniball.is-dragging').forEach(e=>e.classList.remove('drop-target','is-ball-target','is-dragging'));});
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
    const rect=viewport.getBoundingClientRect(),cx=event.clientX-rect.left,cy=event.clientY-rect.top,baseX=(viewport.clientWidth-300)/2;
    const worldX=(cx-baseX-view.x)/view.zoom,worldY=(cy-view.y)/view.zoom;
    view.x=cx-baseX-worldX*next;view.y=cy-worldY*next;view.zoom=next;
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
