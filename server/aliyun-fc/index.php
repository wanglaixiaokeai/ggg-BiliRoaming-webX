<?php

const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

function send_cors(): void {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET,POST,OPTIONS,HEAD');
    header('Access-Control-Allow-Headers: Content-Type,Accept,Origin,Referer,User-Agent,Range,x-from-biliroaming,platform-from-biliroaming');
    header('Access-Control-Expose-Headers: Content-Length,Content-Range,Accept-Ranges,Content-Type');
    header('Access-Control-Max-Age: 86400');
}

function request_path(): string {
    $uri = $_SERVER['REQUEST_URI'] ?? '/';
    $path = parse_url($uri, PHP_URL_PATH);
    return $path ?: '/';
}

function query_without_url(): string {
    $query = $_SERVER['QUERY_STRING'] ?? '';
    parse_str($query, $params);
    unset($params['url']);
    return http_build_query($params);
}

function respond_json(int $code, array $body): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

function proxy_api(string $upstream): void {
    $query = query_without_url();
    $url = $upstream . ($query ? '?' . $query : '');
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_ENCODING => '',
        CURLOPT_HTTPHEADER => [
            'User-Agent: ' . BILI_UA,
            'Referer: https://www.bilibili.com/',
            'Origin: https://www.bilibili.com',
            'Accept: application/json,text/plain,*/*',
        ],
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE) ?: 502;
    $type = curl_getinfo($ch, CURLINFO_CONTENT_TYPE) ?: 'application/json';
    $err = curl_error($ch);
    curl_close($ch);

    if ($body === false) {
        respond_json(502, ['code' => -1, 'message' => $err ?: 'upstream request failed']);
        return;
    }
    http_response_code($status);
    header('Content-Type: ' . $type);
    echo $body;
}

function allowed_media_url(string $url): bool {
    $parts = parse_url($url);
    if (!$parts || !in_array(strtolower($parts['scheme'] ?? ''), ['http', 'https'], true)) return false;
    $host = strtolower($parts['host'] ?? '');
    return preg_match('/(^|\.)bilivideo\.(com|cn)$/i', $host) || preg_match('/(^|\.)hdslb\.com$/i', $host);
}

function proxy_media(): void {
    $url = $_GET['url'] ?? '';
    if (!$url || !allowed_media_url($url)) {
        respond_json(400, ['code' => 400, 'message' => 'unsupported media url']);
        return;
    }

    $headers = [
        'User-Agent: ' . BILI_UA,
        'Referer: https://www.bilibili.com/',
        'Origin: https://www.bilibili.com',
        'Accept: */*',
    ];
    if (!empty($_SERVER['HTTP_RANGE'])) {
        $headers[] = 'Range: ' . $_SERVER['HTTP_RANGE'];
    }

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 0,
        CURLOPT_BUFFERSIZE => 1024 * 128,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_HEADERFUNCTION => function ($ch, string $line): int {
            $trimmed = trim($line);
            if ($trimmed === '') return strlen($line);
            if (preg_match('/^HTTP\/\S+\s+(\d+)/i', $trimmed, $m)) {
                http_response_code((int)$m[1]);
                return strlen($line);
            }
            $name = strtolower(strtok($trimmed, ':'));
            $forward = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
            if (in_array($name, $forward, true)) {
                header($trimmed, true);
            }
            return strlen($line);
        },
        CURLOPT_WRITEFUNCTION => function ($ch, string $chunk): int {
            echo $chunk;
            flush();
            return strlen($chunk);
        },
    ]);
    $ok = curl_exec($ch);
    if ($ok === false && !headers_sent()) {
        respond_json(502, ['code' => 502, 'message' => curl_error($ch) ?: 'media proxy failed']);
    }
    curl_close($ch);
}

send_cors();
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$path = request_path();
$routes = [
    '/pgc/player/web/playurl' => 'https://api.bilibili.com/pgc/player/web/playurl',
    '/pgc/player/api/playurl' => 'https://api.bilibili.com/pgc/player/api/playurl',
    '/pgc/view/web/season' => 'https://api.bilibili.com/pgc/view/web/season',
    '/pgc/view/web/ep/list' => 'https://api.bilibili.com/pgc/view/web/ep/list',
    '/x/web-interface/search/type' => 'https://api.bilibili.com/x/web-interface/search/type',
    '/x/v2/subtitle/web/view' => 'https://api.bilibili.com/x/v2/subtitle/web/view',
];

if ($path === '/media') {
    proxy_media();
    exit;
}

if (isset($routes[$path])) {
    proxy_api($routes[$path]);
    exit;
}

respond_json(404, ['code' => 404, 'message' => 'unsupported path', 'path' => $path]);

