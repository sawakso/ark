/**
 * /api/data —— 干员数据的读写口
 *
 *   GET  /api/data   任何人可读：把 KV 里的整份数据吐出去
 *   POST /api/data   仅管理员：校验密码后，把整份数据写进 KV
 *
 * 用到的 Cloudflare 资源：
 *   · KV 绑定变量名  ARK_DATA     （命名空间名是 ARK-DATA，代码里用下划线）
 *   · KV key         operators
 *   · 环境变量       UPDATE_PASSWORD
 *
 * CPU 预算提醒：免费版是 10ms/请求。这里读的时候整块透传、写的时候不解析，
 * 所以计算量几乎可以忽略，不会撞 Error 1102。
 */

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({}, JSON_HEADERS, extra),
  });
}

function authorized(request, env) {
  const got = request.headers.get('Authorization') || '';
  const want = env.UPDATE_PASSWORD;
  if (!want) return false;
  // 长度先比一下，省得每次都做完整比较
  if (got.length !== want.length + 7) return false;
  return got === 'Bearer ' + want;
}

/** 读：KV 为空时返回 {}，前端会据此降级到 assets/data.json */
export async function onRequestGet({ env }) {
  if (!env.ARK_DATA) {
    return json({
      ok: false,
      error: '没有绑定 KV。请在 Pages 项目设置里添加 KV 命名空间绑定：变量名 ARK_DATA → 命名空间 ARK-DATA',
    }, 500);
  }
  try {
    const raw = await env.ARK_DATA.get('operators');
    if (!raw) return json({});
    // 已经是完整 JSON 字符串，直接透传，避免再解析一遍浪费 CPU
    return new Response(raw, { headers: JSON_HEADERS });
  } catch (e) {
    return json({ ok: false, error: '读取 KV 失败：' + e.message }, 500);
  }
}

/** 写：只验一次密码，只做一次 JSON 校验，然后原样存进去 */
export async function onRequestPost({ request, env }) {
  if (!authorized(request, env)) {
    return json({ ok: false, error: '未授权（密码不对或没有配置 UPDATE_PASSWORD）' }, 401);
  }
  if (!env.ARK_DATA) {
    return json({ ok: false, error: '没有绑定 KV ARK_DATA' }, 500);
  }

  const text = await request.text();
  if (!text) return json({ ok: false, error: '请求体是空的' }, 400);
  if (text.length > 8 * 1024 * 1024) {
    return json({ ok: false, error: '数据过大（超过 8MB），请先精简再提交' }, 413);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return json({ ok: false, error: '提交的不是合法 JSON：' + e.message }, 400);
  }

  // 安全阀：绝不允许用空数据覆盖线上
  if (!parsed || !Array.isArray(parsed.operators) || parsed.operators.length === 0) {
    return json({ ok: false, error: 'operators 为空，拒绝写入（避免把线上数据清空）' }, 400);
  }

  try {
    await env.ARK_DATA.put('operators', text);
    return json({
      ok: true,
      count: parsed.operators.length,
      updatedAt: parsed.meta && parsed.meta.updatedAt,
    });
  } catch (e) {
    return json({ ok: false, error: '写入 KV 失败：' + e.message }, 500);
  }
}
