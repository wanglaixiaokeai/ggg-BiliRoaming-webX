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

function pp_fetch_text(string $url, array $headers = [], int $timeout = 30): string|false {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_ENCODING => '',
        CURLOPT_HTTPHEADER => $headers ?: pp_api_headers(),
    ]);
    $body = curl_exec($ch);
    curl_close($ch);
    return $body;
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
        $params['fnval'] = $params['fnval'] ?? '4048';
        $params['fourk'] = $params['fourk'] ?? '1';
    }

    return http_build_query($params);
}

function pp_base64url_encode(string $value): string {
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}

function pp_base64url_decode(string $value): string|false {
    $padded = strtr($value, '-_', '+/');
    $padded .= str_repeat('=', (4 - strlen($padded) % 4) % 4);
    return base64_decode($padded, true);
}

function pp_encode_mpd_payload(array $payload): string {
    $json = json_encode($payload, JSON_UNESCAPED_SLASHES);
    if (function_exists('gzdeflate')) {
        return 'z' . pp_base64url_encode(gzdeflate($json, 9));
    }
    return 'j' . pp_base64url_encode($json);
}

function pp_decode_mpd_payload(string $src): ?array {
    if ($src === '') {
        return null;
    }
    $mode = $src[0];
    $raw = pp_base64url_decode(substr($src, 1));
    if ($raw === false) {
        return null;
    }
    if ($mode === 'z') {
        if (!function_exists('gzinflate')) {
            return null;
        }
        $raw = gzinflate($raw);
        if ($raw === false) {
            return null;
        }
    }
    $payload = json_decode($raw, true);
    return is_array($payload) ? $payload : null;
}

function pp_cookie_value(string $name): string {
    $cookie = $_SERVER['HTTP_COOKIE'] ?? '';
    if (preg_match('/(?:^|;\s*)' . preg_quote($name, '/') . '=([^;]*)/', $cookie, $m)) {
        return $m[1];
    }
    return '';
}

function pp_build_url(array $parts, array $query): string {
    $scheme = $parts['scheme'] ?? 'https';
    $host = $parts['host'] ?? '';
    $port = isset($parts['port']) ? ':' . $parts['port'] : '';
    $path = $parts['path'] ?? '';
    $fragment = isset($parts['fragment']) ? '#' . $parts['fragment'] : '';
    $qs = http_build_query($query);
    return $scheme . '://' . $host . $port . $path . ($qs ? '?' . $qs : '') . $fragment;
}

function pp_patch_media_url(string $url): string {
    $parts = parse_url($url);
    if (!$parts || empty($parts['host'])) {
        return $url;
    }
    $host = strtolower($parts['host']);
    if (!str_contains($host, 'bilivideo.') && !str_ends_with($host, 'hdslb.com')) {
        return $url;
    }

    $query = [];
    parse_str($parts['query'] ?? '', $query);
    $buvid3 = pp_cookie_value('buvid3');
    if ($buvid3 !== '' && empty($query['buvid'])) {
        $query['buvid'] = $buvid3;
    }
    if (($query['platform'] ?? '') === 'android') {
        $query['platform'] = 'pc';
    }
    if (($query['build'] ?? '') === '6800300' && ($query['platform'] ?? '') === 'pc') {
        $query['build'] = '0';
    }
    foreach (['mobi_app', 'device', 'otype', 'module'] as $key) {
        unset($query[$key]);
    }

    return pp_build_url($parts, $query);
}

function pp_rewrite_media_urls(string $body): string {
    $base = pp_public_base();
    $domains = 'bilivideo\.com|bilivideo\.cn|hdslb\.com';
    $pattern = '/(https?:\/\/[^\"\s\\\\]*(' . $domains . ')[^\"\s\\\\]*)/i';

    return preg_replace_callback($pattern, function ($m) use ($base) {
        return $base . '/media?url=' . urlencode($m[1]);
    }, $body);
}

function pp_allowed_subtitle_url(string $url): bool {
    $parts = parse_url($url);
    if (!$parts || !in_array(strtolower($parts['scheme'] ?? ''), ['http', 'https'], true)) {
        return false;
    }
    $host = strtolower($parts['host'] ?? '');
    $domains = ['bilibili.com', 'bilibili.tv', 'bilivideo.com', 'bilivideo.cn', 'hdslb.com'];
    foreach ($domains as $domain) {
        if ($host === $domain || str_ends_with($host, '.' . $domain)) {
            return true;
        }
    }
    return false;
}

