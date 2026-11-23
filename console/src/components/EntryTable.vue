<script setup>
import { computed, watch } from 'vue';
import { LIST_PAGE_SIZE, listPageCandidates, listSelection, listView, runSlangBatch } from '../store.js';

const props = defineProps({
  kind: { type: String, required: true },
  title: { type: String, required: true },
  entries: { type: Array, default: () => [] },
  fields: { type: Function, required: true },
  columns: { type: Array, required: true },
  filters: { type: Array, default: () => [['all', '全部'], ['candidate', '待確認'], ['confirmed', '已確認'], ['rejected', '已拒絕']] },
  empty: { type: String, default: '' },
  selectable: { type: Boolean, default: false },
});

const view = listView[props.kind];
const selection = listSelection[props.kind];

const matched = computed(() => {
  const query = view.query.trim().toLowerCase();
  if (!query) return props.entries;
  return props.entries.filter((entry) => props.fields(entry).some((value) => String(value ?? '').toLowerCase().includes(query)));
});

const counts = computed(() => {
  const out = { all: matched.value.length };
  for (const [status] of props.filters) out[status] ??= 0;
  for (const entry of matched.value) if (out[entry.status] !== undefined) out[entry.status] += 1;
  return out;
});

const summary = computed(() => props.filters
  .filter(([status]) => status !== 'all')
  .map(([status, label]) => `${label} ${counts.value[status]}`)
  .join('｜'));

const shown = computed(() => (view.status === 'all' ? matched.value : matched.value.filter((entry) => entry.status === view.status)));
const pages = computed(() => Math.max(1, Math.ceil(shown.value.length / LIST_PAGE_SIZE)));
const page = computed(() => Math.min(Math.max(1, view.page), pages.value));
const rows = computed(() => shown.value.slice((page.value - 1) * LIST_PAGE_SIZE, page.value * LIST_PAGE_SIZE));
const colSpan = computed(() => props.columns.length + (props.selectable ? 1 : 0) + 1);

watch(page, (value) => { if (view.page !== value) view.page = value; }, { immediate: true });

// 選取只跟著這一頁看得見的候選：換頁、換篩選或搜尋就清掉，批次才不會動到畫面上沒出現的詞。
watch(rows, (list) => {
  if (!props.selectable) return;
  const key = `${view.status}|${page.value}|${view.query}|${view.channel ?? ''}`;
  if (view.selectionKey !== key) {
    selection.clear();
    view.selectionKey = key;
  }
  listPageCandidates[props.kind] = list.filter((entry) => entry.status === 'candidate').map((entry) => entry.id);
  const alive = new Set(listPageCandidates[props.kind]);
  for (const id of [...selection]) if (!alive.has(id)) selection.delete(id);
}, { immediate: true });

function setStatus(status) {
  view.status = status;
  view.page = 1;
}
function setPage(page) {
  view.page = Number(page) || 1;
}
function toggleSelectPage() {
  const ids = listPageCandidates[props.kind] ?? [];
  const allSelected = ids.length > 0 && ids.every((id) => selection.has(id));
  for (const id of ids) {
    if (allSelected) selection.delete(id);
    else selection.add(id);
  }
}
function toggleOne(entry, checked) {
  if (checked) selection.add(entry.id);
  else selection.delete(entry.id);
}
</script>

<template>
<section class="card">
  <h2>{{ title }} <span :id="kind + '-count'" class="muted">（{{ summary }}）</span></h2>
  <div class="row" style="margin-bottom:10px">
    <slot name="toolbar" />
    <div :id="kind + '-filter'" class="seg">
      <button v-for="([status, label]) in filters" :key="status" type="button" :data-list="kind" :data-status="status"
              :aria-pressed="view.status === status" @click="setStatus(status)">{{ label }} {{ counts[status] }}</button>
    </div>
  </div>
  <div v-if="selectable" class="row" style="margin-bottom:10px">
    <button type="button" :id="kind + '-select-page'" class="ghost" @click="toggleSelectPage">全選本頁</button>
    <button type="button" :id="kind + '-batch-confirm'" @click="runSlangBatch(kind, 'confirm')">確認選取</button>
    <button type="button" :id="kind + '-batch-reject'" class="ghost" @click="runSlangBatch(kind, 'reject')">拒絕選取</button>
    <span :id="kind + '-selected'" class="muted">{{ selection.size ? `已選 ${selection.size}` : '' }}</span>
  </div>
  <div class="table-wrap">
    <table class="entry-table">
      <colgroup>
        <col v-if="selectable" style="width:36px">
        <col v-for="column in columns" :key="column.key" :style="column.width ? { width: column.width } : undefined">
        <col style="width:112px">
      </colgroup>
      <thead>
        <tr>
          <th v-if="selectable"></th>
          <th v-for="column in columns" :key="column.key" :class="column.className">{{ column.label }}</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody :id="kind + '-rows'">
        <tr v-for="entry in rows" :key="entry.id">
          <td v-if="selectable" class="nowrap">
            <input v-if="entry.status === 'candidate'" type="checkbox" style="width:auto;margin:0"
                   :aria-label="`選取 ${entry.term}`" :data-select="entry.id"
                   :checked="selection.has(entry.id)" @change="toggleOne(entry, $event.target.checked)">
          </td>
          <td v-for="column in columns" :key="column.key" :class="column.className" :title="column.title ? column.title(entry) : undefined">
            <slot v-if="$slots['cell-' + column.key]" :name="'cell-' + column.key" :e="entry" />
            <template v-else>{{ column.value ? column.value(entry) : '' }}</template>
          </td>
          <td>
            <slot name="actions" :e="entry" />
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="colSpan" class="muted empty-cell">
            {{ view.query && !matched.length ? '沒有符合的項目。' : entries.length ? '這個狀態沒有項目。' : empty }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <div :id="kind + '-pager'" class="row pager">
    <template v-if="pages > 1">
      <button type="button" class="ghost" :data-list="kind" :data-page="page - 1" :disabled="page <= 1" @click="setPage(page - 1)">上一頁</button>
      <span class="muted">第 {{ page }} / {{ pages }} 頁（{{ shown.length }} 筆）</span>
      <button type="button" class="ghost" :data-list="kind" :data-page="page + 1" :disabled="page >= pages" @click="setPage(page + 1)">下一頁</button>
    </template>
  </div>
</section>
</template>
