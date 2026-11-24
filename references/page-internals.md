# 虾皮页面接口结构（维护参考）

采集全部依赖页面自身发出的两个请求。上游改版时，先抓一次真实响应比对本文，
再改 `scripts/scrape.mjs` 里对应的解析函数。

## 1. 商品列表 `/api/v4/shop/rcmd_items`

触发方式：导航到 `https://<站点>/<店铺账号>`（翻页加 `?page=N&sortBy=pop&tab=0`），
向下滚动触发懒加载。

响应关键路径（存在两种形态，解析函数都覆盖）：

```
data.centralize_item_card.item_cards[]   # 常见形态
data.items[]                             # 兜底形态
```

单个卡片的字段（顶层或 `item_basic` 里，两处都要试）：

| 字段 | 用途 |
|---|---|
| `itemid` | 商品 ID，去重键 |
| `shopid` | 店铺 ID。**部分卡片不带**，需用目标店铺 ID 兜底 |
| `item_basic.name` 或 `item_card_displayed_asset.name` | 商品名 |
| `tier_variations[]` | `{name, options[]}`，规格维度与选项 |
| `data.no_more` | 布尔，为真表示没有下一页 |

坑：

- 列表接口给的 `tier_variations` 是完整维度表，但**不给每个规格的价格**。价格必须另开商品页。
- `no_more` 在翻页请求里可能一直是 `false`，靠「本页没有新 itemid」判断结束更可靠（当前实现在连续无新增时 break）。

## 2. 商品详情 `/api/v4/pdp/get_pc`

触发方式：逐个导航 `https://<站点>/product/<shop_id>/<item_id>`。

响应关键路径：

```
data.item
  ├ title                商品标题（**不是 name**，name 只在列表卡片上）
  ├ currency             币种（TWD / SGD / MYR ...）
  ├ is_hide_stock        卖家是否隐藏库存；为真时下面所有 stock 都是 null
  ├ price                商品级价格（仅在无规格时有意义）
  ├ price_before_discount 划线价
  ├ has_stock / is_clickable  商品级可售
  ├ stock                库存（可能被卖家隐藏为 null）
  ├ tier_variations[]    {name, options[]}
  └ models[]
      ├ model_id         规格 ID（**必有，缺失则跳过该行**）
      ├ name             规格名，常为空
      ├ price            1/100000 本位币
      ├ price_before_discount
      ├ has_stock
      ├ is_clickable
      ├ stock            库存（`is_hide_stock` 为真时为 null）
      ├ sold             已售数量，常为 null
      └ extinfo.tier_index  int[]，各维度 option 的下标
```

### 价格与可售口径

- 价格单位固定 `1/100000`，除完保留两位。
- 可售 = `has_stock && is_clickable`。两者都在 `model` 上，缺失才回退到 `item` 级。
- 不可售时 `price` 留空，但把接口原值存进 `raw_price`。这不是冗余——运营需要区分「没采到」和「卖完了」。
- `extinfo.tier_index` 的长度等于规格维度数（最多 2）。用它去 `tier_variations[i].options[index]` 取文字，比解析 `models[].name` 可靠，因为 `name` 常为空。

### 已知坑

**无规格商品**：`models` 为空数组，价格挂在 `item.price` 上。早期实现把这种情况判为采集失败，会整件商品丢失。现在的做法是产一行 `model_id=0`。

**`model_id` 缺失**：不能补 `0` 顶替。`0` 已被「无规格商品」占用，补 `0` 会让两个不同的东西撞成一行。

**同一链接内多个规格可以有相同 SKU/名称**：虾皮允许，不要按名称去重。

**价格与库存不在 `price_info` 上**：`has_model=true` 时 `price_info` 通常为空，别去那里找。

### 折扣明细与店铺券

页面上「券后价」图标 hover 出来的「价格明细」浮层，数据来自 `data.price_breakdown`（在 `data` 层，不在 `item` 里）：

```
data.price_breakdown
  ├ price.single_value                 券后价（当前选中规格）
  ├ price_before_discount.single_value 原价
  └ discount_breakdown[]
      ├ type: 0  price_source: "商品折扣"
      │            discount_amount: 2700000
      └ type: 2  price_source: "商店优惠券折扣"
                   discount_amount: 300000
                   shop_voucher: {min_spend, discount_type, discount_value}
```

它只反映**当前选中规格**。要给每个规格单独算折扣，用 `data.shop_vouchers`：

```
data.shop_vouchers[]
  ├ voucher_code           券码
  ├ min_spend              使用门槛（1/100000）
  ├ used_price             折抵金额（1/100000）
  └ voucher_discount_type  0 = 固定金额
```

判断券是哪种类型看字段，不看 `voucher_discount_type`：

| 字段 | 含义 |
|---|---|
| `discount_percentage > 0` | 百分比券，折抵 = 售价 × 比例，受 `discount_cap` 封顶 |
| 否则 `used_price` / `discount_value` | 固定金额券 |

固定金额券的 `discount_percentage` 和 `discount_cap` 返回 `0`（不是 `null`），判定时要用 `> 0`。

百分比字段的单位未拿到真实样本：`1200` 和 `12` 都可能表示 12%。实现按「大于 100 视为 ×100 存储」处理，1%–100% 区间两种存储结果一致。

`data.product_price.final_price_info.final_price_vouchers.shop_voucher.voucher_discount` 是前端为选中规格算出的那张券，可用来印证上面的规则。注意 `price_breakdown` 只对应当前选中规格——实测 `model[0].price` 是 RM10.6 时，`price_breakdown.price` 显示的是默认选中规格的 RM20。

## 3. 站点差异

各站点域名：`shopee.tw` / `shopee.sg` / `shopee.com.my` / `shopee.co.th` /
`shopee.ph` / `shopee.vn` / `shopee.co.id` / `shopee.com.br`。

接口路径 `/api/v4/...` 各站点一致，但**响应字段可能增减**。接入新站点时先用
`--max-items 1` 抓一个商品，把响应 dump 出来比对上面两节。

参考券后价规则（满 399 减 30 / 满 20 减 10）只来自台湾站样本，其它站点不套用。
