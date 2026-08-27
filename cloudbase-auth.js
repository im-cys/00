/**
 * cloudbase-auth.js —— CloudBase 真实账户访问层
 *
 * 这个文件只封装浏览器端允许使用的 Web SDK：登录、注册、验证码、会话和退出。
 * Publishable Key 本来就会随网页公开；任何 SecretId、SecretKey 或服务端 API Key
 * 都不应出现在本文件、浏览器扩展或 GitHub 仓库中。
 */

import cloudbase from '@cloudbase/js-sdk';

export const CLOUD_BASE_CONFIG = Object.freeze({
  env: 'personal-test-d3g2ebfi159910e0f',
  region: 'ap-shanghai',
  accessKey: 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjYxMWUyMGE4LTUwNGUtNDBlYS05N2U5LTk0YjM0ZTY3YzY3NyJ9.eyJpc3MiOiJodHRwczovL3BlcnNvbmFsLXRlc3QtZDNnMmViZmkxNTk5MTBlMGYuYXAtc2hhbmdoYWkudGNiLWFwaS50ZW5jZW50Y2xvdWRhcGkuY29tIiwic3ViIjoiYW5vbiIsImF1ZCI6InBlcnNvbmFsLXRlc3QtZDNnMmViZmkxNTk5MTBlMGYiLCJleHAiOjQwOTE0OTkyMDYsImlhdCI6MTc4NzgxNjAwNiwibm9uY2UiOiI1TDZvNU53MFFiR29fVVczR25ZcFpBIiwiYXRfaGFzaCI6IjVMNm81TncwUWJHb19VVzNHbllwWkEiLCJuYW1lIjoiQW5vbnltb3VzIiwic2NvcGUiOiJhbm9ueW1vdXMiLCJwcm9qZWN0X2lkIjoicGVyc29uYWwtdGVzdC1kM2cyZWJmaTE1OTkxMGUwZiIsIm1ldGEiOnsicGxhdGZvcm0iOiJQdWJsaXNoYWJsZUtleSJ9LCJyb2xlIjoiYW5vbiIsImlzX2Fub255bW91cyI6dHJ1ZSwiYXBwX21ldGFkYXRhIjp7InByb3ZpZGVyIjoiYW5vbnltb3VzIiwicHJvdmlkZXJzIjpbImFub255bW91cyJdfSwidXNlcl9tZXRhZGF0YSI6eyJuYW1lIjoiQW5vbnltb3VzIn0sInVzZXJfdHlwZSI6IiIsImNsaWVudF90eXBlIjoiY2xpZW50X3VzZXIiLCJpc19zeXN0ZW1fYWRtaW4iOmZhbHNlfQ.whu5HFgFMZYgz26cBbzXqK8Rl6Nvt6Ag_pn77qtqxefUjjgfppmYUbcGCu5KOdlFolOmcXEWj3pVixR-T8mN0GyXHEVEVMzKvrx2cdf5xammGuv_JZGuaNaXvo1Cd2ffS7Rd-ZTymnQoSe5Bnh5RhKJuLfgkrPLVXp0OZSclQpsQgpu21HDgUA5NtVGEzcoA58njlcRlSmpcEOxZT_JcFAsaMdVvo9oMoUWSZPwwPce70H895-s4TnVLmU0TDSJNhGyIF2sCBfle6LD3unALFQCWx3zkd3-GVsbGBe5xnoAeHShNq6wyMEMaQugstURuOtLyp9SRAua6illtH4jMWw'
});

const cloudbaseApp = cloudbase.init({
  ...CLOUD_BASE_CONFIG,
  auth: { detectSessionInUrl: true }
});

// v3 同时兼容 app.auth 与 app.auth()；当前版本两者指向同一认证实例。
export const cloudbaseAuth = cloudbaseApp.auth;

function unwrap(result, fallbackMessage) {
  if (result?.error) {
    const error = new Error(result.error.message || fallbackMessage);
    error.code = result.error.code;
    error.cause = result.error;
    throw error;
  }
  return result?.data;
}

function requireVerifier(data, message) {
  if (typeof data?.verifyOtp !== 'function') throw new Error(message);
  return data.verifyOtp;
}

export async function getAuthenticatedAccount() {
  const sessionData = unwrap(await cloudbaseAuth.getSession(), '无法读取登录状态');
  const session = sessionData?.session;

  // Publishable Key 只提供公开访问身份，不能被当成真正的用户登录。
  if (!session || String(session.loginType || '').toUpperCase() === 'ANONYMOUS') return null;

  const userData = unwrap(await cloudbaseAuth.getUser(), '无法读取账户信息');
  const user = userData?.user || userData;
  return user ? { user, session } : null;
}

export async function signInWithPassword(identifier, password) {
  const normalized = identifier.trim();
  let credential = { username: normalized };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) credential = { email: normalized };
  else if (/^1\d{10}$/.test(normalized)) credential = { phone: normalized };

  const data = unwrap(
    await cloudbaseAuth.signInWithPassword({ ...credential, password }),
    '账号或密码不正确'
  );
  return data;
}

export async function beginSmsSignIn(phone) {
  const data = unwrap(
    await cloudbaseAuth.signInWithOtp({ phone, options: { shouldCreateUser: true } }),
    '短信验证码发送失败'
  );
  return requireVerifier(data, '短信验证码流程没有正确启动');
}

export async function beginRegistration({ email, phone, password, username }) {
  const data = unwrap(
    await cloudbaseAuth.signUp({ email, phone, password, username }),
    '注册验证码发送失败'
  );
  return requireVerifier(data, '注册验证码流程没有正确启动');
}

export async function completeOtpVerification(verifyOtp, token) {
  return unwrap(await verifyOtp({ token }), '验证码不正确或已经过期');
}

export async function setNickname(nickname) {
  if (!nickname) return null;
  const data = unwrap(await cloudbaseAuth.updateUser({ nickname }), '昵称保存失败');
  return data?.user || data;
}

export async function beginPhoneBinding(phone) {
  const data = unwrap(await cloudbaseAuth.updateUser({ phone }), '绑定验证码发送失败');
  return requireVerifier(data, '手机号绑定流程没有正确启动');
}

export async function signOutAccount() {
  unwrap(await cloudbaseAuth.signOut(), '退出登录失败');
}

export function toLocalProfile(user) {
  const metadata = user?.user_metadata || user?.userMetadata || {};
  const email = user?.email || metadata.email || '';
  const phone = user?.phone || user?.phone_number || metadata.phone || '';
  const username = user?.username || metadata.username || '';
  const nickname = user?.nickname || metadata.nickname || metadata.name || '';
  const fallback = username || (email ? email.split('@')[0] : '') || (phone ? `用户${phone.slice(-4)}` : '观点用户');

  return {
    uid: user?.id || user?.uid || user?._id || '',
    name: nickname || fallback,
    nickname,
    username,
    email,
    phone,
    createdAt: user?.created_at || user?.createdAt || new Date().toISOString(),
    authProvider: 'cloudbase'
  };
}
