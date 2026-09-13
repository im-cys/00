import { readFile } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function configuration() {
  let loaded = {}, configSource = '环境变量';
  try {
    loaded = parseEnv(await readFile(resolve(root, '.env'), 'utf8'));
    configSource = '项目 .env';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const env = { ...loaded, ...process.env };
  const privateDataSetting = env.PRIVATE_DATA_DIR || 'private-data';
  const collisionDataSetting = env.COLLISION_DATA_DIR || 'collision';
  const privateDataDir = isAbsolute(privateDataSetting) ? resolve(privateDataSetting) : resolve(root, privateDataSetting);
  return {
    configSource,
    port: Math.min(65535, Math.max(1, Number(env.PORT) || 3210)),
    host: env.HOST || '127.0.0.1',
    allowedHosts: String(env.ALLOWED_HOSTS || '127.0.0.1,localhost').split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
    allowedOrigins: String(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
    collideBase: env.COLLIDE_BASE || 'http://127.0.0.1:3311',
    privateDataDir,
    collisionDataDir: isAbsolute(collisionDataSetting) ? resolve(collisionDataSetting) : resolve(privateDataDir, collisionDataSetting),
    zhihuAuth: {
      configured: Boolean(env.ZHIHU_CLIENT_ID && env.ZHIHU_CLIENT_SECRET && env.ZHIHU_AUTHORIZATION_URL && env.ZHIHU_TOKEN_URL && env.ZHIHU_PROFILE_URL),
      demoMode: String(env.ZHIHU_AUTH_DEMO_MODE ?? 'true').toLowerCase() !== 'false',
      clientId: env.ZHIHU_CLIENT_ID || '',
      clientSecret: env.ZHIHU_CLIENT_SECRET || '',
      authorizationUrl: env.ZHIHU_AUTHORIZATION_URL || '',
      tokenUrl: env.ZHIHU_TOKEN_URL || '',
      profileUrl: env.ZHIHU_PROFILE_URL || '',
      redirectUri: env.ZHIHU_REDIRECT_URI || 'http://127.0.0.1:3210/auth/zhihu/callback',
      scope: env.ZHIHU_SCOPE || 'openid profile'
    }
  };
}
