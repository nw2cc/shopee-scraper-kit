---
name: shopee-shop-scraper
description: This skill should be used when the user wants to scrape, crawl, export, or download a Shopee (虾皮) shop's product list with per-variant prices into a CSV file — e.g. "帮我爬取 xxx 店铺的商品"、"把虾皮这个店铺的所有商品和价格导出来"、"抓一下 xxx 店的品和规格售价"、"dump all products and SKU prices from this Shopee shop to CSV". Drives the user's own Chrome through the web-access CDP proxy, waits for manual login when Shopee demands it, walks the shop's own pages, and writes a streaming CSV with one row per product variant.
agent_created: true
---

# 虾皮店铺商品抓取

把一个虾皮店铺的全部商品连同**每个规格的价格**抓下来，导出 CSV。不装浏览器内核、不装 Python——直接驱动使用者日常在用的 Chrome，登录态天然复用。

## 何时使用

用户说「爬取／抓取／采集／导出／下载」某个虾皮店铺的商品列表、价格、规格，且要的是一个文件而不是屏幕上的答案时使用。

不适用于：修改商品（本 skill 只读）、读取**自己店铺后台**的数据（那走 Shopee 开放平台 API，不是抓页面）、下单或库存操作。

## 前置：浏览器连接

采集脚本自己直连 Chrome 调试端口（默认 9222），不依赖任何第三方库。先确认连接可用：

```bash
node <skill_dir>/scripts/scrape.mjs --check-browser
```

- 输出 `{"event":"browser_ok","browser":"Chrome/..."}` → 可以开始采集。
- 输出 `BROWSER_NOT_CONNECTED` → 让使用者做一次性配置：Chrome 地址栏打开 `chrome://inspect/#remote-debugging`，勾选 `Allow remote debugging for this browser instance`，然后重试。

如果环境里还装了 `web-access` skill，也可以用它的 `check-deps.mjs` 辅助检查，但**不是必须的**——本 skill 只用到 Chrome 的调试端口本身。

不要试图自己启动浏览器或安装内核。这里用的就是使用者当前的 Chrome，它带着使用者已有的虾皮登录态。

## 关于登录（决定可用性的一步）

脚本**不内置任何账号**，登录态只来自使用者那个浏览器。

- 多数站点的店铺页是公开的，不登录也能采。脚本先直接访问，不会一上来就要账号。
- 触发风控（`/verify/`）或站点要求登录（`/buyer/login`）时，输出 `need_login` / `need_verify`。此时需要**使用者在自己的 Chrome 窗口里**完成登录或验证——脚本会等，完成后自动继续。
- **使用者没有账号或没法通过验证时，这一步就过不去**，脚本会等到超时退出，不产出文件。不要反复重试：同一 IP 连续触发只会让风控升级。可以换时段或换网络再试。
- 登录态存在使用者自己的 Chrome 里，本次登录过，下次运行直接复用。

因此可用性前提是：**使用者有一个能正常浏览虾皮的浏览器环境**。它做的是「把人工浏览过程自动化」，不是绕过登录。

## 首次使用：先让人工过一次

在第一次对某个站点采集前，**让使用者在同一个 Chrome 里手动打开目标店铺首页**，确认能看到商品列表和价格。

理由：

- 脚本新开的是后台 tab，沿用同一浏览器 cookie。人工访问过一次之后，风控通常不会再拦。
- 如果人工访问都被验证页挡住，脚本也不可能过去——先确认这一层，比跑一轮超时快得多。
- 验证页出来时，让使用者当场完成。之后脚本不会再遇到。

人工能正常浏览、脚本仍失败时，才去看排错表。

## 执行流程

### 1. 确定店铺标识

从用户的话里提取店铺。可接受三种形式：

| 用户给的 | 例子 | 处理 |
|---|---|---|
| 店铺首页链接 | `https://shopee.tw/esim_go` | 直接传给 `--shop`，站点自动识别 |
| 账号名 / @账号名 | `esim_go`、`@esim_go` | 传 `--shop esim_go`，必要时加 `--site` |
| 中文店铺名 | 「eSIMGO 官方店」 | **无法直接解析**。先要店铺链接或账号名，不要猜 |

用户只给中文店名时不要臆造账号名去拼 URL——会抓错店或跳回首页。问一句「能给我店铺链接吗」比抓错后再解释便宜。

### 2. 后台启动采集

这个命令可能跑几分钟到几十分钟，且中途需要用户在浏览器里操作，**必须后台运行**：

```bash
node <skill_dir>/scripts/scrape.mjs \
  --shop "<店铺链接或账号名>" \
  --out "<输出目录或 csv 路径>" \
  [--site tw] [--max-items N] [--delay-ms 1500]
```

| 参数 | 默认 | 用途 |
|---|---|---|
| `--shop` | 必填 | 店铺链接、@账号名或账号名 |
| `--site` | `tw` | tw/sg/my/th/ph/vn/id/br；给完整链接时自动识别 |
| `--out` | 当前目录 | 输出 CSV 路径或目录 |
| `--max-items` | `0`（全部） | 只采前 N 个商品，用于先试样 |
| `--delay-ms` | `1500` | 商品之间等待毫秒（会乘 0.8-1.3 随机抖动） |
| `--timeout` | `3600` | 整体超时秒数 |
| `--login-wait` | `420` | 等人工登录/验证的秒数 |
| `--header` | `zh` | CSV 表头语言，可选 `en` |
| `--no-voucher` | 关 | 不算参考券后价 |
| `--cdp-port` | `9222` | Chrome 调试端口，一般不用改 |

