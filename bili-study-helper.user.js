// ==UserScript==
// @name         B站学习进度助手 · 合集/分P剩余统计
// @namespace    https://github.com/yangyuan130130/bili-study-helper
// @version      1.3.0
// @description  按小合集统计剩余待看时长：从实际开始播放的那一集起算，前面被跳过的集自动视为已完成
// @author       WorkBuddy
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/bangumi/play/*
// @icon         https://www.bilibili.com/favicon.ico
// @homepageURL  https://github.com/yangyuan130130/bili-study-helper
// @supportURL   https://github.com/yangyuan130130/bili-study-helper/issues
// @downloadURL  https://cdn.jsdelivr.net/gh/yangyuan130130/bili-study-helper@main/bili-study-helper.user.js
// @updateURL    https://cdn.jsdelivr.net/gh/yangyuan130130/bili-study-helper@main/bili-study-helper.user.js
// @grant        none
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // 0. 配置区（想改行为只动这里）
  // ============================================================
  const CFG = {
    debug: false,          // true 时控制台打印解析细节
    cardWidth: 268,        // 展开态卡片宽度 px
    edge: 20,              // 拖拽贴边留白 px
    tickMs: 1000,          // 进度刷新间隔 ms
    cacheTTL: 60000,       // 同一分集数据缓存时长 ms
    watchThreshold: 0.95,  // 播放进度达到该比例即视为该集「已看完」
    historyPages: 3,       // 拉取观看历史的页数（每页 30 条，登录后可用）
    historyTTL: 300000,    // 观看历史缓存 5 分钟
    // 起点之前（被主动跳过、没播过）的集一律视为已完成，剩余时长从起点开始算。
    // 想严格只看「真正播过的集」可以关掉，此时跳过的集仍会算进待看。
    autoSkipBeforeStart: true,
    startConfirmSec: 3,    // 连续播放超过该秒数，才把当前集确认为本轮起点并落盘
    listMaxHeight: 260,    // 分集列表最大高度 px，超出滚动
  };

  const log = (...a) => { if (CFG.debug) console.log('%c[BiliStudy]', 'color:#00a1d6;font-weight:700', ...a); };
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ============================================================
  // 1. 格式化工具
  // ============================================================
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(num(sec)));
    if (sec < 60) return sec + ' 秒';
    const totalMin = Math.round(sec / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h > 0) return m ? h + ' 小时 ' + m + ' 分钟' : h + ' 小时';
    return m + ' 分钟';
  }

  function fmtMini(sec) {
    sec = Math.max(0, Math.round(num(sec)));
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    if (h > 0) return h + 'h' + (m > 0 ? m + 'm' : '');
    if (m > 0) return m + 'm';
    return sec + 's';
  }

  /** 概览用的小时数：30.7h / 4.2h */
  function fmtHours(sec) {
    const h = num(sec) / 3600;
    if (h <= 0) return '0h';
    if (h >= 10) return Math.round(h) + 'h';
    return (Math.round(h * 10) / 10) + 'h';
  }

  function clockNow() {
    try {
      return new Date().toLocaleTimeString('zh-CN', { hour12: false });
    } catch (e) {
      return new Date().toTimeString().slice(0, 8);
    }
  }

  // ============================================================
  // 2. 页面参数解析
  // ============================================================
  function parseBvid(href) {
    const u = new URL(href);
    const m = u.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/);
    if (m) return m[1];
    const q = u.searchParams.get('bvid');
    if (q && /^BV[0-9A-Za-z]{10}$/.test(q)) return q;
    return '';
  }

  function parseP() {
    const p = num(new URL(location.href).searchParams.get('p'));
    return p > 0 ? Math.floor(p) : 1;
  }

  function parseEpId() {
    const m = location.pathname.match(/\/bangumi\/play\/ep(\d+)/);
    return m ? num(m[1]) : 0;
  }

  // ============================================================
  // 3. 数据来源层
  //    L1 页面内嵌 __INITIAL_STATE__（同步、零请求）
  //    L2 官方 view 接口（SPA 切换后 / 内嵌数据缺失时的兜底）
  // ============================================================
  function pickInitialState() {
    const getters = [
      () => window.__INITIAL_STATE__,
      () => window.__data__,
      () => window.__NUXT__ && window.__NUXT__.state,
    ];
    for (const g of getters) {
      try {
        const v = g();
        if (v && (v.videoData || v.epList || v.playlist || v.ugc_season)) return v;
      } catch (e) { /* 忽略单路失败 */ }
    }
    return null;
  }

  async function fetchView(bvid) {
    const url = 'https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid);
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();
    if (!json || json.code !== 0) {
      throw new Error('接口 code=' + (json && json.code) + ' ' + ((json && json.message) || ''));
    }
    return json.data;
  }

  /**
   * 把 videoData（来自内嵌状态或 view 接口，结构一致）整理成统一上下文。
   *
   * 作用域规则（这是本脚本最核心的判定）：
   *   王道这类教程的结构是「大合集 ugc_season → 多个小合集(每门课=一个BV) → 分集(P)」。
   *   用户关心的是「当前这门课还剩多少」，所以：
   *     A. 当前视频自身多P  → 范围 = 本 BV 的 pages（王道走这条）
   *     B. 当前视频单P      → 范围 = 它所在 section 的 episodes
   *   任何情况下都不跨到同一个大合集下的兄弟小合集。
   *
   * watchKey 决定用哪个字段去匹配观看历史：
   *   pages   → cid（同一 BV 下每个 P 有独立 cid）
   *   section → bvid（每个分集是独立视频）
   */
  function normalizeVideoData(vd, bvid, p) {
    if (!vd) return null;

    const season = vd.ugc_season && Array.isArray(vd.ugc_season.sections) ? vd.ugc_season : null;
    const seasonTitle = season ? String(season.title || '') : '';
    const multiSection = !!(season && season.sections.length > 1);

    // 定位当前视频落在哪个小合集里
    let hostSection = null;
    let hostSectionIdx = -1;
    let hostSectionPos = -1;
    if (season) {
      for (let si = 0; si < season.sections.length; si++) {
        const sec = season.sections[si];
        const eps = sec.episodes || [];
        const i = eps.findIndex((e) => e && e.bvid === bvid);
        if (i >= 0) { hostSection = sec; hostSectionIdx = i; hostSectionPos = si; break; }
      }
    }

    const pages = Array.isArray(vd.pages) ? vd.pages : [];

    // --- A. 当前视频自身多P：统计范围限定在本 BV 的分P ---
    if (pages.length > 1) {
      const episodes = pages.map((pg, i) => ({
        title: String(pg.part || ('P' + (pg.page || i + 1))),
        duration: num(pg.duration),
        cid: num(pg.cid),
        page: num(pg.page) || i + 1,
      }));
      let idx = episodes.findIndex((e) => e.page === p);
      if (idx < 0) idx = clamp(p - 1, 0, episodes.length - 1);
      return {
        scope: 'pages',
        kind: 'pages',
        title: String(vd.title || '分P视频'),
        groupTitle: seasonTitle,
        episodes: episodes,
        currentIndex: idx,
        watchKey: 'cid',
        localId: 'p:' + (vd.bvid || bvid),
      };
    }

    // --- B. 单P视频，但属于某个小合集：统计范围限定在该小合集 ---
    if (hostSection && (hostSection.episodes || []).length > 1) {
      const episodes = hostSection.episodes.map((ep, i) => ({
        title: String(ep.title || ('第 ' + (i + 1) + ' 集')),
        // 时长单位：秒。缺字段记 0，后续标记为「未知」而不是瞎猜
        duration: num(ep.arc ? ep.arc.duration : ep.duration),
        bvid: ep.bvid || '',
        cid: num(ep.cid),
      }));
      let title = seasonTitle || String(vd.title || '合集');
      if (multiSection && hostSection.title) title = seasonTitle + ' · ' + hostSection.title;
      return {
        scope: 'section',
        kind: 'season',
        title: title,
        groupTitle: seasonTitle,
        episodes: episodes,
        currentIndex: hostSectionIdx,
        watchKey: 'bvid',
        // 用章节自身 id 做键，否则不同章节的本地记录会串台
        localId: 's:' + (season.id || seasonTitle) + ':' + (hostSection.id || hostSectionPos),
      };
    }

    return null;
  }

  /** 番剧：epList 里 duration 是毫秒，需要换算 */
  function normalizeBangumi(IS, epId) {
    const list = Array.isArray(IS.epList) ? IS.epList : [];
    if (list.length < 2) return null;
    const episodes = list.map((ep, i) => {
      const raw = num(ep.duration);
      // 单集番剧正常在 20~30 分钟；>10000 说明给的是毫秒
      const seconds = raw > 10000 ? Math.round(raw / 1000) : raw;
      return {
        title: String(ep.long_title || ep.title || ('第 ' + (i + 1) + ' 话')),
        duration: seconds,
        epId: num(ep.id),
      };
    });
    const idx = list.findIndex((ep) => num(ep.id) === epId);
    if (idx < 0) return null;
    let seasonTitle = '番剧';
    try {
      if (IS.mediaInfo && IS.mediaInfo.title) seasonTitle = IS.mediaInfo.title;
      else if (IS.h1Title) seasonTitle = IS.h1Title;
    } catch (e) { /* 忽略 */ }
    return {
      scope: 'bangumi',
      kind: 'bangumi',
      title: String(seasonTitle),
      episodes: episodes,
      currentIndex: idx,
      watchKey: 'epid',
      localId: 'e:' + (IS.mediaInfo && IS.mediaInfo.season_id ? IS.mediaInfo.season_id : seasonTitle),
    };
  }

  // ============================================================
  // 4. 观看状态层：判定「起点」与「已完成」
  //    A. 起点：本小合集里最早有播放证据的那一集（历史 / 播放观测 / 已存记录）。
  //       起点之前的集 = 用户跳过的集，一律视为已完成，不进待看。
  //    B. 已完成：起点及之后，播到阈值的集（历史 / 播放观测）。
  //    两者都不含手动标记，全部由播放行为自动推断。
  // ============================================================
  function episodeKey(ctx, ep) {
    if (!ctx || !ep) return '';
    if (ctx.watchKey === 'cid') return ep.cid ? 'c' + ep.cid : '';
    if (ctx.watchKey === 'bvid') return ep.bvid ? 'b' + ep.bvid : '';
    if (ctx.watchKey === 'epid') return ep.epId ? 'e' + ep.epId : '';
    return '';
  }

  async function fetchHistory(maxPages) {
    const items = [];
    let cursor = null;
    for (let i = 0; i < maxPages; i++) {
      const q = new URLSearchParams();
      q.set('max', cursor ? String(cursor.max) : '0');
      q.set('view_at', cursor ? String(cursor.view_at) : '0');
      q.set('business', '');
      q.set('ps', '30');
      const resp = await fetch('https://api.bilibili.com/x/web-interface/history/cursor?' + q.toString(), {
        credentials: 'include',
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const json = await resp.json();
      if (!json || json.code !== 0) throw new Error('历史接口 code=' + (json && json.code));
      const list = (json.data && json.data.list) || [];
      if (!list.length) break;
      items.push.apply(items, list);
      const c = json.data && json.data.cursor;
      if (!c) break;
      if (cursor && c.max === cursor.max && c.view_at === cursor.view_at) break;
      cursor = c;
    }
    return items;
  }

  let historyCache = { at: 0, items: [] };

  async function fetchHistoryCached(maxPages) {
    if (historyCache.items.length && Date.now() - historyCache.at < CFG.historyTTL) {
      return { items: historyCache.items, fromCache: true };
    }
    const items = await fetchHistory(maxPages);
    historyCache = { at: Date.now(), items: items };
    return { items: items, fromCache: false };
  }

  /**
   * 从历史记录里读出两样东西：
   *   done   —— 播到阈值、算「已完成」的集 key
   *   played —— 有播放痕迹（进度 > 0）的集下标，用来推断「从哪一集开始学」
   */
  function buildHistoryState(items, ctx) {
    // 集 key → 声明时长，既当白名单又当分母
    const durMap = new Map();
    const idxMap = new Map();
    (ctx.episodes || []).forEach((e, i) => {
      const k = episodeKey(ctx, e);
      if (k) { durMap.set(k, num(e.duration)); idxMap.set(k, i); }
    });

    const done = new Set();
    const played = new Set();

    for (const it of items) {
      if (!it) continue;
      const h = it.history;
      if (!h) continue;

      let key = '';
      if (ctx.watchKey === 'cid' && h.cid) key = 'c' + num(h.cid);
      else if (ctx.watchKey === 'bvid' && h.bvid) key = 'b' + h.bvid;
      else if (ctx.watchKey === 'epid') {
        const eid = num(h.epid) || num(it.epid);
        if (eid) key = 'e' + eid;
      }
      if (!key) continue;
      if (!durMap.has(key)) continue;          // 不在当前小合集内，不参与统计

      const prog = num(it.progress);
      if (prog > 0) played.add(idxMap.get(key));

      // 分母优先用列表声明时长：多P场景下历史接口的 duration 可能是整稿时长
      const declared = durMap.get(key) || 0;
      const base = declared > 0 ? declared : num(it.duration);
      if (!(base > 0)) continue;
      if (prog / base < CFG.watchThreshold) continue;
      done.add(key);
    }
    return { done: done, played: played };
  }

  // 两套持久化：done（观测到播完的集）、start（本轮学习的起点下标）
  const DONE_PREFIX = 'bsh:done:';

  function readSet(prefix, localId) {
    const out = new Set();
    try {
      const raw = localStorage.getItem(prefix + localId);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) arr.forEach((k) => out.add(k));
      }
    } catch (e) { /* 隐私模式忽略 */ }
    return out;
  }

  function writeSet(prefix, localId, set) {
    try {
      localStorage.setItem(prefix + localId, JSON.stringify(Array.from(set)));
    } catch (e) { /* 忽略 */ }
  }

  function readLocalDone(ctx) {
    return readSet(DONE_PREFIX, ctx.localId);
  }

  function writeLocalDone(ctx, key) {
    const cur = readLocalDone(ctx);
    cur.add(key);
    writeSet(DONE_PREFIX, ctx.localId, cur);
  }

  // --- 起点持久化：只存一个下标，代表「这一轮从第几集开始学」 ---
  const START_PREFIX = 'bsh:start:';

  function readStart(ctx) {
    try {
      const raw = localStorage.getItem(START_PREFIX + ctx.localId);
      if (raw === null) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    } catch (e) { return null; }
  }

  function writeStart(ctx, idx) {
    try {
      localStorage.setItem(START_PREFIX + ctx.localId, String(Math.max(0, Math.round(num(idx)))));
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 推断起点下标（0 基）。
   *   已有落盘起点 → 直接用它。起点只认「本轮第一次真正开始播放的位置」，
   *                 之后回看更靠前的集不会把起点拉回去，跳过的集不会被重新算成待看。
   *   还没落盘     → 取「最早有播放证据的集」与「当前页」中更靠前的那个。
   * 返回 { start, settled }；settled 为 true 表示有真实播放证据、可以落盘。
   */
  function resolveStartIndex(ctx, played, stored) {
    const n = (ctx.episodes || []).length;
    const cur = clamp(num(ctx.currentIndex), 0, n - 1);
    if (stored !== null && Number.isFinite(stored)) {
      return { start: clamp(stored, 0, n - 1), settled: true };
    }
    let start = cur;
    let settled = false;
    if (played && played.size) {
      played.forEach((i) => {
        if (Number.isFinite(i)) { start = Math.min(start, i); settled = true; }
      });
    }
    return { start: clamp(start, 0, n - 1), settled: settled };
  }

  const cache = new Map();

  function remember(key, value) {
    cache.set(key, { at: Date.now(), value: value });
    if (cache.size > 40) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
    return value;
  }

  async function resolveContext() {
    const href = location.href;

    // --- 番剧分支 ---
    const epId = parseEpId();
    if (epId) {
      const IS = pickInitialState();
      const ctx = IS ? normalizeBangumi(IS, epId) : null;
      if (ctx) return { ok: true, ctx: ctx, source: 'state' };
      return { ok: false, code: 'no-chapters', reason: '未读取到番剧分集列表' };
    }

    // --- 普通视频分支 ---
    const bvid = parseBvid(href);
    if (!bvid) return { ok: false, code: 'not-video', reason: '未识别到 BV 号，当前页面不是视频页' };

    const p = parseP();
    const key = bvid + '#p' + p;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CFG.cacheTTL) return hit.value;

    // L1：内嵌状态。必须校验 bvid，因为 SPA 切换后内嵌状态不会更新
    const IS = pickInitialState();
    if (IS && IS.videoData && IS.videoData.bvid === bvid) {
      const ctx = normalizeVideoData(IS.videoData, bvid, p);
      if (ctx) {
        log('命中 L1 内嵌状态', ctx.kind, ctx.episodes.length);
        return remember(key, { ok: true, ctx: ctx, source: 'state' });
      }
      return remember(key, { ok: false, code: 'no-chapters', reason: '当前视频没有分集或所属合集' });
    }

    // L2：官方接口兜底
    try {
      const data = await fetchView(bvid);
      const ctx = normalizeVideoData(data, bvid, p);
      if (ctx) {
        log('命中 L2 接口', ctx.kind, ctx.episodes.length);
        return remember(key, { ok: true, ctx: ctx, source: 'api' });
      }
      return remember(key, { ok: false, code: 'no-chapters', reason: '当前视频没有分集或所属合集' });
    } catch (err) {
      return { ok: false, code: 'fetch-failed', reason: '数据获取失败：' + ((err && err.message) || err) };
    }
  }

  // ============================================================
  // 5. 统计：起点之前一律算已完成；起点及之后只算「没看完的」
  // ============================================================
  function computeStats(ctx, video, watched, startIdx) {
    const eps = ctx.episodes || [];
    const n = eps.length;
    if (!n) return null;
    const k = clamp(num(ctx.currentIndex), 0, n - 1);
    const W = watched instanceof Set ? watched : new Set();
    const S = clamp(num(startIdx), 0, n - 1);

    // 当前集优先用播放器实测时长（比列表声明值更准）
    let curDur = num(eps[k] ? eps[k].duration : 0);
    if (video) {
      const vd = video.duration;
      if (Number.isFinite(vd) && vd > 0.5) curDur = vd;
    }

    const curKey = episodeKey(ctx, eps[k]);
    // 当前的集在起点之前（回看已跳过的集）：按「已完成」处理，不参与待看
    const beforeStart = CFG.autoSkipBeforeStart && k < S;
    const curWatched = beforeStart || !!(curKey && W.has(curKey));

    let curPos = 0;
    if (video) {
      const vt = video.currentTime;
      if (Number.isFinite(vt) && vt > 0) curPos = vt;
      if (curDur > 0) curPos = Math.min(curPos, curDur);
    }

    let total = 0;        // 本小合集总时长
    let watchedTime = 0;  // 已完成（含起点前跳过）的集时长合计
    let todoTime = 0;     // 待看集时长合计（含当前集，前提是当前集没完成）
    let watchedCount = 0;
    let todoCount = 0;
    let unknown = 0;      // 时长缺失的集数
    let skippedCount = 0; // 起点之前、靠「跳过」推断为已完成
    const todoIdx = [];   // 待看集下标（供列表展示）

    for (let i = 0; i < n; i++) {
      const isCur = i === k;
      const d = isCur ? curDur : num(eps[i].duration);
      const skip = CFG.autoSkipBeforeStart && i < S;
      if (skip) skippedCount++;
      if (!(d > 0)) { unknown++; continue; }
      total += d;

      // 当前集：已完成算已完成，否则算待看，它的已播进度稍后单独扣减
      const isWatched = isCur ? curWatched : (skip || W.has(episodeKey(ctx, eps[i])));
      if (isWatched) { watchedTime += d; watchedCount++; }
      else { todoTime += d; todoCount++; todoIdx.push(i); }
    }

    // 当前集没完成时，已播的那部分要从待看总时长里扣掉
    const remain = Math.max(0, todoTime - (curWatched ? 0 : curPos));
    const doneForPct = watchedTime + (curWatched ? 0 : curPos);
    const pct = total > 0 ? clamp((doneForPct / total) * 100, 0, 100) : 0;

    return {
      n: n,
      k: k,
      start: S,
      curIndex1: k + 1,
      total: total,
      watchedTime: watchedTime,
      todoTime: todoTime,
      watchedCount: watchedCount,
      todoCount: todoCount,
      todoIdx: todoIdx,
      skippedCount: skippedCount,
      remain: remain,
      pct: pct,
      unknown: unknown,
      curWatched: curWatched,
      curPos: curPos,
      curDur: curDur,
    };
  }

  // ============================================================
  // 6. 面板 UI（Shadow DOM 隔离，避免被 B 站样式污染）
  // ============================================================
  const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

.card {
  --bg: rgba(24, 26, 33, .93);
  --fg: #e9ecf2;
  --muted: #949bab;
  --line: rgba(255, 255, 255, .10);
  --track: rgba(255, 255, 255, .13);
  --accent: #fb7299;
  --shadow: 0 12px 34px rgba(0, 0, 0, .48);
  width: 268px;
  border-radius: 12px;
  background: var(--bg);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
  backdrop-filter: blur(14px) saturate(150%);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
  font-size: 13px;
  line-height: 1.5;
  overflow: hidden;
  user-select: none;
  transition: width .18s ease;
}
.card.light {
  --bg: rgba(255, 255, 255, .96);
  --fg: #18191c;
  --muted: #6b7280;
  --line: rgba(0, 0, 0, .08);
  --track: rgba(0, 0, 0, .08);
  --shadow: 0 10px 30px rgba(0, 0, 0, .14);
}

.head {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 8px 8px 12px;
  cursor: move;
}
.title {
  flex: 1; min-width: 0;
  font-size: 12px; font-weight: 600;
  color: var(--muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.acts { display: flex; gap: 2px; flex: none; }
.btn {
  display: flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; padding: 0;
  border: 0; border-radius: 5px;
  background: transparent; color: var(--muted);
  font: inherit; font-size: 12px; line-height: 1;
  cursor: pointer;
  transition: background .12s, color .12s;
}
.btn:hover { background: var(--track); color: var(--fg); }

.body { padding: 0 12px 10px; }
.cap { font-size: 11px; color: var(--muted); letter-spacing: .5px; }
.big {
  margin-top: 1px;
  font-size: 22px; font-weight: 700;
  letter-spacing: -.3px;
  font-variant-numeric: tabular-nums;
}
.sub { margin-top: 2px; font-size: 12px; color: var(--muted); }

.bar {
  margin: 9px 0 7px;
  height: 6px; border-radius: 3px;
  background: var(--track);
  overflow: hidden;
}
.bar > i {
  display: block; height: 100%; width: 0;
  border-radius: 3px;
  background: linear-gradient(90deg, #ff9db5, var(--accent));
  transition: width .35s ease;
}

.row { font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; }

.mini { display: none; padding: 0 12px 9px; font-size: 13px; font-weight: 600; }

.foot {
  padding: 6px 12px;
  border-top: 1px solid var(--line);
  font-size: 10.5px; color: var(--muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.card[data-state="loading"] .big { color: var(--muted); font-size: 18px; letter-spacing: 2px; }
.card[data-state="error"] .big { font-size: 15px; color: #ff7f7f; }
.card[data-state="error"] .bar { display: none; }
.card[data-state="error"] .sub { color: var(--fg); opacity: .78; }

.card.folded { width: auto; }
.card.folded .body, .card.folded .foot, .card.folded .listbar, .card.folded .list { display: none; }
.card.folded .mini { display: block; }
.card.folded .title { max-width: 110px; }
.card.folded .head { padding-bottom: 4px; }

.card.wide { width: 320px; }

.listbar {
  display: flex; align-items: center; gap: 6px;
  padding: 7px 12px;
  border-top: 1px solid var(--line);
  cursor: pointer;
  font-size: 12px;
}
.listbar:hover { background: var(--track); }
.listbar .lab { font-weight: 500; }
.listbar .hint { flex: 1; text-align: right; font-size: 10.5px; color: var(--muted); }
.listbar .chev { flex: none; color: var(--muted); transition: transform .15s; display: inline-block; }
.card.open .listbar .chev { transform: rotate(90deg); }

.list {
  display: none;
  max-height: var(--listh, 260px);
  overflow-y: auto;
  border-top: 1px solid var(--line);
  overscroll-behavior: contain;
}
.card.open .list { display: block; }
.list::-webkit-scrollbar { width: 6px; }
.list::-webkit-scrollbar-thumb { background: var(--track); border-radius: 3px; }

.li {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px;
  font-size: 12px;
}
.li .idx { flex: none; width: 26px; color: var(--muted); font-variant-numeric: tabular-nums; }
.li .tt { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.li .du { flex: none; font-size: 10.5px; color: var(--muted); font-variant-numeric: tabular-nums; }

.li.is-cur { background: var(--track); }
.li.is-cur .idx { color: var(--accent); font-weight: 500; }
.li.is-cur .tt { font-weight: 500; }

.list-empty {
  padding: 10px 12px;
  font-size: 11.5px; color: var(--muted);
}
`;

  const HTML = `
<div class="card" data-state="loading">
  <div class="head" data-drag>
    <span class="title">学习进度</span>
    <div class="acts">
      <button class="btn" data-act="reload" title="重新读取">&#8635;</button>
      <button class="btn" data-act="fold" title="折叠 / 展开">&#8722;</button>
    </div>
  </div>
  <div class="body">
    <div class="cap" title="双击数字可把当前集设为起点">还要学</div>
    <div class="big">&#183;&#183;&#183;</div>
    <div class="sub">正在读取</div>
    <div class="bar"><i></i></div>
    <div class="row"></div>
  </div>
  <div class="listbar" data-act="list">
    <span class="lab">待看列表</span>
    <span class="hint"></span>
    <span class="chev">&#8250;</span>
  </div>
  <div class="list"></div>
  <div class="mini"></div>
  <div class="foot"></div>
</div>
`;

  const POS_KEY = 'bsh:pos:v1';
  const FOLD_KEY = 'bsh:fold:v1';

  const UI = (function () {
    let host = null;
    let shadow = null;
    let card = null;
    let folded = false;
    const refs = {};
    let onRetry = null;
    let onReset = null;

    // 分集列表状态（只读展示待看集，不提供任何手动标记）
    let listOpen = false;
    let listRows = [];
    let listSig = '';
    let lastCurIdx = -1;

    function setText(el, v) {
      if (!el) return;
      if (el.__bsh === v) return;
      el.__bsh = v;
      el.textContent = v;
    }

    function isDarkPage() {
      const de = document.documentElement;
      const b = document.body;
      return de.classList.contains('bili-dark')
        || de.classList.contains('dark')
        || de.getAttribute('data-theme') === 'dark'
        || (b && b.classList.contains('bili-dark'));
    }

    function applyTheme() {
      if (!card) return;
      card.classList.toggle('light', !isDarkPage());
    }

    function savePos() {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({
          x: parseFloat(host.style.left) || 0,
          y: parseFloat(host.style.top) || 0,
        }));
      } catch (e) { /* 隐私模式忽略 */ }
    }

    function setPos(x, y) {
      const w = host.offsetWidth || CFG.cardWidth;
      const h = host.offsetHeight || 120;
      x = clamp(x, CFG.edge, Math.max(CFG.edge, window.innerWidth - w - CFG.edge));
      y = clamp(y, CFG.edge, Math.max(CFG.edge, window.innerHeight - h - CFG.edge));
      host.style.left = x + 'px';
      host.style.top = y + 'px';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    }

    function toggleFold() {
      folded = !folded;
      card.classList.toggle('folded', folded);
      shadow.querySelector('[data-act="fold"]').innerHTML = folded ? '&#43;' : '&#8722;';
      try { localStorage.setItem(FOLD_KEY, folded ? '1' : '0'); } catch (e) { /* 忽略 */ }
    }

    function toggleList() {
      listOpen = !listOpen;
      card.classList.toggle('open', listOpen);
      card.classList.toggle('wide', listOpen);
      if (listOpen) {
        lastCurIdx = -1;          // 展开时重新定位到当前集
        scrollToCurrent();
      }
      // 宽度过渡结束后再夹一次位置，避免贴边时超出屏幕
      setTimeout(() => {
        if (host && host.style.left) {
          setPos(parseFloat(host.style.left) || 0, parseFloat(host.style.top) || 0);
        }
      }, 220);
    }

    function scrollToCurrent() {
      if (!listOpen || !refs.list) return;
      const el = refs.list.querySelector('.li.is-cur');
      if (!el) return;
      const top = el.offsetTop - refs.list.clientHeight / 2 + el.offsetHeight / 2;
      refs.list.scrollTop = Math.max(0, top);
    }

    /** 列表只列「待看」的集；集合或当前集变化时才重建，其余时间不动 DOM */
    function setList(targetCtx, todoIdx, curIdx) {
      if (!refs.list || !targetCtx) return;
      const idxs = Array.isArray(todoIdx) ? todoIdx : [];
      const cur = num(curIdx);
      const sig = String(targetCtx.localId || '') + '|' + cur + '|' + idxs.join(',');

      if (sig !== listSig) {
        listSig = sig;
        const prevScroll = refs.list.scrollTop;
        refs.list.textContent = '';
        listRows = [];

        if (!idxs.length) {
          const em = document.createElement('div');
          em.className = 'list-empty';
          em.textContent = '本小合集已全部完成';
          refs.list.appendChild(em);
        } else {
          const frag = document.createDocumentFragment();
          idxs.forEach((i) => {
            const ep = targetCtx.episodes[i];
            if (!ep) return;
            const row = document.createElement('div');
            row.className = 'li' + (i === cur ? ' is-cur' : '');
            row.dataset.i = String(i);

            const idx = document.createElement('span');
            idx.className = 'idx';
            idx.textContent = String(i + 1);

            const tt = document.createElement('span');
            tt.className = 'tt';
            tt.textContent = ep.title || ('第 ' + (i + 1) + ' 集');
            tt.title = tt.textContent + (ep.duration > 0 ? ' · ' + fmtDur(ep.duration) : '');

            const du = document.createElement('span');
            du.className = 'du';
            du.textContent = ep.duration > 0 ? fmtMini(ep.duration) : '--';

            row.appendChild(idx);
            row.appendChild(tt);
            row.appendChild(du);
            frag.appendChild(row);
            listRows.push(row);
          });
          refs.list.appendChild(frag);
        }
        refs.list.scrollTop = prevScroll;
      }

      if (cur !== lastCurIdx) {
        lastCurIdx = cur;
        if (listOpen) scrollToCurrent();
      }
    }

    function enableDrag() {
      const head = shadow.querySelector('[data-drag]');
      let dragging = false;
      let sx = 0, sy = 0, ox = 0, oy = 0;

      head.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('[data-act]')) return;
        const r = host.getBoundingClientRect();
        ox = r.left; oy = r.top;
        sx = e.clientX; sy = e.clientY;
        host.style.left = ox + 'px';
        host.style.top = oy + 'px';
        host.style.right = 'auto';
        host.style.bottom = 'auto';
        dragging = true;
        try { head.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
        e.preventDefault();
      });

      head.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        setPos(ox + e.clientX - sx, oy + e.clientY - sy);
      });

      const end = (e) => {
        if (!dragging) return;
        dragging = false;
        try { head.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
        savePos();
      };
      head.addEventListener('pointerup', end);
      head.addEventListener('pointercancel', end);

      window.addEventListener('resize', () => {
        if (host.style.left) {
          setPos(parseFloat(host.style.left) || 0, parseFloat(host.style.top) || 0);
        }
      });
    }

    function mount(retryFn) {
      if (host) return;
      onRetry = retryFn;

      host = document.createElement('div');
      host.id = 'bsh-host';
      host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;';
      shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<style>' + CSS + '</style>' + HTML;
      (document.body || document.documentElement).appendChild(host);

      card = shadow.querySelector('.card');
      refs.title = shadow.querySelector('.title');
      refs.big = shadow.querySelector('.big');
      refs.sub = shadow.querySelector('.sub');
      refs.row = shadow.querySelector('.row');
      refs.mini = shadow.querySelector('.mini');
      refs.foot = shadow.querySelector('.foot');
      refs.fill = shadow.querySelector('.bar > i');
      refs.list = shadow.querySelector('.list');
      refs.hint = shadow.querySelector('.listbar .hint');
      card.style.setProperty('--listh', CFG.listMaxHeight + 'px');

      // 初始位置：优先恢复记忆位置
      let restored = false;
      try {
        const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
          setPos(saved.x, saved.y);
          restored = true;
        }
      } catch (e) { /* 忽略 */ }
      if (!restored) {
        host.style.right = CFG.edge + 'px';
        host.style.bottom = '120px';
      }

      try {
        if (localStorage.getItem(FOLD_KEY) === '1') toggleFold();
      } catch (e) { /* 忽略 */ }

      shadow.addEventListener('click', (e) => {
        // 分集条目只做展示，点击不产生任何标记
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'fold') toggleFold();
        else if (act === 'reload') { show(); if (typeof onRetry === 'function') onRetry(); }
        else if (act === 'list') toggleList();
      });

      // 双击大号数字：把当前集重设为起点（起点推断错了时的兜底，不是逐集标记）
      const body = shadow.querySelector('.body');
      if (body) {
        body.addEventListener('dblclick', () => {
          if (typeof onReset === 'function') onReset();
        });
      }

      enableDrag();
      applyTheme();
      // 主题类名可能在页面加载后才挂上，低频复查
      setInterval(applyTheme, 2000);
    }

    function show() { if (host) host.style.display = ''; }
    function hide() { if (host) host.style.display = 'none'; }

    function setLoading(msg) {
      card.dataset.state = 'loading';
      setText(refs.big, '\u00b7\u00b7\u00b7');
      setText(refs.sub, msg || '正在读取分集数据');
      setText(refs.row, '');
      setText(refs.mini, '读取中');
      refs.fill.style.width = '0%';
    }

    function setError(msg) {
      card.dataset.state = 'error';
      setText(refs.big, '读取失败');
      setText(refs.sub, msg || '未知原因');
      setText(refs.row, '');
      setText(refs.mini, '读取失败');
      refs.fill.style.width = '0%';
    }

    function render(st, ctx, source, at, watchMeta) {
      if (!st) return;
      card.dataset.state = 'ok';
      setText(refs.title, ctx.title || '学习进度');
      refs.title.title = ctx.groupTitle && ctx.groupTitle !== ctx.title
        ? ctx.title + '（大合集：' + ctx.groupTitle + '）'
        : (ctx.title || '');

      setText(refs.big, st.remain <= 0 ? '已学完' : fmtDur(st.remain));

      if (st.todoCount <= 0) {
        setText(refs.sub, '共 ' + st.n + ' 集 · 已全部完成');
      } else if (st.skippedCount > 0) {
        setText(refs.sub, '待看 ' + st.todoCount + ' 集 · 前 ' + st.skippedCount + ' 集自动跳过');
      } else {
        setText(refs.sub, '待看 ' + st.todoCount + ' 集 · 已完成 ' + st.watchedCount + ' / 共 ' + st.n + ' 集');
      }
      refs.fill.style.width = st.pct.toFixed(1) + '%';

      let row = '共 ' + fmtHours(st.total) + ' · 完成 ' + fmtHours(st.watchedTime);
      if (st.unknown > 0) row += ' · ' + st.unknown + ' 集时长未知';
      setText(refs.row, row);

      setText(refs.mini, '待看 ' + st.todoCount + ' 集 \u00b7 ' + fmtMini(st.remain));
      if (refs.hint) setText(refs.hint, st.todoCount > 0 ? '剩 ' + st.todoCount + ' 集' : '已全部完成');

      let basis;
      if (watchMeta && watchMeta.source === 'history') basis = '观看历史';
      else if (watchMeta && watchMeta.source === 'local') basis = '播放记录';
      else basis = '推断';
      const startTxt = watchMeta && watchMeta.startIdx !== undefined
        ? '第 ' + (num(watchMeta.startIdx) + 1) + ' 集起 · '
        : '';
      setText(refs.foot, '依据：' + basis + ' · ' + startTxt + at);
    }

    return {
      mount: mount,
      show: show,
      hide: hide,
      setLoading: setLoading,
      setError: setError,
      render: render,
      setList: setList,
      setResetHandler: function (fn) { onReset = fn; },
    };
  })();

  // ============================================================
  // 7. 主流程
  // ============================================================
  let seq = 0;
  let ctx = null;
  let source = '';
  let videoEl = null;
  let timer = null;
  let lastKey = '';
  let loadedAt = '';
  // doneSet   起点及之后、判定为「已完成」的集（观看历史 + 播放观测，没有任何手动标记）
  // playedIdx 有播放痕迹的集下标，用来推断起点
  // startIdx  起点下标：它之前的集一律按「主动跳过 = 已完成」处理
  let doneSet = new Set();
  let playedIdx = new Set();
  let startIdx = 0;
  let startSettled = false;   // 起点是否已被真实播放确认并落盘
  let playedSinceNav = false; // 本次切集后播放器是否真的开始播过（防止用上一集的进度误判）
  let watchedMeta = { count: 0, source: 'none', startIdx: 0 };

  function getVideo() {
    if (videoEl && videoEl.isConnected) return videoEl;
    videoEl = document.querySelector('.bpx-player-video-wrap video')
      || document.querySelector('#bilibili-player video')
      || document.querySelector('video');
    // 播放器可能被复用，绑定一次即可；每次切集都会重置 playedSinceNav
    if (videoEl && !videoEl.__bshBound) {
      videoEl.__bshBound = true;
      videoEl.addEventListener('playing', () => { playedSinceNav = true; });
    }
    return videoEl;
  }

  /** 依据「已落盘起点 → 播放证据 → 当前页」重新确定起点 */
  function applyStart(targetCtx) {
    const stored = readStart(targetCtx);
    const r = resolveStartIndex(targetCtx, playedIdx, stored);
    startIdx = r.start;
    startSettled = r.settled;
    watchedMeta.startIdx = startIdx;
    if (r.settled && stored === null) writeStart(targetCtx, startIdx);
    log('起点第', startIdx + 1, '集', r.settled ? '（已确认）' : '（按当前页推算）');
  }

  function refresh(targetCtx, video) {
    const st = computeStats(targetCtx, video, doneSet, startIdx);
    if (!st) return null;
    UI.render(st, targetCtx, source, loadedAt, watchedMeta);
    UI.setList(targetCtx, st.todoIdx, st.k);
    return st;
  }

  async function loadWatched(targetCtx, my) {
    doneSet = readLocalDone(targetCtx);
    playedIdx = new Set();
    (targetCtx.episodes || []).forEach((ep, i) => {
      if (doneSet.has(episodeKey(targetCtx, ep))) playedIdx.add(i);
    });
    let basis = doneSet.size ? 'local' : 'none';
    try {
      const res = await fetchHistoryCached(CFG.historyPages);
      const hs = buildHistoryState(res.items, targetCtx);
      hs.done.forEach((k) => doneSet.add(k));
      hs.played.forEach((i) => playedIdx.add(i));
      basis = 'history';
      log('观看历史', res.items.length, '条 · 已完成', hs.done.size, '集 · 有播放痕迹', hs.played.size, '集');
    } catch (e) {
      log('观看历史不可用：', (e && e.message) || e);
      basis = doneSet.size ? 'local' : 'none';
    }
    if (my !== seq) return;   // 期间又切了页面，丢弃旧结果
    applyStart(targetCtx);
    watchedMeta = { count: doneSet.size, source: basis, startIdx: startIdx };
  }

  function tick() {
    if (!ctx) return;
    const v = getVideo();
    const st = refresh(ctx, v);
    if (!st) return;

    // 观察到真实播放：把起点定在当前这次学习开始的位置并落盘。
    // 落盘后起点不再回退 —— 之后回看前面的集，已跳过的集不会被算回待看。
    if (!startSettled) {
      const t = v ? num(v.currentTime) : 0;
      if (playedSinceNav && t >= CFG.startConfirmSec) {
        startSettled = true;
        writeStart(ctx, startIdx);
        log('起点已确认：第', startIdx + 1, '集');
        refresh(ctx, v);
        return;
      }
    }

    // 当前集播到阈值：记为完成，并立刻从待看里剔除
    if (!st.curWatched && st.curDur > 0 && st.curPos / st.curDur >= CFG.watchThreshold) {
      const key = episodeKey(ctx, ctx.episodes[st.k]);
      if (key && !doneSet.has(key)) {
        doneSet.add(key);
        playedIdx.add(st.k);
        writeLocalDone(ctx, key);
        watchedMeta = {
          count: doneSet.size,
          source: watchedMeta.source === 'none' ? 'local' : watchedMeta.source,
          startIdx: startIdx,
        };
        refresh(ctx, getVideo());
      }
    }
  }

  function startTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(tick, CFG.tickMs);
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  async function sync(force) {
    const urlKey = location.pathname + location.search;
    if (!force && urlKey === lastKey && ctx) return;
    lastKey = urlKey;

    const my = ++seq;
    UI.show();
    UI.setLoading('正在读取分集数据');

    let res;
    try {
      res = await resolveContext();
    } catch (e) {
      res = { ok: false, code: 'fetch-failed', reason: String((e && e.message) || e) };
    }
    if (my !== seq) return;   // 期间又切了页面，丢弃旧结果

    if (!res.ok) {
      ctx = null;
      stopTimer();
      if (res.code === 'no-chapters' || res.code === 'not-video') {
        UI.hide();            // 单集视频 / 非视频页：不打扰
      } else {
        UI.setError(res.reason);
      }
      log('未命中', res);
      return;
    }

    ctx = res.ctx;
    source = res.source;
    videoEl = null;
    playedSinceNav = false;
    loadedAt = clockNow();

    // 先用本地记录顶一下，避免历史接口返回前面板显示「全部未看」的假数字
    doneSet = readLocalDone(ctx);
    playedIdx = new Set();
    ctx.episodes.forEach((ep, i) => { if (doneSet.has(episodeKey(ctx, ep))) playedIdx.add(i); });
    applyStart(ctx);
    watchedMeta = { count: doneSet.size, source: doneSet.size ? 'local' : 'none', startIdx: startIdx };
    tick();
    startTimer();

    loadWatched(ctx, my).then(() => { if (my === seq) tick(); });
    log('就绪', ctx);
  }

  function watchRoute() {
    let debounce = null;
    const fire = () => {
      if (debounce) clearTimeout(debounce);
      // 留一点时间让新页面的数据/播放器就绪
      debounce = setTimeout(() => sync(false), 450);
    };

    const wrap = (name) => {
      const orig = history[name];
      if (typeof orig !== 'function') return;
      history[name] = function () {
        const ret = orig.apply(this, arguments);
        fire();
        return ret;
      };
    };
    wrap('pushState');
    wrap('replaceState');

    window.addEventListener('popstate', fire);

    // 兜底：部分跳转不走 history API
    let prev = location.href;
    setInterval(() => {
      if (location.href !== prev) {
        prev = location.href;
        fire();
      }
    }, 1200);
  }

  /** 把当前集重设为起点（起点推断偏了时的兜底） */
  function resetStartToCurrent() {
    if (!ctx) return;
    const i = clamp(num(ctx.currentIndex), 0, ctx.episodes.length - 1);
    startIdx = i;
    startSettled = true;
    writeStart(ctx, i);
    watchedMeta = { count: doneSet.size, source: watchedMeta.source, startIdx: i };
    log('重设起点：第', i + 1, '集');
    refresh(ctx, getVideo());
  }

  function main() {
    UI.mount(() => sync(true));
    UI.setResetHandler(resetStartToCurrent);
    watchRoute();
    sync(true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main, { once: true });
  } else {
    main();
  }
})();
