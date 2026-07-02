# 阿里云函数计算 PHP 自建服务端

本文档说明如何把本仓库的 PHP 服务端部署到阿里云函数计算，用于浏览器扩展和 PotPlayer 插件。

## 选择哪个目录

| 用途 | 上传目录 | 服务端地址填哪里 |
|---|---|---|
| 浏览器扩展网页播放 | `server/aliyun-fc` | 扩展设置里的“服务端地址” |
| PotPlayer 高画质播放 | `server/aliyun-fc-potplayer` | PotPlayer Bilibili 插件的 `host` |

建议两套服务分开部署成两个函数：网页端函数只给扩展用，PotPlayer 函数只给 PotPlayer 插件用。这样出问题时更容易定位，也不会互相影响。

## 前提

- 阿里云函数计算地域请选择中国大陆地域，例如华东 1（杭州）或华东 2（上海）。
- 运行环境选择 PHP 8.1 自定义运行时，Debian 10 可用。
- HTTP 触发器需要打开公网访问。
- 本项目不要提交真实公网地址、Cookie、access key 或账号信息。

## 部署浏览器扩展服务

上传目录：

```text
server/aliyun-fc
```

需要上传的文件：

```text
index.php
potplayer.php
README.md
```

函数配置：

```text
运行环境：PHP 8.1 自定义运行时
启动命令：php -S 0.0.0.0:9000 index.php
监听端口：9000
执行超时时间：60 秒或更高
触发器类型：HTTP 触发器
请求方法：GET、POST、PUT、DELETE、HEAD、OPTIONS、PATCH
认证方式：自用可选“无需认证”
```

部署后会得到类似下面的公网访问地址：

```text
https://your-function-region.fcapp.run
```

把这个地址填到扩展设置里的“服务端地址”，末尾不要带斜杠。

可测试的地址：

```text
https://your-function-region.fcapp.run/x/web-interface/nav
```

能返回 JSON 就说明函数已启动。未登录或未带 Cookie 时返回未登录状态是正常的。

## 部署 PotPlayer 专用服务

上传目录：

```text
server/aliyun-fc-potplayer
```

需要上传的文件：

```text
bootstrap
server.php
index.php
README.md
```

函数配置：

```text
运行环境：PHP 8.1 自定义运行时
启动命令：./bootstrap
监听端口：9000
执行超时时间：60 秒或更高
触发器类型：HTTP 触发器
请求方法：GET、POST、PUT、DELETE、HEAD、OPTIONS、PATCH
认证方式：自用可选“无需认证”
```

如果控制台提示 `bootstrap` 没有执行权限，可以把启动命令改成：

```bash
bash bootstrap
```

部署后，把 PotPlayer Bilibili 插件里的 `host` 改成你的公网访问地址：

```text
https://your-function-region.fcapp.run
```

不要在仓库里写入自己的真实函数地址。

## PotPlayer 服务路由

PotPlayer 专用服务支持：

- `/pgc/player/web/playurl`
- `/pgc/player/api/playurl`
- `/x/player/playurl`
- `/mpd`
- `/media`
- `/subtitle`

它会把 B 站 DASH playurl 转成 PotPlayer 可识别的 MPD，并通过 `/media` 代理音视频分片。`/subtitle` 用于弹幕和字幕转换。

## 常见问题

### 打开根路径返回 unsupported path

这是正常的。服务端不是网页首页，需要访问具体 API 路由，例如 `/x/web-interface/nav`。

### 只有声音没有画面

通常是 PotPlayer 解码器或编码选择问题。本服务默认会避开 HDR/Dolby Vision，优先选择 SDR HEVC。如果仍然黑屏，可以在 PotPlayer 里切到可用的视频解码器，或临时选择 AVC 画质。

### 只能 720p

浏览器扩展服务里的 `potplayer.php` 是简易 fallback，可能只能拿到 combined `durl` 低清晰度。高画质请使用 `server/aliyun-fc-potplayer` 独立函数。

### 播放一会儿自动下一集

多半是 `/media` Range 代理超时或返回头不完整。PotPlayer 专用服务已经按分片 Range 代理设计，请优先使用它，不要用简易 fallback 播放高画质。

### 弹幕不显示

PotPlayer 插件里的弹幕服务器请填同一个 PotPlayer 函数地址。弹幕会作为 PotPlayer 字幕轨显示，不是网页播放器那种原生弹幕层。

## 安全提醒

- 公网 HTTP 触发器如果设置为“无需认证”，任何人都可以访问你的函数地址。
- 只建议自用，不要把真实地址公开到 README、issue、截图或代码里。
- 不要上传 `Bilibili_Config.json`、浏览器 Cookie、`SESSDATA`、`bili_jct`、`DedeUserID`。
