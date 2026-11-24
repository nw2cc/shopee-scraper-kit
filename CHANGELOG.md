# Changelog

遵循[语义化版本](https://semver.org/lang/zh-CN/)。版本号对应 git tag（`v0.0.1`）。

## [0.1.0] - 2026-11-24

### 变更

- **仓库根目录即技能目录**。此前技能放在 `shopee-shop-scraper/` 子目录，需要复制嵌套文件夹才能安装；现在 `git clone` 到技能目录即可，`SKILL.md`、`scripts/`、`references/` 都在根下
- 安装方式改为 `git clone`，更新为 `git pull --ff-only`

### 新增

- `SKILL.md` 增加「安装与更新」一节：用户说「更新虾皮商品工具」时，Agent 检查 `git log HEAD..origin/main`、列出变更、执行 `--ff-only` 拉取，并提示重启 WorkBuddy
- 更新流程明确禁止 `reset --hard` / `clean` / `--force`，本地有改动时拒绝更新而非覆盖
- 使用指南补充「怎么更新」，并区分 clone 安装（可更新）与下载压缩包安装（只能重装）

## [0.0.1] - 2026-11-24

首个可用版本。

### 新增

- 虾皮店铺商品采集：翻完店铺全部商品，逐个读取每个规格组合的售价，导出一行一规格的 CSV
- 支持站点：`tw` / `sg` / `my` / `th` / `ph` / `vn` / `id` / `br`，给完整店铺链接时自动识别
- 通过 CDP 的 `Network` 域旁听页面自身请求，不构造接口调用
- 逐行流式写 CSV，采集中断时已采部分仍可交付
- 列表总数交叉校验：接口自报 `total` 与实采数量不符时发 `count_mismatch`
- 浏览器连接检查 `--check-browser`、离线解析自检 `--self-test`
- WorkBuddy 技能定义、使用者安装指南、页面接口字段说明

### 已知限制

- 需要使用者浏览器有能访问虾皮的登录态；遇到验证页会停下等人处理
- 卖家开启 `is_hide_stock` 时接口不返回库存，CSV 该列为空
- 参考券后价只对台湾站计算
- 采集依赖 `rcmd_items` 与 `pdp/get_pc` 两个页面接口，上游改版需更新 marker
