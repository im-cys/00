(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  const requestedReturnTo = params.get('return_to') || '/';
  const returnTo = /^\/(?!\/)/.test(requestedReturnTo) ? requestedReturnTo : '/';
  const zhihuLogin = document.querySelector('#zhihuLogin');
  const unavailable = document.querySelector('#loginUnavailable');

  async function initialize() {
    try {
      const response = await fetch('/api/auth/session');
      if (!response.ok) throw new Error('session unavailable');
      const session = await response.json();
      if (session.user) { location.replace(returnTo); return; }
      location.replace(`/auth/zhihu?return_to=${encodeURIComponent(returnTo)}`);
    } catch {
      zhihuLogin.hidden = true;
      unavailable.textContent = '无法读取登录状态，请刷新页面重试。';
      unavailable.hidden = false;
    }
  }

  initialize();
})();
