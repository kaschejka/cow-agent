<?php
declare(strict_types=1);

// Фоновый обработчик задач (очередь писем и будущих фоновых работ).
// Запуск:  php worker.php
// Остановка: Ctrl+C. Для продакшена — systemd/supervisor/Планировщик Windows.

require __DIR__ . '/core.php';
require __DIR__ . '/smtp_mailer.php';

const SWEEP_INTERVAL = 5;      // сек между свёрками БД (страховка при потере Redis)
const PENDING_TTL_DAYS = 14;   // сколько дней хранить неподтверждённые аккаунты
const CLEANUP_EVERY = 3600;    // период чистки, сек

/* ===== Реестр обработчиков =====
 * Каждая фоновая задача = type + payload. Новые фоновые работы добавляются сюда.
 */

$handlers = [
    'mail.send' => function (array $p): bool|string {
        if (empty($p['to']) || !filter_var($p['to'], FILTER_VALIDATE_EMAIL)) return 'bad recipient';
        $r = smtpSend((string)$p['to'], (string)($p['subject'] ?? ''), (string)($p['html'] ?? ''));
        if ($r === true && env('SMTP_HOST', '') === '') {
            out('[dev] SMTP не настроен — письмо к ' . $p['to'] . ' пропущено');
        }
        return $r;
    },
];

function out(string $s): void {
    echo '[' . date('Y-m-d H:i:s') . '] ' . $s . "\n";
}

/** Обрабатывает одну задачу из БД. */
function processJob(array $handlers, array $job): void {
    $id = (int)$job['id'];
    $type = (string)$job['type'];
    if (!isset($handlers[$type])) {
        jobFinish(db(), $job, false, "нет обработчика для '$type'");
        out("#$id $type — НЕТ ОБРАБОТЧИКА");
        return;
    }
    $payload = json_decode((string)$job['payload'], true);
    if (!is_array($payload)) $payload = [];
    $t0 = microtime(true);
    $r = ($handlers[$type])($payload);
    $ms = (int)((microtime(true) - $t0) * 1000);
    jobFinish(db(), $job, $r === true, is_string($r) ? $r : 'error');
    out($r === true ? "#$id {$type} — ок ({$ms}ms)" : "#$id {$type} — ошибка: $r");
}

/** Свёрка по БД: подбирает задачи, потерянные вместе с Redis, и отложенные ретраи. */
function sweepDueJobs(array $handlers): int {
    $st = db()->query("SELECT * FROM jobs WHERE status='pending' AND next_attempt_at <= " . time() . ' ORDER BY id LIMIT 20');
    $rows = $st->fetchAll();
    foreach ($rows as $j) {
        $claimed = jobClaim(db(), (int)$j['id']);
        if ($claimed !== null) processJob($handlers, $claimed);
    }
    return count($rows);
}

/** Удаляет давно неподтверждённые локальные аккаунты (освобождает логин и почту). */
function cleanupStalePending(): void {
    $cutoff = time() - PENDING_TTL_DAYS * 86400;
    $st = db()->prepare("DELETE FROM users WHERE provider='local' AND email_verified=0 AND email IS NOT NULL AND created_at < ?");
    $st->execute([$cutoff]);
    if ($st->rowCount() > 0) out('cleanup: удалено неподтверждённых аккаунтов: ' . $st->rowCount());
}

out('worker запущен' . (env('SMTP_HOST', '') === '' ? ' (SMTP не настроен — письма только логируются)' : ''));
$lastSweep = 0;
$lastCleanup = 0;

while (true) {
    $now = time();

    // Быстрый путь: задача из Redis-очереди
    try {
        $pop = redis()->brPop(['jobs:queue'], 2);
    } catch (Throwable $e) {
        $pop = null;
    }
    if (is_array($pop) && isset($pop[1])) {
        $jid = (int)$pop[1];
        $st = db()->prepare('SELECT * FROM jobs WHERE id = ?');
        $st->execute([$jid]);
        $j = $st->fetch();
        if ($j !== false && (int)$j['next_attempt_at'] <= $now) {
            $claimed = jobClaim(db(), $jid);
            if ($claimed !== null) processJob($handlers, $claimed);
        }
    }

    // Медленный путь: свёрка с БД (ретраи, задачи при пустом/упавшем Redis)
    if ($now - $lastSweep >= SWEEP_INTERVAL) {
        $lastSweep = $now;
        try {
            $n = sweepDueJobs($handlers);
            if ($n > 0) out("sweep: обработано из БД: $n");
        } catch (Throwable $e) {
            out('sweep error: ' . $e->getMessage());
        }
    }

    // Периодическая чистка
    if ($now - $lastCleanup >= CLEANUP_EVERY) {
        $lastCleanup = $now;
        try { cleanupStalePending(); } catch (Throwable $e) { out('cleanup error: ' . $e->getMessage()); }
    }
}
