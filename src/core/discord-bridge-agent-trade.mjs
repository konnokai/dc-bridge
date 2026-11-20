// 模擬股票 MCP 工具：quote／symbols／order／portfolio／leaderboard 與 bot 下單。
// 拆自 discord-bridge-agent-tools.mjs；由 createAgentTools 組裝，入口不直接接線。
// 這一層不碰 config：服務本身由 discord-bridge-trade.mjs 建立，這裡只格式化與轉接。
import { formatPct, formatTwd, pickPlayerIdentity, playerAccountId } from './discord-trade.mjs';
import { findSymbol } from './trade-symbols.mjs';

function formatMarket(market) {
  if (!market) return '市場狀態不明';
  if (market.open) return `${market.label}；這不是即時報價，今天下單用今日收盤價結算`;
  if (market.canOrder) return `${market.label}；預約時段，現在下單排到 ${market.orderDate} 收盤結算`;
  const next = market.nextOpen ? `；下一次開盤 ${market.nextOpen}` : '';
  return `${market.label}${next}；現在不能排隊下單，下一段下單時間 ${market.nextOrderAt || '未定'}`;
}

export function formatQuoteResult(result) {
  if (!result.entry) {
    if (result.unlisted) return result.unlisted.note;
    if (!result.candidates?.length) {
      return result.sourceDown
        ? '官方行情目前抓不到，無法確認這個代號；稍後再查，不要自己猜。'
        : '查不到這個股票或最近沒有行情。台股一般上市／上櫃普通股與主檔內的 ETF 才能交易。';
    }
    return `找到多個可能：${result.candidates.map((item) => `${item.symbol} ${item.name}（${item.exchange}）`).join('、')}。請問是哪一個，不要自己猜。`;
  }
  const entry = result.entry;
  const kind = entry.type === 'etf' ? `｜ETF（漲跌幅 ±${entry.limitPct ?? 10}%）` : '';
  const lines = [`${entry.name}（${entry.symbol}）｜${entry.exchange === 'TWSE' ? '上市' : '上櫃'}${kind}`];
  if (!result.quote) {
    lines.push('最近收盤價：查不到（報價來源可能中斷）');
  } else {
    const quote = result.quote;
    const change = quote.changeCents ?? 0;
    const changePct = quote.referenceCents > 0 ? (change / quote.referenceCents) * 100 : 0;
    lines.push(`最近收盤價：${formatTwd(quote.closeCents)}（${quote.asOf}）`);
    lines.push(`漲跌：${change >= 0 ? '+' : ''}${formatTwd(change)}（${formatPct(changePct)}）`);
  }
  lines.push(`市場：${formatMarket(result.market)}`);
  lines.push(`可下單：${result.tradable && result.market?.canOrder ? '是' : '否'}`);
  return lines.join('\n');
}

/**
 * 可交易商品清單。沒帶 query 只列 ETF 與範圍說明，避免把兩千檔普通股倒給模型；
 * 帶 query 時列主檔別名與官方行情的一般普通股，另有 unlisted 說明不能交易的原因。
 */
export function formatSymbolList(result) {
  if (!result.query) {
    return [
      '可交易範圍：台股一般上市／上櫃普通股（官方行情查得到就能下單）＋ 以下 ETF。',
      `ETF（${result.etfs.length} 檔）：`,
      ...result.etfs.map((item) => `${item.symbol} ${item.name}（${item.exchange === 'TWSE' ? '上市' : '上櫃'}・ETF）`),
      '要查某支代號或名稱，帶 query 再查。',
    ].join('\n');
  }
  const suffix = result.truncated ? '（只列前 50 筆）' : '';
  const header = `可交易商品符合「${result.query}」：${result.items.length} 檔${suffix}`;
  if (!result.items.length && !result.unlistedTotal) {
    return `${header}\n${result.sourceDown
      ? '官方行情目前抓不到，清單可能不完整；稍後再查。'
      : '查不到這個股票或最近沒有行情：確認代號或名稱，或換一個關鍵字。'}`;
  }
  const lines = [header];
  for (const item of result.items) {
    const market = item.exchange === 'TWSE' ? '上市' : '上櫃';
    const kind = item.type === 'etf' ? '・ETF' : '';
    lines.push(`${item.symbol} ${item.name}（${market}${kind}）`);
  }
  if (result.unlistedTotal) {
    const names = result.unlisted.map((listed) => `${listed.symbol} ${listed.name}`).join('、');
    const more = result.unlistedTotal > result.unlisted.length ? ' 等' : '';
    lines.push(`另有 ${result.unlistedTotal} 檔不開放（ETF 只收主檔；TDR、特別股、ETN 不開放）：${names}${more}`);
  }
  if (result.truncated) lines.push('符合的標的太多，請縮小關鍵字。');
  if (result.sourceDown) lines.push('注意：官方行情目前抓不到，清單可能不完整。');
  return lines.join('\n');
}

