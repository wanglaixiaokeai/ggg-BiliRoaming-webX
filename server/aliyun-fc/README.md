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

Do not commit personal service URLs or account access keys.
