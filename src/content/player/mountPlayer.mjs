// BiliRoaming-webX Player — 播放器挂载核心。
//
// 架构：覆盖式播放（不重写 B 站 Player core）
//   在 #bilibili-player 内追加 .brx-player-root 绝对定位覆盖层，隐藏 B 站原生 <video>，
//   创建 ArtPlayer 接管 video 状态机，dash.js 作为 MSE 引擎消费 MPD Blob。
//
// 关键设计点：
//   - 选择器等待：waitForElement('#bilibili-player, .bpx-player-container') —— 容器可能被
//     React 异步渲染。
//   - 事件栅栏 installPlayerEventFence：bubble 阶段截断 click/dblclick/contextmenu/mouse/
//     pointer/touch/wheel/keydown/keyup，避免 ArtPlayer 内部控件点击冒泡到 B 站原生监听器
//     触发误触（网页全屏 / 暂停 / 选中控件）。
//   - destroy 顺序：clearInterval → subtitle dispose → eventFence cleanup → resizeObserver
//     disconnect → dashPlayer.reset → art.destroy(false) → revokeObjectURL → root.remove，
//     保证切集后无残留音频（修复历史：VisionPlayer 时代 "暂停后音频继续"）。
//   - 切换清晰度/编码/音轨：reloadWithSelection() 重建 MPD Blob，保留 currentTime。
//
// 弹幕：artplayerPluginDanmuku(cid-based https://comment.bilibili.com/<cid>.xml) +
//   chrome.storage.sync.brx_danmaku 持久化。
// 字幕：SubtitleManager 异步拉 /x/v2/subtitle/web/view → VTT Blob → art.subtitle.init。

import { waitForElement, stripAreaLimitUi } from '../../common/dom.mjs';
import { QUALITY_LABELS } from '../../common/constants.mjs';
import { extractDash, uniqueQualities, uniqueCodecs, audioOptions, createMpdUrl, selectStreams, createMediaProxyBase, proxyMediaForServer } from './dashMpdBuilder.mjs';
import { SubtitleManager } from '../subtitle/subtitlePlugin.mjs';
import { fetchBiliSubtitleVtt } from '../subtitle/biliSubtitle.mjs';

export async function mountPlayer({ playurl, context, config, log }) {
  const engine = String(config?.playerEngine || 'xgplayer').toLowerCase();
  if (engine !== 'artplayer') {
    try {
      return await mountXgPlayer({ playurl, context, config, log });
    } catch (err) {
      log?.warn?.('xgplayer mount failed, fallback to ArtPlayer', err);
      if (engine === 'xgplayer') {
        window.__BRX_PLAYER_DEBUG__ = Object.assign(window.__BRX_PLAYER_DEBUG__ || {}, {
          xgplayerError: String(err?.message || err),
          playerFallback: 'artplayer',
        });
      }
    }
  }
  return mountArtPlayer({ playurl, context, config, log });
}

