#!/usr/bin/env node
/**
 * 虾皮店铺商品抓取（Node + Chrome DevTools Protocol 版）
 *
 * 为什么不用 playwright：最终用户的机器上只有 WorkBuddy，不保证有 Python
 * 或浏览器内核。这里只依赖 Node 22（web-access 本身就要求）和用户日常
 * 在用的 Chrome —— 浏览器里已有的登录态直接复用，不额外装任何东西。
 *
 * 采集方式仍是「旁观页面自身请求」：只做导航与滚动，数据来自页面自己发出
 * 的 rcmd_items / pdp 请求，通过 CDP 的 Network 域读取响应体。不构造请求、
 * 不维护签名算法。
 *
 * stdout 每行一个 JSON 事件，人读日志走 stderr。用法见 --help。
 */

import { readFileSync, unlinkSync, openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';

const SITES = {
  tw: 'https://shopee.tw',
  sg: 'https://shopee.sg',
  my: 'https://shopee.com.my',
  th: 'https://shopee.co.th',
  ph: 'https://shopee.ph',
  vn: 'https://shopee.vn',
  id: 'https://shopee.co.id',
  br: 'https://shopee.com.br',
};

const LIST_MARKER = '/api/v4/shop/rcmd_items';
const PDP_MARKER = '/api/v4/pdp/get_pc';
const PRICE_DIVISOR = 100000;
const MAX_LIST_PAGES = 30;
const SCROLL_TIMES = 6;
const SCROLL_INTERVAL_MS = 700;
const VOUCHERS_TW = [[399, 30], [20, 10]];
const RESERVED_FIRST = new Set([
  'product', 'search', 'buyer', 'cart', 'verify', 'api',
  'shop', 'seller', 'live', 'm', 'mall', 'universal-link',
]);

const COLUMNS = [
  ['shop_name', '店铺名', 'shop_name'],
  ['shop_id', '店铺ID', 'shop_id'],
  ['site', '站点', 'site'],
  ['item_id', '商品ID', 'item_id'],
  ['item_name', '商品名', 'item_name'],
  ['item_url', '商品链接', 'item_url'],
  ['model_id', '规格ID', 'model_id'],
  ['model_name', '规格名', 'model_name'],
  ['tier1', '维度1', 'tier1'],
  ['tier2', '维度2', 'tier2'],
  ['currency', '币种', 'currency'],
  ['price', '售价', 'price'],
  ['price_before_discount', '划线价', 'price_before_discount'],
  ['discount_percent', '售价占原价(%)', 'price_over_list_pct'],
  ['item_discount', '商品折扣', 'item_discount'],
  ['voucher_discount', '券折扣', 'voucher_discount'],
  ['voucher_price', '参考券后价', 'voucher_price'],
  ['stock', '库存', 'stock'],
  ['available', '可售', 'available'],
  ['raw_price', '原始价', 'raw_price'],
  ['collected_at', '采集时间', 'collected_at'],
];

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function emit(event, payload = {}) {
  process.stdout.write(JSON.stringify({ event, ...payload }) + '\n');
}

function log(msg) {
  process.stderr.write(`[shopee] ${msg}\n`);
}

class ScrapeError extends Error {
  constructor(message, code, needUser = false) {
    super(message);
    this.code = code;
    this.needUser = needUser;
  }
}

// ---------------------------------------------------------------------------
// 纯函数：URL / 风控 / 解析 / 造行
// ---------------------------------------------------------------------------

function siteFromUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const [key, base] of Object.entries(SITES)) {
      if (new URL(base).hostname === host) return key;
    }
  } catch {
    return '';
  }
  return '';
}

function parseShopUsername(pageUrl) {
  let parsed;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return '';
  }
  if (!siteFromUrl(pageUrl)) return '';
  const segs = parsed.pathname.split('/').filter(Boolean);
  if (!segs.length) return '';
  const first = decodeURIComponent(segs[0]).trim();
  if (!first || RESERVED_FIRST.has(first) || first.startsWith('.')) return '';
  return first;
}

function normalizeShopArg(raw, fallbackSite) {
  const text = String(raw ?? '').trim();
  if (!text) throw new ScrapeError('缺少店铺参数', 'SHOPEE_BAD_SHOP_ARG');

  if (text.includes('://') || text.startsWith('shopee.') || text.includes('.shopee.')) {
    const withProto = text.includes('://') ? text : `https://${text}`;
    const username = parseShopUsername(withProto);
    if (!username) {
      throw new ScrapeError(
        `无法从链接解析店铺账号名：${raw}（请给店铺首页链接，如 https://shopee.tw/店铺账号）`,
        'SHOPEE_BAD_SHOP_ARG',
      );
    }
    return { username, site: siteFromUrl(withProto) || fallbackSite };
  }

  let username = text.replace(/^@+/, '').replace(/^\/+|\/+$/g, '');
  if (/^\d{5,}$/.test(username)) {
    throw new ScrapeError(
      `「${raw}」看起来是数字 ID。请改给店铺首页链接或店铺账号名。`,
      'SHOPEE_BAD_SHOP_ARG',
    );
  }
  if (username.includes('/')) username = username.split('/')[0];
  return { username, site: fallbackSite };
}

function isHomeUrl(url) {
  try {
    return new URL(url).pathname.replace(/^\/+|\/+$/g, '') === '';
  } catch {
    return false;
  }
}

function detectRisk(url) {
  const text = String(url ?? '');
  if (text.includes('/verify/') || text.includes('error?home_url') || text.includes('error%3Fhome_url')) {
    return 'SHOPEE_CAPTCHA_BLOCKED';
  }
  if (text.includes('buyer/login') || text.includes('/login')) return 'SHOPEE_AUTH_REQUIRED';
  return '';
}

function riskMessage(code) {
  return code === 'SHOPEE_AUTH_REQUIRED'
    ? '虾皮要求登录。请在你自己的浏览器窗口里登录买家账号，登录后采集会自动继续。'
    : '虾皮要求安全验证。请在你自己的浏览器窗口里完成验证，完成后采集会自动继续。';
}

function buildShopUrl(username, site, pageIndex = 0) {
  const base = SITES[site] || SITES.tw;
  let url = `${base}/${encodeURIComponent(username)}`;
  if (pageIndex > 0) url += `?page=${pageIndex}&sortBy=pop&tab=0`;
  return url;
}