建议首次先加 `--max-items 3` 验证链路通不通，再放全量。

### 3. 读事件流，把需要用户做的事翻译成人话

脚本 stdout 是**每行一个 JSON 事件**，stderr 是人读日志。按 `event` 字段判断：

| event | 含义 | agent 该做什么 |
|---|---|---|
| `start` | 已启动，给出店铺、CSV 路径、浏览器版本 | 告诉用户已开始 |
| `need_login` | 虾皮要求登录 | **立刻**提示用户：在**自己的 Chrome 窗口**里登录虾皮，登录后自动继续。不要重跑脚本 |
| `need_verify` | 触发安全验证 | 提示用户在自己的 Chrome 里完成滑块/点选验证 |
| `waiting_login` | 仍在等 | 间隔较长时给一次进度提示，不要刷屏 |
| `login_ok` | 已通过 | 告诉用户已继续 |
| `list_page` | 列表翻页进度 | 可选播报商品总数 |
| `truncated` | 被 `--max-items` 截断 | 说明总数与实采数 |
| `items_found` | 列表采完，共 N 个商品 | 播报总数和预估耗时 |
| `item` | 单个商品采完，含规格数 | 长任务每隔若干条给一次进度 |
| `item_failed` | 单个商品失败 | 记下 item_id，最后汇总；不要中断 |
| `done` | 全部完成 | 汇报 CSV 路径、行数、成功/失败商品数 |
| `error` | 失败 | 按 `code` 给建议（见下节） |

`need_login` / `need_verify` 出现时脚本会**原地等待**（默认 7 分钟），不要 kill 重跑。

### 4. 汇报结果

告诉用户三件事：CSV 绝对路径、总行数（规格数，不等于商品数）、失败商品数（如果有）。失败不为零时列出前几个 `item_id` 和原因（通常是该商品页接口没返回价格，可能已下架）。

不要替用户改 CSV 内容，不要自动打开文件，除非用户要看。

## CSV 结构

一行 = **一个商品规格**（变体），不是一件商品。无规格商品也占一行（`规格ID` 为 `0`，规格名为「（无规格）」）。

| 列 | 说明 |
|---|---|
| 店铺名 / 店铺ID / 站点 | 采集目标标识 |
| 商品ID / 商品名 / 商品链接 | 商品级字段，同商品多行会重复 |
| 规格ID / 规格名 | 变体标识；规格名是虾皮给的，可能为空 |
| 维度1 / 维度2 | 形如 `天數: 3天`，虾皮最多两级规格 |
| 币种 / 售价 / 划线价 / 售价占原价(%) / 参考券后价 | 金额两位小数 |
| 库存 / 可售 | 卖家可隐藏库存（`is_hide_stock`），此时库存列整列为空；可售 = 有库存且可点击，不可售时售价留空 |
| 原始价 | 不可售时保留接口原值，区分「没价格」和「卖完了」 |
| 采集时间 | ISO 8601 |

UTF-8 with BOM，Excel 双击直接打开不乱码。

## 关键约束

**不构造虾皮接口请求。** 脚本只做导航与滚动，数据来自页面自己发出的请求，通过 CDP 的 `Network` 域读取响应体。维护者切忌「优化」成 `fetch('/api/v4/...')` —— 那需要自己处理 `af-ac-enc-dat` 之类签名头，是这个实现刻意避开的东西。上游改版只需更新 `LIST_MARKER` / `PDP_MARKER`。

**价格单位是 1/100000。** 接口返回整数，除以 100000 才是本位币金额。

**参考券后价只对台湾站成立。** 「满 399 减 30、满 20 减 10」来自台湾店铺券样本，其它站点留空而不是套用。

**一个浏览器并发跑多个采集会互相干扰。** 每个进程都会新建自己的后台 tab，但同一 Chrome 上频繁导航会加重风控。多店铺串行跑。

**日志与事件分离。** stdout 只放 JSON 事件，人读信息走 stderr。改脚本时不要往 stdout 打普通文本。

**结束时关掉自己开的 tab**，不要动用户原有的标签页。

## 排错

| `error.code` | 原因 | 处理 |
|---|---|---|
| `BROWSER_NOT_CONNECTED` | 连不上 Chrome 调试端口 | 先跑 web-access 的 `check-deps.mjs`，按提示开启远程调试 |
| `SHOPEE_AUTH_REQUIRED` | 等待登录超时 | 先确认使用者**确实有**账号。有账号就加大 `--login-wait` 重跑；没有就停手 |
| `SHOPEE_CAPTCHA_BLOCKED` | 验证未通过 | 同上；换时段或换网络再试，连续重试会加重风控 |
| `SHOPEE_BAD_SHOP_ARG` | 店铺参数解析不了，或打开后被跳回首页（店铺不存在） | 让用户给店铺首页链接，确认店铺真的存在 |
| `SHOPEE_LIST_NOT_CAPTURED` | 没抓到店铺列表接口 | 账号名不对、页面打不开、或页面结构变了。先让用户手动打开该店铺页确认能正常浏览 |
| `SHOPEE_ALL_ITEMS_FAILED` | 全部商品失败 | 通常是登录态失效但没被识别成登录页，或 IP 被限 |
| `SHOPEE_TIMEOUT` | 超过 `--timeout` | 加大超时或减少采集量 |
| `UNEXPECTED` | 未预期异常 | 看 stderr 的堆栈 |

采集依赖 `rcmd_items` 与 `pdp/get_pc` 两个接口。上游改版会导致采集失败，此时看 [references/page-internals.md](references/page-internals.md) 里的响应结构重新适配。
