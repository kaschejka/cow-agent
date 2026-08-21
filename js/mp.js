'use strict';

const MP = {
  room: null,
  token: null,
  myId: null,
  version: -1,
  pollTimer: null,
  tickBusy: false,
  animating: false,
  queuedSnap: null,
  animatedKey: null,
  animatedCount: 0,
  localTurnKey: null,
  modalKey: null,
  submittedKeys: new Set(),
  inLobbyView: false,
  inMenuView: false,
  awaitingView: false,
  roomsTimer: null,
  connecting: false,
  failCount: 0,
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.playerName = function () {
  const u = window.AUTH && AUTH.getUser();
  if (u && u.name) return u.name;
  if (!window.playerName.cached) {
    window.playerName.cached = 'Игрок-' + Math.floor(100 + Math.random() * 900);
  }
  return window.playerName.cached;
};

MP.loadSession = function () {
  try {
    const s = JSON.parse(localStorage.getItem('cow_mp_session') || 'null');
    return s && s.room && s.token ? s : null;
  } catch { return null; }
};

MP.saveSession = function () {
  localStorage.setItem('cow_mp_session', JSON.stringify({ room: MP.room, token: MP.token, you: MP.myId }));
};

MP.clearSession = function () {
  localStorage.removeItem('cow_mp_session');
};

MP.setSession = function (room, token, you) {
  MP.room = room;
  MP.token = token;
  MP.myId = you;
  MP.version = -1;
  MP.localTurnKey = null;
  MP.saveSession();
};

MP.hardReset = function () {
  MP.stopPoll();
  MP.stopRoomList();
  MP.room = null;
  MP.token = null;
  MP.myId = null;
  MP.version = -1;
  MP.animatedKey = null;
  MP.animatedCount = 0;
  MP.localTurnKey = null;
  MP.modalKey = null;
  MP.submittedKeys = new Set();
  MP.inLobbyView = false;
  MP.animating = false;
  MP.queuedSnap = null;
  MP.connecting = false;
  MP.failCount = 0;
  MP.inMenuView = false;
  MP.awaitingView = false;
  els.layout.classList.remove('in-lobby');
  els.rows.classList.remove('hidden');
  state = null;
  MODE = 'menu';
  ui.selected = null;
};

async function mpApi(action, payload) {
  const res = await fetch('api.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action, room: MP.room, token: MP.token }, payload || {})),
  });
  let data = null;
  try { data = await res.json(); } catch { throw new Error('Сервер недоступен'); }
  if (!res.ok || !data.ok) {
    const err = new Error((data && data.error) || 'Ошибка сервера');
    err.code = res.status;
    throw err;
  }
  return data;
}

MP.startPoll = function (immediate) {
  if (!MP.pollTimer) MP.pollTimer = setInterval(() => MP.tick(), 1100);
  if (immediate) MP.tick();
};

MP.stopPoll = function () {
  clearInterval(MP.pollTimer);
  MP.pollTimer = null;
};

MP.renderRooms = function (rooms) {
  const box = $('#mp-rooms');
  if (!box) return;
  let html = '';
  if (MP.room && MP.token) {
    const mine = rooms.find(r => r.id === MP.room);
    const cnt = mine ? `${mine.players}/${mine.max}` : '';
    html += `
      <div class="my-room-bar">
        <span>Ваша комната${cnt ? ' — игроков: ' + cnt : ''}. Игра начнётся автоматически.</span>
        <button class="btn secondary rr-leave" data-leave="1">Покинуть</button>
      </div>`;
  }
  if (!rooms.length) {
    html += '<p class="subtitle" style="text-align:center">Пока нет открытых комнат — нажмите «Сетевая игра»!</p>';
    box.innerHTML = html;
    return;
  }
  html += `
    <table class="room-table">
      <tr><th>Хост</th><th>Игроки</th><th></th></tr>
      ${rooms.map(r => {
        const mine = MP.room === r.id;
        return `
        <tr>
          <td>👑 ${escapeHtml(r.host)}</td>
          <td>${r.players}/${r.max}</td>
          <td class="rt-action">${mine
            ? '<span class="rr-mine">ваша комната</span>'
            : `<button class="btn secondary rr-join" data-room="${escapeHtml(r.id)}">Войти</button>`}</td>
        </tr>`;
      }).join('')}
    </table>`;
  box.innerHTML = html;
};

MP.refreshRooms = async function () {
  let data = null;
  try {
    const res = await fetch('api.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rooms' }),
    });
    data = await res.json();
  } catch { return; }
  if (data && data.ok) MP.renderRooms(data.rooms || []);
};

MP.startRoomList = function () {
  MP.stopRoomList();
  MP.refreshRooms();
  MP.roomsTimer = setInterval(MP.refreshRooms, 2000);
};

