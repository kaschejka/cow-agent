<?php
declare(strict_types=1);

// Минимальный SMTP-клиент (без внешних зависимостей).
// Поддерживает: ssl:// и STARTTLS, AUTH LOGIN, UTF-8/HTML-письма.
// Конфиг берётся из .env: SMTP_HOST, SMTP_PORT, SMTP_SECURE (ssl|tls|none), SMTP_USER, SMTP_PASS.

function smtpBuildMessage(string $from, string $fromName, string $to, string $subject, string $html): array {
    $eol = "\r\n";
    $headers = [
        'From: =?UTF-8?B?' . base64_encode($fromName) . '?= <' . $from . '>',
        'To: <' . $to . '>',
        'Subject: =?UTF-8?B?' . base64_encode($subject) . '?=',
        'Date: ' . date('r'),
        'Message-ID: <' . bin2hex(random_bytes(16)) . '@' . ($_SERVER['HTTP_HOST'] ?? 'localhost') . '>',
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
    ];
    // лимит SMTP — строки не длиннее 998 байт
    $body = chunk_split(base64_encode($html), 76, $eol);
    return [implode($eol, $headers) . $eol . $eol . $body, implode(', ', [$headers[0], $headers[2]])];
}

/** Возвращает true при успехе, иначе текст ошибки. */
function smtpSend(string $to, string $subject, string $html): bool|string {
    $host = env('SMTP_HOST', '');
    if ($host === '') return true; // dev-режим: отправка не настроена, письмо «доставлено» в лог

    $port = (int)env('SMTP_PORT', '587');
    $secure = strtolower(env('SMTP_SECURE', 'tls')); // tls = STARTTLS, ssl = сразу шифрование
    $user = env('SMTP_USER', '');
    $pass = env('SMTP_PASS', '');
    $from = env('MAIL_FROM', $user);
    $fromName = env('MAIL_FROM_NAME', 'Еноты-агенты');
    if ($from === '') return 'MAIL_FROM не задан';

    $transport = $secure === 'ssl' ? 'ssl://' : '';
    $sock = @stream_socket_client("$transport$host:$port", $errno, $errstr, 10);
    if (!$sock) return "connect: $errstr";
    stream_set_timeout($sock, 10);

    $read = function () use ($sock): string|bool {
        $data = '';
        while (($line = fgets($sock, 1024)) !== false) {
            $data .= $line;
            if (strlen($line) < 4 || $line[3] !== '-') break; // конец многострочного ответа
        }
        return $data;
    };
    $cmd = function (string $c, array $expect) use ($sock, $read): string|bool {
        fwrite($sock, $c . "\r\n");
        $resp = $read();
        if ($resp === false || $resp === '') return false;
        $code = (int)substr($resp, 0, 3);
        return in_array($code, $expect, true) ? $resp : "$c -> $resp";
    };

    try {
        $greet = $read();
        if ($greet === false || (int)substr($greet, 0, 3) !== 220) return "greeting: $greet";

        $ehloHost = $_SERVER['HTTP_HOST'] ?? 'localhost';
        $r = $cmd('EHLO ' . $ehloHost, [250]);
        if ($r === false) return "EHLO failed";

        if ($secure === 'tls') {
            $r = $cmd('STARTTLS', [220]);
            if ($r === false) return 'STARTTLS rejected';
            if (!stream_socket_enable_crypto($sock, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
                return 'TLS handshake failed';
            }
            $r = $cmd('EHLO ' . $ehloHost, [250]);
            if ($r === false) return 'EHLO after TLS failed';
        }

        if ($user !== '') {
            $r = $cmd('AUTH LOGIN', [334]);
            if ($r === false) return 'AUTH LOGIN rejected';
            $r = $cmd(base64_encode($user), [334]);
            if ($r === false) return 'AUTH user rejected';
            $r = $cmd(base64_encode($pass), [235]);
            if ($r === false) return 'AUTH failed (проверьте SMTP_USER/SMTP_PASS)';
        }

        $r = $cmd('MAIL FROM:<' . $from . '>', [250]);
        if ($r === false) return 'MAIL FROM rejected';
        $r = $cmd('RCPT TO:<' . $to . '>', [250, 251]);
        if ($r === false) return "RCPT TO <$to> rejected";

        [$msg] = smtpBuildMessage($from, $fromName, $to, $subject, $html);
        $msg = preg_replace('/^\./m', '..', $msg) ?? $msg; // dot-stuffing
        $r = $cmd('DATA', [354]);
        if ($r === false) return 'DATA rejected';
        $r = $cmd($msg . "\r\n.", [250]);
        if ($r === false) return 'message rejected';

        $cmd('QUIT', [221]);
    } finally {
        fclose($sock);
    }
    return true;
}
