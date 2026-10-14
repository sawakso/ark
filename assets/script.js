/* ==========================================================================
   明日方舟干员推荐台 —— 交互逻辑 v2
   ========================================================================== */

(function () {
  'use strict';

  const PROFESSIONS = ['先锋', '近卫', '重装', '狙击', '术师', '医疗', '辅助', '特种'];
  const RARITIES = [6, 5, 4, 3, 2, 1];
  const STORE_PREFIX = 'ark_live_';
  const DEFAULT_ROW_TITLES = ['S 幻神', 'A 强力', 'B 可用', 'C 过渡'];

  // 梯度行标签的默认配色（用户改过之后就用他自己的颜色）
  const TIER_COLORS = ['#ff4d4d', '#ff9c4d', '#ffd24a', '#4caf50', '#2f9bff', '#b45cff', '#9e9e9e'];

  const state = {
    operators: [],
    byId: new Map(),
    meta: null,
    filters: { professions: [], rarities: [] },
    search: '',
    pinned: {},          // 始终指向「当前榜单」的 pinned
    rows: [],            // 始终指向「当前榜单」的 rows
    boards: [],          // 全部榜单 [{ id, name, rows, pinned }]
    activeBoard: 0,
    selectedId: null,
    dataSource: '',      // 'kv' | 'bundle' | 'baked'，用于调试和状态提示
    showSkills: true,    // 排行榜里是否在头像下方显示已固定的技能
    unique: false,       // 每个干员只能出现在一个梯度行里
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function loadStore(key, fallback) {
    try {
      const raw = localStorage.getItem(STORE_PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function saveStore(key, value) {
    try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value)); } catch (e) {}
  }
  function removeStore(key) {
    try { localStorage.removeItem(STORE_PREFIX + key); } catch (e) {}
  }

  /* ======================================================================
     多榜单
     每个榜单 = { id, name, rows, pinned }。
     为了不动原有的渲染/拖动/导出逻辑，state.rows 与 state.pinned 始终是
     「当前榜单」里那两个对象的直接引用，老代码照常跑，只把持久化换成 saveBoards()。
     ====================================================================== */

  const MIN_BOARDS = 4;                 // 至少准备几个榜单位
  const FIELD_SEP = '\u0001';           // 榜单内部字段分隔
  const BOARD_SEP = '\u0002';           // 榜单之间分隔
  const ROW_SEP = '\u0003';             // 分组行之间分隔
  const ROW_FIELD_SEP = '\u0004';       // 分组行内部字段分隔

  function newBoardId() {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function makeBoard(name, rows, pinned) {
    return {
      id: newBoardId(),
      name: name || '未命名榜单',
      rows: Array.isArray(rows) ? rows : [],
      pinned: normalizePinned(pinned || {}),
    };
  }

  function curBoard() {
    if (!state.boards.length) state.boards.push(makeBoard('榜单 1', initialRows(), {}));
    if (!(state.activeBoard >= 0) || state.activeBoard >= state.boards.length) state.activeBoard = 0;
    return state.boards[state.activeBoard];
  }

  /** 把 state.rows / state.pinned 指到当前榜单上 */
  function syncActiveBoard() {
    const b = curBoard();
    state.rows = b.rows;
    state.pinned = b.pinned;
  }

  function saveBoards() {
    saveStore('boards', state.boards.map((b) => ({
      id: b.id, name: b.name, rows: b.rows, pinned: b.pinned,
    })));
    saveStore('activeBoard', state.activeBoard);
  }

  function switchBoard(index) {
    if (index < 0 || index >= state.boards.length) return;
    state.activeBoard = index;
    syncActiveBoard();
    saveBoards();
    $('#ranking-title').value = curBoard().name;
    renderBoardTabs();
    if (state.unique) dedupeAllRows();
    renderSidebar();
    renderGrid();
  }

  function addBoard() {
    const n = state.boards.length + 1;
    state.boards.push(makeBoard('榜单 ' + n, defaultRows(), {}));   // 新榜从空白的 S/A/B/C 起步
    switchBoard(state.boards.length - 1);
  }

  function removeBoard(index) {
    if (state.boards.length <= 1) { alert('至少保留一个榜单。'); return; }
    const b = state.boards[index];
    if (!b) return;
    if (!confirm('删除榜单「' + b.name + '」？里面的分组和技能固定都会一起没掉，且无法撤销。')) return;
    state.boards.splice(index, 1);
    state.activeBoard = Math.max(0, Math.min(state.activeBoard, state.boards.length - 1));
    syncActiveBoard();
    saveBoards();
    $('#ranking-title').value = curBoard().name;
    renderBoardTabs();
    renderSidebar();
    renderGrid();
  }

  function renderBoardTabs() {
    const box = $('#board-tabs');
    if (!box) return;
    box.innerHTML = '';
    state.boards.forEach((b, i) => {
      const tab = document.createElement('div');
      tab.className = 'board-tab' + (i === state.activeBoard ? ' active' : '');
      tab.title = '切换到「' + b.name + '」';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'board-tab-name';
      nameSpan.textContent = b.name;
      tab.appendChild(nameSpan);
      if (state.boards.length > 1) {
        const del = document.createElement('span');
        del.className = 'board-tab-del';
        del.textContent = '×';
        del.title = '删除这个榜单';
        del.addEventListener('click', (e) => { e.stopPropagation(); removeBoard(i); });
        tab.appendChild(del);
      }
      tab.addEventListener('click', () => { if (i !== state.activeBoard) switchBoard(i); });
      box.appendChild(tab);
    });
    const add = document.createElement('button');
    add.className = 'tool-btn tiny board-tab-add';
    add.type = 'button';
    add.textContent = '＋ 新榜';
    add.title = '再开一个榜单';
    add.addEventListener('click', addBoard);
    box.appendChild(add);
  }

  // ---------------------------------------------------------------- 配置码

  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(String(b64 || '').replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /**
   * 配置码格式（先拼成 UTF-8 文本，再整体 base64）：
   *   第 0 行：ARKCFG1
   *   第 1 行：当前榜单序号 / 带技能 / 不重复
   *   第 2 行：干员 id 字典（逗号分隔）—— 只出现一次，码才不会太长
   *   第 3 行：各榜单，榜单内用控制字符分隔
   */
  function encodeConfig() {
    const dict = [];
    const dictIndex = new Map();
    const dictAdd = (id) => {
      if (dictIndex.has(id)) return dictIndex.get(id);
      const i = dict.length; dict.push(id); dictIndex.set(id, i); return i;
    };
    const opToken = (id, pins) => {
      const idx = dictAdd(id);
      const mask = (pins || []).reduce((m, s) => m | (1 << s), 0);
      return mask ? idx.toString(36) + '.' + mask.toString(36) : idx.toString(36);
    };
    const boardLines = state.boards.map((b) => {
      const pins = b.pinned || {};
      const inRows = new Set();
      const rows = (b.rows || []).map((r) => {
        const ops = (r.ops || []).map((id) => {
          inRows.add(id);
          return opToken(id, pins[id]);
        }).join(',');
        return [r.title || '', ops, r.color || ''].join(ROW_FIELD_SEP);
      }).join(ROW_SEP);
      // 没被拖进任何分组、但单独固定过技能的干员，也要一起带出去
      const extra = Object.keys(pins).filter((id) => !inRows.has(id)).map((id) => opToken(id, pins[id])).join(',');
      return [b.name, rows, extra].join(FIELD_SEP);
    }).join(BOARD_SEP);

    const payload = [
      'ARKCFG1',
      [state.activeBoard, state.showSkills ? 1 : 0, state.unique ? 1 : 0].join(FIELD_SEP),
      dict.join(','),
      boardLines,
    ].join('\n');
    return b64encode(payload);
  }

  function decodeConfig(code) {
    const payload = b64decode(String(code || '').trim());
    const lines = payload.split('\n');
    if (lines[0] !== 'ARKCFG1') throw new Error('不是有效的配置码（缺少 ARKCFG1 标识）');
    const head = (lines[1] || '').split(FIELD_SEP);
    const dict = (lines[2] || '').split(',');
    const boards = (lines[3] || '').split(BOARD_SEP).filter(Boolean).map((chunk) => {
      const parts = chunk.split(FIELD_SEP);
      const name = parts[0] || '未命名榜单';
      const pinned = {};

      // 解析一串 "idx36.mask36"，把干员 id 收进 ops（或丢掉），技能位掩码收进 pinned
      const readTokens = (str, sink) => {
        (str || '').split(',').filter(Boolean).forEach((token) => {
          const seg = token.split('.');
          const id = dict[parseInt(seg[0], 36)];
          if (!id) return;
          if (seg[1]) {
            const mask = parseInt(seg[1], 36) || 0;
            const pins = [];
            for (let k = 0; k < 8; k++) if (mask & (1 << k)) pins.push(k);
            if (pins.length) pinned[id] = pins;
          }
          if (sink) sink.push(id);
        });
      };

      const rows = (parts[1] || '').split(ROW_SEP).filter(Boolean).map((r) => {
        const rp = r.split(ROW_FIELD_SEP);
        const ops = [];
        readTokens(rp[1], ops);
        const row = { title: rp[0] || '未命名', ops };
        if (rp[2]) row.color = rp[2];
        return row;
      });
      readTokens(parts[2], null);          // 没进分组、但单独固定过技能的干员
      return { id: newBoardId(), name, rows, pinned: normalizePinned(pinned) };
    });
    if (!boards.length) throw new Error('配置码里没有解析出任何榜单');
    return {
      boards,
      activeBoard: Math.max(0, Math.min(boards.length - 1, parseInt(head[0], 10) || 0)),
      showSkills: head[1] === '1',
      unique: head[2] === '1',
    };
  }

  /** 把配置码解出来的东西灌进 state 并重画 */
  function applyConfig(cfg) {
    state.boards = cfg.boards;
    state.activeBoard = cfg.activeBoard;
    state.showSkills = !!cfg.showSkills;
    state.unique = !!cfg.unique;
    saveStore('showSkills', state.showSkills);
    saveStore('unique', state.unique);
    $('#opt-show-skills').checked = state.showSkills;
    $('#opt-unique').checked = state.unique;
    syncActiveBoard();
    saveBoards();
    if (state.unique) dedupeAllRows();
    $('#ranking-title').value = curBoard().name;
    renderBoardTabs();
    renderSidebar();
    renderGrid();
  }

  /**
   * 首次打开时用的榜单。
   * 优先级：浏览器里已有的老存档 > 固化在文件里的配置码 > 内置梯队。
   * （老存档排第一，是为了不让人本机正在用的配置被文件里的默认值盖掉。）
   */
  function buildInitialBoards() {
    const baked = bakedDefaults();
    const oldRows = loadStore('rows', null);
    const oldPinned = loadStore('pinned', null);
    const hasLegacy = Array.isArray(oldRows) && oldRows.length > 0;

    if (!hasLegacy && window.ARK_DEFAULT_CONFIG) {
      try {
        const cfg = decodeConfig(window.ARK_DEFAULT_CONFIG);
        const boards = cfg.boards.slice();
        while (boards.length < MIN_BOARDS) boards.push(makeBoard('榜单 ' + (boards.length + 1), defaultRows(), {}));
        return { boards, showSkills: cfg.showSkills, unique: cfg.unique };
      } catch (e) { /* 码坏了就走下面的兜底 */ }
    }

    // 以前只有一个榜单，直接搬进「榜单 1」
    const boards = [makeBoard('榜单 1', hasLegacy ? oldRows : initialRows(), oldPinned || {})];
    while (boards.length < MIN_BOARDS) boards.push(makeBoard('榜单 ' + (boards.length + 1), defaultRows(), {}));
    return {
      boards,
      showSkills: baked ? !!baked.showSkills : true,
      unique: !!(baked && baked.unique),
    };
  }

  function downloadBlob(text, filename, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function setCfgMsg(text, ok) {
    const el = $('#cfg-msg');
    el.textContent = text || '';
    el.className = 'cfg-msg' + (text ? (ok ? ' ok' : ' err') : '');
  }

  function openCfgModal(mode) {
    const ta = $('#cfg-text');
    setCfgMsg('');
    if (mode === 'export') {
      $('#cfg-title').textContent = '导出配置码';
      $('#cfg-desc').innerHTML = '复制这串码保存好。它包含<b>全部 ' + state.boards.length +
        ' 个榜单</b>的分组、干员和已固定的技能，换台机器/换个浏览器粘回去就能还原。';
      ta.value = encodeConfig();
      ta.readOnly = true;
      $('#cfg-apply').classList.add('hidden');
      $('#cfg-copy').classList.remove('hidden');
      $('#cfg-download').classList.remove('hidden');
    } else {
      $('#cfg-title').textContent = '导入配置码';
      $('#cfg-desc').textContent = '把之前导出的配置码粘贴进来，点「导入并覆盖」即可还原全部榜单。';
      ta.value = '';
      ta.readOnly = false;
      $('#cfg-apply').classList.remove('hidden');
      $('#cfg-copy').classList.add('hidden');
      $('#cfg-download').classList.add('hidden');
    }
    $('#cfg-modal').classList.remove('hidden');
    setTimeout(() => { ta.focus(); if (mode === 'export') ta.select(); }, 30);
  }

  function closeCfgModal() { $('#cfg-modal').classList.add('hidden'); }

  /** 把当前配置固化进 HTML 里，下载一份可直接部署的单文件网页 */
  function bakeDefaultConfig(html, code) {
    const marker = /window\.ARK_DEFAULT_CONFIG\s*=\s*"[^"]*"/;
    if (!marker.test(html)) return null;
    return html.replace(marker, () => 'window.ARK_DEFAULT_CONFIG = "' + code + '"');
  }

  /**
   * 「下载单文件版（含我当前的配置）」。
   * 网页版自己是多文件的，光下载 index.html 少了 assets/ 就跑不起来，
   * 所以这里拉的是 standalone/ak-tools.html，再把它的配置占位符换成当前配置。
   */
  function downloadWithDefaultConfig() {
    const code = encodeConfig();
    fetch('standalone/ak-tools.html', { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then((html) => {
        const baked = bakeDefaultConfig(html, code);
        if (!baked) { alert('单文件版里没找到配置占位符，无法生成。'); return; }
        downloadBlob(baked, 'ak-tools.html', 'text/html;charset=utf-8');
      })
      .catch((e) => {
        alert('没能取到单文件版（' + (e && e.message ? e.message : e) + '）。\n' +
              '可以直接打开 /standalone/ak-tools.html 另存为。');
      });
  }

  function stars(n) { return '★'.repeat(n); }

  /**
   * 图片地址解析。
   *  · 多文件版：op.avatar 是 "images/avatar/xxx.png" 这类相对路径，直接用
   *  · 单文件版：整个 images/ 被压成 webp 内嵌进 window.ARK_IMAGE_MAP，这里换成 data URI
   *  · 在线更新出来的新干员：avatar 直接是 https://media.prts.wiki/... 的远程地址
   */
  function resolveImg(path) {
    if (!path) return '';
    const map = window.ARK_IMAGE_MAP;
    if (map && map[path]) return map[path];
    return path;
  }

  /** 取某个干员已固定的技能序号，并保证按 1、2、3 升序（显示顺序与点击顺序无关） */
  function sortedPinned(opId) {
    return (state.pinned[opId] || []).slice().sort((a, b) => a - b);
  }

  // ---------------------------------------------------------------- 数据加载

  /**
   * 数据加载：三级来源，按优先级依次尝试。
   *   1) /api/data  → Cloudflare KV，所有用户共用同一份最新数据（推荐）
   *   2) assets/data.json → 随站点一起部署的静态快照（KV 为空时的降级）
   *   3) window.ARKNIGHTS_DATA → 单文件版/standalone 内嵌快照（最后兜底）
   * 注意：不再读 localStorage 里的 operators_v1。数据现在以云端为准，
   * 否则某个人本地更新过就会一直看到旧数据，覆盖掉管理员发布的版本。
   */
  async function loadData() {
    // 1) 云端 KV
    try {
      const res = await fetch('/api/data', { cache: 'no-store' });
      if (res.ok) {
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.indexOf('application/json') >= 0) {
          const json = await res.json();
          if (json && Array.isArray(json.operators) && json.operators.length) {
            state.operators = json.operators;
            state.meta = json.meta || { source: '云端 KV', count: json.operators.length };
            state.dataSource = 'kv';
          }
        }
      }
    } catch (e) { /* KV 挂了就往下走，别让页面白屏 */ }

    // 2) 静态快照
    if (!state.operators.length) {
      try {
        const res = await fetch('assets/data.json', { cache: 'force-cache' });
        if (res.ok) {
          const json = await res.json();
          if (json && Array.isArray(json.operators) && json.operators.length) {
            state.operators = json.operators;
            state.meta = json.meta || null;
            state.dataSource = 'bundle';
          }
        }
      } catch (e) {}
    }

    // 3) 内嵌快照
    if (!state.operators.length && window.ARKNIGHTS_DATA && Array.isArray(window.ARKNIGHTS_DATA.operators)) {
      state.operators = window.ARKNIGHTS_DATA.operators;
      state.meta = window.ARKNIGHTS_DATA.meta || null;
      state.dataSource = 'baked';
    }

    state.byId = new Map(state.operators.map((o) => [o.id, o]));
    if (!state.operators.length) {
      $('#grid').innerHTML =
        '<div class="empty-tip">还没有数据。<br>请管理员点一次角落的 ⚙ 触发云端更新。</div>';
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- 筛选 / 网格

  function filteredOperators() {
    const q = state.search.trim().toLowerCase();
    return state.operators.filter((op) => {
      if (state.filters.professions.length && !state.filters.professions.includes(op.profession)) return false;
      if (state.filters.rarities.length && !state.filters.rarities.includes(op.rarity)) return false;
      if (q) {
        const hay = (op.name + ' ' + (op.enName || '') + ' ' + op.id + ' ' + (op.subProfession || '')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderGrid() {
    const list = filteredOperators();
    const grid = $('#grid');
    grid.innerHTML = list
      .map((op) => {
        const pinnedIdx = sortedPinned(op.id);
        const pinnedHtml = pinnedIdx.length
          ? `<div class="op-pinned">${pinnedIdx
              .map((i) => {
                const sk = op.skills[i];
                if (!sk) return '';
                return sk.icon
                  ? `<img src="${esc(resolveImg(sk.icon))}" alt="${esc(sk.name)}" title="${esc(sk.name)}">`
                  : `<div class="pin-dot" title="${esc(sk.name)}">${i + 1}</div>`;
              })
              .join('')}</div>`
          : '';

        // 注意：这里不要用内联 onerror（里面再嵌套引号会把 HTML 解析搞崩），
        // 头像加载失败交给下面统一挂的 error 监听处理。
        const avatar = `
          <img class="op-avatar" src="${esc(resolveImg(op.avatar))}" alt="${esc(op.name)}" loading="lazy"${op.avatar ? '' : ' style="display:none"'}>
          <div class="op-avatar-fallback" style="display:none">${esc(op.name.slice(0, 1))}</div>`;

        return `
        <div class="op-card r${op.rarity} ${state.selectedId === op.id ? 'selected' : ''}"
             data-id="${esc(op.id)}"
             data-prts-url="${esc(op.prtsUrl)}"
             title="${esc(op.name)}｜${esc(op.profession)}·${esc(op.subProfession)}｜${op.rarity}星（Ctrl+左键打开 PRTS）">
          <div class="op-stars">${stars(op.rarity)}</div>
          <div class="op-avatar-wrap">${avatar}</div>
          <div class="op-info">
            <div class="op-name">${esc(op.name)}</div>
            <div class="op-sub">${esc(op.subProfession || op.profession)}</div>
            ${pinnedHtml}
          </div>
        </div>`;
      })
      .join('');

    // 头像加载失败 → 显示首字占位图
    grid.querySelectorAll('img.op-avatar').forEach((img) => {
      const showFallback = () => {
        img.style.display = 'none';
        const fb = img.parentElement.querySelector('.op-avatar-fallback');
        if (fb) fb.style.display = 'flex';
      };
      img.addEventListener('error', showFallback);
      if (img.complete && img.naturalWidth === 0) showFallback();
    });

    $('#empty-tip').classList.toggle('hidden', list.length > 0);
    $('#count-label').textContent = `${list.length} / ${state.operators.length}`;
    $('#count-label').title = list.length === state.operators.length ? '全部干员' : `已筛选 ${list.length} 名`;
  }

  function buildFilterButtons() {
    const pBox = $('#profession-filters');
    pBox.innerHTML = '';
    PROFESSIONS.forEach((p) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = p;
      b.dataset.profession = p;
      b.addEventListener('click', () => {
        const arr = state.filters.professions;
        const i = arr.indexOf(p);
        if (i >= 0) arr.splice(i, 1); else arr.push(p);
        saveStore('filters', state.filters);
        syncFilterButtons();
        renderGrid();
      });
      pBox.appendChild(b);
    });

    const rBox = $('#rarity-filters');
    rBox.innerHTML = '';
    RARITIES.forEach((r) => {
      const b = document.createElement('button');
      b.className = 'chip r' + r;
      b.textContent = r + '★';
      b.dataset.rarity = String(r);
      b.addEventListener('click', () => {
        const arr = state.filters.rarities;
        const i = arr.indexOf(r);
        if (i >= 0) arr.splice(i, 1); else arr.push(r);
        saveStore('filters', state.filters);
        syncFilterButtons();
        renderGrid();
      });
      rBox.appendChild(b);
    });
  }

  function syncFilterButtons() {
    $$('#profession-filters .chip').forEach((b) => b.classList.toggle('active', state.filters.professions.includes(b.dataset.profession)));
    $$('#rarity-filters .chip').forEach((b) => b.classList.toggle('active', state.filters.rarities.includes(Number(b.dataset.rarity))));
  }

  // ---------------------------------------------------------------- 左侧分组（梯度榜行）

  /** 内置的兜底分组（只有在既没存过、也没有 defaults.js 时才用） */
  function defaultRows() {
    return DEFAULT_ROW_TITLES.map((t) => ({ title: t, ops: [] }));
  }

  /** defaults.js 里固化的默认梯队（由「设为默认」或手工生成） */
  function bakedDefaults() {
    const d = window.ARKNIGHTS_DEFAULTS;
    return d && typeof d === 'object' ? d : null;
  }

  /** 首次打开时用的分组：优先用固化的默认梯队 */
  function initialRows() {
    const d = bakedDefaults();
    if (d && Array.isArray(d.rows) && d.rows.length) {
      // 深拷贝一份，后续拖动/改名不会污染 window 上的原始数据
      return JSON.parse(JSON.stringify(d.rows)).map((r) => ({
        title: r.title || '未命名',
        ops: Array.isArray(r.ops) ? r.ops.slice() : [],
        ...(r.color ? { color: r.color } : {}),
      }));
    }
    return defaultRows();
  }

  function renderSidebar() {
    const box = $('#rows-container');
    box.innerHTML = '';

    state.rows.forEach((row, rowIndex) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'group-row';
      rowEl.dataset.rowIndex = String(rowIndex);

      const label = document.createElement('div');
      label.className = 'tier-label';
      // 行颜色：用户设过就用他设的，没设过就用默认调色板
      label.style.background = row.color || TIER_COLORS[rowIndex % TIER_COLORS.length];
      label.textContent = row.title || '未命名';
      label.title = '点一下改名字 · 按住拖动可调整这一行的顺序';

      // 标题编辑：点标签即可改
      label.addEventListener('click', (e) => {
        e.stopPropagation();
        if (Date.now() < suppressClickUntil) return;          // 刚刚是在拖整行，不当成改名
        if (rowEl.querySelector('.row-title-edit')) return;   // 已经在编辑了
        const input = document.createElement('input');
        input.className = 'row-title-edit';
        input.value = row.title;
        input.placeholder = '分级名';
        rowEl.classList.add('editing');
        rowEl.appendChild(input);
        input.focus();
        input.select();
        const save = () => {
          const next = input.value.trim();
          if (next) row.title = next;
          saveBoards();
          input.remove();
          rowEl.classList.remove('editing');
          renderSidebar();
        };
        input.addEventListener('blur', save);
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
          if (ev.key === 'Escape') { ev.preventDefault(); input.value = row.title; input.blur(); }
        });
      });

      // 行右上角工具：改颜色 / 删除
      const tools = document.createElement('div');
      tools.className = 'row-tools';

      const colorWrap = document.createElement('label');
      colorWrap.className = 'row-color';
      colorWrap.title = '自定义这一行的颜色';
      colorWrap.style.background = row.color || TIER_COLORS[rowIndex % TIER_COLORS.length];
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.value = normalizeHex(row.color || TIER_COLORS[rowIndex % TIER_COLORS.length]);
      colorInput.addEventListener('input', () => {
        row.color = colorInput.value;
        label.style.background = colorInput.value;
        colorWrap.style.background = colorInput.value;
        saveBoards();
      });
      colorWrap.appendChild(colorInput);

      const del = document.createElement('button');
      del.className = 'row-del';
      del.textContent = '×';
      del.title = '删除这一行';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        state.rows.splice(rowIndex, 1);
        saveBoards();
        renderSidebar();
      });

      tools.appendChild(colorWrap);
      tools.appendChild(del);

      const content = document.createElement('div');
      content.className = 'tier-content';
      content.dataset.rowIndex = String(rowIndex);

      row.ops.forEach((opId, opIndex) => {
        const op = state.byId.get(opId);
        if (!op) return;
        const chip = makeTierChip(op, rowIndex, opIndex);
        content.appendChild(chip);
      });

      // 空放置槽
      const empty = document.createElement('div');
      empty.className = 'tier-slot empty';
      empty.dataset.rowIndex = String(rowIndex);
      empty.title = '拖到此处加入本行';
      content.appendChild(empty);

      rowEl.appendChild(label);
      rowEl.appendChild(content);
      rowEl.appendChild(tools);
      box.appendChild(rowEl);
    });
  }

  /** normalizeHex：<input type="color"> 只接受 #rrggbb 格式 */
  function normalizeHex(c) {
    if (!c) return '#9e9e9e';
    if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
    const m = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(c);
    if (m) return '#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
    return '#9e9e9e';
  }

  /** 排行榜里这个干员要显示的技能小图标（取"已固定"的技能，没固定就不显示） */
  function tierSkillsHtml(op) {
    const idx = sortedPinned(op.id);
    if (!idx.length) return '';
    const inner = idx
      .map((i) => {
        const sk = op.skills[i];
        if (!sk) return '';
        return sk.icon
          ? `<img src="${esc(resolveImg(sk.icon))}" alt="${esc(sk.name)}" title="${esc(sk.name)}">`
          : `<div class="pin-dot" title="${esc(sk.name)}">${i + 1}</div>`;
      })
      .join('');
    return inner ? `<div class="tier-skills">${inner}</div>` : '';
  }

  function makeTierChip(op, rowIndex, opIndex) {
    const chip = document.createElement('div');
    const skillsHtml = state.showSkills ? tierSkillsHtml(op) : '';
    chip.className = 'tier-slot' + (skillsHtml ? ' has-skills' : '');
    chip.dataset.opId = op.id;
    chip.dataset.rowIndex = String(rowIndex);
    chip.dataset.opIndex = String(opIndex);
    chip.title = `${op.name}｜${op.profession}｜${op.rarity}星（可拖动排序 / 换行，Ctrl+左键打开 PRTS，右键移除）`;
    chip.innerHTML =
      `<div class="tier-avatar-wrap">${op.avatar ? `<img class="tier-avatar" src="${esc(resolveImg(op.avatar))}" alt="${esc(op.name)}">` : ''}</div>` +
      skillsHtml +
      `<div class="slot-remove" data-remove="1">×</div>`;

    chip.addEventListener('click', (e) => {
      if (Date.now() < suppressClickUntil) return;   // 刚拖完，忽略这次点击
      if (e.target.dataset.remove === '1') {
        e.stopPropagation();
        removeFromRow(rowIndex, opIndex);
        return;
      }
      if (e.ctrlKey || e.metaKey) { window.open(op.prtsUrl, '_blank'); return; }
      openSkillModal(op.id);
    });

    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, op, { fromSidebar: true, rowIndex, opIndex });
    });

    return chip;
  }

  // ---------------------------------------------------------------- 拖拽（指针事件实现）
  //
  // 说明：原来用的是浏览器原生 HTML5 拖放（draggable + dragstart/drop）。
  // 在预览窗口 / 某些内嵌 iframe 里原生拖放会被拦截，导致"拖不过去"。
  // 这里改为自己用 mousedown / mousemove / mouseup 实现，全平台一致。

  let dragState = null;
  let suppressClickUntil = 0;

  function onPointerDown(e) {
    if (e.button !== 0) return;
    // 点在删除按钮上不触发拖拽
    if (e.target.dataset && e.target.dataset.remove === '1') return;

    // ---- 情况 A：按在行标签上 → 拖动整行排序 ----
    const labelEl = e.target.closest('.tier-label');
    if (labelEl) {
      const rowEl = labelEl.closest('.group-row');
      if (rowEl) {
        dragState = {
          kind: 'row',
          rowIndex: Number(rowEl.dataset.rowIndex),
          startX: e.clientX,
          startY: e.clientY,
          started: false,
          ghost: null,
          insertIndex: null,
        };
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
        document.addEventListener('pointercancel', onPointerUp);
        return;
      }
    }

    // ---- 情况 B：按在干员卡片 / 排行榜头像上 → 拖动干员 ----
    const el = e.target.closest('.op-card, .tier-slot');
    if (!el) return;

    const isTierChip = el.classList.contains('tier-slot') && !el.classList.contains('empty');
    const opId = el.dataset.id || el.dataset.opId;
    if (!opId || !state.byId.has(opId)) return;

    dragState = {
      kind: 'op',
      opId,
      fromRow: isTierChip ? Number(el.dataset.rowIndex) : -1,
      fromIndex: isTierChip ? Number(el.dataset.opIndex) : -1,
      startX: e.clientX,
      startY: e.clientY,
      started: false,
      ghost: null,
      hoverRow: null,
    };

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
  }

  function onPointerMove(e) {
    if (!dragState) return;

    if (!dragState.started) {
      const dx = Math.abs(e.clientX - dragState.startX);
      const dy = Math.abs(e.clientY - dragState.startY);
      if (dx < 5 && dy < 5) return;   // 还没到拖动阈值，当普通点击处理
      if (dragState.kind === 'row') startRowGhost();
      else startGhost();
    }

    moveGhost(e.clientX, e.clientY);
    if (dragState.kind === 'row') updateRowInsertLine(e.clientY);
    else highlightHover(e.clientX, e.clientY);
  }

  function startGhost() {
    const op = state.byId.get(dragState.opId);
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.innerHTML = op && op.avatar ? `<img src="${esc(resolveImg(op.avatar))}" alt="">` : '';
    document.body.appendChild(ghost);
    dragState.ghost = ghost;
    dragState.started = true;
    document.body.classList.add('dragging');
  }

  // ---- 拖动整行：幽灵块 + 插入位置指示线 ----

  function startRowGhost() {
    const row = state.rows[dragState.rowIndex];
    const color = (row && row.color) || TIER_COLORS[dragState.rowIndex % TIER_COLORS.length];
    const ghost = document.createElement('div');
    ghost.className = 'row-ghost';
    ghost.style.background = color;
    ghost.textContent = (row && row.title) || '未命名';
    document.body.appendChild(ghost);

    const line = document.createElement('div');
    line.className = 'row-insert-line';
    document.body.appendChild(line);

    dragState.ghost = ghost;
    dragState.line = line;
    dragState.started = true;
    document.body.classList.add('dragging');

    const rowEl = document.querySelector(`.group-row[data-row-index="${dragState.rowIndex}"]`);
    if (rowEl) rowEl.classList.add('dragging-row');
  }

  /** 算出行应该插到第几个位置（0..行数） */
  function computeRowInsertIndex(y) {
    const rows = $$('.group-row');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return rows.length;
  }

  function updateRowInsertLine(y) {
    const rows = $$('.group-row');
    if (!rows.length) return;
    const idx = computeRowInsertIndex(y);
    dragState.insertIndex = idx;

    // 指示线画在目标行的上边缘（或最后一行下边缘）
    const anchor = rows[Math.min(idx, rows.length - 1)];
    const r = anchor.getBoundingClientRect();
    const lineY = idx >= rows.length ? r.bottom : r.top;
    dragState.line.style.left = r.left + 'px';
    dragState.line.style.width = r.width + 'px';
    dragState.line.style.top = (lineY - 1.5) + 'px';
  }

  function applyRowReorder(fromIndex, insertIndex) {
    if (insertIndex == null) return;
    let to = insertIndex;
    if (to > fromIndex) to--;          // 自己先被抽走，后面的下标要前移
    if (to === fromIndex) return;      // 位置没变
    const [moved] = state.rows.splice(fromIndex, 1);
    state.rows.splice(Math.max(0, Math.min(to, state.rows.length)), 0, moved);
    saveBoards();
    renderSidebar();
  }

  function moveGhost(x, y) {
    if (!dragState || !dragState.ghost) return;
    dragState.ghost.style.left = x + 'px';
    dragState.ghost.style.top = y + 'px';
  }

  /** 高亮鼠标下方的梯度行 */
  function highlightHover(x, y) {
    const row = rowUnderPoint(x, y);
    if (dragState.hoverRow === row) return;
    $$('.group-row.drop-active').forEach((n) => n.classList.remove('drop-active'));
    // 注意：行号可能是 0，所以这里必须用 != null 判断，不能用 if (row)
    if (row != null) {
      const el = document.querySelector(`.group-row[data-row-index="${row}"]`);
      if (el) el.classList.add('drop-active');
    }
    dragState.hoverRow = row;
  }

  function rowUnderPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const rowEl = el.closest('.group-row');
    return rowEl ? Number(rowEl.dataset.rowIndex) : null;
  }

  function onPointerUp(e) {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerUp);

    const st = dragState;
    dragState = null;
    if (!st) return;

    if (st.ghost) st.ghost.remove();
    if (st.line) st.line.remove();
    document.body.classList.remove('dragging');
    $$('.group-row.drop-active').forEach((n) => n.classList.remove('drop-active'));
    $$('.group-row.dragging-row').forEach((n) => n.classList.remove('dragging-row'));

    if (!st.started) return;   // 没真正拖动 → 让 click 事件正常走

    suppressClickUntil = Date.now() + 250;

    // 拖动整行：按指示线落位
    if (st.kind === 'row') {
      applyRowReorder(st.rowIndex, st.insertIndex);
      return;
    }

    const el = document.elementFromPoint(e.clientX, e.clientY);
    const rowEl = el && el.closest('.group-row');
    if (!rowEl) return;        // 没落在任何分组上 → 取消

    const rowIndex = Number(rowEl.dataset.rowIndex);

    // 落点如果在某个头像上，就插到它前面；否则追加到行尾
    let insertIndex = -1;
    const chip = el.closest('.tier-slot:not(.empty)');
    if (chip && Number(chip.dataset.rowIndex) === rowIndex) {
      insertIndex = Number(chip.dataset.opIndex);
    }

    if (st.fromRow === rowIndex && insertIndex > st.fromIndex) insertIndex--;
    if (st.fromRow >= 0) removeFromRow(st.fromRow, st.fromIndex, true);

    addToRow(rowIndex, st.opId, insertIndex);
  }

  function addToRow(rowIndex, opId, insertBeforeIndex = -1) {
    const row = state.rows[rowIndex];
    if (!row || !state.byId.has(opId)) return;

    // 「不重复」模式：先从别的行里把它摘掉
    if (state.unique) removeOpEverywhere(opId, rowIndex);

    if (row.ops.indexOf(opId) >= 0) return;   // 已经在本行了

    if (insertBeforeIndex >= 0 && insertBeforeIndex < row.ops.length) {
      row.ops.splice(insertBeforeIndex, 0, opId);
    } else {
      row.ops.push(opId);
    }
    saveBoards();
    renderSidebar();
  }

  /** 把某个干员从除 exceptRowIdx 之外的所有行里移除（「不重复」模式用） */
  function removeOpEverywhere(opId, exceptRowIdx) {
    state.rows.forEach((row, i) => {
      if (i === exceptRowIdx) return;
      row.ops = row.ops.filter((id) => id !== opId);
    });
  }

  /** 刚打开「不重复」时，清理已有重复：同一干员只保留最靠前的那一行 */
  function dedupeAllRows() {
    const seen = new Set();
    let changed = false;
    state.rows.forEach((row) => {
      const kept = [];
      row.ops.forEach((id) => {
        if (seen.has(id)) { changed = true; return; }
        seen.add(id);
        kept.push(id);
      });
      row.ops = kept;
    });
    return changed;
  }

  function removeFromRow(rowIndex, opIndex, silent) {
    const row = state.rows[rowIndex];
    if (!row) return;
    row.ops.splice(opIndex, 1);
    saveBoards();
    if (!silent) renderSidebar();
  }

  // ---------------------------------------------------------------- 技能面板

  function openSkillModal(opId) {
    const op = state.byId.get(opId);
    if (!op) return;
    state.selectedId = opId;
    renderGrid();

    $('#modal-avatar').src = resolveImg(op.avatar);
    $('#modal-avatar').style.display = op.avatar ? '' : 'none';
    $('#modal-name').textContent = op.name;
    $('#modal-stars').innerHTML = `<span style="color:var(--r${op.rarity})">${stars(op.rarity)}</span>`;
    $('#modal-sub').textContent =
      `${op.rarity}星 · ${op.profession} · ${op.subProfession || '-'} · ${op.position || '-'}${op.enName ? ' · ' + op.enName : ''}`;
    $('#modal-open-prts').onclick = () => window.open(op.prtsUrl, '_blank');

    const box = $('#modal-skills');
    const pinned = sortedPinned(op.id);
    if (!op.skills.length) {
      box.innerHTML = '<div class="modal-noskill">该干员没有技能。</div>';
    } else {
      box.innerHTML = op.skills
        .map(
          (sk, i) => `
        <div class="skill-item ${pinned.includes(i) ? 'pinned' : ''}" data-skill-index="${i}">
          ${sk.icon ? `<img src="${esc(resolveImg(sk.icon))}" alt="">` : '<div class="op-avatar-fallback" style="width:44px;height:44px;font-size:16px">技</div>'}
          <div>
            <div class="skill-no">技能 ${i + 1}${pinned.includes(i) ? ' · 已固定' : ''}</div>
            <div class="skill-name">${esc(sk.name)}</div>
          </div>
        </div>`
        )
        .join('');
      box.querySelectorAll('.skill-item').forEach((item) => {
        item.addEventListener('click', () => {
          togglePin(op.id, Number(item.dataset.skillIndex));
          openSkillModal(op.id);
        });
      });
    }

    $('#skill-modal').classList.remove('hidden');
  }

  function closeSkillModal() {
    $('#skill-modal').classList.add('hidden');
  }

  function togglePin(opId, skillIndex) {
    const arr = state.pinned[opId] || [];
    const i = arr.indexOf(skillIndex);
    if (i >= 0) arr.splice(i, 1); else arr.push(skillIndex);
    // 固定技能一律按技能序号从小到大排列，显示顺序与点击顺序无关
    arr.sort((a, b) => a - b);
    if (arr.length) state.pinned[opId] = arr; else delete state.pinned[opId];
    saveBoards();
    renderGrid();
    if (state.showSkills) renderSidebar();   // 排行榜也跟着更新技能图标
  }

  /** 老存档里可能是乱序的（按点击顺序存的），读进来时统一整理一遍 */
  function normalizePinned(pinned) {
    const out = {};
    Object.keys(pinned || {}).forEach((opId) => {
      const arr = pinned[opId];
      if (!Array.isArray(arr) || !arr.length) return;
      out[opId] = [...new Set(arr.map(Number).filter((n) => Number.isInteger(n) && n >= 0))].sort((a, b) => a - b);
      if (!out[opId].length) delete out[opId];
    });
    return out;
  }

  // ---------------------------------------------------------------- 右键菜单

  let ctxTarget = null;

  function showContextMenu(x, y, op, opts) {
    opts = opts || {};
    ctxTarget = { op, opts };
    const menu = $('#context-menu');
    let html = `<div class="ctx-title">${esc(op.name)} · ${op.rarity}星 ${esc(op.profession)}</div>`;
    html += `<div class="ctx-item" data-act="prts">打开 PRTS 页面 ↗</div>`;
    html += `<div class="ctx-item" data-act="skills">技能面板 / 固定技能</div>`;

    if (!opts.fromSidebar) {
      html += `<div class="ctx-sep"></div><div class="ctx-title">添加到分组</div>`;
      if (!state.rows.length) {
        html += `<div class="ctx-item disabled">（还没有分组）</div>`;
      } else {
        state.rows.forEach((row, i) => {
          html += `<div class="ctx-item" data-act="add" data-row="${i}">${esc(row.title || '未命名')}</div>`;
        });
      }
    } else {
      html += `<div class="ctx-sep"></div>`;
      html += `<div class="ctx-item danger" data-act="remove">从分组移除</div>`;
    }

    menu.innerHTML = html;
    menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';

    menu.querySelectorAll('.ctx-item').forEach((item) => {
      item.addEventListener('click', () => {
        const act = item.dataset.act;
        if (act === 'prts') window.open(op.prtsUrl, '_blank');
        else if (act === 'skills') openSkillModal(op.id);
        else if (act === 'add') addToRow(Number(item.dataset.row), op.id);
        else if (act === 'remove') removeFromRow(opts.rowIndex, opts.opIndex);
        hideContextMenu();
      }, { once: true });
    });
  }

  function hideContextMenu() {
    $('#context-menu').classList.add('hidden');
    ctxTarget = null;
  }

  // ---------------------------------------------------------------- 数据更新（云端）
  //
  // 主路径（管理员）：
  //   输密码 → 浏览器循环调 /api/fetch-prts → Cloudflare 边缘抓 PRTS → 浏览器组装
  //   → POST /api/data 一次性写 KV → 所有访客下次打开都是这份
  //
  // 兜底路径：
  //   prts.wiki 托管在国内（响应头能看到阿里云 CDN 节点 cache4.cn6144），
  //   Cloudflare 边缘出境访问可能超时。一旦云端链路失败，自动切成
  //   浏览器 JSONP 直连（MediaWiki 还留着 &callback= 支持），两条路径解析代码完全共用。
  //
  // 为什么服务端只转发不解析：免费版 CPU 只有 10ms/请求，解析全放浏览器，服务端 CPU 接近 0。

  const PRTS_API = 'https://prts.wiki/api.php';
  const PRTS_WIKI = 'https://prts.wiki/w/';
  const EXCLUDE_NAME = /卫戍协议/;
  const SKILL_RE = /\|\s*技能名\s*=\s*([^\n|}]+)/g;
  const PAGE_SIZE = 100;
  const SKILL_BATCH = 10;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 传输层：cloud = 走 Cloudflare 代理（默认）；browser = 浏览器直连（兜底） */
  let transport = 'cloud';
  /** 上一次的密码错误提示，用于重新弹出密码框时显示 */
  let pwdError = '';

  const md5Hex = (function () {
    const SHIFT = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const K = new Int32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

    return function (str) {
      const bytes = new TextEncoder().encode(str);
      const len = bytes.length;
      const total = (((len + 8) >> 6) + 1) << 6;
      const buf = new Uint8Array(total);
      buf.set(bytes);
      buf[len] = 0x80;
      const view = new DataView(buf.buffer);
      const bitLen = len * 8;
      view.setUint32(total - 8, bitLen >>> 0, true);
      view.setUint32(total - 4, Math.floor(bitLen / 4294967296), true);

      let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
      const M = new Int32Array(16);
      for (let off = 0; off < total; off += 64) {
        for (let j = 0; j < 16; j++) M[j] = view.getInt32(off + j * 4, true);
        let A = a0, B = b0, C = c0, D = d0;
        for (let i = 0; i < 64; i++) {
          let f, g;
          if (i < 16) { f = (B & C) | (~B & D); g = i; }
          else if (i < 32) { f = (B & D) | (C & ~D); g = (5 * i + 1) % 16; }
          else if (i < 48) { f = B ^ C ^ D; g = (3 * i + 5) % 16; }
          else { f = C ^ (B | ~D); g = (7 * i) % 16; }
          f = (f + A + K[i] + M[g]) | 0;
          A = D; D = C; C = B;
          B = (B + ((f << SHIFT[i]) | (f >>> (32 - SHIFT[i])))) | 0;
        }
        a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
      }
      const hex = (n) => {
        let s = '';
        for (let i = 0; i < 4; i++) s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
        return s;
      };
      return hex(a0) + hex(b0) + hex(c0) + hex(d0);
    };
  })();

  function mediaUrl(fileName) {
    const file = fileName.replace(/ /g, '_');
    const h = md5Hex(file);
    return `https://media.prts.wiki/${h[0]}/${h.slice(0, 2)}/${encodeURIComponent(file)}`;
  }

  // ---------------------------------------------------------------- 解析（两条链路共用）

  function parseSkillNames(text) {
    const names = [];
    if (!text) return names;
    SKILL_RE.lastIndex = 0;
    let m;
    while ((m = SKILL_RE.exec(text))) {
      const n = m[1].trim();
      if (n && !names.includes(n)) names.push(n);
    }
    return names;
  }

  function parsePrintouts(data) {
    const results = (data && data.query && data.query.results) || {};
    return Object.keys(results).map((title) => {
      const po = results[title].printouts || {};
      const first = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);
      const raw = first(po['稀有度']);
      return {
        title,
        name: first(po['干员名']) || title,
        charId: first(po['干员id']),
        enName: first(po['干员外文名']) || '',
        profession: first(po['职业']),
        subProfession: first(po['子职业']) || '',
        position: first(po['位置']) || '',
        rarity: raw == null ? null : parseInt(raw, 10) + 1,   // PRTS 的稀有度是 0 起的
      };
    });
  }

  function parseSkillPages(data) {
    const pages = (data && data.query && data.query.pages) || [];
    return pages.map((p) => {
      const rev = p.revisions && p.revisions[0];
      const content = rev && rev.slots && rev.slots.main ? rev.slots.main.content : '';
      return { title: p.title, skills: parseSkillNames(content || '') };
    });
  }

  // ---------------------------------------------------------------- 传输层 A：Cloudflare 代理

  /** 把非 2xx 的响应统一变成一条能看懂的错误 */
  async function apiError(res) {
    let msg = 'HTTP ' + res.status;
    try {
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('application/json') >= 0) {
        const j = await res.json();
        if (j && j.error) msg = j.error;
      } else if (res.status === 401) {
        msg = '密码不正确';
      } else if (res.status === 502) {
        msg = 'Cloudflare 边缘访问 PRTS 失败';
      }
    } catch (e) { /* 读不出就保留状态码 */ }
    const err = new Error(msg);
    if (res.status === 401) err.auth = true;
    return err;
  }

  function callPrts(body, pwd) {
    return fetch('/api/fetch-prts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + pwd },
      body: JSON.stringify(body),
    });
  }

  async function cloudFetchPage(offset, pwd) {
    const res = await callPrts({ step: 'list', offset }, pwd);
    if (!res.ok) throw await apiError(res);
    return parsePrintouts(await res.json());
  }

  async function cloudFetchSkills(titles, pwd) {
    const res = await callPrts({ step: 'skills', titles }, pwd);
    if (!res.ok) throw await apiError(res);
    return parseSkillPages(await res.json());
  }

  // ---------------------------------------------------------------- 传输层 B：浏览器 JSONP 直连
  //
  // 为什么用 JSONP 而不是 fetch：prts.wiki 的 api.php 不返回 CORS 头，
  // 浏览器 fetch 会被跨域拦掉；而 <script src> 不受同源策略限制。

  function jsonp(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const name = 'ark_cb_' + Math.random().toString(36).slice(2);
      const script = document.createElement('script');
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        try { delete window[name]; } catch (e) { window[name] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true; cleanup(); reject(new Error('PRTS 请求超时'));
      }, timeoutMs || 20000);
      window[name] = (data) => {
        if (settled) return;
        settled = true; cleanup(); resolve(data);
      };
      script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'callback=' + name;
      script.onerror = () => {
        if (settled) return;
        settled = true; cleanup(); reject(new Error('浏览器直连 PRTS 失败'));
      };
      document.head.appendChild(script);
    });
  }

  async function browserFetchPage(offset) {
    const q =
      '[[干员id::+]]|?干员id|?干员名|?干员外文名|?职业|?稀有度|?子职业|?位置' +
      '|limit=' + PAGE_SIZE + '|offset=' + offset;
    const data = await jsonp(PRTS_API + '?action=ask&format=json&query=' + encodeURIComponent(q));
    return parsePrintouts(data);
  }

  async function browserFetchSkills(titles) {
    const url =
      PRTS_API + '?action=query&format=json&formatversion=2&prop=revisions' +
      '&rvprop=content&rvslots=main&titles=' + encodeURIComponent(titles.join('|'));
    return parseSkillPages(await jsonp(url));
  }

  // ---------------------------------------------------------------- 统一入口：云端优先，失败降级

  async function fetchRemotePage(offset, pwd) {
    if (transport === 'cloud') {
      try {
        return await cloudFetchPage(offset, pwd);
      } catch (e) {
        if (e && e.auth) throw e;                 // 密码错不该降级
        transport = 'browser';
        showBanner('云端代理访问 PRTS 失败，已自动改用浏览器直连…');
        await sleep(300);
      }
    }
    return browserFetchPage(offset);
  }

  async function fetchSkillNamesBatch(titles, pwd) {
    if (transport === 'cloud') {
      try {
        return await cloudFetchSkills(titles, pwd);
      } catch (e) {
        if (e && e.auth) throw e;
        transport = 'browser';
        await sleep(300);
      }
    }
    return browserFetchSkills(titles);
  }

  // ---------------------------------------------------------------- 顶部进度条

  function showBanner(text) {
    const t = $('#update-banner-text');
    if (t) t.textContent = text;
    const banner = $('#update-banner');
    if (banner) banner.classList.remove('hidden');
    document.documentElement.style.setProperty('--banner-h', '36px');
  }

  function hideBanner() {
    const banner = $('#update-banner');
    if (banner) banner.classList.add('hidden');
    document.documentElement.style.setProperty('--banner-h', '0px');
  }

  // ---------------------------------------------------------------- 管理员密码弹窗

  /**
   * 弹出密码框。返回 Promise<string>；取消或关闭返回 ''。
   * 用 <input type="password"> 输入，默认显示为圆点，点「显示」才切成明文。
   * 密码只留在这个页面的内存变量里，不写 localStorage、不进 URL。
   */
  function askPassword(errorText) {
    return new Promise((resolve) => {
      const modal = $('#pwd-modal');
      const input = $('#pwd-input');
      const msgEl = $('#pwd-msg');
      const okBtn = $('#pwd-ok');
      const toggle = $('#pwd-toggle');

      const showError = (t) => {
        msgEl.textContent = t;
        msgEl.classList.toggle('hidden', !t);
      };

      const finish = (value) => {
        modal.classList.add('hidden');
        modal.removeEventListener('click', onMaskClick);
        document.removeEventListener('keydown', onKey);
        input.value = '';
        input.type = 'password';
        toggle.textContent = '显示';
        okBtn.disabled = false;
        okBtn.textContent = '确认并开始更新';
        resolve(value);
      };

      const submit = () => {
        const v = input.value.trim();
        if (!v) { showError('请输入密码'); input.focus(); return; }
        okBtn.disabled = true;
        okBtn.textContent = '验证中…';
        finish(v);
      };

      const onMaskClick = (e) => {
        if (e.target && e.target.dataset && e.target.dataset.pwdClose) finish('');
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish(''); }
      };

      input.value = '';
      input.type = 'password';
      toggle.textContent = '显示';
      okBtn.disabled = false;
      okBtn.textContent = '确认并开始更新';
      showError(errorText || '');

      okBtn.onclick = submit;
      input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      };
      toggle.onclick = () => {
        const shown = input.type === 'text';
        input.type = shown ? 'password' : 'text';
        toggle.textContent = shown ? '显示' : '隐藏';
        input.focus();
      };

      modal.addEventListener('click', onMaskClick);
      document.addEventListener('keydown', onKey);
      modal.classList.remove('hidden');
      setTimeout(() => input.focus(), 30);
    });
  }

  // ---------------------------------------------------------------- 管理员全流程

  async function adminUpdate(attempt) {
    const btn = $('#update-btn');
    if (!btn || btn.dataset.busy === '1') return;
    const round = attempt || 0;

    const pwd = await askPassword(pwdError);
    if (!pwd) return;                       // 用户取消
    pwdError = '';

    const oldText = btn.textContent;
    btn.dataset.busy = '1';
    btn.disabled = true;
    btn.textContent = '更新中…';
    transport = 'cloud';

    try {
      // ---- 1) 干员列表：一页 100 条，一页一个请求 ----
      const remote = [];
      let offset = 0;
      for (let guard = 0; guard < 40; guard++) {
        const items = await fetchRemotePage(offset, pwd);
        remote.push(...items);
        showBanner(
          (transport === 'cloud' ? '云端抓取' : '直连抓取') + '干员列表 … 已获取 ' + remote.length + ' 名'
        );
        if (items.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
        await sleep(120);
      }
      if (!remote.length) throw new Error('没有取到干员数据');

      const valid = remote.filter(
        (o) => o.charId && PROFESSIONS.includes(o.profession) && o.rarity >= 1 && o.rarity <= 6 && !EXCLUDE_NAME.test(o.name)
      );

      // ---- 2) 只给「本地没有的干员」补技能名（老干员直接复用，省掉几百次请求）----
      const localById = new Map(state.operators.map((o) => [o.id, o]));
      const needSkills = valid.filter((o) => !localById.has(o.charId));
      const skillMap = new Map();
      for (let i = 0; i < needSkills.length; i += SKILL_BATCH) {
        const slice = needSkills.slice(i, i + SKILL_BATCH);
        const got = await fetchSkillNamesBatch(slice.map((o) => o.title), pwd);
        got.forEach((it) => skillMap.set(it.title, it.skills));
        showBanner('抓取技能 … ' + Math.min(i + SKILL_BATCH, needSkills.length) + '/' + needSkills.length);
        await sleep(100);
      }

      // ---- 3) 组装 ----
      const localIcon = new Map();
      state.operators.forEach((o) => (o.skills || []).forEach((s) => {
        if (s.name && s.icon && !localIcon.has(s.name)) localIcon.set(s.name, s.icon);
      }));

      const operators = valid.map((r) => {
        const local = localById.get(r.charId);
        const names = local && local.skills && local.skills.length
          ? local.skills.map((s) => s.name)
          : (skillMap.get(r.title) || []);
        return {
          id: r.charId,
          name: r.name,
          enName: r.enName || (local && local.enName) || '',
          rarity: r.rarity,
          profession: r.profession,
          subProfession: r.subProfession || (local && local.subProfession) || '',
          position: r.position || (local && local.position) || '',
          prtsUrl: PRTS_WIKI + encodeURIComponent(r.title),
          // 仓库里已有的干员继续用那几 KB 的小图；新干员先用 PRTS 原图顶上
          avatar: (local && local.avatar) || mediaUrl('头像 ' + r.name + '.png'),
          skills: names.map((n) => ({
            name: n,
            icon: localIcon.get(n) || mediaUrl('技能 ' + n + '.png'),
          })),
        };
      });

      // 同名去重（PRTS 偶尔有两条记录），保留技能更全的那条
      const byName = new Map();
      operators.forEach((o) => {
        const prev = byName.get(o.name);
        if (!prev || o.skills.length > prev.skills.length) byName.set(o.name, o);
      });
      const finalOps = [...byName.values()];

      const profOrder = new Map(PROFESSIONS.map((p, i) => [p, i]));
      finalOps.sort(
        (a, b) =>
          b.rarity - a.rarity ||
          (profOrder.get(a.profession) ?? 99) - (profOrder.get(b.profession) ?? 99) ||
          a.name.localeCompare(b.name, 'zh')
      );

      const beforeNames = new Set(state.operators.map((o) => o.name));
      const added = finalOps.filter((o) => !beforeNames.has(o.name)).map((o) => o.name);

      // ---- 4) 发布：一次 KV 写入 ----
      showBanner('正在发布到云端 …');
      const res = await fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + pwd },
        body: JSON.stringify({
          meta: {
            source: 'PRTS (https://prts.wiki)',
            updatedAt: new Date().toISOString(),
            count: finalOps.length,
            skillCount: finalOps.reduce((n, o) => n + (o.skills || []).length, 0),
            transport,
          },
          operators: finalOps,
        }),
      });
      if (!res.ok) throw await apiError(res);

      showBanner(
        added.length
          ? '发布成功：共 ' + finalOps.length + ' 名干员，新增 ' + added.length + ' 名（' +
            added.slice(0, 6).join('、') + (added.length > 6 ? '…' : '') + '）'
          : '发布成功：共 ' + finalOps.length + ' 名干员，没有发现新干员'
      );
      setTimeout(() => location.reload(), 1500);
    } catch (err) {
      const authFail = !!(err && err.auth);
      hideBanner();
      btn.textContent = oldText;
      btn.disabled = false;
      btn.dataset.busy = '0';

      if (authFail) {
        // 密码错了：把错误带到密码框里再问一次（最多 3 轮，取消即停）
        pwdError = '密码不正确，请重新输入';
        if (round < 2) { adminUpdate(round + 1); return; }
        alert('密码连续错误，已停止。');
        return;
      }
      alert('更新失败：' + (err && err.message ? err.message : String(err)));
    }
  }

  /** 更新按钮 = 管理员入口。普通访客点开只有密码框，猜不到就什么都做不了。 */
  function initUpdate() {
    const btn = $('#update-btn');
    if (!btn) return;
    btn.textContent = '⟳ 更新';
    btn.title = '管理员入口：输入密码后从 PRTS 抓取最新数据并发布给所有访客';
    btn.addEventListener('click', () => adminUpdate(0));

    // 顶部提示条平时藏起来，只在更新过程中显示进度
    const bannerBtn = $('#banner-update-btn');
    if (bannerBtn) bannerBtn.classList.add('hidden');
    const resetBtn = $('#banner-reset');
    if (resetBtn) resetBtn.classList.add('hidden');
    const closeBtn = $('#banner-close');
    if (closeBtn) closeBtn.addEventListener('click', hideBanner);

    if (state.meta && state.meta.updatedAt) {
      const d = new Date(state.meta.updatedAt);
      const label = $('#count-label');
      if (label) label.title = '数据更新时间：' + d.toLocaleString('zh-CN');
    }
  }

  // ---------------------------------------------------------------- 排行榜图片导出（纯 Canvas，无需额外文件或依赖）
  function loadCanvasImage(src) {
    return new Promise((resolve) => {
      if (!src) return resolve(null);
      const img = new Image();
      if (/^https?:/i.test(src)) img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  /** 圆角矩形路径（手写 arcTo，避免依赖 ctx.roundRect，兼容老浏览器） */
  function roundRectPath(ctx, x, y, w, h, r) {
    const rad = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  async function exportRankingImage() {
    const note = prompt('给这张排行榜图片添加备注（可留空）：', '仅代表个人观点');
    if (note === null) return;
    const title = ($('#ranking-title').value || curBoard().name || '我的干员排行榜').trim() || '我的干员排行榜';
    if (curBoard().name !== title) { curBoard().name = title; renderBoardTabs(); }
    saveBoards();
    const rows = state.rows;
    const scale = 2, pad = 14, labelW = 56, gap = 8;
    // 导出卡片：头像在上 —— 正方形区域 + 等比缩放(contain)，完整显示、绝不裁切上下部分；
    // 技能图标单独占一行，固定在头像正下方，既不覆盖头像也不会跑到左上角。
    const cardW = 132;
    const avatarH = cardW;                       // PRTS 头像原图是 1:1，正方形区域可以正好铺满
    const skillH = state.showSkills ? 34 : 0;    // 关闭「显示技能」时不留空行
    const cardH = avatarH + skillH;
    const noteLines = wrapCanvasText(note, 58);
    const headerH = 104, footerH = 40 + noteLines.length * 26;

    // 自动挑选「每行放几个干员」：让整张导出图尽量接近正方形，
    // 而不是又窄又长的一条（列数越多图越宽越矮，取最接近 1:1 的那一档）。
    const layoutFor = (cols) => {
      const w = labelW + pad * 2 + cols * cardW + (cols - 1) * gap;
      const heights = rows.map(r =>
        Math.max(cardH + 20, Math.ceil(((r.ops || []).length || 1) / cols) * (cardH + gap) + 16));
      const h = headerH + heights.reduce((a, b) => a + b, 0) + footerH + pad;
      return { cols, w, h, heights, ratio: Math.max(w / h, h / w) };
    };
    let layout = null;
    for (let cols = 2; cols <= 22; cols++) {
      const L = layoutFor(cols);
      if (L.w > 2400) break;                       // 宽度上限，避免横向过长
      if (!layout || L.ratio < layout.ratio - 1e-9) layout = L;
    }
    if (!layout) layout = layoutFor(1);
    const contentW = layout.w, perRow = layout.cols, totalH = layout.h, rowHeights = layout.heights;
    const canvas = document.createElement('canvas');
    canvas.width = contentW * scale; canvas.height = totalH * scale;
    const ctx = canvas.getContext('2d'); ctx.scale(scale, scale);
    ctx.fillStyle = '#101214'; ctx.fillRect(0,0,contentW,totalH);
    ctx.fillStyle = '#1b1e21'; ctx.fillRect(0,0,contentW,headerH);
    ctx.fillStyle = '#ffae00'; ctx.fillRect(pad,24,5,42);
    ctx.fillStyle = '#f1f3f4'; ctx.font = 'bold 27px "Microsoft YaHei", sans-serif';
    ctx.fillText(title, pad+18, 45, contentW-pad*2-20);
    ctx.fillStyle = '#9da3a8'; ctx.font = '12px "Microsoft YaHei", sans-serif';
    ctx.fillText('明日方舟 · 干员梯度榜', pad+18, 70);
    ctx.fillText(new Date().toLocaleDateString('zh-CN'), contentW-pad-100, 70);
    let y = headerH;
    for (let ri=0; ri<rows.length; ri++) {
      const row = rows[ri], h = rowHeights[ri];
      ctx.fillStyle = ri%2 ? '#17191b' : '#202326'; ctx.fillRect(0,y,contentW,h);
      ctx.fillStyle = row.color || TIER_COLORS[ri % TIER_COLORS.length]; ctx.fillRect(0,y,labelW,h);
      const tierTitle = Array.from(row.title || '未命名');
      ctx.save(); ctx.fillStyle = '#fff'; ctx.font = 'bold 25px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const charStep = 29, shownChars = tierTitle.slice(0, Math.max(1, Math.floor((h-12)/charStep)));
      const startY = y + (h-(shownChars.length-1)*charStep)/2;
      shownChars.forEach((ch,ci)=>ctx.fillText(ch,labelW/2,startY+ci*charStep));
      ctx.restore();
      const ids = row.ops || [];
      for (let oi=0; oi<ids.length; oi++) {
        const op = state.byId.get(ids[oi]); if (!op) continue;
        const x = labelW + pad + (oi%perRow)*(cardW+gap);
        const oy = y + 10 + Math.floor(oi/perRow)*(cardH+gap);

        // 卡片底：圆角深色底
        ctx.fillStyle='#101214';
        roundRectPath(ctx,x,oy,cardW,cardH,9); ctx.fill();

        // ① 头像区：正方形容器 + contain 等比缩放并居中 —— 图片完整呈现，不裁掉上下部分
        const image = await loadCanvasImage(resolveImg(op.avatar));
        ctx.save();
        roundRectPath(ctx,x+2,oy+2,cardW-4,avatarH-4,7); ctx.clip();
        ctx.fillStyle='#17191b'; ctx.fillRect(x+2,oy+2,cardW-4,avatarH-4);
        if (image) {
          const boxW=cardW-4, boxH=avatarH-4;
          const ratio=Math.min(boxW/image.width,boxH/image.height);
          const iw=image.width*ratio, ih=image.height*ratio;
          ctx.drawImage(image,x+2+(boxW-iw)/2,oy+2+(boxH-ih)/2,iw,ih);
        } else {
          ctx.fillStyle='#f0f2f3'; ctx.font='bold 16px "Microsoft YaHei", sans-serif';
          ctx.textAlign='center'; ctx.textBaseline='middle';
          ctx.fillText(op.name || '?',x+cardW/2,oy+avatarH/2);
        }
        ctx.restore();

        // ② 技能行：独立一条，紧贴在头像正下方（不覆盖头像、不会出现在左上角）
        if (state.showSkills) {
          const pins=sortedPinned(op.id);
          if (pins.length) {
            const sy = oy + avatarH;
            ctx.save();
            roundRectPath(ctx,x+2,sy+1,cardW-4,skillH-5,7); ctx.clip();
            ctx.fillStyle='#191c1f'; ctx.fillRect(x+2,sy+1,cardW-4,skillH-5);
            ctx.restore();
            const iconSize=26, iconGap=6;
            const total=pins.length*iconSize+Math.max(0,pins.length-1)*iconGap;
            const iy = sy + (skillH-iconSize)/2 - 1;
            let sx = x+(cardW-total)/2;
            for (const skillIndex of pins) {
              const skill=op.skills && op.skills[skillIndex];
              if (!skill) { sx+=iconSize+iconGap; continue; }
              const assetPath=skill.icon || '';
              const src=(window.ARK_IMAGE_MAP && window.ARK_IMAGE_MAP[assetPath]) || resolveImg(assetPath);
              const skillImage=await loadCanvasImage(src);
              if (skillImage) {
                ctx.save();
                roundRectPath(ctx,sx,iy,iconSize,iconSize,5); ctx.clip();
                ctx.drawImage(skillImage,sx,iy,iconSize,iconSize);
                ctx.restore();
              } else {
                ctx.fillStyle='#303438';
                roundRectPath(ctx,sx,iy,iconSize,iconSize,5); ctx.fill();
                ctx.save();
                ctx.fillStyle='#ffae00'; ctx.font='bold 13px sans-serif';
                ctx.textAlign='center'; ctx.textBaseline='middle';
                ctx.fillText(String(skillIndex+1),sx+iconSize/2,iy+iconSize/2);
                ctx.restore();
              }
              ctx.strokeStyle='#c99a20'; ctx.lineWidth=1.5;
              roundRectPath(ctx,sx+0.75,iy+0.75,iconSize-1.5,iconSize-1.5,5); ctx.stroke();
              sx+=iconSize+iconGap;
            }
          }
        }

        // 卡片描边
        ctx.strokeStyle='#343a40'; ctx.lineWidth=1.5;
        roundRectPath(ctx,x+0.75,oy+0.75,cardW-1.5,cardH-1.5,9); ctx.stroke();
      }
      y+=h;
    }
    ctx.fillStyle='#17191b'; ctx.fillRect(0,y,contentW,footerH+pad);
    ctx.fillStyle='#ffae00'; ctx.font='bold 14px "Microsoft YaHei", sans-serif';
    ctx.textAlign='left'; ctx.textBaseline='alphabetic';
    ctx.fillText('备注',pad,y+26);
    ctx.fillStyle='#d0d4d7'; ctx.font='13px "Microsoft YaHei", sans-serif';
    noteLines.forEach((line,i)=>ctx.fillText(line,pad,y+50+i*26,contentW-pad*2));
    ctx.fillStyle='#737a80'; ctx.font='11px sans-serif'; ctx.fillText('个人整理 · 排名不代表官方观点',pad,totalH-12);
    canvas.toBlob(blob => {
      if (!blob) { alert('图片生成失败。请检查头像/技能图片是否可加载。'); return; }
      const url=URL.createObjectURL(blob), a=document.createElement('a');
      a.href=url; a.download=(title.replace(/[\\/:*?"<>|]/g,'_')||'干员排行榜')+'.png';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1500);
    },'image/png');
  }

  function wrapCanvasText(text, maxChars) {
    const chars=Array.from(String(text||'')); const lines=[];
    if (!chars.length) return ['（无备注）'];
    for(let i=0;i<chars.length;i+=maxChars) lines.push(chars.slice(i,i+maxChars).join(''));
    return lines;
  }

  // ---------------------------------------------------------------- 事件绑定

  function bindGlobalEvents() {
    const titleInput = $('#ranking-title');
    // 标题输入框 = 当前榜单的名字（同时也是导出图片的标题）
    titleInput.addEventListener('input', () => {
      curBoard().name = titleInput.value;
      saveBoards();
      const active = $('#board-tabs .board-tab.active .board-tab-name');
      if (active) active.textContent = titleInput.value || '未命名榜单';
    });
    titleInput.addEventListener('change', () => {
      const next = titleInput.value.trim() || '未命名榜单';
      curBoard().name = next;
      titleInput.value = next;
      saveBoards();
      renderBoardTabs();
    });
    $('#export-ranking').addEventListener('click', exportRankingImage);
    const grid = $('#grid');
    grid.addEventListener('click', (e) => {
      if (Date.now() < suppressClickUntil) return;   // 刚拖完，忽略这次点击
      const card = e.target.closest('.op-card');
      if (!card) return;
      const op = state.byId.get(card.dataset.id);
      if (!op) return;
      if (e.ctrlKey || e.metaKey) { window.open(card.dataset.prtsUrl, '_blank'); return; }
      openSkillModal(op.id);
    });

    grid.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('.op-card');
      if (!card) return;
      e.preventDefault();
      const op = state.byId.get(card.dataset.id);
      if (op) showContextMenu(e.clientX, e.clientY, op, {});
    });

    // 关掉浏览器自带的图片拖拽，避免和我们的指针拖拽打架
    grid.addEventListener('dragstart', (e) => e.preventDefault());
    document.addEventListener('dragstart', (e) => {
      if (e.target.closest && e.target.closest('.op-card, .tier-slot')) e.preventDefault();
    });

    // 统一的拖拽入口（卡片 / 左侧梯度头像都用它）
    document.addEventListener('pointerdown', onPointerDown);
    // 拖拽时禁止选中文字
    document.addEventListener('selectstart', (e) => { if (dragState && dragState.started) e.preventDefault(); });

    const searchInput = $('#search-input');
    searchInput.addEventListener('input', () => {
      state.search = searchInput.value;
      saveStore('search', state.search);
      renderGrid();
    });

    $('#reset-filters').addEventListener('click', () => {
      state.filters = { professions: [], rarities: [] };
      state.search = '';
      searchInput.value = '';
      saveStore('filters', state.filters);
      saveStore('search', '');
      syncFilterButtons();
      renderGrid();
    });

    $('#toggle-filters').addEventListener('click', () => {
      const box = $('#filter-chips');
      box.classList.toggle('hidden');
      $('#toggle-filters').textContent = box.classList.contains('hidden') ? '筛选 ▾' : '筛选 ▴';
    });

    // 「带技能」：排行榜头像下方是否显示已固定的技能
    $('#opt-show-skills').addEventListener('change', (e) => {
      state.showSkills = e.target.checked;
      saveStore('showSkills', state.showSkills);
      renderSidebar();
    });

    // 「不重复」：每个干员只能待在一个梯度行里
    $('#opt-unique').addEventListener('change', (e) => {
      state.unique = e.target.checked;
      saveStore('unique', state.unique);
      if (state.unique) {
        dedupeAllRows();
        saveBoards();
      }
      renderSidebar();
      renderGrid();
    });

    $('#add-row-btn').addEventListener('click', () => {
      state.rows.push({ title: '新分组', ops: [] });
      saveBoards();
      renderSidebar();
    });

    $('#skill-modal').addEventListener('click', (e) => {
      if (e.target.dataset.close === '1') closeSkillModal();
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#context-menu')) hideContextMenu();
    });
    document.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('.op-card') && !e.target.closest('.tier-slot')) hideContextMenu();
    });
    window.addEventListener('blur', hideContextMenu);
    grid.addEventListener('scroll', hideContextMenu);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('#context-menu').classList.contains('hidden')) { hideContextMenu(); return; }
        if (!$('#skill-modal').classList.contains('hidden')) { closeSkillModal(); return; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        $('#search-input').focus();
        $('#search-input').select();
      }
    });

    $('#banner-close').addEventListener('click', () => {
      $('#update-banner').classList.add('hidden');
      document.documentElement.style.setProperty('--banner-h', '0px');
    });
  }

  // ---------------------------------------------------------------- 配置码事件

  function bindConfigEvents() {
    $('#export-config').addEventListener('click', () => openCfgModal('export'));
    $('#import-config').addEventListener('click', () => openCfgModal('import'));
    $('#save-as-default').addEventListener('click', () => {
      if (!confirm('会下载一份 6.4 MB 的单文件版（ak-tools.html），并把你当前的榜单配置固化进去。\n可以离线双击打开，也可以随手分享给别人。继续？')) return;
      downloadWithDefaultConfig();
    });

    $('#cfg-modal').addEventListener('click', (e) => {
      if (e.target && e.target.dataset && e.target.dataset.close) closeCfgModal();
    });

    $('#cfg-copy').addEventListener('click', () => {
      const ta = $('#cfg-text');
      const text = ta.value;
      const done = () => setCfgMsg('已复制到剪贴板（' + text.length + ' 个字符）', true);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => {
          ta.focus(); ta.select();
          setCfgMsg('浏览器不让自动复制，已帮你选中，按 Ctrl+C 即可', false);
        });
      } else {
        ta.focus(); ta.select();
        setCfgMsg('已帮你选中，按 Ctrl+C 即可', false);
      }
    });

    $('#cfg-download').addEventListener('click', () => {
      downloadBlob($('#cfg-text').value, '干员榜单配置码.txt', 'text/plain;charset=utf-8');
    });

    $('#cfg-apply').addEventListener('click', () => {
      const code = $('#cfg-text').value.trim();
      if (!code) { setCfgMsg('请先粘贴配置码', false); return; }
      let cfg;
      try { cfg = decodeConfig(code); } catch (e) { setCfgMsg('导入失败：' + e.message, false); return; }
      const names = cfg.boards.map((b) => b.name).join('、');
      if (!confirm('即将导入 ' + cfg.boards.length + ' 个榜单（' + names + '），覆盖当前浏览器里的全部配置。继续？')) return;
      applyConfig(cfg);
      setCfgMsg('已导入 ' + cfg.boards.length + ' 个榜单', true);
      setTimeout(closeCfgModal, 700);
    });
  }

  // ---------------------------------------------------------------- 启动

  async function main() {
    const baked = bakedDefaults();

    // 筛选条件属于「临时视图状态」，不参与默认值，避免一打开就只剩几个干员
    state.filters = loadStore('filters', { professions: [], rarities: [] }) || { professions: [], rarities: [] };
    if (!Array.isArray(state.filters.professions)) state.filters.professions = [];
    if (!Array.isArray(state.filters.rarities)) state.filters.rarities = [];
    state.search = loadStore('search', '') || '';

    // 榜单：存过就用存的；没存过就用固化在文件里的默认配置码 / 老存档 / 内置梯队
    const storedBoards = loadStore('boards', null);
    let cfgDefaults = null;
    if (Array.isArray(storedBoards) && storedBoards.length) {
      state.boards = storedBoards.map((b, i) => ({
        id: b.id || newBoardId(),
        name: b.name || ('榜单 ' + (i + 1)),
        rows: Array.isArray(b.rows) ? b.rows : [],
        pinned: normalizePinned(b.pinned || {}),
      }));
      state.activeBoard = Math.max(0, Math.min(state.boards.length - 1, Number(loadStore('activeBoard', 0)) || 0));
      syncActiveBoard();
    } else {
      const init = buildInitialBoards();
      state.boards = init.boards;
      state.activeBoard = 0;
      cfgDefaults = init;
      syncActiveBoard();
      saveBoards();
    }

    // 两个开关：没存过就用固化配置 / defaults.js 里的
    const swDefault = cfgDefaults ? !!cfgDefaults.showSkills : (baked ? !!baked.showSkills : true);
    const uqDefault = cfgDefaults ? !!cfgDefaults.unique : !!(baked && baked.unique);
    state.showSkills = loadStore('showSkills', swDefault) === true;
    state.unique = loadStore('unique', uqDefault) === true;
    $('#ranking-title').value = curBoard().name;

    const ok = await loadData();
    if (!ok) return;

    $('#search-input').value = state.search;
    $('#opt-show-skills').checked = state.showSkills;
    $('#opt-unique').checked = state.unique;
    if (state.unique) dedupeAllRows();
    buildFilterButtons();
    syncFilterButtons();
    renderBoardTabs();
    renderSidebar();
    renderGrid();
    bindConfigEvents();
    bindGlobalEvents();
    initUpdate();
  }

  document.addEventListener('DOMContentLoaded', main);
})();
