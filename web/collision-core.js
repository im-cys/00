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
  function mergeAnswers(workspace,answerIds,maximum=5){
    const incoming=[...new Set((answerIds||[]).filter(Boolean))];
    const selected=[...new Set([...(workspace.selected||[]),...incoming])];
    if(selected.length>maximum)throw new Error(`一个工作区最多保留 ${maximum} 篇回答。`);
    const slots=[...(workspace.slots||[]),null,null].slice(0,2).map(id=>selected.includes(id)?id:null);
    for(const id of incoming){
      if(slots.includes(id))continue;
      const free=slots.indexOf(null);
      if(free<0)break;
      slots[free]=id;
    }
    const reader=selected.includes(workspace.reader)?workspace.reader:(selected[0]||null);
    return {...workspace,selected,slots,reader};
  }
  function preferredSlot(workspace){
    const free=(workspace.slots||[]).findIndex(id=>!id);
    return free>=0?free:1;
  }
  function validatePair(questionId,refs,lookup){
    if(refs.length!==2 || refs[0].answerId===refs[1].answerId)return '请选择两篇不同回答的节点。';
    for(const ref of refs){
      if(ref.answerId.split('-')[0]!==questionId)return '只能碰撞同一问题下的回答。';
      const node=lookup(ref);
      if(!node)return '节点不存在，请重新选择。';
      if(node.collidable!==true && node.kind!=='collision')return '请选择观点树最末层的可碰撞观点。';
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
  /* 语义层判定不在前端做。可碰撞判定由服务端 extractor/pair_screen.py 承担：
     它按「争议对象对齐 ∧ 适用条件有重叠 ∧ 主张方向可冲突」逐项检查结构化字段，
     零模型调用即可给出可解释的拒绝理由。前端只保留结构校验（validatePair），
     避免两套语义规则各自漂移。 */
  const api={keyOf,pairKey,transition,assignSlot,mergeAnswers,preferredSlot,validatePair,validateDraft,locateQuote,evidenceCheck,size,LIMITS};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  global.CollisionCore=api;
})(typeof window!=='undefined'?window:globalThis);
