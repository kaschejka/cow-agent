'use strict';

/* ---------------------------------------------------------------------------
   Обучение: правила + интерактивный тур.
   Полностью переиспользует низкоуровневые функции отрисовки game.js
   (renderAll, renderHand, placeCard, ...) и НЕ затрагивает реальный игровой цикл.
--------------------------------------------------------------------------- */

const TUT = { active: false };

/* ============================ ПРАВИЛА (оверлей) ============================ */

const TUT_INTRO = [
  {
    title: 'Добро пожаловать, агент!',
    body: `«Еноты-агенты» — карточная игра, где главное — <b>не набрать очков</b>. Каждый ход все игроки одновременно выкладывают по одной карте, затем карты вскрываются и раскладываются на стол.`,
    bullets: ['Партия на 2–4 игрока', 'У каждого по 10 карт', 'Кто наберёт 66 штрафных пончиков 🍩 — проигрывает'],
  },
  {
    title: 'Стол и задача',
    body: `В центре <b>4 ряда</b>. Каждый ряд растёт по возрастанию — сверху лежит крайняя (самая старшая) карта ряда. Над рядом — счёт пончиков за ряд.`,
    bullets: [
      'В руке всегда 10 карт, все играются по очереди',
      'Каждая ваша карта уходит в один из рядов',
      'Старайтесь не брать ряды с дорогими пончиками',
    ],
  },
];

const TUT_RULES = [
  {
    title: 'Куда ляжет карта?',
    body: `Карта встаёт в <b>тот</b> ряд, чья крайняя карта — <b>ближайшее меньшее</b> число к вашей карте.`,
    bullets: [
      'У вас 41 → ищем ряды, где крайняя меньше 41',
      'Крайние 14 и 33 — оба меньше 41',
      'Ближе всех к 41 — число 33, значит карта ложится туда',
    ],
  },
  {
    title: 'Шестой енот 🍩',
    body: `Если ваша карта должна встать <b>шестой</b> в ряд (а там уже 5 карт) — вы <b>забираете весь ряд</b> себе как штраф.`,
    bullets: [
      'Забранные карты = штрафные пончики',
      'Ваша карта открывает ряд заново',
      'Смотрите счёт ряда, чтобы не забрать дорогой!',
    ],
  },
  {
    title: 'Карта меньше всех крайних',
    body: `Если ваша карта меньше крайних карт <b>всех</b> рядов — она никуда не встаёт. Придётся <b>выбрать ряд и забрать его</b> себе.`,
    bullets: [
      'Выбирайте самый «дешёвый» по пончикам ряд',
      'Либо избавляйтесь от опасного незаполненного ряда',
    ],
  },
  {
    title: 'Стоимость карт',
    body: `Штрафные пончики на картах считаются так:`,
    bullets: [
      'Карта №55 — сразу 7 🍩',
      'Кратные 10 — по 3 🍩',
      'Оканчиваются на 5 — по 2 🍩',
      'Все остальные — по 1 🍩',
    ],
    cardDemo: true,
  },
];

function tutCardSet(cards) {
  return cards.map(n => `<span class="tut-demo-card">${n}${'🍩'.repeat(cardPoints(n))}</span>`).join('');
}

function tutRulesHtml() {
  const intro = TUT_INTRO.map((s, i) => `<div class="tut-slide" data-slide="i${i}">
    <h3>${s.title}</h3>
    <p class="tut-body">${s.body}</p>
    <ul class="tut-bullets">${s.bullets.map(b => `<li>${b}</li>`).join('')}</ul>
  </div>`).join('');
  const rules = TUT_RULES.map((s, i) => `<div class="tut-slide" data-slide="r${i}">
    <h3>${s.title}</h3>
    <p class="tut-body">${s.body}</p>
    <ul class="tut-bullets">${s.bullets.map(b => `<li>${b}</li>`).join('')}</ul>
    ${s.cardDemo ? `<div class="tut-carddemo">${tutCardSet([55, 10, 30, 25, 7, 5])}</div>` : ''}
  </div>`).join('');
  return `<div id="tut-rules-wrap">${intro}${rules}</div>`;
}

