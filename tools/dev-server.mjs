/**
 * 零依赖本地测试服务器
 *
 *   node tools/dev-server.mjs
 *   node tools/dev-server.mjs --port 8890 --password dev123
 *
 * 它和线上几乎一致的地方：
 *   · 真的去加载并执行 functions/api/*.js（不是模拟那层逻辑）
 *   · 真的把 _headers 里的缓存头应用到响应上
 *   · /api/ 的鉴权、错误码、content-type 都和线上走同一份代码
 *
 * 唯一模拟的是 KV —— 用一个内存 Map 顶着，重启即清空，不会碰到线上数据。
 *
 * 为什么不用 wrangler：wrangler 需要你在 wrangler.toml 里填真实的 KV namespace id，
 * 而且首次要下载几十 MB。等你拿到 id、想验证真实 KV 行为时再用它（见 README）。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', 8890));
// 密码优先级：命令行 --password > .dev.vars > 默认值
let PASSWORD = arg('password', '');
if (!PASSWORD) {
  const devVars = path.join(ROOT, '.dev.vars');
  if (fs.existsSync(devVars)) {
    const m = fs.readFileSync(devVars, 'utf8').match(/^\s*UPDATE_PASSWORD\s*=\s*"?([^"\r\n]*)"?/m);
    if (m) PASSWORD = m[1].trim();
  }
}
if (!PASSWORD) PASSWORD = 'dev123';

// ---------------------------------------------------------------- 加载 Functions
const TMP = path.join(HERE, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

async function loadFunction(file) {
  const src = path.join(ROOT, 'functions', 'api', file);
  const dst = path.join(TMP, file.replace(/\.js$/, '.mjs'));
  fs.copyFileSync(src, dst);
  return import(pathToFileURL(dst).href);
}

const fnData = await loadFunction('data.js');
const fnFetch = await loadFunction('fetch-prts.js');

// ---------------------------------------------------------------- 假 KV
const store = new Map();
const stats = { reads: 0, writes: 0 };

const env = {
  UPDATE_PASSWORD: PASSWORD,
  ARK_DATA: {
    async get(key) {
      stats.reads++;
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      stats.writes++;
      store.set(key, value);
    },
  },
};

// ---------------------------------------------------------------- _headers
/** 极简版 Pages _headers 解析：支持 /* 和 /* 前缀匹配，后面的规则覆盖前面的 */
function loadHeaderRules() {
  const file = path.join(ROOT, '_headers');
  if (!fs.existsSync(file)) return [];
  const rules = [];
  let current = null;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      current = { pattern: raw.trim(), headers: {} };
      rules.push(current);
    } else if (current) {
      const idx = raw.indexOf(':');
      if (idx > 0) current.headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
    }
  }
  return rules;
}

function matchPattern(pattern, pathname) {
  if (pattern === '/*') return true;
  if (pattern.endsWith('/*')) return pathname.startsWith(pattern.slice(0, -1));
  return pathname === pattern;
}

function headersFor(pathname) {
  const out = {};
  for (const rule of loadHeaderRules()) {
    if (matchPattern(rule.pattern, pathname)) Object.assign(out, rule.headers);
  }
  return out;
}

// ---------------------------------------------------------------- 静态文件
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  let p = decodeURIComponent(pathname);
  if (p === '/') p = '/index.html';

  if (p.startsWith('/standalone/')) {
    // standalone 是个目录，指向里面的单文件版
    p = '/standalone/ak-tools.html';
  }

  const file = path.resolve(ROOT, '.' + p);
  const rootAbs = path.resolve(ROOT);
  if (!file.startsWith(rootAbs) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 找不到：' + p);
  }

  const body = fs.readFileSync(file);
  const extra = headersFor(p);
  res.writeHead(200, Object.assign({
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': body.length,
  }, extra));
  res.end(body);
}

// ---------------------------------------------------------------- 主服务
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // 测试用的观察口：看看 KV 里现在有什么
  if (url.pathname === '/__dev/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    const raw = store.get('operators') || '';
    let count = 0;
    try { count = raw ? JSON.parse(raw).operators.length : 0; } catch (e) {}
    return res.end(JSON.stringify({ ...stats, kvHasOperators: store.has('operators'), kvBytes: raw.length, kvOperatorCount: count }, null, 2));
  }
  if (url.pathname === '/__dev/reset') {
    store.clear();
    stats.reads = 0;
    stats.writes = 0;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, message: '假 KV 已清空' }));
  }

  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const request = new Request(`http://127.0.0.1:${PORT}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: body.length ? body : undefined,
    });

    try {
      let out;
      if (url.pathname === '/api/data') {
        out = req.method === 'GET' ? await fnData.onRequestGet({ request, env }) : await fnData.onRequestPost({ request, env });
      } else if (url.pathname === '/api/fetch-prts') {
        out = req.method === 'GET' ? await fnFetch.onRequestGet({ request, env }) : await fnFetch.onRequestPost({ request, env });
      } else {
        out = new Response(JSON.stringify({ ok: false, error: '没有这个接口：' + url.pathname }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      const buf = Buffer.from(await out.arrayBuffer());
      const outHeaders = {};
      out.headers.forEach((v, k) => { outHeaders[k] = v; });
      outHeaders['Content-Length'] = buf.length;
      res.writeHead(out.status, outHeaders);
      res.end(buf);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e && e.stack ? e.stack : e) }));
    }
    return;
  }

  serveStatic(res, url.pathname);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  明日方舟干员选择器 · 本地测试');
  console.log('  ────────────────────────────────────────');
  console.log('  页面           http://127.0.0.1:' + PORT + '/');
  console.log('  单文件版       http://127.0.0.1:' + PORT + '/standalone/');
  console.log('  管理员密码     ' + PASSWORD);
  console.log('  KV 观察口      http://127.0.0.1:' + PORT + '/__dev/stats');
  console.log('  清空假 KV      http://127.0.0.1:' + PORT + '/__dev/reset');
  console.log('  ────────────────────────────────────────');
  console.log('  KV 是内存模拟的，重启就清空，不会碰到线上数据');
  console.log('');
});
