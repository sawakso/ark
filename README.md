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
| R2 存储桶 | `ark-images` | `env.ARK_IMAGES` | 存新干员的头像 / 技能图标，见下方说明 |
| R2 自定义域 | `imgark.sawakso.com` | `env.R2_PUBLIC_BASE`（可选，默认已内置） | 对外读图走这个域 |
| 环境变量 | `UPDATE_PASSWORD` | `env.UPDATE_PASSWORD` | 管理员更新密码 |
| 环境变量 | `R2_ACCESS_KEY_ID` 等 | — | 用不到，见下方说明 |

> **关于 R2 域名**：用的是 `imgark.sawakso.com` 而不是 `img.ark.sawakso.com`。
> Cloudflare 免费版的通用证书只覆盖 `*.sawakso.com` 这一级，`img.ark.sawakso.com`
> 属于二级子域，没有证书可用。
>
> 换域名**不用改代码**：Worker 会把公开域名放在 `/api/images` 的 `base` 字段里返回，
> 前端以它为准。要覆盖就在 Pages 加环境变量 `R2_PUBLIC_BASE`；
> 找不到这个变量时才用代码里的默认值（`functions/api/images.js` 顶部的 `DEFAULT_R2_BASE`）。

### ⚠️ 需要在 Pages 后台补一个 R2 绑定

**Settings → Functions → R2 bucket bindings**

| 变量名 | 存储桶 |
|---|---|
| `ARK_IMAGES` | `ark-images` |

少了这个绑定，更新时数据照样发布成功，只是图片留在 PRTS 上（不报错，会提示「保留 PRTS 原链接」）。

### R2 是怎么用的

目标：**图片只存在于 R2 一个地方**，访客一律从 `imgark.sawakso.com` 读，不再依赖 PRTS。

更新时多跑一步，顺序是「先查、再传、后改写」：

```
抓完 PRTS、组装数据
   ↓
收集候选图（默认只收新干员的；勾选后连仓库自带的 1399 张一起收）
   ↓
POST /api/images?check=1  ← 问 Worker「这些 key 里哪些 R2 已经有了」
   ↓  只处理缺的那部分
浏览器取图 → 原始字节 POST /api/images → Worker 写 R2
   ↓
把数据里的图片地址全部改写成 https://imgark.sawakso.com/img/<md5>.ext
```

**取图放在浏览器做，不让 Cloudflare 边缘去取。** 这是关键：
`media.prts.wiki` 托管在国内（`Server: Tengine`、`Via: ...l2cn9026`），
让边缘出境取图会超时——当初「请求 PRTS 失败：The operation was aborted」就是这个病根。
浏览器取图走管理员自己的网络（国内直连 ~0.05s），而 `media.prts.wiki` 带了
`Access-Control-Allow-Origin: *`，仓库图本身就是同源，所以都能读成 Blob 再上传。

**存在性检查带来两个好处**：首次全量同步之后，后续每次更新检查全命中，
一个字节都不用传；万一 KV 被清空重来，也不会重复上传已有对象。

密码弹窗里那个 **「顺便把仓库自带的图片也同步到 R2」** 勾选框控制要不要连 `assets/images/` 一起搬：

| | 只传新干员（不勾） | 连仓库图一起（勾选） |
|---|---|---|
| 首次耗时 | 几秒 | **一两分钟**（约 1400 张 / 4.5 MB） |
| 之后每次更新 | 秒级 | 秒级（检查全命中，零传输） |
| 图片来源 | 两种域名混用 | 统一到 R2 |

对象名统一是 `img/<文件名 md5>.<ext>`：md5 保证唯一、避免中文进 URL，
一套规则同时覆盖头像和技能图标。写入时带 `Cache-Control: public, max-age=31536000, immutable`，
回头客零请求。

任何一张图失败都不影响数据发布：那一张保留原链接，进度条会显示
`图片在 R2 x/y（已有 a，本次上传 b）⚠ n 张失败：<第一条错误>`。失败详情同时打到控制台。

### 为什么用绑定而不是你配的 S3 密钥

你配的 `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT` 是 **S3 兼容接口**的凭证，能用，但在这个场景下更差：