function formatOrderLine(order) {
  const side = order.side === 'buy' ? '買' : '賣';
  const state = order.status === 'pending' ? '排隊中' : (order.status === 'filled' ? '已成交' : '未成交');
  const price = order.fill_price_cents ? `＠${formatTwd(order.fill_price_cents)}` : '';
  return `${side} ${order.symbol} ${order.qty ?? ''} 股 ${state}${price}（${String(order.created_at).slice(0, 16).replace('T', ' ')}）`;
}

export function formatPortfolioResult(portfolio) {
  if (!portfolio.exists) {
    return '你還沒有模擬帳戶。第一次成功排隊下單時會自動建立（起始資金依設定）。';
  }
  const lines = [
    `現金 ${formatTwd(portfolio.cashCents)}（保留 ${formatTwd(portfolio.reservedCents)}，可用 ${formatTwd(portfolio.availableCashCents)}）`,
    `淨值 ${formatTwd(portfolio.navCents)}｜報酬率 ${formatPct(portfolio.returnPct)}｜已實現 ${formatTwd(portfolio.realizedCents)}｜未實現 ${formatTwd(portfolio.unrealizedCents)}`,
  ];
  if (portfolio.positions.length) {
    lines.push('持股：');
    for (const position of portfolio.positions) {
      lines.push(`- ${position.symbol} ${position.name} ${position.qty} 股｜平均成本 ${formatTwd(position.avgCostCents)}｜現價 ${position.priceCents === null ? '查不到' : formatTwd(position.priceCents)}｜未實現 ${formatTwd(position.unrealizedCents)}`);
    }
  } else {
    lines.push('目前沒有持股。');
  }
  if (portfolio.orders.length) {
    lines.push('最近訂單：');
    for (const order of portfolio.orders) lines.push(`- ${formatOrderLine(order)}`);
  }
  return lines.join('\n');
}

