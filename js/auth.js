(function () {
  'use strict';

  const TOKEN_KEY = 'cow_auth_token';
  const USER_KEY = 'cow_auth_user';
  let mode = 'login';

  const $ = s => document.querySelector(s);

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }

  function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
  }

  function saveAuth(d) {
    localStorage.setItem(TOKEN_KEY, d.authToken);
    localStorage.setItem(USER_KEY, JSON.stringify({ userId: d.userId, name: d.name, provider: d.provider, login: d.login }));
  }

  function clearAuth() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  async function api(action, extra) {
    const res = await fetch('api.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action }, extra || {})),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const e = new Error((data && data.error) || 'Ошибка сети');
      e.code = res.status;
      throw e;
    }
    return data;
  }

  function escapeHtmlA(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function afterLogin(d) {
    saveAuth(d);
    render();
  }

  function render() {
    const info = $('#auth-info');
    if (!info) return;
    const guest = $('#auth-guest-actions');
    $('#auth-form').classList.add('hidden');
    const u = getUser();
    if (u) {
      info.innerHTML = `Вы вошли как <b>${escapeHtmlA(u.name)}</b>`;
      guest.innerHTML = '<button id="auth-logout" class="btn secondary">Выйти</button>';
    } else {
      info.textContent = 'Вы играете как гость. Войдите, чтобы закрепить имя.';
      guest.innerHTML = `
        <button id="auth-login-btn" class="btn primary">Вход</button>
        <button id="auth-register-btn" class="btn secondary">Регистрация</button>`;
    }
  }

  async function yaLogin() {
    try {
      if (!window.YaGames) {
        await new Promise((ok, bad) => {
          const s = document.createElement('script');
          s.src = 'https://yandex.ru/games/sdk/v2';
          s.onload = ok;
          s.onerror = bad;
          document.head.appendChild(s);
        });
      }
      const ysdk = await window.YaGames.init();
      const player = await ysdk.getPlayer({ scopes: false });
      afterLogin(await api('authYandex', { yaId: player.getUniqueID(), name: player.getName() || 'Игрок Яндекса' }));
    } catch (err) {
      $('#auth-error').textContent = 'Вход через Яндекс доступен только внутри платформы Яндекс Игры';
    }
  }

  async function vkCallback() {
    const q = new URLSearchParams(location.search);
    const code = q.get('code');
    if (!code) return;
    history.replaceState(null, '', location.pathname);
    try {
      const redirect = localStorage.getItem('cow_vk_redirect') || (location.origin + location.pathname);
      afterLogin(await api('authVk', { code, redirectUri: redirect }));
    } catch (err) {
      $('#auth-error').textContent = err.message;
    }
  }

  function openForm(m) {
    mode = m;
    $('#auth-form').classList.remove('hidden');
    $('#auth-name-row').classList.toggle('hidden', mode !== 'register');
    $('#auth-submit').textContent = mode === 'login' ? 'Войти' : 'Зарегистрироваться';
    $('#auth-login-btn').classList.toggle('secondary', mode !== 'login');
    $('#auth-login-btn').classList.toggle('primary', mode === 'login');
    $('#auth-register-btn').classList.toggle('primary', mode === 'register');
    $('#auth-register-btn').classList.toggle('secondary', mode !== 'register');
    $('#auth-error').textContent = '';
    (mode === 'login' ? $('#auth-login') : $('#auth-name')).focus();
  }

  $('#auth-block').addEventListener('click', async e => {
    const t = e.target.closest('button');
    if (!t) return;
    try {
      if (t.id === 'auth-login-btn') {
        if (mode === 'login' && !$('#auth-form').classList.contains('hidden')) {
          $('#auth-form').classList.add('hidden');
          return;
        }
        openForm('login');
        return;
      }
      if (t.id === 'auth-register-btn') {
        if (mode === 'register' && !$('#auth-form').classList.contains('hidden')) {
          $('#auth-form').classList.add('hidden');
          return;
        }
        openForm('register');
        return;
      }
      if (t.id === 'auth-submit') {
        const payload = { login: $('#auth-login').value.trim(), password: $('#auth-pass').value };
        if (mode === 'register') payload.name = ($('#auth-name').value || '').trim() || payload.login;
        afterLogin(await api(mode, payload));
        return;
      }
      if (t.id === 'auth-vk') {
        const cfg = await api('authConfig');
        if (!cfg.vkAppId) {
          $('#auth-error').textContent = 'VK-авторизация не настроена на сервере (нужны VK_APP_ID и VK_APP_SECRET)';
          return;
        }
        const redirect = location.origin + location.pathname;
        localStorage.setItem('cow_vk_redirect', redirect);
        location.href = 'https://oauth.vk.com/authorize?client_id=' + encodeURIComponent(cfg.vkAppId)
          + '&redirect_uri=' + encodeURIComponent(redirect)
          + '&response_type=code&v=5.199&display=page';
        return;
      }
      if (t.id === 'auth-ya') {
        await yaLogin();
        return;
      }
      if (t.id === 'auth-logout') {
        await api('logout', { authToken: getToken() }).catch(() => {});
        clearAuth();
        render();
      }
    } catch (err) {
      $('#auth-error').textContent = err.message;
    }
  });

  window.AUTH = { getToken, getUser };

  (async function init() {
    render();
    if (getToken()) {
      try {
        const d = await api('me', { authToken: getToken() });
        saveAuth({ authToken: getToken(), userId: d.userId, name: d.name, provider: d.provider, login: d.login });
      } catch (e) {
        if (e.code === 401) clearAuth();
      }
      render();
    }
    vkCallback();
  })();
})();