MP.stopRoomList = function () {
  clearInterval(MP.roomsTimer);
  MP.roomsTimer = null;
};

MP.tick = async function () {
  if (MP.tickBusy || !MP.room || !MP.token) return;
  MP.tickBusy = true;
  try {
    const snap = await mpApi('state');
    MP.failCount = 0;
    MP.applySnapshot(snap);
  } catch (e) {
    if ([401, 404, 410].includes(e.code)) MP.sessionLost(e.message);
    else if (MP.connecting && ++MP.failCount >= 5) MP.sessionLost('Не удалось подключиться к серверу');
  } finally {
    MP.tickBusy = false;
  }
};

MP.sessionLost = function (msg) {
  MP.clearSession();
  MP.hardReset();
  showMainMenu();
  const box = $('#mp-error');
  if (box) box.textContent = msg || 'Сессия завершена';
};

MP.resume = function () {
  const s = MP.loadSession();
  if (!s) { showMainMenu(); return; }
  MP.room = s.room;
  MP.token = s.token;
  MP.myId = s.you;
  MP.version = -1;
  MP.connecting = true;
  MP.failCount = 0;
  MP.awaitingView = true;
  MODE = 'mp';
  MP.startPoll(true);
};

MP.leaveFromMenu = async function () {
  try { await mpApi('leave'); } catch (e) {}
  MP.stopPoll();
  MP.clearSession();
  MP.room = null;
  MP.token = null;
  MP.myId = null;
  MP.inMenuView = false;
  const nb = $('#net-btn');
  if (nb) { nb.disabled = false; nb.title = ''; }
  MP.refreshRooms();
};

MP.joinRoom = async function (roomId, btn) {
  const errBox = $('#mp-error');
  try {
    if (MP.room === roomId && MP.token) { MP.refreshRooms(); return; }
    const name = playerName();
    if (MP.room && MP.token) {
      try { await mpApi('leave', { room: MP.room }); } catch {}
      MP.stopPoll();
      MP.clearSession();
      MP.room = null;
      MP.token = null;
      MP.myId = null;
      MP.inMenuView = false;
      const netBtn = $('#net-btn');
      if (netBtn) netBtn.disabled = false;
    }
    const r = await mpApi('join', { room: roomId, name });
    MP.stopRoomList();
    MODE = 'mp';
    MP.setSession(r.room, r.token, r.you);
    if (r.started) {
      MP.inMenuView = false;
      MP.awaitingView = true;
    } else {
      MP.inMenuView = true;
    }
    MP.startPoll(true);
  } catch (e) {
    if (errBox) errBox.textContent = e.message;
    if (btn) btn.disabled = false;
    MP.refreshRooms();
  }
};

MP.applySnapshot = function (snap) {
  if (snap.version === MP.version) return;
  MP.version = snap.version;

  if (MP.connecting) {
    MP.connecting = false;
    els.overlay.classList.add('hidden');
    hideMenuScreen();
  }
  if (MP.awaitingView) {
    MP.awaitingView = false;
    hideMenuScreen();
  }

  if (snap.phase === 'lobby') {
    if (!MP.inMenuView) {
      MP.inMenuView = true;
      MODE = 'menu';
      state = null;
      ui.selected = null;
      showMenuScreen();
      MP.startRoomList();
    }
    MP.refreshRooms();
    return;
  }

  if (MP.inMenuView) {
    MP.inMenuView = false;
    hideMenuScreen();
    addLog('Все игроки на месте — игра началась!', 'sys');
  }

  if (MP.animating) {
    MP.queuedSnap = snap;
    return;
  }
  MP.process(snap);
};

function mapPhase(snap) {
  switch (snap.phase) {
    case 'pick': return 'pick';
    case 'choose_row': return snap.waitingFor === snap.you ? 'choose-row' : 'locked';
    case 'round_end': return 'round-end';
    case 'game_end': return 'game-end';
    default: return 'locked';
  }
}

function stripHintFor(snap) {
  const me = snap.players.find(p => p.id === snap.you);
  if (snap.phase === 'pick' && me && me.committed) return 'Карта сыграна — ждём остальных игроков...';
  if (snap.phase === 'choose_row' && snap.waitingFor !== snap.you) {
    const w = snap.players.find(p => p.id === snap.waitingFor);
    return `${w ? w.avatar + ' ' + w.name : 'Соперник'} выбирает ряд для забора...`;
  }
  return null;
}

function currentPickKey() {
  return 'r' + state.round + 't' + Math.max(0, state.turn - 1);
}

MP.canAct = function () {
  return !!(state && state.phase === 'pick' && !MP.submittedKeys.has(currentPickKey()));
};

function reconstructBaseRows(rows, events) {
  const r = rows.map(x => x.slice());
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.t === 'place') {
      const row = r[ev.row];
      if (row.length && row[row.length - 1] === ev.card) row.pop();
    } else {
      r[ev.row] = ev.cards.slice();
    }
  }
  return r;
}

