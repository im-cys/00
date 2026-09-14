import cloudbase from '@cloudbase/node-sdk';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const iso = value => new Date(value).toISOString();
const rows = result => {
  if (result?.error) throw new Error(`数据库操作失败：${result.error.message || result.error}`);
  return Array.isArray(result?.data) ? result.data : result?.data ? [result.data] : [];
};
const toggleActions = new Set(['upvote', 'like', 'favorite']);

export function createCloudbaseStore(config) {
  const env = config.cloudbaseEnv || cloudbase.SYMBOL_CURRENT_ENV;
  const hasSecretPair = Boolean(config.cloudbaseSecretId && config.cloudbaseSecretKey);
  const app = cloudbase.init({
    env,
    timeout: 30000,
    ...(hasSecretPair ? { secretId: config.cloudbaseSecretId, secretKey: config.cloudbaseSecretKey } : {}),
    ...(!hasSecretPair && config.cloudbaseApiKey ? { accessKey: config.cloudbaseApiKey } : {})
  });
  // The Node SDK calls this option `database`, but sends it as PostgREST's
  // Accept-Profile/Content-Profile header. It therefore represents the
  // PostgreSQL schema (normally `public`), not the CloudBase environment ID.
  const db = app.rdb({
    instance: config.cloudbaseDatabaseInstance || 'default',
    database: config.cloudbaseDatabaseSchema || 'public'
  });

  async function upsert(table, value, onConflict) {
    rows(await db.from(table).upsert(value, { onConflict }));
  }

  async function ensureUser(user) {
    await upsert('app_users', {
      id: user.id, name: user.name, avatar: user.avatar || '', provider: user.provider || 'zhihu', updated_at: iso(Date.now())
    }, 'id');
  }

  async function session(token) {
    if (!token) return null;
    const item = rows(await db.from('app_sessions').select('user_id,expires_at').eq('token_hash', hash(token)).gt('expires_at', iso(Date.now())).limit(1))[0];
    const user = item ? rows(await db.from('app_users').select('id,name,avatar,provider').eq('id', item.user_id).limit(1))[0] : null;
    return user ? { id: String(user.id), name: user.name, avatar: user.avatar || '', provider: user.provider || 'zhihu' } : null;
  }

  async function createSession(user) {
    await ensureUser(user);
    const token = randomBytes(32).toString('base64url');
    rows(await db.from('app_sessions').insert({ token_hash: hash(token), user_id: user.id, expires_at: iso(Date.now() + 30 * 86400000) }));
    return token;
  }

  async function deleteSession(token) {
    if (token) rows(await db.from('app_sessions').delete().eq('token_hash', hash(token)));
  }

  async function saveOAuthState(state, browserNonce, returnTo) {
    rows(await db.from('oauth_states').insert({ state_hash: hash(state), browser_nonce_hash: hash(browserNonce), return_to: returnTo, expires_at: iso(Date.now() + 10 * 60000) }));
  }

  async function consumeOAuthState(state, browserNonce) {
    if (!state || !browserNonce) return null;
    const stateHash = hash(state);
    const found = rows(await db.from('oauth_states').select('return_to,expires_at,browser_nonce_hash').eq('state_hash', stateHash).limit(1));
    rows(await db.from('oauth_states').delete().eq('state_hash', stateHash));
    const item = found[0];
    if (!item || item.browser_nonce_hash !== hash(browserNonce) || new Date(item.expires_at).getTime() <= Date.now()) return null;
    return { returnTo: item.return_to };
  }

  async function getDataset() {
    return rows(await db.from('private_datasets').select('payload,content_hash').eq('id', 'main').limit(1))[0] || null;
  }

  async function importDataset(payload, contentHash) {
    await upsert('private_datasets', { id: 'main', payload, content_hash: contentHash, imported_at: iso(Date.now()) }, 'id');
    return { ok: true, contentHash };
  }

  async function getAnswerMaps(questionId) {
    const query = db.from('answer_maps').select('answer_id,payload');
    const found = rows(await (questionId ? query.eq('question_id', questionId) : query));
    return Object.fromEntries(found.map(item => [item.answer_id, item.payload]));
  }

  async function getAnswerMap(answerId) {
    return rows(await db.from('answer_maps').select('payload,source_hash,model,prompt_version').eq('answer_id', answerId).limit(1))[0] || null;
  }

  async function saveAnswerMap({ answerId, questionId, payload, sourceHash, model, promptVersion }) {
    await upsert('answer_maps', { answer_id: answerId, question_id: questionId, payload, source_hash: sourceHash, model, prompt_version: promptVersion, updated_at: iso(Date.now()) }, 'answer_id');
    return payload;
  }

  async function getCollisionCache(cacheKey) {
    return rows(await db.from('collision_cache').select('result').eq('cache_key', cacheKey).limit(1))[0]?.result || null;
  }

  async function saveCollisionCache({ cacheKey, questionId, answerIds, nodeIds, result, model, promptVersion }) {
    await upsert('collision_cache', { cache_key: cacheKey, question_id: questionId, answer_ids: answerIds, node_ids: nodeIds, result, model, prompt_version: promptVersion }, 'cache_key');
  }

  async function listDiscoveries(questionId = '') {
    let query = db.from('discoveries').select('id,payload,status,created_at').eq('status', 'published').order('created_at', { ascending: false });
    if (questionId) query = query.eq('question_id', questionId);
    const items = rows(await query).map(row => ({ ...row.payload, id: row.id, status: row.status }));
    const ids = items.map(item => item.id);
    if (!ids.length) return { items, comments: {} };
    const comments = rows(await db.from('discovery_comments').select('*').in('discovery_id', ids).eq('status', 'visible').order('created_at', { ascending: true }));
    return { items, comments: comments.reduce((all, item) => {
      (all[item.discovery_id] ||= []).push({ id: item.id, text: item.text, status: item.status, authorId: item.user_id, author: item.author, createdAt: new Date(item.created_at).getTime() });
      return all;
    }, {}) };
  }

  async function saveDiscovery(user, item) {
    await ensureUser(user);
    const duplicate = rows(await db.from('discoveries').select('id,payload').eq('pair_key', String(item.pairKey)).limit(1))[0];
    if (duplicate) return { ...duplicate.payload, id: duplicate.id };
    const id = String(item.id || randomUUID());
    const payload = { ...item, id, creatorId: user.id, author: user.name, status: 'published' };
    rows(await db.from('discoveries').insert({ id, pair_key: String(item.pairKey), question_id: String(item.questionId), creator_id: user.id, author: user.name, payload, status: 'published', updated_at: iso(Date.now()) }));
    return payload;
  }

  async function commentDiscovery(user, discoveryId, text) {
    await ensureUser(user);
    const content = String(text || '').trim();
    if (!content || content.length > 500) throw new Error('评论需为 1–500 个字符。');
    const item = { id: randomUUID(), discovery_id: discoveryId, user_id: user.id, author: user.name, text: content, status: 'visible' };
    rows(await db.from('discovery_comments').insert(item));
    return { id: item.id, text: content, status: 'visible', authorId: user.id, author: user.name, createdAt: Date.now() };
  }

  async function updateDiscoveryStatus(user, discoveryId, status) {
    if (status !== 'withdrawn') throw new Error('不支持的状态。');
    const found = rows(await db.from('discoveries').select('creator_id').eq('id', discoveryId).limit(1))[0];
    if (!found || found.creator_id !== user.id) throw new Error('无权撤回这条发现。');
    rows(await db.from('discoveries').update({ status, updated_at: iso(Date.now()) }).eq('id', discoveryId));
    return { id: discoveryId, status };
  }

  async function withdrawDiscoveryComment(user, discoveryId, commentId) {
    const found = rows(await db.from('discovery_comments').select('user_id').eq('id', commentId).eq('discovery_id', discoveryId).limit(1))[0];
    if (!found || found.user_id !== user.id) throw new Error('无权撤回这条评论。');
    rows(await db.from('discovery_comments').update({ status: 'withdrawn' }).eq('id', commentId));
    return { id: commentId, status: 'withdrawn' };
  }

  async function act(user, { questionId, answerId, action }) {
    await ensureUser(user);
    if (!/^\d{5}$/.test(questionId) || !/^\d{5}-\d{2}$/.test(answerId)) throw new Error('回答编号无效。');
    if (action === 'map') rows(await db.from('answer_map_events').insert({ id: randomUUID(), answer_id: answerId, question_id: questionId, user_id: user.id }));
    else if (toggleActions.has(action)) {
      const existing = rows(await db.from('answer_actions').select('answer_id').eq('answer_id', answerId).eq('user_id', user.id).eq('action', action).limit(1));
      if (existing.length) rows(await db.from('answer_actions').delete().eq('answer_id', answerId).eq('user_id', user.id).eq('action', action));
      else rows(await db.from('answer_actions').insert({ answer_id: answerId, question_id: questionId, user_id: user.id, action }));
    } else throw new Error('不支持的互动类型。');
    return snapshot(user.id);
  }

  async function comment(user, { questionId, answerId, text }) {
    await ensureUser(user);
    const content = String(text || '').trim();
    if (!/^\d{5}$/.test(questionId) || !/^\d{5}-\d{2}$/.test(answerId)) throw new Error('回答编号无效。');
    if (!content || content.length > 500) throw new Error('评论需为 1–500 个字符。');
    rows(await db.from('answer_comments').insert({ id: randomUUID(), answer_id: answerId, question_id: questionId, user_id: user.id, author: user.name, avatar: user.avatar || '', text: content }));
    return snapshot(user.id);
  }

  async function snapshot(userId = '') {
    const [actions, events, comments] = await Promise.all([
      db.from('answer_actions').select('*'), db.from('answer_map_events').select('*'), db.from('answer_comments').select('*').order('created_at', { ascending: true })
    ]).then(results => results.map(rows));
    const answers = {}, questions = {};
    const entry = answerId => answers[answerId] ||= { upvotes: 0, likes: 0, favorites: 0, mapGenerations: 0, comments: 0, recentComments: [], mine: { upvote: false, like: false, favorite: false } };
    for (const action of actions) { const a = entry(action.answer_id); a[`${action.action}s`]++; if (action.user_id === userId) a.mine[action.action] = true; }
    for (const event of events) entry(event.answer_id).mapGenerations++;
    for (const comment of comments) { const a = entry(comment.answer_id); a.comments++; a.recentComments.push({ id: comment.id, userId: comment.user_id, author: comment.author, avatar: comment.avatar, text: comment.text, at: new Date(comment.created_at).getTime() }); a.recentComments = a.recentComments.slice(-20); }
    for (const [answerId, a] of Object.entries(answers)) { const q = questions[answerId.split('-')[0]] ||= { likes: 0, favorites: 0, comments: 0, mapGenerations: 0, heat: 0 }; q.likes += a.likes; q.favorites += a.favorites; q.comments += a.comments; q.mapGenerations += a.mapGenerations; q.heat = q.likes + q.favorites + q.comments + q.mapGenerations; }
    return { answers, questions };
  }

  return { session, createSession, deleteSession, saveOAuthState, consumeOAuthState, getDataset, importDataset, getAnswerMaps, getAnswerMap, saveAnswerMap, getCollisionCache, saveCollisionCache, listDiscoveries, saveDiscovery, commentDiscovery, updateDiscoveryStatus, withdrawDiscoveryComment, act, comment, snapshot };
}