function buildItemUrl(site, shopId, itemId) {
  if (!shopId || !itemId) return '';
  return `${SITES[site] || SITES.tw}/product/${shopId}/${itemId}`;
}

function normalizeTiers(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      name: String(e.name ?? ''),
      options: Array.isArray(e.options) ? e.options.map(String) : [],
    }));
}

function parseItemCards(body) {
  if (!body || typeof body !== 'object') return { cards: [], noMore: false, total: null };

  // 列表响应有两种形态：/shop/rcmd_items 包在 data 里，
  // /shop/search_items 直接放在最外层（含 total_count / nomore）。
  const data = body.data && typeof body.data === 'object' ? body.data : body;

  const central = data.centralize_item_card;
  let cards = central && typeof central === 'object' ? central.item_cards : null;
  if (!Array.isArray(cards)) cards = data.items;
  if (!Array.isArray(cards)) cards = data.item;
  if (!Array.isArray(cards)) cards = [];

  const out = [];
  for (const card of cards) {
    if (!card || typeof card !== 'object') continue;
    const basic = card.item_basic && typeof card.item_basic === 'object' ? card.item_basic : {};
    const itemId = card.itemid ?? basic.itemid;
    if (!itemId) continue;
    const display =
      card.item_card_displayed_asset && typeof card.item_card_displayed_asset === 'object'
        ? card.item_card_displayed_asset
        : basic;
    out.push({
      item_id: String(itemId),
      shop_id: String(card.shopid ?? basic.shopid ?? ''),
      item_name: String(display.name ?? card.name ?? ''),
      tier_variations: normalizeTiers(card.tier_variations ?? basic.tier_variations),
    });
  }

  const noMore = Boolean(
    data.no_more ?? data.nomore ?? body.no_more ?? body.nomore,
  );
  const rawTotal = data.total ?? data.total_count ?? body.total_count ?? body.total;
  const total = typeof rawTotal === 'number' && rawTotal > 0 ? rawTotal : null;
  return { cards: out, noMore, total };
}

function parsePdpPayload(body) {
  const data = body && typeof body === 'object' ? body.data : null;
  if (!data || typeof data !== 'object') return null;
  const item = data.item && typeof data.item === 'object' ? data.item : null;
  if (!item) return null;
  return {
    item,
    // 店铺券列表：适用门槛与折抵金额都在这里，浮层「价格明细」用它算券折扣
    shopVouchers: Array.isArray(data.shop_vouchers) ? data.shop_vouchers : [],
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * 一张券在该售价下的折抵金额（元）。
 *
 * 券有两种形态，靠字段区分而不是 voucher_discount_type：
 * - 百分比券：discount_percentage 有值，折抵 = 售价 × 比例，可被 discount_cap 封顶
 * - 固定金额券：discount_value / used_price 有值
 *
 * 实测（shopee.sg）：discount_percentage 是整数百分比，10 表示 10%。
 * 超过 100 视为异常数据，按 100% 处理。
 */
function voucherAmount(v, price) {
  const pctRaw = Number(v.discount_percentage);
  if (Number.isFinite(pctRaw) && pctRaw > 0) {
    const rate = Math.min(pctRaw, 100) / 100;
    let amount = price * rate;
    const cap = toMoney(v.discount_cap);
    if (cap !== null && cap > 0) amount = Math.min(amount, cap);
    return round2(amount);
  }
  return toMoney(v.used_price ?? v.discount_value);
}

/**
 * 从店铺券里挑出该售价可用的、折抵最大的一张。
 *
 * 券字段单位是 1/100000，price 是元。折抵额不会超过售价本身。
 */
function pickVoucherDiscount(vouchers, price) {
  if (!Array.isArray(vouchers) || price === null || price === undefined || price <= 0) {
    return null;
  }
  let best = 0;
  for (const v of vouchers) {
    if (!v || typeof v !== 'object') continue;
    const minSpend = toMoney(v.min_spend);
    if (minSpend !== null && price < minSpend) continue;
    const amount = voucherAmount(v, price);
    if (amount !== null && amount > best) best = amount;
  }
  if (best <= 0) return null;
  return round2(Math.min(best, price));
}

function toMoney(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.round((n / PRICE_DIVISOR) * 100) / 100;
}

function computeVoucher(price, site) {
  if (site !== 'tw' || price === null || price < 0) return null;
  const usable = VOUCHERS_TW.filter(([min]) => price >= min).map(([, amt]) => amt);
  if (!usable.length) return null;
  return Math.round((price - Math.max(...usable)) * 100) / 100;
}

function tierIndicesOf(model) {
  const ext = model.extinfo && typeof model.extinfo === 'object' ? model.extinfo : {};
  const raw = ext.tier_index;
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : -1;
  });
}

function dimsOf(tiers, indices) {
  return indices.map((idx, group) => {
    const opts = tiers[group] && Array.isArray(tiers[group].options) ? tiers[group].options : [];
    return idx >= 0 && idx < opts.length ? String(opts[idx]) : '';
  });
}

function tierLabel(name, option) {
  if (name && option) return `${name}: ${option}`;
  return option || name || '';
}

function modelAvailable(model, item) {
  const stock = model.has_stock ?? item.has_stock ?? true;
  const clickable = model.is_clickable ?? item.is_clickable ?? true;
  return Boolean(stock) && Boolean(clickable);
}

function modelStock(model, item) {
  for (const src of [model, item]) {
    if (src && typeof src === 'object' && typeof src.stock === 'number' && Number.isFinite(src.stock)) {
      return Math.trunc(src.stock);
    }
  }
  return null;
}

