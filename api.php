<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

const HAND_SIZE = 10;
const ROW_COUNT = 4;
const LOSE_AT = 66;
const MAX_PLAYERS = 4;
const STALE_SECONDS = 90;
const ROOM_TTL = 43200;
const ROUND_PAUSE = 8;
const TURN_LIMIT = 60;
const REVEAL_PAUSE = 5;
const TOPS_LIMIT = 10;
const AVATARS = ['🦝', '🐾', '🕵️', '🎩', '🧢', '🌙', '🍩', '🎭'];

require __DIR__ . '/core.php';

function roomKey(string $code): string {
    return 'room:' . $code;
}

function chatKey(string $code): string {
    return 'chat:' . $code;
}

const PROFANITY_STEMS = [
    'хуй', 'хуя', 'хуе', 'хую', 'пизд', 'бляд', 'блях', 'блят',
    'мудак', 'мудач', 'мудил', 'гандон', 'гондон', 'пидор', 'пидар',
    'шлюх', 'шалав', 'залуп', 'дроч', 'срак', 'падл', 'гнид',
];
const PROFANITY_LATIN = ['huy', 'nahuy', 'pizd', 'blyad', 'ebat', 'ebal', 'suka', 'mudak', 'gandon', 'xyu', 'xyi', 'hui'];
const PROFANITY_JOIN = [
    'хуй', 'хуе', 'хуя', 'пизд', 'уеб', 'выеб', 'заеб',
    'поеб', 'ебан', 'ъеб', 'хуило', 'пидор', 'мудак', 'ахуй', 'наъуй',
];

function profanityMap(string $s): string {
    $map = [
        'ё' => 'е', '@' => 'а', '$' => 'с', '+' => 'т', '0' => 'о', '6' => 'б',
        'x' => 'х', 'y' => 'у', 'i' => 'и', 'e' => 'е', 'a' => 'а', 'o' => 'о',
        'p' => 'р', 'c' => 'с', 'b' => 'б', 'm' => 'м', 'k' => 'к', 't' => 'т',
        'r' => 'р', 'l' => 'л', 'd' => 'д', 'h' => 'х', 'u' => 'у', '3' => 'з',
        '9' => 'я', '4' => 'ч', 'w' => 'в', 'f' => 'ф', 'g' => 'г', 'z' => 'з',
        'n' => 'н', 'v' => 'в', 's' => 'с', 'q' => 'к', 'j' => 'ж',
    ];
    return strtr($s, $map);
}

function profanitySquash(string $token): string {
    $norm = profanityMap(mb_strtolower($token));
    $letters = preg_replace('/[^a-zа-я]/u', '', $norm) ?? '';
    return preg_replace('/(.)\\1+/u', '$1', $letters) ?? $letters;
}

function profanityTokenBad(string $nt, string $orig = ''): bool {
    if ($nt === '') return false;
    $ol = mb_strtolower($orig);
    foreach (PROFANITY_STEMS as $st) {
        if (mb_strpos($nt, $st) !== false) return true;
    }
    foreach (PROFANITY_LATIN as $st) {
        if (strpos($nt, $st) !== false || ($ol !== '' && strpos($ol, $st) !== false)) return true;
    }
    if (preg_match('/(?:^|[аеиоуыэюяъь])еб/u', $nt)) return true;
    if (preg_match('/(?:^|[аеиоуыэюяъь])хер/u', $nt)) return true;
    if (preg_match('/(?:^|[аеиоуыэюяъь])у[ъь]?й$/u', $nt)) return true;
    if ($nt === 'бля' || $nt === 'хуа' || $nt === 'сука' || $nt === 'суки' || $nt === 'сукин') return true;
    return false;
}

function filterProfanity(string $text): string {
    $tokens = preg_split('/(\s+)/u', $text, -1, PREG_SPLIT_DELIM_CAPTURE);
    if (!is_array($tokens)) return '***';
    $norms = [];
    foreach ($tokens as $i => $tok) {
        $norms[$i] = ($i % 2 === 0) ? profanitySquash($tok) : '';
    }
    $joined = implode('', array_values(array_filter($norms, fn($v) => $v !== '')));
    $whole = false;
    foreach (PROFANITY_JOIN as $st) {
        if (mb_strpos($joined, $st) !== false) { $whole = true; break; }
    }
    if ($whole) return str_repeat('*', min(12, max(3, mb_strlen($text))));
    $bad = [];
    foreach ($norms as $i => $nt) {
        if ($i % 2 === 0 && profanityTokenBad($nt, $tokens[$i])) $bad[] = $i;
    }
    if (!$bad) return $text;
    foreach ($bad as $i) {
        $len = mb_strlen($tokens[$i]);
        $tokens[$i] = $len > 1 ? mb_substr($tokens[$i], 0, 1) . str_repeat('*', $len - 1) : '*';
    }
    return implode('', $tokens);
}

function chatTail(string $code): array {
    try {
        $raw = redis()->lRange(chatKey($code), 0, 24);
    } catch (Throwable $e) {
        return [];
    }
    $out = [];
    foreach ($raw as $line) {
        $e = json_decode($line, true);
        if (is_array($e)) $out[] = $e;
    }
    return array_reverse($out);
}

function cardPoints(int $n): int {
    if ($n === 55) return 7;
    if ($n % 10 === 0) return 3;
    if ($n % 10 === 5) return 2;
    return 1;
}

function rowPoints(array $row): int {
    $s = 0;
    foreach ($row as $n) $s += cardPoints($n);
    return $s;
}

function shuffledDeck(): array {
    $d = range(1, 104);
    for ($i = count($d) - 1; $i > 0; $i--) {
        $j = random_int(0, $i);
        [$d[$i], $d[$j]] = [$d[$j], $d[$i]];
    }
    return $d;
}

function cleanName(?string $s): string {
    $s = trim((string)$s);
    $s = preg_replace('/[\x00-\x1F\x7F]/u', '', $s) ?? '';
    $s = mb_substr($s, 0, 64);
    return $s === '' ? 'Игрок' : $s;
}

function authSanitizeLogin(string $s): string {
    return strtolower(substr(preg_replace('/[^A-Za-z0-9_.@-]/', '', trim($s)) ?? '', 0, 32));
}

function currentUser(array $body): ?array {
    $token = (string)($body['authToken'] ?? '');
    if (!preg_match('/^[a-f0-9]{64}$/', $token)) return null;
    $raw = redis()->get('sess:' . $token);
    if (!is_string($raw)) return null;
    $sess = json_decode($raw, true);
    if (!is_array($sess) || !isset($sess['userId'])) return null;
    return authGetUserById((int)$sess['userId']);
}

function authStartSession(int $userId, string $name): array {
    $token = bin2hex(random_bytes(32));
    redis()->setex('sess:' . $token, AUTH_SESSION_TTL, json_encode(['userId' => $userId, 'name' => $name], JSON_UNESCAPED_UNICODE));
    return ['authToken' => $token, 'userId' => $userId, 'name' => $name];
}

function authGetUserById(int $id): ?array {
    $st = db()->prepare('SELECT * FROM users WHERE id = ?');
    $st->execute([$id]);
    $row = $st->fetch();
    return $row === false ? null : $row;
}

function authFindUserId(string $provider, string $extId): ?int {
    $st = db()->prepare('SELECT id FROM users WHERE provider = ? AND ext_id = ?');
    $st->execute([$provider, $extId]);
    $v = $st->fetchColumn();
    return $v === false ? null : (int)$v;
}

function authCreateUser(string $provider, string $extId, string $login, string $name, ?string $passHash, ?string $email = null, int $verified = 1): array {
    try {
        $st = db()->prepare('INSERT INTO users (provider, ext_id, login, pass_hash, name, email, email_verified, confirm_token, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        $st->execute([
            $provider, $extId, $login !== '' ? $login : null, $passHash, $name,
            $email, $verified, $verified ? null : bin2hex(random_bytes(32)), time(),
        ]);
        $id = (int)db()->lastInsertId();
        ratingEnsureRow(null, $id);
    } catch (PDOException $e) {
        if ($e->getCode() === '23000') fail('Такой пользователь уже существует', 409);
        throw $e;
    }
    return authGetUserById($id);
}

