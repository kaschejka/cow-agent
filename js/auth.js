(function () {
  'use strict';

  const TOKEN_KEY = 'cow_auth_token';
  const USER_KEY = 'cow_auth_user';
  let mode = 'login';
  let vkAppId = '';

  const $ = s => document.querySelector(s);

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }

  function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
  }

  function saveAuth(d) {
    localStorage.setItem(TOKEN_KEY, d.authToken);
    localStorage.setItem(USER_KEY, JSON.stringify({
      userId: d.userId,
      name: d.name,
      provider: d.provider,
      login: d.login,
      rating: typeof d.rating === 'number' ? d.rating : null,
      stats: d.stats || null,
    }));
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
      let statsHtml = '';
      if (u.stats) {
        const s = u.stats;
        const winRate = s.games > 0 ? Math.round((s.wins * 100) / s.games) : 0;
        const line = (label, val) => `<div class="as-line"><span>${label}</span><b>${val}</b></div>`;
        const rows =
          line('Партий', s.games)
          + line('Побед', `${s.wins} (${winRate}%)`)
          + line('Топ-3', s.top3)
          + line('Серия побед', s.winStreak)
          + line('Лучшая серия', s.bestStreak)
          + line('Средний штраф', s.avgPenalty != null ? s.avgPenalty : '—')
          + line('Лучший результат', s.bestGame != null ? s.bestGame : '—')
          + line('Худший результат', s.worstGame != null ? s.worstGame : '—')
          + line('Шестой енот', s.sixthTakes)
          + line('Забрал ряд по выбору', s.forcedTakes);
        statsHtml = `<div class="auth-stats"><div class="as-rating">★ ${u.rating ?? 1000}</div>${rows}</div>`;
      } else {
        statsHtml = '<div class="auth-stats"><div class="as-rating">★ ' + (u.rating != null ? u.rating : 1000) + '</div><div class="as-line"><span>Партий</span><b>пока нет</b></div></div>';
      }
      info.innerHTML = `Вы вошли как <b>${escapeHtmlA(u.name)}</b>${statsHtml}`;
      guest.innerHTML = '<button id="auth-logout" class="btn secondary">Выйти</button>';
    } else {
      info.textContent = 'Вы играете как гость. Войдите, чтобы закрепить имя.';
      guest.innerHTML = `
        <button id="auth-login-btn" class="btn primary">Вход</button>
        <button id="auth-register-btn" class="btn secondary">Регистрация</button>
        <button id="auth-vk" class="btn secondary">Войти через VK</button>`;
    }
  }

  async function loadAuthConfig() {
    try {
      const cfg = await api('authConfig');
      vkAppId = cfg.vkAppId || '';
    } catch { /* сервер недоступен — кнопка останется заблокированной */ }
    return vkAppId;
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
    $('#auth-email-row').classList.toggle('hidden', mode !== 'register');
    $('#auth-submit').textContent = mode === 'login' ? 'Войти' : 'Зарегистрироваться';
    $('#auth-login-btn').classList.toggle('secondary', mode !== 'login');
    $('#auth-login-btn').classList.toggle('primary', mode === 'login');
    $('#auth-register-btn').classList.toggle('primary', mode === 'register');
    $('#auth-register-btn').classList.toggle('secondary', mode !== 'register');
    $('#auth-error').style.color = '';
    $('#auth-error').textContent = '';
    const oldResend = $('#auth-resend');
    if (oldResend) oldResend.remove();
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
        if (mode === 'register') {
          payload.name = ($('#auth-name').value || '').trim() || payload.login;
          payload.email = ($('#auth-email').value || '').trim();
          const d = await api('register', payload);
          openForm('login');
          const ok = $('#auth-error');
          ok.style.color = '#7ddb8a';
          ok.textContent = d.message || 'Письмо отправлено — подтвердите почту и войдите.';
          return;
        }
        afterLogin(await api(mode, payload));
        return;
      }
      if (t.id === 'auth-vk') {
        if (!vkAppId) await loadAuthConfig(); // вдруг настроили без перезагрузки страницы
        if (!vkAppId) {
          $('#auth-error').textContent = 'VK-авторизация не настроена на сервере (нужны VK_APP_ID и VK_APP_SECRET)';
          return;
        }
        const redirect = location.origin + location.pathname;
        localStorage.setItem('cow_vk_redirect', redirect);
        location.href = 'https://oauth.vk.com/authorize?client_id=' + encodeURIComponent(vkAppId)
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
      const box = $('#auth-error');
      box.style.color = '';
      box.textContent = err.message;
      // 403 = e-mail не подтверждён: предлагаем выслать письмо повторно
      if (err.code === 403 && mode === 'login' && !$('#auth-resend')) {
        const b = document.createElement('button');
        b.id = 'auth-resend';
        b.type = 'button';
        b.className = 'btn secondary';
        b.textContent = 'Отправить письмо ещё раз';
        b.addEventListener('click', async () => {
          try {
            const d = await api('resend', { login: $('#auth-login').value.trim() });
            box.style.color = '#7ddb8a';
            box.textContent = d.message || 'Письмо отправлено.';
            b.remove();
          } catch (e2) {
            box.style.color = '';
            box.textContent = e2.message;
          }
        });
        document.querySelector('#auth-form .lobby-actions').appendChild(b);
      }
    }
  });

  // Запуск внутри VK (мини-приложение): тихий вход без формы регистрации
  async function vkMiniLogin(q) {
    try {
      if (!window.vkBridge) {
        await new Promise((ok, bad) => {
          const s = document.createElement('script');
          s.src = 'https://unpkg.com/@vkontakte/vk-bridge/dist/browser.min.js';
          s.onload = ok;
          s.onerror = bad;
          document.head.appendChild(s);
        });
      }
      const bridge = window.vkBridge.default || window.vkBridge;
      await bridge.send('VKWebAppInit');
      let name = '';
      try {
        const ui = await bridge.send('VKWebAppGetUserInfo');
        name = ((ui.first_name || '') + ' ' + (ui.last_name || '')).trim();
      } catch { /* имя необязательно */ }
      afterLogin(await api('authVkMini', { params: Object.fromEntries(q.entries()), user: { name } }));
    } catch (err) {
      $('#auth-error').textContent = 'Не удалось выполнить вход через VK: ' + err.message;
    }
  }

  window.AUTH = { getToken, getUser };

  (async function init() {
    await loadAuthConfig();
    render();
    const q = new URLSearchParams(location.search);
    if (q.get('vk_app_id') && q.get('vk_user_id') && q.get('sign')) {
      await vkMiniLogin(q);
      return;
    }
    if (getToken()) {
      try {
        const d = await api('me', { authToken: getToken() });
        saveAuth({ authToken: getToken(), userId: d.userId, name: d.name, provider: d.provider, login: d.login, rating: d.rating, stats: d.stats });
      } catch (e) {
        if (e.code === 401) clearAuth();
      }
      render();
    }
    vkCallback();
  })();
})();