function buildRows({
  shopName,
  targetShopId,
  site,
  itemCard,
  pdpItem,
  shopVouchers = [],
  withVoucher,
}) {
  const shopId = String(itemCard.shop_id || targetShopId || pdpItem.shopid || '');
  const itemId = String(itemCard.item_id || pdpItem.itemid || '');
  if (!itemId) return [];

  // 商品页接口给的是 title；name 只存在于列表卡片，作为兜底
  const itemName = String(pdpItem.title || pdpItem.name || itemCard.item_name || '').trim();
  const tiers = normalizeTiers(pdpItem.tier_variations ?? itemCard.tier_variations);
  const currency = String(pdpItem.currency || 'TWD');
  const ts = new Date().toISOString();
  const itemUrl = buildItemUrl(site, shopId, itemId);
  const models = Array.isArray(pdpItem.models) ? pdpItem.models : [];

  const base = {
    shop_name: shopName,
    shop_id: shopId,
    site,
    item_id: itemId,
    item_name: itemName,
    item_url: itemUrl,
    currency,
    collected_at: ts,
  };

  // 两列折扣都按规格自己的售价算：商品折扣 = 划线价 - 售价，券折扣 = 该售价可用的最优店铺券
  const discountsOf = (price, priceBefore) => ({
    itemDiscount:
      price !== null && priceBefore !== null && priceBefore > price
        ? round2(priceBefore - price)
        : null,
    voucherDiscount: pickVoucherDiscount(shopVouchers, price),
  });

  // 无规格商品：接口不给 models，价格挂在 item 上，产一行 model_id=0
  if (!models.length) {
    const available = modelAvailable(pdpItem, pdpItem);
    const price = available ? toMoney(pdpItem.price) : null;
    const before = toMoney(pdpItem.price_before_discount);
    const priceBefore = available && before ? before : null;
    const { itemDiscount, voucherDiscount } = discountsOf(price, priceBefore);
    return [
      {
        ...base,
        model_id: '0',
        model_name: '（无规格）',
        tier1: '',
        tier2: '',
        price,
        price_before_discount: priceBefore,
        discount_percent:
          available && price !== null && priceBefore
            ? Math.round((price / priceBefore) * 1000) / 10
            : null,
        item_discount: itemDiscount,
        voucher_discount: voucherDiscount,
        voucher_price: available && withVoucher ? computeVoucher(price, site) : null,
        stock: modelStock(pdpItem, pdpItem),
        available,
        raw_price: available ? null : toMoney(pdpItem.price),
      },
    ];
  }

  const rows = [];
  for (const model of models) {
    if (!model || typeof model !== 'object') continue;
    const modelId = model.model_id ?? model.modelid;
    if (modelId === null || modelId === undefined || modelId === '') continue;

    const indices = tierIndicesOf(model);
    const dims = dimsOf(tiers, indices);
    const available = modelAvailable(model, pdpItem);
    const price = available ? toMoney(model.price) : null;
    const before = toMoney(model.price_before_discount);
    const priceBefore = available && before ? before : null;
    const { itemDiscount, voucherDiscount } = discountsOf(price, priceBefore);

    rows.push({
      ...base,
      model_id: String(modelId),
      model_name: String(model.name || '').trim() || dims.filter(Boolean).join(' / '),
      tier1: tierLabel(tiers[0]?.name ?? '', dims[0] ?? ''),
      tier2: tierLabel(tiers[1]?.name ?? '', dims[1] ?? ''),
      price,
      price_before_discount: priceBefore,
      discount_percent:
        available && price !== null && priceBefore
          ? Math.round((price / priceBefore) * 1000) / 10
          : null,
      item_discount: itemDiscount,
      voucher_discount: voucherDiscount,
      voucher_price: available && withVoucher ? computeVoucher(price, site) : null,
      stock: modelStock(model, pdpItem),
      available,
      raw_price: available ? null : toMoney(model.price),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// CSV（流式：边采边写，中断也留得住已采部分）
// ---------------------------------------------------------------------------

class CsvSink {
  constructor(path, headerLang = 'zh') {
    this.path = path;
    this.lang = headerLang;
    this.rows = 0;
    mkdirSync(dirname(resolve(path)), { recursive: true });
    this.fd = openSync(path, 'w');
    const header = COLUMNS.map(([, zh, en]) => (headerLang === 'zh' ? zh : en));
    writeSync(this.fd, '\uFEFF' + header.map(csvCell).join(',') + '\n');
    this.header = header;
  }

  write(rows) {
    if (!rows.length) return 0;
    const lines = rows.map((row) =>
      COLUMNS.map(([key]) => csvCell(cellValue(row[key], this.lang))).join(','),
    );
    writeSync(this.fd, lines.join('\n') + '\n');
    this.rows += rows.length;
    return rows.length;
  }

  close() {
    try {
      closeSync(this.fd);
    } catch {
      /* 已关闭 */
    }
  }
}

function cellValue(v, lang) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return lang === 'zh' ? (v ? '是' : '否') : v ? 'true' : 'false';
  return v;
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ---------------------------------------------------------------------------
// CDP 客户端（Node 22 原生 WebSocket，零依赖）
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * CDP 客户端。
 *
 * 连的是 **browser 级** WebSocket（/devtools/browser），不是 page 级：
 * 新版 Chrome 已禁用 /json/version、/json/list 这些 HTTP 端点，但 browser
 * WebSocket 仍可用。页面命令通过 Target.attachToTarget(flatten) 拿到的
 * sessionId 路由，这也是 Playwright / puppeteer 内部的做法。
 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.sessionId = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: ok, reject: fail } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) fail(new Error(`${msg.error.message} (${msg.error.code})`));
        else ok(msg.result);
        return;
      }
      if (!msg.method) return;
      // 只处理属于本页面 session 的事件（浏览器级事件没有 sessionId）
      if (this.sessionId && msg.sessionId && msg.sessionId !== this.sessionId) return;
      for (const fn of this.listeners.get(msg.method) ?? []) {
        try {
          fn(msg.params);
        } catch {
          /* 单个监听器异常不影响其它 */
        }
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('连接 CDP WebSocket 超时')), 15000);
      ws.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error('CDP WebSocket 连接失败')); }, { once: true });
    });
    return new Cdp(ws);
  }

    /** 发命令；默认带当前页面 sessionId，传 null 可显式走浏览器级。 */
  send(method, params = {}, opts = {}) {
    const { sessionId = this.sessionId, timeoutMs = 60000 } = opts;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 连接浏览器，带重试。
 *
 * Chrome 对短时间内的重复 CDP 连接偶尔会拒绝一次（上一个连接还在关闭，
 * 或用户正在切标签页）。单次失败就告诉用户「环境没配好」是误报，所以重试。
 */
async function connectWithRetry(wsUrl, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await Cdp.connect(wsUrl);
    } catch (err) {
      lastErr = err;
      if (i < attempts) await sleep(700 * i);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// 采集器
// ---------------------------------------------------------------------------

class Scraper {
  constructor(opts) {
    this.opts = opts;
    this.deadline = Date.now() + opts.timeoutSeconds * 1000;
    this.captured = [];
    this.lastCaptureAt = 0;
    this.hitRisk = false;
    this.itemsOk = 0;
    this.itemsFailed = 0;
    this.failedItems = [];
    // 列表接口自报的商品总数，用来交叉校验有没有漏采
    this.expectedTotal = null;
  }

  async attach(cdp) {
    this.cdp = cdp;
    const pendingUrls = new Map();

    cdp.on('Network.responseReceived', (p) => {
      const url = p?.response?.url ?? '';
      if (url.includes(LIST_MARKER) || url.includes(PDP_MARKER)) {
        pendingUrls.set(p.requestId, url);
      }
    });

    cdp.on('Network.loadingFinished', (p) => {
      const url = pendingUrls.get(p.requestId);
      if (!url) return;
      pendingUrls.delete(p.requestId);
      cdp
        .send('Network.getResponseBody', { requestId: p.requestId }, 15000)
        .then(({ body, base64Encoded }) => {
          const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
          this.captured.push({ url, body: JSON.parse(text), at: Date.now() });
          this.lastCaptureAt = Date.now();
        })
        .catch(() => {
          /* 响应体已释放或非 JSON，单条失败不致命 */
        });
    });
  }

  resetCapture() {
    this.captured = [];
    this.lastCaptureAt = 0;
  }

  takeCaptured(marker) {
    const hit = this.captured.filter((c) => c.url.includes(marker));
    return hit.map((c) => c.body);
  }

  remainingMs() {
    return Math.max(0, this.deadline - Date.now());
  }

  async evalJs(expression) {
    const res = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || '页面脚本执行失败');
    return res.result?.value;
  }

  async currentUrl() {
    return String(await this.evalJs('location.href'));
  }

  async navigate(url, timeoutMs = 45000) {
    await this.cdp.send('Page.navigate', { url }, Math.max(5000, timeoutMs));
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await sleep(300);
      try {
        const state = await this.evalJs('document.readyState');
        if (state === 'complete' || state === 'interactive') return;
      } catch {
        /* 导航中间态取不到，继续等 */
      }
    }
  }

  async scrollBottom() {
    for (let i = 0; i < SCROLL_TIMES; i++) {
      try {
        await this.evalJs('window.scrollTo(0, document.body.scrollHeight)');
      } catch {
        return;
      }
      await sleep(SCROLL_INTERVAL_MS);
    }
    try {
      await this.evalJs('window.scrollTo(0, 0)');
      await sleep(400);
    } catch {
      /* ignore */
    }
  }

  async waitCaptured(marker, { timeoutMs = 45000, quietMs = 1000 } = {}) {
    const started = Date.now();
    let lastCount = -1;
    let lastChange = started;
    while (Date.now() - started < timeoutMs) {
      const count = this.captured.filter((c) => c.url.includes(marker)).length;
      if (count !== lastCount) {
        lastCount = count;
        lastChange = Date.now();
      }
      if (count > 0 && Date.now() - lastChange >= quietMs) return count;
      await sleep(200);
    }
    return lastCount > 0 ? lastCount : 0;
  }

  async pageReady() {
    try {
      const len = await this.evalJs(
        "document.body ? document.body.innerText.trim().length : 0",
      );
      return Number(len) > 150;
    } catch {
      return true;
    }
  }

  async checkRisk(resumeUrl) {
    const code = detectRisk(await this.currentUrl());
    if (!code) return;

    this.hitRisk = true;
    emit(code === 'SHOPEE_AUTH_REQUIRED' ? 'need_login' : 'need_verify', {
      url: await this.currentUrl(),
      message: riskMessage(code),
      wait_seconds: this.opts.loginWaitSeconds,
      hint: '请在你自己的 Chrome 窗口里完成操作，脚本会自动继续',
    });
    log(riskMessage(code));

    const started = Date.now();
    let lastNav = started;
    let lastEmit = 0;

    while (Date.now() - started < this.opts.loginWaitSeconds * 1000) {
      await sleep(3000);
      const url = await this.currentUrl();

      if (!detectRisk(url)) {
        if (await this.pageReady()) {
          emit('login_ok', { url });
          log('检测到已通过，回到目标页继续');
          await this.navigate(resumeUrl);
          return;
        }
      } else if (Date.now() - lastNav > 20000) {
        lastNav = Date.now();
        try {
          await this.navigate(resumeUrl, 30000);
        } catch {
          /* 被拦回也算预期 */
        }
        if (!detectRisk(await this.currentUrl()) && (await this.pageReady())) {
          emit('login_ok', { url: await this.currentUrl() });
          log('检测到已通过，继续采集');
          return;
        }
      }

      if (Date.now() - lastEmit > 15000) {
        lastEmit = Date.now();
        emit('waiting_login', {
          remaining: Math.max(
            0,
            Math.round(this.opts.loginWaitSeconds - (Date.now() - started) / 1000),
          ),
        });
      }
    }

    throw new ScrapeError(
      `等待人工${code === 'SHOPEE_AUTH_REQUIRED' ? '登录' : '验证'}超时（${this.opts.loginWaitSeconds} 秒）`,
      code,
      true,
    );
  }

  async collectList() {
    const merged = new Map();
    for (let pageIndex = 0; pageIndex < MAX_LIST_PAGES; pageIndex++) {
      if (Date.now() > this.deadline) {
        throw new ScrapeError('采集商品列表超时', 'SHOPEE_TIMEOUT');
      }
      const url = buildShopUrl(this.opts.username, this.opts.site, pageIndex);

      this.resetCapture();
      await this.navigate(url);
      await this.scrollBottom();
      await this.waitCaptured(LIST_MARKER, { timeoutMs: 60000 });
      await this.checkRisk(url);

      const bodies = this.takeCaptured(LIST_MARKER);
      if (!bodies.length) {
        if (!merged.size) {
          if (isHomeUrl(await this.currentUrl())) {
            throw new ScrapeError(
              `店铺「${this.opts.username}」不存在或已关闭：打开后被跳回了站点首页。请确认店铺首页链接。`,
              'SHOPEE_BAD_SHOP_ARG',
            );
          }
          if (this.hitRisk) {
            throw new ScrapeError(
              '商品列表没加载出来，而本次运行撞过虾皮安全验证。请确认该店铺页在你的浏览器里能正常显示商品后重跑。',
              'SHOPEE_LIST_NOT_CAPTURED',
              true,
            );
          }
          throw new ScrapeError(
            '未捕获到店铺页自身的商品列表请求（rcmd_items）。可能是账号名不对、页面打不开，或页面结构已变。',
            'SHOPEE_LIST_NOT_CAPTURED',
          );
        }
        break;
      }

      let noMore = false;
      let added = 0;
      for (const body of bodies) {
        const parsed = parseItemCards(body);
        noMore = noMore || parsed.noMore;
        if (parsed.total && this.expectedTotal === null) this.expectedTotal = parsed.total;
        for (const card of parsed.cards) {
          if (!merged.has(card.item_id)) {
            merged.set(card.item_id, card);
            added++;
          }
        }
      }
      emit('list_page', { page: pageIndex + 1, new: added, total: merged.size, no_more: noMore });
      log(`列表第 ${pageIndex + 1} 页：新增 ${added}，累计 ${merged.size}`);
      if (noMore) break;
      if (pageIndex < MAX_LIST_PAGES - 1) await sleep(1200);
    }

    const collected = [...merged.values()];
    // 接口自报 total 时做交叉校验：不一致说明翻页漏了，不能当成功悄悄放过
    if (this.expectedTotal !== null && collected.length < this.expectedTotal) {
      emit('count_mismatch', { expected: this.expectedTotal, collected: collected.length });
      log(
        `注意：接口称共 ${this.expectedTotal} 个商品，实际采到 ${collected.length} 个（可能有商品被平台隐藏或翻页未覆盖）`,
      );
    }
    return collected;
  }

  async collectItem(card) {
    const shopId = String(card.shop_id || '').trim();
    const url = buildItemUrl(this.opts.site, shopId, card.item_id);
    if (!url) return null;

    this.resetCapture();
    await this.navigate(url, 45000);
    await this.waitCaptured(PDP_MARKER, { timeoutMs: 45000 });
    await this.checkRisk(url);

    for (const body of this.takeCaptured(PDP_MARKER)) {
      const payload = parsePdpPayload(body);
      if (payload) return payload;
    }
    return null;
  }

  async run(sink) {
    const shopUrl = buildShopUrl(this.opts.username, this.opts.site, 0);
    await this.navigate(shopUrl);
    await this.checkRisk(shopUrl);

    let cards = await this.collectList();
    if (!cards.length) {
      throw new ScrapeError('店铺页没有解析到任何商品', 'SHOPEE_LIST_NOT_CAPTURED');
    }
    const found = cards.length;
    if (this.opts.maxItems > 0 && found > this.opts.maxItems) {
      cards = cards.slice(0, this.opts.maxItems);
      emit('truncated', { found, using: cards.length });
      log(`共 ${found} 个商品，按 --max-items 只采前 ${cards.length} 个`);
    }

    const fallbackShopId = cards.find((c) => c.shop_id)?.shop_id ?? '';
    const shopName = this.opts.shopName || this.opts.username;
    emit('items_found', { total: cards.length, shop_name: shopName });

    for (let i = 0; i < cards.length; i++) {
      if (Date.now() > this.deadline) throw new ScrapeError('采集总超时', 'SHOPEE_TIMEOUT');
      const card = cards[i];
      const index = i + 1;

      let pdp = null;
      let reason = '未捕获到商品页价格接口';
      try {
        pdp = await this.collectItem(card);
      } catch (err) {
        if (err instanceof ScrapeError && (err.needUser || err.code === 'SHOPEE_AUTH_REQUIRED' || err.code === 'SHOPEE_CAPTCHA_BLOCKED')) {
          throw err;
        }
        reason = err instanceof Error ? err.message : String(err);
        log(`[${index}/${cards.length}] 商品 ${card.item_id} 失败：${reason}`);
      }

      if (!pdp) {
        this.itemsFailed++;
        this.failedItems.push({ item_id: card.item_id, reason });
        emit('item_failed', { index, total: cards.length, item_id: card.item_id, reason });
      } else {
        const rows = buildRows({
          shopName,
          targetShopId: String(card.shop_id || fallbackShopId || ''),
          site: this.opts.site,
          itemCard: card,
          pdpItem: pdp.item,
          shopVouchers: pdp.shopVouchers,
          withVoucher: this.opts.withVoucher,
        });
        if (!rows.length) {
          this.itemsFailed++;
          this.failedItems.push({ item_id: card.item_id, reason: '解析不到规格' });
          emit('item_failed', { index, total: cards.length, item_id: card.item_id, reason: '解析不到规格' });
        } else {
          const written = sink.write(rows);
          this.itemsOk++;
          emit('item', {
            index,
            total: cards.length,
            item_id: card.item_id,
            item_name: rows[0].item_name,
            variants: written,
            rows_total: sink.rows,
          });
          log(`[${index}/${cards.length}] 商品 ${card.item_id}：${written} 个规格`);
        }
      }

      if (index < cards.length) {
        const base = Math.max(this.opts.delayMs, 0);
        const jitter = 0.8 + Math.random() * 0.5;
        await sleep(base * jitter);
      }
    }

    if (cards.length && this.itemsOk === 0) {
      throw new ScrapeError(`${cards.length} 个商品全部采集失败`, 'SHOPEE_ALL_ITEMS_FAILED');
    }

    return {
      items_total: cards.length,
      items_ok: this.itemsOk,
      items_failed: this.itemsFailed,
      rows_written: sink.rows,
      failed_items: this.failedItems.slice(0, 50),
    };
  }
}