function showTutorial() {
  els.overlayContent.innerHTML = `
    <button id="tut-rules-close" class="tut-x" title="Закрыть">✕</button>
    <h2>📖 Обучение</h2>
    <p class="subtitle">Сначала правила — потом потренируемся на живых примерах.</p>
    ${tutRulesHtml()}
    <div class="tut-nav">
      <button id="tut-rules-back" class="btn secondary hidden">← Назад</button>
      <span id="tut-rules-dots" class="tut-dots"></span>
      <button id="tut-rules-next" class="btn primary">Дальше →</button>
    </div>`;
  els.overlay.classList.remove('hidden');

  const slides = $$('#tut-rules-wrap .tut-slide');
  let cur = 0;
  const back = $('#tut-rules-back');
  const next = $('#tut-rules-next');
  const dots = $('#tut-rules-dots');

  const paint = () => {
    slides.forEach((s, i) => s.classList.toggle('hidden', i !== cur));
    back.classList.toggle('hidden', cur === 0);
    next.textContent = cur === slides.length - 1 ? '▶ Начать тренировку' : 'Дальше →';
    dots.innerHTML = slides.map((_, i) => `<span class="tut-dot${i === cur ? ' on' : ''}"></span>`).join('');
  };
  paint();

  back.addEventListener('click', () => { if (cur > 0) { cur--; paint(); } });
  $('#tut-rules-close').addEventListener('click', tutExit);
  next.addEventListener('click', () => {
    if (cur < slides.length - 1) { cur++; paint(); return; }
    els.overlay.classList.add('hidden');
    startTutorial();
  });
}

/* ============================ ТРЕНАЖЁР (в игре) ============================ */

function tutCoachEl() {
  let c = document.getElementById('tut-coach');
  if (c) return c;
  c = document.createElement('div');
  c.id = 'tut-coach';
  c.innerHTML = `
    <div class="tut-coach-step"></div>
    <div class="tut-coach-actions">
      <span id="tut-coach-phase" class="tut-coach-phase"></span>
      <button id="tut-coach-exit" class="btn secondary">✕ Выйти</button>
      <button id="tut-coach-next" class="btn primary">Дальше →</button>
    </div>`;
  const col = document.getElementById('game-col');
  if (col) col.prepend(c);
  else document.body.appendChild(c);
  c.querySelector('#tut-coach-exit').addEventListener('click', tutExit);
  return c;
}

function tutCoach(stepHtml, nextLabel, phase) {
  const c = tutCoachEl();
  c.classList.remove('hidden');
  c.querySelector('.tut-coach-step').innerHTML = stepHtml;
  c.classList.add('tut-read');
  const ph = c.querySelector('#tut-coach-phase');
  ph.textContent = phase || '';
  ph.classList.toggle('hidden', !phase);
  const next = c.querySelector('#tut-coach-next');
  if (nextLabel === null) next.classList.add('hidden');
  else next.classList.remove('hidden');
  if (nextLabel) next.textContent = nextLabel;
  return next;
}

function tutCoachNext(fn) {
  const next = tutCoachEl().querySelector('#tut-coach-next');
  next.onclick = fn;
}

function tutTimerOff() {
  if (state) state.turnLimit = null;
  if (typeof disarmSoloTimer === 'function') disarmSoloTimer();
}

function tutExit() {
  TUT.active = false;
  TUT.required = null;
  const c = document.getElementById('tut-coach');
  if (c) c.classList.add('hidden');
  $$('.tut-target, .tut-label').forEach(l => l.classList.remove('tut-target', 'tut-label'));
  tutHighlightHand(false);
  tutIntroPanels(false);
  els.overlay.classList.add('hidden');
  showMainMenu();
}

function tutBuildHuman(name) {
  return { id: 0, name: name || 'Вы', isBot: false, avatar: '🦝', hand: [], taken: [], total: 0 };
}

function tutSetState(human, rows, turn) {
  state = {
    players: [human],
    rows,
    round: 1,
    turn: turn || 1,
    played: [],
    lastPlaced: null,
    phase: 'idle',
    resolveHumanCard: null,
    resolveRowPick: null,
    turnLimit: null,
    turnDeadline: 0,
  };
}

