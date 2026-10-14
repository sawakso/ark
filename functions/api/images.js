/**
 * /api/images —— 把 PRTS 的图片写进 R2（管理员专用）
 *
 * 两种工作模式：
 *
 *  ①【推荐】浏览器直传（Content-Type 不是 JSON 时）
 *     管理员浏览器先把图下下来（media.prts.wiki 带 Access-Control-Allow-Origin: *，
 *     浏览器能直接取），再把原始字节 POST 过来，这里只负责往 R2 写。
 *
 *     为什么这么做：media.prts.wiki 和 prts.wiki 一样托管在国内
 *     （响应头 Server: Tengine、Via: ...l2cn9026），让 Cloudflare 边缘去取图
 *     同样会超时——之前「抓取失败：The operation was aborted」就是这个原因。
 *     换成浏览器取图，走的是管理员自己的网络（国内直连 ~0.05s），绕开跨境链路。
 *
 *  ②【兜底】服务端代抓（Content-Type: application/json）
 *     真要 Cloudflare 自己去取图时用，但前面说了——多半会超时。
 *
 * 用【原生 R2 绑定】而不是 S3 密钥：
 *   · 免费版 CPU 只有 10ms/请求，S3 的 SigV4 签名要跑 SHA256 + 多轮 HMAC，很吃 CPU
 *   · 绑定调用不占「50 个子请求/请求」的额度
 *   · 不用管密钥轮换，凭证也不会出现在运行时代码里
 * 后台只需要一个绑定：R2 bucket `ark-images` → 变量名 `ARK_IMAGES`
 * （用 wrangler.workers.jsonc 部署的话，绑定已经写在配置里了）
 *
 * 请求：
 *   模式①  POST /api/images
 *          Header: Authorization: Bearer <密码>
 *                  X-Ark-Key: img/xxxx.png        ← R2 对象名
 *                  Content-Type: image/png        ← 图片类型
 *          Body:   图片原始字节
 *
 *   模式②  POST /api/images   Content-Type: application/json
 *          Body: {"items":[{"key":"img/xxxx.png","src":"https://media.prts.wiki/..."}]}
 *          一次最多 6 个（对齐 Workers 的 6 条并发出站连接）
 *
 *  诊断  GET /api/images?test=1     让 Cloudflare 边缘试着取一张 PRTS 图，报耗时和错误
 *
 * 响应：{ ok, done, failed:[{key,error}], base, ms }
 */

const IMAGE_BATCH = 6;        // 服务端代抓的并发上限
const IMG_TIMEOUT = 25000;    // 单张图超时：跨境取图很慢，给足
const IMG_RETRIES = 1;
const MAX_UPLOAD = 8 * 1024 * 1024;   // 单张图上限 8MB

/**
 * R2 对外读图的域名，唯一的默认值。
 * 前端以本接口返回的 base 为准，所以换域名只改这一处，
 * 或者干脆不改代码——去后台加环境变量 R2_PUBLIC_BASE。
 *
 * 注：Cloudflare 免费版通用证书只覆盖 *.sawakso.com 这一级，
 * img.ark.sawakso.com 这种二级子域没有证书，所以用的是 imgark.sawakso.com。
 */
const DEFAULT_R2_BASE = 'https://imgark.sawakso.com';

function publicBase(env) {
  const raw = env && env.R2_PUBLIC_BASE != null ? env.R2_PUBLIC_BASE : DEFAULT_R2_BASE;
  return String(raw).replace(/\/+$/, '');   // 去掉结尾斜杠，拼 key 时统一补一个
}

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

function missingBinding() {
  return json({
    ok: false,
    error: '没有绑定 R2。需要添加绑定：变量名 ARK_IMAGES → 存储桶 ark-images。'
      + '（用 wrangler.workers.jsonc 部署的话配置里已含；Pages 项目要在后台 Settings → Functions → R2 bucket bindings 加）',
  }, 500);
}

const EXT_TYPE = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
};

function contentTypeFor(key, fallback) {
  const m = /\.([a-z0-9]+)(?:\?|$)/i.exec(key || '');
  const byExt = m ? EXT_TYPE[m[1].toLowerCase()] : null;
  return byExt || fallback || 'application/octet-stream';
}

/** 写 R2：对象名是文件名的 md5，内容不会变 → 让边缘和浏览器都能长期缓存 */
function putR2(env, key, body, contentType) {
  return env.ARK_IMAGES.put(key, body, {
    httpMetadata: {
      contentType: contentType || contentTypeFor(key),
      cacheControl: 'public, max-age=31536000, immutable',
    },
  });
}

/** 服务端取图（带超时和一次重试） */
async function grab(src) {
  for (let i = 0; i <= IMG_RETRIES; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IMG_TIMEOUT);
    try {
      const res = await fetch(src, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ark-tools/1.8; +https://ark.sawakso.com)' },
        signal: ctrl.signal,
      });
      if (res.ok && res.body) return { res };
      if (i === IMG_RETRIES) return { error: 'PRTS 返回 HTTP ' + res.status };
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message)));
      if (i === IMG_RETRIES) {
        return {
          error: aborted
            ? '取图超时（' + IMG_TIMEOUT / 1000 + 's）—— Cloudflare 边缘访问国内的 media.prts.wiki 很慢'
            : String(e && e.message ? e.message : e),
        };
      }
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { error: '未知错误' };
}

