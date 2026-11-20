<script setup>
import { computed } from 'vue';
import { data } from '../store.js';
import { fmtAgo } from '../format.js';
import QuotaCard from '../components/QuotaCard.vue';

const items = computed(() => {
  const s = data.status;
  if (!s) return [];
  const topTriggers = (s.triggers?.top ?? [])
    .map((user) => (user.name || user.userId) + ' ' + user.count)
    .join('、');
  return [
    ['Bot', s.bot ? s.bot.tag + '（' + s.bot.id + '）' : '—'],
    ['DSH', s.dsh.baseUrl],
    ['模型', s.dsh.provider + ' / ' + s.dsh.model + '（' + s.dsh.effort + '）'],
    ['Preset', s.dsh.preset],
    ['事件流', s.dsh.lastFrameAt ? '最後一幀 ' + fmtAgo(s.dsh.lastFrameAt) : '還沒收到任何幀'],
    ['會話', s.sessions + ' 個｜等待回答 ' + s.pending + '｜離線佇列 ' + (s.queue ?? 0) + ' 條'],
    ['白名單', 'guilds ' + s.allow.guilds + '｜channels ' + s.allow.channels + '｜users ' + s.allow.users],
    ['管理員', s.ownerIds.length ? s.ownerIds.join(', ') : '未設定'],
    ['頻道模式', (s.requireMention ? '要 @bot 才回' : '自由參與') + (s.mentionOverrides ? '（' + s.mentionOverrides + ' 個頻道覆寫）' : '')],
    ['圖片', s.media.enabled ? ('≤' + Math.round(s.media.maxBytes / 1048576) + 'MB，長邊 ≤' + s.media.maxLongEdge + '，最多 ' + s.media.maxCount + ' 張') : '關閉'],
    ['表情目錄', (s.emoji?.entries ?? 0) + ' 條／' + (s.emoji?.guilds ?? 0) + ' 個伺服器'],
    ['黑話', s.slang ? (s.slang.enabled ? ('待確認 ' + s.slang.candidate + '｜已確認 ' + s.slang.confirmed) : '關閉') : '—'],
    ['群知識', s.knowledge ? (s.knowledge.enabled ? ('待確認 ' + s.knowledge.candidate + '｜已確認 ' + s.knowledge.approved) : '關閉') : '—'],
    ['觸發對話', s.triggers
      ? ('今天 ' + s.triggers.todayUsers + ' 人｜總計 ' + s.triggers.totalUsers + ' 人（' + s.triggers.totalTriggers + ' 次｜畫圖 ' + (s.triggers.totalDraws ?? 0) + ' 次）' + (topTriggers ? '｜最常：' + topTriggers : ''))
      : '—'],
    ['模型不理', (() => {
      const names = (s.ignored ?? []).map((user) => user.name || user.userId);
      if (!names.length) return '沒有';
      return names.length + ' 人' + (names.length <= 5 ? '：' + names.join('、') : '');
    })()],
    ['控制台', s.console.host + ':' + s.console.port],
  ];
});
</script>

<template>
<section class="card">
  <h2>狀態</h2>
  <div id="status" class="grid">
    <div v-for="([label, value], index) in items" :key="index">
      <div class="muted" style="font-size:12px">{{ label }}</div>
      <div class="mono" style="word-break:break-all">{{ value }}</div>
    </div>
  </div>
</section>

<QuotaCard prefix="quota" :quota="data.quota" />
<QuotaCard prefix="quota-2" :quota="data.quota?.fallback ?? null" />
<QuotaCard prefix="codex-quota" :quota="data.codexQuota" kind="codex" />
</template>
