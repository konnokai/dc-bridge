// 模擬股票的交易規則：台股、A 模式（盤中或預約排隊、收盤結算）、股數下單。
//
// 這裡只碰交易域：帳戶、訂單、持倉、費用、結算與排行榜。報價由 quote-provider 提供，
// Discord 身分與訊息由橋接處理。模型看不到這裡的計算，也不能自己決定成交價。
//
// 金額全部用整數「分」；費率用 ppm（0.001425 → 1425）算，避免浮點數累積誤差。

import { randomBytes } from 'node:crypto';
import { findSymbol, resolveSymbol } from './trade-symbols.mjs';

export const ACCOUNT_KIND = Object.freeze({ PLAYER: 'player', BOT: 'bot' });

export function playerAccountId(userId) {
  return `user:${String(userId)}`;
}

export function botAccountId(clientId) {
  return `bot:${String(clientId)}`;
}

/** 台股升降單位（分）。ETF 只有兩級：未滿 50 元 0.01、50 元以上 0.05。 */
export function tickCents(priceCents, type = 'stock') {
  if (type === 'etf') return priceCents < 5_000 ? 1 : 5;
  if (priceCents < 1_000) return 1;      // 未滿 10 元：0.01
  if (priceCents < 5_000) return 5;      // 10–未滿 50：0.05
  if (priceCents < 10_000) return 10;    // 50–未滿 100：0.1
  if (priceCents < 50_000) return 50;    // 100–未滿 500：0.5
  if (priceCents < 100_000) return 100;  // 500–未滿 1000：1
  return 500;                            // 1000 以上：5
}

/**
 * 漲跌停價。台股是參考價 ×(1±limitPct) 後對齊升降單位：
 * 漲停向下取、跌停向上取，不能讓玩家拿到比規則更好的價格。
 * limitPct 逐檔不同（一般股票 10%、槓桿 ETF 20%），沒有 entry 時當一般股票。
 */
export function limitPrices(referenceCents, entry = null) {
  const type = entry?.type ?? 'stock';
  const limitPct = Number(entry?.limitPct) > 0 ? Number(entry.limitPct) : 10;
  const rawUp = Math.floor((referenceCents * (100 + limitPct)) / 100);
  const rawDown = Math.ceil((referenceCents * (100 - limitPct)) / 100);
  const up = Math.floor(rawUp / tickCents(rawUp, type)) * tickCents(rawUp, type);
  const down = Math.ceil(rawDown / tickCents(rawDown, type)) * tickCents(rawDown, type);
  return { tick: tickCents(referenceCents, type), up, down };
}

/**
 * 估漲跌停的參考價：最新一筆資料還停在 trade_date 之前時，參考價就是那筆收盤，
 * 不是「收盤 − 漲跌」（那會變成前一天的參考價）。同一天的資料才用 Change 回推。
 */
function referenceForTradeDate(latest, tradeDate) {
  if (!latest) return 0;
  if (latest.date < tradeDate) return latest.closeCents;
  return latest.referenceCents > 0 ? latest.referenceCents : latest.closeCents;
}
/** 手續費：成交金額 × 費率，無條件進位到分；最低手續費可設定。 */
export function feeCents(grossCents, ratePpm, minFeeCents = 0) {
  return Math.max(minFeeCents, Math.ceil((grossCents * ratePpm) / 1_000_000));
}

/** 證交稅：賣出金額 × 稅率，無條件進位到分。 */
export function taxCents(grossCents, ratePpm) {
  return Math.ceil((grossCents * ratePpm) / 1_000_000);
}

export function formatTwd(cents) {
  const value = Number(cents);
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(Math.round(value));
  return `${sign}NT$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

export function formatPct(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${number >= 0 ? '+' : ''}${number.toFixed(2)}%`;
}

/** "HH:MM" → 當日分鐘數；格式不對回 NaN。 */
export function parseHhmm(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? '').trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
}

const TAIPEI = 'Asia/Taipei';