function pp_ass_time(float $seconds): string {
    $seconds = max(0, $seconds);
    $cs = (int) round(($seconds - floor($seconds)) * 100);
    $total = (int) floor($seconds);
    $s = $total % 60;
    $m = (int) floor($total / 60) % 60;
    $h = (int) floor($total / 3600);
    return sprintf('%d:%02d:%02d.%02d', $h, $m, $s, min(99, $cs));
}

function pp_srt_time(float $seconds): string {
    $seconds = max(0, $seconds);
    $ms = (int) round(($seconds - floor($seconds)) * 1000);
    $total = (int) floor($seconds);
    $s = $total % 60;
    $m = (int) floor($total / 60) % 60;
    $h = (int) floor($total / 3600);
    return sprintf('%02d:%02d:%02d,%03d', $h, $m, $s, min(999, $ms));
}

function pp_ass_escape(string $text): string {
    $text = html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $text = str_replace(["\r\n", "\r", "\n"], '\\N', $text);
    return str_replace(['{', '}'], ['(', ')'], $text);
}

function pp_ass_color(int $rgb): string {
    $r = ($rgb >> 16) & 0xff;
    $g = ($rgb >> 8) & 0xff;
    $b = $rgb & 0xff;
    return sprintf('&H%02X%02X%02X&', $b, $g, $r);
}

function pp_ass_alpha(float $opacity): string {
    $opacity = max(0.0, min(1.0, $opacity));
    return sprintf('&H%02X&', (int) round((1.0 - $opacity) * 255));
}

function pp_ass_header(string $font, int $fontSize, float $opacity): string {
    $alpha = pp_ass_alpha($opacity);
    return "[Script Info]\n" .
        "ScriptType: v4.00+\n" .
        "WrapStyle: 2\n" .
        "ScaledBorderAndShadow: yes\n" .
        "PlayResX: 1920\n" .
        "PlayResY: 1080\n\n" .
        "[V4+ Styles]\n" .
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" .
        "Style: Default," . $font . "," . $fontSize . ",&H00FFFFFF,&H00FFFFFF,&H00000000," . $alpha . "000000,-1,0,0,0,100,100,0,0,1,1.4,0,2,20,20,20,1\n\n" .
        "[Events]\n" .
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
}

function pp_parse_danmaku_xml(string $xml): array {
    $items = [];
    if (preg_match_all('/<d\s+p="([^"]*)"[^>]*>(.*?)<\/d>/s', $xml, $matches, PREG_SET_ORDER)) {
        foreach ($matches as $match) {
            $parts = explode(',', $match[1]);
            if (count($parts) < 4) {
                continue;
            }
            $items[] = [
                'time' => (float) $parts[0],
                'mode' => (int) $parts[1],
                'size' => (int) $parts[2],
                'color' => (int) $parts[3],
                'text' => pp_ass_escape($match[2]),
            ];
        }
    }
    usort($items, fn($a, $b) => $a['time'] <=> $b['time']);
    return $items;
}

function pp_row_slot(array &$rows, int $maxRows, float $start, float $duration): array {
    $maxRows = max(1, $maxRows);
    while (count($rows) < $maxRows) {
        $rows[] = 0.0;
    }

    $gap = 0.18;
    $bestRow = 0;
    $bestFreeAt = $rows[0];
    foreach ($rows as $i => $freeAt) {
        if ($freeAt <= $start) {
            $rows[$i] = $start + $duration + $gap;
            return [$i, $start];
        }
        if ($freeAt < $bestFreeAt) {
            $bestRow = $i;
            $bestFreeAt = $freeAt;
        }
    }

    $delayedStart = $bestFreeAt;
    $rows[$bestRow] = $delayedStart + $duration + $gap;
    return [$bestRow, $delayedStart];
}

