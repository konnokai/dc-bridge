<script setup>
import { computed } from 'vue';
import { data, openDetail } from '../store.js';
import { tradeAccountName, tradeMoney, tradePct } from '../format.js';

const trade = computed(() => data.trade ?? {});
const enabled = computed(() => trade.value.enabled !== false);

const summary = computed(() => (enabled.value
  ? `（${trade.value.market?.label ?? ''}｜${trade.value.accounts?.length ?? 0} 個帳戶）`
  : `（${trade.value.reason ?? '未開啟'}）`));

const accounts = computed(() => trade.value.accounts ?? []);
const positions = computed(() => accounts.value.flatMap((account) => (account.positions ?? []).map((position) => ({ account, position }))));
const orders = computed(() => trade.value.orders ?? []);
const quotes = computed(() => trade.value.quotes ?? []);
const runs = computed(() => trade.value.botRuns ?? []);

function openOrderDetail(order) {
  const status = order.status === 'pending' ? '排隊中' : (order.status === 'filled' ? '已成交' : '未成交');
  const meta = [
    ['時間', String(order.created_at ?? '').replace('T', ' ').slice(0, 19)],
    ['帳戶', `${tradeAccountName(order.account_id, order.accountName)}（${order.account_id}）`],
    ['標的', String(order.symbol ?? '')],
    ['方向', order.side === 'buy' ? '買' : '賣'],
    ['股數', String(order.qty ?? '')],
    ['狀態', status],
    ['成交價', order.fill_price_cents ? tradeMoney(order.fill_price_cents) : '—'],
    ['手續費', order.fee_cents ? tradeMoney(order.fee_cents) : '—'],
    ['稅', order.tax_cents ? tradeMoney(order.tax_cents) : '—'],
  ];
  const reason = [order.reject_reason, order.reason].filter(Boolean).join('\n');
  openDetail({
    title: `訂單 ${order.symbol ?? ''} ${order.side === 'buy' ? '買' : '賣'} ${order.qty ?? ''} 股`,
    meta,
    body: reason || '（沒有備註）',
  });
}

function onOrderClick(order, event) {
  // 拖選文字時不要順便開彈窗。
  if (String(window.getSelection() ?? '').trim()) return;
  if (event?.type === 'keydown') {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
  }
  openOrderDetail(order);
}
</script>

<template>
<section class="card">
  <h2>模擬股盤 <span id="trade-summary" class="muted">{{ summary }}</span></h2>
  <div class="table-wrap">
    <table style="min-width:760px">
      <colgroup><col style="width:24%"><col style="width:8%"><col style="width:13%"><col style="width:13%"><col style="width:13%"><col style="width:10%"></colgroup>
      <thead><tr><th>帳戶</th><th>種類</th><th class="num">現金</th><th class="num">保留</th><th class="num">淨值</th><th class="num">報酬率</th></tr></thead>
      <tbody id="trade-accounts">
        <template v-if="enabled">
          <tr v-for="account in accounts" :key="account.accountId">
            <td :title="account.accountId">{{ tradeAccountName(account.accountId, account.accountName) }}</td>
            <td class="muted">{{ account.kind === 'bot' ? 'Bot' : '玩家' }}</td>
            <td class="num">{{ tradeMoney(account.cashCents) }}</td>
            <td class="num">{{ tradeMoney(account.reservedCents) }}</td>
            <td class="num">{{ tradeMoney(account.navCents) }}</td>
            <td class="num">{{ tradePct(account.returnPct) }}</td>
          </tr>
          <tr v-if="!accounts.length"><td colspan="6" class="muted">還沒有人下單。</td></tr>
        </template>
        <tr v-else><td colspan="6" class="muted">模擬股票沒有開啟。</td></tr>
      </tbody>
    </table>
  </div>
</section>

<section class="card">
  <h2>持股 <span id="trade-position-count" class="muted">{{ enabled ? `（${positions.length} 筆）` : '' }}</span></h2>
  <div class="table-wrap">
    <table style="min-width:860px">
      <colgroup><col style="width:18%"><col style="width:15%"><col style="width:9%"><col style="width:12%"><col style="width:12%"><col style="width:12%"><col style="width:12%"></colgroup>
      <thead><tr><th>帳戶</th><th>標的</th><th class="num">股數</th><th class="num">平均成本</th><th class="num">現價</th><th class="num">市值</th><th class="num">未實現</th></tr></thead>
      <tbody id="trade-positions">
        <template v-if="enabled">
          <tr v-for="({ account, position }, index) in positions" :key="index">
            <td :title="account.accountId">{{ tradeAccountName(account.accountId, account.accountName) }}</td>
            <td>{{ position.symbol }} {{ position.name ?? '' }}</td>
            <td class="num">{{ position.qty ?? 0 }}</td>
            <td class="num">{{ tradeMoney(position.avgCostCents) }}</td>
            <td class="num">{{ position.priceCents === null ? '—' : tradeMoney(position.priceCents) }}</td>
            <td class="num">{{ tradeMoney(position.marketValueCents) }}</td>
            <td class="num">{{ tradeMoney(position.unrealizedCents) }}</td>
          </tr>
          <tr v-if="!positions.length"><td colspan="7" class="muted">目前沒有持股。</td></tr>
        </template>
        <tr v-else><td colspan="7" class="muted">—</td></tr>
      </tbody>
    </table>
  </div>
