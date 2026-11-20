<script setup>
import { computed, reactive } from 'vue';
import { api } from '../api.js';
import { data, refreshUsage, ui } from '../store.js';
import { usageClock, usageMoney, usageNum, usagePct } from '../format.js';

const RANGES = [['24h', '24 小時'], ['3d', '3 天'], ['7d', '7 天'], ['30d', '30 天']];
const W = 720, H = 150, padL = 4, padR = 4, padT = 8, padB = 22;
const plotW = W - padL - padR, plotH = H - padT - padB;

const message = reactive({ text: '', tone: '' });
let messageTimer = null;

const totals = computed(() => data.usage?.totals ?? {});
const buckets = computed(() => data.usage?.series?.buckets ?? []);
const symbol = computed(() => data.usage?.prices?.symbol ?? '$');

const totalText = computed(() => ((Number(totals.value.cost) || 0) > 0 ? '累計 ' + usageMoney(totals.value.cost, symbol.value) : ''));

const priceText = computed(() => {
  const prices = data.usage?.prices;
  if (!prices) return '';
  return `價目 ${prices.version}｜${prices.now?.label ?? ''}（${prices.now?.model ?? ''}）｜現在是`
    + (prices.now?.tier === 'peak' ? '高峰時段（單價 ×2）' : '空閒時段');
});

const totalItems = computed(() => {
  const t = totals.value;
  const b = t.buckets ?? {};
  return [
    ['總花費', usageMoney(t.cost, symbol.value) + (t.byTier ? `（高峰 ${usageMoney(t.byTier.peak, symbol.value)}｜空閒 ${usageMoney(t.byTier.off, symbol.value)}）` : '')],
    ['輪 / 步', usageNum(t.turns) + ' 輪｜' + usageNum(t.steps) + ' 步'],
    ['Token', '輸入 ' + usageNum(t.inputTokens) + '（命中率 ' + usagePct(t.cacheHitRate) + '）｜輸出 ' + usageNum(b.output)],
    ['平均每輪', usageMoney(t.avgCostPerTurn, symbol.value)],
  ];
});

const note = computed(() => {
  const d = data.usage;
  if (!d) return '';
  const series = d.series ?? {};
  const t = d.totals ?? {};
  const notes = [
    `圖上是近 ${d.hours ?? 24} 小時：${usageMoney(series.totals?.cost ?? 0, symbol.value)}，`
    + `${usageNum(series.totals?.tokens ?? 0)} token`
    + (series.busiest ? `｜最貴一格 ${usageClock(series.busiest.t, series.bucketMs)} ${usageMoney(series.busiest.cost, symbol.value)}` : ''),
  ];
  if ((series.offChartCost ?? 0) > 0.0001) {
    notes.push(`另有 ${usageMoney(series.offChartCost, symbol.value)} 是更早的歷史（只有累計值，沒有逐時明細），所以圖上合計會小於總花費。`);
  }
  if (series.countedSamples === 0) {
    notes.push('時間窗內沒有取樣：可能真的沒呼叫，或逐輪明細已被容量上限淘汰（總量仍然準）。');
  }
  if (t.estimated) notes.push('⚠️ 有模型不在價目表，按兜底價估算。');
  if ((d.ledger?.droppedLines ?? 0) > 0) {
    notes.push(`⚠️ 帳本有 ${d.ledger.droppedLines} 行讀不回來（已跳過，其餘照常計算）。`);
  }
  return notes.join(' ');
});

const chart = computed(() => {
  const series = data.usage?.series;
  const list = buckets.value;
  const empty = !list.length || !list.some((b) => (b.cost || 0) > 0 || (b.tokens || 0) > 0);
  if (empty) return { empty: true, bars: [], hits: [], labels: [], gridlines: [] };
  const max = Math.max(...list.map((b) => b.cost || 0), 0) || 1;
  const step = plotW / list.length;
  const barW = Math.max(1, step * 0.72);
  const tierClass = (tier) => (tier === 'peak' ? 'bar-peak' : tier === 'mixed' ? 'bar-mixed' : 'bar-off');
  const tipOf = (b) => `${usageClock(b.t, series.bucketMs)}\n花費：${usageMoney(b.cost, symbol.value)}`
    + `\n未命中 ${usageNum(b.cacheMiss)}｜命中 ${usageNum(b.cacheHit)}｜輸出 ${usageNum(b.output)}`
    + `\n步數 ${usageNum(b.steps)}｜輪次 ${usageNum(b.turns)}`
    + `\n時段：${b.tier === 'peak' ? '高峰期（單價 ×2）' : b.tier === 'mixed' ? '跨時段' : '空閒'}`;
  const bars = [];
  const hits = [];
  list.forEach((b, i) => {
    const cost = b.cost || 0;
    const height = cost > 0 ? Math.max(1.5, (cost / max) * plotH) : 0;
    const x = padL + i * step + (step - barW) / 2;
    if (height > 0) {
      bars.push({ x, y: padT + plotH - height, width: barW, height, cls: tierClass(b.tier), tip: tipOf(b) });
    }
    // 0 的格子也要能 hover，否則「那幾個小時很安靜」看不出來。
    hits.push({ x: padL + i * step, y: padT, width: step, height: plotH, tip: tipOf(b) });
  });
  const tickEvery = Math.max(1, Math.ceil(list.length / 6));
  const labels = [];
  for (let i = 0; i < list.length; i += tickEvery) {
    labels.push({ x: padL + i * step + step / 2, y: H - padB + 15, text: usageClock(list[i].t, series.bucketMs) });
  }
  return {
    empty: false,
    bars,
    hits,
    labels,
    gridlines: [0, 0.5, 1].map((fraction) => ({ y: padT + plotH - fraction * plotH })),
  };
});

