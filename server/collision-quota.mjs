export const DAILY_COLLISION_LIMIT = 10;

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

export function chinaDayKey(now = Date.now()) {
  return new Date(Number(now) + CHINA_OFFSET_MS).toISOString().slice(0, 10);
}

export function collisionQuota(used = 0, now = Date.now()) {
  const normalized = Math.min(DAILY_COLLISION_LIMIT, Math.max(0, Number(used) || 0));
  const day = chinaDayKey(now);
  return {
    day,
    limit: DAILY_COLLISION_LIMIT,
    used: normalized,
    remaining: DAILY_COLLISION_LIMIT - normalized,
    resetAt: Date.parse(`${day}T16:00:00.000Z`)
  };
}
