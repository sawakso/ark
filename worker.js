/**
 * Workers 入口（当项目以 Worker 而不是 Pages 部署时用它）
 *
 * 背景：Cloudflare 现在把新项目默认建成 Worker，而 `functions/` 目录是 **Pages 专有的约定**，
 * Worker 不认它。所以这里写一个极薄的路由，把请求转给同样那几个 handler，
 * 让 functions/api/*.js 的代码在两种部署方式下都能复用，不需要维护两份。
 *
 * 部署配置见 wrangler.workers.jsonc：
 *   main    = worker.js
 *   assets  = { directory: ".", binding: "ASSETS" }
 *
 * 匹配顺序：先看是不是 /api/*，不是就交给静态资源。
 * （静态资源默认优先于 Worker 脚本，但 /api/xxx 不对应任何文件，所以一定会落到这里。）
 */

import * as apiData from './functions/api/data.js';
import * as apiFetchPrts from './functions/api/fetch-prts.js';
import * as apiImages from './functions/api/images.js';

const ROUTES = {
  '/api/data': apiData,
  '/api/fetch-prts': apiFetchPrts,
  '/api/images': apiImages,
};

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 去掉结尾斜杠，容忍 /api/data/ 这种写法
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    const mod = ROUTES[path];

    if (mod) {
      const handler = request.method === 'GET' ? mod.onRequestGet : mod.onRequestPost;
      if (typeof handler !== 'function') {
        return json({ ok: false, error: '这个接口不支持 ' + request.method }, 405);
      }
      try {
        return await handler({ request, env, ctx });
      } catch (e) {
        // 兜住异常，别把 Worker 的原始堆栈暴露给调用方
        return json({ ok: false, error: '接口内部错误：' + (e && e.message ? e.message : String(e)) }, 500);
      }
    }

    // 不是接口 → 交给静态资源
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
