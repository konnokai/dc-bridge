<script setup>
import { computed, watch } from 'vue';
import { data, triggerState } from '../store.js';
import { fmtAgo } from '../format.js';
import { LIST_PAGE_SIZE } from '../store.js';

const SORT = {
  count: (user) => Number(user.count ?? 0),
  drawCount: (user) => Number(user.drawCount ?? 0),
  lastAt: (user) => Number(user.lastAt ?? 0),
  firstAt: (user) => Number(user.firstAt ?? 0),
};

const summary = computed(() => {
  const t = data.triggers;
  if (!t) return '';
  return `（今天 ${t.todayUsers ?? 0} 人｜總計 ${t.totalUsers ?? 0} 人｜${t.totalTriggers ?? 0} 次｜畫圖 ${t.totalDraws ?? 0} 次）`;
});

const filtered = computed(() => {
  const users = data.triggers?.users ?? [];
  const query = triggerState.search.trim().toLowerCase();
  if (!query) return users;
  return users.filter((user) => String(user.name ?? '').toLowerCase().includes(query) || String(user.userId).includes(query));
});

const sorted = computed(() => {
  const value = SORT[triggerState.sortKey];
  if (!value) return filtered.value;
  const dir = triggerState.dir === 'asc' ? 1 : -1;
  // 同值時沿用伺服器給的順序（次數多、最近觸發在前）；sort 是穩定排序。
  return [...filtered.value].sort((a, b) => ((value(a) || 0) - (value(b) || 0)) * dir);
});

const pages = computed(() => Math.max(1, Math.ceil(sorted.value.length / LIST_PAGE_SIZE)));
const page = computed(() => Math.min(Math.max(1, triggerState.page), pages.value));
const rows = computed(() => sorted.value.slice((page.value - 1) * LIST_PAGE_SIZE, page.value * LIST_PAGE_SIZE));
watch(page, (value) => { if (triggerState.page !== value) triggerState.page = value; }, { immediate: true });

function sortBy(key) {
  const same = triggerState.sortKey === key;
  triggerState.dir = same && triggerState.dir === 'desc' ? 'asc' : 'desc';
  triggerState.sortKey = key;
  triggerState.page = 1;
}
function sortMark(key) {
  if (triggerState.sortKey !== key) return '';
  return triggerState.dir === 'asc' ? '↑' : '↓';
}
function ariaSort(key) {
  if (triggerState.sortKey !== key) return undefined;
  return triggerState.dir === 'asc' ? 'ascending' : 'descending';
}
function setSearch(event) {
  triggerState.search = event.target.value;
  triggerState.page = 1;
}
function setPage(page) {
  triggerState.page = Number(page) || 1;
}
</script>

<template>
<section class="card">
  <h2>對話次數 <span id="trigger-summary" class="muted">{{ summary }}</span></h2>
  <div class="row" style="margin-bottom:10px">
    <input id="trigger-search" type="search" aria-label="搜尋群友" placeholder="搜尋名稱或 user id" style="max-width:260px"
           :value="triggerState.search" @input="setSearch">
  </div>
  <div class="table-wrap">
    <table style="min-width:720px">
      <colgroup><col style="width:20%"><col style="width:9%"><col style="width:9%"><col style="width:20%"><col style="width:21%"><col style="width:21%"></colgroup>
      <thead>
        <tr>
          <th>群友</th>
          <th class="num" data-sort-key="count" :aria-sort="ariaSort('count')"><button type="button" class="sort" data-sort="count" @click="sortBy('count')">次數<span class="sort-mark" aria-hidden="true">{{ sortMark('count') }}</span></button></th>
          <th class="num" data-sort-key="drawCount" :aria-sort="ariaSort('drawCount')"><button type="button" class="sort" data-sort="drawCount" @click="sortBy('drawCount')">畫圖<span class="sort-mark" aria-hidden="true">{{ sortMark('drawCount') }}</span></button></th>
          <th>最後頻道</th>
          <th data-sort-key="lastAt" :aria-sort="ariaSort('lastAt')"><button type="button" class="sort" data-sort="lastAt" @click="sortBy('lastAt')">最後觸發<span class="sort-mark" aria-hidden="true">{{ sortMark('lastAt') }}</span></button></th>
          <th data-sort-key="firstAt" :aria-sort="ariaSort('firstAt')"><button type="button" class="sort" data-sort="firstAt" @click="sortBy('firstAt')">第一次<span class="sort-mark" aria-hidden="true">{{ sortMark('firstAt') }}</span></button></th>
        </tr>
      </thead>
      <tbody id="trigger-rows">
        <tr v-for="user in rows" :key="user.userId">
          <td>
            <strong>{{ user.name || user.userId }}</strong>
            <div class="muted" style="font-size:11px">{{ user.userId }}</div>
          </td>
          <td class="num">{{ user.count ?? 0 }}</td>
          <td class="num">{{ user.drawCount ?? 0 }}</td>
          <td class="muted">{{ user.channelName || '—' }}</td>
          <td class="muted">{{ fmtAgo(user.lastAt) }}</td>
          <td class="muted">{{ user.firstAt ? new Date(user.firstAt).toLocaleString() : '—' }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="6" class="muted">{{ triggerState.search ? '沒有符合的人。' : '還沒有對話紀錄。' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
  <div id="trigger-pager" class="row pager">
    <template v-if="pages > 1">
      <button type="button" class="ghost" :data-page="page - 1" :disabled="page <= 1" @click="setPage(page - 1)">上一頁</button>
      <span class="muted">第 {{ page }} / {{ pages }} 頁（{{ sorted.length }} 人）</span>
      <button type="button" class="ghost" :data-page="page + 1" :disabled="page >= pages" @click="setPage(page + 1)">下一頁</button>
    </template>
  </div>
</section>
</template>
