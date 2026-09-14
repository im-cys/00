import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { root } from './config.mjs';

const emptyDatabase = () => ({ version: 3, sessions: {}, oauthStates: {}, answers: {}, dataset: null, maps: {}, collisionCache: {}, discoveries: {}, discoveryComments: {} });
const toggleActions = new Set(['upvote', 'like', 'favorite']);

export function createCommunityStore(filePath = resolve(root, 'runtime', 'community.json')) {
  let queue = Promise.resolve();

  async function read() {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      return { ...emptyDatabase(), ...parsed, sessions: parsed.sessions || {}, oauthStates: parsed.oauthStates || {}, answers: parsed.answers || {}, maps: parsed.maps || {}, collisionCache: parsed.collisionCache || {}, discoveries: parsed.discoveries || {}, discoveryComments: parsed.discoveryComments || {} };
    } catch (error) {
      if (error.code === 'ENOENT') return emptyDatabase();
      throw error;
    }
  }

  async function write(database) {
    await mkdir(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(database, null, 2), 'utf8');
    await rename(temporary, filePath);
  }

  function mutate(operation) {
    const task = queue.then(async () => {
      const database = await read();
      const result = await operation(database);
      await write(database);
      return result;
    });
    queue = task.catch(() => {});
    return task;
  }

  const entryFor = (database, answerId) => database.answers[answerId] ||= {
    upvotes: {}, likes: {}, favorites: {}, mapEvents: [], comments: []
  };

  async function session(token) {
    if (!token) return null;
    const database = await read();
    const item = database.sessions[token];
    const expiresAt = item?.expiresAt || (Number(item?.createdAt) + 30 * 86400000);
    return item?.user && expiresAt > Date.now() ? item.user : null;
  }

  async function createSession(user) {
    const token = randomUUID();
    await mutate(database => {
      database.sessions[token] = { user, createdAt: Date.now(), expiresAt: Date.now() + 30 * 86400000 };
    });
    return token;
  }

  async function deleteSession(token) {
    if (!token) return;
    await mutate(database => { delete database.sessions[token]; });
  }

  async function saveOAuthState(state, browserNonce, returnTo) {
    await mutate(database => { database.oauthStates[state] = { browserNonce, returnTo, expiresAt: Date.now() + 10 * 60000 }; });
  }

  async function consumeOAuthState(state, browserNonce) {
    return mutate(database => {
      const item = database.oauthStates[state];
      delete database.oauthStates[state];
      return item && item.browserNonce === browserNonce && item.expiresAt > Date.now() ? { returnTo: item.returnTo } : null;
    });
  }

  async function getDataset() { return (await read()).dataset; }
  async function importDataset(payload, contentHash) {
    await mutate(database => { database.dataset = { payload, contentHash, importedAt: Date.now() }; });
    return { ok: true, contentHash };
  }
  async function getAnswerMaps(questionId = '') {
    const database = await read();
    return Object.fromEntries(Object.entries(database.maps).filter(([, item]) => !questionId || item.questionId === questionId).map(([id, item]) => [id, item.payload]));
  }
  async function getAnswerMap(answerId) { return (await read()).maps[answerId] || null; }
  async function saveAnswerMap(item) {
    await mutate(database => { database.maps[item.answerId] = { ...item, updatedAt: Date.now() }; });
    return item.payload;
  }
  async function pruneAnswerMaps(schemaVersion, promptVersion = '') {
    return mutate(database => {
      let removed = 0;
      const dropped = new Set();
      for (const [answerId, item] of Object.entries(database.maps)) {
        const actual = item?.payload?.schemaVersion || item?.payload?.schema_version || '';
        const actualPrompt = item?.promptVersion || item?.prompt_version || '';
        if (actual === schemaVersion && (!promptVersion || actualPrompt === promptVersion)) continue;
        delete database.maps[answerId];
        dropped.add(answerId);
        removed++;
      }
      // 只清理引用了被删结构图的缓存条目，不整表清空（理由见 cloudbase-store 同名函数）。
      if (removed) {
        for (const [cacheKey, entry] of Object.entries(database.collisionCache)) {
          const ids = Array.isArray(entry?.answerIds) ? entry.answerIds : [];
          if (ids.length && ids.some(id => dropped.has(id))) delete database.collisionCache[cacheKey];
        }
      }
      return removed;
    });
  }
  async function getCollisionCache(cacheKey) { return (await read()).collisionCache[cacheKey]?.result || null; }
  async function saveCollisionCache(item) { await mutate(database => { database.collisionCache[item.cacheKey] = { ...item, createdAt: Date.now() }; }); }
  async function listDiscoveries(questionId = '') {
    const database = await read();
    const items = Object.values(database.discoveries).filter(item => item.status === 'published' && (!questionId || item.questionId === questionId)).sort((a, b) => b.createdAt - a.createdAt);
    const ids = new Set(items.map(item => item.id));
    return { items, comments: Object.fromEntries(Object.entries(database.discoveryComments).filter(([id]) => ids.has(id))) };
  }
  async function saveDiscovery(user, item) {
    return mutate(database => {
      const duplicate = Object.values(database.discoveries).find(value => value.pairKey === item.pairKey);
      if (duplicate) return duplicate;
      const saved = { ...item, id: String(item.id || randomUUID()), creatorId: user.id, author: user.name, status: 'published', createdAt: Number(item.createdAt) || Date.now() };
      database.discoveries[saved.id] = saved;
      return saved;
    });
  }
  async function commentDiscovery(user, discoveryId, text) {
    const content = String(text || '').trim();
    if (!content || content.length > 500) throw new Error('评论需为 1–500 个字符。');
    return mutate(database => {
      if (!database.discoveries[discoveryId] || database.discoveries[discoveryId].status !== 'published') throw new Error('发现不存在或不可评论。');
      const item = { id: randomUUID(), text: content, status: 'visible', authorId: user.id, author: user.name, createdAt: Date.now() };
      (database.discoveryComments[discoveryId] ||= []).push(item);
      return item;
    });
  }
  async function updateDiscoveryStatus(user, discoveryId, status) {
    if (status !== 'withdrawn') throw new Error('不支持的状态。');
    return mutate(database => {
      const item = database.discoveries[discoveryId];
      if (!item || item.creatorId !== user.id) throw new Error('无权撤回这条发现。');
      item.status = status; item.updatedAt = Date.now();
      return item;
    });
  }
  async function withdrawDiscoveryComment(user, discoveryId, commentId) {
    return mutate(database => {
      const item = (database.discoveryComments[discoveryId] || []).find(comment => comment.id === commentId);
      if (!item || item.authorId !== user.id) throw new Error('无权撤回这条评论。');
      item.status = 'withdrawn'; item.moderatedAt = Date.now();
      return item;
    });
  }

  async function act(user, { questionId, answerId, action }) {
    if (!/^\d{5}$/.test(questionId) || !/^\d{5}-\d{2}$/.test(answerId)) throw new Error('回答编号无效。');
    if (!toggleActions.has(action) && action !== 'map') throw new Error('不支持的互动类型。');
    return mutate(database => {
      const entry = entryFor(database, answerId);
      if (action === 'map') entry.mapEvents.push({ userId: user.id, at: Date.now() });
      else if (entry[`${action}s`][user.id]) delete entry[`${action}s`][user.id];
      else entry[`${action}s`][user.id] = Date.now();
      return snapshotFrom(database, user.id);
    });
  }

  async function comment(user, { questionId, answerId, text }) {
    if (!/^\d{5}$/.test(questionId) || !/^\d{5}-\d{2}$/.test(answerId)) throw new Error('回答编号无效。');
    const content = String(text || '').trim();
    if (!content || content.length > 500) throw new Error('评论需为 1–500 个字符。');
    return mutate(database => {
      const entry = entryFor(database, answerId);
      entry.comments.push({ id: randomUUID(), userId: user.id, author: user.name, avatar: user.avatar || '', text: content, at: Date.now() });
      return snapshotFrom(database, user.id);
    });
  }

  function snapshotFrom(database, userId = '') {
    const answers = {};
    const questions = {};
    for (const [answerId, entry] of Object.entries(database.answers)) {
      const questionId = answerId.split('-')[0];
      const stats = {
        upvotes: Object.keys(entry.upvotes || {}).length,
        likes: Object.keys(entry.likes || {}).length,
        favorites: Object.keys(entry.favorites || {}).length,
        mapGenerations: (entry.mapEvents || []).length,
        comments: (entry.comments || []).length,
        recentComments: (entry.comments || []).slice(-20),
        mine: {
          upvote: Boolean(entry.upvotes?.[userId]),
          like: Boolean(entry.likes?.[userId]),
          favorite: Boolean(entry.favorites?.[userId])
        }
      };
      answers[answerId] = stats;
      const question = questions[questionId] ||= { likes: 0, favorites: 0, comments: 0, mapGenerations: 0, heat: 0 };
      question.likes += stats.likes;
      question.favorites += stats.favorites;
      question.comments += stats.comments;
      question.mapGenerations += stats.mapGenerations;
      question.heat = question.likes + question.favorites + question.comments + question.mapGenerations;
    }
    return { answers, questions };
  }

  async function snapshot(userId = '') {
    return snapshotFrom(await read(), userId);
  }

  return { session, createSession, deleteSession, saveOAuthState, consumeOAuthState, getDataset, importDataset, getAnswerMaps, getAnswerMap, saveAnswerMap, pruneAnswerMaps, getCollisionCache, saveCollisionCache, listDiscoveries, saveDiscovery, commentDiscovery, updateDiscoveryStatus, withdrawDiscoveryComment, act, comment, snapshot };
}