function pp_danmaku_to_ass(array $items): string {
    $font = (string) ($_GET['font'] ?? 'Microsoft YaHei');
    $fontSize = max(12, min(80, (int) round((float) ($_GET['font_size'] ?? 30))));
    $opacity = (float) ($_GET['alpha'] ?? 0.8);
    $displayArea = max(0.2, min(1.0, (float) ($_GET['display_area'] ?? 0.8)));
    $marqueeDuration = max(3.0, min(30.0, (float) ($_GET['duration_marquee'] ?? 15.0)));
    $stillDuration = max(2.0, min(6.0, (float) ($_GET['duration_still'] ?? 5.0)));
    $enableScroll = ($_GET['scroll'] ?? '0') === '1';
    $lineHeight = $fontSize + 8;
    $maxRows = max(1, (int) floor((1080 * $displayArea) / $lineHeight));
    $scrollRows = [];
    $danmakuRows = [];
    $ass = pp_ass_header($font, $fontSize, $opacity);

    foreach ($items as $item) {
        $start = (float) $item['time'];
        $mode = (int) $item['mode'];
        $size = max(12, min(80, (int) $item['size']));
        $color = pp_ass_color((int) $item['color']);
        $text = $item['text'];
        $duration = ($mode === 4 || $mode === 5 || !$enableScroll) ? $stillDuration : $marqueeDuration;
        $displayStart = $start;

        if ($mode === 5 || $mode === 4) {
            [$row, $displayStart] = pp_row_slot($danmakuRows, $maxRows, $start, $duration);
            $y = 20 + $row * $lineHeight;
            $tag = sprintf('{\\an8\\pos(960,%d)\\fs%d\\c%s}', $y, $size, $color);
        } elseif ($enableScroll) {
            [$row, $displayStart] = pp_row_slot($scrollRows, $maxRows, $start, $duration);
            $y = 20 + $row * $lineHeight;
            $tag = sprintf('{\\move(1920,%d,-720,%d)\\fs%d\\c%s}', $y, $y, $size, $color);
        } else {
            [$row, $displayStart] = pp_row_slot($danmakuRows, $maxRows, $start, $duration);
            $y = 20 + $row * $lineHeight;
            $tag = sprintf('{\\an8\\pos(960,%d)\\fs%d\\c%s}', $y, $size, $color);
        }
        $end = $displayStart + $duration;

        $ass .= 'Dialogue: 0,' . pp_ass_time($displayStart) . ',' . pp_ass_time($end) . ',Default,,0,0,0,,' . $tag . $text . "\n";
    }
    return $ass;
}

function pp_serve_danmaku(): void {
    $cid = preg_replace('/\D+/', '', (string) ($_GET['cid'] ?? ''));
    if ($cid === '') {
        pp_json(400, ['code' => -1, 'message' => 'missing cid']);
        return;
    }

    $xml = pp_fetch_text('https://comment.bilibili.com/' . $cid . '.xml', [
        'User-Agent: ' . PP_BILI_UA,
        'Referer: https://www.bilibili.com/',
        'Accept: application/xml,text/xml,*/*',
    ]);
    if ($xml === false || $xml === '') {
        pp_json(502, ['code' => -1, 'message' => 'danmaku request failed']);
        return;
    }

    header('Content-Type: text/plain; charset=utf-8');
    header('Content-Disposition: inline; filename="danmaku.ass"');
    echo pp_danmaku_to_ass(pp_parse_danmaku_xml($xml));
}

function pp_serve_subtitle_url(): void {
    $url = (string) ($_GET['url'] ?? '');
    if (!$url || !pp_allowed_subtitle_url($url)) {
        pp_json(400, ['code' => -1, 'message' => 'invalid subtitle url']);
        return;
    }

    $body = pp_fetch_text($url, [
        'User-Agent: ' . PP_BILI_UA,
        'Referer: https://www.bilibili.com/',
        'Accept: application/json,text/plain,*/*',
    ]);
    if ($body === false || $body === '') {
        pp_json(502, ['code' => -1, 'message' => 'subtitle request failed']);
        return;
    }

    $json = json_decode($body, true);
    $items = is_array($json) ? ($json['body'] ?? []) : [];
    if (!is_array($items)) {
        header('Content-Type: text/plain; charset=utf-8');
        echo $body;
        return;
    }

    $srt = '';
    $index = 1;
    foreach ($items as $item) {
        if (!is_array($item) || !isset($item['from'], $item['to'], $item['content'])) {
            continue;
        }
        $srt .= $index++ . "\n";
        $srt .= pp_srt_time((float) $item['from']) . ' --> ' . pp_srt_time((float) $item['to']) . "\n";
        $srt .= trim((string) $item['content']) . "\n\n";
    }
    header('Content-Type: text/plain; charset=utf-8');
    header('Content-Disposition: inline; filename="subtitle.srt"');
    echo $srt;
}