// ---------------------------------------------------------------------------
// 参数与入口
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    shop: '',
    site: 'tw',
    out: '',
    maxItems: 0,
    delayMs: 1500,
    timeoutSeconds: 3600,
    loginWaitSeconds: 420,
    headerLang: 'zh',
    shopName: '',
    withVoucher: true,
    cdpPort: 9222,
    readexpr: false,
    selfTest: false,
    checkBrowser: false,
    probe: '',
  };
  const takesValue = new Set([
    'shop', 'site', 'out', 'max-items', 'delay-ms', 'timeout',
    'login-wait', 'header', 'shop-name', 'cdp-port', 'probe',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'help') {
      opts.help = true;
      continue;
    }
    if (key === 'self-test') { opts.selfTest = true; continue; }
    if (key === 'check-browser') { opts.checkBrowser = true; continue; }
    if (key === 'no-voucher') { opts.withVoucher = false; continue; }
    if (!takesValue.has(key)) continue;
    const value = argv[++i];
    switch (key) {
      case 'shop': opts.shop = value; break;
      case 'site': opts.site = value; break;
      case 'out': opts.out = value; break;
      case 'max-items': opts.maxItems = Number(value) || 0; break;
      case 'delay-ms': opts.delayMs = Number(value) || 0; break;
      case 'timeout': opts.timeoutSeconds = Math.max(60, Number(value) || 3600); break;
      case 'login-wait': opts.loginWaitSeconds = Math.max(30, Number(value) || 420); break;
      case 'header': opts.headerLang = value === 'en' ? 'en' : 'zh'; break;
      case 'shop-name': opts.shopName = value; break;
      case 'cdp-port': opts.cdpPort = Number(value) || 9222; break;
      case 'probe': opts.probe = value; break;
    }
  }
  return opts;
}