</section>

<section class="card">
  <h2>訂單 <span id="trade-order-count" class="muted">{{ enabled ? `（最近 ${orders.length} 筆）` : '' }}</span></h2>
  <div class="table-wrap">
    <table style="min-width:960px">
      <colgroup><col style="width:12%"><col style="width:16%"><col style="width:8%"><col style="width:8%"><col style="width:8%"><col style="width:8%"><col style="width:10%"><col style="width:10%"><col style="width:10%"><col style="width:10%"></colgroup>
      <thead><tr><th>時間</th><th>帳戶</th><th>標的</th><th>方向</th><th class="num">股數</th><th>狀態</th><th class="num">成交價</th><th class="num">手續費</th><th class="num">稅</th><th>原因</th></tr></thead>
      <tbody id="trade-orders">
        <template v-if="enabled">
          <tr v-for="(order, index) in orders" :key="index" class="clickable" :data-order="index" title="點開看完整訂單" tabindex="0"
              @click="onOrderClick(order, $event)" @keydown="onOrderClick(order, $event)">
            <td class="muted nowrap">{{ String(order.created_at ?? '').slice(0, 16).replace('T', ' ') }}</td>
            <td>{{ tradeAccountName(order.account_id, order.accountName) }}</td>
            <td>{{ order.symbol }}</td>
            <td>{{ order.side === 'buy' ? '買' : '賣' }}</td>
            <td class="num">{{ order.qty ?? '' }}</td>
            <td>{{ order.status === 'pending' ? '排隊中' : (order.status === 'filled' ? '已成交' : '未成交') }}</td>
            <td class="num">{{ order.fill_price_cents ? tradeMoney(order.fill_price_cents) : '—' }}</td>
            <td class="num">{{ order.fee_cents ? tradeMoney(order.fee_cents) : '—' }}</td>
            <td class="num">{{ order.tax_cents ? tradeMoney(order.tax_cents) : '—' }}</td>
            <td class="muted">{{ [order.reject_reason, order.actor === 'bot' ? order.reason : ''].filter(Boolean).join('｜') }}</td>
          </tr>
          <tr v-if="!orders.length"><td colspan="10" class="muted">還沒有訂單。</td></tr>
        </template>
        <tr v-else><td colspan="10" class="muted">—</td></tr>
      </tbody>
    </table>
  </div>
</section>

<section class="card">
  <h2>報價來源</h2>
  <div class="table-wrap">
    <table style="min-width:640px">
      <colgroup><col style="width:16%"><col style="width:16%"><col style="width:18%"><col style="width:12%"><col style="width:38%"></colgroup>
      <thead><tr><th>來源</th><th>資料日期</th><th>最後抓取</th><th class="num">筆數</th><th>錯誤</th></tr></thead>
      <tbody id="trade-quotes">
        <template v-if="enabled">
          <tr v-for="quote in quotes" :key="quote.exchange">
            <td>{{ quote.exchange }}</td>
            <td>{{ quote.date ?? '—' }}</td>
            <td class="muted">{{ quote.fetchedAt ? new Date(quote.fetchedAt).toLocaleString() : '—' }}</td>
            <td class="num">{{ quote.count ?? 0 }}</td>
            <td class="muted">{{ quote.error ?? '' }}</td>
          </tr>
          <tr v-if="!quotes.length"><td colspan="5" class="muted">沒有報價來源資料。</td></tr>
        </template>
        <tr v-else><td colspan="5" class="muted">—</td></tr>
      </tbody>
    </table>
  </div>
</section>

<section class="card">
  <h2>Bot 交易員 <span id="trade-bot-note" class="muted">{{ enabled && !trade.botEnabled ? '（Bot 交易沒有開啟）' : '' }}</span></h2>
  <div class="table-wrap">
    <table style="min-width:760px">
      <colgroup><col style="width:22%"><col style="width:10%"><col style="width:10%"><col style="width:12%"><col style="width:46%"></colgroup>
      <thead><tr><th>開始</th><th>種類</th><th>狀態</th><th class="num">Tokens</th><th>原因</th></tr></thead>
      <tbody id="trade-bot">
        <template v-if="enabled">
          <tr v-for="(run, index) in runs" :key="index">
            <td class="muted nowrap">{{ String(run.started_at ?? '').slice(0, 16).replace('T', ' ') }}</td>
            <td>{{ run.kind === 'review' ? '復盤' : '決策' }}</td>
            <td>{{ run.status ?? '—' }}</td>
            <td class="num">{{ run.tokens ?? 0 }}</td>
            <td class="muted">{{ run.reason ?? '' }}</td>
          </tr>
          <tr v-if="!runs.length"><td colspan="5" class="muted">還沒有 Bot 決策紀錄。</td></tr>
        </template>
        <tr v-else><td colspan="5" class="muted">—</td></tr>
      </tbody>
    </table>
  </div>
</section>
</template>