async function mountArtPlayer({ playurl, context, config, log }) {
  await ensureArtVendorLoaded();

  const dash = extractDash(playurl);
  if (!dash || !dash.video?.length) {
    return mountMp4Player({ playurl, context, config, log });
  }

  const target = await waitForElement('#bilibili-player, .bpx-player-container');
  const outer = target.id === 'bilibili-player' ? target : (target.closest('#bilibili-player') || target);
  outer.style.position = 'relative';
  outer.querySelectorAll('.brx-player-root').forEach((el) => el.remove());
  stripAreaLimitUi(outer);

  const root = document.createElement('div');
  root.className = 'brx-player-root brx-artplayer-root';
  root.innerHTML = `
    <div class="brx-artplayer-box"></div>
    <div class="brx-status">BiliRoaming-webX ArtPlayer</div>
  `;
  const style = document.createElement('style');
  style.textContent = cssText();
  root.appendChild(style);
  outer.appendChild(root);

  // 播放器覆盖层事件栅栏：允许 ArtPlayer 内部控件先正常处理事件，
  // 但在冒泡离开覆盖层前截断，避免点击/双击/右键等漏到 B 站原生播放器，
  // 触发原生网页全屏、暂停、选中控件等副作用。
  const eventFenceCleanups = installPlayerEventFence(root);

  for (const v of outer.querySelectorAll('video')) {
    if (!v.closest('.brx-player-root')) v.style.opacity = '0';
  }

  const artBox = root.querySelector('.brx-artplayer-box');
  const status = root.querySelector('.brx-status');

  const qualities = uniqueQualities(dash.video || []);
  const codecs = uniqueCodecs(dash.video || []);
  const audios = audioOptions(dash.audio || dash.dolby?.audio || []);
  let selection = {
    qn: config.defaultQn || '80',
    codec: config.defaultCodec || 'auto',
    audioId: config.defaultAudioId || 'auto',
  };
  if (!qualities.some((q) => q.id === selection.qn)) selection.qn = qualities[0]?.id || 'auto';

  let mpdObjectUrl = '';
  let art = null;
  let dashPlayer = null;
  let resizeObserver = null;
  let subtitleManager = null;

  // 从 chrome.storage 加载弹幕已保存设置
  let dmSaved = {};
  try {
    const r = await chrome.storage.sync.get('brx_danmaku');
    if (r.brx_danmaku && typeof r.brx_danmaku.speed === 'number') {
      dmSaved = r.brx_danmaku;
      delete dmSaved.margin;
    } else {
      // 旧数据格式（speed 是 NaN 或不存在），清除
      try { chrome.storage.sync.remove('brx_danmaku'); } catch (_) {}
    }
  } catch (_) {}

  function nextMpdUrl() {
    if (mpdObjectUrl) URL.revokeObjectURL(mpdObjectUrl);
    const mpd = createMpdUrl(dash, selection, { mediaProxyBase: createMediaProxyBase(config.serverBaseUrl) });
    mpdObjectUrl = mpd.url;
    window.__BRX_PLAYER_LAST_MPD__ = mpd.xml;
    return mpdObjectUrl;
  }

  // ArtPlayer customType 回调：dash.js 接管 <video>。
  function playMpd(video, url, artInstance) {
    if (!window.dashjs?.supportsMediaSource?.()) {
      artInstance.notice.show = '当前浏览器不支持 DASH/MSE';
      return;
    }
    if (artInstance.dash) {
      try { artInstance.dash.reset?.(); } catch (_) {}
      try { artInstance.dash.destroy?.(); } catch (_) {}
    }
    const player = window.dashjs.MediaPlayer().create();
    dashPlayer = player;
    artInstance.dash = player;
    player.updateSettings({
      streaming: {
        buffer: { fastSwitchEnabled: true },
        abr: { autoSwitchBitrate: { video: selection.qn === 'auto' } },
      },
    });
    player.on(window.dashjs.MediaPlayer.events.ERROR, (e) => {
      status.textContent = '播放错误: ' + JSON.stringify(e.error || e.event || e).slice(0, 180);
      status.style.opacity = '1';
    });
    player.on(window.dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
      status.textContent = labelSelection(selection);
      status.style.opacity = '1';
      setTimeout(() => { status.style.opacity = '0'; }, 1800);
    });
    player.initialize(video, url, artInstance.option.autoplay);
  }

  art = new window.Artplayer({
    container: artBox,
    url: nextMpdUrl(),
    type: 'mpd',
    autoplay: true,
    pip: false,
    autoSize: false,
    autoMini: false,
    screenshot: false,
    setting: true,
    playbackRate: true,
    aspectRatio: true,
    fullscreen: true,
    fullscreenWeb: true,
    mutex: false,
    theme: '#00aeec',
    customType: { mpd: playMpd },
    settings: createArtSettings(),
    plugins: createArtPlugins(),
  });

  // 字幕按钮随播放器一起初始化，不用等 ready
  // SubtitleManager 内部用 art.controls.add 挂到 controlsRight
  buildSubtitleControl();
  // 字幕数据异步拉，不阻塞 ready
  loadSubtitle().catch(() => {});

  art.on('ready', async () => {
    installResizeRelay();
    installDanmakuPersistence();
    window.__BRX_PLAYER_DEBUG__ = Object.assign(window.__BRX_PLAYER_DEBUG__ || {}, { art, dashPlayer });
  });

  for (const eventName of ['resize', 'fullscreen', 'fullscreenWeb', 'mini', 'pip', 'document-pip']) {
    art.on(eventName, () => {});
  }
  document.addEventListener('fullscreenchange', onGlobalFullscreenChange);

  async function reloadWithSelection(next) {
    selection = next;
    const video = art?.video;
    const t = video?.currentTime || 0;
    const paused = video ? video.paused : false;
    status.textContent = '切换到 ' + labelSelection(selection);
    status.style.opacity = '1';
    if (art) art.url = nextMpdUrl();
    const onMeta = () => {
      try { art.video.currentTime = t; } catch (_) {}
      if (!paused) art.video.play().catch(() => {});
      art.video.removeEventListener('loadedmetadata', onMeta);
    };
    art?.video?.addEventListener('loadedmetadata', onMeta);
  }

  function createArtSettings() {
    return [
      {
        html: '清晰度',
        tooltip: qualities.find((q) => q.id === selection.qn)?.label || '自动清晰度',
        selector: [{ html: '自动清晰度', value: 'auto', default: selection.qn === 'auto' }, ...qualities.map((q) => ({ html: q.label, value: q.id, default: q.id === selection.qn }))],
        onSelect: (item) => { reloadWithSelection({ ...selection, qn: item.value }); return item.html; },
      },
      {
        html: '编码',
        tooltip: codecs.find((c) => c.id === selection.codec)?.label || '自动编码',
        selector: codecs.map((c) => ({ html: c.label, value: c.id, default: c.id === selection.codec })),
        onSelect: (item) => { reloadWithSelection({ ...selection, codec: item.value }); return item.html; },
      },
      {
        html: '音轨',
        tooltip: audios.find((a) => a.id === selection.audioId)?.label || '自动音轨',
        selector: audios.map((a) => ({ html: a.label, value: a.id, default: a.id === selection.audioId })),
        onSelect: (item) => { reloadWithSelection({ ...selection, audioId: item.value }); return item.html; },
      },
    ];
  }

  function createArtPlugins() {
    const plugins = [];
    if (window.artplayerPluginDanmuku) {
      // PGC 场景下 cid 不可缺（缺失会让插件请求 ?oid=null&pid=null → code:-400）。
      // 由 content/app.mjs 的 FETCH_EP_INFO 已确保 cid 非空。
      const cid = Number(context?.cid) || 0;
      if (!cid) log.warn('danmuku: skip load, context.cid missing', { context });
      const danmukuUrl = cid ? `https://comment.bilibili.com/${cid}.xml` : [];
      const dmDefaults = { speed: 5, opacity: 0.9, fontSize: 25, antiOverlap: true, synchronousPlayback: true, visible: true, modes: [0, 1, 2] };
      const dmOpts = { ...dmDefaults, ...dmSaved, danmuku: danmukuUrl, emitter: false, heatmap: false, filter: (d) => d.text.trim().length > 0 };
      plugins.push(window.artplayerPluginDanmuku(dmOpts));
    }
    if (window.artplayerPluginDocumentPip) {
      plugins.push(window.artplayerPluginDocumentPip({ width: 640, height: 360, fallbackToVideoPiP: false, placeholder: '正在以画中画播放' }));
    }
    return plugins;
  }

  // 字幕开关 + 语言切换面板，挂在 controlsRight（右边设置按钮旁边）
  function buildSubtitleControl() {
    if (!art?.template) return;
    subtitleManager = new SubtitleManager({ art, log });
    subtitleManager.buildUI();
  }

  // 拉 B 站 PGC 字幕 → 喂给 SubtitleManager
  async function loadSubtitle() {
    if (!subtitleManager) return;
    const cid = Number(context?.cid);
    const aid = Number(context?.aid);
    if (!cid || !aid) {
      log?.info?.('subtitle: skip, no cid/aid', { context });
      return;
    }
    await subtitleManager.load({ cid, aid });
  }

  function installResizeRelay() {
    if (resizeObserver || !window.ResizeObserver) return;
    resizeObserver = new ResizeObserver(() => {});
    if (art?.template?.$player) resizeObserver.observe(art.template.$player);
    if (art?.template?.$container) resizeObserver.observe(art.template.$container);
    if (art?.video) resizeObserver.observe(art.video);
  }

  let dmSaveTimer = null;
  function installDanmakuPersistence() {
    // ArtPlayer 插件挂在 art.plugins 上，属性名是 plugin 返回值的 name。
    // 实际值：art.plugins.artplayerPluginDanmuku 或 art.plugins.danmuku（向后兼容）。
    const readOpt = () => {
      try {
        const p = art.plugins || {};
        const inst = p.artplayerPluginDanmuku || p.danmuku;
        return inst?.option || null;
      } catch (_) { return null; }
    };
    const save = () => {
      const opt = readOpt(); if (!opt) return;
      try {
        chrome.storage.sync.set({ brx_danmaku: {
          visible: opt.visible !== false,
          speed: opt.speed,
          opacity: opt.opacity,
          fontSize: opt.fontSize,
          antiOverlap: opt.antiOverlap,
          synchronousPlayback: opt.synchronousPlayback,
          modes: Array.isArray(opt.modes) ? [...opt.modes] : [0, 1, 2],
        } });
      } catch (_) {}
    };
    save();
    dmSaveTimer = setInterval(save, 3000);
  }

  function onGlobalFullscreenChange() {}

  function labelSelection(sel) {
    const q = sel.qn === 'auto' ? '自动清晰度' : (qualities.find((x) => x.id === sel.qn)?.label || sel.qn);
    const c = sel.codec === 'auto' ? '自动编码' : String(sel.codec).toUpperCase();
    const a = audios.find((x) => x.id === sel.audioId)?.label || '自动音轨';
    const selected = selectStreams(dash, sel);
    return `${q} / ${c} / ${a} (${selected.videos.length}V/${selected.audios.length}A)`;
  }

  return {
    root,
    get art() { return art; },
    get video() { return art?.video || null; },
    get dashPlayer() { return dashPlayer; },
    get selection() { return selection; },
    destroy() {
      if (dmSaveTimer) { clearInterval(dmSaveTimer); dmSaveTimer = null; }
      try { subtitleManager?.dispose?.(); } catch (_) {}
      subtitleManager = null;
      for (const cleanup of eventFenceCleanups) {
        try { cleanup(); } catch (_) {}
      }
      document.removeEventListener('fullscreenchange', onGlobalFullscreenChange);
      try { resizeObserver?.disconnect?.(); } catch (_) {}
      try { dashPlayer?.reset?.(); } catch (_) {}
      try { art?.destroy?.(false); } catch (_) {}
      if (mpdObjectUrl) URL.revokeObjectURL(mpdObjectUrl);
      root.remove();
    },
  };
}

