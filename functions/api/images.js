/**
 * /api/images —— 把图片写进 R2 / 查 R2 里有哪些图（管理员专用）
 *
 * ============================ 存取后端 ============================
 * 优先用【原生 R2 绑定】env.ARK_IMAGES；没有绑定就退回【S3 兼容接口】，
 * 用环境变量 R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ENDPOINT / R2_BUCKET。
 *
 * 为什么优先绑定：CPU 开销几乎为 0、不占「子请求」额度、不用管密钥轮换。
 * 为什么还要留 S3 兜底：绑定需要在 Pages 后台手动加**并且重新部署**才生效，
 * 这是最容易漏的一步；S3 凭证你已经在环境变量里配好了，加个兜底就不用再折腾后台。
 * 两条路都会在响应里用 store 字段标明实际用了哪个，方便排查。
 *
 * ============================ 两种上传模式 ============================
 *  ①【推荐】浏览器直传（Content-Type 不是 JSON 时）
 *     管理员浏览器先把图下下来（media.prts.wiki 带 Access-Control-Allow-Origin: *，
 *     仓库图本身同源），再把原始字节 POST 过来，这里只负责往 R2 写。
 *
 *     为什么不在服务端取图：media.prts.wiki 和 prts.wiki 一样托管在国内
 *     （响应头 Server: Tengine、Via: ...l2cn9026），让 Cloudflare 边缘去取图会超时——
 *     之前「请求 PRTS 失败：The operation was aborted」就是这个原因。
 *     浏览器取图走管理员自己的网络（国内直连 ~0.05s），绕开跨境链路。
 *
 *  ②【兜底】服务端代抓（Content-Type: application/json）
 *     真要 Cloudflare 自己去取图时用，但前面说了——多半会超时。
 *
 * 请求：
 *   模式①  POST /api/images
 *          Header: Authorization: Bearer <密码>、X-Ark-Key: img/xxxx.png、Content-Type: image/png
 *          Body:   图片原始字节
 *
 *   模式②  POST /api/images   Content-Type: application/json
 *          Body: {"items":[{"key":"img/xxxx.png","src":"https://media.prts.wiki/..."}]}
 *
 *   查存在  POST /api/images?check=1
 *          Body: {"keys":["img/a.webp", ...]}      一次最多 500 个
 *
 *   诊断    GET  /api/images           看绑定/凭证是否就绪
 *          GET  /api/images?test=1      让 Cloudflare 边缘试着取一张 PRTS 图，报耗时和错误
 */

const IMAGE_BATCH = 6;        // 服务端代抓的并发上限
const IMG_TIMEOUT = 25000;    // 单张图超时：跨境取图很慢，给足
const IMG_RETRIES = 1;
const MAX_UPLOAD = 8 * 1024 * 1024;   // 单张图上限 8MB
const CHECK_CHUNK = 25;       // 存在性检查的并发

/** R2 对外读图域名，唯一默认值。前端以接口返回的 base 为准，换域名只改这一处 */
const DEFAULT_R2_BASE = 'https://imgark.sawakso.com';

function publicBase(env) {
  const raw = env && env.R2_PUBLIC_BASE != null ? env.R2_PUBLIC_BASE : DEFAULT_R2_BASE;
  return String(raw).replace(/\/+$/, '');
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

const EXT_TYPE = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
};

function contentTypeFor(key, fallback) {
  const m = /\.([a-z0-9]+)(?:\?|$)/i.exec(key || '');
  const byExt = m ? EXT_TYPE[m[1].toLowerCase()] : null;
  return byExt || fallback || 'application/octet-stream';
}

// 对象名是文件名的 md5，内容不会变 → 让边缘和浏览器都能长期缓存
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

// ============================================================ S3 兜底（SigV4 签名）

const _enc = new TextEncoder();

function toHex(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += b.toString(16).padStart(2, '0');
  return s;
}

async function sha256Hex(data) {
  const buf = typeof data === 'string' ? _enc.encode(data) : data;
  return toHex(await crypto.subtle.digest('SHA-256', buf));
}

async function hmac(keyBytes, msg) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, typeof msg === 'string' ? _enc.encode(msg) : msg));
}

function s3Configured(env) {
  return !!(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ENDPOINT);
}

/** AWS SigV4 签名的 S3 请求。R2 的 region 固定用 auto。 */
async function s3Request(env, method, key, body, contentType) {
  const endpoint = String(env.R2_ENDPOINT).replace(/\/+$/, '');
  const host = new URL(endpoint).host;
  const bucket = env.R2_BUCKET || 'ark-images';
  const region = 'auto';
  const service = 's3';

  const now = new Date();
  const amzdate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');   // 20261015T014000Z
  const datestamp = amzdate.slice(0, 8);

  const payload = body || new ArrayBuffer(0);
  const payloadHash = await sha256Hex(payload);

  // key 逐段编码，保留 /
  const canonicalUri = '/' + bucket + '/' + key.split('/').map(encodeURIComponent).join('/');

  const canonicalHeaders =
    'host:' + host + '\n' +
    'x-amz-content-sha256:' + payloadHash + '\n' +
    'x-amz-date:' + amzdate + '\n';
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = datestamp + '/' + region + '/' + service + '/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzdate, scope, await sha256Hex(canonicalRequest)].join('\n');

  const kDate = await hmac(_enc.encode('AWS4' + env.R2_SECRET_ACCESS_KEY), datestamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));

  const authorization =
    'AWS4-HMAC-SHA256 Credential=' + env.R2_ACCESS_KEY_ID + '/' + scope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

  return fetch(endpoint + canonicalUri, {
    method,
    headers: {
      Authorization: authorization,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzdate,
      ...(method === 'PUT' ? { 'Content-Type': contentType || 'application/octet-stream' } : {}),
    },
    body: method === 'PUT' ? body : undefined,
  });
}

