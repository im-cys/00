(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  const requestedReturnTo = params.get('return_to') || '/';
  const returnTo = /^\/(?!\/)/.test(requestedReturnTo) ? requestedReturnTo : '/';
  const panel = document.querySelector('#testAuthPanel');
  const form = document.querySelector('#testAuthForm');
  const errorBox = document.querySelector('#loginError');
  const zhihuLogin = document.querySelector('#zhihuLogin');
  const divider = document.querySelector('#loginDivider');
  const unavailable = document.querySelector('#loginUnavailable');

  const showError = message => { errorBox.textContent = message; errorBox.hidden = !message; };
  const setBusy = busy => form?.querySelectorAll('button,input').forEach(element => { element.disabled = busy; });

  async function initialize() {
    try {
      const response = await fetch('/api/auth/session');
      const session = await response.json();
      if (session.user) { location.replace(returnTo); return; }
      panel.hidden = !session.testPasswordAuthEnabled;
      const hasZhihu = session.configured || session.demoMode;
      zhihuLogin.hidden = !hasZhihu;
      divider.hidden = !session.testPasswordAuthEnabled || !hasZhihu;
      unavailable.hidden = session.testPasswordAuthEnabled || hasZhihu;
      zhihuLogin.href = `/auth/zhihu?return_to=${encodeURIComponent(returnTo)}`;
    } catch {
      showError('无法读取登录状态，请刷新页面重试。');
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault(); showError(''); setBusy(true);
    const action = event.submitter?.dataset.action === 'register' ? 'register' : 'login';
    const values = new FormData(form);
    try {
      const response = await fetch(`/api/auth/test/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: values.get('username'), password: values.get('password'), returnTo })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '登录失败。');
      location.replace(result.returnTo || returnTo);
    } catch (error) {
      showError(error.message); setBusy(false);
    }
  });

  initialize();
})();
