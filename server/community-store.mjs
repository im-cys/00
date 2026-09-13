import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { root } from './config.mjs';

const emptyDatabase = () => ({ version: 1, sessions: {}, answers: {} });
const toggleActions = new Set(['upvote', 'like', 'favorite']);

export function createCommunityStore(filePath = resolve(root, 'runtime', 'community.json')) {
  let queue = Promise.resolve();

  async function read() {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      return { ...emptyDatabase(), ...parsed, sessions: parsed.sessions || {}, answers: parsed.answers || {} };
    } catch (error) {
      if (error.code === 'ENOENT') return emptyDatabase();
      throw error;
    }
  }

  async function write(database) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(database, null, 2), 'utf8');
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
    return database.sessions[token]?.user || null;
  }

  async function createSession(user) {
    const token = randomUUID();
    await mutate(database => {
      database.sessions[token] = { user, createdAt: Date.now() };
    });
    return token;
  }

  async function deleteSession(token) {
    if (!token) return;
    await mutate(database => { delete database.sessions[token]; });
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

  return { session, createSession, deleteSession, act, comment, snapshot };
}