function mapPlayers(snap) {
  return snap.players.map(p => ({
    id: p.id,
    name: p.name,
    isBot: p.isBot,
    avatar: p.avatar,
    host: p.host,
    hand: p.id === snap.you ? snap.hand.slice() : [],
    handCount: p.handCount,
    taken: p.id === snap.you ? snap.myTaken.slice() : [],
    takenCount: p.takenCount,
    takenPts: p.takenPts,
    total: p.total,
    committed: p.committed,
  }));
}

function buildLocalState(snap) {
  state = {
    players: mapPlayers(snap),
    rows: reconstructBaseRows(snap.rows, snap.events || []),
    round: snap.round,
    turn: snap.turn,
    played: (snap.revealed || []).map(r => ({
      player: snap.players.find(p => p.id === r.pid),
      card: r.card,
      active: false,
      done: false,
    })),
    lastPlaced: null,
    phase: mapPhase(snap),
    waitingFor: snap.waitingFor,
    stripHint: stripHintFor(snap),
    resolveHumanCard: card => MP.submitCard(card),
    resolveRowPick: idx => MP.chooseRow(idx),
  };
  ui.selected = null;
}

function refreshLocalMeta(snap) {
  const prevSelected = ui.selected;
  state.players = mapPlayers(snap);
  state.round = snap.round;
  state.turn = snap.turn;
  state.phase = mapPhase(snap);
  state.waitingFor = snap.waitingFor;
  state.stripHint = stripHintFor(snap);
  if (prevSelected != null && !state.players[0].hand.includes(prevSelected)) {
    ui.selected = null;
  }
}

MP.process = function (snap) {
  if (snap.phase === 'pick' && !els.overlay.classList.contains('hidden') && MP.modalKey) {
    els.overlay.classList.add('hidden');
  }

  const freshView = !state;
  const sameTurn = !freshView && MP.localTurnKey === snap.turnKey;

  if (!sameTurn) {
    if (MP.localTurnKey && snap.round === 1 && snap.turn === 1) {
      MP.submittedKeys.clear();
      MP.modalKey = null;
    }
    buildLocalState(snap);
    MP.localTurnKey = snap.turnKey;
    MP.animatedKey = snap.turnKey;
    const skipAnim = freshView && snap.phase === 'pick';
    if (skipAnim) {
      MP.animatedCount = (snap.events || []).length;
      state.rows = snap.rows.map(r => r.slice());
    } else {
      MP.animatedCount = 0;
    }
  } else {
    refreshLocalMeta(snap);
  }

  const pending = (snap.events || []).slice(MP.animatedCount);

  if (pending.length) {
    MP.animating = true;
    MP.animate(pending).then(() => {
      MP.animatedCount = (snap.events || []).length;
      MP.animating = false;
      if (MP.queuedSnap) {
        const q = MP.queuedSnap;
        MP.queuedSnap = null;
        MP.process(q);
      } else {
        MP.postProcess(snap);
      }
    });
  } else {
    MP.postProcess(snap);
  }
};

function mpPlayerById(id) {
  return state.players.find(p => p.id === id) || null;
}

function mpEventText(ev, p) {
  if (ev.t === 'sixth') return `${p.avatar} ${p.name}: шестая корова! Карта ${ev.card} сносит ряд (${ev.pts} 🐮)!`;
  if (ev.t === 'forced') return `${p.avatar} ${p.name}: карта ${ev.card} меньше всех — забирает ряд (${ev.pts} 🐮)!`;
  return `${p.avatar} ${p.name} кладёт карту ${ev.card} в ряд ${ev.row + 1}.`;
}

MP.animate = async function (pending) {
  for (const ev of pending) {
    const p = mpPlayerById(ev.pid);
    if (!p) continue;
    const entry = state.played.find(e => e.player && e.player.id === ev.pid);
    if (entry) entry.active = true;
    renderPlayedStrip();
    await sleep(250);

    if (ev.t === 'place') {
      state.rows[ev.row].push(ev.card);
    } else {
      p.taken.push(...ev.cards);
      p.takenCount = p.taken.length;
      p.takenPts = (p.takenPts || 0) + ev.pts;
      state.rows[ev.row] = [ev.card];
    }
    state.lastPlaced = { rowIndex: ev.row, card: ev.card };
    addLog(mpEventText(ev, p), ev.pid === MP.myId ? 'you' : 'bot');
    renderAll();
    await flashRow(ev.row);

    if (entry) {
      entry.active = false;
      entry.done = true;
    }
    renderPlayedStrip();
    await sleep(120);
  }
};

