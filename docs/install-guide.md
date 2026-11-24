# 安装指南（面向使用者）

这是一个 WorkBuddy 技能：让它帮你把一个虾皮店铺的**全部商品 + 每个规格的售价**抓下来，存成一个 Excel 能直接打开的 CSV。

不需要会写代码，装好之后一句话就能用。

---

## 安装（三步，约 5 分钟）

### 第 1 步：装 Node.js

从 [nodejs.org](https://nodejs.org/) 下载 **Node.js 22 LTS** 的 Windows 安装包（`.msi`），双击后一路点「Next」，最后点「Install」。

装完验证：

1. 按 `Win + R`，输入 `cmd`，回车
2. 在黑窗口里输入 `node -v`，回车
3. 显示 `v22.` 开头的版本号就说明装好了

> 如果显示「不是内部或外部命令」，关掉黑窗口重新开一次；仍然不行说明没装上。

macOS 用户可以 `brew install node@22`，或从官网下载 `.pkg`。

### 第 2 步：放好技能文件夹

1. 按 `Win + R`，输入 `%USERPROFILE%\.workbuddy\skills`，回车
   - 目录不存在就先手动建：`.workbuddy` → `skills`
2. 把 **`shopee-shop-scraper` 整个文件夹**复制进去

macOS 对应目录是 `~/.workbuddy/skills/`。

⚠️ **最容易出错的地方**：复制完之后，路径必须是

```
C:\Users\你的用户名\.workbuddy\skills\shopee-shop-scraper\SKILL.md
```

而不是

```
...\skills\shopee-shop-scraper\shopee-shop-scraper\SKILL.md
```

多套了一层，WorkBuddy 就认不出这个技能。检查方法：双击进 `shopee-shop-scraper` 文件夹，**应该直接看到 `SKILL.md`**。

### 第 3 步：让 Chrome 允许 WorkBuddy 连接

1. 打开 Chrome
2. 地址栏输入：`chrome://inspect/#remote-debugging`
3. 勾上 **Allow remote debugging for this browser instance**

只需做一次（Chrome 完全退出重开之后可能需要再勾一次）。

### 完成后重启 WorkBuddy

重启后在技能列表里应该能看到「虾皮店铺商品抓取」。

---

## 怎么用

在 WorkBuddy 里直接说：

> 帮我爬取 https://shopee.tw/esim_go 这个店铺的商品

或者：

> 把这个虾皮店铺的商品和价格导出来：https://shopee.sg/nikesingapore

它会：

1. 在你自己的 Chrome 里新开一个**后台标签页**（不动你正在看的页面）
2. 自动翻完店铺的所有商品
3. 逐个进商品页读每个规格的价格
4. 生成 CSV 并把路径告诉你

**用你自己的浏览器，所以不需要另外登录**——你平时怎么逛虾皮，它就怎么逛。

---

## 第一次用，请先手动开一次店铺页

**这一步很重要**：在让 WorkBuddy 抓之前，先用你自己的 Chrome 手动打开那个店铺首页，确认能看到商品。

- 如果弹出验证（拖滑块、点图片），当场完成它
- 如果要求登录，先登录

原因：虾皮会对「看起来不像正常浏览」的访问弹验证。你手动过一次，浏览器里就有了正常访问记录，脚本随后用同一个浏览器跑，基本不会再被拦。

反过来，如果**你自己手动都打不开**，那脚本也一定打不开——先解决访问问题，再谈抓取。

---

## 常见问题

### 提示「连不上 Chrome 调试端口」

第 3 步没做，或者 Chrome 重启后设置重置了。重新去 `chrome://inspect/#remote-debugging` 勾选。

### 提示「要求安全验证」/「要求登录」

- 先按上面说的，手动打开店铺页完成验证或登录，然后重新抓一次
- 反复被拦说明当前网络环境被虾皮盯上了，换个时间或网络再试
- **没有虾皮账号的话，这一步过不去**。有些站点（如台湾站）不登录也能看商品，有些（如新加坡站）会强制要求登录

### 抓了一半停了

已经抓到的部分**已经写进 CSV 了**，不会白跑。文件在它告诉你的路径里，可以直接打开用（可能少了后面几个商品）。

### 提示某个商品失败

正常。个别商品可能已下架，或页面结构特殊读不到价格。完成后会告诉你失败几个、是哪几个商品 ID。

### CSV 打开是乱码

不会。文件是带 BOM 的 UTF-8，Excel / WPS / Numbers 双击都正常。

### 库存列是空的

卖家在虾皮后台开启了「隐藏库存」，接口不返回这个字段。不是采集出错。

### 想抓多个店铺

一个个说就行。不建议同时开两个任务——同一个浏览器同时跑会互相干扰。

---

## 这个技能会碰你电脑上的什么

- **读取**：你自己 Chrome 里的虾皮页面（通过 Chrome 官方调试接口）
- **写入**：一个 CSV 文件（默认当前目录，也可在指令里指定）
- **不会**：修改你虾皮账号里的任何东西（价格、库存、订单都不碰，纯只读）
- **不会**：上传你的数据到任何地方

---

## 卸载

1. 删掉 `%USERPROFILE%\.workbuddy\skills\shopee-shop-scraper` 文件夹
2. 重启 WorkBuddy

Node.js 如果别的程序还要用可以留着；不想要就在「设置 → 应用」里卸载。

---

## 想改代码

见项目根目录的 [README.md](../README.md#开发)。快速自检：

```bash
node scripts\scrape.mjs --self-test
node scripts\scrape.mjs --check-browser
node scripts\scrape.mjs --help
```
