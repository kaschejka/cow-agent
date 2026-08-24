'use strict';

const CARD_TOTAL = 104;
const HAND_SIZE = 10;
const ROW_COUNT = 4;
const LOSE_AT = 66;

const $ = sel => document.querySelector(sel);

const PLAYER_COLORS = ['#e0566b', '#e8a33d', '#4fbf74', '#4f9cf5', '#b07ef0', '#3fc2c9'];
function playerColor(id) {
  return PLAYER_COLORS[((id % PLAYER_COLORS.length) + PLAYER_COLORS.length) % PLAYER_COLORS.length];
}

const els = {
  rows: $('#rows'),
  hand: $('#hand'),
  players: $('#players'),
  playedStrip: $('#played-strip'),
  banner: $('#banner'),
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

const BOT_NAMES = [
  'Рокки', 'Полоскун', 'Полосатик', 'Воришка', 'Ловкач', 'Шустрик',
  'Мася', 'Тучка', 'Елисей', 'Пуговка', 'Мадам Полоска', 'Барон Ракун',
  'Агент Хвост', 'Дон Енотов', 'Резидент 004', 'Енот Стив',
];

function pickBotNames(n) {
  const pool = [...BOT_NAMES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

function makePlayers(botCount) {
  const avatars = ['🤖', '🐾', '🕵️', '🎩', '🧢'];
  const names = pickBotNames(botCount);
  const players = [{
    id: 0, name: 'Вы', isBot: false, avatar: '🦝',
    hand: [], taken: [], total: 0,
  }];
  for (let i = 1; i <= botCount; i++) {
    players.push({
      id: i, name: names[i - 1] || ('Бот ' + i), isBot: true, avatar: avatars[(i - 1) % avatars.length],
      hand: [], taken: [], total: 0,
    });
  }
  return players;
}

function addLog() {}

function cardInner(n) {
  const pts = cardPoints(n);
  if (pts === 7) {
    return `<span class="num">${n}</span><span class="cows pips pips7">${'<i>🍩</i>'.repeat(7)}</span>`;
  }
  if (pts >= 5) {
    return `<span class="num">${n}</span><span class="cows pips pips${pts}">${'<i>🍩</i>'.repeat(pts - 1)}</span>`;
  }
  return `<span class="num">${n}</span><span class="cows">${'🍩'.repeat(pts)}</span>`;
}

function cardHtml(n, extra) {
  const pts = cardPoints(n);
  const face = pts >= 5 ? ' pipface' : '';
  return `<div class="card ${extra || ''} p${pts}${face}" data-card="${n}">${cardInner(n)}</div>`;
}

function renderRows() {
  const selectable = state.phase === 'choose-row';
  els.rows.innerHTML = state.rows.map((row, i) => {
    const cards = row.map(n => {
      const fresh = state.lastPlaced && state.lastPlaced.rowIndex === i && state.lastPlaced.card === n;
      return cardHtml(n, 'small' + (fresh ? ' just-placed' : ''));
    }).join('');
    return `<div class="row${selectable ? ' selectable' : ''}" data-row="${i}">
      <div class="row-score" title="Ряд ${i + 1}"><span class="rs-num">${rowPoints(row)}</span><span class="rs-cow">🍩</span></div>
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
  els.players.innerHTML = state.players.map(p => {
    const handN = p.handCount != null ? p.handCount : p.hand.length;
    const roundPts = p.takenPts != null ? p.takenPts : rowPoints(p.taken);
    const committed = p.committed != null
      ? p.committed
      : (state.played && state.played.some(e => e.player === p));
    const hostBadge = p.host ? ' 👑' : '';
    const ratingBadge = p.rating != null
      ? ` <span class="rating-badge" title="Рейтинг">★${p.rating}</span>`
      : '';
    const right = committed
      ? '<span class="committed" title="Карта на этот ход заявлена"></span>'
      : '';
    const stats = `Очки: <b>${p.total}</b> · Тур: <b>${roundPts == null ? '—' : '+' + roundPts}</b> · Карт: <b>${handN}</b>`;
    return `<div class="opp${p.isBot ? '' : ' human'}" data-pid="${p.id}" style="--pc:${playerColor(p.id)}">
      <span class="avatar">${p.avatar}</span>
      <span class="opp-body">
        <span class="opp-name">${p.name}${hostBadge}${ratingBadge}</span>
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

function spawnDonutRain(pid, pts) {
  const target = document.querySelector(`#players .opp[data-pid="${pid}"]`);
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const n = Math.max(4, Math.min(14, pts || 3));
  for (let i = 0; i < n; i++) {
    const el = document.createElement('span');
    el.className = 'donut-fall';
    el.textContent = '🍩';
    const tx = rect.left + 12 + Math.random() * Math.max(30, rect.width - 34);
    const ty = rect.top + 6 + Math.random() * Math.max(10, Math.min(30, rect.height - 12));
    el.style.left = cx + 'px';
    el.style.top = cy + 'px';
    document.body.appendChild(el);
    const dx = tx - cx;
    const dy = ty - cy;
    const bend = Math.random() * 120 - 60;
    const rot = Math.random() * 260 - 130;
    el.animate([
      { transform: 'translate(-50%,-50%) scale(1.5) rotate(0deg)', opacity: 0 },
      { transform: 'translate(-50%,-50%) scale(1.15) rotate(40deg)', opacity: 1, offset: .18 },
      { transform: `translate(calc(-50% + ${dx * .55 + bend}px), calc(-50% + ${dy * .45 - 40}px)) scale(.9) rotate(${rot * .6}deg)`, opacity: 1, offset: .62 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.45) rotate(${rot}deg)`, opacity: .95, offset: .92 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.3) rotate(${rot}deg)`, opacity: 0 }
    ], { duration: 1050 + Math.random() * 420, delay: i * 60, easing: 'cubic-bezier(.3,.7,.35,1)' })
      .onfinish = () => el.remove();
  }
  target.classList.remove('gain');
  void target.offsetWidth;
  target.classList.add('gain');
}

function cheapestRowIndex() {  let best = [];
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
    armSoloTimer();
    addLog('Ваша карта меньше всех крайних — выберите ряд, который заберёте!', 'warn');
    state.resolveRowPick = idx => {
      state.resolveRowPick = null;
      disarmSoloTimer();
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
    addLog(`${player.avatar} ${player.name}: карта ${card} меньше всех — забирает ряд (${pts} 🍩)!`, player.isBot ? 'bot' : 'you');
    renderAll();
    if (!player.isBot) spawnDonutRain(player.id, pts);
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
    addLog(`${player.avatar} ${player.name}: шестой енот! Карта ${card} сносит ряд (${pts} 🍩)!`, player.isBot ? 'bot' : 'you');
    if (!player.isBot) spawnDonutRain(player.id, pts);
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
  armSoloTimer();

  // Последняя карта в руке разыгрывается автоматически
  const human = state.players[0];
  if (human.hand.length === 1) {
    const lastCard = human.hand[0];
    addLog('Последняя карта — разыгрывается автоматически.', 'sys');
    setTimeout(() => {
      if (state && state.phase === 'pick'
        && typeof state.resolveHumanCard === 'function'
        && state.players[0].hand.includes(lastCard)) {
        state.resolveHumanCard(lastCard);
      }
    }, 700);
  }

  const humanCard = await new Promise(resolve => { state.resolveHumanCard = resolve; });
  disarmSoloTimer();
  await finishTurnAfterHuman(humanCard);
}

async function finishTurnAfterHuman(humanCard) {
  state.phase = 'locked';
  disarmSoloTimer();
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
  disarmSoloTimer();
  for (const p of state.players) p.total += rowPoints(p.taken);
  renderAll();

  const gameOver = state.players.some(p => p.total >= LOSE_AT);
  showRoundSummary(gameOver);
}

function scoreTableHtml(entries) {
  const placeIcon = n => n === 1 ? '🥇' : n === 2 ? '🥈' : n === 3 ? '🥉' : `#${n}`;
  const deltaHtml = e => e.ratingDelta == null ? '' :
    ` <span class="rating-delta ${e.ratingDelta >= 0 ? 'up' : 'down'}">★${e.ratingDelta >= 0 ? '+' : ''}${e.ratingDelta}</span>`;
  return `<table class="score-table">
    <tr><th>Игрок</th><th>Карт забрано</th><th>Очки за тур</th><th>Всего очков</th></tr>
    ${entries.map(e => `<tr class="${e.me ? 'me' : ''}">
      <td>${e.place != null ? placeIcon(e.place) + ' ' : ''}${e.avatar} ${e.name}${deltaHtml(e)}</td>
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

  const sorted = [...state.players].sort((a, b) => a.total - b.total);
  const minScore = sorted[0].total;
  const winners = sorted.filter(p => p.total === minScore);
  const losers = sorted.filter(p => p.total >= LOSE_AT);

  const titleFor = p => {
    if (winners.includes(p)) return '<div class="final-title winner">⭐ Звезда Енотьего Шпионажа!</div>';
    if (losers.includes(p)) return '<div class="final-title loser">👑 Повелитель Пончиков</div>';
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
    btn.title = 'Выйти в меню — текущая партия будет сброшена';
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

function showSoloSetup() {
  els.overlayContent.innerHTML = `
    <h2>🤖 Одиночная игра</h2>
    <p class="subtitle">«6 берёт!» — набери как можно меньше штрафных очков</p>
    <div class="rules-short">
      <p>У каждого игрока 10 карт. Каждый ход все выкладывают по одной карте, затем они вскрываются и раскладываются в 4 ряда по возрастанию — в ряд с минимальной разницей.</p>
      <p>⚠️ <b>Шестой енот:</b> если ваша карта стала 6-й в ряду — вы забираете весь ряд себе.</p>
      <p>⚠️ <b>Наименьшая карта:</b> если ваша карта меньше всех крайних — вы забираете любой ряд на выбор.</p>
      <p>Кто набирает 66+ штрафных очков — проигрывает и становится «Повелителем Пончиков». Осторожно: карта №55 стоит сразу 7 пончиков! Кратные 10 — по 3, оканчивающиеся на 5 — по 2, остальные — по 1.</p>
    </div>
    <label class="bot-picker">Соперников-ботов:
      <select id="bot-count">${[1, 2, 3, 4].map(n => `<option value="${n}"${n === 3 ? ' selected' : ''}>${n}</option>`).join('')}</select>
    </label>
    <label class="bot-picker">⏱ Контроль времени:
      <select id="time-limit">
        <option value="0" selected>Без контроля</option>
        <option value="60">1 минута на ход</option>
      </select>
    </label>
    <br>
    <button id="start-btn" class="btn primary">Начать игру</button>
    <button id="back-btn" class="btn secondary">← Назад</button>`;
  els.overlay.classList.remove('hidden');
  $('#start-btn').addEventListener('click', () => {
    const n = parseInt($('#bot-count').value, 10);
    const tl = parseInt($('#time-limit').value, 10);
    startGame(n, tl);
  });
  $('#back-btn').addEventListener('click', showMainMenu);
}

function startGame(botCount, timeLimit) {
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
    turnLimit: timeLimit > 0 ? timeLimit : null,
    turnDeadline: 0,
  };
  ui.selected = null;
  els.overlay.classList.add('hidden');
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

function armSoloTimer() {
  if (!state) return;
  state.turnDeadline = state.turnLimit ? Date.now() + state.turnLimit * 1000 : 0;
}

function disarmSoloTimer() {
  if (state) state.turnDeadline = 0;
}

function soloTimeoutAction() {
  if (!state || !state.turnDeadline || Date.now() < state.turnDeadline) return;
  state.turnDeadline = 0;
  if (state.phase === 'pick' && state.resolveHumanCard) {
    const human = state.players[0];
    const lowest = Math.min(...human.hand);
    const resolve = state.resolveHumanCard;
    state.resolveHumanCard = null;
    ui.selected = lowest;
    resolve(lowest);
  } else if (state.phase === 'choose-row' && state.resolveRowPick) {
    const resolve = state.resolveRowPick;
    state.resolveRowPick = null;
    resolve(cheapestRowIndex());
  }
}

function updateTurnTimerUI() {
  const el = document.getElementById('turn-timer');
  if (!el) return;
  let end = 0;
  if (MODE === 'solo' && state) end = state.turnDeadline || 0;
  else if (MODE === 'mp') end = (MP.turnEndAt || 0) * 1000;
  if (!end) { el.hidden = true; return; }
  const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
  el.hidden = false;
  el.textContent = '⏱ ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
  el.classList.toggle('low', left <= 10);
}

setInterval(() => {
  soloTimeoutAction();
  updateTurnTimerUI();
  const chatEl = document.getElementById('chat-box');
  if (chatEl) chatEl.hidden = MODE !== 'mp';
}, 250);

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

$('#net-btn').addEventListener('click', () => {
  if (MP.room && MP.token) { MP.refreshRooms(); return; }
  $('#mp-error').textContent = '';
  $('#net-panel').classList.toggle('hidden');
});

async function createNetRoom(max) {
  const name = playerName();
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

$('#mp-rooms').addEventListener('click', e => {
  if (e.target.closest('[data-leave]')) { MP.leaveFromMenu(); return; }
  const btn = e.target.closest('[data-room]');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  MP.joinRoom(btn.dataset.room, btn);
});

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
  showMainMenu();
})();
