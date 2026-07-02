# Aliyun Function Compute PHP Proxy

This directory contains a minimal PHP HTTP server entry for Aliyun Function Compute custom runtime.

## Runtime

- Runtime: PHP 8.1 custom runtime
- Listen port: `9000`
- Startup command:

```bash
php -S 0.0.0.0:9000 index.php
```

## Routes

Browser extension routes, handled by `index.php`:

- `/pgc/player/web/playurl`
- `/pgc/player/api/playurl`
- `/pgc/view/web/season`
- `/pgc/view/web/ep/list`
- `/pgc/season/index/result`
- `/x/v2/subtitle/web/view`
- `/media?url=...`

The `/media` route proxies Bilibili media URLs with Range support, which is required when the browser cannot directly access `bilivideo.com` media hosts.

## Extension Setup

Set the extension server URL to your own Function Compute public URL, for example:

```text
https://your-function-region.fcapp.run
```

## PotPlayer fallback

`potplayer.php` is a simple fallback entry for the Chen310 PotPlayer plugin. It keeps the browser route untouched, forces PotPlayer playurl requests to combined `durl` mode first, and rewrites returned media URLs through its own `/media` proxy. Combined `durl` streams may be limited to lower quality.

Upload both files:

- `index.php`
- `potplayer.php`

Keep the startup command unchanged:

```bash
php -S 0.0.0.0:9000 index.php
```

Set the PotPlayer plugin host to:

```text
https://your-function-region.fcapp.run/potplayer.php
```

For higher quality DASH/HEVC playback, use the dedicated `../aliyun-fc-potplayer` package instead.

Do not commit personal service URLs or account access keys.