function printHelp() {
  process.stderr.write(`抓取虾皮店铺全部商品及其规格售价，导出 CSV。

用法：
  node scrape.mjs --shop <店铺链接或账号名> [--site tw] [--out 目录或csv]

参数：
  --shop, -s        店铺首页链接、@账号名或账号名（必填）
  --site            站点 tw/sg/my/th/ph/vn/id/br，默认 tw（给完整链接时自动识别）
  --out             输出 CSV 路径或目录，默认当前目录
  --max-items       最多采集多少个商品，0 = 全部
  --delay-ms        商品之间等待毫秒，默认 1500（会乘 0.8-1.3 抖动）
  --timeout         整体超时秒数，默认 3600
  --login-wait      等待人工登录/验证的秒数，默认 420
  --header          CSV 表头语言 zh|en，默认 zh
  --shop-name       CSV 里的店铺名，默认用账号名
  --no-voucher      不算参考券后价
  --cdp-port        Chrome 调试端口，默认 9222
  --check-browser   只检查能否连上 Chrome，不采集
  --probe <商品URL> 抓单个商品的价格与券结构，用于排查站点差异
  --self-test       跑离线解析自检，不联网

前置：Chrome 已开启远程调试（chrome://inspect/#remote-debugging）。
`);
}

/**
 * 诊断单个商品：抓一次 pdp，输出券与价格明细。
 *
 * 不同站点的券类型分布不同（固定金额 / 百分比 / 带上限），没有真实样本时
 * 只能按启发式处理。这个命令用来让有登录态的机器产出样本。
 */
