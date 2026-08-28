(function () {
  'use strict';

  const TOKEN_KEY = 'cow_auth_token';
  const USER_KEY = 'cow_auth_user';
  let mode = 'login';
  let vkAppId = '';
  let vkRedirectUri = '';

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
      vkId: d.vkId != null ? String(d.vkId) : null,
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
      let actions = '<button id="auth-logout" class="btn secondary">Выйти</button>';
      // Привязка VK к обычному аккаунту (видна только локально зарегистрированным)
      if (u.provider === 'local') {
        actions += u.vkId
          ? `<div class="auth-link-row">Привязано: VK id <b>${escapeHtmlA(u.vkId)}</b> <button id="auth-vk-unlink" class="btn sm-btn secondary">Снять</button></div>`
          : `<div class="auth-link-row">Привязать вход из VK к этому аккаунту
               <input id="auth-vk-link-input" inputmode="numeric" maxlength="16" pattern="[0-9]*" placeholder="Ваш VK id">
               <button id="auth-vk-link" class="btn secondary">Привязать</button>
             </div>`;
      }
      guest.innerHTML = actions;
    } else {
      info.textContent = 'Вы играете как гость. Войдите, чтобы закрепить имя.';
      guest.innerHTML = `
        <button id="auth-login-btn" class="btn primary">Вход</button>
        <button id="auth-register-btn" class="btn secondary">Регистрация</button>`;
    }
  }

  async function loadAuthConfig() {
    try {
      const cfg = await api('authConfig');
      vkAppId = cfg.vkAppId || '';
      vkRedirectUri = cfg.vkRedirectUri || '';
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

  function vkRedirect() {
    return vkRedirectUri || (location.origin + location.pathname);
  }

  async function vkCallback() {
    const q = new URLSearchParams(location.search);
    const code = q.get('code');
    if (!code) return;
    history.replaceState(null, '', location.pathname);
    try {
      const redirect = localStorage.getItem('cow_vk_redirect') || vkRedirect();
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
      if (t.id === 'auth-vk-link') {
        const input = $('#auth-vk-link-input');
        const vkId = (input ? input.value : '').replace(/\D/g, '').trim();
        if (!vkId) {
          $('#auth-error').textContent = 'Укажите ваш id из VK (цифрами)';
          return;
        }
        const d = await api('linkVk', { authToken: getToken(), vkId });
        saveAuth({ authToken: getToken(), userId: d.userId, name: d.name, provider: d.provider, login: d.login, vkId: d.vkId, rating: d.rating, stats: d.stats });
        render();
        return;
      }
      if (t.id === 'auth-vk-unlink') {
        const d = await api('unlinkVk', { authToken: getToken() });
        saveAuth({ authToken: getToken(), userId: d.userId, name: d.name, provider: d.provider, login: d.login, vkId: d.vkId, rating: d.rating, stats: d.stats });
        render();
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

  function launchParamsFromUrl() {
    const q = new URLSearchParams(location.search);
    if (location.hash.length > 1) {
      try {
        const h = new URLSearchParams(location.hash.slice(1));
        for (const [k, v] of h) if (!q.has(k)) q.append(k, v);
      } catch { /* нестандартный фрагмент */ }
    }
    return q;
  }

  function ensureVkBridge() {
    if (window.vkBridge) return Promise.resolve();
    const cdn = [
      'https://unpkg.com/@vkontakte/vk-bridge/dist/browser.min.js',
      'https://cdn.jsdelivr.net/npm/@vkontakte/vk-bridge/dist/browser.min.js',
    ];
    return new Promise((ok, bad) => {
      let i = -1;
      const timer = window.setTimeout(() => { bad(new Error('vk-bridge timeout')); }, 4000);
      const loadNext = () => {
        i++;
        if (i >= cdn.length) { window.clearTimeout(timer); bad(new Error('vk-bridge недоступен')); return; }
        const s = document.createElement('script');
        s.src = cdn[i];
        s.onload = () => { window.clearTimeout(timer); ok(); };
        s.onerror = () => { s.remove(); loadNext(); };
        document.head.appendChild(s);
      };
      loadNext();
    });
  }

  // Запуск внутри VK (мини-приложение): тихий вход без формы регистрации.
  // Параметры запуска берём из URL и/или от хоста VK (VKWebAppGetLaunchParams);
  // подпись проверяется на сервере, мост нужен только для имени и параметров.
  async function vkMiniLogin(q) {
    let name = '';
    try {
      await ensureVkBridge();
      const bridge = window.vkBridge.default || window.vkBridge;
      await bridge.send('VKWebAppInit');
      try {
        const lp = await bridge.send('VKWebAppGetLaunchParams');
        if (lp && typeof lp === 'object') {
          for (const k of Object.keys(lp)) {
            if (k === 'sign' || String(k).startsWith('vk_')) q.set(k, String(lp[k]));
          }
        }
      } catch { /* параметры могли прийти в URL */ }
      try {
        const ui = await bridge.send('VKWebAppGetUserInfo');
        name = ((ui.first_name || '') + ' ' + (ui.last_name || '')).trim();
      } catch { /* имя необязательно */ }
    } catch { /* без моста пробуем войти по URL-параметрам */ }

    if (!q.get('sign') || !q.get('vk_user_id')) {
      console.warn('[auth] VK-параметры запуска не найдены', location.href);
      return;
    }

    try {
      afterLogin(await api('authVkMini', { params: q.toString(), user: { name } }));
    } catch (err) {
      console.error('[auth] автоматический вход через VK не удался:', err.message, q.toString());
      const info = $('#auth-info');
      if (info) info.textContent = 'Вход через VK не выполнен (' + err.message + ') — войдите вручную ниже.';
    }
  }

  window.AUTH = { getToken, getUser };

  (async function init() {
    await loadAuthConfig();
    render();
    const q = launchParamsFromUrl();
    const insideVk = q.has('vk_app_id') || q.has('vk_user_id') || q.has('sign')
      || window.vkBridge
      || (window.parent !== window && window.self !== window.top)
      || /vk(ango)?[ _-]?(app|android|ios|client|web)/i.test(navigator.userAgent);
    if (insideVk) {
      await vkMiniLogin(q);
      return;
    }
    if (getToken()) {
      try {
        const d = await api('me', { authToken: getToken() });
        saveAuth({ authToken: getToken(), userId: d.userId, name: d.name, provider: d.provider, login: d.login, vkId: d.vkId, rating: d.rating, stats: d.stats });
      } catch (e) {
        if (e.code === 401) clearAuth();
      }
      render();
    }
    vkCallback();
  })();
})();
