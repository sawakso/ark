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
 * 一次性抓 440 名干员 + 上千张图必然爆掉。所以拆成「一步一请求」，
 * 由前端循环调用，解析和汇总都放在浏览器里做（浏览器没有任何 CPU 限制）。
 *
 * 请求体：
 *   { step: 'list',   offset: 0 }       抓一页干员（100 条，服务端只花 1 个子请求）
 *   { step: 'skills', titles: [..] }    抓这些页面（≤10 个）的 wikitext，用于解析技能名
 *
 * 响应：
 *   · 成功 → 直接把 PRTS 的 JSON 原样返回（HTTP 200）
 *   · 失败 → { ok:false, error:'...' } + 对应状态码
 *
 * 需要：环境变量 UPDATE_PASSWORD
 */

const PRTS_API = 'https://prts.wiki/api.php';
const UA = 'ark-tools/1.5 (+https://ark.sawakso.com)';

const PAGE_SIZE = 100;      // 一页取多少名干员（前端用它判断是不是最后一页）
const MAX_TITLES = 10;      // 一次最多取多少个页面的 wikitext
const PRTS_TIMEOUT = 12000; // PRTS 偶尔很慢，给自己留个上限，别把请求挂死

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

/** 带超时和 UA 的 fetch —— PRTS 会看 UA，不带就容易被掐 */
async function prts(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PRTS_TIMEOUT);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal,
      cf: { cacheTtl: 0 },
    });
  } finally {
    clearTimeout(timer);
  }
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

  // ---------------------------------------------------------------- 干员列表
  if (step === 'list') {
    const offset = Math.max(0, parseInt(body.offset, 10) || 0);
    const query =
      '[[干员id::+]]|?干员id|?干员名|?干员外文名|?职业|?稀有度|?子职业|?位置' +
      '|limit=' + PAGE_SIZE + '|offset=' + offset;
    const url = PRTS_API + '?action=ask&format=json&query=' + encodeURIComponent(query);

    let res;
    try {
      res = await prts(url);
    } catch (e) {
      return json({ ok: false, error: '请求 PRTS 失败：' + e.message }, 502);
    }
    if (!res.ok) {
      return json({ ok: false, error: 'PRTS 返回 HTTP ' + res.status }, 502);
    }
    // 原样透传，服务端不做一点解析
    const text = await res.text();
    return new Response(text, {
      status: 200,
      headers: Object.assign({}, JSON_HEADERS, { 'X-Ark-Offset': String(offset), 'X-Ark-PageSize': String(PAGE_SIZE) }),
    });
  }

  // ---------------------------------------------------------------- 技能名
  if (step === 'skills') {
    const titles = Array.isArray(body.titles) ? body.titles.filter((t) => typeof t === 'string' && t).slice(0, MAX_TITLES) : [];
    if (!titles.length) return json({ ok: false, error: 'titles 为空' }, 400);

    const url =
      PRTS_API + '?action=query&format=json&formatversion=2&prop=revisions' +
      '&rvprop=content&rvslots=main&titles=' + encodeURIComponent(titles.join('|'));

    let res;
    try {
      res = await prts(url);
    } catch (e) {
      return json({ ok: false, error: '请求 PRTS 失败：' + e.message }, 502);
    }
    if (!res.ok) {
      return json({ ok: false, error: 'PRTS 返回 HTTP ' + res.status }, 502);
    }
    const text = await res.text();
    return new Response(text, { status: 200, headers: JSON_HEADERS });
  }

  return json({ ok: false, error: "不认识的 step：" + step + "（支持 list / skills）" }, 400);
}

// 方便本地直接用浏览器看一眼接口通不通
export async function onRequestGet() {
  return json({
    ok: true,
    hint: '这是管理员抓取接口，需要用 POST 调用',
    steps: ['list', 'skills'],
  });
}
