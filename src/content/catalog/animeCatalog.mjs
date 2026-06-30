import { sendRuntime } from '../bridge.mjs';

const HOST_ID = 'brx-anime-catalog-host';
const PAGE_SIZE = 18;

export function installAnimeCatalogPanel(log) {
  if (!isAnimePage()) return;
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host{position:fixed;right:18px;bottom:18px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#18191c}
      button,input{font:inherit}
      .toggle{width:44px;height:44px;border:0;border-radius:50%;background:#00aeec;color:#fff;font-weight:700;box-shadow:0 8px 24px rgba(0,0,0,.24);cursor:pointer}
      .panel{position:absolute;right:0;bottom:54px;width:min(420px,calc(100vw - 28px));max-height:min(640px,calc(100vh - 92px));display:flex;flex-direction:column;border:1px solid rgba(0,0,0,.12);border-radius:8px;background:#fff;box-shadow:0 18px 56px rgba(0,0,0,.24);overflow:hidden}
      .head{display:flex;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid #e3e5e7;background:#f6f7f8}
      .title{font-size:14px;font-weight:700;white-space:nowrap}
      form{display:flex;gap:6px;flex:1;min-width:0}
      input{min-width:0;flex:1;height:30px;border:1px solid #dcdfe6;border-radius:6px;padding:0 9px;outline:none}
      input:focus{border-color:#00aeec}
      .small{height:30px;border:1px solid #dcdfe6;border-radius:6px;background:#fff;color:#18191c;padding:0 10px;cursor:pointer}
      .small:disabled{cursor:default;opacity:.45}
      .status{min-height:18px;padding:8px 12px 0;color:#61666d;font-size:12px;line-height:18px}
      .list{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:10px 12px 12px;overflow:auto}
      .item{display:block;color:inherit;text-decoration:none;min-width:0}
      .cover{width:100%;aspect-ratio:3/4;border-radius:6px;background:#f1f2f3;object-fit:cover;display:block}
      .name{margin-top:6px;font-size:12px;line-height:16px;font-weight:650;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .meta{margin-top:3px;color:#9499a0;font-size:11px;line-height:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .foot{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border-top:1px solid #e3e5e7;background:#fafafa}
      .page{font-size:12px;color:#61666d}
      .empty{grid-column:1/-1;padding:32px 8px;text-align:center;color:#9499a0;font-size:13px}
      @media (max-width:420px){:host{right:10px;bottom:10px}.panel{width:calc(100vw - 20px)}.list{grid-template-columns:repeat(2,1fr)}}
    </style>
    <button class="toggle" type="button" title="BRX 番剧索引">BRX</button>
    <section class="panel" hidden>
      <div class="head">
        <div class="title">番剧索引</div>
        <form>
          <input class="keyword" type="search" placeholder="搜索番名">
          <button class="small" type="submit">搜索</button>
        </form>
      </div>
      <div class="status">打开后从自建大陆服务端读取索引</div>
      <div class="list"></div>
      <div class="foot">
        <button class="small prev" type="button">上一页</button>
        <span class="page">第 1 页</span>
        <button class="small next" type="button">下一页</button>
      </div>
    </section>
  `;
  (document.documentElement || document.body).appendChild(host);

  const panel = shadow.querySelector('.panel');
  const toggle = shadow.querySelector('.toggle');
  const form = shadow.querySelector('form');
  const input = shadow.querySelector('.keyword');
  const list = shadow.querySelector('.list');
  const status = shadow.querySelector('.status');
  const pageLabel = shadow.querySelector('.page');
  const prev = shadow.querySelector('.prev');
  const next = shadow.querySelector('.next');

  const state = {
    opened: false,
    loaded: false,
    loading: false,
    mode: 'index',
    keyword: '',
    page: 1,
    items: [],
  };

  toggle.addEventListener('click', () => {
    state.opened = !state.opened;
    panel.hidden = !state.opened;
    if (state.opened && !state.loaded) loadIndex(1).catch((err) => showError(err, log));
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const keyword = input.value.trim();
    if (keyword) loadSearch(keyword, 1).catch((err) => showError(err, log));
    else loadIndex(1).catch((err) => showError(err, log));
  });

  prev.addEventListener('click', () => {
    if (state.page <= 1 || state.loading) return;
    loadPage(state.page - 1).catch((err) => showError(err, log));
  });
  next.addEventListener('click', () => {
    if (state.loading) return;
    loadPage(state.page + 1).catch((err) => showError(err, log));
  });

  async function loadPage(page) {
    if (state.mode === 'search') return loadSearch(state.keyword, page);
    return loadIndex(page);
  }

  async function loadIndex(page) {
    state.loading = true;
    state.mode = 'index';
    state.keyword = '';
    state.page = page;
    renderLoading();
    const json = await sendRuntime('FETCH_SEASON_INDEX', { page, pageSize: PAGE_SIZE });
    assertSuccessfulResponse(json);
    state.items = normalizeItems(json, 'index');
    state.loaded = true;
    state.loading = false;
    render();
  }

  async function loadSearch(keyword, page) {
    state.loading = true;
    state.mode = 'search';
    state.keyword = keyword;
    state.page = page;
    renderLoading();
    const json = await sendRuntime('FETCH_SEASON_INDEX', { keyword, page, pageSize: PAGE_SIZE });
    assertSuccessfulResponse(json);
    state.items = normalizeItems(json, 'search');
    state.loaded = true;
    state.loading = false;
    render();
  }

  function renderLoading() {
    status.textContent = state.mode === 'search' ? `搜索 ${state.keyword}...` : '读取番剧索引...';
    list.innerHTML = '<div class="empty">加载中...</div>';
    updatePager();
  }

  function render() {
    status.textContent = state.mode === 'search'
      ? `搜索：${state.keyword || '-'}`
      : '大陆索引结果';
    list.textContent = '';
    if (!state.items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '没有结果';
      list.appendChild(empty);
      updatePager();
      return;
    }
    for (const item of state.items) {
      list.appendChild(renderItem(item));
    }
    updatePager();
  }

  function renderItem(item) {
    const a = document.createElement('a');
    a.className = 'item';
    a.href = item.url;
    a.target = '_self';
    const img = document.createElement('img');
    img.className = 'cover';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.alt = item.title;
    img.src = item.cover || '';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.title || '未命名';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = item.meta || '';
    a.append(img, name, meta);
    return a;
  }

  function updatePager() {
    pageLabel.textContent = `第 ${state.page} 页`;
    prev.disabled = state.loading || state.page <= 1;
    next.disabled = state.loading || (state.loaded && state.items.length < PAGE_SIZE);
  }

  function showError(err, logger) {
    state.loading = false;
    state.loaded = true;
    status.textContent = String(err?.message || err);
    list.innerHTML = '<div class="empty">加载失败</div>';
    updatePager();
    logger?.warn?.('anime catalog failed', err);
  }
}

function isAnimePage() {
  return location.hostname === 'www.bilibili.com' && /^\/anime(?:\/|$)/.test(location.pathname);
}

function normalizeItems(json, mode) {
  const data = json?.data || json?.result || {};
  const rawList = Array.isArray(data.list) ? data.list
    : Array.isArray(data.result) ? data.result
      : Array.isArray(json?.result?.list) ? json.result.list
        : [];
  return rawList.map((item) => normalizeItem(item, mode)).filter((item) => item.url && item.title);
}

function assertSuccessfulResponse(json) {
  if (!json || typeof json !== 'object') throw new Error('服务端无响应');
  if (Number(json.code) && Number(json.code) !== 0) {
    throw new Error(String(json.message || JSON.stringify(json)).slice(0, 180));
  }
}

function normalizeItem(item, mode) {
  const seasonId = numberLike(item.season_id || item.seasonId || item.season_id_str);
  const epId = numberLike(item.ep_id || item.episode_id || item.episodeId);
  const mediaId = numberLike(item.media_id || item.mediaId);
  const title = cleanText(item.title || item.season_title || item.org_title || item.media_name || item.name);
  const cover = normalizeUrl(item.cover || item.season_cover || item.pic || item.img);
  const indexShow = cleanText(item.index_show || item.indexShow || item.order || item.new_ep?.index_show || item.newest_ep?.index_show);
  const styles = Array.isArray(item.styles) ? item.styles.join(' / ') : cleanText(item.styles || item.style);
  const score = item.score || item.rating?.score || '';
  const meta = [indexShow, score ? `${score}分` : '', styles].filter(Boolean).join(' · ');
  const sourceUrl = normalizeUrl(item.url || item.link || item.arcurl);
  const url = epId
    ? `https://www.bilibili.com/bangumi/play/ep${epId}`
    : seasonId
      ? `https://www.bilibili.com/bangumi/play/ss${seasonId}`
      : mediaId
        ? `https://www.bilibili.com/bangumi/media/md${mediaId}/`
        : sourceUrl;
  return { title, cover, meta: meta || (mode === 'search' ? '搜索结果' : '番剧'), url };
}

function normalizeUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('//')) return 'https:' + text;
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('/')) return 'https://www.bilibili.com' + text;
  return text;
}

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

function numberLike(value) {
  const m = String(value || '').match(/\d+/);
  return m ? Number(m[0]) : 0;
}
