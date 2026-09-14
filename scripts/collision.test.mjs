import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import '../web/collision-core.js';
const c=globalThis.CollisionCore;
const a={answerId:'10005-01',nodeId:'a'},b={answerId:'10005-02',nodeId:'b'};
test('同一组节点的碰撞与方向无关，动作不同则不同',()=>{
  assert.equal(c.pairKey('10005',[a,b],'contrast'),c.pairKey('10005',[b,a],'contrast'));
  assert.notEqual(c.pairKey('10005',[a,b],'contrast'),c.pairKey('10005',[a,b],'synthesize'));
});
test('只接受同一问题、不同回答的两个可碰撞叶子',()=>{
  assert.equal(c.validatePair('10005',[a,b],()=>({kind:'collision',collidable:true})),null);
  assert.ok(c.validatePair('10005',[a,a],()=>({kind:'collision',collidable:true})));
  assert.ok(c.validatePair('10001',[a,b],()=>({kind:'collision',collidable:true})));
  assert.ok(c.validatePair('10005',[a,b],()=>({kind:'branch',collidable:false})));
  assert.ok(c.validatePair('10005',[a,b],()=>null));
});
test('切换已经展开的回答时互换槽位，不产生重复图',()=>{
  const w={selected:['a','b','c'],slots:['a','b']};
  assert.deepEqual(c.assignSlot(w,0,'b').slots,['b','a']);
  assert.deepEqual(c.assignSlot(w,1,'c').slots,['a','c']);
  assert.deepEqual(c.assignSlot(w,1,null).slots,['a',null]);
  assert.deepEqual(w.slots,['a','b']);
  assert.throws(()=>c.assignSlot(w,0,'unknown'));
});
test('新增回答合并进工作区：先填空槽，满槽后留在最小化区',()=>{
  const first=c.mergeAnswers({selected:['a'],slots:['a',null],reader:'a'},['b'],5);
  assert.deepEqual(first.selected,['a','b']);
  assert.deepEqual(first.slots,['a','b']);
  const full=c.mergeAnswers(first,['c'],5);
  assert.deepEqual(full.selected,['a','b','c']);
  assert.deepEqual(full.slots,['a','b']);
  assert.equal(c.preferredSlot(full),1);
  const minimized=c.assignSlot(full,0,null);
  assert.equal(c.preferredSlot(minimized),0);
  assert.throws(()=>c.mergeAnswers(full,['c','d','e','f'],5));
});
test('草稿不能跳过审核公开，审核必须对应同一版本',()=>{
  const draft={status:'draft',revision:3};
  assert.throws(()=>c.transition(draft,'published',3));
  const pending=c.transition(draft,'pending');
  assert.throws(()=>c.transition(pending,'published',2));
  const published=c.transition(pending,'published',3);
  assert.equal(published.publishedRevision,3);
  assert.equal(c.transition(published,'withdrawn').status,'withdrawn');
  assert.throws(()=>c.transition(published,'draft'));
  assert.equal(draft.status,'draft');
});
test('退回修改、撤回待审和重新提交',()=>{
  const pending={status:'pending',revision:2};
  assert.equal(c.transition(pending,'draft').status,'draft');
  const returned=c.transition(pending,'returned');
  assert.equal(c.transition(returned,'pending').status,'pending');
  assert.equal(c.transition(returned,'draft').status,'draft');
});
test('审核员可下架已公开内容，终态不能再流转',()=>{
  const published={status:'published',revision:1,publishedAt:1};
  const hidden=c.transition(published,'hidden');
  assert.equal(hidden.status,'hidden');
  assert.throws(()=>c.transition(hidden,'published',1));
  assert.throws(()=>c.transition({status:'withdrawn'},'published',1));
  assert.throws(()=>c.transition({status:'discarded'},'draft'));
});
test('首次公开时间在再次发布时保留，另记最近发布时间',()=>{
  const first=c.transition({status:'pending',revision:1},'published',1);
  const again=c.transition({...first,status:'pending',revision:2},'published',2);
  assert.equal(again.publishedAt,first.publishedAt);
  assert.ok(again.lastPublishedAt>=first.publishedAt);
});
test('草稿字段按 Unicode 字符计数校验，不做静默截断',()=>{
  const ok={title:'比较岗位前需要区分入门机会与长期上限',rationale:'甲'.repeat(30),limitations:''};
  assert.equal(c.validateDraft(ok),null);
  assert.ok(c.validateDraft({...ok,title:''}));
  assert.ok(c.validateDraft({...ok,title:'甲'.repeat(81)}));
  assert.equal(c.validateDraft({...ok,title:'甲'.repeat(80)}),null);
  assert.ok(c.validateDraft({...ok,rationale:'甲'.repeat(19)}));
  assert.ok(c.validateDraft({...ok,rationale:'甲'.repeat(401)}));
  assert.ok(c.validateDraft({...ok,limitations:'甲'.repeat(201)}));
  assert.equal(c.size('👩‍🦰'.slice(0,2)+'字'),2);
  assert.equal(c.validateDraft({...ok,title:'😀'.repeat(80)}),null);
  assert.ok(c.validateDraft({...ok,title:'😀'.repeat(81)}));
});
test('引用定位命中原段落，跨段与差异情况有明确降级',()=>{
  const paragraphs=['前面一段无关内容。','面试最大的感受就是现在的算法岗越来越偏向于工程了。','中间一段。','然后是第二段引用内容。','结尾。'];
  assert.deepEqual(c.locateQuote('面试最大的感受就是现在的算法岗越来越偏向于工程了。',paragraphs),{index:1,method:'exact'});
  assert.equal(c.locateQuote('面试最大的感受就是现在的算法岗越来越偏向于工程了',paragraphs).method,'exact');
  assert.equal(c.locateQuote('面试最大的感受，就是现在的算法岗越来越偏向于工程了',paragraphs).method,'normalized');
  // 抽取产物里的 quote 可能跨段落，用换行连接
  assert.deepEqual(c.locateQuote('面试最大的感受就是现在的算法岗越来越偏向于工程了。\n然后是第二段引用内容。',paragraphs),{index:1,method:'exact'});
  // 第二段找不到时只认首段命中，并标记 partial，不假装完整命中
  assert.deepEqual(c.locateQuote('面试最大的感受就是现在的算法岗越来越偏向于工程了。\n这句话原文里没有出现过。',paragraphs),{index:1,method:'partial'});
  assert.equal(c.locateQuote('完全没有出现过的句子内容',paragraphs),null);
  assert.equal(c.locateQuote('短',paragraphs),null);
  assert.equal(c.locateQuote('任意引用',null),null);
  assert.equal(c.locateQuote(null,paragraphs),null);
});
test('两侧证据齐备才 eligible，缺引用即 needs_evidence',()=>{
  const paras={'10005-01':['甲说这条路更容易入行。'],'10005-02':['乙说这条路上限更高。']};
  const nodes={a:{quote:'甲说这条路更容易入行。'},b:{quote:'乙说这条路上限更高。'},none:{quote:null}};
  const lookup=ref=>nodes[ref.nodeId];
  const paragraphsOf=id=>paras[id];
  assert.equal(c.evidenceCheck([a,b],lookup,paragraphsOf).eligibility,'eligible');
  const missing=c.evidenceCheck([a,{answerId:'10005-02',nodeId:'none'}],lookup,paragraphsOf);
  assert.equal(missing.eligibility,'needs_evidence');
  assert.equal(missing.details[1].found,false);
  assert.equal(missing.details[0].method,'exact');
});
test('前端只做结构校验，不再重复实现语义层判定',()=>{
  // 语义判定已移到服务端 extractor/pair_screen.py（覆盖用例见 test_pair_screen.py）。
  // 这里确认前端不再导出那套词重叠规则，避免两套语义标准并存又互相漂移。
  assert.equal(c.evaluateCollision,undefined);
  assert.equal(c.terms,undefined);
  assert.equal(typeof c.validatePair,'function');
  assert.equal(typeof c.evidenceCheck,'function');
});
test('Git 跟踪的回退数据不包含摘录正文和预生成节点',()=>{
  const context={window:{}};
  runInNewContext(readFileSync(new URL('../web/data.empty.js',import.meta.url),'utf8'),context);
  runInNewContext(readFileSync(new URL('../web/collision-maps.empty.js',import.meta.url),'utf8'),context);
  assert.equal(JSON.stringify(context.window.ZHIHU_DEMO_DATA),'{"questions":[]}');
  assert.equal(JSON.stringify(context.window.COLLISION_MAPS),'{}');
});
test('回答浮窗支持关闭，最小化圆球支持右键删除菜单',()=>{
  const source=readFileSync(new URL('../web/collision.js',import.meta.url),'utf8');
  assert.match(source,/co-close-answer/);
  assert.match(source,/data-co="remove-answer"/);
  assert.match(source,/addEventListener\('contextmenu'/);
  assert.match(source,/删除窗口/);
});
test('生成过程不暴露复用策略或底层 HTML 解析错误',()=>{
  const source=readFileSync(new URL('../web/collision.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/已有结果会直接复用/);
  assert.doesNotMatch(source,/结构图来自已保存的抽取结果/);
  assert.match(source,/async function apiJson/);
  assert.match(source,/生成服务响应超时/);
});
test('点击生成会立即打开可最小化的加载浮窗，并在浮窗内承接失败',()=>{
  const source=readFileSync(new URL('../web/collision.js',import.meta.url),'utf8');
  assert.match(source,/btn\('点击生成','start-workbench'/);
  assert.doesNotMatch(source,/打开节点浮窗 →/);
  assert.doesNotMatch(source,/选择后只能阅读原文，不能参与碰撞/);
  assert.match(source,/mapGeneration\.set\(id,\{status:'processing'/);
  assert.match(source,/saveWorkspace\(\);decorate\(\);renderWorkbench\(\)/);
  assert.match(source,/missing\.forEach\(id=>void runMapGeneration\(id\)\)/);
  assert.match(source,/co-generation-state is-failed/);
  assert.match(source,/可以最小化浮窗，生成会在后台继续/);
  assert.match(source,/data-co="close-slot"/);
});
test('文章结构显示短观点，单击看详情、双击回原文，只有末层可拖拽碰撞',()=>{
  const source=readFileSync(new URL('../web/collision.js',import.meta.url),'utf8');
  const nodeDetail=source.slice(source.indexOf('function showTreeNodeDetail'),source.indexOf('function showCollision'));
  assert.match(source,/function treeGraphHtml/);
  assert.match(source,/co-tree-network/);
  assert.match(source,/nodeDisplayText/);
  assert.match(source,/thesis\?nodeDisplayText\(thesis\)/);
  assert.match(source,/data-co="node-detail"/);
  assert.match(source,/function showTreeNodeDetail/);
  assert.match(source,/addEventListener\('dblclick'/);
  assert.match(source,/单击节点看详情 · 双击定位原文/);
  assert.match(source,/可碰撞观点/);
  assert.match(source,/nodeQuote/);
  assert.match(nodeDetail,/观点解释/);
  assert.match(nodeDetail,/isCollidable\(n\)&&explanation/);
  assert.doesNotMatch(nodeDetail,/<h3>完整观点<\/h3>/);
  assert.match(nodeDetail,/原文依据/);
  assert.doesNotMatch(nodeDetail,/<h3>(节点作用|论证摘要|所在结构)<\/h3>/);
  assert.match(source,/fitX/);
  assert.match(source,/结构数据不兼容/);
  assert.doesNotMatch(source,/也可以逐个点选配对/);
  assert.doesNotMatch(source,/function nodeCard/);
  assert.doesNotMatch(source,/classList\.contains\('is-tree'\)/);
});

test('碰撞新节点详情以作者来源、AI 分析和深入问题为主',()=>{
  const source=readFileSync(new URL('../web/collision.js',import.meta.url),'utf8');
  const detail=source.slice(source.indexOf('function showDetail'),source.indexOf('function showPublicList'));
  assert.match(detail,/来自 \$\{sourceNames\.join\(' 与 '\)\} 的回答/);
  assert.match(detail,/co-collision-analysis/);
  assert.match(detail,/AI 分析/);
  assert.match(detail,/由此提出的深入问题/);
  assert.doesNotMatch(detail,/sourceCards\(|aiEvidence|whoCanAnswer|从这两个回答出发|复制发现链接|继续碰撞/);
});

test('问题页展开的新节点也不重复展示来源节点',()=>{
  const source=readFileSync(new URL('../web/collision.js',import.meta.url),'utf8');
  const detail=source.slice(source.indexOf('function inlineDiscoveryDetail'),source.indexOf('function inlineDiscoveryItem'));
  assert.match(detail,/co-inline-analysis/);
  assert.doesNotMatch(detail,/co-inline-nodes|节点 A|节点 B|两个来源共用/);
});

test('展开区用问题详情说明代替重复的问题标题',()=>{
  // 外层 summary 已经显示过问题标题，展开里再重复一次没有信息量，
  // 因此这里放「关于这个问题」的详情说明；旧数据缺该字段时才降级回标题。
  const source=readFileSync(new URL('../web/collision.js',import.meta.url),'utf8');
  const detail=source.slice(source.indexOf('function inlineDiscoveryDetail'),source.indexOf('function inlineDiscoveryItem'));
  assert.match(detail,/关于这个问题/);
  assert.match(detail,/questionDetailHtml\(item,'co-inline-question-detail'\)/);
  assert.doesNotMatch(detail,/由此提出的深入问题/);
});

test('详情页在问题标题下给出问题详情说明',()=>{
  const source=readFileSync(new URL('../web/collision.js',import.meta.url),'utf8');
  const detail=source.slice(source.indexOf('function showDetail'),source.indexOf('function showPublicList'));
  assert.match(detail,/由此提出的深入问题/);
  assert.match(detail,/questionDetailHtml\(i,'co-question-detail'\)/);
});

test('问题详情说明缺失时不调模型，用已有字段生成兼容说明',()=>{
  const source=readFileSync(new URL('../web/collision.js',import.meta.url),'utf8');
  const helper=source.slice(source.indexOf('function questionDetailHtml'),source.indexOf('function showDetail'));
  assert.match(helper,/item\?\.whoCanAnswer/);
  assert.match(helper,/这个问题具体落在\$\{audience\}身上/);
  assert.doesNotMatch(helper,/if\(!text\)return ''/);
});
test('首页与问题页用每日碰撞次数替代直答，首次登录说明突出失败也计次',()=>{
  const home=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
  const question=readFileSync(new URL('../web/question.html',import.meta.url),'utf8');
  const site=readFileSync(new URL('../web/site.js',import.meta.url),'utf8');
  const collision=readFileSync(new URL('../web/collision.js',import.meta.url),'utf8');
  for(const page of [home,question]){
    assert.match(page,/id="collisionQuota"/);
    assert.doesNotMatch(page,/class="zhida"|>.*直答.*<\/button>/);
  }
  assert.match(site,/刘看山把两张观点卡碰撞成新问题/);
  assert.match(site,/失败、无结果、缓存命中也计入总次数/);
  assert.match(site,/collision-onboarding-v1/);
  assert.doesNotMatch(collision,/querySelector\('\.zhida'\)/);
});