const conversations = computed(() => data.usage?.conversations ?? []);

function share(conversation) {
  const totalCost = Number(totals.value.cost) || 0;
  return totalCost > 0 ? (Number(conversation.cost) || 0) / totalCost : 0;
}

async function setRange(range) {
  ui.usageRange = range;
  try {
    await refreshUsage(range);
    if (message.tone === 'err') { message.text = ''; message.tone = ''; }
  } catch (error) {
    message.text = '花費讀取失敗：' + error.message;
    message.tone = 'err';
  }
}

async function toggleRow(conversation) {
  const key = conversation.key;
  if (ui.usageOpenKey === key) {
    ui.usageOpenKey = null;
    ui.usageDetail = null;
    return;
  }
  ui.usageOpenKey = key;
  ui.usageDetail = null;
  try {
    const detail = await api('/api/usage/turns?key=' + encodeURIComponent(key) + '&limit=200');
    if (ui.usageOpenKey === key) ui.usageDetail = detail;
  } catch (error) {
    if (ui.usageOpenKey === key) ui.usageDetail = { error: '逐輪明細讀取失敗：' + error.message };
  }
}

function flash(text, tone) {
  message.text = text;
  message.tone = tone;
  if (messageTimer) clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    if (message.text === text) { message.text = ''; message.tone = ''; }
  }, 4000);
}

async function resetLedger() {
  if (!confirm('清空 token 帳本？累計花費與逐輪明細都會消失，重啟或事件流重連後才會重新拉回累計值（逐輪明細只能重新累積）。')) return;
  try {
    await api('/api/usage/reset', { method: 'POST', body: JSON.stringify({}) });
    ui.usageOpenKey = null;
    ui.usageDetail = null;
    await refreshUsage();
    flash('已清空帳本', 'ok');
  } catch (error) {
    message.text = '清空失敗：' + error.message;
    message.tone = 'err';
  }
}

function detailRows(conversation) {
  return conversation.key === ui.usageOpenKey;
}
</script>

