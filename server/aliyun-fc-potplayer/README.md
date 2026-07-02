# Aliyun Function Compute for PotPlayer

Dedicated PHP runtime package for the Chen310 Bilibili PotPlayer plugin.

Full Chinese deployment guide: [`../ALIYUN_FC_PHP.md`](../ALIYUN_FC_PHP.md)

## Files

- `bootstrap`
- `server.php`
- `index.php`

Upload all three files to Aliyun Function Compute.

## Runtime

- Runtime: custom runtime, Debian 10 works
- Startup command: `./bootstrap`
- Listen port: `9000`
- Public HTTP trigger: enabled

## Plugin host

Set the PotPlayer Bilibili plugin host to your own Function Compute public URL:

```text
https://your-function-region.fcapp.run
```

Do not commit personal service URLs, cookies, or account access keys.

## Routes

- `/pgc/player/web/playurl`
- `/pgc/player/api/playurl`
- `/x/player/playurl`
- `/mpd`
- `/media`
- `/subtitle`

The service converts Bilibili DASH playurl data into MPD output for PotPlayer, proxies media with Range support, and converts Bilibili danmaku/subtitles for PotPlayer subtitle tracks.