/** 台北的日期與分鐘數。用 IANA 時區，不硬寫 UTC+8。 */
export function taipeiClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TAIPEI,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const [year, month, day] = date.split('-').map(Number);
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return {
    date,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    dayOfWeek,
  };
}

export const MARKET_PHASES = Object.freeze({
  HOLIDAY: 'holiday',
  PREOPEN: 'preopen',
  OPEN: 'open',
  AFTER: 'after',
});

// 台股盤中零股：交易日 09:00–13:30；預約單：14:50 至次一交易日 09:00。
const OPEN_MINUTES = 9 * 60;
const CLOSE_MINUTES = 13 * 60 + 30;
const PREORDER_MINUTES = 14 * 60 + 50;

function previousTradingDate(fromDate, holidays) {
  if (!fromDate) return '';
  const start = new Date(`${fromDate}T00:00:00Z`);
  for (let offset = 1; offset <= 14; offset += 1) {
    const day = new Date(start);
    day.setUTCDate(day.getUTCDate() - offset);
    const date = day.toISOString().slice(0, 10);
    const weekDay = day.getUTCDay();
    if (weekDay === 0 || weekDay === 6 || holidays.has(date) || date.endsWith('-01-01')) continue;
    return date;
  }
  return '';
}

function isTradingDate(date, holidays) {
  const [year, month, day] = date.split('-').map(Number);
  const weekDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekDay !== 0 && weekDay !== 6 && !holidays.has(date) && !date.endsWith('-01-01');
}

function nextTradingDate(fromDate, holidays) {
  const start = new Date(`${fromDate}T00:00:00Z`);
  for (let offset = 1; offset <= 31; offset += 1) {
    const day = new Date(start);
    day.setUTCDate(day.getUTCDate() + offset);
    const date = day.toISOString().slice(0, 10);
    if (isTradingDate(date, holidays)) return date;
  }
  return '';
}

/**
 * 台股市場狀態。holidays 是 YYYY-MM-DD 的休市日（不含週末）。
 * canOrder／orderDate：能不能下單，以及這筆單記在哪個交易日（預約單記在下一個交易日）。
 */
export function marketState(now = new Date(), holidays = new Set()) {
  const { date, minutes } = taipeiClock(now);
  const prevTradingDate = previousTradingDate(date, holidays);
  const prevPrevTradingDate = previousTradingDate(prevTradingDate, holidays);
  const base = { date, minutes, prevTradingDate, prevPrevTradingDate };
  const nextDate = nextTradingDate(date, holidays);
  const nextOpen = nextDate ? `${nextDate} 09:00` : '';
  // 報價至少要抓到「下兩個交易日」的位置；預約單的基準日是 orderDate，不是今天。
  const nextRefFloor = nextDate ? previousTradingDate(previousTradingDate(nextDate, holidays), holidays) : '';
  if (!isTradingDate(date, holidays)) {
    // 休市日的任何時間都還在上一交易日 14:50 開始的預約窗裡。
    return { ...base, phase: MARKET_PHASES.HOLIDAY, open: false, canOrder: Boolean(nextDate), orderDate: nextDate, orderRefFloor: nextRefFloor, nextOrderAt: '', label: '休市', nextOpen };
  }
  if (minutes < OPEN_MINUTES) {
    return { ...base, phase: MARKET_PHASES.PREOPEN, open: false, canOrder: true, orderDate: date, orderRefFloor: prevPrevTradingDate, nextOrderAt: '', label: '尚未開盤（09:00 開盤）', nextOpen: `${date} 09:00` };
  }
  if (minutes < CLOSE_MINUTES) {
    return { ...base, phase: MARKET_PHASES.OPEN, open: true, canOrder: true, orderDate: date, orderRefFloor: prevPrevTradingDate, nextOrderAt: '', label: '盤中（09:00–13:30）', nextOpen: '' };
  }
  if (minutes < PREORDER_MINUTES) {
    return { ...base, phase: MARKET_PHASES.AFTER, open: false, canOrder: false, orderDate: '', orderRefFloor: '', nextOrderAt: `${date} 14:50`, label: '已收盤（13:30）', nextOpen };
  }
  return { ...base, phase: MARKET_PHASES.AFTER, open: false, canOrder: Boolean(nextDate), orderDate: nextDate, orderRefFloor: nextRefFloor, nextOrderAt: '', label: '已收盤（13:30）', nextOpen };
}