function pp_serve_subtitle(): void {
    if (!empty($_GET['url'])) {
        pp_serve_subtitle_url();
        return;
    }
    pp_serve_danmaku();
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
    if (pp_is_playurl($path)) {
        $transformed = pp_transform_playurl_for_potplayer($body, $path);
        if ($transformed !== null) {
            header('Content-Type: application/json; charset=utf-8');
            echo $transformed;
            return;
        }
    }
    echo pp_rewrite_media_urls($body);
}

function pp_dash_data(array $root, string $path): ?array {
    $data = str_starts_with($path, '/pgc/') ? ($root['result'] ?? null) : ($root['data'] ?? null);
    if (!is_array($data)) {
        return null;
    }
    $dash = $data['dash'] ?? ($data['video_info']['dash'] ?? null);
    return is_array($dash) ? $data : null;
}

function pp_codec_name(array $stream): string {
    $codecid = (int) ($stream['codecid'] ?? 0);
    if ($codecid === 12) return 'hevc';
    if ($codecid === 13) return 'av1';
    if ($codecid === 7) return 'avc';
    $codecs = strtolower((string) ($stream['codecs'] ?? ''));
    if (str_contains($codecs, 'hev') || str_contains($codecs, 'hvc')) return 'hevc';
    if (str_contains($codecs, 'av01')) return 'av1';
    if (str_contains($codecs, 'avc')) return 'avc';
    return 'unknown';
}

function pp_stream_url(array $stream): string {
    return (string) ($stream['baseUrl'] ?? $stream['base_url'] ?? ($stream['backupUrl'][0] ?? ($stream['backup_url'][0] ?? '')));
}

function pp_sort_streams(array $streams): array {
    usort($streams, function ($a, $b) {
        $aq = (int) ($a['id'] ?? 0);
        $bq = (int) ($b['id'] ?? 0);
        if ($aq !== $bq) return $bq <=> $aq;
        return ((int) ($b['bandwidth'] ?? 0)) <=> ((int) ($a['bandwidth'] ?? 0));
    });
    return $streams;
}

function pp_select_video(array $dash, int $targetQn, string $preferredCodec = 'hevc'): ?array {
    $videos = array_values(array_filter($dash['video'] ?? [], 'is_array'));
    if (!$videos) {
        return null;
    }
    $videos = pp_sort_streams($videos);
    $candidates = array_values(array_filter($videos, fn($v) => (int) ($v['id'] ?? 0) === $targetQn));
    if (!$candidates) {
        $candidates = array_values(array_filter($videos, fn($v) => (int) ($v['id'] ?? 0) <= $targetQn));
    }
    if (!$candidates) {
        $candidates = $videos;
    }
    $codecCandidates = array_values(array_filter($candidates, fn($v) => pp_codec_name($v) === $preferredCodec));
    if (!$codecCandidates && $preferredCodec !== 'auto') {
        $codecCandidates = array_values(array_filter($videos, fn($v) => pp_codec_name($v) === $preferredCodec));
    }
    $selected = $codecCandidates[0] ?? $candidates[0] ?? $videos[0];
    return is_array($selected) ? $selected : null;
}

function pp_sdr_quality_cap(int $targetQn): int {
    if (($_GET['allow_hdr'] ?? '') === '1') {
        return $targetQn;
    }
    // Avoid Dolby Vision/HDR/4K by default. PotPlayer often renders Bilibili HDR
    // streams as a gray SDR image, especially after switching fullscreen modes.
    return min($targetQn, 112);
}

function pp_select_audio(array $dash): ?array {
    $audios = array_values(array_filter($dash['audio'] ?? [], 'is_array'));
    if (!$audios && isset($dash['dolby']['audio']) && is_array($dash['dolby']['audio'])) {
        $audios = array_values(array_filter($dash['dolby']['audio'], 'is_array'));
    }
    if (!$audios && isset($dash['flac']['audio']) && is_array($dash['flac']['audio'])) {
        $audios = [array_filter($dash['flac']['audio'])];
    }
    if (!$audios) {
        return null;
    }
    usort($audios, fn($a, $b) => ((int) ($b['bandwidth'] ?? 0)) <=> ((int) ($a['bandwidth'] ?? 0)));
    return $audios[0];
}

function pp_accept_quality(array $dash): array {
    $values = [];
    foreach (($dash['video'] ?? []) as $video) {
        if (is_array($video) && isset($video['id'])) {
            $values[(string) $video['id']] = (int) $video['id'];
        }
    }
    rsort($values, SORT_NUMERIC);
    return array_values($values);
}

