# 明日方舟干员选择器 · ark.sawakso.com

Cloudflare Pages 上的明日方舟干员强度榜制作工具。原先是 6.7 MB 的单文件 HTML（图片全内嵌），
现在拆成了多文件 + KV 数据 + 管理员云端更新。

## 为什么拆

原版首次打开要下载 **4.75 MB**（Brotli 后），其中 95.5% 是内嵌图片，而且 `Cache-Control: max-age=0`
导致回头客每次都要重下。国内连 Cloudflare 走东京节点，白屏 5–10 秒。

拆分后首屏只需要 **约 300 KB**（压缩后约 90 KB），图片按需加载并永久缓存。

## 目录结构

```
ark-tools/
├── index.html              页面骨架（约 7.5 KB，只引用外部资源）
├── _headers                Cloudflare Pages 缓存头配置
├── wrangler.toml           本地开发用的绑定配置
├── assets/
│   ├── style.css           样式（约 22 KB）
│   ├── script.js           全部前端逻辑（约 77 KB）
│   ├── data.json           静态快照：KV 为空时的降级数据（443 名干员，约 190 KB）
│   └── images/
│       ├── avatar/*.webp   443 张干员头像（每张约 3 KB）
│       └── skill/*.webp    956 张技能图标
├── functions/
│   └── api/
│       ├── data.js         GET 读 KV / POST 管理员发布
│       └── fetch-prts.js   管理员专用的 PRTS 抓取代理（分批）
└── standalone/
    └── ak-tools.html       原单文件版（6.4 MB），供离线使用 / 随手分享
```

## 数据流

```
普通访客 ──► GET /api/data ──► Cloudflare KV (key: operators)
                                    ▲
                                    │ 一次写入
管理员 ──► 输密码 ──► 循环 POST /api/fetch-prts ──► PRTS
                      （前端组装好整份数据后 POST /api/data）
```

三级降级，任何一环挂了页面都不会白屏：

1. `/api/data` → KV（所有访客共用，最新）
2. `assets/data.json` → 随站点部署的静态快照
3. `window.ARKNIGHTS_DATA` → 内嵌快照（只有 standalone 版会走到这里）

## Cloudflare 侧已配置的资源

| 类型 | 名称 | 代码里的变量 | 用途 |
|---|---|---|---|
| KV 命名空间 | `ARK-DATA` | `env.ARK_DATA` | 存干员数据，key 固定为 `operators` |
| KV key | — | — | `operators`（整份 JSON 字符串） |
| R2 存储桶 | `ark-images` | `env.ARK_IMAGES` | 目前**没有用到**，见下方说明 |
| R2 自定义域 | `img.ark.sawakso.com` | — | 同上 |
| 环境变量 | `UPDATE_PASSWORD` | `env.UPDATE_PASSWORD` | 管理员更新密码 |
| 环境变量 | `R2_ACCESS_KEY_ID` 等 | — | 目前**没有用到** |

### 关于 R2：为什么这一版没用它

实测 `media.prts.wiki` 的图片地址可以由文件名直接算出来（`md5(文件名)`，前 1 位 / 前 2 位 / 文件名），
而且它是公开可直连的：`Access-Control-Allow-Origin: *`、`Cache-Control: max-age=1800`。

既然 PRTS 本身就在免费提供图片，再把 1400 张图下载一遍、上传 R2，只是白白消耗：

- 免费版 **子请求 50 个/请求**，1400 张图要拆成 70+ 次请求
- 免费版 **CPU 10ms/请求**，加上 S3 签名、图片流转换，很容易撞 Error 1102
- 免费版 **KV 写入 1000 次/天**，分批写中间状态会很快烧掉
- 仓库里的 443 张头像（每张 3 KB）已经随 Pages 部署，和 R2 一样都在 Cloudflare CDN 上，快慢没区别

所以当前策略是：**已知干员用仓库里的小图，新抓到的干员直接用 `media.prts.wiki` 原图**。
R2 的绑定和密钥保留了，将来真要镜像时可以直接启用。

## 管理员怎么更新数据

1. 打开 https://ark.sawakso.com
2. 点工具栏的 **⟳ 更新**
3. 输入 `UPDATE_PASSWORD` 的值
4. 等进度提示走完（首次约 10–20 秒），页面会自动刷新

更新是**全局的**：数据写进 KV 后，所有人（包括无痕窗口）下次打开都会读到新版本。
其他访客点这个按钮只会看到密码框，没有密码什么都做不了。

**密码不会**出现在前端代码、URL 或 localStorage 里，只存在当前页面的内存变量中。

### 为什么是分批的

Cloudflare Workers / Pages Functions 免费版的硬限制：

| 限制 | 免费版 | 付费版 |
|---|---|---|
| CPU 时间 | **10 ms / 请求** | 30 秒（可提到 5 分钟） |
| 子请求 | **50 个 / 请求** | 10,000 个 |
| KV 写入 | **1,000 次 / 天** | 1,000,000 次 / 月 |

注意 CPU 限制是**毫秒**，不是秒。一次性抓 440 名干员必然报 `Error 1102`。

所以 `/api/fetch-prts` 被设计成**只做鉴权 + 转发**，一行解析都不做：

