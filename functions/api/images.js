/**
 * /api/images —— 把 PRTS 的图片抓下来存进 R2（管理员专用）
 *
 * 为什么需要它：media.prts.wiki 托管在国内（响应头 Server: Tengine、Via: ...l2cn9026），
 * 从 Cloudflare 边缘出境取图很慢。抓一次存进 R2 之后，所有访客都从
 * https://img.ark.sawakso.com/... 读取——走 Cloudflare CDN、同源、可长期缓存。
 *
 * 用【原生 R2 绑定】而不是 S3 密钥，原因很实在：
 *   · 免费版 CPU 只有 10ms/请求，S3 的 SigV4 签名要跑 SHA256 + 多轮 HMAC，很吃 CPU
 *   · 绑定调用不占「50 个子请求/请求」的额度，S3 走的是公网 fetch，要占
 *   · 绑定不用管密钥轮换，也不会把凭证带进运行时代码
 * 所以后台只需要加一个绑定：R2 bucket `ark-images` → 变量名 `ARK_IMAGES`
 *
 * 请求体（一次最多 6 个，跟 Workers 的并发连接上限对齐）：
 *   { items: [ { key: 'img/ab12cd.png', src: 'https://media.prts.wiki/...' }, ... ] }
 *
 * 响应：
 *   成功 → { ok:true, done:3, failed:[{key,error}], base:'https://img.ark.sawakso.com', ms:1234 }
 *   失败 → { ok:false, error:'...' } + 状态码
 *
 * 需要：环境变量 UPDATE_PASSWORD、R2 绑定 ARK_IMAGES
 */

const IMAGE_BATCH = 6;        // 并发上限（Workers 每请求最多 6 条同时出站的连接）
const IMG_TIMEOUT = 25000;    // 单张图的超时：跨境取图很慢，给足
const IMG_RETRIES = 1;

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
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

function contentTypeFor(key, fallback) {
  const m = /\.([a-z0-9]+)(?:\?|$)/i.exec(key || '');
  const byExt = m ? EXT_TYPE[m[1].toLowerCase()] : null;
  return byExt || fallback || 'application/octet-stream';
}

/** 抓一张图（带超时和一次重试） */
async function grab(src) {
  for (let i = 0; i <= IMG_RETRIES; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IMG_TIMEOUT);
    try {
      const res = await fetch(src, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ark-tools/1.7; +https://ark.sawakso.com)' },
        signal: ctrl.signal,
      });
      if (res.ok && res.body) return res;
      if (i === IMG_RETRIES) return { error: 'HTTP ' + res.status };
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message)));
      if (i === IMG_RETRIES) {
        return { error: aborted ? '取图超时（' + IMG_TIMEOUT / 1000 + 's）' : String(e && e.message ? e.message : e) };
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
  if (!env.ARK_IMAGES) {
    return json({
      ok: false,
      error: '没有绑定 R2。请在 Pages 项目设置里添加 R2 存储桶绑定：变量名 ARK_IMAGES → 存储桶 ark-images',
    }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
  }

  const items = Array.isArray(body.items) ? body.items.slice(0, IMAGE_BATCH) : [];
  if (!items.length) return json({ ok: false, error: 'items 为空' }, 400);

  const started = Date.now();
  const failed = [];

  // 并发抓 + 写；单个失败不影响其他
  await Promise.all(items.map(async (it) => {
    const key = typeof it.key === 'string' ? it.key.replace(/^\/+/, '') : '';
    const src = typeof it.src === 'string' ? it.src : '';
    if (!key || !/^https:\/\//i.test(src)) {
      failed.push({ key: key || '(空)', error: 'key 或 src 不合法' });
      return;
    }
    const res = await grab(src);
    if (res.error) {
      failed.push({ key, error: res.error });
      return;
    }
    try {
      // 流式写入，不把整张图的字节读进内存
      await env.ARK_IMAGES.put(key, res.body, {
        httpMetadata: {
          contentType: contentTypeFor(key, res.headers.get('content-type')),
          // 对象名是文件名的 md5，内容不会变 → 让 CF 边缘和浏览器都能长期缓存
          cacheControl: 'public, max-age=31536000, immutable',
        },
      });
    } catch (e) {
      failed.push({ key, error: '写入 R2 失败：' + (e && e.message ? e.message : String(e)) });
    }
  }));

  return json({
    ok: true,
    done: items.length - failed.length,
    failed,
    base: 'https://img.ark.sawakso.com',
    ms: Date.now() - started,
  });
}

export async function onRequestGet() {
  return json({ ok: true, hint: '这是图片镜像接口，需要用 POST 调用', needBinding: 'ARK_IMAGES' });
}
