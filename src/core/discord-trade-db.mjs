// 模擬股票的交易域 SQLite。
//
// 為什麼交易要獨立一個 DB：一筆成交會同時動現金、保留現金、持倉、訂單與現金流水，
// 這些必須在同一個 transaction 裡全成或全敗。其他橋接狀態（會話、記憶、筆記）照舊用 JSON。
//
// Node 26 內建 node:sqlite，不需要原生模組。API 是同步的，所以同一個 process 內
// 一個 transaction 不會被其他請求插隊；跨 process 由 BEGIN IMMEDIATE 與 busy_timeout 擋。

import fs from 'node:fs';
import path from 'node:path';
import * as sqlite from 'node:sqlite';

// Node 26.12 只有 DatabaseSync；26.13 起多了 Database（DatabaseSync 變成 deprecated 別名）。
// 伺服器版本不一定跟本機一樣，兩個都認。
const Database = sqlite.Database ?? sqlite.DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  cash_cents INTEGER NOT NULL,
  reserved_cents INTEGER NOT NULL DEFAULT 0,
  starting_cash_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  qty INTEGER NOT NULL,
  reserved_qty INTEGER NOT NULL DEFAULT 0,
  cost_basis_cents INTEGER NOT NULL,
  PRIMARY KEY (account_id, symbol)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  market TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty INTEGER,
  amount_cents INTEGER,
  currency TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  guild_id TEXT,
  channel_id TEXT,
  source_message_id TEXT,
  reserved_cents INTEGER NOT NULL DEFAULT 0,
  reserved_qty INTEGER NOT NULL DEFAULT 0,
  fee_rate_ppm INTEGER NOT NULL DEFAULT 0,
  tax_rate_ppm INTEGER NOT NULL DEFAULT 0,
  min_fee_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  fill_price_cents INTEGER,
  gross_cents INTEGER,
  fee_cents INTEGER,
  tax_cents INTEGER,
  fx_rate_micro INTEGER,
  fx_spread_cents INTEGER,
  net_cents INTEGER,
  quote_source TEXT,
  quote_as_of TEXT,
  reason TEXT,
  reject_reason TEXT,
  note TEXT,
  UNIQUE(account_id, source_message_id)
);

CREATE TABLE IF NOT EXISTS cash_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  order_id TEXT,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  balance_after_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  market TEXT NOT NULL,
  nav_cents INTEGER NOT NULL,
  as_of TEXT NOT NULL,
  fx_rate_micro INTEGER,
  PRIMARY KEY (account_id, date, market)
);

CREATE TABLE IF NOT EXISTS account_guilds (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (account_id, guild_id)
);