- 抓列表：一页 100 条 = 1 个子请求，约 5 次调用
- 抓技能：一次 10 个页面 = 1 个子请求，只对**新干员**调用（老干员直接复用仓库里的技能名）

解析和组装全在浏览器里做（浏览器没有 CPU 限制），最后一次性 `POST /api/data`。

**结果：整个更新流程只消耗 1 次 KV 写入。**

## 本地开发

两种方式，按需要选：

### 方式一：零依赖（推荐先用这个）

```bash
cd ark-tools
node tools/dev-server.mjs                          # 默认端口 8890，密码 dev123
node tools/dev-server.mjs --port 9000 --password 自己的密码
```

不需要装任何东西。它会**真的加载并执行 `functions/api/*.js`**，也**真的会应用 `_headers`**，
只有 KV 是内存模拟的（重启即清空，碰不到线上）。

| 地址 | 用途 |
|---|---|
| `http://127.0.0.1:8890/` | 页面 |
| `http://127.0.0.1:8890/standalone/` | 单文件版 |
| `http://127.0.0.1:8890/__dev/stats` | 看假 KV 里现在有什么、读写了几次 |
| `http://127.0.0.1:8890/__dev/reset` | 清空假 KV |

### 方式二：wrangler（更接近线上）

```bash
cd ark-tools

# 1) 复制本地配置，填入自己的 KV id
cp wrangler.toml.example wrangler.toml
npx wrangler kv namespace list        # 查 id

# 2) 密码放 .dev.vars（已在 .gitignore 里）
echo 'UPDATE_PASSWORD=dev123' > .dev.vars

# 3) 起服务
npm run dev      # = wrangler pages dev . --kv ARK_DATA
```

打开 http://localhost:8788。

> **两个坑，别踩：**
> 1. `wrangler.toml` 里的 `[[kv_namespaces]]` **对 `wrangler pages dev` 不生效**（wrangler 4.151 实测，加
>    `preview_id` 也没用）。必须用命令行参数 `--kv ARK_DATA`，已经写进 `npm run dev` 了。
> 2. 仓库里**故意不放 `wrangler.toml`**（只放 `.example`）。因为只要仓库根目录存在这个文件，
>    Cloudflare Pages 就会拿它**覆盖后台的构建设置**，而且 `name` 必须和 Pages 项目名完全一致，
>    否则部署直接报错。线上配置全部在后台做，更省事也更安全。

## 部署

仓库：https://github.com/sawakso/ark （推 `main` 即自动部署）

### 第一次接 Pages 时要在后台填的

| 位置 | 配置项 | 值 |
|---|---|---|
| Build configuration | Framework preset | None |
| Build configuration | Build command | **留空** |
| Build configuration | Build output directory | `/` |
| Settings → Functions → KV namespace bindings | Variable name | `ARK_DATA` |
| Settings → Functions → KV namespace bindings | KV namespace | 选 `ARK-DATA` |
| Settings → Environment variables | `UPDATE_PASSWORD` | 你的管理员密码（勾选 Encrypt） |

> 构建输出目录一定填 `/`（仓库根目录）。`functions/` 和 `_headers` 都在这一层，
> Pages 会自动识别，不需要额外配置。

### 部署完自检

```bash
curl -i https://ark.sawakso.com/api/data
```

- 返回 `200` + `application/json` → Functions 生效了 ✅
- 返回 `200` + `text/html` → Functions **没**生效（Pages 把请求兜底成 index.html 了），
  检查 `functions/` 是否在仓库根目录、构建输出目录是不是填的 `/`

然后打开首页点 `⟳ 更新`，输入密码跑一次，KV 就从空的变成 446 名干员了。

### 不接 GitHub 的手动部署

```bash
npm run deploy      # = wrangler pages deploy .
```

## 更新 / 轮换密钥

- **换管理员密码**：Pages → Settings → Environment variables → 改 `UPDATE_PASSWORD` → 重新部署生效。
- **R2 密钥**：当前版本没有用到。要轮换直接在 Cloudflare 后台删旧建新即可，不影响本站。
- **加新环境变量**：同上，加完要重新部署一次才会注入到 Functions。

## 缓存策略（`_headers`）

| 路径 | Cache-Control | 原因 |
|---|---|---|
| `/assets/images/*` | `max-age=31536000, immutable` | 文件名带干员 id，内容永不变，回头客零请求 |
| `/assets/*.js` `.css` `data.json` | `max-age=0, must-revalidate` | 部署后会变，靠 ETag 快速 304 |
| `/index.html` `/` | `max-age=0, must-revalidate` | 保证发布完刷新就能看到新数据 |
| `/api/*` | `no-store` | 数据接口不缓存 |

> 注意：图片用了 `immutable`，所以**同一文件名不要改内容**——改名才会触发更新。
> 干员图片按 id 命名，天然满足。

## 已知待办

- [ ] `assets/script.js` 里仍保留了少量旧版遗留的辅助函数（约 15 KB），可以再精简
- [ ] 新干员的图片目前直接用 `media.prts.wiki` 原图（每张几十 KB），如需统一成 144×144 小图，
      可以加一个「图片镜像」步骤：在 Worker 里把图片转码后写 R2，再把 URL 换成 `img.ark.sawakso.com`
- [ ] 配置码导入导出目前仍走 localStorage（每台设备各自保存榜单），没有跨设备同步
