# shopee-scraper-kit

采集虾皮（Shopee）店铺的全部商品与每个规格的售价，导出 CSV。以 WorkBuddy 技能形式分发：使用者说一句「帮我爬取 xxx 店铺的商品」，Agent 驱动本机 Chrome 完成采集。

## 实现方式

虾皮的页面接口需要设备指纹签名（`af-ac-enc-dat` 等），直接构造请求会失效或触发风控。本项目只做导航与滚动，由页面自己发请求，通过 Chrome DevTools Protocol 的 `Network` 域读取响应体。

采集依赖两个接口：

| 用途 | 接口 |
|---|---|
| 商品列表 | `/api/v4/shop/rcmd_items` |
| 规格与价格 | `/api/v4/pdp/get_pc` |

上游改版时更新 `scripts/scrape.mjs` 的 `LIST_MARKER` / `PDP_MARKER`，解析字段对照 `references/page-internals.md`。

## 环境要求

- Node.js 22+
- Chrome，已开启远程调试

## 安装

### 1. 装 Node.js 22

从 [nodejs.org](https://nodejs.org/) 下载安装，验证：

```bash
node -v   # v22.x
```

### 2. 克隆到技能目录

仓库根目录就是技能本体，直接 clone 到技能目录即可：

```bash
# macOS / Linux
git clone https://github.com/nw2cc/shopee-scraper-kit.git ~/.workbuddy/skills/shopee-shop-scraper
```

```powershell
# Windows PowerShell
git clone https://github.com/nw2cc/shopee-scraper-kit.git "$env:USERPROFILE\.workbuddy\skills\shopee-shop-scraper"
```

目录名必须是 `shopee-shop-scraper`，且里面直接能看到 `SKILL.md`。用 clone 安装的好处是后续更新只需 `git pull`。

### 3. 开启 Chrome 远程调试

Chrome 地址栏打开 `chrome://inspect/#remote-debugging`，勾选 **Allow remote debugging for this browser instance**。

验证：

```bash
node scripts/scrape.mjs --check-browser
```

输出 `{"event":"browser_ok","browser":"Chrome/..."}` 即就绪。

使用者的图文步骤与排错见 [docs/install-guide.md](docs/install-guide.md)。

## 更新

对 WorkBuddy 说「更新虾皮商品工具」即可，Agent 会按 `SKILL.md` 的流程检查并拉取。手动更新：

```bash
git -C ~/.workbuddy/skills/shopee-shop-scraper pull --ff-only
```

更新后重启 WorkBuddy 生效。版本历史见 [CHANGELOG.md](CHANGELOG.md)。

如果本地改过代码，`--ff-only` 会拒绝更新而不是覆盖你的改动，先提交或 stash 再拉。

## 使用

在 WorkBuddy 里说：

> 帮我爬取 https://shopee.com.my/simplanet 这个店铺的商品

或走命令行：

```bash
node scripts/scrape.mjs \
  --shop https://shopee.com.my/simplanet \
  --out ~/Desktop
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--shop` | 必填 | 店铺首页链接、`@账号名` 或账号名 |
| `--site` | `tw` | `tw`/`sg`/`my`/`th`/`ph`/`vn`/`id`/`br`；给完整链接时自动识别 |
| `--out` | 当前目录 | 输出 CSV 路径或目录 |
| `--max-items` | `0`（全部） | 只采前 N 个商品 |
| `--delay-ms` | `1500` | 商品间等待毫秒，实际乘 0.8–1.3 抖动 |
| `--header` | `zh` | CSV 表头语言，可选 `en` |
| `--no-voucher` | 关 | 不算参考券后价 |
| `--cdp-port` | `9222` | Chrome 调试端口 |
| `--check-browser` | — | 只检查能否连上 Chrome，不采集 |
| `--probe` | — | 抓单个商品的价格与券结构，排查站点差异 |
| `--self-test` | — | 离线解析自检，不联网 |

stdout 逐行输出 JSON 事件（`start` / `list_page` / `items_found` / `item` / `count_mismatch` / `done` / `error`），日志走 stderr。

## 输出

一行 = 一个商品规格（变体），不是一件商品。UTF-8 with BOM。

```
店铺名, 店铺ID, 站点, 商品ID, 商品名, 商品链接, 规格ID, 规格名,
维度1, 维度2, 币种, 售价, 划线价, 售价占原价(%), 商品折扣, 券折扣,
参考券后价, 库存, 可售, 原始价, 采集时间
```

口径：

- 接口价格单位是 1/100000，已换算为两位小数
- 商品折扣 = 划线价 − 售价；券折扣 = 该售价可用的最优店铺券折抵金额（未达券门槛或卖家未设券时为空）
- 可售 = `has_stock && is_clickable`。不可售时售价留空，`原始价` 保留接口原值
- 卖家开启 `is_hide_stock` 时接口不返回库存，该列为空
- 参考券后价只对台湾站计算（满 399 减 30、满 20 减 10），其它站点留空
- 无规格商品占一行，`规格ID` 为 `0`

## 项目结构

仓库根目录即 WorkBuddy 技能目录：

```
├── SKILL.md                     技能定义、执行流程、事件协议、更新流程
├── scripts/scrape.mjs           采集实现
├── references/page-internals.md 页面接口字段说明
├── README.md
├── CHANGELOG.md
└── docs/install-guide.md        使用者安装与排错
```

## 开发

```bash
# 解析自检：32 项断言，含 CSV 往返；不联网、不开浏览器
node scripts/scrape.mjs --self-test

# 浏览器连接检查
node scripts/scrape.mjs --check-browser

# 小量真实验证
node scripts/scrape.mjs --shop <店铺链接> --max-items 3
```

实现要点：

- 连 browser 级 WebSocket（`/devtools/browser`），不是 page 级。新版 Chrome 已禁用 `/json/version`、`/json/list`，页面命令靠 `Target.attachToTarget(flatten)` 的 `sessionId` 路由
- 响应体在 `Network.loadingFinished` 时取，页面导航会释放
- 列表采集用接口自报的 `data.total` 与实采数量交叉校验，少于总数时发 `count_mismatch`
- 列表响应有两种形态：`rcmd_items` 包在 `data` 里，`search_items` 直接在外层，解析函数两种都认

## 已知限制

- 需要使用者浏览器有能访问虾皮的登录态。遇到验证页会停下等人处理，没有账号则无法继续
- 全店采集可能中途多次触发验证，需要有人在浏览器前守着；中断时已采部分仍在 CSV 里
- 首次使用先在同一个 Chrome 里手动打开目标店铺页，让浏览器建立正常访问记录
- 不要并发跑多个采集，同一个 Chrome 上频繁导航会加重风控
- 采集依赖上述两个页面接口，上游改版需要更新 marker

## 实测

2026-11 在 `shopee.com.my/simplanet` 全店采集：

| 项 | 值 |
|---|---|
| 商品数 | 25（接口自报 `total=25`，与实采一致） |
| 规格行数 | 871 |
| 失败 | 0 |
| 耗时 | 2 分 50 秒 |
| 可售占比 | 85%（740 / 871） |
