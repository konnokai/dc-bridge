<script setup>
import { computed } from 'vue';
import { fmtAgo, quotaProviderLabel, untilText } from '../format.js';

const props = defineProps({
  prefix: { type: String, required: true },
  quota: { type: Object, default: null },
  kind: { type: String, default: 'subscription' }, // subscription | codex
});

const title = computed(() => (props.kind === 'codex' ? 'Codex' : quotaProviderLabel(props.quota?.provider)));
const hidden = computed(() => !props.quota || props.quota.skipped === true);
const error = computed(() => (props.quota && props.quota.ok === false
  ? '查不到：' + (props.quota.error ?? '未知原因')
  : ''));

const note = computed(() => {
  const q = props.quota;
  if (!q || !q.ok) return '';
  if (props.kind === 'codex') {
    const notes = ['5 分鐘更新一次'];
    if (q.resetCredits?.availableCount > 0) notes.push('重置券 ' + q.resetCredits.availableCount + ' 張');
    if (q.credits?.hasCredits && Number(q.credits.balance) > 0) notes.push('credits ' + q.credits.balance);
    return `（${fmtAgo(q.fetchedAt)}查的，${notes.join('，')}）`;
  }
  return `（${fmtAgo(q.fetchedAt)}查的，60 秒更新一次）`;
});

function rowOf(window) {
  const percent = Math.max(0, Math.min(100, Number(window.remainingPercent) || 0));
  const bar = Math.round(percent);
  const level = bar <= 10 ? ' bad' : bar <= 30 ? ' warn' : '';
  // 月額度的分母只有 70，整數百分比一格是 $0.7，跟下面那列金額對不起來，所以多留一位。
  const shown = window.key === 'monthly' ? percent.toFixed(1) : String(bar);
  const remaining = window.resetsAt ? window.resetsAt - Date.now() : null;
  const reset = remaining === null ? '' : remaining > 0 ? untilText(remaining) + '後重置' : '已重置';
  return {
    label: window.label,
    bar,
    level,
    text: shown + '%' + (window.status && window.status !== 'ok' ? '（' + window.status + '）' : '') + (reset ? '｜' + reset : ''),
  };
}

const rows = computed(() => {
  const q = props.quota;
  if (!q || !q.ok) return [];
  const windows = q.windows ?? [];
  const list = [];
  for (const window of windows) {
    list.push(rowOf(window));
    // 每月只報剩餘金額（上限是方案常數），金額緊接在月額度那一列後面。
    if (window.key === 'monthly' && q.monthly) {
      list.push({ label: '剩餘', bar: null, level: '', text: '$' + Number(q.monthly.remaining).toFixed(2) });
    }
  }
  return list;
});
</script>

<template>
<section class="card" :id="prefix + '-card'" :hidden="hidden">
  <h2 v-if="kind === 'codex'">Codex 額度 <span :id="prefix + '-note'" class="muted">{{ note }}</span></h2>
  <h2 v-else><span :id="prefix + '-title'">{{ title }}</span> 額度 <span :id="prefix + '-note'" class="muted">{{ note }}</span></h2>
  <div :id="prefix">
    <div v-if="error" class="msg err">{{ error }}</div>
    <template v-else-if="quota && quota.ok">
      <div v-for="(row, index) in rows" :key="index" class="quota-row">
        <span class="muted">{{ row.label }}</span>
        <div v-if="row.bar !== null" class="bar-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"
             :aria-valuenow="String(row.bar)" :aria-label="row.label + '剩餘額度'">
          <div class="bar-fill" :class="row.level" :style="{ width: row.bar + '%' }"></div>
        </div>
        <div v-else></div>
        <span class="num">{{ row.text }}</span>
      </div>
    </template>
  </div>
</section>
</template>
