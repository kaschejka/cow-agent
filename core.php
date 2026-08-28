<?php
declare(strict_types=1);

// Общее ядро: конфигурация из .env, подключения к MySQL и Redis.
// Подключается и из api.php, и из worker.php (обработчик очереди писем).

function envLoad(string $path): void {
    if (!is_file($path)) return;
    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (!is_array($lines)) return;
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#' || !str_contains($line, '=')) continue;
        $pos = strpos($line, '=');
        $k = trim(substr($line, 0, $pos));
        $v = trim(substr($line, $pos + 1));
        $len = strlen($v);
        if ($len >= 2 && (($v[0] === '"' && $v[$len - 1] === '"') || ($v[0] === "'" && $v[$len - 1] === "'"))) {
            $v = substr($v, 1, -1);
        }
        $_ENV[$k] = $v;
    }
}
envLoad(__DIR__ . '/.env');

function env(string $key, string $default = ''): string {
    $v = $_ENV[$key] ?? getenv($key);
    return ($v === false || $v === null || $v === '') ? $default : (string)$v;
}

define('VK_APP_ID', env('VK_APP_ID', ''));
define('VK_APP_SECRET', env('VK_APP_SECRET', ''));
// Точный redirect_uri для OAuth VK (должен совпадать с адресом в настройках
// приложения на dev.vk.com). Пусто = брать из текущего запроса.
define('VK_REDIRECT_URI', env('VK_REDIRECT_URI', ''));
define('AUTH_SESSION_TTL', (int)env('AUTH_SESSION_TTL', '2592000'));

define('REDIS_HOSTS', array_values(array_filter(array_map('trim', explode(',', env('REDIS_HOSTS', '127.0.1.55,127.0.0.1'))))));
define('REDIS_PORT', (int)env('REDIS_PORT', '6379'));

define('DB_HOST', env('DB_HOST', '127.0.0.1'));
define('DB_PORT', env('DB_PORT', '3306'));
define('DB_NAME', env('DB_NAME', 'cows'));
define('DB_USER', env('DB_USER', 'root'));
define('DB_PASS', env('DB_PASS', ''));

const LOCK_TTL = 5;