async function mountXgPlayer({ playurl, context, config, log }) {
  await ensureXgVendorLoaded();

  const dash = extractDash(playurl);
  const mp4Options = dash?.video?.length ? [] : extractMp4Options(playurl, config);
  if ((!dash || !dash.video?.length) && !mp4Options.length) {
    throw new Error('No DASH or MP4 video in playurl response');
  }

  const target = await waitForElement('#bilibili-player, .bpx-player-container');
  const outer = target.id === 'bilibili-player' ? target : (target.closest('#bilibili-player') || target);
  outer.style.position = 'relative';
  outer.querySelectorAll('.brx-player-root').forEach((el) => el.remove());
  stripAreaLimitUi(outer);

  const root = document.createElement('div');
  root.className = 'brx-player-root brx-xgplayer-root';
  root.innerHTML = `
    <div class="brx-xgplayer-box"></div>
    <div class="brx-xg-danmaku"></div>
    <div class="brx-xg-toolbar"></div>
    <div class="brx-status">BiliRoaming-webX xgplayer</div>
  `;
  const style = document.createElement('style');
  style.textContent = cssText();
  root.appendChild(style);
  outer.appendChild(root);

  const eventFenceCleanups = installPlayerEventFence(root);
  for (const v of outer.querySelectorAll('video')) {
    if (!v.closest('.brx-player-root')) v.style.opacity = '0';
  }

  const playerBox = root.querySelector('.brx-xgplayer-box');
  const toolbar = root.querySelector('.brx-xg-toolbar');
  const status = root.querySelector('.brx-status');
  const danmakuLayer = root.querySelector('.brx-xg-danmaku');

  let mode = dash?.video?.length ? 'dash' : 'mp4';
  let player = null;
  let dashPlayer = null;
  let mpdObjectUrl = '';
  let mpdXml = '';
  let currentMp4 = mp4Options[0] || null;
  let subtitleCleanup = () => {};
  let danmakuCleanup = () => {};

  const qualities = mode === 'dash' ? uniqueQualities(dash.video || []) : mp4Options.map((item) => ({ id: item.id, label: item.label }));
  const codecs = mode === 'dash' ? uniqueCodecs(dash.video || []) : [{ id: 'mp4', label: 'MP4' }];
  const audios = mode === 'dash' ? audioOptions(dash.audio || dash.dolby?.audio || []) : [{ id: 'mp4', label: 'MP4' }];
  let selection = mode === 'dash'
    ? {
        qn: config.defaultQn || '80',
        codec: config.defaultCodec || 'auto',
        audioId: config.defaultAudioId || 'auto',
      }
    : { qn: currentMp4?.id || 'mp4', codec: 'mp4', audioId: 'mp4' };
  if (mode === 'dash' && !qualities.some((q) => q.id === selection.qn)) selection.qn = qualities[0]?.id || 'auto';

  function nextMpdUrl() {
    if (mpdObjectUrl) URL.revokeObjectURL(mpdObjectUrl);
    const mpd = createMpdUrl(dash, selection, { mediaProxyBase: createMediaProxyBase(config.serverBaseUrl) });
    mpdObjectUrl = mpd.url;
    mpdXml = mpd.xml;
    window.__BRX_PLAYER_LAST_MPD__ = mpd.xml;
    return mpdObjectUrl;
  }

  function currentUrl() {
    return mode === 'dash' ? nextMpdUrl() : currentMp4.url;
  }

  buildXgToolbar();

  const mediaEl = document.createElement('video');
  mediaEl.preload = 'auto';
  mediaEl.playsInline = true;
  mediaEl.setAttribute('playsinline', '');
  mediaEl.setAttribute('webkit-playsinline', '');

  player = new window.Player({
    el: playerBox,
    mediaEl,
    url: mode === 'dash' ? '' : currentUrl(),
    autoplay: true,
    nullUrlStart: mode === 'dash',
    videoInit: true,
    fluid: true,
    width: '100%',
    height: '100%',
    videoFillMode: 'contain',
    lang: 'zh-cn',
    closeVideoClick: false,
    closeVideoDblclick: false,
    pip: true,
    cssFullscreen: true,
    playbackRate: [0.5, 0.75, 1, 1.25, 1.5, 2],
    ignores: ['download', 'miniscreen'],
    plugins: [],
  });

  player.on?.('ready', () => {
    status.textContent = `xgplayer / ${labelSelection(selection)}`;
    status.style.opacity = '1';
    setTimeout(() => { status.style.opacity = '0'; }, 1800);
    window.__BRX_PLAYER_DEBUG__ = Object.assign(window.__BRX_PLAYER_DEBUG__ || {}, {
      playerEngine: 'xgplayer',
      xgplayer: player,
      dashPlayer,
      context,
    });
  });
  player.on?.('error', (err) => {
    status.textContent = 'xgplayer 播放错误: ' + String(err?.message || err).slice(0, 160);
    status.style.opacity = '1';
    log?.warn?.('xgplayer error', err);
  });

  if (mode === 'dash') {
    await startDashPlayback(nextMpdUrl(), true, 0);
  }

  subtitleCleanup = await installXgSubtitle({ player, root, toolbar, context, log });
  danmakuCleanup = await installXgDanmaku({ player, root, toolbar, danmakuLayer, context, config, log });

  async function reloadWithSelection(next) {
    selection = next;
    const video = getXgVideo(player, root);
    const t = video?.currentTime || player?.currentTime || 0;
    const paused = video ? video.paused : true;
    const url = mode === 'dash' ? nextMpdUrl() : currentMp4.url;
    status.textContent = '切换到 ' + labelSelection(selection);
    status.style.opacity = '1';
    if (mode === 'dash') {
      await startDashPlayback(url, !paused, t);
    } else if (typeof player?.switchURL === 'function') {
      await player.switchURL(url, { currentTime: t, seamless: false }).catch(() => null);
    } else {
      player.url = url;
    }
    const nextVideo = await waitForXgVideo(player, root).catch(() => null);
    try { if (nextVideo) nextVideo.currentTime = t; } catch (_) {}
    if (!paused) player?.play?.();
  }

  async function startDashPlayback(url, autoplay, startTime = 0) {
    const video = await waitForXgVideo(player, root);
    try { dashPlayer?.reset?.(); } catch (_) {}
    dashPlayer = window.dashjs.MediaPlayer().create();
    dashPlayer.updateSettings({
      streaming: {
        buffer: { fastSwitchEnabled: true },
        abr: { autoSwitchBitrate: { video: selection.qn === 'auto' } },
      },
    });
    dashPlayer.on(window.dashjs.MediaPlayer.events.ERROR, (e) => {
      status.textContent = 'DASH 播放错误: ' + JSON.stringify(e.error || e.event || e).slice(0, 160);
      status.style.opacity = '1';
      log?.warn?.('xg dash.js error', e);
    });
    dashPlayer.on(window.dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
      status.textContent = `xgplayer / ${labelSelection(selection)}`;
      status.style.opacity = '1';
      setTimeout(() => { status.style.opacity = '0'; }, 1800);
      if (startTime > 0) {
        try { video.currentTime = startTime; } catch (_) {}
      }
      if (autoplay) video.play?.().catch?.(() => {});
    });
    dashPlayer.initialize(video, url, autoplay);
  }

  function buildXgToolbar() {
    const qOptions = mode === 'dash'
      ? [{ id: 'auto', label: '自动清晰度' }, ...qualities]
      : mp4Options;
    toolbar.innerHTML = `
      <select class="brx-xg-select" data-role="quality" title="清晰度">${qOptions.map((q) => `<option value="${escAttr(q.id)}"${q.id === selection.qn ? ' selected' : ''}>${escHtml(q.label || q.id)}</option>`).join('')}</select>
      ${mode === 'dash' ? `<select class="brx-xg-select" data-role="codec" title="编码">${codecs.map((c) => `<option value="${escAttr(c.id)}"${c.id === selection.codec ? ' selected' : ''}>${escHtml(c.label || c.id)}</option>`).join('')}</select>` : ''}
      ${mode === 'dash' ? `<select class="brx-xg-select" data-role="audio" title="音轨">${audios.map((a) => `<option value="${escAttr(a.id)}"${a.id === selection.audioId ? ' selected' : ''}>${escHtml(a.label || a.id)}</option>`).join('')}</select>` : ''}
      <button class="brx-xg-button" type="button" data-role="subtitle" disabled>字幕</button>
      <button class="brx-xg-button" type="button" data-role="danmaku" disabled>弹幕</button>
      ${config.externalInterpolation !== false ? '<button class="brx-xg-button" type="button" data-role="interpolation">插帧</button>' : ''}
    `;
    toolbar.querySelector('[data-role="quality"]')?.addEventListener('change', (e) => {
      const value = e.target.value;
      if (mode === 'dash') {
        reloadWithSelection({ ...selection, qn: value });
      } else {
        currentMp4 = mp4Options.find((item) => item.id === value) || currentMp4;
        reloadWithSelection({ qn: currentMp4?.id || value, codec: 'mp4', audioId: 'mp4' });
      }
    });
    toolbar.querySelector('[data-role="codec"]')?.addEventListener('change', (e) => {
      reloadWithSelection({ ...selection, codec: e.target.value });
    });
    toolbar.querySelector('[data-role="audio"]')?.addEventListener('change', (e) => {
      reloadWithSelection({ ...selection, audioId: e.target.value });
    });
    toolbar.querySelector('[data-role="interpolation"]')?.addEventListener('click', () => {
      handleExternalInterpolation({
        mode,
        url: currentMp4?.url || '',
        mpdXml,
        context,
        status,
      });
    });
  }

  function labelSelection(sel) {
    if (mode === 'mp4') return `${currentMp4?.label || sel.qn} / MP4`;
    const q = sel.qn === 'auto' ? '自动清晰度' : (qualities.find((x) => x.id === sel.qn)?.label || sel.qn);
    const c = sel.codec === 'auto' ? '自动编码' : String(sel.codec).toUpperCase();
    const a = audios.find((x) => x.id === sel.audioId)?.label || '自动音轨';
    const selected = selectStreams(dash, sel);
    return `${q} / ${c} / ${a} (${selected.videos.length}V/${selected.audios.length}A)`;
  }

  return {
    root,
    get art() { return null; },
    get player() { return player; },
    get video() { return getXgVideo(player, root); },
    get dashPlayer() { return dashPlayer; },
    get selection() { return selection; },
    destroy() {
      try { subtitleCleanup?.(); } catch (_) {}
      try { danmakuCleanup?.(); } catch (_) {}
      for (const cleanup of eventFenceCleanups) {
        try { cleanup(); } catch (_) {}
      }
      try { dashPlayer?.reset?.(); } catch (_) {}
      try { player?.destroy?.(); } catch (_) {}
      if (mpdObjectUrl) URL.revokeObjectURL(mpdObjectUrl);
      root.remove();
    },
  };
}

