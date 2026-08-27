/**
 * background.js —— 扩展后台通信层
 *
 * content.js 不直接保存后端地址或处理网络细节，而是把请求交给这里。
 * Edge 商店测试版固定连接腾讯云 HTTPS 服务；账号系统完成后，设备令牌也会由这里附加。
 */

const DEFAULT_API_BASE = 'https://zhihu-social-demo-302050-11-1344805741.sh.run.tcloudbase.com';

async function getSettings() {
  const stored = await chrome.storage.local.get({
    apiBase: DEFAULT_API_BASE,
    dashboardUrl: DEFAULT_API_BASE
  });

  // 0.1-0.3 版曾把本机地址写入扩展存储。升级到商店版时自动迁移，避免旧设置覆盖公网地址。
  const migrateLegacyBase = (value) => {
    const normalized = String(value || DEFAULT_API_BASE).replace(/\/$/, '');
    return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(normalized) ? DEFAULT_API_BASE : normalized;
  };
  const apiBase = migrateLegacyBase(stored.apiBase);
  const dashboardUrl = migrateLegacyBase(stored.dashboardUrl || stored.apiBase);

  if (apiBase !== stored.apiBase || dashboardUrl !== stored.dashboardUrl) {
    await chrome.storage.local.set({ apiBase, dashboardUrl });
  }

  return {
    apiBase,
    dashboardUrl
  };
}

async function postJson(path, payload) {
  const { apiBase } = await getSettings();
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'GET_SETTINGS') {
    getSettings().then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }

  if (message.type === 'OPEN_DASHBOARD') {
    getSettings()
      .then(({ dashboardUrl }) => chrome.tabs.create({ url: `${dashboardUrl}/?extension=connect&view=conversations` }))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'OPEN_PRIVACY') {
    getSettings()
      .then(({ dashboardUrl }) => chrome.tabs.create({ url: `${dashboardUrl}/privacy` }))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'OPEN_SUPPORT') {
    getSettings()
      .then(({ dashboardUrl }) => chrome.tabs.create({ url: `${dashboardUrl}/support` }))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'AGENT_REPLY') {
    postJson('/api/agent/respond', message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'AGENT_SUMMARY') {
    postJson('/api/agent/summarize', message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

// 点击浏览器工具栏图标时，在任意已注入的普通网页中展开悬浮球菜单。
// chrome://、edge:// 和浏览器应用商店等受保护页面不允许扩展注入，这是浏览器本身的限制。
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !/^https?:\/\//.test(tab.url || '')) return;
  await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_ORB_MENU' }).catch(() => {});
});
