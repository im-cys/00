import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const USERNAME_PATTERN = /^[\p{L}\p{N}_.-]{2,24}$/u;

export function testUsername(value) {
  return String(value || '').normalize('NFKC').trim();
}

export function testUsernameKey(value) {
  return testUsername(value).toLocaleLowerCase('zh-CN');
}

export function validateTestCredentials(username, password) {
  const name = testUsername(username);
  const passwordLength = Array.from(String(password || '')).length;
  if (!USERNAME_PATTERN.test(name)) throw Object.assign(new Error('用户名需为 2–24 位中文、字母、数字、点、短横线或下划线。'), { status: 400 });
  if (passwordLength < 8 || passwordLength > 72) throw Object.assign(new Error('密码需为 8–72 个字符。'), { status: 400 });
  return { username: name, usernameKey: testUsernameKey(name), password: String(password) };
}

export function testUserId(usernameKey) {
  return `test-${createHash('sha256').update(usernameKey).digest('hex').slice(0, 32)}`;
}

export async function createPasswordRecord(password) {
  const salt = randomBytes(16).toString('base64url');
  const hash = await scrypt(password, salt, 64);
  return { salt, passwordHash: Buffer.from(hash).toString('base64url') };
}

export async function verifyPassword(password, salt, expected) {
  try {
    const actual = Buffer.from(await scrypt(String(password), String(salt), 64));
    const wanted = Buffer.from(String(expected), 'base64url');
    return actual.length === wanted.length && timingSafeEqual(actual, wanted);
  } catch {
    return false;
  }
}