async function mountMp4Player({ playurl, context, config, log }) {
  const mp4Options = extractMp4Options(playurl, config);
  if (!mp4Options.length) throw new Error('No DASH or MP4 video in playurl response');

  const target = await waitForElement('#bilibili-player, .bpx-player-container');
  const outer = target.id === 'bilibili-player' ? target : (target.closest('#bilibili-player') || target);
  outer.style.position = 'relative';
  outer.querySelectorAll('.brx-player-root').forEach((el) => el.remove());
  stripAreaLimitUi(outer);

  const root = document.createElement('div');
  root.className = 'brx-player-root brx-artplayer-root';
  root.innerHTML = `
    <div class="brx-artplayer-box"></div>
    <div class="brx-status">BiliRoaming-webX MP4</div>
  `;
  const style = document.createElement('style');
  style.textContent = cssText();
  root.appendChild(style);
  outer.appendChild(root);

  const eventFenceCleanups = installPlayerEventFence(root);
  for (const v of outer.querySelectorAll('video')) {
    if (!v.closest('.brx-player-root')) v.style.opacity = '0';
  }

  const artBox = root.querySelector('.brx-artplayer-box');
  const status = root.querySelector('.brx-status');
  const quality = mp4Options.map((item, index) => ({
    default: index === 0,
    html: item.label,
    url: item.url,
  }));

  const art = new window.Artplayer({
    container: artBox,
    url: mp4Options[0].url,
    type: 'mp4',
    autoplay: true,
    pip: false,
    autoSize: false,
    autoMini: false,
    screenshot: false,
    setting: true,
    playbackRate: true,
    aspectRatio: true,
    fullscreen: true,
    fullscreenWeb: true,
    mutex: false,
    theme: '#00aeec',
    quality,
  });

  art.on('ready', () => {
    status.textContent = `${mp4Options[0].label} / MP4`;
    status.style.opacity = '1';
    setTimeout(() => { status.style.opacity = '0'; }, 1800);
    window.__BRX_PLAYER_DEBUG__ = Object.assign(window.__BRX_PLAYER_DEBUG__ || {}, {
      art,
      mp4Fallback: true,
      context,
    });
  });
  art.on('error', (err) => {
    status.textContent = 'MP4 播放错误: ' + String(err && err.message || err).slice(0, 120);
    status.style.opacity = '1';
    log?.warn?.('mp4 player error', err);
  });

  return {
    root,
    get art() { return art; },
    get video() { return art?.video || null; },
    get dashPlayer() { return null; },
    get selection() { return { qn: mp4Options[0].id, codec: 'mp4', audioId: 'mp4' }; },
    destroy() {
      for (const cleanup of eventFenceCleanups) {
        try { cleanup(); } catch (_) {}
      }
      try { art?.destroy?.(false); } catch (_) {}
      root.remove();
    },
  };
}