function tutPrepPick(human, required) {
  TUT.required = required;
  state.phase = 'pick';
  tutTimerOff();
  const coach = document.getElementById('tut-coach');
  if (coach) coach.classList.remove('tut-read');
  renderAll();
  ui.selected = null;
  tutHighlightHand(true);
  return new Promise(resolve => {
    state.resolveHumanCard = card => {
      state.resolveHumanCard = null;
      state.phase = 'locked';
      ui.selected = null;
      TUT.required = null;
      resolve(card);
    };
  });
}

function tutHighlightRow(idx, on) {
  const el = els.rows.querySelector(`.row[data-row="${idx}"]`);
  if (el) el.classList.toggle('tut-target', !!on);
}

function tutHighlightHand(on) {
  const wrap = document.getElementById('hand');
  if (!wrap) return;
  if (on) {
    wrap.classList.add('tut-pick');
    const req = TUT.required;
    wrap.querySelectorAll('.hand-card').forEach(el => {
      el.classList.remove('tut-required');
      if (parseInt(el.dataset.card, 10) === req) el.classList.add('tut-required');
    });
  } else {
    wrap.classList.remove('tut-pick');
    wrap.querySelectorAll('.hand-card.tut-required').forEach(el => el.classList.remove('tut-required'));
  }
}

/* После раскладки карты очищаем полосу сыгранных карт — карта уже ушла в ряд. */
function tutAfterPlay() {
  if (!state) return;
  state.played = [];
  renderPlayedStrip();
}

/* Скрыть/показать игровое поле на вводном шаге тренировки (Шаг 0):
   стол с рядами (table-wrap), столбец игроков и руку игрока. */
function tutIntroPanels(hide) {
  const ids = ['table-wrap', 'sidebar', 'hand-area'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !!hide);
  });
}

async function tutStageA() {
  if (!TUT.active) return;
  tutIntroPanels(false);
  const human = tutBuildHuman();
  human.hand = [41, 12, 78];
  const rows = [[3, 9, 14], [27, 33], [50, 52, 55], [64]];
  tutSetState(human, rows, 1);
  state.players = [human];
  renderAll();
  tutHighlightRow(1, true);

  tutCoach(
    `🃏 <b>Механика 1 — «Ближайший меньший ряд»</b><br><br>
    Смотри на стол: <b>ряд 2</b> оканчивается на <b>33</b> (подсвечен).<br><br>
    Выбери в руке карту <b>41</b> и нажми «Сыграть карту» — увидим, куда она ляжет.`,
    'К выбору карты →', 'Шаг 2 из 5'
  );
  tutCoachNext(async () => {
    const pickPromise = tutPrepPick(human, 41);
    tutHighlightRow(1, true);
    const card = await pickPromise;
    tutHighlightHand(false);
    human.hand = human.hand.filter(c => c !== card);
    state.played.push({ player: human, card });
    renderAll();
    tutTimerOff();
    await placeCard(human, card);
    tutAfterPlay();
    if (!TUT.active) return;
    tutCoach(
      `✅ <b>Верно!</b> Карта <b>${card}</b> легла в <b>ряд 2</b>.<br><br>
      Почему? <b>33</b> — ближайшее меньшие число к ${card} (больше 14, но меньше 55 и 64).<br>
      Карта всегда встаёт в ряд с <b>ближайшим меньшим</b> крайним числом.`,
      'Дальше →', 'Шаг 2 из 5'
    );
    tutCoachNext(tutStageB);
  });
}

async function tutStageB() {
  if (!TUT.active) return;
  const human = tutBuildHuman();
  human.hand = [32, 60];
  const rows = [[5, 11, 18, 24, 30], [48, 52], [57], [70, 74]];
  tutSetState(human, rows, 2);
  state.players = [human];
  renderAll();
  tutHighlightRow(0, true);

  tutCoach(
    `🍩 <b>Механика 2 — «Шестой енот»</b><br><br>
    <b>Ряд 1</b> полностью заполнен — в нём уже <b>5 карт</b> (подсвечен).<br><br>
    Если твоя карта ляжет туда, станет 6-й и <b>снесёт ряд тебе</b>.<br>
    Сыграй карту <b>32</b> и посмотри, что произойдёт.`,
    'К выбору карты →', 'Шаг 3 из 5'
  );
  tutCoachNext(async () => {
    tutHighlightRow(0, false);
    const card = await tutPrepPick(human, 32);
    tutHighlightHand(false);
    human.hand = human.hand.filter(c => c !== card);
    state.played.push({ player: human, card });
    renderAll();
    tutTimerOff();
    await placeCard(human, card);
    tutAfterPlay();
    if (!TUT.active) return;
    tutCoach(
      `🍩 <b>Шестой енот!</b> Твоя карта <b>${card}</b> должна была встать в заполненный ряд — и <b>снесла его тебе</b> как штраф.<br><br>
      Теперь ${card} открывает ряд заново.<br>
      <b>Совет:</b> избегай класть карту в ряд, где уже 5 карт.`,
      'Дальше →', 'Шаг 3 из 5'
    );
    tutCoachNext(tutStageC);
  });
}

