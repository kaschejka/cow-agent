'use strict';

const CARD_TOTAL = 104;
const HAND_SIZE = 10;
const ROW_COUNT = 4;
const LOSE_AT = 66;

const $ = sel => document.querySelector(sel);

const els = {
  rows: $('#rows'),
  hand: $('#hand'),
  opponents: $('#opponents'),
  playedStrip: $('#played-strip'),
  banner: $('#banner'),
  log: $('#log'),
  playBtn: $('#play-btn'),
  roundInfo: $('#round-info'),
  turnInfo: $('#turn-info'),
  overlay: $('#overlay'),
  overlayContent: $('#overlay-content'),
  layout: $('#layout'),
  menuScreen: $('#menu-screen'),
};

let state = null;
let ui = { selected: null };
let MODE = 'menu';

function canPick() {
  if (!state || state.phase !== 'pick') return false;
  if (MODE === 'mp') return typeof MP !== 'undefined' && MP.canAct();
  return true;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function cardPoints(n) {
  if (n === 55) return 7;
  if (n % 10 === 0) return 3;
  if (n % 10 === 5) return 2;
  return 1;
}

function rowPoints(row) {
  return row.reduce((s, n) => s + cardPoints(n), 0);
}

function shuffledDeck() {
  const d = Array.from({ length: CARD_TOTAL }, (_, i) => i + 1);
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function makePlayers(botCount) {
  const avatars = ['🤖', '🐄', '🕵️', '🚜', '🧢'];
  const players = [{
    id: 0, name: 'Вы', isBot: false, avatar: '🧑‍🌾',
    hand: [], taken: [], total: 0,
  }];
  for (let i = 1; i <= botCount; i++) {
    players.push({
      id: i, name: 'Бот ' + i, isBot: true, avatar: avatars[(i - 1) % avatars.length],
      hand: [], taken: [], total: 0,
    });
  }
  return players;
}

function addLog(msg, type) {
  const line = document.createElement('div');
  line.className = 'log-line ' + (type || 'sys');
  line.textContent = msg;
  els.log.prepend(line);
  while (els.log.children.length > 80) els.log.lastChild.remove();
}

function cardInner(n) {
  return `<span class="num">${n}</span><span class="cows">${'🐮'.repeat(cardPoints(n))}</span>`;
}

function cardHtml(n, extra) {
  return `<div class="card ${extra || ''} p${cardPoints(n)}" data-card="${n}">${cardInner(n)}</div>`;
}

function renderRows() {
  const selectable = state.phase === 'choose-row';
  els.rows.innerHTML = state.rows.map((row, i) => {
    const cards = row.map(n => {
      const fresh = state.lastPlaced && state.lastPlaced.rowIndex === i && state.lastPlaced.card === n;
      return cardHtml(n, 'small' + (fresh ? ' just-placed' : ''));
    }).join('');
    return `<div class="row${selectable ? ' selectable' : ''}" data-row="${i}">
      <div class="row-label">Ряд ${i + 1} · ${rowPoints(row)}🐮</div>
      <div class="row-cards">${cards}</div>
    </div>`;
  }).join('');
}

function renderHand() {
  const human = state.players[0];
  const pickable = canPick();
  els.hand.innerHTML = human.hand.map(c =>
    `<div class="card hand-card p${cardPoints(c)}${ui.selected === c ? ' selected' : ''}${pickable ? ' pickable' : ''}" data-card="${c}">${cardInner(c)}</div>`
  ).join('') || '<span class="strip-hint">Рука пуста</span>';
  els.playBtn.classList.toggle('hidden', !pickable);
  els.playBtn.disabled = !(pickable && ui.selected != null);
}

function renderOpponents() {
  els.opponents.innerHTML = state.players.map(p => {
    const handN = p.handCount != null ? p.handCount : p.hand.length;
    const roundPts = p.takenPts != null ? p.takenPts : rowPoints(p.taken);
    const committed = p.committed != null
      ? p.committed
      : (state.played && state.played.some(e => e.player === p));
    const hostBadge = p.host ? ' 👑' : '';
    const right = committed
      ? '<span class="committed" title="Карта на этот ход заявлена"></span>'
      : '';
    const stats = `Очки: <b>${p.total}</b> · Тур: <b>${roundPts == null ? '—' : '+' + roundPts}</b> · Карт: <b>${handN}</b>`;
    return `<div class="opp${p.isBot ? '' : ' human'}">
      <span class="avatar">${p.avatar}</span>
      <span class="opp-body">
        <span class="opp-name">${p.name}${hostBadge}</span>
        <span class="opp-stats">${stats}</span>
      </span>
      <span class="opp-right">${right}</span>
    </div>`;
  }).join('');
}

function renderPlayedStrip() {
  if (!state.played || !state.played.length) {
    els.playedStrip.innerHTML = `<span class="strip-hint">${
      state.stripHint || (state.phase === 'pick'
        ? 'Выберите карту из руки — все открывают карты одновременно'
        : 'Ставки этого хода появятся здесь')
    }</span>`;
    return;
  }
  els.playedStrip.innerHTML = state.played.map(e =>
    `<div class="played-entry${e.active ? ' active' : ''}${e.done ? ' done' : ''}">
      <span class="pe-name">${e.player.avatar} ${e.player.name}</span>
      ${cardHtml(e.card, 'small')}
    </div>`
  ).join('');
}

function updateStatusBar() {
  els.roundInfo.textContent = 'Тур ' + state.round;
  els.turnInfo.textContent = 'Ход ' + Math.min(Math.max(state.turn, 1), HAND_SIZE) + '/' + HAND_SIZE;
}

function updateBanner() {
  els.banner.classList.toggle('hidden', state.phase !== 'choose-row');
}

function renderAll() {
  renderOpponents();
  renderRows();
  renderHand();
  renderPlayedStrip();
  updateStatusBar();
  updateBanner();
}

async function flashRow(index) {
  const el = els.rows.querySelector(`.row[data-row="${index}"]`);
  if (el) el.classList.add('flash');
  await sleep(550);
  if (el) el.classList.remove('flash');
  state.lastPlaced = null;
}

function cheapestRowIndex() {
  let best = [];
  let bestPts = Infinity;
  state.rows.forEach((row, i) => {
    const pts = rowPoints(row);
    if (pts < bestPts) { bestPts = pts; best = [i]; }
    else if (pts === bestPts) best.push(i);
  });
  return best[Math.floor(Math.random() * best.length)];
}

function botChooseCard(bot) {
  let best = null;
  for (const card of bot.hand) {
    const opts = state.rows
      .map(row => ({ row, last: row[row.length - 1] }))
      .filter(o => o.last < card);
    let cost;
    if (!opts.length) {
      cost = Math.min(...state.rows.map(rowPoints)) + 2;
    } else {
      opts.sort((a, b) => (card - a.last) - (card - b.last) || a.row.length - b.row.length);
      const t = opts[0];
      if (t.row.length >= 5) cost = rowPoints(t.row) + 1.5;
      else cost = (card - t.last) * 0.06 + (t.row.length === 4 ? 0.9 : 0) + Math.random() * 0.25;
    }
    if (!best || cost < best.cost) best = { card, cost };
  }
  return best.card;
}

function askHumanTakeRow() {
  return new Promise(resolve => {
    state.phase = 'choose-row';
    renderAll();
    addLog('Ваша карта меньше всех крайних — выберите ряд, который заберёте!', 'warn');
    state.resolveRowPick = idx => {
      state.resolveRowPick = null;
      state.phase = 'locked';
      renderRows();
      updateBanner();
      resolve(idx);
    };
  });
}

async function placeCard(player, card) {
  if (!state) return;
  const options = state.rows
    .map((row, i) => ({ i, row, last: row[row.length - 1] }))
    .filter(o => o.last < card);

  if (!options.length) {
    let idx;
    if (player.isBot) {
      idx = cheapestRowIndex();
      await sleep(500);
    } else {
      idx = await askHumanTakeRow();
    }
    const pts = rowPoints(state.rows[idx]);
    player.taken.push(...state.rows[idx]);
    state.rows[idx] = [card];
    state.lastPlaced = { rowIndex: idx, card };
    addLog(`${player.avatar} ${player.name}: карта ${card} меньше всех — забирает ряд (${pts} 🐮)!`, player.isBot ? 'bot' : 'you');
    renderAll();
    await flashRow(idx);
    return;
  }

  options.sort((a, b) => (card - a.last) - (card - b.last) || a.row.length - b.row.length);
  const target = options[0];

  if (target.row.length >= 5) {
    const pts = rowPoints(target.row);
    player.taken.push(...target.row);
    state.rows[target.i] = [card];
    state.lastPlaced = { rowIndex: target.i, card };
    addLog(`${player.avatar} ${player.name}: шестая корова! Карта ${card} сносит ряд (${pts} 🐮)!`, player.isBot ? 'bot' : 'you');
  } else {
    target.row.push(card);
    state.lastPlaced = { rowIndex: target.i, card };
    addLog(`${player.avatar} ${player.name} кладёт карту ${card} в ряд ${target.i + 1}.`, player.isBot ? 'bot' : 'you');
  }
  renderAll();
  await flashRow(target.i);
}

async function playTurn() {
  state.turn++;
  state.played = [];
  state.phase = 'pick';
  ui.selected = null;
  renderAll();
  saveSolo();

  const humanCard = await new Promise(resolve => { state.resolveHumanCard = resolve; });
  await finishTurnAfterHuman(humanCard);
}

async function finishTurnAfterHuman(humanCard) {
  state.phase = 'locked';
  const human = state.players[0];
  human.hand = human.hand.filter(c => c !== humanCard);
  state.played.push({ player: human, card: humanCard });

  for (const p of state.players) {
    if (!p.isBot) continue;
    const c = botChooseCard(p);
    p.hand = p.hand.filter(x => x !== c);
    state.played.push({ player: p, card: c });
  }

  state.played.sort((a, b) => a.card - b.card);
  ui.selected = null;
  renderAll();
  addLog(`— Ход ${state.turn}: карты открыты —`, 'sys');
  await sleep(900);

  for (const entry of state.played) {
    entry.active = true;
    renderPlayedStrip();
    await placeCard(entry.player, entry.card);
    if (!state) return;
    entry.active = false;
    entry.done = true;
    renderPlayedStrip();
    await sleep(250);
    if (!state) return;
  }

  if (state.turn >= HAND_SIZE) endRound();
  else playTurn();
}

function startRound() {
  state.round++;
  state.turn = 0;
  state.played = [];
  state.lastPlaced = null;

  const deck = shuffledDeck();
  for (const p of state.players) {
    p.taken = [];
    p.hand = deck.splice(0, HAND_SIZE).sort((a, b) => a - b);
  }
  state.rows = Array.from({ length: ROW_COUNT }, () => [deck.pop()]);

  state.phase = 'dealing';
  renderAll();
  addLog(`— Тур ${state.round}: колода перемешана, розданы карты —`, 'sys');
  playTurn();
}

function endRound() {
  state.phase = 'round-end';
  for (const p of state.players) p.total += rowPoints(p.taken);
  renderAll();
  saveSolo();
  const gameOver = state.players.some(p => p.total >= LOSE_AT);
  showRoundSummary(gameOver);
}

function scoreTableHtml(entries) {
  return `<table class="score-table">
    <tr><th>Игрок</th><th>Карт забрано</th><th>Очки за тур</th><th>Всего очков</th></tr>
    ${entries.map(e => `<tr class="${e.me ? 'me' : ''}">
      <td>${e.avatar} ${e.name}</td>
      <td>${e.count}</td>
      <td class="pts-round">+${e.roundPts}</td>
      <td class="pts-total">${e.total}</td>
    </tr>`).join('')}
  </table>`;
}

function showRoundSummary(gameOver) {
  const sorted = [...state.players].sort((a, b) => a.total - b.total);
  const entries = sorted.map(p => ({
    avatar: p.avatar,
    name: p.name,
    me: !p.isBot && MODE === 'solo',
    count: p.taken.length,
    roundPts: rowPoints(p.taken),
    total: p.total,
  }));
  els.overlayContent.innerHTML = `
    <h2>${gameOver ? '🏁 Игра окончена!' : '📋 Конец тура ' + state.round}</h2>
    <p class="subtitle">${gameOver
      ? 'Кто-то набрал ' + LOSE_AT + '+ штрафных очков. Пора подводить итоги!'
      : 'Штрафные очки за тур добавлены к общему счёту.'}</p>
    ${scoreTableHtml(entries)}
    <button id="next-btn" class="btn primary">${gameOver ? 'Итоги игры' : 'Следующий тур →'}</button>`;
  els.overlay.classList.remove('hidden');
  $('#next-btn').addEventListener('click', () => {
    els.overlay.classList.add('hidden');
    if (gameOver) showGameOver();
    else startRound();
  });
}

function showGameOver() {
  state.phase = 'game-end';
  saveSolo();
  const sorted = [...state.players].sort((a, b) => a.total - b.total);
  const minScore = sorted[0].total;
  const winners = sorted.filter(p => p.total === minScore);
  const losers = sorted.filter(p => p.total >= LOSE_AT);

  const titleFor = p => {
    if (winners.includes(p)) return '<div class="final-title winner">⭐ Звезда Коровьего Шпионажа!</div>';
    if (losers.includes(p)) return '<div class="final-title loser">👑 Повелитель Коров</div>';
    return '';
  };

  els.overlayContent.innerHTML = `
    <h2>🏆 Результаты игры</h2>
    <p class="subtitle">Победил${winners.length > 1 ? 'и' : ''} ${winners.map(w => w.name).join(', ')} — всего ${minScore} штрафных очков!</p>
    ${sorted.map(p => `
      <div style="margin-bottom:10px">
        <strong>${p.avatar} ${p.name}</strong> — ${p.total} очков
        ${titleFor(p)}
      </div>`).join('')}
    <button id="restart-btn" class="btn primary" style="margin-top:14px">Новая игра</button>`;
  els.overlay.classList.remove('hidden');
  $('#restart-btn').addEventListener('click', () => {
    els.overlay.classList.add('hidden');
    if (state && state.phase === 'game-end') localStorage.removeItem(SOLO_KEY);
    showMainMenu();
  });
}

function refreshExitBtn() {
  const show = (MODE === 'solo' && !!state) || (MODE === 'mp' && !!(MP.room && MP.token));
  const btn = $('#exit-btn');
  btn.classList.toggle('hidden', !show);
  if (MODE === 'mp') {
    btn.textContent = '🚪 Покинуть игру';
    btn.title = 'Выйти из игры; для остальных участников партия продолжится с ботом';
  } else {
    btn.textContent = '⌂ В меню';
    btn.title = 'Выйти в меню; прогресс сохранится и продолжится после перезагрузки';
  }
}

function showMenuScreen() {
  els.menuScreen.classList.remove('hidden');
  els.layout.classList.add('hidden');
  $('#status-bar').classList.add('hidden');
  $('#exit-btn').classList.add('hidden');
  els.layout.classList.remove('in-lobby');
  els.rows.classList.remove('hidden');
  els.overlay.classList.add('hidden');
  els.roundInfo.textContent = '';
  els.turnInfo.textContent = '';
}

function hideMenuScreen() {
  els.menuScreen.classList.add('hidden');
  els.layout.classList.remove('hidden');
  $('#status-bar').classList.remove('hidden');
  refreshExitBtn();
}

$('#exit-btn').addEventListener('click', () => {
  if (MODE === 'mp' && MP.room) { MP.leave(); return; }
  if (!state || state.phase === 'game-end') localStorage.removeItem(SOLO_KEY);
  els.overlay.classList.add('hidden');
  state = null;
  MODE = 'menu';
  ui.selected = null;
  showMainMenu();
});

function showMainMenu() {
  MODE = 'menu';
  state = null;
  ui.selected = null;
  showMenuScreen();
  $('#mp-error').textContent = '';
  MP.inMenuView = !!(MP.room && MP.token);
  const netBtn = $('#net-btn');
  netBtn.disabled = MP.inMenuView;
  netBtn.title = MP.inMenuView ? 'У вас уже есть комната' : '';
  if (MP.inMenuView) MP.startPoll(false);
  MP.startRoomList();
}

const SOLO_KEY = 'cow_solo_save';

function saveSolo() {
  if (MODE !== 'solo' || !state) return;
  try {
    localStorage.setItem(SOLO_KEY, JSON.stringify({
      players: state.players,
      rows: state.rows,
      round: state.round,
      turn: state.turn,
      phase: state.phase,
    }));
  } catch {}
}

function loadSolo() {
  try {
    const s = JSON.parse(localStorage.getItem(SOLO_KEY) || 'null');
    if (!s || !Array.isArray(s.players) || s.players.length < 2) return null;
    if (!Array.isArray(s.rows) || s.rows.length !== ROW_COUNT) return null;
    if (typeof s.round !== 'number' || typeof s.turn !== 'number') return null;
    if (!['pick', 'round-end', 'game-end'].includes(s.phase)) return null;
    return s;
  } catch { return null; }
}

async function resumeSoloTurn() {
  state.phase = 'pick';
  ui.selected = null;
  renderAll();
  const humanCard = await new Promise(resolve => { state.resolveHumanCard = resolve; });
  await finishTurnAfterHuman(humanCard);
}

function restoreSolo(s) {
  MODE = 'solo';
  hideMenuScreen();
  state = {
    players: s.players,
    rows: s.rows,
    round: s.round,
    turn: s.turn,
    played: [],
    lastPlaced: null,
    phase: s.phase,
    resolveHumanCard: null,
    resolveRowPick: null,
  };
  ui.selected = null;
  els.log.innerHTML = '';
  els.overlay.classList.add('hidden');
  addLog('Игра восстановлена — продолжаем с того же места.', 'sys');
  renderAll();
  refreshExitBtn();
  if (state.phase === 'pick') resumeSoloTurn();
  else if (state.phase === 'round-end') showRoundSummary(false);
  else showGameOver();
}

function showSoloSetup() {
  els.overlayContent.innerHTML = `
    <h2>🤖 Одиночная игра</h2>
    <p class="subtitle">«6 берёт!» — набери как можно меньше штрафных очков</p>
    <div class="rules-short">
      <p>У каждого игрока 10 карт-коров. Каждый ход все выкладывают по одной карте, затем они вскрываются и раскладываются в 4 ряда по возрастанию — в ряд с минимальной разницей.</p>
      <p>⚠️ <b>Шестая корова:</b> если ваша карта стала 6-й в ряду — вы забираете весь ряд себе.</p>
      <p>⚠️ <b>Наименьшая карта:</b> если ваша карта меньше всех крайних — вы забираете любой ряд на выбор.</p>
      <p>Кто набирает 66+ штрафных очков — проигрывает и становится «Повелителем Коров». Осторожно: карта №55 стоит сразу 7 очков! Кратные 10 — по 3, оканчивающиеся на 5 — по 2, остальные — по 1.</p>
    </div>
    <label class="bot-picker">Соперников-ботов:
      <select id="bot-count">${[1, 2, 3, 4].map(n => `<option value="${n}"${n === 3 ? ' selected' : ''}>${n}</option>`).join('')}</select>
    </label>
    <br>
    <button id="start-btn" class="btn primary">Начать игру</button>
    <button id="back-btn" class="btn secondary">← Назад</button>`;
  els.overlay.classList.remove('hidden');
  $('#start-btn').addEventListener('click', () => {
    const n = parseInt($('#bot-count').value, 10);
    startGame(n);
  });
  $('#back-btn').addEventListener('click', showMainMenu);
}

function startGame(botCount) {
  if (MP.room && MP.token) MP.leaveFromMenu();
  MODE = 'solo';
  hideMenuScreen();
  state = {
    players: makePlayers(botCount),
    rows: [],
    round: 0,
    turn: 0,
    played: [],
    lastPlaced: null,
    phase: 'idle',
    resolveHumanCard: null,
    resolveRowPick: null,
  };
  ui.selected = null;
  els.overlay.classList.add('hidden');
  els.log.innerHTML = '';
  addLog('Игра началась! Удачной охоты, агент! 🕵️', 'sys');
  refreshExitBtn();
  startRound();
}

els.hand.addEventListener('click', e => {
  const cardEl = e.target.closest('.hand-card');
  if (!cardEl || !canPick()) return;
  ui.selected = parseInt(cardEl.dataset.card, 10);
  renderHand();
});

els.playBtn.addEventListener('click', () => {
  if (!state || !canPick() || ui.selected == null) return;
  const card = ui.selected;
  const resolve = state.resolveHumanCard;
  if (!resolve) return;
  state.resolveHumanCard = null;
  resolve(card);
});

els.rows.addEventListener('click', e => {
  if (!state || !state.resolveRowPick) return;
  const rowEl = e.target.closest('.row');
  if (!rowEl) return;
  state.resolveRowPick(parseInt(rowEl.dataset.row, 10));
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#exit-btn').classList.contains('hidden')) {
    $('#exit-btn').click();
    return;
  }
  if (!state) return;
  if (e.key === 'Enter' && !els.playBtn.classList.contains('hidden') && !els.playBtn.disabled) {
    els.playBtn.click();
    return;
  }
  if (state.resolveRowPick && ['1', '2', '3', '4'].includes(e.key)) {
    const idx = parseInt(e.key, 10) - 1;
    if (idx >= 0 && idx < state.rows.length) state.resolveRowPick(idx);
  }
});

$('#solo-btn').addEventListener('click', () => {
  MP.stopRoomList();
  MP.stopPoll();
  MP.inMenuView = false;
  showSoloSetup();
});

function openSettings() {
  $('#net-panel').classList.add('hidden');
  $('#settings-panel').classList.remove('hidden');
  $('#mp-name').focus();
}

$('#net-btn').addEventListener('click', () => {
  if (MP.room && MP.token) { MP.refreshRooms(); return; }
  const name = ($('#mp-name').value || '').trim();
  if (!name) {
    $('#mp-error').textContent = 'Сначала задайте имя (⚙️)';
    openSettings();
    return;
  }
  localStorage.setItem('cow_mp_name', name);
  $('#mp-error').textContent = '';
  $('#settings-panel').classList.add('hidden');
  $('#net-panel').classList.toggle('hidden');
});

async function createNetRoom(max) {
  const name = ($('#mp-name').value || '').trim();
  $('#mp-error').textContent = '';
  $('#net-btn').disabled = true;
  try {
    const r = await mpApi('create', { name, max });
    MODE = 'mp';
    MP.setSession(r.room, r.token, r.you);
    MP.inMenuView = true;
    $('#net-btn').title = 'У вас уже есть комната';
    $('#net-panel').classList.add('hidden');
    MP.startPoll(false);
    MP.startRoomList();
  } catch (e) {
    $('#mp-error').textContent = e.message;
    $('#net-btn').disabled = false;
  }
}

$('#net-panel').addEventListener('click', e => {
  const btn = e.target.closest('[data-max]');
  if (!btn || btn.disabled) return;
  createNetRoom(parseInt(btn.dataset.max, 10));
});

$('#settings-btn').addEventListener('click', () => {
  $('#net-panel').classList.add('hidden');
  $('#settings-panel').classList.toggle('hidden');
  if (!$('#settings-panel').classList.contains('hidden')) $('#mp-name').focus();
});

$('#settings-done').addEventListener('click', () => {
  const n = $('#mp-name').value.trim();
  if (!n) { $('#mp-error').textContent = 'Имя не может быть пустым'; return; }
  localStorage.setItem('cow_mp_name', n);
  $('#settings-panel').classList.add('hidden');
  $('#mp-error').textContent = '';
});

$('#mp-rooms').addEventListener('click', e => {
  if (e.target.closest('[data-leave]')) { MP.leaveFromMenu(); return; }
  const btn = e.target.closest('[data-room]');
  if (!btn || btn.disabled) return;
  const name = localStorage.getItem('cow_mp_name') || '';
  if (!name) {
    $('#mp-error').textContent = 'Сначала задайте имя (⚙️)';
    openSettings();
    return;
  }
  btn.disabled = true;
  MP.joinRoom(btn.dataset.room, btn);
});

$('#mp-name').value = localStorage.getItem('cow_mp_name') || '';

(function boot() {
  const mpSession = typeof MP !== 'undefined' ? MP.loadSession() : null;
  if (mpSession) {
    els.overlayContent.innerHTML = `
      <h2>🔄 Переподключение...</h2>
      <p class="subtitle">Возвращаемся в текущую сетевую игру</p>`;
    els.overlay.classList.remove('hidden');
    els.layout.classList.add('hidden');
    $('#status-bar').classList.add('hidden');
    MP.resume();
    return;
  }
  const solo = loadSolo();
  if (solo) { restoreSolo(solo); return; }
  showMainMenu();
})();