/** Ссылка подтверждения e-mail: APP_URL из .env либо текущий хост запроса. */
function appUrl(): string {
    $u = rtrim(env('APP_URL', ''), '/');
    if ($u !== '') return $u;
    $https = (($_SERVER['HTTPS'] ?? '') !== '' && ($_SERVER['HTTPS'] ?? '') !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    return ($https ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost');
}

function buildConfirmLetter(string $name, string $link): string {
    $n = htmlspecialchars($name, ENT_QUOTES, 'UTF-8');
    $l = htmlspecialchars($link, ENT_QUOTES, 'UTF-8');
    return "<div style=\"font:15px/1.6 Arial,sans-serif;color:#222;max-width:520px\">
      <h2 style=\"margin:0 0 12px\">🦝 Еноты-агенты</h2>
      <p>Привет, <b>{$n}</b>!</p>
      <p>Подтвердите почту, чтобы активировать аккаунт (ссылка действует 48 часов):</p>
      <p style=\"margin:18px 0\"><a href=\"{$l}\" style=\"background:#f5b83d;color:#1c1c28;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:bold\">Подтвердить почту</a></p>
      <p style=\"color:#777;font-size:13px\">Если кнопка не работает, скопируйте ссылку в браузер:<br>{$l}</p>
      <p style=\"color:#777;font-size:13px\">Если вы не регистрировались — просто проигнорируйте это письмо.</p>
    </div>";
}

function sendConfirmEmail(array $u): void {
    $link = appUrl() . '/api.php?action=confirm&token=' . $u['confirm_token'];
    jobEnqueue('mail.send', [
        'to' => $u['email'],
        'subject' => 'Еноты-агенты: подтвердите почту',
        'html' => buildConfirmLetter((string)$u['name'], $link),
    ]);
}

function authPublicUser(array $u): array {
    $out = ['userId' => (int)$u['id'], 'name' => (string)$u['name'], 'provider' => (string)$u['provider'], 'login' => (string)$u['login'], 'vkId' => isset($u['vk_id']) && $u['vk_id'] !== null ? (string)$u['vk_id'] : null];
    try {
        $rows = ratingFetchMap(db(), [(int)$u['id']]);
        $r = $rows[(int)$u['id']] ?? ratingRowDefault((int)$u['id']);
        $out['rating'] = (int)$r['rating'];
        $out['stats'] = [
            'games'      => (int)$r['games'],
            'wins'       => (int)$r['wins'],
            'top3'       => (int)$r['top3'],
            'winStreak'  => (int)$r['win_streak'],
            'bestStreak' => (int)$r['best_streak'],
            'avgPenalty' => (int)$r['games'] > 0 ? (int)round(((int)$r['sum_penalty']) / (int)$r['games']) : null,
            'bestGame'   => $r['best_game'] !== null ? (int)$r['best_game'] : null,
            'worstGame'  => $r['worst_game'] !== null ? (int)$r['worst_game'] : null,
            'sixthTakes' => (int)$r['sixth_takes'],
            'forcedTakes'=> (int)$r['forced_takes'],
        ];
    } catch (Throwable $e) { /* профиль без статистики не критичен */ }
    return $out;
}

function authRespondUser(array $u): void {
    respond(['ok' => true] + authStartSession((int)$u['id'], (string)$u['name']) + authPublicUser($u));
}

function newCode(): string {
    $r = redis();
    $alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    do {
        $c = '';
        for ($i = 0; $i < 4; $i++) $c .= $alpha[random_int(0, strlen($alpha) - 1)];
    } while ($r->exists(roomKey($c)));
    return $c;
}

function listOpenRooms(): array {
    $r = redis();
    $out = [];
    foreach ($r->keys('room:*') ?: [] as $key) {
        $room = json_decode((string)$r->get($key), true);
        if (!is_array($room) || ($room['phase'] ?? '') !== 'lobby') continue;
        $code = $room['code'];
        $sum = 0;
        $members = [];
        foreach ($room['players'] ?? [] as $p) {
            $rt = (int)($p['rating'] ?? RATING_START);
            $sum += $rt;
            $members[] = ['name' => (string)($p['name'] ?? 'Игрок'), 'rating' => $rt];
        }
        $cnt = count($members);
        $out[] = [
            'id' => $code,
            'name' => (string)($room['name'] ?? ('Комната ' . $code)),
            'players' => $cnt,
            'max' => (int)($room['maxPlayers'] ?? MAX_PLAYERS),
            'avgRating' => $cnt > 0 ? (int)round($sum / $cnt) : (int)RATING_START,
            'members' => $members,
        ];
    }
    usort($out, fn($a, $b) => $b['players'] <=> $a['players']);
    return $out;
}

$ROOM_ADJ = ['Секретная', 'Ночная', 'Тайная', 'Кодовая', 'Шпионская', 'Засекреченная', 'Скрытная', 'Бесшумная', 'Молниеносная', 'Смелая', 'Дерзкая', 'Хитрая', 'Дикая', 'Плутовская', 'Шкодная', 'Неуловимая', 'Космическая', 'Магическая', 'Огненная', 'Ледяная', 'Гениальная', 'Опасная'];
$ROOM_NOUN = ['Миссия', 'Операция', 'Задача', 'Вылазка', 'Разведка', 'Слежка', 'Диверсия', 'Передача', 'Депеша', 'Уловка', 'Хитрость', 'Проделка', 'Плутовка', 'Шкода', 'Засада', 'Агентура', 'Авантюра', 'Разгадка', 'Подмена', 'Добыча'];

function newRoomName(): string {
    global $ROOM_ADJ, $ROOM_NOUN;
    $r = redis();
    $used = [];
    foreach ($r->keys('room:*') ?: [] as $key) {
        $room = json_decode((string)$r->get($key), true);
        if (is_array($room) && !empty($room['name'])) $used[$room['name']] = true;
    }
    for ($i = 0; $i < 20; $i++) {
        $n = $ROOM_ADJ[array_rand($ROOM_ADJ)] . ' ' . $ROOM_NOUN[array_rand($ROOM_NOUN)];
        if (!isset($used[$n])) return $n;
    }
    return 'Операция ' . strtolower((string)random_int(100, 999));
}

function bumpRoom(array &$room): void {
    $room['__bump'] = true;
}

function withRoom(string $code, callable $fn) {
    $r = redis();
    $lockKey = 'lock:' . $code;
    $deadline = microtime(true) + LOCK_TTL;
    while (!$r->set($lockKey, 1, ['nx', 'ex' => LOCK_TTL])) {
        if (microtime(true) > $deadline) return null;
        usleep(50000);
    }
    try {
        $raw = $r->get(roomKey($code));
        $room = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($room)) return null;
        autoAdvanceRound($room);
        autoAdvanceReveal($room);
        checkTurnTimeout($room);
        $result = $fn($room);
        if ($result === '__delete') {
            $r->del(roomKey($code));
            $r->del(chatKey($code));
            $r->del('chatseq:' . $code);
            return ['__deleted' => true];
        }
        $bump = isset($room['__bump']);
        unset($room['__bump']);
        $room['lastActivity'] = time();
        if ($bump) $room['version'] = (int)($room['version'] ?? 0) + 1;
        $r->set(roomKey($code), json_encode($room, JSON_UNESCAPED_UNICODE));
        $r->expire(roomKey($code), ROOM_TTL);
        return $result;
    } finally {
        $r->del($lockKey);
    }
}

function findPlayerIdx(array $room, string $token): int {
    foreach ($room['players'] as $i => $p) {
        if ($p['token'] !== '' && $p['token'] === $token) return $i;
    }
    return -1;
}

function makePlayer(int $id, string $name, bool $isBot): array {
    return [
        'id' => $id,
        'name' => $name,
        'avatar' => AVATARS[$id % count(AVATARS)],
        'isBot' => $isBot,
        'token' => $isBot ? '' : bin2hex(random_bytes(16)),
        'hand' => [],
        'taken' => [],
        'total' => 0,
        'card' => null,
        'lastSeen' => time(),
    ];
}

function cheapestRow(array $rows): int {
    $best = [];
    $bestPts = PHP_INT_MAX;
    foreach ($rows as $i => $row) {
        $pts = rowPoints($row);
        if ($pts < $bestPts) { $bestPts = $pts; $best = [$i]; }
        elseif ($pts === $bestPts) $best[] = $i;
    }
    return $best[random_int(0, count($best) - 1)];
}

function botPickCard(array $rows, array $hand): int {
    $bestCard = null;
    $bestCost = INF;
    foreach ($hand as $card) {
        $opts = [];
        foreach ($rows as $ri => $r) {
            $last = $r[count($r) - 1];
            if ($last < $card) $opts[] = ['i' => $ri, 'last' => $last, 'len' => count($r)];
        }
        if (!$opts) {
            $cost = min(array_map('rowPoints', $rows)) + 2;
        } else {
            usort($opts, function ($a, $b) use ($card) {
                $da = $card - $a['last'];
                $db = $card - $b['last'];
                return $da === $db ? $a['len'] - $b['len'] : ($da < $db ? -1 : 1);
            });
            $t = $opts[0];
            if ($t['len'] >= 5) {
                $cost = rowPoints($rows[$t['i']]) + 1.5;
            } else {
                $cost = ($card - $t['last']) * 0.06 + ($t['len'] === 4 ? 0.9 : 0) + mt_rand() / mt_getrandmax() * 0.25;
            }
        }
        if ($cost < $bestCost) { $bestCost = $cost; $bestCard = $card; }
    }
    return $bestCard ?? $hand[0];
}

function autoSubmitBots(array &$room): void {
    foreach ($room['players'] as &$p) {
        if ($p['isBot'] && $p['card'] === null && !empty($p['hand'])) {
            $c = botPickCard($room['rows'], $p['hand']);
            $p['hand'] = array_values(array_diff($p['hand'], [$c]));
            $p['card'] = $c;
        }
    }
    unset($p);
}

function applyTake(array &$room, int $pid, int $card, int $rowIdx, string $kind): void {
    $taken = $room['rows'][$rowIdx];
    $pts = rowPoints($taken);
    $room['players'][$pid]['taken'] = array_merge($room['players'][$pid]['taken'], $taken);
    if ($kind === 'sixth') $room['players'][$pid]['sixthTakes'] = ($room['players'][$pid]['sixthTakes'] ?? 0) + 1;
    elseif ($kind === 'forced') $room['players'][$pid]['forcedTakes'] = ($room['players'][$pid]['forcedTakes'] ?? 0) + 1;
    $room['rows'][$rowIdx] = [$card];
    $room['lastEvents'][] = [
        't' => $kind,
        'pid' => $pid,
        'card' => $card,
        'row' => $rowIdx,
        'cards' => $taken,
        'pts' => $pts,
    ];
}

function advanceResolve(array &$room): void {
    $q = $room['queue'];
    while (($room['qIndex'] ?? 0) < count($q)) {
        $step = $q[$room['qIndex']];
        $pid = $step['pid'];
        $card = $step['card'];
        $opts = [];
        foreach ($room['rows'] as $i => $row) {
            $last = $row[count($row) - 1];
            if ($last < $card) $opts[] = ['i' => $i, 'last' => $last];
        }
        if (!$opts) {
            if ($room['players'][$pid]['isBot']) {
                applyTake($room, $pid, $card, cheapestRow($room['rows']), 'forced');
                $room['qIndex']++;
                continue;
            }
            $room['phase'] = 'choose_row';
            $room['waitingFor'] = $pid;
            $room['turnEndAt'] = time() + TURN_LIMIT;
            return;
        }
        usort($opts, function ($a, $b) use ($card, $room) {
            $da = $card - $a['last'];
            $db = $card - $b['last'];
            return $da === $db
                ? count($room['rows'][$a['i']]) - count($room['rows'][$b['i']])
                : ($da < $db ? -1 : 1);
        });
        $t = $opts[0]['i'];
        if (count($room['rows'][$t]) >= 5) {
            applyTake($room, $pid, $card, $t, 'sixth');
        } else {
            $room['rows'][$t][] = $card;
            $room['lastEvents'][] = ['t' => 'place', 'pid' => $pid, 'card' => $card, 'row' => $t];
        }
        $room['qIndex']++;
    }
    // Очередь обработана полностью: если среди игроков есть люди,
    // задерживаемся в фазе reveal, чтобы расклад было видно.
    foreach ($room['players'] as $p) {
        if (!$p['isBot']) {
            $room['phase'] = 'reveal';
            $room['revealEndAt'] = time() + REVEAL_PAUSE;
            return;
        }
    }
    finishTurn($room);
}

/**
 * Итоги партии: места, попарный Эло и статистика — одной транзакцией в MySQL.
 * Рейтингуется любая сетевая партия между живыми игроками (матч только против
 * ботов не считается). Гость без аккаунта играет с базовым рейтингом 1000:
 * влияет на дельты соперников, но собственных строк в БД не получает.
 * Обогащает $summary (place/ratingDelta) и вешает ratingDelta на игроков комнаты.
 */
function saveRatedGame(array &$room, array &$summary): void {
    try {
        $humans = [];
        foreach ($room['players'] as $i => $p) {
            if (!empty($p['isBot'])) continue;
            $humans[] = [
                'idx'    => $i,
                'pid'    => $p['id'],
                'uid'    => isset($p['userId']) ? (int)$p['userId'] : null,
                'total'  => (int)$p['total'],
                'sixth'  => (int)($p['sixthTakes'] ?? 0),
                'forced' => (int)($p['forcedTakes'] ?? 0),
            ];
        }
        // Против ботов рейтинг не считаем; записывать результаты некому, если нет аккаунтов
        if (count($humans) < 2) return;
        $uids = array_values(array_filter(array_column($humans, 'uid'), fn($u) => $u !== null));
        if (!$uids) return;

        usort($humans, fn($a, $b) => $a['total'] <=> $b['total']);

        $pdo = db();
        $pdo->beginTransaction();
        $rows = ratingFetchMap($pdo, $uids);
        $standings = [];
        foreach ($humans as $h) {
            $h['rating'] = $h['uid'] !== null && isset($rows[$h['uid']])
                ? (int)$rows[$h['uid']]['rating']
                : RATING_START;
            $standings[] = $h;
        }
        $res = ratingCompute(array_map(fn($h) => ['total' => $h['total'], 'rating' => $h['rating']], $standings));

        $stG = $pdo->prepare('INSERT INTO games (room_code, finished_at) VALUES (?, ?)');
        $stG->execute([(string)$room['code'], time()]);
        $gid = (int)$pdo->lastInsertId();

        $stP = $pdo->prepare('INSERT INTO game_players
            (game_id, user_id, place, total, sixth_takes, forced_takes, rating_before, rating_after)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        foreach ($standings as $i => $h) {
            if ($h['uid'] === null) continue;
            $stP->execute([
                $gid, $h['uid'], (int)$res['places'][$i], $h['total'],
                $h['sixth'], $h['forced'], $h['rating'], (int)$res['newRating'][$i],
            ]);
        }

        foreach ($standings as $i => $h) {
            if ($h['uid'] === null) continue;
            $uid = $h['uid'];
            $old = $rows[$uid] ?? ratingRowDefault($uid);
            $place = (int)$res['places'][$i];
            $win = $place === 1 ? 1 : 0;
            $streak = $win ? (int)$old['win_streak'] + 1 : 0;
            $row = [
                'user_id'     => $uid,
                'rating'      => (int)$res['newRating'][$i],
                'games'       => (int)$old['games'] + 1,
                'wins'        => (int)$old['wins'] + $win,
                'top3'        => (int)$old['top3'] + ($place <= 3 ? 1 : 0),
                'sum_penalty' => (int)$old['sum_penalty'] + $h['total'],
                'best_game'   => $old['best_game'] === null ? $h['total'] : min((int)$old['best_game'], $h['total']),
                'worst_game'  => $old['worst_game'] === null ? $h['total'] : max((int)$old['worst_game'], $h['total']),
                'win_streak'  => $streak,
                'best_streak' => max((int)$old['best_streak'], $streak),
                'sixth_takes' => (int)$old['sixth_takes'] + $h['sixth'],
                'forced_takes'=> (int)$old['forced_takes'] + $h['forced'],
            ];
            ratingUpsert($pdo, $row);
        }
        $pdo->commit();

        // Отражаем результат в комнате и сводке для ВСЕХ живых участников
        $byPid = [];
        foreach ($standings as $i => $h) {
            $delta = (int)$res['deltas'][$i];
            $newRating = (int)$res['newRating'][$i];
            $room['players'][$h['idx']]['rating'] = $newRating;
            $room['players'][$h['idx']]['ratingDelta'] = $delta;
            $room['players'][$h['idx']]['place'] = (int)$res['places'][$i];
            $byPid[$h['pid']] = ['place' => (int)$res['places'][$i], 'delta' => $delta];
        }
        foreach ($summary as &$s) {
            if (isset($byPid[$s['pid']])) {
                $s['place'] = $byPid[$s['pid']]['place'];
                $s['ratingDelta'] = $byPid[$s['pid']]['delta'];
            }
        }
        unset($s);
    } catch (Throwable $e) {
        // Сбой БД не должен ломать игру: партия просто останется без рейтинга
        if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) $pdo->rollBack();
    }
}

function finishTurn(array &$room): void {
    $room['queue'] = null;
    $room['qIndex'] = 0;
    $room['waitingFor'] = null;
    $room['lastEvents'] = [];
    $room['turn']++;
    foreach ($room['players'] as &$p) $p['card'] = null;
    unset($p);

    if ($room['turn'] >= HAND_SIZE) {
        $summary = [];
        $over = false;
        foreach ($room['players'] as &$p) {
            $rp = rowPoints($p['taken']);
            $p['total'] += $rp;
            if ($p['total'] >= LOSE_AT) $over = true;
            $summary[] = [
                'pid' => $p['id'],
                'name' => $p['name'],
                'avatar' => $p['avatar'],
                'total' => $p['total'],
                'roundPts' => $rp,
                'count' => count($p['taken']),
            ];
        }
        unset($p);
        if ($over) saveRatedGame($room, $summary);
        $room['summary'] = $summary;
        $room['phase'] = $over ? 'game_end' : 'round_end';
        if (!$over) $room['roundEndAt'] = time();
    } else {
        $room['phase'] = 'pick';
        autoSubmitBots($room);
        resolveIfReady($room);
        refreshAfterTransition($room);
    }
}

function resolveIfReady(array &$room): void {
    foreach ($room['players'] as $p) {
        if ($p['card'] === null) return;
    }
    $q = [];
    foreach ($room['players'] as $i => $p) {
        $q[] = ['pid' => $i, 'card' => $p['card']];
    }
    usort($q, fn($a, $b) => $a['card'] <=> $b['card']);
    $room['queue'] = $q;
    $room['qIndex'] = 0;
    $room['lastEvents'] = [];
    advanceResolve($room);
}

function autoAdvanceRound(array &$room): void {
    if (($room['phase'] ?? '') !== 'round_end') return;
    if (time() - (int)($room['roundEndAt'] ?? 0) < ROUND_PAUSE) return;
    bumpRoom($room);
    startRound($room);
}

// Пауза после раздачи карт по рядам: даём всем увидеть расклад,
// прежде чем начнётся следующий ход.
function autoAdvanceReveal(array &$room): void {
    if (($room['phase'] ?? '') !== 'reveal') return;
    if (time() < (int)($room['revealEndAt'] ?? 0)) return;
    bumpRoom($room);
    finishTurn($room);
    refreshAfterTransition($room);
}

function refreshAfterTransition(array &$room): void {
    $ph = $room['phase'] ?? '';
    if ($ph === 'pick' || $ph === 'choose_row') {
        $room['turnEndAt'] = time() + TURN_LIMIT;
    }
}

function checkTurnTimeout(array &$room): void {
    $ph = $room['phase'] ?? '';
    if ($ph !== 'pick' && $ph !== 'choose_row') return;
    $end = (int)($room['turnEndAt'] ?? 0);
    if ($end === 0 || time() < $end) return;
    bumpRoom($room);
    if ($ph === 'pick') {
        foreach ($room['players'] as &$p) {
            if (!$p['isBot'] && $p['card'] === null && !empty($p['hand'])) {
                sort($p['hand']);
                $p['card'] = array_shift($p['hand']);
            }
        }
        unset($p);
        resolveIfReady($room);
    } else {
        $pid = (int)$room['waitingFor'];
        applyTake($room, $pid, $room['queue'][$room['qIndex']]['card'], cheapestRow($room['rows']), 'forced');
        $room['qIndex']++;
        $room['waitingFor'] = null;
        $room['phase'] = 'resolve';
        advanceResolve($room);
    }
    refreshAfterTransition($room);
}

function startRound(array &$room): void {
    $deck = shuffledDeck();
    foreach ($room['players'] as &$p) {
        $p['taken'] = [];
        $p['card'] = null;
        $p['hand'] = array_splice($deck, 0, HAND_SIZE);
        sort($p['hand']);
    }
    unset($p);
    $room['rows'] = [];
    for ($i = 0; $i < ROW_COUNT; $i++) $room['rows'][] = [array_pop($deck)];
    $room['round']++;
    $room['turn'] = 0;
    $room['queue'] = null;
    $room['qIndex'] = 0;
    $room['waitingFor'] = null;
    $room['summary'] = null;
    $room['lastEvents'] = [];
    $room['phase'] = 'pick';
    autoSubmitBots($room);
    resolveIfReady($room);
    refreshAfterTransition($room);
}

function convertToBot(array &$room, int $idx): void {
    $p = &$room['players'][$idx];
    if ($p['isBot']) return;
    $p['isBot'] = true;
    $p['token'] = '';
    $uid = $p['userId'] ?? null;
    if ($uid !== null) {
        unset($room['userIds'][$uid]);
        unset($p['userId']);
    }
    unset($p);
    if ($room['hostId'] === $room['players'][$idx]['id']) {
        $newHost = null;
        foreach ($room['players'] as $p2) {
            if (!$p2['isBot']) { $newHost = $p2['id']; break; }
        }
        $room['hostId'] = $newHost;
    }
    if ($room['phase'] === 'pick') {
        autoSubmitBots($room);
        resolveIfReady($room);
    } elseif ($room['phase'] === 'choose_row' && $room['waitingFor'] === $idx) {
        applyTake($room, $idx, $room['queue'][$room['qIndex']]['card'], cheapestRow($room['rows']), 'forced');
        $room['qIndex']++;
        $room['waitingFor'] = null;
        $room['phase'] = 'resolve';
        advanceResolve($room);
    }
}

function humansLeft(array $room): bool {
    foreach ($room['players'] as $p) {
        if (!$p['isBot']) return true;
    }
    return false;
}

function snapshot(array $room, int $me): array {
    $order = [$me];
    foreach ($room['players'] as $i => $p) {
        if ($i !== $me) $order[] = $i;
    }
    $playersOut = [];
    foreach ($order as $i) {
        $p = $room['players'][$i];
        $isMe = $i === $me;
        $playersOut[] = [
            'id' => $p['id'],
            'name' => $p['name'],
            'avatar' => $p['avatar'],
            'isBot' => $p['isBot'],
            'host' => $room['hostId'] === $p['id'],
            'handCount' => count($p['hand']),
            'takenCount' => count($p['taken']),
            'takenPts' => rowPoints($p['taken']),
            'total' => $p['total'],
            'committed' => $p['card'] !== null,
            'rating' => isset($p['rating']) ? (int)$p['rating'] : null,
            'ratingDelta' => isset($p['ratingDelta']) ? (int)$p['ratingDelta'] : null,
        ];
    }
    $meP = $room['players'][$me];
    $revealed = [];
    if ($room['phase'] !== 'pick' && is_array($room['queue'])) {
        foreach ($room['queue'] as $s) {
            $revealed[] = ['pid' => $s['pid'], 'card' => $s['card']];
        }
    }
    return [
        'ok' => true,
        'version' => $room['version'],
        'room' => $room['code'],
        'maxPlayers' => (int)($room['maxPlayers'] ?? MAX_PLAYERS),
        'you' => $meP['id'],
        'hostId' => $room['hostId'],
        'phase' => $room['phase'],
        'round' => (int)$room['round'],
        'turn' => min((int)$room['turn'] + 1, HAND_SIZE),
        'rows' => $room['rows'],
        'hand' => $meP['hand'],
        'myTaken' => $meP['taken'],
        'players' => $playersOut,
        'revealed' => $revealed,
        'events' => $room['lastEvents'] ?? [],
        'waitingFor' => $room['waitingFor'],
        'turnKey' => 'r' . $room['round'] . 't' . $room['turn'],
        'summary' => $room['summary'],
        'roundEndAt' => (int)($room['roundEndAt'] ?? 0),
        'pause' => ROUND_PAUSE,
        'turnEndAt' => (int)($room['turnEndAt'] ?? 0),
        'turnLimit' => TURN_LIMIT,
        'rematchYes' => array_map('intval', array_keys(is_array($room['rematch'] ?? null) ? $room['rematch'] : [])),
        'chat' => chatTail($room['code']),
    ];
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// Подтверждение e-mail по ссылке из письма (GET /api.php?action=confirm&token=...)
if ($method === 'GET' && ($_GET['action'] ?? '') === 'confirm') {
    header('Content-Type: text/html; charset=utf-8');
    $t = strtolower(preg_replace('/[^a-f0-9]/i', '', (string)($_GET['token'] ?? '')));
    $u = null;
    if (strlen($t) === 64) {
        $st = db()->prepare('SELECT * FROM users WHERE confirm_token = ? AND email_verified = 0 LIMIT 1');
        $st->execute([$t]);
        $u = $st->fetch() ?: null;
    }
    if ($u !== null) {
        $st = db()->prepare('UPDATE users SET email_verified = 1, confirm_token = NULL WHERE id = ?');
        $st->execute([(int)$u['id']]);
        $title = 'Почта подтверждена ✔';
        $msg = 'Аккаунт активирован. Теперь можно войти, используя логин и пароль.';
        $ok = true;
    } else {
        $title = 'Ссылка недействительна';
        $msg = 'Ссылка уже использована или устарела. Запросите новое письмо на странице входа.';
        $ok = false;
    }
    $home = htmlspecialchars(appUrl(), ENT_QUOTES, 'UTF-8');
    echo '<!doctype html><html lang="ru"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width,initial-scale=1">'
        . '<title>' . $title . '</title>'
        . '<meta http-equiv="refresh" content="4;url=' . $home . '"></head>'
        . '<body style="font:16px/1.6 system-ui,Arial,sans-serif;background:#1c1c28;color:#eee;'
        . 'display:flex;align-items:center;justify-content:center;height:100vh;margin:0">'
        . '<div style="text-align:center"><div style="font-size:42px;margin-bottom:10px">' . ($ok ? '🦝' : '😿') . '</div>'
        . '<h2 style="margin:0 0 8px">' . $title . '</h2><p style="color:#bbb">' . $msg . '</p>'
        . '<p><a href="' . $home . '" style="color:#f5b83d">Перейти к игре</a></p></div></body></html>';
    exit;
}

$body = json_decode((string)file_get_contents('php://input'), true);
if (!is_array($body)) fail('Некорректный запрос');
$action = (string)($body['action'] ?? '');

if ($action === 'register') {
    $login = authSanitizeLogin((string)($body['login'] ?? ''));
    $pass = (string)($body['password'] ?? '');
    $name = cleanName($body['name'] ?? $login);
    $email = strtolower(trim((string)($body['email'] ?? '')));
    if (strlen($login) < 3) fail('Логин: минимум 3 символа (латиница, цифры, . _ - @)');
    if (strlen($pass) < 6) fail('Пароль: минимум 6 символов');
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) fail('Укажите корректный e-mail — на него придёт письмо подтверждения');
    if (strlen($email) > 191) fail('Слишком длинный e-mail');
    if (authFindUserId('local', $login) !== null) fail('Такой логин уже занят', 409);
    $st = db()->prepare('SELECT id FROM users WHERE email = ? LIMIT 1');
    $st->execute([$email]);
    if ($st->fetchColumn() !== false) fail('Эта почта уже используется', 409);

    // Атомарно: учётка (неподтверждённая) + письмо в очередь (outbox)
    $pdo = db();
    $now = time();
    $ctoken = bin2hex(random_bytes(32));
    try {
        $pdo->beginTransaction();
        $st = $pdo->prepare('INSERT INTO users (provider, ext_id, login, pass_hash, name, email, email_verified, confirm_token, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)');
        $st->execute(['local', $login, $login, password_hash($pass, PASSWORD_DEFAULT), $name, $email, $ctoken, $now]);
        $uid = (int)$pdo->lastInsertId();
        ratingEnsureRow($pdo, $uid);
        $link = appUrl() . '/api.php?action=confirm&token=' . $ctoken;
        jobEnqueue('mail.send', [
            'to' => $email,
            'subject' => 'Еноты-агенты: подтвердите почту',
            'html' => buildConfirmLetter($name, $link),
        ], 0, $pdo);
        $pdo->commit();
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        if ($e->getCode() === '23000') fail('Такой логин или почта уже заняты', 409);
        throw $e;
    }
    respond(['ok' => true, 'message' => 'Аккаунт создан. На ' . $email . ' отправлено письмо — подтвердите почту и войдите.']);
}

if ($action === 'resend') {
    $login = authSanitizeLogin((string)($body['login'] ?? ''));
    $id = authFindUserId('local', $login);
    if ($id !== null) {
        $u = authGetUserById($id);
        if ($u !== null && (string)$u['email'] !== '' && !(int)$u['email_verified']) {
            $rl = 'rsl:' . $id;
            if (!redis()->set($rl, 1, ['nx', 'ex' => 300])) {
                fail('Письмо уже отправляли недавно — проверьте почту или попробуйте через 5 минут', 429);
            }
            $ctoken = bin2hex(random_bytes(32));
            $st = db()->prepare('UPDATE users SET confirm_token = ? WHERE id = ?');
            $st->execute([$ctoken, $id]);
            $u['confirm_token'] = $ctoken;
            sendConfirmEmail($u);
        }
    }
    respond(['ok' => true, 'message' => 'Если аккаунт существует и не подтверждён — письмо отправлено']);
}

if ($action === 'login') {
    $login = authSanitizeLogin((string)($body['login'] ?? ''));
    $pass = (string)($body['password'] ?? '');
    $id = authFindUserId('local', $login);
    $u = $id !== null ? authGetUserById($id) : null;
    if ($u === null || !password_verify($pass, (string)($u['pass_hash'] ?? ''))) fail('Неверный логин или пароль', 401);
    if ((string)$u['email'] !== '' && !(int)$u['email_verified']) {
        fail('Подтвердите e-mail — ссылка отправлена при регистрации. Можно запросить новое письмо.', 403);
    }
    authRespondUser($u);
}

if ($action === 'logout') {
    $token = (string)($body['authToken'] ?? '');
    if (preg_match('/^[a-f0-9]{64}$/', $token)) redis()->del('sess:' . $token);
    respond(['ok' => true]);
}

if ($action === 'me') {
    $u = currentUser($body);
    if (!$u) fail('Не авторизован', 401);
    respond(['ok' => true] + authPublicUser($u));
}

// Привязка локального аккаунта (provider=local) к VK id: пользователь указывает
// свой id из VK, чтобы при запуске игры из VK входить под этим же аккаунтом.
if ($action === 'linkVk') {
    $u = currentUser($body);
    if (!$u) fail('Не авторизован', 401);
    if ((string)$u['provider'] !== 'local') fail('Привязать VK можно только к аккаунту с обычной регистрацией', 400);
    $vkId = preg_replace('/\D/', '', (string)($body['vkId'] ?? ''));
    if ($vkId === '') fail('Укажите id из VK', 400);
    // id занят другим пользователем (уже привязан) или уже существует мини-аккаунт VK на этот id
    $st = db()->prepare('SELECT id FROM users WHERE vk_id = ? LIMIT 1');
    $st->execute([$vkId]);
    if ($st->fetchColumn() !== false) fail('Этот VK id уже привязан к другому аккаунту', 409);
    $mini = authFindUserId('vkmini', $vkId);
    if ($mini !== null) fail('Этот VK аккаунт уже используется в игре', 409);
    try {
        $st = db()->prepare('UPDATE users SET vk_id = ? WHERE id = ?');
        $st->execute([$vkId, (int)$u['id']]);
    } catch (PDOException $e) {
        if ($e->getCode() === '23000') fail('Этот VK id уже привязан к другому аккаунту', 409);
        throw $e;
    }
    respond(['ok' => true] + authPublicUser(authGetUserById((int)$u['id'])));
}

// Снятие привязки VK id с локального аккаунта.
if ($action === 'unlinkVk') {
    $u = currentUser($body);
    if (!$u) fail('Не авторизован', 401);
    $st = db()->prepare('UPDATE users SET vk_id = NULL WHERE id = ?');
    $st->execute([(int)$u['id']]);
    respond(['ok' => true] + authPublicUser(authGetUserById((int)$u['id'])));
}

if ($action === 'authConfig') {
    respond(['ok' => true, 'vkAppId' => VK_APP_ID, 'vkRedirectUri' => VK_REDIRECT_URI]);
}

if ($action === 'authYandex') {
    $extId = substr(preg_replace('/[^A-Za-z0-9_-]/', '', (string)($body['yaId'] ?? '')) ?? '', 0, 64);
    if ($extId === '') fail('Нет данных авторизации Яндекса');
    $name = cleanName($body['name'] ?? '');
    $id = authFindUserId('yandex', $extId);
    if ($id === null) {
        $u = authCreateUser('yandex', $extId, 'ya_' . substr($extId, -16), $name, null);
        authRespondUser($u);
    }
    $u = authGetUserById($id);
    if ($u === null) fail('Ошибка данных пользователя');
    authRespondUser($u);
}

if ($action === 'authVk') {
    if (VK_APP_ID === '' || VK_APP_SECRET === '') fail('Авторизация через VK не настроена на сервере');
    $code = trim((string)($body['code'] ?? ''));
    if ($code === '') fail('Нет кода авторизации VK');
    // redirect_uri в обмене кода обязан совпадать с тем, что уходил в /authorize.
    $redirectUri = trim((string)($body['redirectUri'] ?? ''));
    if ($redirectUri === '') $redirectUri = trim(VK_REDIRECT_URI) !== '' ? trim(VK_REDIRECT_URI) : appUrl() . '/';
    $query = http_build_query([
        'client_id' => VK_APP_ID,
        'client_secret' => VK_APP_SECRET,
        'redirect_uri' => $redirectUri,
        'code' => $code,
    ]);
    $raw = @file_get_contents('https://oauth.vk.com/access_token?' . $query);
    $data = $raw ? json_decode($raw, true) : null;
    if (!is_array($data) || empty($data['access_token'])) {
        $desc = isset($data['error_description']) ? ': ' . $data['error_description'] : '';
        if (stripos($desc, 'redirect_uri') !== false || isset($data['error']) && $data['error'] === 'invalid_request') {
            $desc .= ' (адрес входа укажите точно в настройках приложения VK, проверьте VK_REDIRECT_URI: ' . $redirectUri . ')';
        }
        fail('VK: не удалось обменять код' . $desc, 401);
    }
    $vkUid = (string)$data['user_id'];
    $raw2 = @file_get_contents('https://api.vk.com/method/users.get?'
        . http_build_query(['user_ids' => $vkUid, 'fields' => 'photo_100', 'access_token' => $data['access_token'], 'v' => '5.199']));
    $info = $raw2 ? json_decode($raw2, true) : null;
    $fname = $info['response'][0]['first_name'] ?? '';
    $lname = $info['response'][0]['last_name'] ?? '';
    $name = cleanName(trim($fname . ' ' . $lname));
    $id = authFindUserId('vk', $vkUid);
    if ($id === null) {
        $u = authCreateUser('vk', $vkUid, 'vk_' . $vkUid, $name, null);
        authRespondUser($u);
    }
    $u = authGetUserById($id);
    if ($u === null) fail('Ошибка данных пользователя');
    authRespondUser($u);
}

/** Проверка подписи параметров запуска VK Mini Apps: HMAC-SHA256 от
 * отсортированных vk_*-параметров (вид "k=v&k2=v2", URL-кодированные), base64url без дополнения. */
function vkMiniSignValid(array $p): bool {
    if (VK_APP_SECRET === '') return false;
    $signParams = [];
    foreach ($p as $k => $v) {
        $k = (string)$k;
        if ($k !== 'sign' && str_starts_with($k, 'vk_')) $signParams[$k] = (string)$v;
    }
    ksort($signParams);
    // VK подписывает строку "k=v&k2=v2" с исходными (не URL-кодированными) значениями
    $pairs = [];
    foreach ($signParams as $k => $v) $pairs[] = $k . '=' . $v;
    $signParamsQuery = implode('&', $pairs);
    $calc = rtrim(strtr(base64_encode(hash_hmac('sha256', $signParamsQuery, VK_APP_SECRET, true)), '+/', '-_'), '=');
    error_log('authVkMini: keys=' . json_encode(array_keys($signParams), JSON_UNESCAPED_UNICODE)
        . ' query=' . $signParamsQuery
        . ' calc=' . $calc
        . ' sign=' . (string)($p['sign'] ?? ''));
    return hash_equals($calc, (string)($p['sign'] ?? ''));
}

// Автоматический вход внутри VK (мини-приложение): регистрация не нужна,
// аккаунт создаётся сам с именем из VK, без e-mail и писем.
if ($action === 'authVkMini') {
    if (VK_APP_ID === '' || VK_APP_SECRET === '') fail('Авторизация через VK не настроена на сервере');
    $p = $body['params'] ?? [];
    if (is_string($p)) {
        $out = [];
        parse_str($p, $out);
        $p = $out;
    }
    if (!is_array($p)) $p = [];
    if (!vkMiniSignValid($p)) {
        error_log('authVkMini: invalid VK sign, params=' . json_encode(array_keys($p), JSON_UNESCAPED_UNICODE));
        fail('Подпись VK недействительна', 401);
    }
    $uid = preg_replace('/\D/', '', (string)($p['vk_user_id'] ?? ''));
    if ($uid === '') fail('Не передан vk_user_id');
    $nameRaw = is_array($body['user'] ?? null) ? ($body['user']['name'] ?? '') : '';
    $name = cleanName($nameRaw !== '' ? $nameRaw : 'Игрок VK');
    // Если этот VK id привязан к обычному аккаунту (через linkVk) — входим под ним.
    $st = db()->prepare('SELECT id FROM users WHERE vk_id = ? LIMIT 1');
    $st->execute([$uid]);
    $linkedId = $st->fetchColumn();
    if ($linkedId !== false) {
        $lid = (int)$linkedId;
        $st = db()->prepare('UPDATE users SET name = ? WHERE id = ?');
        $st->execute([$name, $lid]);
        authRespondUser(authGetUserById($lid));
    }
    $id = authFindUserId('vkmini', $uid);
    if ($id !== null) {
        // имя подтягиваем из профиля при каждом входе
        $st = db()->prepare('UPDATE users SET name = ? WHERE id = ?');
        $st->execute([$name, $id]);
    } else {
        authCreateUser('vkmini', $uid, '', $name, null); // verified=1 по умолчанию
    }
    $id = authFindUserId('vkmini', $uid);
    if ($id === null) fail('Ошибка данных пользователя');
    authRespondUser(authGetUserById($id));
}

if ($action === 'create') {
    $cu = currentUser($body);
    $name = cleanName($cu['name'] ?? ($body['name'] ?? ''));
    $max = (int)($body['max'] ?? 4);
    if ($max < 2 || $max > MAX_PLAYERS) fail('Число участников — от 2 до ' . MAX_PLAYERS);
    $code = newCode();
    $player = makePlayer(0, $name, false);
    if ($cu !== null) {
        $player['userId'] = (int)$cu['id'];
        $player['rating'] = ratingSnapshot(null, (int)$cu['id']);
    } else {
        // Незарегистрированный участник в сетевой игре имеет базовый рейтинг
        $player['rating'] = RATING_START;
    }
    $room = [
        'code' => $code,
        'name' => newRoomName(),
        'createdAt' => time(),
        'lastActivity' => time(),
        'version' => 0,
        'phase' => 'lobby',
        'hostId' => 0,
        'nextId' => 1,
        'maxPlayers' => $max,
        'players' => [$player],
        'userIds' => $cu !== null ? [(int)$cu['id'] => 0] : [],
        'rows' => [],
        'round' => 0,
        'turn' => 0,
        'queue' => null,
        'qIndex' => 0,
        'waitingFor' => null,
        'lastEvents' => [],
        'summary' => null,
    ];
    $r = redis();
    $r->set(roomKey($code), json_encode($room, JSON_UNESCAPED_UNICODE));
    $r->expire(roomKey($code), ROOM_TTL);
    respond(['ok' => true, 'room' => $code, 'you' => 0, 'token' => $player['token']]);
}

if ($action === 'rooms') {
    respond(['ok' => true, 'rooms' => listOpenRooms()]);
}

/* ===== Зал славы: топы за день и за неделю ===== */

function topsForPeriod(int $since): array {
    $empty = ['rating' => [], 'neat' => [], 'donut' => []];
    try {
        $st = db()->prepare('SELECT u.name AS name,
               COUNT(*) AS g,
               SUM(gp.total) AS s,
               AVG(gp.total) AS avgp,
               SUM(gp.rating_after - gp.rating_before) AS d,
               MAX(r.rating) AS cur
            FROM game_players gp
            JOIN games gm ON gm.id = gp.game_id
            JOIN users u ON u.id = gp.user_id
            LEFT JOIN ratings r ON r.user_id = gp.user_id
            WHERE gm.finished_at >= ?
            GROUP BY gp.user_id, u.name');
        $st->execute([$since]);
        $rows = $st->fetchAll();
        if (!$rows) return $empty;

        foreach ($rows as &$r) {
            foreach (['g', 's', 'd', 'cur'] as $k) $r[$k] = (int)$r[$k];
            $r['avgp'] = (float)$r['avgp'];
        }
        unset($r);

        $rating = $rows;
        usort($rating, fn($a, $b) => [$b['d'], $b['cur']] <=> [$a['d'], $a['cur']]);
        $rating = array_slice($rating, 0, TOPS_LIMIT);

        $neat = array_slice(array_values(array_filter($rows, fn($r) => $r['g'] > 0)), 0);
        usort($neat, fn($a, $b) => [$a['avgp'], $a['g']] <=> [$b['avgp'], $b['g']]);
        $neat = array_slice($neat, 0, TOPS_LIMIT);

        $donut = $rows;
        usort($donut, fn($a, $b) => [$b['s'], $b['g']] <=> [$a['s'], $a['g']]);
        $donut = array_slice($donut, 0, TOPS_LIMIT);

        return [
            'rating' => array_map(fn($r) => [
                'name' => $r['name'], 'delta' => $r['d'],
                'rating' => $r['cur'] ?: RATING_START, 'games' => $r['g'],
            ], $rating),
            'neat' => array_map(fn($r) => [
                'name' => $r['name'], 'avg' => round($r['avgp'], 1), 'games' => $r['g'],
            ], $neat),
            'donut' => array_map(fn($r) => [
                'name' => $r['name'], 'donuts' => $r['s'], 'games' => $r['g'],
            ], $donut),
        ];
    } catch (Throwable $e) {
        return $empty;
    }
}

function topsPayload(): array {
    $now = time();
    return ['day' => topsForPeriod($now - 86400), 'week' => topsForPeriod($now - 7 * 86400)];
}

if ($action === 'tops') {
    $out = ['ok' => true] + topsPayload();
    try {
        $pdo = db();
        $stB = $pdo->query('SELECT u.name AS name, r.rating AS rating, r.games AS games
            FROM ratings r JOIN users u ON u.id = r.user_id
            WHERE r.games > 0
            ORDER BY r.rating DESC, r.games DESC, u.name ASC
            LIMIT 100');
        $out['board'] = array_map(fn($r) => [
            'name' => $r['name'], 'rating' => (int)$r['rating'], 'games' => (int)$r['games'],
        ], $stB->fetchAll());
        $out['total'] = (int)$pdo->query('SELECT COUNT(*) FROM ratings WHERE games > 0')->fetchColumn();

        $cu = currentUser($body);
        if ($cu !== null) {
            $stM = $pdo->prepare('SELECT rating, games FROM ratings WHERE user_id = ?');
            $stM->execute([(int)$cu['id']]);
            $me = $stM->fetch();
            if ($me !== false && (int)$me['games'] > 0) {
                $stP = $pdo->prepare('SELECT COUNT(*) FROM ratings WHERE games > 0 AND rating > ?');
                $stP->execute([(int)$me['rating']]);
                $out['you'] = ['place' => (int)$stP->fetchColumn() + 1, 'rating' => (int)$me['rating'], 'games' => (int)$me['games']];
            } else {
                $out['you'] = null;
            }
        } else {
            $out['you'] = null;
        }
    } catch (Throwable $e) {
        $out['board'] = [];
        $out['total'] = 0;
        $out['you'] = null;
    }
    respond($out);
}

if ($action === 'join') {
    $code = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', (string)($body['room'] ?? '')));
    $cu = currentUser($body);
    $result = withRoom($code, function (array &$room) use ($body, $cu) {
        if ($room['phase'] !== 'lobby') return ['ok' => false, 'error' => 'Игра в этой комнате уже началась'];
        $max = (int)($room['maxPlayers'] ?? MAX_PLAYERS);
        if ($cu !== null && isset($room['userIds'][(int)$cu['id']])) {
            return ['ok' => false, 'error' => 'Вы уже в этой комнате'];
        }
        if (count($room['players']) >= $max) return ['ok' => false, 'error' => 'Комната заполнена'];
        $id = $room['nextId']++;
        $p = makePlayer($id, cleanName($cu['name'] ?? ($body['name'] ?? '')), false);
        if ($cu !== null) {
            $p['userId'] = (int)$cu['id'];
            $p['rating'] = ratingSnapshot(null, (int)$cu['id']);
            $room['userIds'][(int)$cu['id']] = $id;
        } else {
            // Незарегистрированный участник в сетевой игре имеет базовый рейтинг
            $p['rating'] = RATING_START;
        }
        $room['players'][] = $p;
        bumpRoom($room);
        $started = false;
        if (count($room['players']) >= $max) {
            startRound($room);
            $started = true;
        }
        return ['ok' => true, 'room' => $room['code'], 'you' => $id, 'token' => $p['token'], 'started' => $started];
    });
    if ($result === null) fail('Комната не найдена', 404);
    if (!$result['ok']) fail($result['error'], 409);
    respond($result);
}

if ($action === 'state') {
    $code = strtoupper((string)($body['room'] ?? ''));
    $token = (string)($body['token'] ?? '');
    $out = withRoom($code, function (array &$room) use ($token) {
        $idx = findPlayerIdx($room, $token);
        if ($idx === -1) return ['gone' => true];
        $room['players'][$idx]['lastSeen'] = time();
        $converted = false;
        foreach ($room['players'] as $i => $p) {
            if (!$p['isBot'] && time() - $p['lastSeen'] > STALE_SECONDS) {
                convertToBot($room, $i);
                $converted = true;
            }
        }
        if (!humansLeft($room)) return '__delete';
        if ($converted) bumpRoom($room);
        return snapshot($room, $idx);
    });
    if ($out === null) fail('Комната закрыта', 410);
    if (isset($out['gone'])) fail('Вы не в этой комнате', 401);
    respond($out);
}

if ($action === 'chat') {
    $code = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', (string)($body['room'] ?? '')));
    $token = (string)($body['token'] ?? '');
    $text = trim((string)($body['text'] ?? ''));
    if ($text === '') fail('Пустое сообщение');
    if (mb_strlen($text) > 200) $text = mb_substr($text, 0, 200);
    $text = filterProfanity($text);
    $out = withRoom($code, function (array &$room) use ($token) {
        $idx = findPlayerIdx($room, $token);
        if ($idx === -1) return ['__unauth' => true];
        $p = $room['players'][$idx];
        bumpRoom($room);
        return ['ok' => true, 'p' => ['id' => $p['id'], 'name' => $p['name'], 'avatar' => $p['avatar']]];
    });
    if ($out === null || isset($out['__unauth'])) fail('Вы не в этой комнате', 401);
    $r = redis();
    $id = $r->incr('chatseq:' . $code);
    $r->expire('chatseq:' . $code, ROOM_TTL);
    $entry = json_encode([
        'id' => $id,
        'pid' => $out['p']['id'],
        'name' => $out['p']['name'],
        'avatar' => $out['p']['avatar'],
        'text' => $text,
        'ts' => time(),
    ], JSON_UNESCAPED_UNICODE);
    $r->lPush(chatKey($code), $entry);
    $r->lTrim(chatKey($code), 0, 99);
    $r->expire(chatKey($code), ROOM_TTL);
    respond(['ok' => true, 'id' => $id]);
}

$authed = function (callable $fn) use ($body) {
    $code = strtoupper((string)($body['room'] ?? ''));
    $token = (string)($body['token'] ?? '');
    return withRoom($code, function (array &$room) use ($fn, $token) {
        $idx = findPlayerIdx($room, $token);
        if ($idx === -1) return ['__unauth' => true];
        $room['players'][$idx]['lastSeen'] = time();
        return $fn($room, $idx);
    });
};

switch ($action) {
    case 'play': {
        $card = (int)($body['card'] ?? 0);
        $out = $authed(function (array &$room, int $idx) use ($card) {
            if ($room['phase'] !== 'pick') return ['ok' => false, 'error' => 'Сейчас нельзя играть карту'];
            $p = &$room['players'][$idx];
            if ($p['isBot']) return ['ok' => false, 'error' => 'Вы вышли из игры'];
            if ($p['card'] !== null) return ['ok' => false, 'error' => 'Карта на этот ход уже сыграна'];
            if (!in_array($card, $p['hand'], true)) return ['ok' => false, 'error' => 'Такой карты нет у вас в руке'];
            $p['hand'] = array_values(array_diff($p['hand'], [$card]));
            $p['card'] = $card;
            bumpRoom($room);
            resolveIfReady($room);
            return ['ok' => true];
        });
        if ($out === null) fail('Комната не найдена', 404);
        if (isset($out['__unauth'])) fail('Вы не в этой комнате', 401);
        if (!$out['ok']) fail($out['error'], 409);
        respond($out);
    }

    case 'choose_row': {
        $row = (int)($body['row'] ?? -1);
        $out = $authed(function (array &$room, int $idx) use ($row) {
            if ($room['phase'] !== 'choose_row' || $room['waitingFor'] !== $idx) {
                return ['ok' => false, 'error' => 'Сейчас не ваш выбор ряда'];
            }
            if ($row < 0 || $row >= ROW_COUNT) return ['ok' => false, 'error' => 'Неверный ряд'];
            applyTake($room, $idx, $room['queue'][$room['qIndex']]['card'], $row, 'forced');
            $room['qIndex']++;
            $room['waitingFor'] = null;
            $room['phase'] = 'resolve';
            bumpRoom($room);
            advanceResolve($room);
            return ['ok' => true];
        });
        if ($out === null) fail('Комната не найдена', 404);
        if (isset($out['__unauth'])) fail('Вы не в этой комнате', 401);
        if (!$out['ok']) fail($out['error'], 409);
        respond($out);
    }

    case 'next_round': {
        $out = $authed(function (array &$room, int $idx) {
            if ($room['players'][$idx]['id'] !== $room['hostId']) return ['ok' => false, 'error' => 'Только хозяин комнаты начинает новый тур'];
            if ($room['phase'] !== 'round_end') return ['ok' => false, 'error' => 'Тур ещё не закончился'];
            bumpRoom($room);
            startRound($room);
            return ['ok' => true];
        });
        if ($out === null) fail('Комната не найдена', 404);
        if (isset($out['__unauth'])) fail('Вы не в этой комнате', 401);
        if (!$out['ok']) fail($out['error'], 409);
        respond($out);
    }

    case 'rematch': {
        // Реванш только при игре ровно вдвоём (без ботов) и только когда
        // подтвердят ОБА игрока: первый клик фиксирует согласие,
        // второй запускает новую партию.
        $out = $authed(function (array &$room, int $idx) {
            if ($room['phase'] !== 'game_end') return ['ok' => false, 'error' => 'Игра ещё не закончилась'];
            if (count($room['players']) !== 2) return ['ok' => false, 'error' => 'Реванш доступен только в игре вдвоём'];
            foreach ($room['players'] as $p) {
                if ($p['isBot']) return ['ok' => false, 'error' => 'Реванш доступен только в игре вдвоём'];
            }
            $pid = $room['players'][$idx]['id'];
            $otherPid = $room['players'][$idx === 0 ? 1 : 0]['id'];
            $rm = is_array($room['rematch'] ?? null) ? $room['rematch'] : [];
            if (!empty($rm[$pid])) return ['ok' => true, 'waiting' => true];
            $rm[$pid] = true;
            if (empty($rm[$otherPid])) {
                $room['rematch'] = $rm;
                bumpRoom($room);
                return ['ok' => true, 'waiting' => true];
            }
            unset($room['rematch']);
            foreach ($room['players'] as &$p) {
                $p['total'] = 0;
                $p['taken'] = [];
                $p['hand'] = [];
                $p['card'] = null;
            }
            unset($p);
            $room['round'] = 0;
            bumpRoom($room);
            startRound($room);
            return ['ok' => true, 'started' => true];
        });
        if ($out === null) fail('Комната не найдена', 404);
        if (isset($out['__unauth'])) fail('Вы не в этой комнате', 401);
        if (!$out['ok']) fail($out['error'], 409);
        respond($out);
    }

    case 'leave': {
        $out = $authed(function (array &$room, int $idx) {
            $wasHost = $room['players'][$idx]['id'] === $room['hostId'];
            if ($room['phase'] === 'lobby') {
                $uid = $room['players'][$idx]['userId'] ?? null;
                array_splice($room['players'], $idx, 1);
                if ($uid !== null) unset($room['userIds'][$uid]);
                if (!count($room['players'])) return '__delete';
                if ($wasHost) {
                    $newHost = null;
                    foreach ($room['players'] as $p) {
                        if (!$p['isBot']) { $newHost = $p['id']; break; }
                    }
                    if ($newHost === null) return '__delete';
                    $room['hostId'] = $newHost;
                }
                bumpRoom($room);
                return ['ok' => true];
            }
            convertToBot($room, $idx);
            if (!humansLeft($room)) return '__delete';
            bumpRoom($room);
            return ['ok' => true];
        });
        if (isset($out['__unauth'])) fail('Вы не в этой комнате', 401);
        if ($out === null) fail('Комната не найдена', 404);
        respond(['ok' => true]);
    }

    default:
        fail('Неизвестное действие');
}