async function tutStageC() {
  if (!TUT.active) return;
  const human = tutBuildHuman();
  human.hand = [8];
  const rows = [[10, 15, 22, 28, 34], [40, 46, 51], [58, 63, 67, 72], [77]];
  tutSetState(human, rows, 3);
  state.players = [human];
  renderAll();

  tutCoach(
    `⬇️ <b>Механика 3 — «Наименьшая карта»</b><br><br>
    Твоя карта <b>8</b> меньше <b>всех</b> крайних карт на столе (34, 51, 72, 77).<br>
    Она никуда не встаёт — тебе придётся <b>забрать один ряд на выбор</b>.<br><br>
    Сыграй карту <b>8</b>, затем выбери ряд, который заберёшь (лучше самый дешёвый).`,
    'К выбору карты →', 'Шаг 4 из 5'
  );
  tutCoachNext(async () => {
    const card = await tutPrepPick(human, 8);
    tutHighlightHand(false);
    human.hand = human.hand.filter(c => c !== card);
    state.played.push({ player: human, card });
    renderAll();
    tutTimerOff();
    await placeCard(human, card);
    const cost = rowPoints(human.taken);
    tutAfterPlay();
    if (!TUT.active) return;
    tutCoach(
      `🧠 <b>Отлично!</b> Ты забрал ряд на ${cost} 🍩.<br><br>
      Такой ход случается, когда карта самая маленькая на столе — выбирай самый дешёвый по пончикам ряд.`,
      'Дальше →', 'Шаг 4 из 5'
    );
    tutCoachNext(tutStageOrder);
  });
}

async function tutStageOrder() {
  if (!TUT.active) return;
  const human = tutBuildHuman();
  const bot = { id: 1, name: 'Опер', isBot: true, avatar: '🐻', hand: [5], taken: [], total: 0 };
  human.hand = [10];
  const rows = [[2, 4], [6, 8], [12], [20]];
  tutSetState(human, rows, 4);
  state.players = [human, bot];
  renderAll();

  tutCoach(
    `🔄 <b>Механика 4 — «Порядок розыгрыша»</b><br><br>
    Все игроки выбирают карты <b>вслепую</b>. Когда карты вскрываются, их разыгрывают <b>от меньшей к большей</b>.<br><br>
    Соперник «Опер» выбрал <b>5</b>, а ты — <b>10</b>. Так как <b>5 &lt; 10</b>, <b>первым</b> сыграет соперник.<br><br>
    Сыграй карту <b>10</b>, чтобы вскрыть карты и увидеть порядок.`,
    'К выбору карты →', 'Шаг 5 из 5'
  );
  tutCoachNext(async () => {
    const card = await tutPrepPick(human, 10);
    tutHighlightHand(false);
    human.hand = human.hand.filter(c => c !== card);
    bot.hand = [];
    state.played = [
      { player: bot, card: 5 },
      { player: human, card },
    ].sort((a, b) => a.card - b.card);
    renderAll();
    tutTimerOff();
    if (!TUT.active) return;
    tutCoach(
      `👁️ <b>Карты вскрыты!</b> В полосе сверху виден порядок розыгрыша:<br>
      Сначала идёт <b>5 (соперник)</b> — он меньше твоей карты <b>${card}</b>.<br><br>
      <b>Почему?</b> Порядок всегда <b>от меньшего к большему</b>: ${5} &lt; ${card}, поэтому 5 разыгрывается первым.<br>
      Нажимай «Разыграть →», чтобы увидеть, как карты по очереди заполняют ряды.</b>`,
      'Разыграть →', 'Шаг 5 из 5'
    );
    tutCoachNext(async () => {
      // раскладываем по порядку, как в реальной игре: подсветка -> в ряд -> затухание
      for (const entry of state.played) {
        if (!TUT.active) return;
        entry.active = true;
        renderPlayedStrip();
        await placeCard(entry.player, entry.card);
        if (!TUT.active) return;
        entry.active = false;
        entry.done = true;
        renderPlayedStrip();
        await sleep(450);
      }
      tutAfterPlay();
      if (!TUT.active) return;
      tutCoach(
        `✅ <b>Готово!</b> Порядок розыгрыша всегда <b>от меньшего к большему</b>: сначала <b>5</b> (соперник), потом <b>${card}</b> (ты) — и именно так карты легли в ряды.<br><br>
        Поэтому думай не только о своей карте, но и о том, <b>какие карты взяли соперники</b> — маленькая карта соперника разыграется раньше твоей.`,
        'Завершить →', 'Готово!'
      );
      tutCoachNext(tutStageD);
    });
  });
}