async function probeProduct(opts) {
  const wsUrl = `ws://127.0.0.1:${opts.cdpPort}/devtools/browser`;
  let cdp;
  try {
    cdp = await connectWithRetry(wsUrl);
  } catch {
    emit('error', {
      code: 'BROWSER_NOT_CONNECTED',
      message: `连不上 Chrome 调试端口 ${opts.cdpPort}`,
      need_user: true,
    });
    return 3;
  }

  let targetId = null;
  const bodies = [];
  const pendingIds = new Set();

  try {
    const created = await cdp.send('Target.createTarget', { url: 'about:blank' }, { sessionId: null });
    targetId = created.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, { sessionId: null });
    cdp.sessionId = attached.sessionId;

    cdp.on('Network.responseReceived', (p) => {
      if (String(p?.response?.url ?? '').includes(PDP_MARKER)) pendingIds.add(p.requestId);
    });
    cdp.on('Network.loadingFinished', (p) => {
      if (!pendingIds.has(p.requestId)) return;
      pendingIds.delete(p.requestId);
      cdp
        .send('Network.getResponseBody', { requestId: p.requestId }, 15000)
        .then(({ body, base64Encoded }) => {
          const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
          bodies.push(JSON.parse(text));
        })
        .catch(() => {});
    });

    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.navigate', { url: opts.probe }, 45000);
    for (let i = 0; i < 40 && !bodies.length; i++) await sleep(500);

    if (!bodies.length) {
      emit('error', {
        code: 'PDP_NOT_CAPTURED',
        message: '没抓到商品页价格接口。页面可能打不开、需要登录，或商品已下架。',
        need_user: false,
      });
      return 1;
    }

    const data = bodies[0].data;
    if (!data) {
      emit('error', {
        code: 'PDP_INVALID',
        message: `响应没有 data（error=${bodies[0].error}），可能被风控降级`,
        need_user: false,
      });
      return 1;
    }

    const m = data.item?.models?.[0];
    emit('probe', {
      url: opts.probe,
      currency: data.item?.currency,
      model0: m
        ? {
            model_id: m.model_id,
            price: m.price,
            price_before_discount: m.price_before_discount,
            has_stock: m.has_stock,
          }
        : null,
      shop_vouchers: (data.shop_vouchers ?? []).map((v) => ({
        code: v.voucher_code,
        type: v.voucher_discount_type,
        min_spend: v.min_spend,
        used_price: v.used_price,
        discount_value: v.discount_value,
        discount_percentage: v.discount_percentage,
        discount_cap: v.discount_cap,
      })),
      price_breakdown: data.price_breakdown ?? null,
    });
    return 0;
  } catch (err) {
    emit('error', { code: 'PROBE_FAILED', message: String(err), need_user: false });
    return 1;
  } finally {
    if (targetId) {
      try {
        await cdp.send('Target.closeTarget', { targetId }, { sessionId: null });
      } catch {
        /* 关不掉不影响结果 */
      }
    }
    cdp.close();
  }
}