export function createAgentTradeTools({
  agentSender,
  client,
  messageRefs,
  turnUsers,
  turnDirectMessages,
  getTradeService,
  getBotActiveRun,
}) {
  const toolError = (message, statusCode) => Object.assign(new Error(message), { statusCode });

  function requireTrade() {
    const tradeService = getTradeService();
    if (!tradeService) throw toolError('模擬股票沒有開啟或還沒就緒（config.json 的 discord.trade.enabled）', 403);
    return tradeService;
  }

  function tradeFailure(error) {
    if (typeof error?.statusCode === 'number') return error;
    return toolError(String(error?.message ?? error), 400);
  }


  /**
   * 玩家身分：由會話令牌與這一輪的觸發訊息決定，模型填的 user id 一律不採信。
   * place_order 必須指定訊息；查帳戶可以省略（這一輪只有一個觸發者時）。
   */
  async function tradePlayerIdentity(body, { requireMessage = false } = {}) {
    const { key, kind, channel } = await agentSender.resolve(body.token);
    if (kind !== 'ch' && kind !== 'dm') throw toolError('模擬股票只能在一般頻道或私聊使用', 403);
    const users = turnUsers.get(key) ?? [];
    const directs = turnDirectMessages.get(key) ?? [];
    let identity;
    try {
      identity = pickPlayerIdentity({
        users,
        directs,
        message: body.message,
        lookup: (ref) => messageRefs.lookup(key, ref),
        requireMessage,
      });
    } catch (error) {
      throw tradeFailure(error);
    }
    const channelId = kind === 'ch' ? String(channel?.id ?? key.slice(3)) : null;
    const guildId = kind === 'ch' ? (channel?.guildId ?? null) : null;
    return { key, kind, ...identity, guildId, channelId };
  }

  async function tradeBotIdentity(body) {
    const { sessionId } = await agentSender.resolve(body.token, { allowBot: true });
    const botActiveRun = getBotActiveRun();
    if (!botActiveRun || sessionId !== botActiveRun.sessionId) {
      throw toolError('這不是目前的 Bot 交易回合；bot_place_order 只能在排程回合使用', 403);
    }
    if (botActiveRun.ordered) throw toolError('這一輪已經下過單，一輪最多一筆', 429);
    return botActiveRun;
  }

  return {
    handlers: {
    async 'trade-quote'(body) {
      const service = requireTrade();
      try {
        return { text: formatQuoteResult(await service.quote(String(body.query ?? ''))) };
      } catch (error) {
        throw tradeFailure(error);
      }
    },
    async 'trade-symbols'(body) {
      const service = requireTrade();
      try {
        return { text: formatSymbolList(await service.symbols(String(body.query ?? ''))) };
      } catch (error) {
        throw tradeFailure(error);
      }
    },
    async 'trade-order'(body) {
      const service = requireTrade();
      const identity = await tradePlayerIdentity(body, { requireMessage: true });
      try {
        const result = await service.placeOrder({
          actorKind: 'player',
          actorId: identity.userId,
          side: body.side,
          symbol: String(body.symbol ?? '').trim(),
          quantity: body.quantity,
          requestId: `msg:${identity.messageId}`,
          messageId: identity.messageId,
          guildId: identity.guildId,
          channelId: identity.channelId,
        });
        if (result.duplicate) {
          return { text: `這則訊息已經下過單（${result.order.id}，${result.order.status}），不重複下單。` };
        }
        const order = result.order;
        const entry = findSymbol(order.symbol);
        const portfolio = await service.portfolio(playerAccountId(identity.userId));
        const lines = [
          `已排隊（pending）：${order.side === 'buy' ? '買入' : '賣出'} ${entry?.name ?? order.symbol}（${order.symbol}）${order.qty} 股，訂單 ${order.id}。`,
          order.side === 'buy' ? `保留現金 ${formatTwd(order.reserved_cents)}。` : `保留 ${order.reserved_qty} 股。`,
          `${order.trade_date} 收盤後才結算；成交價與費用會再通知，現在不是已成交。`,
        ];
        if (portfolio.exists) lines.push(`目前可用現金 ${formatTwd(portfolio.availableCashCents)}。`);
        return { text: lines.join('\n') };
      } catch (error) {
        throw tradeFailure(error);
      }
    },
    async 'trade-portfolio'(body) {
      const service = requireTrade();
      const identity = await tradePlayerIdentity(body);
      return { text: formatPortfolioResult(await service.portfolio(playerAccountId(identity.userId))) };
    },
    async 'trade-leaderboard'(body) {
      const service = requireTrade();
      const { kind, channel } = await agentSender.resolve(body.token);
      if (kind !== 'ch' || !channel?.guildId) throw toolError('排行榜只能在伺服器頻道查', 400);
      const { rows, market } = await service.leaderboard({ guildId: channel.guildId });
      if (!rows.length) return { text: '這個伺服器還沒有模擬交易紀錄。' };
      const lines = [`模擬投資排行榜（依總報酬率；${market?.label ?? '市場狀態不明'}）`];
      let index = 0;
      for (const row of rows) {
        index += 1;
        let name;
        if (row.kind === 'bot') {
          name = `🤖 ${client.user.displayName || client.user.username}`;
        } else {
          const userId = row.accountId.slice('user:'.length);
          const member = channel.guild?.members.cache.get(userId)
            ?? await channel.guild?.members.fetch(userId).catch(() => null);
          name = member?.displayName ?? userId;
        }
        lines.push(`${index}. ${name}｜${formatTwd(row.navCents)}｜${formatPct(row.returnPct)}`);
      }
      return { text: lines.join('\n') };
    },
    async 'trade-bot-portfolio'(body) {
      const service = requireTrade();
      await agentSender.resolve(body.token, { allowBot: true });
      if (!service.botAccountId) return { text: 'Bot 交易員還沒建立帳戶（config.json 的 discord.trade.bot.enabled）。' };
      return { text: formatPortfolioResult(await service.portfolio(service.botAccountId)) };
    },
    async 'trade-bot-order'(body) {
      const service = requireTrade();
      const run = await tradeBotIdentity(body);
      try {
        const result = await service.placeOrder({
          actorKind: 'bot',
          actorId: client.user.id,
          side: body.side,
          symbol: String(body.symbol ?? '').trim(),
          quantity: body.quantity,
          requestId: `run:${run.runId}`,
          reason: body.reason,
          note: body.note,
        });
        if (result.duplicate) {
          run.ordered = true;
          return { text: `這一輪已經下過單（${result.order.id}），不重複下單。` };
        }
        run.ordered = true;
        return { text: `已排隊：${result.order.side === 'buy' ? '買入' : '賣出'} ${result.order.symbol} ${result.order.qty} 股，訂單 ${result.order.id}。收盤後結算。` };
      } catch (error) {
        throw tradeFailure(error);
      }
    }
    },
  };
}