async function tutStageD() {
  if (!TUT.active) return;
  tutIntroPanels(true);
  tutCoach(
    `🏁 <b>Тренировка завершена!</b><br><br>
    Ты разобрался со всеми механиками:<br>
    • куда ложится карта<br>
    • как сносится шестой енот<br>
    • как выбрать ряд для наименьшей карты<br>
    • в каком порядке разыгрываются карты<br><br>
    Теперь попробуй настоящую партию — удачной охоты, агент! 🦝`,
    null, 'Финиш'
  );
  const exit = tutCoachEl().querySelector('#tut-coach-exit');
  exit.textContent = '🎮 В меню';
  tutCoachNext(tutExit);
}

async function startTutorial() {
  TUT.active = true;
  tutTimerOff();
  MODE = 'solo';
  hideMenuScreen();
  els.overlay.classList.add('hidden');
  tutTimerOff();
  tutIntroPanels(true);
  tutCoach(
    `🕵️ <b>Тренировка</b><br><br>
    Сейчас проработаем четыре ключевых механики на живых примерах.<br>
    Следуй подсказкам и внимательно читай пояснения.`,
    'Начать →', ''
  );
  tutCoachNext(tutStageIntro);
}

async function tutStageIntro() {
  if (!TUT.active) return;
  tutIntroPanels(false);
  const human = tutBuildHuman('Вы');
  human.hand = [12, 41, 78];
  const bot1 = { id: 1, name: 'Снайпер', isBot: true, avatar: '🐨', hand: [3, 4, 5], taken: [], total: 30, takenPts: 0 };
  const bot2 = { id: 2, name: 'Опер', isBot: true, avatar: '🐻', hand: [7, 8, 9], taken: [], total: 0, takenPts: 3 };
  const rows = [[3, 9, 14], [27, 33], [50, 52, 55], [64]];
  tutSetState(human, rows, 1);
  state.players = [human, bot1, bot2];
  renderAll();
  const card = els.players.querySelector('.opp.human');
  if (card) card.classList.add('tut-target');

  tutCoach(
    `🧭 <b>Знакомимся с интерфейсом</b><br><br>
    Справа — <b>карточки игроков</b>. Твоя подсвечена, а рядом — примеры соперников:<br>
    • <b>Очки</b> — штрафные пончики 🍩, набранные в <b>прошлых раундах</b>. У «Снайпера» — <b>30</b>.<br>
    • <b>Тур</b> — «+N»: сколько пончиков набрано <b>в этом раунде</b>. У «Опера» — <b>+3</b>.<br>
    • <b>Карт</b> — сколько карт осталось в руке: у всех сейчас по <b>3</b>.<br><br>
    У тебя пока <b>Очки: 0 · Тур: +0 · Карт: 3</b> — ты ещё ничего не забирал.`,
    'К Механике 1 →', 'Шаг 1 из 5'
  );
  tutCoachNext(tutStageA);
}

/* Подключение кнопки «Обучение» в главном меню */
(function wireTutMenuBtn() {
  const btn = document.getElementById('tut-btn');
  if (btn) btn.addEventListener('click', showTutorial);
})();
