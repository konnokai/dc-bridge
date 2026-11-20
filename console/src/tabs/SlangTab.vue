<script setup>
import { computed, ref, watch } from 'vue';
import { api } from '../api.js';
import { data, listView, refresh } from '../store.js';
import EntryTable from '../components/EntryTable.vue';
import EntryActions from '../components/EntryActions.vue';

const SLANG_LABEL = { candidate: '待確認', confirmed: '已確認', rejected: '已拒絕' };
const busy = ref('');

const words = computed(() => (data.slang?.entries ?? []).filter((entry) => entry.kind !== 'style'));
const styles = computed(() => (data.slang?.entries ?? []).filter((entry) => entry.kind === 'style'));

const learningText = computed(() => {
  const learning = data.slang?.learning;
  if (!learning?.enabled) return '黑話學習已關閉（config.json 的 discord.slang.enabled）';
  return learning.running ? '學習中…' : `佇列 ${learning.queued ?? 0}｜今天 ${learning.today ?? 0}/${learning.maxPerDay ?? 0}`;
});

// 頻道選單：同名頻道先補伺服器名稱，還是撞才補 id。
const channels = computed(() => {
  const map = new Map();
  for (const entry of styles.value) {
    const channel = map.get(entry.channelId) ?? {
      id: entry.channelId,
      name: entry.channelName || entry.channelId,
      guildName: '',
      count: 0,
    };
    // 舊條目可能沒有 guildName，同頻道只要有一筆查得到就用。
    channel.guildName ||= entry.guildName || '';
    channel.count += 1;
    map.set(entry.channelId, channel);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')
    || a.guildName.localeCompare(b.guildName, 'zh-Hant')
    || a.id.localeCompare(b.id));
});

const channelOptions = computed(() => {
  const list = channels.value;
  const labelOf = (channel) => `#${channel.name}${channel.guildName ? ` · ${channel.guildName}` : ''}`;
  const labels = list.map(labelOf);
  const duplicated = new Set(labels.filter((label, index) => labels.indexOf(label) !== index));
  return [
    { value: 'all', label: `全部頻道（${styles.value.length}）` },
    ...list.map((channel) => ({
      value: channel.id,
      label: `#${channel.name}${channel.guildName ? ` · ${channel.guildName}` : ''}${duplicated.has(`#${channel.name}${channel.guildName ? ` · ${channel.guildName}` : ''}`) ? ` · ${channel.id}` : ''}（${channel.count}）`,
    })),
  ];
});

const activeChannel = computed(() => (channels.value.some((row) => row.id === listView.style.channel) ? listView.style.channel : 'all'));
watch(activeChannel, (value) => {
  if (listView.style.channel === value) return;
  listView.style.channel = value;
  listView.style.page = 1;
}, { immediate: true });

const visibleStyles = computed(() => (activeChannel.value === 'all'
  ? styles.value
  : styles.value.filter((entry) => entry.channelId === activeChannel.value)));

const slangColumns = [
  { key: 'term', label: '詞', width: '16%', title: (entry) => String(entry.term ?? '') },
  { key: 'meaning', label: '意思', title: (entry) => String(entry.meaning ?? '') },
  { key: 'usage', label: '用法', className: 'muted', title: (entry) => entry.usage || '—' },
  { key: 'status', label: '狀態', className: 'nowrap', width: '64px', value: (entry) => SLANG_LABEL[entry.status] ?? entry.status },
  { key: 'seen', label: '次數', className: 'nowrap', width: '64px', value: (entry) => String(entry.seen ?? 0) },
];

const styleColumns = [
  { key: 'channel', label: '頻道', className: 'muted', width: '20%', title: (entry) => channelLabel(entry) },
  { key: 'term', label: '標籤', width: '12%', title: (entry) => String(entry.term ?? '') },
  { key: 'meaning', label: '描述', title: (entry) => String(entry.meaning ?? '') },
  { key: 'status', label: '狀態', className: 'nowrap', width: '64px', value: (entry) => SLANG_LABEL[entry.status] ?? entry.status },
  { key: 'seen', label: '次數', className: 'nowrap', width: '64px', value: (entry) => String(entry.seen ?? 0) },
];

