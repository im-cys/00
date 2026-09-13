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
test('只接受同一问题、不同回答的两个观点',()=>{
  assert.equal(c.validatePair('10005',[a,b],()=>({type:'claim'})),null);
  assert.ok(c.validatePair('10005',[a,a],()=>({type:'claim'})));
  assert.ok(c.validatePair('10001',[a,b],()=>({type:'claim'})));
  assert.ok(c.validatePair('10005',[a,b],()=>({type:'fact'})));
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
test('讨论对象不同或证据不足时返回 no_result，不产生发现',()=>{
  const nodes={
    a:{text:'算法岗的面试越来越偏向工程能力',scope:null},
    b:{text:'算法岗的面试更看重工程落地经验',scope:null},
    far:{text:'周末带孩子去公园散步很放松',scope:null}
  };
  const lookup=ref=>nodes[ref.nodeId];
  assert.equal(c.evaluateCollision([{nodeId:'a'},{nodeId:'b'}],lookup,'contrast').outcome,'candidate');
  const off=c.evaluateCollision([{nodeId:'a'},{nodeId:'far'}],lookup,'contrast');
  assert.equal(off.outcome,'no_result');
  assert.equal(off.code,'different_subject');
  assert.equal(c.evaluateCollision([{nodeId:'a'},{nodeId:'missing'}],lookup,'contrast').code,'missing_node');
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