function defaultOutPath(username) {
  const stamp = new Date()
    .toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
    .replace(/[: ]/g, '')
    .replace(/-/g, '');
  const safe = username.replace(/[^\w.-]/g, '_') || 'shop';
  return join(process.cwd(), `shopee_${safe}_${stamp}.csv`);
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  if (opts.help) {
    printHelp();
    return 0;
  }
  if (opts.selfTest) return selfTest();

  if (opts.probe) return probeProduct(opts);

  if (opts.checkBrowser) {
    try {
      const probe = await connectWithRetry(`ws://127.0.0.1:${opts.cdpPort}/devtools/browser`);
      const v = await probe.send('Browser.getVersion', {}, { sessionId: null });
      probe.close();
      emit('browser_ok', { browser: v?.product ?? 'Chrome', port: opts.cdpPort });
      return 0;
    } catch {
      emit('error', {
        code: 'BROWSER_NOT_CONNECTED',
        message:
          `连不上 Chrome 调试端口 ${opts.cdpPort}。请在 Chrome 打开 ` +
          'chrome://inspect/#remote-debugging 勾选“Allow remote debugging for this browser instance”，' +
          '然后重试。',
        need_user: true,
      });
      return 3;
    }
  }

  if (!opts.shop) {
    printHelp();
    emit('error', { code: 'MISSING_ARG', message: '缺少 --shop', need_user: false });
    return 2;
  }

  let parsed;
  try {
    parsed = normalizeShopArg(opts.shop, opts.site);
  } catch (err) {
    emit('error', { code: err.code ?? 'SHOPEE_BAD_SHOP_ARG', message: err.message, need_user: false });
    return 2;
  }
  opts.username = parsed.username;
  opts.site = parsed.site;

  const generated = defaultOutPath(parsed.username);
  const outPath = opts.out
    ? opts.out.endsWith('.csv')
      ? resolve(opts.out)
      : join(resolve(opts.out), basename(generated))
    : generated;

  const wsUrl = `ws://127.0.0.1:${opts.cdpPort}/devtools/browser`;
  let cdp;
  try {
    cdp = await connectWithRetry(wsUrl);
  } catch {
    emit('error', {
      code: 'BROWSER_NOT_CONNECTED',
      message:
        `连不上 Chrome 调试端口 ${opts.cdpPort}。请先运行 web-access 的 check-deps，` +
        '或在 Chrome 打开 chrome://inspect/#remote-debugging 勾选允许远程调试。',
      need_user: true,
    });
    return 3;
  }

  let browserProduct = 'Chrome';
  try {
    const v = await cdp.send('Browser.getVersion', {}, { sessionId: null });
    if (v?.product) browserProduct = v.product;
  } catch {
    /* 取不到版本不影响采集 */
  }

  emit('start', {
    shop: parsed.username,
    site: opts.site,
    shop_url: buildShopUrl(parsed.username, opts.site, 0),
    csv: outPath,
    browser: browserProduct,
  });
  log(`目标店铺 ${parsed.username}（${opts.site}），文件 ${outPath}`);

  let targetId = null;
  let sink = null;

  try {
    // 在浏览器里新开一个后台 tab，不碰用户已有的页面
    const created = await cdp.send('Target.createTarget', { url: 'about:blank' }, { sessionId: null });
    targetId = created.targetId;
    const attached = await cdp.send(
      'Target.attachToTarget',
      { targetId, flatten: true },
      { sessionId: null },
    );
    cdp.sessionId = attached.sessionId;

    sink = new CsvSink(outPath, opts.headerLang);
    const scraper = new Scraper(opts);
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    // 需要人工登录/验证时，用户得看得见这个 tab，否则无人可操作
    try {
      await cdp.send('Page.bringToFront');
      await cdp.send('Target.activateTarget', { targetId }, { sessionId: null });
    } catch {
      /* 激活失败不影响采集，只是需要用户手动找一下标签页 */
    }
    await scraper.attach(cdp);

    const result = await scraper.run(sink);
    sink.close();
    sink = null;
    emit('done', {
      csv: outPath,
      rows: result.rows_written,
      items_ok: result.items_ok,
      items_failed: result.items_failed,
      items_total: result.items_total,
      failed_items: result.failed_items,
    });
    return 0;
  } catch (err) {
    const code = err instanceof ScrapeError ? err.code : 'UNEXPECTED';
    emit('error', {
      code,
      message: err instanceof Error ? err.message : String(err),
      need_user: err instanceof ScrapeError ? err.needUser : false,
    });
    if (!(err instanceof ScrapeError)) log(err.stack);
    return err instanceof ScrapeError && err.needUser ? 2 : 1;
  } finally {
    if (sink) sink.close();
    if (targetId) {
      try {
        await cdp.send('Target.closeTarget', { targetId }, { sessionId: null });
      } catch {
        /* 关不掉不影响结果 */
      }
    }
    cdp.close();
  }
}

// ---------------------------------------------------------------------------
// 离线自检
// ---------------------------------------------------------------------------