function extractMp4Options(playurl, config) {
  const result = playurl?.result || playurl?.data || playurl || {};
  const options = [];
  const support = new Map((result.support_formats || []).map((item) => [String(item.quality), item]));
  const pushUrl = (quality, url) => {
    if (!url || options.some((item) => item.url === url)) return;
    const id = String(quality || result.quality || 'mp4');
    const fmt = support.get(id);
    options.push({
      id,
      label: fmt?.new_description || fmt?.display_desc || QUALITY_LABELS[id] || `${id}P`,
      url: proxyMediaForServer(url, config?.serverBaseUrl),
    });
  };

  for (const item of result.durls || []) {
    const quality = item.quality;
    for (const d of item.durl || []) pushUrl(quality, d.url || d.base_url || d.baseUrl);
  }
  for (const d of result.durl || []) pushUrl(result.quality, d.url || d.base_url || d.baseUrl);

  const preferred = String(config?.defaultQn || '');
  options.sort((a, b) => {
    if (a.id === preferred) return -1;
    if (b.id === preferred) return 1;
    return Number(b.id) - Number(a.id);
  });
  return options;
}

async function installXgSubtitle({ player, root, toolbar, context, log }) {
  const button = toolbar.querySelector('[data-role="subtitle"]');
  const cid = Number(context?.cid);
  const aid = Number(context?.aid);
  if (!button || !cid || !aid) return () => {};

  let blobUrl = '';
  let trackEl = null;
  let visible = true;
  button.textContent = '字幕...';
  button.disabled = true;

  try {
    const track = await fetchBiliSubtitleVtt({ cid, aid }, { log });
    if (!track?.blobUrl) {
      button.textContent = '无字幕';
      return () => {};
    }
    blobUrl = track.blobUrl;
    const video = await waitForXgVideo(player, root);
    trackEl = document.createElement('track');
    trackEl.kind = 'subtitles';
    trackEl.label = track.lanDoc || track.lan || 'Subtitle';
    trackEl.srclang = track.lan || 'zh';
    trackEl.src = track.blobUrl;
    trackEl.default = true;
    video.appendChild(trackEl);
    trackEl.addEventListener('load', () => {
      try { trackEl.track.mode = visible ? 'showing' : 'hidden'; } catch (_) {}
    });
    button.textContent = '字幕';
    button.disabled = false;
    button.classList.toggle('active', visible);
    button.addEventListener('click', () => {
      visible = !visible;
      button.classList.toggle('active', visible);
      try { trackEl.track.mode = visible ? 'showing' : 'hidden'; } catch (_) {}
    });
  } catch (err) {
    button.textContent = '字幕失败';
    button.disabled = true;
    log?.warn?.('xg subtitle load failed', err);
  }

  return () => {
    try { trackEl?.remove?.(); } catch (_) {}
    if (blobUrl) try { URL.revokeObjectURL(blobUrl); } catch (_) {}
  };
}