function respond(array $d, int $code = 200): void {
    http_response_code($code);
    echo json_encode($d, JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(string $msg, int $code = 400): void {
    respond(['ok' => false, 'error' => $msg], $code);
}

function db(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        try {
            $dsn = 'mysql:host=' . DB_HOST . ';port=' . DB_PORT . ';dbname=' . DB_NAME . ';charset=utf8mb4';
            $pdo = new PDO($dsn, DB_USER, DB_PASS, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_TIMEOUT => 3,
            ]);
            $pdo->exec("CREATE TABLE IF NOT EXISTS users (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT,
                provider VARCHAR(16) NOT NULL,
                ext_id VARCHAR(191) NOT NULL,
                login VARCHAR(32) DEFAULT NULL,
                pass_hash VARCHAR(255) DEFAULT NULL,
                name VARCHAR(24) NOT NULL,
                email VARCHAR(191) DEFAULT NULL,
                email_verified TINYINT(1) NOT NULL DEFAULT 0,
                confirm_token CHAR(64) DEFAULT NULL,
                created_at INT UNSIGNED NOT NULL,
                PRIMARY KEY (id),
                UNIQUE KEY uidx (provider, ext_id),
                UNIQUE KEY login (login)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
            dbMigrateUsers($pdo);
            $pdo->exec("CREATE TABLE IF NOT EXISTS jobs (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                type VARCHAR(64) NOT NULL,
                payload TEXT NOT NULL,
                status ENUM('pending','processing','sent','failed') NOT NULL DEFAULT 'pending',
                attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
                next_attempt_at INT UNSIGNED NOT NULL,
                created_at INT UNSIGNED NOT NULL,
                updated_at INT UNSIGNED NOT NULL,
                last_error VARCHAR(500) DEFAULT NULL,
                PRIMARY KEY (id),
                KEY idx_due (status, next_attempt_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
            dbMigrateRatings($pdo);
        } catch (PDOException $e) {
            fail('База данных недоступна, попробуйте позже', 503);
        }
    }
    return $pdo;
}

/** Добавляет колонки e-mail-подтверждения к таблице users старых установок. */
function dbMigrateUsers(PDO $pdo): void {
    $has = $pdo->query("SHOW COLUMNS FROM users LIKE 'email'")->fetch();
    if (!$has) {
        $pdo->exec("ALTER TABLE users
            ADD COLUMN email VARCHAR(191) DEFAULT NULL AFTER name,
            ADD COLUMN email_verified TINYINT(1) NOT NULL DEFAULT 0 AFTER email,
            ADD COLUMN confirm_token CHAR(64) DEFAULT NULL AFTER email_verified");
    }
    try {
        $pdo->exec("ALTER TABLE users ADD UNIQUE KEY uq_email (email)");
    } catch (PDOException $e) {
        // индекс уже существует или в данных дубликаты — не критично
    }
    // Привязка локального аккаунта к VK id (только один пользователь на один VK id)
    $hasVk = $pdo->query("SHOW COLUMNS FROM users LIKE 'vk_id'")->fetch();
    if (!$hasVk) {
        $pdo->exec("ALTER TABLE users ADD COLUMN vk_id VARCHAR(64) DEFAULT NULL AFTER email_verified");
    }
    try {
        $pdo->exec("ALTER TABLE users ADD UNIQUE KEY uq_vk_id (vk_id)");
    } catch (PDOException $e) {
        // индекс уже существует или в данных дубликаты — не критично
    }
}

/* ===== Рейтинг и статистика ===== */

function dbMigrateRatings(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS games (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        room_code CHAR(8) NOT NULL,
        finished_at INT UNSIGNED NOT NULL,
        PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $pdo->exec("CREATE TABLE IF NOT EXISTS game_players (
        game_id BIGINT UNSIGNED NOT NULL,
        user_id INT UNSIGNED NOT NULL,
        place SMALLINT UNSIGNED NOT NULL,
        total INT NOT NULL,
        sixth_takes INT NOT NULL DEFAULT 0,
        forced_takes INT NOT NULL DEFAULT 0,
        rating_before INT NOT NULL,
        rating_after INT NOT NULL,
        PRIMARY KEY (game_id, user_id),
        KEY idx_gp_user (user_id, game_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $pdo->exec("CREATE TABLE IF NOT EXISTS ratings (
        user_id INT UNSIGNED NOT NULL PRIMARY KEY,
        rating INT NOT NULL DEFAULT 1000,
        games INT NOT NULL DEFAULT 0,
        wins INT NOT NULL DEFAULT 0,
        top3 INT NOT NULL DEFAULT 0,
        sum_penalty INT NOT NULL DEFAULT 0,
        best_game INT DEFAULT NULL,
        worst_game INT DEFAULT NULL,
        win_streak INT NOT NULL DEFAULT 0,
        best_streak INT NOT NULL DEFAULT 0,
        sixth_takes INT NOT NULL DEFAULT 0,
        forced_takes INT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}

const RATING_START = 1000;
const RATING_K = 24.0;

/**
 * Попарный Эло по местам (place-Elo).
 * $standings — отсортированный по возрастанию штрафа список:
 *   [['total'=>int,'rating'=>int], ...]
 * Возвращает ['places'=>[...], 'deltas'=>[...], 'newRating'=>[...]] —
 * индексы массивов соответствуют позициям входного списка.
 */
function ratingCompute(array $standings, float $k = RATING_K): array {
    $n = count($standings);
    $places = [];
    foreach ($standings as $i => $s) {
        $place = 1;
        foreach ($standings as $t) {
            if ($t['total'] < $s['total']) $place++;
        }
        $places[$i] = $place;
    }
    $deltas = array_fill(0, $n, 0.0);
    $newRating = [];
    foreach ($standings as $i => $s) {
        $newRating[$i] = (float)($s['rating'] ?? RATING_START);
    }
    for ($a = 0; $a < $n; $a++) {
        for ($b = $a + 1; $b < $n; $b++) {
            $ra = (float)($standings[$a]['rating'] ?? RATING_START);
            $rb = (float)($standings[$b]['rating'] ?? RATING_START);
            $sa = $places[$a] < $places[$b] ? 1.0 : ($places[$a] === $places[$b] ? 0.5 : 0.0);
            $ea = 1.0 / (1.0 + pow(10.0, ($rb - $ra) / 400.0));
            $d = $k * ($sa - $ea);
            $deltas[$a] += $d;
            $deltas[$b] -= $d;
        }
    }
    foreach ($standings as $i => $s) {
        $newRating[$i] = (int)round($newRating[$i] + $deltas[$i]);
        $deltas[$i] = (int)round($deltas[$i]);
    }
    return ['places' => $places, 'deltas' => $deltas, 'newRating' => $newRating];
}

/** Текущая строка рейтингов или строка с дефолтами для новичка. */
function ratingRowDefault(int $uid): array {
    return [
        'user_id' => $uid, 'rating' => RATING_START, 'games' => 0, 'wins' => 0,
        'top3' => 0, 'sum_penalty' => 0, 'best_game' => null, 'worst_game' => null,
        'win_streak' => 0, 'best_streak' => 0, 'sixth_takes' => 0, 'forced_takes' => 0,
    ];
}

function ratingFetchMap(PDO $pdo, array $uids): array {
    if (!$uids) return [];
    $in = implode(',', array_fill(0, count($uids), '?'));
    $st = $pdo->prepare("SELECT * FROM ratings WHERE user_id IN ($in)");
    $st->execute(array_map('intval', $uids));
    $map = [];
    foreach ($st->fetchAll() as $row) $map[(int)$row['user_id']] = $row;
    return $map;
}

/** Полностью пересчитанная строка статистики после партии — апсертится как есть. */
function ratingUpsert(PDO $pdo, array $row): void {
    $st = $pdo->prepare('INSERT INTO ratings
        (user_id, rating, games, wins, top3, sum_penalty, best_game, worst_game, win_streak, best_streak, sixth_takes, forced_takes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        rating=VALUES(rating), games=VALUES(games), wins=VALUES(wins), top3=VALUES(top3),
        sum_penalty=VALUES(sum_penalty), best_game=VALUES(best_game), worst_game=VALUES(worst_game),
        win_streak=VALUES(win_streak), best_streak=VALUES(best_streak),
        sixth_takes=VALUES(sixth_takes), forced_takes=VALUES(forced_takes)');
    $st->execute([
        (int)$row['user_id'], (int)$row['rating'], (int)$row['games'], (int)$row['wins'],
        (int)$row['top3'], (int)$row['sum_penalty'],
        $row['best_game'] !== null ? (int)$row['best_game'] : null,
        $row['worst_game'] !== null ? (int)$row['worst_game'] : null,
        (int)$row['win_streak'], (int)$row['best_streak'],
        (int)$row['sixth_takes'], (int)$row['forced_takes'],
    ]);
}

/** Рейтинг для показа в лобби: 1000, если партий ещё не было. */
function ratingSnapshot(?PDO $pdo, int $uid): int {
    $own = $pdo === null;
    if ($own) { try { $pdo = db(); } catch (Throwable $e) { return RATING_START; } }
    try {
        $st = $pdo->prepare('SELECT rating FROM ratings WHERE user_id = ?');
        $st->execute([$uid]);
        $r = $st->fetch();
        return $r === false ? RATING_START : (int)$r['rating'];
    } catch (Throwable $e) {
        return RATING_START;
    }
}

/** Создаёт строку рейтинга с базовым значением (при регистрации аккаунта). */
function ratingEnsureRow(?PDO $pdo, int $uid): void {
    $own = $pdo === null;
    if ($own) { try { $pdo = db(); } catch (Throwable $e) { return; } }
    try {
        $st = $pdo->prepare('INSERT IGNORE INTO ratings (user_id, rating) VALUES (?, ?)');
        $st->execute([$uid, RATING_START]);
    } catch (Throwable $e) {
        // не критично: базовые значения подставляются лениво при чтении
    }
}

function redis(): Redis {
    static $r = null;
    if ($r === null) {
        $r = new Redis();
        $ok = false;
        foreach (REDIS_HOSTS as $host) {
            if (@$r->connect($host, REDIS_PORT, 1.5)) { $ok = true; break; }
        }
        if (!$ok) fail('Хранилище недоступно, попробуйте позже', 503);
        $r->setOption(Redis::OPT_SERIALIZER, Redis::SERIALIZER_NONE);
    }
    return $r;
}

/* ===== Фоновые задания: MySQL outbox + Redis для быстрой доставки =====
 *
 * Источник правды — таблица jobs. Redis (список jobs:queue) только ускоряет
 * пробуждение воркера: при потере Redis воркер подберёт задачи свёркой по БД.
 */

function jobEnqueue(string $type, array $payload, int $delay = 0, ?PDO $pdo = null): int {
    $own = $pdo === null;
    if ($own) $pdo = db();
    $now = time();
    $st = $pdo->prepare('INSERT INTO jobs (type, payload, status, attempts, next_attempt_at, created_at, updated_at)
                         VALUES (?, ?, \'pending\', 0, ?, ?, ?)');
    $st->execute([$type, json_encode($payload, JSON_UNESCAPED_UNICODE), $now + $delay, $now, $now]);
    $id = (int)$pdo->lastInsertId();
    if ($delay <= 0) {
        try { redis()->lPush('jobs:queue', (string)$id); } catch (Throwable $e) { /* подберёт свёрка */ }
    }
    return $id;
}

/** Атомарно захватывает задачу; возвращает строку или null. */
function jobClaim(PDO $pdo, int $id): ?array {
    $st = $pdo->prepare("UPDATE jobs SET status='processing', updated_at=? WHERE id=? AND status='pending'");
    $st->execute([time(), $id]);
    if ($st->rowCount() !== 1) return null;
    $row = $pdo->prepare('SELECT * FROM jobs WHERE id = ?');
    $row->execute([$id]);
    $j = $row->fetch();
    return $j === false ? null : $j;
}

/** Отмечает результат выполнения и планирует ретрай при неудаче. */
function jobFinish(PDO $pdo, array $job, bool $ok, string $err = ''): void {
    if ($ok) {
        $st = $pdo->prepare("UPDATE jobs SET status='sent', updated_at=?, last_error=NULL WHERE id=?");
        $st->execute([time(), $job['id']]);
        return;
    }
    $attempts = (int)$job['attempts'] + 1;
    if ($attempts >= 5) {
        $st = $pdo->prepare("UPDATE jobs SET status='failed', attempts=?, updated_at=?, last_error=? WHERE id=?");
        $st->execute([$attempts, time(), mb_substr($err, 0, 500), $job['id']]);
        return;
    }
    $backoff = 60 * (2 ** ($attempts - 1)); // 1, 2, 4, 8 минут
    $st = $pdo->prepare("UPDATE jobs SET status='pending', attempts=?, next_attempt_at=?, updated_at=?, last_error=? WHERE id=?");
    $st->execute([$attempts, time() + $backoff, time(), mb_substr($err, 0, 500), $job['id']]);
}
