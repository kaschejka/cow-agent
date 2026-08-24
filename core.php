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