async function installXgDanmaku({ player, root, toolbar, danmakuLayer, context, config, log }) {
  const button = toolbar.querySelector('[data-role="danmaku"]');
  const cid = Number(context?.cid);
  if (!button || !danmakuLayer || !cid || config?.danmakuEnabled === false) return () => {};

  let visible = true;
  let items = [];
  let index = 0;
  let lastTime = 0;
  let video = null;
  const maxVisible = Number(config?.danmakuMaxVisible || 120);
  const fontSize = Number(config?.danmakuFontSize || 25);
  const opacity = Number(config?.danmakuOpacity || 0.95);
  const speed = Math.max(0.5, Number(config?.danmakuSpeed || 1));

  button.textContent = '弹幕...';
  button.disabled = true;

  try {
    const resp = await fetch(`https://comment.bilibili.com/${encodeURIComponent(cid)}.xml`, {
      credentials: 'omit',
      headers: { 'Referer': 'https://www.bilibili.com/' },
    });
    const xml = await resp.text();
    items = parseBiliDanmakuXml(xml);
    video = await waitForXgVideo(player, root);
    button.textContent = '弹幕';
    button.disabled = false;
    button.classList.add('active');
    button.addEventListener('click', () => {
      visible = !visible;
      button.classList.toggle('active', visible);
      danmakuLayer.style.display = visible ? '' : 'none';
    });
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('seeked', onSeeked);
  } catch (err) {
    button.textContent = '弹幕失败';
    button.disabled = true;
    log?.warn?.('xg danmaku load failed', err);
  }

  function onSeeked() {
    const t = video?.currentTime || 0;
    index = lowerBoundDanmaku(items, t);
    lastTime = t;
    danmakuLayer.textContent = '';
  }

  function onTimeUpdate() {
    if (!visible || !video || !items.length) return;
    const t = video.currentTime || 0;
    if (t + 1 < lastTime || t - lastTime > 5) index = lowerBoundDanmaku(items, t);
    lastTime = t;
    const limit = t + 0.35;
    while (index < items.length && items[index].time <= limit) {
      if (items[index].time >= t - 0.2) emitDanmaku(items[index]);
      index += 1;
    }
  }

  function emitDanmaku(item) {
    if (danmakuLayer.childElementCount >= maxVisible) danmakuLayer.firstElementChild?.remove?.();
    const el = document.createElement('div');
    el.className = 'brx-xg-danmaku-item';
    el.textContent = item.text;
    el.style.color = item.color || '#fff';
    el.style.fontSize = `${fontSize}px`;
    el.style.opacity = String(opacity);
    const laneHeight = Math.max(28, fontSize + 8);
    const lanes = Math.max(1, Math.floor((danmakuLayer.clientHeight || 360) * Number(config?.danmakuArea || 0.75) / laneHeight));
    el.style.top = `${(item.lane++ % lanes) * laneHeight}px`;
    danmakuLayer.appendChild(el);
    const distance = (danmakuLayer.clientWidth || 640) + el.offsetWidth + 80;
    const duration = Math.max(4, 9 / speed / Math.max(0.5, video?.playbackRate || 1));
    el.style.transform = `translateX(${danmakuLayer.clientWidth || 640}px)`;
    el.style.transition = `transform ${duration}s linear`;
    requestAnimationFrame(() => {
      el.style.transform = `translateX(-${distance}px)`;
    });
    setTimeout(() => el.remove(), duration * 1000 + 200);
  }

  return () => {
    try { video?.removeEventListener('timeupdate', onTimeUpdate); } catch (_) {}
    try { video?.removeEventListener('seeked', onSeeked); } catch (_) {}
    try { danmakuLayer.textContent = ''; } catch (_) {}
  };
}