function channelLabel(entry) {
  return '#' + (entry.channelName || entry.channelId) + (entry.guildName ? ` · ${entry.guildName}` : '');
}

async function act(entry, action) {
  busy.value = entry.id;
  try {
    if (action === 'delete') {
      if (!confirm('刪除「' + entry.term + '」？')) return;
      await api('/api/slang/delete', { method: 'POST', body: JSON.stringify({ id: entry.id }) });
    } else if (action === 'edit') {
      const style = entry.kind === 'style';
      const term = prompt(style ? '標籤' : '詞', entry.term);
      if (term === null) return;
      const meaning = prompt(style ? '描述' : '意思', entry.meaning);
      if (meaning === null) return;
      const usage = style ? '' : prompt('什麼時候用（可留空）', entry.usage ?? '');
      if (usage === null) return;
      await api('/api/slang/update', { method: 'POST', body: JSON.stringify({ id: entry.id, term, meaning, usage }) });
    } else {
      await api('/api/slang/' + action, { method: 'POST', body: JSON.stringify({ id: entry.id }) });
    }
    await refresh();
  } catch (error) {
    alert('操作失敗：' + error.message);
  } finally {
    busy.value = '';
  }
}

function setQuery(kind, event) {
  listView[kind].query = event.target.value;
  listView[kind].page = 1;
}
function setChannel(event) {
  listView.style.channel = event.target.value;
  listView.style.page = 1;
}
</script>

<template>
<EntryTable
  kind="slang"
  title="黑話詞庫"
  :entries="words"
  :fields="(entry) => [entry.term, entry.meaning, entry.usage]"
  :columns="slangColumns"
  empty="還沒有詞條；在允許的頻道累積 20 則訊息後會自動學。"
  selectable
>
  <template #toolbar>
    <input id="slang-search" type="search" aria-label="搜尋黑話" placeholder="搜尋詞、意思、用法" style="max-width:260px"
           :value="listView.slang.query" @input="setQuery('slang', $event)">
    <span id="slang-learning" class="muted">{{ learningText }}</span>
  </template>
  <template #cell-term="{ e }"><div class="cell-clamp"><strong>{{ e.term }}</strong></div></template>
  <template #cell-meaning="{ e }"><div class="cell-clamp">{{ e.meaning }}</div></template>
  <template #cell-usage="{ e }"><div class="cell-clamp">{{ e.usage || '—' }}</div></template>
  <template #actions="{ e }"><EntryActions :entry="e" kind="slang" :busy="busy === e.id" @action="act(e, $event)" /></template>
</EntryTable>

<EntryTable
  kind="style"
  title="頻道風格"
  :entries="visibleStyles"
  :fields="(entry) => [entry.channelName || entry.channelId, entry.guildName, entry.term, entry.meaning]"
  :columns="styleColumns"
  empty="還沒有頻道風格；黑話學習每次抽取時會順便產出。"
  selectable
>
  <template #toolbar>
    <select id="style-channel" aria-label="頻道" style="min-width:min(280px,100%);max-width:340px" :value="activeChannel" @change="setChannel">
      <option v-for="option in channelOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
    </select>
    <input id="style-search" type="search" aria-label="搜尋頻道標籤" placeholder="搜尋頻道、標籤、描述" style="max-width:260px"
           :value="listView.style.query" @input="setQuery('style', $event)">
    <span class="muted" style="font-size:12px">跟黑話同一次抽；確認後才會注入那個頻道</span>
  </template>
  <template #cell-channel="{ e }"><div class="cell-clamp">{{ channelLabel(e) }}</div></template>
  <template #cell-term="{ e }"><div class="cell-clamp"><strong>{{ e.term }}</strong></div></template>
  <template #cell-meaning="{ e }"><div class="cell-clamp">{{ e.meaning }}</div></template>
  <template #actions="{ e }"><EntryActions :entry="e" kind="style" :busy="busy === e.id" @action="act(e, $event)" /></template>
</EntryTable>
</template>