export async function onRequestPost({ request, env }) {
  if (!authorized(request, env)) {
    return json({ ok: false, error: '未授权（密码不对或没有配置 UPDATE_PASSWORD）' }, 401);
  }
  if (!env.ARK_IMAGES) return missingBinding();

  const started = Date.now();
  const url = new URL(request.url);
  const contentType = (request.headers.get('content-type') || '').toLowerCase();

  // ============================================================ 存在性检查
  // 前端先问「这些 key 里哪些 R2 已经有了」，只传缺的那部分。
  // 全部命中的话，一次更新连一个字节都不用传。
  if (url.searchParams.get('check')) {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
    }
    const keys = (Array.isArray(body.keys) ? body.keys : [])
      .filter((k) => typeof k === 'string' && k)
      .slice(0, 500)
      .map((k) => k.replace(/^\/+/, ''));
    if (!keys.length) return json({ ok: false, error: 'keys 为空' }, 400);

    const existing = [];
    // 分批查，别一次性打出几百个并发 R2 操作
    const CHUNK = 25;
    for (let i = 0; i < keys.length; i += CHUNK) {
      await Promise.all(keys.slice(i, i + CHUNK).map(async (k) => {
        try {
          const head = await env.ARK_IMAGES.head(k);
          if (head) existing.push(k);
        } catch (e) { /* 查不到就当不存在，后面会重新传 */ }
      }));
    }
    return json({ ok: true, checked: keys.length, existing, base: publicBase(env), ms: Date.now() - started });
  }

  // ============================================================ 模式①：浏览器直传
  if (contentType.indexOf('application/json') < 0) {
    const rawKey = request.headers.get('X-Ark-Key') || request.headers.get('x-ark-key') || '';
    const key = rawKey.replace(/^\/+/, '');
    if (!key) return json({ ok: false, error: '缺少 X-Ark-Key 请求头（R2 对象名）' }, 400);

    const buf = await request.arrayBuffer();
    if (!buf.byteLength) return json({ ok: false, error: '请求体是空的' }, 400);
    if (buf.byteLength > MAX_UPLOAD) {
      return json({ ok: false, error: '单张图 ' + buf.byteLength + ' 字节，超过 8MB 上限' }, 413);
    }

    try {
      await putR2(env, key, buf, contentType);
    } catch (e) {
      return json({ ok: false, error: '写入 R2 失败：' + (e && e.message ? e.message : String(e)) }, 500);
    }
    return json({ ok: true, done: 1, failed: [], key, bytes: buf.byteLength, base: publicBase(env), ms: Date.now() - started });
  }

  // ============================================================ 模式②：服务端代抓
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
  }

  const items = Array.isArray(body.items) ? body.items.slice(0, IMAGE_BATCH) : [];
  if (!items.length) return json({ ok: false, error: 'items 为空' }, 400);

  const failed = [];

  await Promise.all(items.map(async (it) => {
    const key = typeof it.key === 'string' ? it.key.replace(/^\/+/, '') : '';
    const src = typeof it.src === 'string' ? it.src : '';
    if (!key || !/^https:\/\//i.test(src)) {
      failed.push({ key: key || '(空)', error: 'key 或 src 不合法' });
      return;
    }
    const r = await grab(src);
    if (r.error) {
      failed.push({ key, error: r.error });
      return;
    }
    try {
      // 流式写入，不把整张图的字节读进内存
      await putR2(env, key, r.res.body, contentTypeFor(key, r.res.headers.get('content-type')));
    } catch (e) {
      failed.push({ key, error: '写入 R2 失败：' + (e && e.message ? e.message : String(e)) });
    }
  }));

  return json({
    ok: true,
    done: items.length - failed.length,
    failed,
    base: publicBase(env),
    ms: Date.now() - started,
  });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  // 诊断：让 Cloudflare 边缘试着取一张 PRTS 图，看能不能通、多慢
  if (url.searchParams.get('test')) {
    if (!authorized(request, env)) return json({ ok: false, error: '未授权' }, 401);
    const src = url.searchParams.get('url')
      || 'https://media.prts.wiki/d/df/%E5%A4%B4%E5%83%8F_%E4%BC%BA%E5%A4%9C.png';
    const r = await grab(src);
    if (r.error) return json({ ok: false, stage: '下载', error: r.error, canSeeMedia: false }, 502);
    return json({ ok: true, stage: '下载', status: r.res.status, bytes: r.res.headers.get('content-length') || '未知', canSeeMedia: true });
  }

  return json({
    ok: true,
    hint: '这是图片接口，需要用 POST 调用',
    needBinding: 'ARK_IMAGES',
    hasBinding: !!env.ARK_IMAGES,
    base: publicBase(env),
  });
}