function tradeError(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * 從這一輪的觸發者與 ★ 訊息決定玩家身分。
 *
 * 模型只會傳 #編號，不能傳 user id；編號必須是這一輪真的觸發 bot 的那一則，
 * 作者也要在 turnUsers 裡。多人合批時一定要指定訊息，避免替別人下單。
 */
export function pickPlayerIdentity({ users = [], directs = [], message = '', lookup = () => null, requireMessage = false } = {}) {
  const userIds = users.map((user) => String(user?.userId ?? user?.id ?? '')).filter(Boolean);
  if (userIds.length === 0) throw tradeError('這一輪沒有明確的觸發者，不能查帳戶或下單', 'NO_TRIGGER');
  const ref = String(message ?? '').trim();
  let messageId = '';
  let userId = '';
  if (ref) {
    const id = lookup(ref);
    const hit = directs.find((entry) => entry.id === id);
    if (!hit) throw tradeError(`${ref} 不是這一輪觸發你的訊息；message 要填 ★ 那則的 #編號`, 'BAD_MESSAGE');
    messageId = id;
    userId = String(hit.userId ?? '');
  } else {
    if (requireMessage) throw tradeError('下單要指定觸發這一輪的訊息 #編號（★ 那則）', 'BAD_MESSAGE');
    const unique = [...new Set(directs.map((entry) => String(entry.userId ?? '')).filter(Boolean))];
    if (unique.length === 0) throw tradeError('這一輪沒有明確的 ★ 訊息；查帳戶要指定訊息 #編號', 'BAD_MESSAGE');
    if (unique.length !== 1) throw tradeError('這一輪有多個觸發者；message 要填其中一人的訊息 #編號', 'BAD_MESSAGE');
    userId = unique[0];
    messageId = directs.find((entry) => String(entry.userId) === userId)?.id ?? '';
  }
  if (!userIds.includes(userId)) throw tradeError('這則訊息不是這一輪的觸發者', 'BAD_MESSAGE');
  return { userId, messageId };
}

function newOrderId() {
  return `ORD-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

function positiveInt(value, label, max = 10_000_000) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > max) {
    throw tradeError(`${label}必須是 1~${max} 的整數`, 'BAD_QUANTITY');
  }
  return number;
}

/**
 * @param options.db      openTradeDb() 的回傳值
 * @param options.config  normalizeDiscordConfig().trade
 * @param options.quotes  createQuoteProvider() 的回傳值
 * @param options.now     測試用時鐘
 * @param options.holidays 測試用休市日 Set；省略時向 quotes 要
 */
export function createTradeService({
  db,
  config,
  quotes,
  now = () => new Date(),
  holidays = null,
  botId = '',
  log = () => {},
}) {
  const startingCashCents = Math.round(Number(config.startingCash) * 100);
  const feePpm = Math.round(Number(config.fees.twFeeRate) * 1_000_000);
  const taxPpm = Math.round(Number(config.fees.twTaxRate) * 1_000_000);
  const etfTaxPpm = Math.round(Number(config.fees.twEtfTaxRate) * 1_000_000);
  const minFeeCents = Math.round(Number(config.fees.minFee) * 100);
  const maxOrderPct = Number(config.maxOrderPct);
  const botAccount = botId ? botAccountId(botId) : '';
  const locks = new Map(); // accountId -> Promise：同一帳戶的請求依序處理

  function withAccount(accountId, action) {
    const previous = locks.get(accountId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    locks.set(accountId, next);
    const cleanup = () => { if (locks.get(accountId) === next) locks.delete(accountId); };
    next.then(cleanup, cleanup);
    return next;
  }

  const configuredHolidays = new Set(config.extraHolidays ?? []);

  async function holidaySet() {
    const base = holidays
      ? (holidays instanceof Set ? holidays : new Set(holidays))
      : await quotes.getHolidays().catch(() => new Set());
    return new Set([...base, ...configuredHolidays]);
  }

  async function state() {
    return marketState(now(), await holidaySet());
  }

  function assertChannel({ guildId, channelId }) {
    if (config.allowedGuilds.length && !config.allowedGuilds.includes(String(guildId ?? ''))) {
      throw tradeError('這個伺服器沒有開放模擬股票', 'CHANNEL_NOT_ALLOWED');
    }
    if (config.allowedChannels.length && !config.allowedChannels.includes(String(channelId ?? ''))) {
      throw tradeError('這個頻道沒有開放模擬股票', 'CHANNEL_NOT_ALLOWED');
    }
  }

  function ensurePlayer(userId) {
    return db.ensureAccount(playerAccountId(userId), {
      kind: ACCOUNT_KIND.PLAYER,
      startingCashCents,
      now: new Date(now()).toISOString(),
    });
  }

  function ensureBot() {
    if (!botAccount) throw tradeError('Bot 帳戶還沒建立', 'NO_BOT');
    return db.ensureAccount(botAccount, {
      kind: ACCOUNT_KIND.BOT,
      startingCashCents,
      now: new Date(now()).toISOString(),
    });
  }

  if (config.enabled && config.bot.enabled && botAccount) {
    ensureBot();
    log(`模擬股票：Bot 帳戶 ${botAccount} 已就緒`);
  }

  /** 持倉現值：報價抓不到時用成本基礎代替，寧可低估淨值，也不編一個價格。 */
  async function snapshot(account) {
    const positions = await Promise.all(db.listPositions(account.id).map(async (position) => {
      const entry = findSymbol(position.symbol);
      const quote = entry ? await quotes.getLatest(entry) : null;
      const priceCents = quote?.closeCents ?? null;
      const marketValueCents = priceCents === null ? position.cost_basis_cents : priceCents * position.qty;
      return {
        ...position,
        name: entry?.name ?? position.symbol,
        exchange: entry?.exchange ?? '',
        priceCents,
        asOf: quote?.asOf ?? null,
        marketValueCents,
        unrealizedCents: marketValueCents - position.cost_basis_cents,
        avgCostCents: position.qty > 0 ? Math.round(position.cost_basis_cents / position.qty) : 0,
      };
    }));
    const marketValueCents = positions.reduce((sum, item) => sum + item.marketValueCents, 0);
    const costBasisCents = positions.reduce((sum, item) => sum + item.cost_basis_cents, 0);
    const navCents = account.cash_cents + marketValueCents;
    return {
      account,
      positions,
      cashCents: account.cash_cents,
      reservedCents: account.reserved_cents,
      availableCashCents: account.cash_cents - account.reserved_cents,
      marketValueCents,
      costBasisCents,
      navCents,
      unrealizedCents: marketValueCents - costBasisCents,
      // 沒有入金／出金時，已實現損益 = 現金 + 未賣出成本 − 起始資金。
      realizedCents: account.cash_cents + costBasisCents - account.starting_cash_cents,
      returnPct: account.starting_cash_cents > 0
        ? ((navCents - account.starting_cash_cents) / account.starting_cash_cents) * 100
        : 0,
    };
  }

  /** 主檔沒收錄時，用官方行情確認這支股票是不是真的存在（漏收，而不是代號打錯）。 */
  async function lookupListed(query) {
    if (typeof quotes.lookup !== 'function') return null;
    try {
      return await quotes.lookup(query);
    } catch {
      return null;
    }
  }

  /**
   * 官方行情有、商品主檔沒有時的說明。行情清單也含 ETF、特別股、TDR，
   * 這裡分不出是漏收還是不開放，所以只斷言「不是代號打錯」。
   */
  function unlistedNote(listed) {
    const market = listed.exchange === 'TWSE' ? '上市' : '上櫃';
    return `${listed.name}（${listed.symbol}，${market}）在官方行情查得到，但不在可交易商品主檔：`
      + '可能漏收，也可能是目前不開放的商品（白名單外的 ETF、特別股等），不是代號打錯；現在不能交易，照實講。';
  }

  async function quote(query) {
    const resolved = resolveSymbol(query);
    const [market, latest] = await Promise.all([
      state(),
      resolved.match ? quotes.getLatest(resolved.match) : Promise.resolve(null),
    ]);
    if (!resolved.match) {
      const listed = resolved.candidates.length ? null : await lookupListed(query);
      return {
        candidates: resolved.candidates.map((item) => ({ symbol: item.symbol, name: item.name, exchange: item.exchange })),
        unlisted: listed ? { ...listed, note: unlistedNote(listed) } : null,
        market,
      };
    }
    const entry = resolved.match;
    return {
      entry,
      quote: latest,
      market,
      tradable: entry.tradable === true,
    };
  }

  /**
   * 排隊下單。回傳的是 pending，不是成交。
   * requestId：玩家 msg:<messageId>，Bot run:<runId>。
   */
  async function placeOrder({
    actorKind = ACCOUNT_KIND.PLAYER,
    actorId,
    side,
    symbol,
    quantity,
    requestId,
    messageId = null,
    guildId = null,
    channelId = null,
    reason = null,
    note = null,
  }) {
    if (!config.enabled) throw tradeError('模擬股票沒有開啟（config.json 的 discord.trade.enabled）', 'TRADE_DISABLED');
    assertChannel({ guildId, channelId });
    const orderSide = String(side ?? '').toLowerCase();
    if (orderSide !== 'buy' && orderSide !== 'sell') throw tradeError('side 只能是 buy 或 sell', 'BAD_SIDE');
    const qty = positiveInt(quantity, '股數');
    const resolved = resolveSymbol(symbol, { strict: true });
    const entry = resolved.match;
    if (!entry || entry.tradable !== true) {
      if (resolved.candidates.length > 1) {
        throw tradeError(`「${symbol}」對到多個標的，先用 get_quote 查清楚代號`, 'BAD_SYMBOL');
      }
      const listed = entry ? null : await lookupListed(symbol);
      if (listed) throw tradeError(unlistedNote(listed), 'SYMBOL_NOT_COLLECTED');
      throw tradeError(`「${symbol}」不在可交易清單：先用 get_quote 查代號`, 'BAD_SYMBOL');
    }
    const isBot = actorKind === ACCOUNT_KIND.BOT;
    const accountId = isBot ? botAccount : playerAccountId(actorId);
    if (isBot && !accountId) throw tradeError('Bot 帳戶還沒建立', 'NO_BOT');
    const request = String(requestId ?? '').trim();
    if (!request) throw tradeError('缺少 request_id（橋接沒有帶到觸發訊息）', 'BAD_REQUEST');
    // 先回重送的單：市場狀態幾分鐘就換一段，不能因為時間窗變了就把已存在的單說成不能下單。
    const existing = db.findOrderByRequest(request)
      ?? (messageId ? db.findOrderByMessage(accountId, String(messageId)) : null);
    if (existing) {
      if (existing.account_id !== accountId) throw tradeError('這筆請求不屬於你的帳戶', 'BAD_REQUEST');
      return { duplicate: true, order: existing };
    }
    const market = await state();
    if (!market.canOrder) {
      throw tradeError(`現在${market.label}，不能下單；下一段下單時間 ${market.nextOrderAt || '未定'}`, 'MARKET_CLOSED');
    }
    const tradeDate = market.orderDate;
    const latest = await quotes.getLatest(entry);
    if (!latest || latest.closeCents <= 0) throw tradeError('查不到最近收盤價，暫時不能下單', 'NO_QUOTE');
    // 資料至少要是「預約日的前兩個交易日」之一：TWSE／TPEx 更新時間不同，留一個交易日的緩衝。
    // 超過就代表來源停擺或連假後還沒更新，不要用太舊的價格估保留額。
    if (!market.orderRefFloor || latest.date < market.orderRefFloor) {
      throw tradeError(`最近收盤資料太舊（${latest.asOf}），暫時不能下單`, 'STALE_QUOTE');
    }
    const reference = referenceForTradeDate(latest, tradeDate);
    const limit = limitPrices(reference, entry);
    const orderTaxPpm = entry.type === 'etf' ? etfTaxPpm : taxPpm;
    const existingAccount = db.getAccount(accountId);
    // 帳戶要到真的排隊成功才建立；先用起始資金做 30% 與現金檢查的假帳戶。
    const accountForCheck = existingAccount ?? {
      id: accountId,
      kind: isBot ? ACCOUNT_KIND.BOT : ACCOUNT_KIND.PLAYER,
      cash_cents: startingCashCents,
      reserved_cents: 0,
      starting_cash_cents: startingCashCents,
    };
    const nowIso = new Date(now()).toISOString();

    // 保留額：買單用漲停價估算，成交價不可能高於它；多保留的差額結算時釋放。
    const reservedCents = orderSide === 'buy'
      ? limit.up * qty + feeCents(limit.up * qty, feePpm, minFeeCents)
      : 0;
    const reservedQty = orderSide === 'sell' ? qty : 0;

    if (orderSide === 'buy') {
      const current = await snapshot(accountForCheck);
      const estimatedGross = latest.closeCents * qty;
      const estimatedCost = estimatedGross + feeCents(estimatedGross, feePpm, minFeeCents);
      if (estimatedCost > Math.floor((current.navCents * maxOrderPct) / 100)) {
        throw tradeError(`單筆買入不得超過帳戶淨值的 ${maxOrderPct}%（目前淨值 ${formatTwd(current.navCents)}）`, 'ORDER_TOO_LARGE');
      }
    }

    return withAccount(accountId, () => {
      const again = db.findOrderByRequest(request)
        ?? (messageId ? db.findOrderByMessage(accountId, String(messageId)) : null);
      if (again) return { duplicate: true, order: again };
      if (db.hasOppositePending(accountId, entry.symbol, tradeDate, orderSide)) {
        throw tradeError('同一個標的同一個交易日已經有反向的排隊單；MVP 不模擬當沖', 'OPPOSITE_PENDING');
      }
      // 帳戶到這裡才建立；同一筆 transaction 裡的檢查失敗會一起 rollback，不會留下空帳戶。
      let order;
      try {
        order = db.transaction(() => {
          db.ensureAccount(accountId, {
            kind: isBot ? ACCOUNT_KIND.BOT : ACCOUNT_KIND.PLAYER,
            startingCashCents,
            now: nowIso,
          });
          const account = db.getAccount(accountId);
          if (orderSide === 'buy') {
            if (reservedCents > account.cash_cents - account.reserved_cents) {
              throw tradeError(`可用現金不足：需要保留 ${formatTwd(reservedCents)}（買單先按漲停價保留，結算退回差額），可用 ${formatTwd(account.cash_cents - account.reserved_cents)}`, 'INSUFFICIENT_CASH');
            }
          } else {
            const position = db.getPosition(accountId, entry.symbol);
            if (!position || position.qty - position.reserved_qty < qty) {
              throw tradeError('可用持股不足：賣單不能超過還沒被其他單保留的股數', 'INSUFFICIENT_POSITION');
            }
          }
          const inserted = db.insertOrder({
            id: newOrderId(),
            requestId: request,
            accountId,
            actor: isBot ? ACCOUNT_KIND.BOT : ACCOUNT_KIND.PLAYER,
            market: 'TW',
            symbol: entry.symbol,
            side: orderSide,
            qty,
            currency: 'TWD',
            tradeDate,
            guildId,
            channelId,
            sourceMessageId: messageId ? String(messageId) : null,
            reservedCents,
            reservedQty,
            feeRatePpm: feePpm,
            taxRatePpm: orderTaxPpm,
            minFeeCents,
            createdAt: nowIso,
            reason: reason ? String(reason).slice(0, 300) : null,
            note: note ? String(note).slice(0, 200) : null,
          });
          if (orderSide === 'buy') db.reserveBuy(accountId, reservedCents);
          else db.reserveSell(accountId, entry.symbol, qty);
          return inserted;
        });
      } catch (error) {
        // 跨 process 同時送出時，UNIQUE 會擋下第二筆；把原本那筆回給模型，不要讓它重試。
        if (/UNIQUE|constraint/i.test(String(error?.message ?? ''))) {
          const previous = db.findOrderByRequest(request);
          if (previous) return { duplicate: true, order: previous };
        }
        throw error;
      }
      db.touchGuild(accountId, guildId, nowIso);
      return { duplicate: false, order };
    });
  }

  async function portfolio(accountId) {
    const account = db.getAccount(accountId);
    if (!account) return { exists: false, market: await state() };
    const current = await snapshot(account);
    return {
      exists: true,
      ...current,
      orders: db.recentOrders(accountId, 5),
      market: await state(),
    };
  }

  /** 排行榜：先算淨值與報酬率，名稱由橋接用伺服器暱稱補上。 */
  async function leaderboard({ guildId, limit = 10, includeBot = true } = {}) {
    const ids = new Set(db.listGuildAccounts(String(guildId ?? '')));
    if (includeBot && botAccount) ids.add(botAccount);
    for (const id of [...ids]) {
      const account = db.getAccount(id);
      if (account?.kind === ACCOUNT_KIND.BOT && !includeBot) ids.delete(id);
    }
    const rows = [];
    for (const id of ids) {
      const account = db.getAccount(id);
      if (!account) continue;
      const current = await snapshot(account);
      rows.push({
        accountId: id,
        kind: account.kind,
        navCents: current.navCents,
        returnPct: current.returnPct,
        createdAt: account.created_at,
      });
    }
    rows.sort((a, b) => b.returnPct - a.returnPct || b.navCents - a.navCents || String(a.createdAt).localeCompare(String(b.createdAt)));
    return { rows: rows.slice(0, limit), market: await state() };
  }

  /**
   * 結算到期的 pending 單。回傳事件給橋接發通知；不自己在這裡碰 Discord。
   * 只認 trade_date 當天的收盤資料；資料還沒出來就留著，下一輪再試。
   */
  async function settleDue() {
    const pending = db.listPendingOrders();
    if (pending.length === 0) return [];
    const closed = await holidaySet();
    const market = marketState(now(), closed);
    // 19:00 前不結算：收盤價、法人與晚報都還沒齊，太早結算只會拿到半套資料。
    const settleAfter = parseHhmm(config.settlement.twSettleAfter);
    if (!Number.isFinite(settleAfter) || market.minutes < settleAfter) return [];
    const settledAt = new Date(now()).toISOString();
    const events = [];
    const reject = (order, reason) => {
      const rejected = db.rejectOrder(order, { reason, settledAt });
      if (rejected) events.push({ type: 'rejected', order: rejected, reason });
    };
    const jobs = new Map();
    for (const order of pending) {
      const entry = findSymbol(order.symbol);
      if (!entry) {
        reject(order, '標的已不在商品主檔');
        continue;
      }
      if (order.trade_date > market.date) continue; // 預約單要等它的交易日
      // 預約單排好之後才宣布的休市（颱風、行事曆補上）：那天不會有收盤資料，直接失效。
      if (!isTradingDate(order.trade_date, closed)) {
        reject(order, `${order.trade_date} 休市，訂單失效`);
        continue;
      }
      jobs.set(`${order.symbol}|${order.trade_date}`, { entry, date: order.trade_date });
    }
    const quoteByKey = new Map();
    await Promise.all([...jobs].map(async ([key, job]) => {
      quoteByKey.set(key, await quotes.getForDate(job.entry, job.date));
    }));

    for (const order of pending) {
      if (order.trade_date > market.date) continue;
      if (!isTradingDate(order.trade_date, closed)) continue;
      // 當天還沒收盤就不結算，就算報價來源先偷跑也不行。
      if (order.trade_date === market.date && (market.phase === MARKET_PHASES.OPEN || market.phase === MARKET_PHASES.PREOPEN)) continue;
      const entry = findSymbol(order.symbol);
      const key = `${order.symbol}|${order.trade_date}`;
      const quoteRow = quoteByKey.get(key) ?? (entry ? await quotes.getForDate(entry, order.trade_date) : null);
      if (!quoteRow) {
        // 整份資料的日期已經超過這張單的 trade_date，代表這檔股票當天沒有收盤資料
        // （停牌、無成交、或來源缺漏），再等也不會來。
        const sourceDate = entry && typeof quotes.dataDate === 'function'
          ? await quotes.dataDate(entry.exchange)
          : (entry ? (await quotes.getLatest(entry))?.date : null);
        if (sourceDate && sourceDate > order.trade_date) reject(order, '逾期未結算：找不到當日收盤資料');
        continue;
      }
      if (quoteRow.closeCents <= 0) continue;
      const reference = quoteRow.referenceCents > 0 ? quoteRow.referenceCents : quoteRow.closeCents;
      const limit = limitPrices(reference, entry);
      if (order.side === 'buy' && quoteRow.closeCents >= limit.up) {
        reject(order, '收盤漲停，買單不成交');
        continue;
      }
      if (order.side === 'sell' && quoteRow.closeCents <= limit.down) {
        reject(order, '收盤跌停，賣單不成交');
        continue;
      }
      const grossCents = quoteRow.closeCents * order.qty;
      const fee = feeCents(grossCents, order.fee_rate_ppm, order.min_fee_cents);
      const tax = order.side === 'sell' ? taxCents(grossCents, order.tax_rate_ppm) : 0;
      try {
        const filled = order.side === 'buy'
          ? db.fillBuy(order, { priceCents: quoteRow.closeCents, grossCents, feeCents: fee, quote: quoteRow, settledAt })
          : db.fillSell(order, { priceCents: quoteRow.closeCents, grossCents, feeCents: fee, taxCents: tax, quote: quoteRow, settledAt });
        events.push({ type: 'filled', order: filled });
      } catch (error) {
        if (error?.code === 'INSUFFICIENT_CASH' || error?.code === 'INSUFFICIENT_POSITION') {
          reject(order, `結算失敗：${error.message}`);
          continue;
        }
        log(`結算失敗 ${order.id}：${error?.message ?? error}`);
      }
    }
    return events;
  }

  function forgetAccount(userId) {
    return db.deleteAccount(playerAccountId(userId));
  }

  async function overview() {
    const accounts = [];
    for (const account of db.listAccounts()) {
      const current = await snapshot(account);
      accounts.push({
        accountId: account.id,
        kind: account.kind,
        cashCents: current.cashCents,
        reservedCents: current.reservedCents,
        navCents: current.navCents,
        returnPct: current.returnPct,
        positions: current.positions,
      });
    }
    return {
      enabled: config.enabled,
      market: await state(),
      accounts,
      orders: db.listOrders(100),
      quotes: quotes.status(),
      botRuns: db.recentBotRuns(10),
      botEnabled: config.bot.enabled,
      botAccount,
      config: {
        startingCash: config.startingCash,
        maxOrderPct: config.maxOrderPct,
        fees: config.fees,
        allowedGuilds: config.allowedGuilds,
        allowedChannels: config.allowedChannels,
      },
    };
  }

  return {
    config,
    botAccountId: botAccount,
    quote,
    placeOrder,
    portfolio,
    leaderboard,
    settleDue,
    forgetAccount,
    overview,
    state,
    snapshot,
    ensurePlayer,
    ensureBot,
    tickCents,
    limitPrices,
  };
}