MP.postProcess = function (snap) {
  renderAll();
  if (snap.phase === 'round_end' && MP.modalKey !== snap.turnKey) {
    MP.modalKey = snap.turnKey;
    MP.showRoundSummary(snap);
  } else if (snap.phase === 'game_end' && MP.modalKey !== 'gameover') {
    MP.modalKey = 'gameover';
    MP.showGameOver(snap);
  }
};

MP.submitCard = function (card) {
  if (!state || !MP.canAct()) return;
  MP.submittedKeys.add(currentPickKey());
  state.phase = 'locked';
  state.stripHint = 'Карта сыграна — ждём остальных игроков...';
  ui.selected = null;
  renderAll();
  mpApi('play', { card })
    .then(() => setTimeout(() => MP.tick(), 250))
    .catch(e => {
      MP.submittedKeys.delete(currentPickKey());
      addLog('Ошибка: ' + e.message, 'warn');
      MP.tick();
    });
};

MP.chooseRow = function (idx) {
  if (!state || state.phase !== 'choose-row') return;
  state.phase = 'locked';
  renderRows();
  updateBanner();
  mpApi('choose_row', { row: idx })
    .then(() => setTimeout(() => MP.tick(), 200))
    .catch(e => {
      addLog('Ошибка: ' + e.message, 'warn');
      MP.tick();
    });
};

MP.showRoundSummary = function (snap) {
  const entries = [...(snap.summary || [])].sort((a, b) => a.total - b.total)
    .map(s => ({
      avatar: s.avatar,
      name: s.name,
      me: s.pid === snap.you,
      count: s.count,
      roundPts: s.roundPts,
      total: s.total,
    }));
  els.overlayContent.innerHTML = `
    <h2>📋 Конец тура ${snap.round}</h2>
    <p class="subtitle">Штрафные очки за тур добавлены к общему счёту.</p>
    ${scoreTableHtml(entries)}
    <p id="mp-auto-next" class="subtitle"></p>
    <button id="mp-leave" class="btn secondary" style="margin-top:6px">Покинуть игру</button>`;
  els.overlay.classList.remove('hidden');

  if (MP.autoTimer) { clearInterval(MP.autoTimer); MP.autoTimer = null; }
  const tickCountdown = () => {
    const el = $('#mp-auto-next');
    if (!el) { clearInterval(MP.autoTimer); MP.autoTimer = null; return; }
    const left = Math.max(0, Math.ceil((snap.roundEndAt + snap.pause) - Date.now() / 1000));
    el.textContent = left > 0
      ? `⏳ Следующий тур через ${left} с…`
      : '⏳ Начинаем следующий тур…';
  };
  tickCountdown();
  MP.autoTimer = setInterval(tickCountdown, 500);

  $('#mp-leave').addEventListener('click', () => {
    if (MP.autoTimer) { clearInterval(MP.autoTimer); MP.autoTimer = null; }
    els.overlay.classList.add('hidden');
    MP.leave();
  });
};

MP.showGameOver = function (snap) {
  const sorted = [...(snap.summary || [])].sort((a, b) => a.total - b.total);
  const minScore = sorted.length ? sorted[0].total : 0;
  const winners = sorted.filter(s => s.total === minScore);
  const losers = sorted.filter(s => s.total >= LOSE_AT);
  const meIsHost = snap.hostId === snap.you;

  const titleFor = s => {
    if (winners.includes(s)) return '<div class="final-title winner">⭐ Звезда Коровьего Шпионажа!</div>';
    if (losers.includes(s)) return '<div class="final-title loser">👑 Повелитель Коров</div>';
    return '';
  };

  els.overlayContent.innerHTML = `
    <h2>🏆 Результаты игры</h2>
    <p class="subtitle">Побед${winners.length > 1 ? 'или' : 'ил'} ${winners.map(w => escapeHtml(w.name)).join(', ')} — всего ${minScore} штрафных очков!</p>
    ${sorted.map(s => `
      <div style="margin-bottom:10px">
        <strong>${s.avatar} ${escapeHtml(s.name)}</strong> — ${s.total} очков
        ${titleFor(s)}
      </div>`).join('')}
    ${meIsHost ? '<button id="mp-rematch" class="btn primary">🔄 Реванш</button>' : '<p class="subtitle">Ждём решения хозяина комнаты...</p>'}
    <button id="mp-exit" class="btn secondary" style="margin-left:10px">В меню</button>`;
  els.overlay.classList.remove('hidden');

  if (meIsHost) {
    $('#mp-rematch').addEventListener('click', () => {
      mpApi('rematch').then(() => MP.tick()).catch(e => {
        addLog('Ошибка: ' + e.message, 'warn');
        MP.tick();
      });
    });
  }
  $('#mp-exit').addEventListener('click', () => MP.leave());
};

MP.leave = async function () {
  try { await mpApi('leave'); } catch (e) {}
  MP.clearSession();
  MP.hardReset();
  showMainMenu();
};
