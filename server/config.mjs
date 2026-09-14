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
    useDatabase: String(env.CLOUDBASE_USE_DATABASE ?? 'false').toLowerCase() === 'true',
    cloudbaseEnv: env.CLOUDBASE_ENV_ID || '',
    cloudbaseApiKey: env.CLOUDBASE_APIKEY || '',
    dataImportToken: env.DATA_IMPORT_TOKEN || '',
    aiModel: env.EXTRACT_MODEL || 'deepseek-v4-pro',
    privateDataDir,
    collisionDataDir: isAbsolute(collisionDataSetting) ? resolve(collisionDataSetting) : resolve(privateDataDir, collisionDataSetting),
    zhihuAuth: {
      configured: Boolean((env.ZHIHU_OAUTH_APP_ID || env.ZHIHU_CLIENT_ID) && (env.ZHIHU_OAUTH_APP_KEY || env.ZHIHU_CLIENT_SECRET)),
      demoMode: String(env.ZHIHU_AUTH_DEMO_MODE ?? 'false').toLowerCase() === 'true',
      appId: env.ZHIHU_OAUTH_APP_ID || env.ZHIHU_CLIENT_ID || '',
      appKey: env.ZHIHU_OAUTH_APP_KEY || env.ZHIHU_CLIENT_SECRET || '',
      accessSecret: env.ZHIHU_ACCESS_SECRET || '',
      authorizationUrl: env.ZHIHU_AUTHORIZATION_URL || 'https://openapi.zhihu.com/authorize',
      tokenUrl: env.ZHIHU_TOKEN_URL || 'https://openapi.zhihu.com/access_token',
      profileUrl: env.ZHIHU_PROFILE_URL || 'https://openapi.zhihu.com/user',
      redirectUri: env.ZHIHU_OAUTH_REDIRECT_URI || env.ZHIHU_REDIRECT_URI || 'http://127.0.0.1:3210/auth/zhihu/callback',
      scope: env.ZHIHU_SCOPE || ''
    }
  };
}