CREATE TABLE IF NOT EXISTS bot_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'decision',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  market TEXT,
  status TEXT,
  tokens INTEGER DEFAULT 0,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS daily_reviews (
  date TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS orders_status_date ON orders(status, trade_date);
CREATE INDEX IF NOT EXISTS orders_account_created ON orders(account_id, created_at);
CREATE INDEX IF NOT EXISTS ledger_account ON cash_ledger(account_id, id);
`;

function plain(row) {
  return row ? { ...row } : null;
}

export function openTradeDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  if (file !== ':memory:') {
    try { fs.chmodSync(file, 0o600); } catch { /* Windows 沒有 POSIX 權限 */ }
  }
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const statements = new Map();
  const stmt = (sql) => {
    let prepared = statements.get(sql);
    if (!prepared) {
      prepared = db.prepare(sql);
      statements.set(sql, prepared);
    }
    return prepared;
  };

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 已經被 SQLite 收掉 */ }
      throw error;
    }
  }

  function ensureAccount(id, { kind, startingCashCents, now }) {
    const existing = plain(stmt('SELECT * FROM accounts WHERE id = ?').get(id));
    if (existing) return existing;
    stmt('INSERT INTO accounts (id, kind, cash_cents, reserved_cents, starting_cash_cents, created_at) VALUES (?, ?, ?, 0, ?, ?)')
      .run(id, kind, startingCashCents, startingCashCents, now);
    return plain(stmt('SELECT * FROM accounts WHERE id = ?').get(id));
  }

  const getAccount = (id) => plain(stmt('SELECT * FROM accounts WHERE id = ?').get(id));

  const listAccounts = () => stmt('SELECT * FROM accounts ORDER BY created_at').all().map(plain);

  const getPosition = (accountId, symbol) => plain(stmt('SELECT * FROM positions WHERE account_id = ? AND symbol = ?').get(accountId, symbol));

  const listPositions = (accountId) => stmt('SELECT * FROM positions WHERE account_id = ? AND qty > 0 ORDER BY symbol').all(accountId).map(plain);

  function insertOrder(order) {
    stmt(`INSERT INTO orders (
      id, request_id, account_id, actor, market, symbol, side, qty, amount_cents, currency,
      trade_date, guild_id, channel_id, source_message_id, reserved_cents, reserved_qty,
      fee_rate_ppm, tax_rate_ppm, min_fee_cents, status, created_at, reason, note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        order.id, order.requestId, order.accountId, order.actor, order.market, order.symbol,
        order.side, order.qty ?? null, order.amountCents ?? null, order.currency,
        order.tradeDate, order.guildId ?? null, order.channelId ?? null, order.sourceMessageId ?? null,
        order.reservedCents ?? 0, order.reservedQty ?? 0,
        order.feeRatePpm ?? 0, order.taxRatePpm ?? 0, order.minFeeCents ?? 0,
        'pending', order.createdAt, order.reason ?? null, order.note ?? null,
      );
    return getOrder(order.id);
  }

  const getOrder = (id) => plain(stmt('SELECT * FROM orders WHERE id = ?').get(id));
  const findOrderByRequest = (requestId) => plain(stmt('SELECT * FROM orders WHERE request_id = ?').get(requestId));
  const findOrderByMessage = (accountId, messageId) => plain(stmt('SELECT * FROM orders WHERE account_id = ? AND source_message_id = ?').get(accountId, messageId));

  const listPendingOrders = () => stmt("SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at, id").all().map(plain);

  function hasOppositePending(accountId, symbol, tradeDate, side) {
    const opposite = side === 'buy' ? 'sell' : 'buy';
    return Boolean(stmt("SELECT 1 FROM orders WHERE account_id = ? AND symbol = ? AND trade_date = ? AND side = ? AND status = 'pending' LIMIT 1")
      .get(accountId, symbol, tradeDate, opposite));
  }

  const recentOrders = (accountId, limit = 5) => stmt('SELECT * FROM orders WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(accountId, limit).map(plain);

  const listOrders = (limit = 200) => stmt('SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT ?').all(limit).map(plain);

  function reserveBuy(accountId, cents) {
    stmt('UPDATE accounts SET reserved_cents = reserved_cents + ? WHERE id = ?').run(cents, accountId);
  }

  function reserveSell(accountId, symbol, qty) {
    stmt('UPDATE positions SET reserved_qty = reserved_qty + ? WHERE account_id = ? AND symbol = ?').run(qty, accountId, symbol);
  }

  function addLedger(accountId, orderId, kind, amountCents, balanceAfterCents, createdAt) {
    stmt('INSERT INTO cash_ledger (account_id, order_id, kind, amount_cents, balance_after_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(accountId, orderId ?? null, kind, amountCents, balanceAfterCents, createdAt);
  }

  /** 買進成交：現金扣淨額、保留現金全部釋放、持倉成本加上含手續費的總成本。 */
  function fillBuy(order, { priceCents, grossCents, feeCents, quote, settledAt }) {
    return transaction(() => {
      const current = getOrder(order.id);
      if (current?.status !== 'pending') throw new Error('訂單已不是 pending，不能重複結算');
      const account = getAccount(order.account_id);
      const net = grossCents + feeCents;
      // 不能動到其他 pending 買單保留的錢：可用現金 = 現金 − 別筆保留。
      const otherReserved = account.reserved_cents - current.reserved_cents;
      if (account.cash_cents - otherReserved < net) {
        throw Object.assign(new Error('結算時現金不足'), { code: 'INSUFFICIENT_CASH' });
      }
      const cashAfter = account.cash_cents - net;
      stmt('UPDATE accounts SET cash_cents = ?, reserved_cents = reserved_cents - ? WHERE id = ?')
        .run(cashAfter, current.reserved_cents, order.account_id);
      const position = getPosition(order.account_id, order.symbol);
      if (position) {
        stmt('UPDATE positions SET qty = qty + ?, cost_basis_cents = cost_basis_cents + ? WHERE account_id = ? AND symbol = ?')
          .run(order.qty, net, order.account_id, order.symbol);
      } else {
        stmt('INSERT INTO positions (account_id, symbol, qty, reserved_qty, cost_basis_cents) VALUES (?, ?, ?, 0, ?)')
          .run(order.account_id, order.symbol, order.qty, net);
      }
      addLedger(order.account_id, order.id, 'buy', -grossCents, cashAfter + feeCents, settledAt);
      addLedger(order.account_id, order.id, 'fee', -feeCents, cashAfter, settledAt);
      stmt(`UPDATE orders SET status = 'filled', settled_at = ?, fill_price_cents = ?, gross_cents = ?,
        fee_cents = ?, tax_cents = 0, net_cents = ?, quote_source = ?, quote_as_of = ? WHERE id = ?`)
        .run(settledAt, priceCents, grossCents, feeCents, -net, quote.source, quote.asOf, order.id);
      return { ...getOrder(order.id), position };
    });
  }

  /** 賣出成交：扣股數、按比例扣成本、入帳淨收入。 */
  function fillSell(order, { priceCents, grossCents, feeCents, taxCents, quote, settledAt }) {
    return transaction(() => {
      const current = getOrder(order.id);
      if (current?.status !== 'pending') throw new Error('訂單已不是 pending，不能重複結算');
      const position = getPosition(order.account_id, order.symbol);
      if (!position || position.qty < current.qty) throw Object.assign(new Error('結算時持股不足'), { code: 'INSUFFICIENT_POSITION' });
      const proceeds = grossCents - feeCents - taxCents;
      const account = getAccount(order.account_id);
      const cashAfter = account.cash_cents + proceeds;
      const removedCost = position.qty === current.qty
        ? position.cost_basis_cents
        : Math.round((position.cost_basis_cents * current.qty) / position.qty);
      stmt('UPDATE accounts SET cash_cents = ? WHERE id = ?').run(cashAfter, order.account_id);
      if (position.qty === current.qty) {
        stmt('DELETE FROM positions WHERE account_id = ? AND symbol = ?').run(order.account_id, order.symbol);
      } else {
        stmt('UPDATE positions SET qty = qty - ?, reserved_qty = reserved_qty - ?, cost_basis_cents = cost_basis_cents - ? WHERE account_id = ? AND symbol = ?')
          .run(current.qty, current.reserved_qty, removedCost, order.account_id, order.symbol);
      }
      addLedger(order.account_id, order.id, 'sell', grossCents, cashAfter - proceeds + grossCents, settledAt);
      addLedger(order.account_id, order.id, 'fee', -feeCents, cashAfter - proceeds + grossCents - feeCents, settledAt);
      addLedger(order.account_id, order.id, 'tax', -taxCents, cashAfter, settledAt);
      stmt(`UPDATE orders SET status = 'filled', settled_at = ?, fill_price_cents = ?, gross_cents = ?,
        fee_cents = ?, tax_cents = ?, net_cents = ?, quote_source = ?, quote_as_of = ? WHERE id = ?`)
        .run(settledAt, priceCents, grossCents, feeCents, taxCents, proceeds, quote.source, quote.asOf, order.id);
      return { ...getOrder(order.id), removedCost };
    });
  }

  /** 拒絕／逾期：釋放保留的現金或股票，不改餘額、不寫流水。已不是 pending 就回 null。 */
  function rejectOrder(order, { reason, settledAt }) {
    return transaction(() => {
      const current = getOrder(order.id);
      if (current?.status !== 'pending') return null;
      if (current.side === 'buy') {
        stmt('UPDATE accounts SET reserved_cents = reserved_cents - ? WHERE id = ?').run(current.reserved_cents, order.account_id);
      } else {
        stmt('UPDATE positions SET reserved_qty = reserved_qty - ? WHERE account_id = ? AND symbol = ?')
          .run(current.reserved_qty, order.account_id, order.symbol);
      }
      stmt("UPDATE orders SET status = 'rejected', settled_at = ?, reject_reason = ? WHERE id = ?")
        .run(settledAt, String(reason ?? '').slice(0, 300), order.id);
      return getOrder(order.id);
    });
  }

  function touchGuild(accountId, guildId, now) {
    if (!guildId) return;
    stmt(`INSERT INTO account_guilds (account_id, guild_id, last_seen) VALUES (?, ?, ?)
      ON CONFLICT(account_id, guild_id) DO UPDATE SET last_seen = excluded.last_seen`)
      .run(accountId, guildId, now);
  }

  const listGuildAccounts = (guildId) => stmt('SELECT account_id FROM account_guilds WHERE guild_id = ?').all(guildId).map((row) => row.account_id);

  function insertBotRun(run) {
    stmt('INSERT INTO bot_runs (id, kind, started_at, market, status, tokens, reason) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(run.id, run.kind ?? 'decision', run.startedAt, run.market ?? null, run.status ?? 'running', run.tokens ?? 0, run.reason ?? null);
    return plain(stmt('SELECT * FROM bot_runs WHERE id = ?').get(run.id));
  }

  function updateBotRun(id, patch) {
    stmt(`UPDATE bot_runs SET ended_at = COALESCE(?, ended_at), status = COALESCE(?, status),
      tokens = COALESCE(?, tokens), reason = COALESCE(?, reason) WHERE id = ?`)
      .run(patch.endedAt ?? null, patch.status ?? null, patch.tokens ?? null, patch.reason ?? null, id);
    return plain(stmt('SELECT * FROM bot_runs WHERE id = ?').get(id));
  }

  const botRunsSince = (iso) => stmt('SELECT * FROM bot_runs WHERE started_at >= ? ORDER BY started_at DESC').all(iso).map(plain);
  const recentBotRuns = (limit = 10) => stmt('SELECT * FROM bot_runs ORDER BY started_at DESC LIMIT ?').all(limit).map(plain);

  function saveDailyReview({ date, createdAt, summary, tokens = 0 }) {
    stmt(`INSERT INTO daily_reviews (date, created_at, summary, tokens) VALUES (?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET created_at = excluded.created_at, summary = excluded.summary, tokens = excluded.tokens`)
      .run(date, createdAt, summary, tokens);
  }

  const latestReviewBefore = (date) => plain(stmt('SELECT * FROM daily_reviews WHERE date < ? ORDER BY date DESC LIMIT 1').get(date));
  const getDailyReview = (date) => plain(stmt('SELECT * FROM daily_reviews WHERE date = ?').get(date));

  const countBotOrdersSince = (iso) => stmt("SELECT COUNT(*) AS n FROM orders WHERE actor = 'bot' AND created_at >= ?").get(iso).n;

  function deleteAccount(accountId) {
    return transaction(() => {
      for (const table of ['cash_ledger', 'orders', 'positions', 'snapshots', 'account_guilds']) {
        stmt(`DELETE FROM ${table} WHERE account_id = ?`).run(accountId);
      }
      return stmt('DELETE FROM accounts WHERE id = ?').run(accountId).changes > 0;
    });
  }

  function backup(file) {
    if (file === ':memory:') return false;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const escaped = file.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
    return true;
  }

  function close() {
    try { db.close(); } catch { /* 已經關了 */ }
  }

  return {
    db,
    transaction,
    ensureAccount,
    getAccount,
    listAccounts,
    getPosition,
    listPositions,
    insertOrder,
    getOrder,
    findOrderByRequest,
    findOrderByMessage,
    listPendingOrders,
    hasOppositePending,
    recentOrders,
    listOrders,
    reserveBuy,
    reserveSell,
    addLedger,
    fillBuy,
    fillSell,
    rejectOrder,
    touchGuild,
    listGuildAccounts,
    insertBotRun,
    updateBotRun,
    botRunsSince,
    recentBotRuns,
    saveDailyReview,
    latestReviewBefore,
    getDailyReview,
    countBotOrdersSince,
    deleteAccount,
    backup,
    close,
  };
}