// ============================================================ 统一存取接口

/** 写一张图。返回实际用的后端名。 */
async function putImage(env, key, body, contentType) {
  if (env.ARK_IMAGES) {
    await env.ARK_IMAGES.put(key, body, {
      httpMetadata: { contentType: contentTypeFor(key, contentType), cacheControl: CACHE_CONTROL },
    });
    return 'binding';
  }
  if (s3Configured(env)) {
    const res = await s3Request(env, 'PUT', key, body, contentTypeFor(key, contentType));
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('S3 上传失败 HTTP ' + res.status + ' ' + t.slice(0, 180));
    }
    return 's3';
  }
  throw new Error(
    '没有可用的存储：既没有 ARK_IMAGES 绑定，也没有 R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ENDPOINT 环境变量'
  );
}

/** 查一张图在不在。存在返回 true。 */
async function hasImage(env, key) {
  if (env.ARK_IMAGES) {
    return !!(await env.ARK_IMAGES.head(key));
  }
  if (s3Configured(env)) {
    const res = await s3Request(env, 'HEAD', key, null);
    return res.ok;
  }
  return false;
}

/** 服务端取图（带超时和一次重试） */
async function grab(src) {
  for (let i = 0; i <= IMG_RETRIES; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IMG_TIMEOUT);
    try {
      const res = await fetch(src, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ark-tools/1.9; +https://ark.sawakso.com)' },
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

/** 没有任何存储可用时的统一报错 */
function noStore(env) {
  return json({
    ok: false,
    error: '没有可用的图片存储。二选一：'
      + '① 在 Pages 后台加 R2 绑定（变量名 ARK_IMAGES → 存储桶 ark-images）并重新部署；'
      + '② 确认环境变量 R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ENDPOINT / R2_BUCKET 都已配置。',
    hasBinding: false,
    hasS3: s3Configured(env),
  }, 500);
}

// ============================================================ 路由

export async function onRequestPost({ request, env }) {
  if (!authorized(request, env)) {
    return json({ ok: false, error: '未授权（密码不对或没有配置 UPDATE_PASSWORD）' }, 401);
  }
  if (!env.ARK_IMAGES && !s3Configured(env)) return noStore(env);

  const started = Date.now();
  const url = new URL(request.url);
  const contentType = (request.headers.get('content-type') || '').toLowerCase();

  // ---------------------------------------------------------- 存在性检查
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
    for (let i = 0; i < keys.length; i += CHECK_CHUNK) {
      await Promise.all(keys.slice(i, i + CHECK_CHUNK).map(async (k) => {
        try {
          if (await hasImage(env, k)) existing.push(k);
        } catch (e) { /* 查不到就当不存在，后面会重新传 */ }
      }));
    }
    return json({ ok: true, checked: keys.length, existing, store: env.ARK_IMAGES ? 'binding' : 's3', ms: Date.now() - started });
  }

  // ---------------------------------------------------------- 模式①：浏览器直传
  if (contentType.indexOf('application/json') < 0) {
    const rawKey = request.headers.get('X-Ark-Key') || request.headers.get('x-ark-key') || '';
    const key = rawKey.replace(/^\/+/, '');
    if (!key) return json({ ok: false, error: '缺少 X-Ark-Key 请求头（R2 对象名）' }, 400);

    const buf = await request.arrayBuffer();
    if (!buf.byteLength) return json({ ok: false, error: '请求体是空的' }, 400);
    if (buf.byteLength > MAX_UPLOAD) {
      return json({ ok: false, error: '单张图 ' + buf.byteLength + ' 字节，超过 8MB 上限' }, 413);
    }

    let store;
    try {
      store = await putImage(env, key, buf, contentType);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
    }
    return json({ ok: true, done: 1, failed: [], key, bytes: buf.byteLength, store, base: publicBase(env), ms: Date.now() - started });
  }

  // ---------------------------------------------------------- 模式②：服务端代抓
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
      // 流式写入，不把整张图的字节读进内存（S3 模式需要先读成 ArrayBuffer）
      if (env.ARK_IMAGES) {
        await env.ARK_IMAGES.put(key, r.res.body, {
          httpMetadata: { contentType: contentTypeFor(key, r.res.headers.get('content-type')), cacheControl: CACHE_CONTROL },
        });
      } else {
        await putImage(env, key, await r.res.arrayBuffer(), r.res.headers.get('content-type'));
      }
    } catch (e) {
      failed.push({ key, error: String(e && e.message ? e.message : e) });
    }
  }));

  return json({
    ok: true,
    done: items.length - failed.length,
    failed,
    store: env.ARK_IMAGES ? 'binding' : 's3',
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
    return json({ ok: true, stage: '下载', status: r.res.status, canSeeMedia: true });
  }

  return json({
    ok: true,
    hint: '这是图片接口，需要用 POST 调用',
    hasBinding: !!env.ARK_IMAGES,
    hasS3: s3Configured(env),
    store: env.ARK_IMAGES ? 'binding' : (s3Configured(env) ? 's3' : 'none'),
    bucket: env.R2_BUCKET || 'ark-images',
    base: publicBase(env),
  });
}