<template>
<section class="card">
  <h2>花費 <span id="usage-total" class="muted">{{ totalText }}</span></h2>
  <div class="row" style="margin-bottom:10px">
    <div id="usage-range" class="seg">
      <button v-for="([range, label]) in RANGES" :key="range" :data-range="range"
              :aria-pressed="ui.usageRange === range" @click="setRange(range)">{{ label }}</button>
    </div>
    <span id="usage-price" class="muted" style="font-size:12px">{{ priceText }}</span>
  </div>
  <div id="usage-totals" class="grid">
    <div v-for="([label, value], index) in totalItems" :key="index">
      <div class="muted" style="font-size:12px">{{ label }}</div>
      <div class="mono" style="word-break:break-all">{{ value }}</div>
    </div>
  </div>
  <div id="usage-chart" class="chart">
    <div v-if="chart.empty" class="muted" style="font-size:12px;padding:12px 0">這個時間窗內還沒有用量。</div>
    <svg v-else :viewBox="`0 0 ${W} ${H}`" role="img" aria-label="花費走勢">
      <line v-for="(line, index) in chart.gridlines" :key="'g' + index" :x1="padL" :y1="line.y" :x2="W - padR" :y2="line.y" class="gridline" />
      <rect v-for="(bar, index) in chart.bars" :key="'b' + index" :x="bar.x" :y="bar.y" :width="bar.width" :height="bar.height"
            rx="2" :class="bar.cls"><title>{{ bar.tip }}</title></rect>
      <rect v-for="(hit, index) in chart.hits" :key="'h' + index" :x="hit.x" :y="hit.y" :width="hit.width" :height="hit.height"
            fill="transparent"><title>{{ hit.tip }}</title></rect>
      <text v-for="(label, index) in chart.labels" :key="'l' + index" :x="label.x" :y="label.y" text-anchor="middle" class="axis">{{ label.text }}</text>
    </svg>
  </div>
  <div id="usage-note" class="muted" style="font-size:12px;margin-top:6px">{{ note }}</div>
  <div class="table-wrap" style="margin-top:10px">
    <table style="min-width:820px">
      <colgroup><col style="width:20%"><col style="width:7%"><col style="width:8%"><col style="width:10%"><col style="width:11%"><col style="width:10%"><col style="width:11%"><col style="width:23%"></colgroup>
      <thead><tr><th>會話</th><th class="num">輪</th><th class="num">步</th><th class="num">未命中</th><th class="num">命中輸入</th><th class="num">輸出</th><th class="num">花費</th><th>占比</th></tr></thead>
      <tbody id="usage-rows">
        <template v-for="conversation in conversations" :key="conversation.key">
          <tr class="clickable" :data-usage-key="conversation.key" @click="toggleRow(conversation)">
            <td class="mono">{{ conversation.key }}</td>
            <td class="num">{{ usageNum(conversation.turns) }}</td>
            <td class="num">{{ usageNum(conversation.steps) }}</td>
            <td class="num">{{ usageNum(conversation.buckets?.cacheMiss) }}</td>
            <td class="num">{{ usageNum(conversation.buckets?.cacheHit) }}</td>
            <td class="num">{{ usageNum(conversation.buckets?.output) }}</td>
            <td class="num">{{ usageMoney(conversation.cost, symbol) }}</td>
            <td>
              <div class="bar-wrap">
                <div class="bar-track"><div class="bar-fill" :style="{ width: Math.max(2, Math.round(share(conversation) * 100)) + '%' }"></div></div>
                <span class="muted" style="font-size:11px">{{ (share(conversation) * 100).toFixed(1) }}%</span>
              </div>
            </td>
          </tr>
          <tr v-if="detailRows(conversation)" class="detail">
            <td colspan="8">
              <span v-if="!ui.usageDetail" class="muted">讀取逐輪明細…</span>
              <span v-else-if="ui.usageDetail.error" class="msg err">{{ ui.usageDetail.error }}</span>
              <template v-else>
                <div class="muted" style="font-size:12px;margin-bottom:6px">
                  {{ ui.usageDetail.key }}｜可追溯 {{ ui.usageDetail.turns?.length ?? 0 }} 輪｜已歸屬 {{ usageMoney(ui.usageDetail.attributedCost, symbol) }}
                  <template v-if="Number(ui.usageDetail.unattributedCost) > 0">｜未逐輪歸屬 {{ usageMoney(ui.usageDetail.unattributedCost, symbol) }}</template>
                </div>
                <span v-if="!(ui.usageDetail.turns ?? []).length" class="muted">這個會話只有累計值，沒有可追溯的逐輪紀錄。</span>
                <table v-else>
                  <thead><tr><th class="num">輪</th><th>結束時間</th><th class="num">步</th><th class="num">未命中</th><th class="num">命中輸入</th><th class="num">輸出</th><th class="num">花費</th><th>時段</th></tr></thead>
                  <tbody>
                    <tr v-for="turn in ui.usageDetail.turns" :key="turn.turn">
                      <td class="num">#{{ turn.turn }}</td>
                      <td>{{ turn.endedAt ? new Date(turn.endedAt).toLocaleString() : '—' }}</td>
                      <td class="num">{{ usageNum(turn.steps) }}</td>
                      <td class="num">{{ usageNum(turn.buckets?.cacheMiss) }}</td>
                      <td class="num">{{ usageNum(turn.buckets?.cacheHit) }}</td>
                      <td class="num">{{ usageNum(turn.buckets?.output) }}</td>
                      <td class="num">{{ usageMoney(turn.cost, symbol) }}</td>
                      <td>{{ turn.tier === 'peak' ? '高峰' : turn.tier === 'off' ? '空閒' : turn.tier === 'mixed' ? '跨時段' : '—' }}</td>
                    </tr>
                  </tbody>
                </table>
              </template>
            </td>
          </tr>
        </template>
        <tr v-if="!conversations.length">
          <td colspan="8" class="muted">還沒有可歸屬的回合；DSH 產生用量後這裡會出現。</td>
        </tr>
      </tbody>
    </table>
  </div>
  <div class="row" style="margin-top:10px">
    <button id="usage-reset" class="ghost danger" @click="resetLedger">清空帳本</button>
    <span id="usage-msg" class="msg" :class="message.tone" role="status">{{ message.text }}</span>
  </div>
</section>
</template>
