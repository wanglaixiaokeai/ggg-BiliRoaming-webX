<?php

const PP_BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

@set_time_limit(0);

function pp_send_headers(): void {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET,POST,OPTIONS,HEAD');
    header('Access-Control-Allow-Headers: Content-Type,Accept,Origin,Referer,User-Agent,Range,Cookie');
    header('Access-Control-Expose-Headers: Content-Length,Content-Range,Accept-Ranges,Content-Type');
    header('Access-Control-Max-Age: 86400');
    header('Content-Disposition: inline');
}

function pp_request_path(): string {
    $uri = $_SERVER['REQUEST_URI'] ?? '/';
    $path = parse_url($uri, PHP_URL_PATH) ?: '/';
    $prefix = '/potplayer.php';
    if ($path === $prefix) {
        return '/';
    }
    if (str_starts_with($path, $prefix . '/')) {
        return substr($path, strlen($prefix)) ?: '/';
    }
    return $path;
}

function pp_public_base(): string {
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
    $prefix = str_starts_with($path, '/potplayer.php') ? '/potplayer.php' : '';
    return 'https://' . $host . $prefix;
}

function pp_json(int $status, array $body): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

function pp_is_playurl(string $path): bool {
    return in_array($path, [
        '/pgc/player/web/playurl',
        '/pgc/player/api/playurl',
        '/x/player/playurl',
    ], true);
}

function pp_query_string(string $path): string {
    $params = $_GET;
    unset($params['url']);

    if (pp_is_playurl($path)) {
        $params['fnval'] = '0';
        unset($params['fourk']);
    }

    return http_build_query($params);
}

function pp_rewrite_media_urls(string $body): string {
    $base = pp_public_base();
    $domains = 'bilivideo\.com|bilivideo\.cn|hdslb\.com';
    $pattern = '/(https?:\/\/[^\"\s\\\\]*(' . $domains . ')[^\"\s\\\\]*)/i';

    return preg_replace_callback($pattern, function ($m) use ($base) {
        return $base . '/media?url=' . urlencode($m[1]);
    }, $body);
}

function pp_api_headers(): array {
    $headers = [
        'User-Agent: ' . PP_BILI_UA,
        'Referer: https://www.bilibili.com/',
        'Origin: https://www.bilibili.com',
        'Accept: application/json,text/plain,*/*',
    ];
    if (!empty($_SERVER['HTTP_COOKIE'])) {
        $headers[] = 'Cookie: ' . $_SERVER['HTTP_COOKIE'];
    }
    return $headers;
}

function pp_proxy_api(string $path, string $upstream): void {
    $query = pp_query_string($path);
    $url = $upstream . ($query ? '?' . $query : '');
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 35,
        CURLOPT_ENCODING => '',
        CURLOPT_HTTPHEADER => pp_api_headers(),
    ]);

    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE) ?: 502;
    $type = curl_getinfo($ch, CURLINFO_CONTENT_TYPE) ?: 'application/json';
    $err = curl_error($ch);
    curl_close($ch);

    if ($body === false) {
        pp_json(502, ['code' => -1, 'message' => $err ?: 'upstream request failed']);
        return;
    }

    http_response_code($status);
    header('Content-Type: ' . $type);
    echo pp_rewrite_media_urls($body);
}

function pp_allowed_media_url(string $url): bool {
    $parts = parse_url($url);
    if (!$parts || !in_array(strtolower($parts['scheme'] ?? ''), ['http', 'https'], true)) {
        return false;
    }

    $host = strtolower($parts['host'] ?? '');
    $domains = ['bilivideo.com', 'bilivideo.cn', 'hdslb.com', 'upos-sz-mirrorcos.bilivideo.com'];
    foreach ($domains as $domain) {
        if ($host === $domain || str_ends_with($host, '.' . $domain)) {
            return true;
        }
    }
    return false;
}

function pp_media_headers(): array {
    $headers = [
        'User-Agent: ' . PP_BILI_UA,
        'Referer: https://www.bilibili.com/',
        'Origin: https://www.bilibili.com',
        'Accept: */*',
    ];
    if (!empty($_SERVER['HTTP_RANGE'])) {
        $headers[] = 'Range: ' . $_SERVER['HTTP_RANGE'];
    }
    if (!empty($_SERVER['HTTP_COOKIE'])) {
        $headers[] = 'Cookie: ' . $_SERVER['HTTP_COOKIE'];
    }
    return $headers;
}

function pp_proxy_media(): void {
    $url = $_GET['url'] ?? '';
    if (!$url || !pp_allowed_media_url($url)) {
        pp_json(400, ['code' => -1, 'message' => 'invalid media url']);
        return;
    }

    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => false,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 0,
        CURLOPT_ENCODING => '',
        CURLOPT_BUFFERSIZE => 1024 * 256,
        CURLOPT_HTTPHEADER => pp_media_headers(),
        CURLOPT_NOBODY => $method === 'HEAD',
        CURLOPT_HEADERFUNCTION => function ($ch, $line) {
            $trimmed = trim($line);
            if ($trimmed === '') {
                return strlen($line);
            }
            if (preg_match('/^HTTP\/\S+\s+(\d+)/i', $trimmed, $m)) {
                http_response_code((int) $m[1]);
                return strlen($line);
            }

            $parts = explode(':', $line, 2);
            if (count($parts) !== 2) {
                return strlen($line);
            }

            $name = trim($parts[0]);
            $value = trim($parts[1]);
            $allowed = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
            if (in_array(strtolower($name), $allowed, true) && !headers_sent()) {
                header($name . ': ' . $value);
            }
            return strlen($line);
        },
    ]);

    header('Content-Type: application/octet-stream');
    header('Accept-Ranges: bytes');

    curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) use ($method) {
        if ($method !== 'HEAD') {
            echo $chunk;
            flush();
        }
        return strlen($chunk);
    });

    $ok = curl_exec($ch);
    if ($ok === false && !headers_sent()) {
        pp_json(502, ['code' => 502, 'message' => curl_error($ch) ?: 'media proxy failed']);
    }
    curl_close($ch);
}

pp_send_headers();
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$path = pp_request_path();
if ($path === '/media') {
    pp_proxy_media();
    exit;
}

$routes = [
    '/pgc/player/web/playurl' => 'https://api.bilibili.com/pgc/player/web/playurl',
    '/pgc/player/api/playurl' => 'https://api.bilibili.com/pgc/player/api/playurl',
    '/pgc/view/web/season' => 'https://api.bilibili.com/pgc/view/web/season',
    '/pgc/view/web/ep/list' => 'https://api.bilibili.com/pgc/view/web/ep/list',
    '/pgc/season/index/result' => 'https://api.bilibili.com/pgc/season/index/result',
    '/x/player/playurl' => 'https://api.bilibili.com/x/player/playurl',
    '/x/player/wbi/v2' => 'https://api.bilibili.com/x/player/wbi/v2',
    '/x/web-interface/nav' => 'https://api.bilibili.com/x/web-interface/nav',
    '/x/web-interface/view' => 'https://api.bilibili.com/x/web-interface/view',
    '/x/web-interface/archive/related' => 'https://api.bilibili.com/x/web-interface/archive/related',
    '/x/v2/subtitle/web/view' => 'https://api.bilibili.com/x/v2/subtitle/web/view',
];

if (isset($routes[$path])) {
    pp_proxy_api($path, $routes[$path]);
    exit;
}

pp_proxy_api($path, 'https://api.bilibili.com' . $path);