function parseBiliDanmakuXml(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  return [...doc.querySelectorAll('d[p]')].map((node, lane) => {
    const p = String(node.getAttribute('p') || '').split(',');
    const color = Number(p[3] || 16777215).toString(16).padStart(6, '0');
    return {
      time: Number(p[0]) || 0,
      text: node.textContent || '',
      color: `#${color}`,
      lane,
    };
  }).filter((item) => item.text.trim()).sort((a, b) => a.time - b.time);
}

function lowerBoundDanmaku(items, time) {
  let lo = 0, hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function handleExternalInterpolation({ mode, url, mpdXml, context, status }) {
  const safeTitle = `brx-ep${context?.epId || context?.cid || Date.now()}`;
  if (mode === 'mp4' && url) {
    const command = `mpv --profile=svp "${url}"`;
    await copyText(command);
    status.textContent = '已复制 mpv/SVP 插帧命令';
    status.style.opacity = '1';
    return;
  }
  if (mpdXml) {
    const filename = `${safeTitle}.mpd`;
    downloadTextFile(filename, mpdXml, 'application/dash+xml');
    await copyText(`mpv --profile=svp "${filename}"`);
    status.textContent = '已下载 MPD，并复制 mpv/SVP 命令模板';
    status.style.opacity = '1';
    return;
  }
  status.textContent = '当前资源暂不能生成插帧播放入口';
  status.style.opacity = '1';
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
}

function downloadTextFile(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function getXgVideo(player, root) {
  return player?.media || player?.video || player?.root?.querySelector?.('video') || root?.querySelector?.('video') || null;
}

function waitForXgVideo(player, root, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const video = getXgVideo(player, root);
      if (video) return resolve(video);
      if (Date.now() - started > timeoutMs) return reject(new Error('xgplayer video element not ready'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function escHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escAttr(value) {
  return escHtml(value);
}

async function ensureArtVendorLoaded() {
  // ISOLATED content_scripts 列表里已经预先注入了 vendor/dash.all.min.js + artplayer.js，
  // 这里只做存在性检查，不再二次加载。
  if (!window.Artplayer) throw new Error('ArtPlayer vendor not loaded');
  if (!window.dashjs) throw new Error('dash.js content script not loaded');
}

async function ensureXgVendorLoaded() {
  if (!window.Player) throw new Error('xgplayer vendor not loaded');
  if (!window.dashjs) throw new Error('dash.js content script not loaded');
}

// 事件栅栏：在 .brx-player-root 上注册 bubble 阶段 stopPropagation，阻止
// 控件点击冒泡到 #bilibili-player / B 站原生播放器监听器。capture 阶段不拦截，
// ArtPlayer 内部子控件仍能正常处理事件。
function installPlayerEventFence(root) {
  const cleanups = [];
  // 注意：不要拦截 pointerup/mouseup/touchend。
  // ArtPlayer / artplayer-plugin-danmuku 的滑块拖拽通过 document:pointerup
  // 结束拖拽；如果 release 事件在 root 冒泡阶段被截断，弹幕面板的滑块
  // 会一直保持 dragging 状态，表现为鼠标“粘着小球放不下来”。
  // click/dblclick 仍会被截断，所以 release 透传到 document 不会触发 B 站原生点击逻辑。
  const events = [
    'click', 'dblclick', 'contextmenu',
    'mousedown', 'pointerdown', 'touchstart',
    'wheel', 'keydown', 'keyup',
  ];
  for (const eventName of events) {
    const handler = (e) => {
      if (e.eventPhase !== Event.BUBBLING_PHASE) return;
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    root.addEventListener(eventName, handler, false);
    cleanups.push(() => root.removeEventListener(eventName, handler, false));
  }
  return cleanups;
}

function cssText() {
  return `.brx-player-root{position:absolute;inset:0;z-index:999;background:#000;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.brx-artplayer-box,.brx-xgplayer-box{position:absolute;inset:0;background:#000}.brx-artplayer-box .artplayer,.brx-xgplayer-box .xgplayer{width:100%!important;height:100%!important}.brx-xgplayer-box video::cue{font-size:28px;color:#fff;background:rgba(0,0,0,.28);text-shadow:#000 1px 0 2px,#000 0 1px 2px,#000 -1px 0 2px,#000 0 -1px 2px}.brx-status{position:absolute;left:14px;top:12px;z-index:35;background:rgba(0,0,0,.55);padding:6px 10px;border-radius:6px;transition:opacity .35s}.brx-xg-toolbar{position:absolute;right:12px;top:10px;z-index:42;display:flex;gap:6px;align-items:center;max-width:calc(100% - 24px);flex-wrap:wrap}.brx-xg-select,.brx-xg-button{height:28px;border:1px solid rgba(255,255,255,.22);border-radius:6px;background:rgba(0,0,0,.62);color:#fff;font-size:12px;line-height:26px}.brx-xg-select{padding:0 24px 0 8px;max-width:140px}.brx-xg-button{padding:0 10px;cursor:pointer}.brx-xg-button:disabled{cursor:default;opacity:.45}.brx-xg-button.active{border-color:#00aeec;color:#00aeec}.brx-xg-danmaku{position:absolute;inset:0;z-index:28;pointer-events:none;overflow:hidden}.brx-xg-danmaku-item{position:absolute;left:0;top:0;white-space:pre;font-weight:600;line-height:1.15;text-shadow:#000 1px 0 2px,#000 0 1px 2px,#000 -1px 0 2px,#000 0 -1px 2px;will-change:transform}`;
}
