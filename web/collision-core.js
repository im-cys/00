(function(global){
  'use strict';
  const keyOf = ref => `${ref.answerId}:${ref.nodeId}`;
  const pairKey = (questionId,refs,action) => `${questionId}|${action}|${refs.map(keyOf).sort().join('|')}`;
  const allowed = {draft:['pending','discarded'],returned:['draft','pending','discarded'],pending:['draft','published','returned'],published:['withdrawn','hidden'],withdrawn:[],hidden:[],discarded:[]};
  const LIMITS = {title:80,titleAdvice:[15,60],rationaleMin:20,rationaleMax:400,limitations:200,comment:500,issue:500,answers:6};
  const size = value => [...String(value ?? '')].length;
  function transition(item,next,revision){
    if(!allowed[item.status]?.includes(next))throw new Error('这条发现的状态已变化，请重新打开。');
    if(next==='published' && revision!==item.revision)throw new Error('待审核版本已变化。');
    return {...item,status:next,updatedAt:Date.now(),...(next==='published'?{publishedAt:item.publishedAt||Date.now(),lastPublishedAt:Date.now(),publishedRevision:item.revision}:{})};
  }
  function assignSlot(workspace,index,answerId){
    if(answerId && !workspace.selected.includes(answerId))throw new Error('请先加入这篇回答。');
    const slots=[...workspace.slots];
    const other=1-index;
    if(answerId && slots[other]===answerId)slots[other]=slots[index];
    slots[index]=answerId||null;
    return {...workspace,slots};
  }
  function validatePair(questionId,refs,lookup){
    if(refs.length!==2 || refs[0].answerId===refs[1].answerId)return '请选择两篇不同回答的节点。';
    for(const ref of refs){
      if(ref.answerId.split('-')[0]!==questionId)return '只能碰撞同一问题下的回答。';
      const node=lookup(ref);
      if(!node)return '节点不存在，请重新选择。';
      if(node.type!=='claim')return '本版先支持两个观点节点碰撞，其他类型可查看原文。';
    }
    return null;
  }
  function validateDraft(fields){
    const title=size(fields.title), rationale=size(fields.rationale), limitations=size(fields.limitations);
    if(!title)return '请填写发现标题。';
    if(title>LIMITS.title)return `标题最多 ${LIMITS.title} 字，当前 ${title} 字。请改写成完整的一句话，而不是截断。`;
    if(rationale<LIMITS.rationaleMin)return `推导与解释至少 ${LIMITS.rationaleMin} 字，当前 ${rationale} 字。`;
    if(rationale>LIMITS.rationaleMax)return `推导与解释最多 ${LIMITS.rationaleMax} 字，当前 ${rationale} 字。`;
    if(limitations>LIMITS.limitations)return `适用条件与局限最多 ${LIMITS.limitations} 字，当前 ${limitations} 字。`;
    return null;
  }
  const squeeze = value => String(value ?? '').replace(/[\s\u200b\u00a0]/g,'');
  const loosen = value => squeeze(value).replace(/[，。、；：！？,.;:!?"'“”‘’（）()【】\[\]…—\-～~]/g,'');
  function findSegment(segment,list){
    const target=squeeze(segment);
    if(target.length<4)return null;
    let index=list.findIndex(text=>squeeze(text).includes(target));
    if(index>=0)return {index,method:'exact'};
    const loose=loosen(segment);
    if(loose.length<4)return null;
    index=list.findIndex(text=>loosen(text).includes(loose));
    return index>=0?{index,method:'normalized'}:null;
  }
  /* 抽取产物中的 quote 可能跨越多个段落（以换行连接），也可能被旧流程截到 80 字。
     按段落切分逐段定位：全部命中记 exact/normalized，仅首段命中记 partial，
     其余情况返回 null，不做模糊凑合。 */
  function locateQuote(quote,paragraphs){
    if(!Array.isArray(paragraphs))return null;
    const list=paragraphs.map(text=>String(text ?? ''));
    const segments=String(quote ?? '').split(/\n+/).map(part=>part.trim()).filter(part=>squeeze(part).length>=4);
    if(!segments.length)return null;
    const head=findSegment(segments[0],list);
    if(!head)return null;
    if(segments.length===1)return head;
    let method=head.method, cursor=head.index, complete=true;
    for(const segment of segments.slice(1)){
      const next=findSegment(segment,list.slice(cursor+1));
      if(!next){complete=false;break;}
      if(next.method==='normalized')method='normalized';
      cursor+=1+next.index;
    }
    return {index:head.index,method:complete?method:'partial'};
  }
  function evidenceCheck(refs,nodeOf,paragraphsOf){
    const details=refs.map((ref,order)=>{
      const node=nodeOf(ref), quote=node?.quote||'';
      const hit=quote?locateQuote(quote,paragraphsOf(ref.answerId)):null;
      return {label:order?'B':'A',answerId:ref.answerId,hasQuote:Boolean(quote),found:Boolean(hit),method:hit?hit.method:null,paragraph:hit?hit.index:null};
    });
    return {eligibility:details.every(item=>item.found)?'eligible':'needs_evidence',details};
  }
  const stopGrams = new Set(['因为','所以','我们','他们','一个','这个','那个','可以','不是','就是','非常','其实','已经','如果','但是','而且','这样','那样','的话','时候','东西','方面','情况','自己','没有','还是','什么','怎么','这些','那些','之后','之前','一样','觉得','认为','应该','需要','真的','很多','一些','出来','起来','下去','而是','只是','因此','以及','或者','然后','当然','其中']);
  function terms(text){
    const source=String(text ?? '').toLowerCase();
    const found=new Set();
    for(const word of source.match(/[a-z][a-z0-9+#._-]*/g)||[])if(word.length>1)found.add(word);
    for(const run of source.replace(/[^\u3400-\u9fff]+/g,' ').split(' ').filter(Boolean))
      for(let at=0;at+2<=run.length;at+=1){const gram=run.slice(at,at+2);if(!stopGrams.has(gram))found.add(gram);}
    return found;
  }
  function sharedTerms(left,right){const both=[];for(const term of left)if(right.has(term))both.push(term);return both;}
  function evaluateCollision(refs,nodeOf,action){
    const nodes=refs.map(nodeOf);
    if(nodes.some(node=>!node))return {outcome:'no_result',code:'missing_node',message:'节点已不可用，请重新选择两个观点。',shared:[]};
    const shared=sharedTerms(terms(`${nodes[0].text} ${nodes[0].scope||''}`),terms(`${nodes[1].text} ${nodes[1].scope||''}`));
    if(shared.length<2)return {outcome:'no_result',code:'different_subject',message:'这两个节点几乎没有共同的讨论对象，本地规则给不出可靠的比较起点。可以换一组更贴近的节点，或先读两边原文。',shared};
    if(action==='synthesize'&&shared.length<3)return {outcome:'no_result',code:'insufficient_evidence',message:'两句话的共同点太少，把它们拼成一条综合判断会超出原文能支持的范围。可以先试“对比差异”，或选择更具体的节点。',shared};
    return {outcome:'candidate',code:null,message:'',shared};
  }
  const api={keyOf,pairKey,transition,assignSlot,validatePair,validateDraft,locateQuote,evidenceCheck,evaluateCollision,terms,size,LIMITS};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  global.CollisionCore=api;
})(typeof window!=='undefined'?window:globalThis);
