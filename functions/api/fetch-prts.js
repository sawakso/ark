/**
 * /api/fetch-prts —— 管理员专用的 PRTS 抓取代理（分批）
 *
 * 设计要点：这个函数**只做三件事**——验密码、拼 URL、把 PRTS 的原始响应透传回去。
 * 它不做 JSON 解析、不做正则、不做数据加工。
 *
 * 为什么这么抠？Cloudflare Workers / Pages Functions 免费版的硬限制是：
 *   · CPU 时间    10ms / 请求（注意是毫秒，不是秒；超了直接 Error 1102）
 *   · 子请求      50 个 / 请求
 *   · KV 写入     1000 次 / 天
 * 一次性抓 440 名干员必然爆掉。所以拆成「一步一请求」，
 * 由前端循环调用，解析和汇总都放在浏览器里做（浏览器没有任何 CPU 限制）。
 *
 * ⚠️ 已知风险：prts.wiki 托管在国内（阿里云 CDN，响应头里能看到 cache4.cn6144），
 * 国内直连 ~0.15s，但从 Cloudflare 边缘出境访问可能很慢甚至超时。
 * 所以这里把超时放宽到 25 秒、并且失败自动重试一次；如果还是不通，
 * 前端会退回到「浏览器直接 JSONP 抓」的方式。
 *
 * 请求体：
 *   { step: 'ping' }                    测连通性，返回耗时（诊断用）
 *   { step: 'list',   offset: 0 }       抓一页干员（100 条，服务端只花 1 个子请求）
 *   { step: 'skills', titles: [..] }    抓这些页面（≤10 个）的 wikitext，用于解析技能名
 *
 * 响应：
 *   · 成功 → 直接把 PRTS 的 JSON 原样返回（HTTP 200）
 *   · 失败 → { ok:false, error:'...', ms: 耗时 } + 对应状态码
 *
 * 需要：环境变量 UPDATE_PASSWORD
 */

const PRTS_API = 'https://prts.wiki/api.php';
const UA = 'Mozilla/5.0 (compatible; ark-tools/1.6; +https://ark.sawakso.com)';

const PAGE_SIZE = 100;        // 一页取多少名干员（前端用它判断是不是最后一页）
const MAX_TITLES = 10;        // 一次最多取多少个页面的 wikitext
const PRTS_TIMEOUT = 25000;   // 单次请求超时：跨境的 PRTS 很慢，12 秒不够
const PRTS_RETRIES = 1;       // 失败后再试的次数（免费版没有 CPU 压力，等待不计 CPU）

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function authorized(request, env) {
  const got = request.headers.get('Authorization') || '';
  const want = env.UPDATE_PASSWORD;
  if (!want) return false;
  if (got.length !== want.length + 7) return false;
  return got === 'Bearer ' + want;
}

/** 单次带超时的请求；返回 { res } 或 { error: '...' } */
async function once(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PRTS_TIMEOUT);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: ctrl.signal,
    });
    return { res };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message)));
    return {
      error: aborted
        ? '请求 PRTS 超时（' + PRTS_TIMEOUT / 1000 + 's）。prts.wiki 托管在国内，Cloudflare 边缘出境访问可能很慢或被限制。'
        : '请求 PRTS 失败：' + (e && e.message ? e.message : String(e)),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 带重试的请求。等待网络不计入 CPU，所以重试是安全的。 */
async function prts(url) {
  const started = Date.now();
  let last = null;
  for (let i = 0; i <= PRTS_RETRIES; i++) {
    const r = await once(url);
    if (r.res && r.res.ok) return { res: r.res, ms: Date.now() - started };
    last = r.error || ('PRTS 返回 HTTP ' + r.res.status);
    if (i < PRTS_RETRIES) await new Promise((res) => setTimeout(res, 400));
  }
  return { error: last, ms: Date.now() - started };
}

export async function onRequestPost({ request, env }) {
  if (!authorized(request, env)) {
    return json({ ok: false, error: '未授权（密码不对或没有配置 UPDATE_PASSWORD）' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
  }

  const step = body && body.step;

  // ---------------------------------------------------------------- 连通性诊断
  if (step === 'ping') {
    const url = PRTS_API + '?action=query&format=json&meta=siteinfo';
    const r = await prts(url);
    if (r.error) return json({ ok: false, error: r.error, ms: r.ms }, 502);
    const text = await r.res.text();
    return json({ ok: true, ms: r.ms, bytes: text.length, from: 'cloudflare-edge' });
  }

  // ---------------------------------------------------------------- 干员列表
  if (step === 'list') {
    const offset = Math.max(0, parseInt(body.offset, 10) || 0);
    const query =
      '[[干员id::+]]|?干员id|?干员名|?干员外文名|?职业|?稀有度|?子职业|?位置' +
      '|limit=' + PAGE_SIZE + '|offset=' + offset;
    const url = PRTS_API + '?action=ask&format=json&query=' + encodeURIComponent(query);

    const r = await prts(url);
    if (r.error) return json({ ok: false, error: r.error, ms: r.ms }, 502);

    const text = await r.res.text();   // 原样透传，服务端不做一点解析
    return new Response(text, {
      status: 200,
      headers: Object.assign({}, JSON_HEADERS, {
        'X-Ark-Offset': String(offset),
        'X-Ark-PageSize': String(PAGE_SIZE),
        'X-Ark-Ms': String(r.ms),
      }),
    });
  }

  // ---------------------------------------------------------------- 技能名
  if (step === 'skills') {
    const titles = Array.isArray(body.titles)
      ? body.titles.filter((t) => typeof t === 'string' && t).slice(0, MAX_TITLES)
      : [];
    if (!titles.length) return json({ ok: false, error: 'titles 为空' }, 400);

    const url =
      PRTS_API + '?action=query&format=json&formatversion=2&prop=revisions' +
      '&rvprop=content&rvslots=main&titles=' + encodeURIComponent(titles.join('|'));

    const r = await prts(url);
    if (r.error) return json({ ok: false, error: r.error, ms: r.ms }, 502);

    const text = await r.res.text();
    return new Response(text, {
      status: 200,
      headers: Object.assign({}, JSON_HEADERS, { 'X-Ark-Ms': String(r.ms) }),
    });
  }

  return json({ ok: false, error: '不认识的 step：' + step + '（支持 ping / list / skills）' }, 400);
}

// 方便本地直接用浏览器看一眼接口通不通
export async function onRequestGet() {
  return json({
    ok: true,
    hint: '这是管理员抓取接口，需要用 POST 调用',
    steps: ['ping', 'list', 'skills'],
  });
}
