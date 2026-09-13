import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import vm from 'node:vm';

const { values } = parseArgs({ options: {
  url: { type: 'string' }, data: { type: 'string' }, maps: { type: 'string' }, env: { type: 'string', default: '.env' }
} });

let fileEnv = {};
try { fileEnv = parseEnv(await readFile(resolve(values.env), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const env = { ...fileEnv, ...process.env };
const baseUrl = String(values.url || env.DEPLOY_BASE_URL || '').replace(/\/$/, '');
const token = env.DATA_IMPORT_TOKEN || '';
if (!baseUrl || !values.data || !token) {
  console.error('用法：node scripts/import-private-data.mjs --url <部署地址> --data <data.js> [--maps <collision-maps.js>]');
  console.error('DATA_IMPORT_TOKEN 必须通过 .env 或环境变量提供。');
  process.exit(2);
}

async function evaluate(file, globalName) {
  const context = { window: {} };
  vm.runInNewContext(await readFile(resolve(file), 'utf8'), context, { filename: resolve(file), timeout: 5000 });
  const value = context.window[globalName];
  if (!value) throw new Error(`${file} 未定义 window.${globalName}`);
  return JSON.parse(JSON.stringify(value));
}

const data = await evaluate(values.data, 'ZHIHU_DEMO_DATA');
const maps = values.maps ? await evaluate(values.maps, 'COLLISION_MAPS') : {};
const response = await fetch(`${baseUrl}/api/admin/import`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ data, maps }),
  signal: AbortSignal.timeout(120000)
});
const result = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(result.error || `导入失败：HTTP ${response.status}`);
console.log(`导入成功：${result.questions} 个问题，${result.maps} 份已有结构图，内容摘要 ${result.contentHash}`);
