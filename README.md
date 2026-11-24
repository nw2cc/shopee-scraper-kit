# shopee-scraper-kit

把一个虾皮（Shopee）店铺的全部商品连同**每个规格的价格**采集下来，导出成 Excel 直接能打开的 CSV。

以 [WorkBuddy](https://www.workbuddy.cn) 技能的形式分发：使用者说一句「帮我爬取 xxx 店铺的商品」，Agent 驱动本机 Chrome 完成采集，不需要装 Python，也不需要下载浏览器内核。

## 为什么不是普通爬虫

虾皮的页面接口需要设备指纹签名（`af-ac-enc-dat` 之类），自己构造请求要么反复失效，要么直接触发风控。

这里的做法是**只做真实导航和滚动**，让页面自己发请求，通过 Chrome DevTools Protocol 的 `Network` 域旁听响应体。等于是把人的浏览动作自动化，而不是绕过它。

直接好处：

- 不需要 Playwright / Puppeteer，也不需要 `playwright install chromium`
- 复用使用者 Chrome 里已有的登录态
- 上游改版时通常只需更新两个 URL marker

## 依赖

- Node.js **22+**
- 本机 **Chrome**（需开启远程调试）

不需要 Python，没有任何 npm 依赖。

## 安装

### 1. 装 Node.js 22

从 [nodejs.org](https://nodejs.org/) 下载安装，验证：

```bash
node -v   # 应显示 v22.x
```

### 2. 放置技能

把 `shopee-shop-scraper` 整个文件夹放到 WorkBuddy 的技能目录：

- macOS / Linux：`~/.workbuddy/skills/`
- Windows：`%USERPROFILE%\.workbuddy\skills\`

放完后路径应当是 `.../skills/shopee-shop-scraper/SKILL.md`——**不要多套一层同名目录**，否则技能不会被识别。

### 3. 开启 Chrome 远程调试

Chrome 地址栏打开 `chrome://inspect/#remote-debugging`，勾选 **Allow remote debugging for this browser instance**。

验证：

```bash
node shopee-shop-scraper/scripts/scrape.mjs --check-browser
```

输出 `{"event":"browser_ok","browser":"Chrome/..."}` 即就绪。

面向非技术使用者的图文步骤与排错见 [docs/install-guide.md](docs/install-guide.md)。

## 使用

在 WorkBuddy 里直接说：

> 帮我爬取 https://shopee.com.my/simplanet 这个店铺的商品

或走命令行：

```bash
node shopee-shop-scraper/scripts/scrape.mjs \
  --shop https://shopee.com.my/simplanet \
  --out ~/Desktop
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--shop` | 必填 | 店铺首页链接、`@账号名` 或账号名 |
| `--site` | `tw` | `tw`/`sg`/`my`/`th`/`ph`/`vn`/`id`/`br`；给完整链接时自动识别 |
| `--out` | 当前目录 | 输出 CSV 路径或目录 |
| `--max-items` | `0`（全部） | 只采前 N 个商品，用于先试样 |
| `--delay-ms` | `1500` | 商品间等待毫秒（实际乘 0.8–1.3 抖动） |
| `--header` | `zh` | CSV 表头语言，可选 `en` |
| `--no-voucher` | 关 | 不算参考券后价 |
| `--cdp-port` | `9222` | Chrome 调试端口 |
| `--check-browser` | — | 只检查能否连上 Chrome，不采集 |
| `--self-test` | — | 离线解析自检，不联网 |

采集过程向 stdout 输出逐行 JSON 事件（`start` / `list_page` / `items_found` / `item` / `done` / `error` 等），人读日志走 stderr，便于上层 Agent 解析进度。

## 输出

一行 = 一个**商品规格**（变体），不是一件商品。UTF-8 with BOM，Excel 双击打开不乱码。

```
店铺名, 店铺ID, 站点, 商品ID, 商品名, 商品链接, 规格ID, 规格名,
维度1, 维度2, 币种, 售价, 划线价, 售价占原价(%), 参考券后价,
库存, 可售, 原始价, 采集时间
```

口径说明：

- 接口价格单位是 1/100000，已换算成两位小数
- 可售 = `has_stock && is_clickable`；不可售时售价留空，`原始价` 保留接口原值，以便区分「卖完了」和「没采到」
- 卖家开启 `is_hide_stock` 时接口不返回库存，该列为空（数据源限制，不是采集失败）
- 参考券后价只对台湾站计算（规则来自台湾店铺券样本：满 399 减 30、满 20 减 10），其它站点留空
- 无规格商品也占一行，`规格ID` 为 `0`

## 项目结构

```
shopee-scraper-kit/
├── README.md
├── docs/
│   └── install-guide.md             面向非技术使用者的安装与排错
└── shopee-shop-scraper/
    ├── SKILL.md                     技能定义、执行流程、事件协议
    ├── scripts/scrape.mjs           采集实现（Node 原生，零依赖）
    └── references/page-internals.md 页面接口结构，上游改版时对照修
```

## 开发

```bash
# 解析自检：32 项断言，含 CSV 往返（不联网、不开浏览器）
node shopee-shop-scraper/scripts/scrape.mjs --self-test

# 浏览器连接检查
node shopee-shop-scraper/scripts/scrape.mjs --check-browser

# 小量真实验证
node shopee-shop-scraper/scripts/scrape.mjs --shop <店铺链接> --max-items 3
```

`scrape.mjs` 里几个不太显然的实现点：

- 连的是 **browser 级** WebSocket（`/devtools/browser`），不是 page 级。新版 Chrome 已禁用 `/json/version`、`/json/list` 这些 HTTP 端点，页面命令靠 `Target.attachToTarget(flatten)` 拿到的 `sessionId` 路由
- 响应体必须在 `Network.loadingFinished` 时立即取，页面导航会释放它
- 列表采集用接口自报的 `data.total` 与实采数量交叉校验，少于总数时发 `count_mismatch` 事件，不静默放过
- 列表响应有两种形态（`rcmd_items` 包在 `data` 里，`search_items` 直接在外层），解析函数两种都认

## 已知限制

- **需要使用者自己的浏览器有能访问虾皮的登录态**。遇到验证页会停下来等人处理，没有账号就过不去
- 首次使用建议先在同一个 Chrome 里手动打开目标店铺页，让浏览器建立正常访问记录
- 不要并发跑多个采集：同一个 Chrome 上频繁导航会加重风控
- 采集依赖页面的 `rcmd_items` 与 `pdp/get_pc` 两个接口，上游改版时需要更新 marker

## 实测

2026-11 在 `shopee.com.my/simplanet` 全店采集：

| 项 | 值 |
|---|---|
| 商品数 | 25（接口自报 `total=25`，与实采一致） |
| 规格行数 | 871 |
| 失败 | 0 |
| 耗时 | 2 分 50 秒 |
| 可售占比 | 85%（740 / 871） |