| | 原生绑定 `env.ARK_IMAGES` | S3 接口 |
|---|---|---|
| CPU 开销 | 几乎为 0 | 每次 PUT 都要算 SigV4（SHA256 + 多轮 HMAC），免费版只有 **10ms CPU**，很危险 |
| 子请求额度 | 不算子请求 | 走公网 `fetch`，占「50 个子请求/请求」的名额 |
| 密钥管理 | 无 | 要轮换，且凭证会出现在运行时代码里 |

所以密钥那几条环境变量可以留着不管，实际不会用到。

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

仓库：https://github.com/sawakso/ark （推 `main` 即触发构建）

**有两条部署路径，取决于 Cloudflare 后台把项目建成了哪种。** 下面的「自检」能一眼分辨。

### 方式 A：Pages 项目（推荐，零配置）

| 位置 | 配置项 | 值 |
|---|---|---|
| Build configuration | Framework preset | None |
| Build configuration | Build command | **留空** |
| Build configuration | Build output directory | `/` |
| Settings → Functions → KV namespace bindings | Variable name | `ARK_DATA`（命名空间选 `ARK-DATA`） |
| Settings → Functions → R2 bucket bindings | Variable name | `ARK_IMAGES`（存储桶选 `ark-images`） |
| Settings → Environment variables | `UPDATE_PASSWORD` | 管理员密码（勾 Encrypt） |

构建日志里会出现这一行才算对：`Found Functions directory at /functions. Uploading.`

### 方式 B：Worker 项目

> ⚠️ **Cloudflare 现在默认把新项目建成 Worker，而 `functions/` 目录是 Pages 专有约定，Worker 不认。**
> 如果你在构建日志里看到
> `We have identified a functions directory ... Is this correct?` → `Using fallback value: no`，
> 就说明接口根本没被注册，前端所有 `/api/*` 请求都会拿到 HTML 兜底。**必须切到方式 B。**

Worker 走的是「单一入口脚本 + 静态资源」，仓库里已经备好了：

| 文件 | 作用 |
|---|---|
| `worker.js` | 极薄的路由：`/api/*` 转给 `functions/api/*.js`，其余交给静态资源 |
| `wrangler.workers.jsonc` | Worker 配置：`main`、`assets.directory`、KV / R2 绑定 |
| `.assetsignore` | 把 `functions/`、`tools/`、`worker.js`、`README.md` 等排除出公开目录 |

**构建命令改成：**

```
npx wrangler deploy -c wrangler.workers.jsonc
```

构建输出目录保持 `.`（由 wrangler 接管，实际不用它）。

绑定和 KV id 都写在配置里了，**不用去后台点**；只需要补一个密钥：

| 位置 | 项 | 值 |
|---|---|---|
| Worker → Settings → Variables and Secrets | `UPDATE_PASSWORD` | 管理员密码，类型选 **Secret** |

> 为什么配置文件名不叫 `wrangler.toml` / `wrangler.jsonc`：
> 仓库根目录一旦存在默认名字的 wrangler 配置，Pages 会拿它覆盖后台设置，
> 而 Pages 不认 `main` 字段可能直接报错。用单独名字 + `-c` 显式指定，两条路径互不干扰。

### 部署完自检（两种方式通用）

```bash
curl -i https://ark.sawakso.com/api/data
```

| 返回 | 含义 |
|---|---|
| `200` + `application/json` | ✅ 接口生效 |
| `404` | Worker 模式但没走 `worker.js`，或 Pages 模式下 `functions/` 位置不对 |
| `200` + `text/html` | ❌ 被兜底成 index.html —— 就是上面说的「被当成 Worker 但没配路由」 |

再补一条，确认后台文件没有泄漏：

```bash
curl -o /dev/null -w "%{http_code}\n" https://ark.sawakso.com/functions/api/data.js
curl -o /dev/null -w "%{http_code}\n" https://ark.sawakso.com/.dev.vars
```

两条都应该是 `404`。

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
      可以加一个「图片镜像」步骤：在 Worker 里把图片转码后写 R2，再把 URL 换成 `imgark.sawakso.com`
- [ ] 配置码导入导出目前仍走 localStorage（每台设备各自保存榜单），没有跨设备同步