function selfTest() {
  const failures = [];
  const check = (name, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) failures.push(`${name}: 期望 ${e}，实际 ${a}`);
  };

  check('解析店铺页 URL', parseShopUsername('https://shopee.tw/esim_go'), 'esim_go');
  check('商品页 URL 不算店铺名', parseShopUsername('https://shopee.tw/product/1/2'), '');
  check('站点识别', siteFromUrl('https://shopee.sg/abc'), 'sg');
  check('首页判断', isHomeUrl('https://shopee.sg/'), true);
  check('店铺页不是首页', isHomeUrl('https://shopee.sg/nike'), false);
  check('风控-登录', detectRisk('https://shopee.sg/buyer/login?x=1'), 'SHOPEE_AUTH_REQUIRED');
  check('风控-验证', detectRisk('https://shopee.sg/verify/traffic/error'), 'SHOPEE_CAPTCHA_BLOCKED');
  check('风控-正常', detectRisk('https://shopee.sg/nike'), '');
  check('金额换算', toMoney(119900000), 1199);
  check('金额空值', toMoney(null), null);
  check('券后价 满399', computeVoucher(399, 'tw'), 369);
  check('券后价 不足门槛', computeVoucher(19, 'tw'), null);
  check('券后价 非台湾站不算', computeVoucher(500, 'sg'), null);

  const listBody = {
    data: {
      centralize_item_card: {
        item_cards: [
          {
            itemid: 111,
            shopid: 9001,
            item_basic: { name: '商品甲' },
            tier_variations: [{ name: '天數', options: ['3天', '7天'] }],
          },
          { itemid: 112, item_basic: { name: '商品乙' } },
        ],
      },
      no_more: true,
    },
  };
  const parsedList = parseItemCards(listBody);
  check('列表解析-数量', parsedList.cards.length, 2);
  check('列表解析-no_more', parsedList.noMore, true);
  check('列表解析-首条 id', parsedList.cards[0].item_id, '111');
  check('列表解析-维度名', parsedList.cards[0].tier_variations[0].name, '天數');

  // rcmd_items 包在 data 里；search_items 直接在外层，字段名也不一样
  const withTotal = {
    data: { ...listBody.data, total: 25 },
  };
  check('列表解析-total', parseItemCards(withTotal).total, 25);

  const outerBody = {
    error: 0,
    total_count: 2,
    nomore: true,
    centralize_item_card: {
      item_cards: [
        { itemid: 201, shopid: 9002, item_card_displayed_asset: { name: '外层商品甲' } },
        { itemid: 202, shopid: 9002, item_card_displayed_asset: { name: '外层商品乙' } },
      ],
    },
  };
  const outerParsed = parseItemCards(outerBody);
  check('外层结构-数量', outerParsed.cards.length, 2);
  check('外层结构-nomore', outerParsed.noMore, true);
  check('外层结构-total_count', outerParsed.total, 2);
  check('外层结构-商品名', outerParsed.cards[0].item_name, '外层商品甲');

  const pdp = {
    itemid: 111,
    shopid: 9001,
    title: '商品甲-页面标题',
    name: '商品甲-卡片名',
    currency: 'TWD',
    tier_variations: [{ name: '天數', options: ['3天', '7天'] }],
    models: [
      {
        model_id: 700, name: '3天', price: 119900000, price_before_discount: 199900000,
        has_stock: true, is_clickable: true, stock: 12, extinfo: { tier_index: [0] },
      },
      {
        model_id: 701, name: '7天', price: 259900000,
        has_stock: false, is_clickable: true, extinfo: { tier_index: [1] },
      },
    ],
  };
  const rows = buildRows({
    shopName: 'eSIMGO', targetShopId: '9001', site: 'tw',
    itemCard: { item_id: '111', shop_id: '9001', item_name: '商品甲' },
    pdpItem: pdp, withVoucher: true,
  });
  check('造行-规格数', rows.length, 2);
  check('造行-标题优先用 title', rows[0].item_name, '商品甲-页面标题');
  check('造行-有货价', rows[0].price, 1199);
  check('造行-折扣', rows[0].discount_percent, 60);
  check('造行-券后价', rows[0].voucher_price, 1169);
  check('造行-维度1', rows[0].tier1, '天數: 3天');
  check('造行-缺货价留空', rows[1].price, null);
  check('造行-缺货保留原价', rows[1].raw_price, 2599);
  check('造行-缺货可售', rows[1].available, false);

  const flatRows = buildRows({
    shopName: 'S', targetShopId: '9001', site: 'tw',
    itemCard: { item_id: '113', shop_id: '9001' },
    pdpItem: { itemid: 113, shopid: 9001, name: '无规格', price: 9900000, currency: 'TWD' },
    withVoucher: true,
  });
  check('无规格-行数', flatRows.length, 1);
  check('无规格-model_id', flatRows[0].model_id, '0');
  check('无规格-价格', flatRows[0].price, 99);

  // 折扣两列：商品折扣 = 划线价 - 售价；券折扣取该售价可用的最大张
  check('造行-商品折扣', rows[0].item_discount, 800);
  check('造行-无券时券折扣为空', rows[0].voucher_discount, null);

  const voucherRows = buildRows({
    shopName: 'S', targetShopId: '9001', site: 'my',
    itemCard: { item_id: '111', shop_id: '9001' },
    pdpItem: {
      itemid: 111, shopid: 9001, title: '券测试', currency: 'MYR',
      models: [{
        model_id: 900, price: 2000000, price_before_discount: 5000000,
        has_stock: true, is_clickable: true, extinfo: { tier_index: [0] },
      }],
    },
    shopVouchers: [
      { voucher_discount_type: 0, min_spend: 2000000, used_price: 300000 },
      { voucher_discount_type: 0, min_spend: 1000000, used_price: 100000 },
    ],
    withVoucher: true,
  });
  check('券折扣-取折抵最大', voucherRows[0].voucher_discount, 3);
  check('券折扣-商品折扣', voucherRows[0].item_discount, 30);

  const belowMinRows = buildRows({
    shopName: 'S', targetShopId: '9001', site: 'my',
    itemCard: { item_id: '112', shop_id: '9001' },
    pdpItem: {
      itemid: 112, shopid: 9001, title: '低价商品', currency: 'MYR',
      models: [{
        model_id: 901, price: 500000,
        has_stock: true, is_clickable: true, extinfo: { tier_index: [0] },
      }],
    },
    shopVouchers: [{ voucher_discount_type: 0, min_spend: 2000000, used_price: 300000 }],
    withVoucher: true,
  });
  check('券折扣-未达门槛为空', belowMinRows[0].voucher_discount, null);

  // 百分比券：直接取自 shopee.sg 实测响应（10 表示 10%，不是 ×100 存储）
  const pctRow = (pct, cap) =>
    buildRows({
      shopName: 'S', targetShopId: '1', site: 'sg',
      itemCard: { item_id: '201', shop_id: '1' },
      pdpItem: {
        itemid: 201, shopid: 1, title: '百分比券商品', currency: 'SGD',
        models: [{
          model_id: 1, price: 889000, price_before_discount: 1099000,
          has_stock: true, is_clickable: true, extinfo: { tier_index: [0] },
        }],
      },
      shopVouchers: [{ min_spend: 0, discount_percentage: pct, discount_cap: cap }],
      withVoucher: true,
    })[0];

  check('百分比券-10 表示 10%', pctRow(10, null).voucher_discount, 0.89);
  check('百分比券-受上限封顶', pctRow(10, 50000).voucher_discount, 0.5);
  check('百分比券-异常值按 100% 封顶', pctRow(1200, null).voucher_discount, 8.89);
  check('百分比券-商品折扣仍为差额', pctRow(10, null).item_discount, 2.1);

  const badRows = buildRows({
    shopName: 'S', targetShopId: '1', site: 'tw',
    itemCard: { item_id: '1', shop_id: '1' },
    pdpItem: { itemid: 1, shopid: 1, models: [{ name: '无名', price: 100000 }] },
    withVoucher: true,
  });
  check('缺 model_id 跳过', badRows.length, 0);

  // CSV 往返：表头与行必须对得上
  const tmp = join(process.cwd(), `.selftest_${process.pid}.csv`);
  try {
    const sink = new CsvSink(tmp, 'zh');
    sink.write(rows);
    sink.close();
    const raw = readFileSync(tmp, 'utf8');
    check('CSV 带 BOM', raw.charCodeAt(0), 0xfeff);
    const lines = raw.replace(/^\uFEFF/, '').trim().split('\n');
    check('CSV 行数', lines.length, 3);
    check('CSV 首列表头', lines[0].split(',')[0], '店铺名');
    check('CSV 首行含规格ID', lines[1].includes('700'), true);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }

  if (failures.length) {
    for (const f of failures) log(`自检失败 · ${f}`);
    emit('selftest', { ok: false, failures });
    return 1;
  }
  emit('selftest', { ok: true, checks: 'passed' });
  log('解析自检全部通过');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    emit('error', { code: 'FATAL', message: String(err), need_user: false });
    process.exit(1);
  });