function pp_make_mpd_url(array $data, array $video, ?array $audio): string {
    $dash = $data['dash'] ?? ($data['video_info']['dash'] ?? []);
    $payload = [
        'duration' => (int) ($dash['duration'] ?? round(((int) ($data['timelength'] ?? 0)) / 1000)),
        'video' => $video,
        'audio' => $audio,
    ];
    return pp_public_base() . '/mpd?src=' . pp_encode_mpd_payload($payload);
}

function pp_transform_playurl_for_potplayer(string $body, string $path): ?string {
    $root = json_decode($body, true);
    if (!is_array($root) || (int) ($root['code'] ?? -1) !== 0) {
        return null;
    }
    $data = pp_dash_data($root, $path);
    if (!$data) {
        return null;
    }

    $dash = $data['dash'] ?? ($data['video_info']['dash'] ?? null);
    if (!is_array($dash)) {
        return null;
    }

    $targetQn = pp_sdr_quality_cap((int) ($_GET['qn'] ?? 127));
    $preferredCodec = strtolower((string) ($_GET['codec'] ?? 'hevc'));
    $video = pp_select_video($dash, $targetQn, $preferredCodec);
    if (!$video) {
        return null;
    }
    $audio = pp_select_audio($dash);
    $mpdUrl = pp_make_mpd_url($data, $video, $audio);
    $quality = (int) ($video['id'] ?? $targetQn);
    $codecid = (int) ($video['codecid'] ?? (pp_codec_name($video) === 'hevc' ? 12 : 7));

    $data['dash'] = null;
    unset($data['dash'], $data['video_info']['dash']);
    $data['quality'] = $quality;
    $data['video_codecid'] = $codecid;
    $data['accept_quality'] = pp_accept_quality($dash);
    $data['accept_format'] = 'mpd';
    $data['format'] = 'mpd';
    $data['fnval'] = 4048;
    $data['type'] = 'DASH';
    $data['durl'] = [[
        'url' => $mpdUrl,
        'backup_url' => [],
        'length' => (int) ($data['timelength'] ?? (($dash['duration'] ?? 0) * 1000)),
        'size' => 0,
        'ahead' => '',
        'vhead' => '',
    ]];

    if (str_starts_with($path, '/pgc/')) {
        $root['result'] = $data;
    } else {
        $root['data'] = $data;
    }
    return json_encode($root, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
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

function pp_is_bilivideo_url(string $url): bool {
    $host = strtolower(parse_url($url, PHP_URL_HOST) ?? '');
    return str_contains($host, 'bilivideo.');
}

function pp_limited_range_header(string $url): string {
    $range = $_SERVER['HTTP_RANGE'] ?? '';
    if (!pp_is_bilivideo_url($url)) {
        return $range;
    }

    $chunkSize = 8 * 1024 * 1024;
    if ($range === '') {
        return 'bytes=0-' . ($chunkSize - 1);
    }

    if (!preg_match('/^bytes=(\d+)-(\d*)$/', $range, $m)) {
        return $range;
    }

    $start = (int) $m[1];
    $requestedEnd = $m[2] === '' ? null : (int) $m[2];
    $chunkEnd = $start + $chunkSize - 1;
    $end = $requestedEnd === null ? $chunkEnd : min($requestedEnd, $chunkEnd);
    return 'bytes=' . $start . '-' . $end;
}

function pp_media_headers(string $url): array {
    $headers = [
        'User-Agent: ' . PP_BILI_UA,
        'Referer: https://www.bilibili.com/',
        'Origin: https://www.bilibili.com',
        'Accept: */*',
    ];
    $range = pp_limited_range_header($url);
    if ($range !== '') {
        $headers[] = 'Range: ' . $range;
    }
    if (!empty($_SERVER['HTTP_COOKIE'])) {
        $headers[] = 'Cookie: ' . $_SERVER['HTTP_COOKIE'];
    }
    return $headers;
}

function pp_xml_escape(mixed $value): string {
    return htmlspecialchars((string) ($value ?? ''), ENT_QUOTES | ENT_XML1, 'UTF-8');
}

function pp_range_text(mixed $range): string {
    if (is_array($range)) {
        return implode('-', $range);
    }
    $range = (string) ($range ?? '');
    return $range !== '' ? $range : '0-0';
}

function pp_segment_base_value(array $stream, string $key): string {
    if ($key === 'initialization') {
        return pp_range_text($stream['segment_base']['initialization'] ?? ($stream['SegmentBase']['Initialization']['range'] ?? ($stream['initialization'] ?? '0-0')));
    }
    return pp_range_text($stream['segment_base']['index_range'] ?? ($stream['SegmentBase']['indexRange'] ?? ($stream['indexRange'] ?? '0-0')));
}

function pp_media_proxy_url(string $url): string {
    return pp_public_base() . '/media?url=' . urlencode(pp_patch_media_url($url));
}

function pp_build_mpd_xml(array $payload): string {
    $video = is_array($payload['video'] ?? null) ? $payload['video'] : null;
    $audio = is_array($payload['audio'] ?? null) ? $payload['audio'] : null;
    if (!$video) {
        return '';
    }

    $duration = max(0, (int) ($payload['duration'] ?? 0));
    $mediaDuration = $duration > 0 ? 'PT' . $duration . 'S' : 'PT0S';
    $videoUrl = pp_stream_url($video);
    $videoInit = pp_segment_base_value($video, 'initialization');
    $videoIndex = pp_segment_base_value($video, 'index_range');

    $xml = '<?xml version="1.0" encoding="UTF-8"?>';
    $xml .= '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="' . $mediaDuration . '" minBufferTime="PT1.5S">';
    $xml .= '<Period duration="' . $mediaDuration . '">';
    $xml .= '<AdaptationSet id="video" contentType="video" mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">';
    $xml .= '<Representation id="v-' . pp_xml_escape($video['id'] ?? '0') . '" bandwidth="' . pp_xml_escape($video['bandwidth'] ?? 1) . '" codecs="' . pp_xml_escape($video['codecs'] ?? '') . '" width="' . pp_xml_escape($video['width'] ?? 0) . '" height="' . pp_xml_escape($video['height'] ?? 0) . '" frameRate="' . pp_xml_escape($video['frame_rate'] ?? ($video['frameRate'] ?? '')) . '">';
    $xml .= '<BaseURL>' . pp_xml_escape(pp_media_proxy_url($videoUrl)) . '</BaseURL>';
    $xml .= '<SegmentBase indexRange="' . pp_xml_escape($videoIndex) . '"><Initialization range="' . pp_xml_escape($videoInit) . '"/></SegmentBase>';
    $xml .= '</Representation></AdaptationSet>';

    if ($audio && pp_stream_url($audio) !== '') {
        $audioUrl = pp_stream_url($audio);
        $audioInit = pp_segment_base_value($audio, 'initialization');
        $audioIndex = pp_segment_base_value($audio, 'index_range');
        $xml .= '<AdaptationSet id="audio" contentType="audio" mimeType="audio/mp4" segmentAlignment="true" startWithSAP="1">';
        $xml .= '<Representation id="a-' . pp_xml_escape($audio['id'] ?? '0') . '" bandwidth="' . pp_xml_escape($audio['bandwidth'] ?? 1) . '" codecs="' . pp_xml_escape($audio['codecs'] ?? 'mp4a.40.2') . '" audioSamplingRate="' . pp_xml_escape($audio['audioSamplingRate'] ?? 48000) . '">';
        $xml .= '<AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>';
        $xml .= '<BaseURL>' . pp_xml_escape(pp_media_proxy_url($audioUrl)) . '</BaseURL>';
        $xml .= '<SegmentBase indexRange="' . pp_xml_escape($audioIndex) . '"><Initialization range="' . pp_xml_escape($audioInit) . '"/></SegmentBase>';
        $xml .= '</Representation></AdaptationSet>';
    }

    $xml .= '</Period></MPD>';
    return $xml;
}

function pp_serve_mpd(): void {
    $payload = pp_decode_mpd_payload((string) ($_GET['src'] ?? ''));
    if (!$payload) {
        pp_json(400, ['code' => -1, 'message' => 'invalid mpd payload']);
        return;
    }
    $xml = pp_build_mpd_xml($payload);
    if ($xml === '') {
        pp_json(400, ['code' => -1, 'message' => 'empty mpd']);
        return;
    }
    header('Content-Type: application/dash+xml; charset=utf-8');
    header('Content-Disposition: inline');
    echo $xml;
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
        CURLOPT_HTTPHEADER => pp_media_headers($url),
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
if ($path === '/subtitle') {
    pp_serve_subtitle();
    exit;
}
if ($path === '/mpd') {
    pp_serve_mpd();
    exit;
}
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
