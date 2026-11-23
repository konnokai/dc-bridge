<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { api } from '../api.js';
import { LIST_PAGE_SIZE, aliasView, data, refreshAliases } from '../store.js';
import { fmtAgo } from '../format.js';
import Pager from '../components/Pager.vue';

const busy = reactive(new Set());
const selected = aliasView.selection;
const STATUS_LABEL = { active: '啟用', rejected: '已拒絕' };
const SOURCE_LABEL = { prts: 'PRTS', query: '查詢', manual: '手動' };
const draftAlias = ref('');
const draftOperator = ref('');
const addError = ref('');
const adding = ref(false);

const all = computed(() => data.arknightsAliases?.entries ?? []);
const stats = computed(() => data.arknightsAliases?.stats ?? { total: 0, active: 0, rejected: 0 });
const missing = computed(() => data.arknightsAliases?.missing === true);
const corrupt = computed(() => data.arknightsAliases?.corrupt === true);
const operatorNames = computed(() => [...new Set(all.value.map((entry) => entry.name))].sort((a, b) => a.localeCompare(b, 'zh-Hant')));

const matched = computed(() => {
  const query = aliasView.query.trim().toLowerCase();
  if (!query) return all.value;
  return all.value.filter((entry) => [entry.alias, entry.aliasTw, entry.name, entry.nameTw, entry.charId, entry.source]
    .some((value) => String(value ?? '').toLowerCase().includes(query)));
});
const counts = computed(() => ({
  all: matched.value.length,
  active: matched.value.filter((entry) => entry.status === 'active').length,
  rejected: matched.value.filter((entry) => entry.status === 'rejected').length,
}));
const shown = computed(() => (aliasView.status === 'all'
  ? matched.value
  : matched.value.filter((entry) => entry.status === aliasView.status)));
const pages = computed(() => Math.max(1, Math.ceil(shown.value.length / LIST_PAGE_SIZE)));
const page = computed(() => Math.min(Math.max(1, aliasView.page), pages.value));
const rows = computed(() => shown.value.slice((page.value - 1) * LIST_PAGE_SIZE, page.value * LIST_PAGE_SIZE));
const pageIds = computed(() => rows.value.map((entry) => entry.id));
const allSelected = computed(() => pageIds.value.length > 0 && pageIds.value.every((id) => selected.has(id)));

watch(page, (value) => { if (aliasView.page !== value) aliasView.page = value; }, { immediate: true });
watch(rows, () => {
  const alive = new Set(pageIds.value);
  for (const id of [...selected]) if (!alive.has(id)) selected.delete(id);
}, { immediate: true });

onMounted(() => { void refreshAliases(); });

function setStatus(status) {
  aliasView.status = status;
  aliasView.page = 1;
}
function setQuery(event) {
  aliasView.query = event.target.value;
  aliasView.page = 1;
}
function setPage(value) {
  aliasView.page = Number(value) || 1;
}
function togglePage() {
  if (allSelected.value) for (const id of pageIds.value) selected.delete(id);
  else for (const id of pageIds.value) selected.add(id);
}
function toggleOne(entry, checked) {
  if (checked) selected.add(entry.id);
  else selected.delete(entry.id);
}

async function act(action, entry = null) {
  const ids = entry ? [entry.id] : [...selected];
  if (!ids.length) { alert('先勾選別名'); return; }
  if (action === 'delete' && !confirm(`刪除 ${ids.length} 條別名？刪除只是移除這一條，同一個查法可能再學回來；要永久擋用「拒絕」。`)) return;
  for (const id of ids) busy.add(id);
  try {
    await api('/api/arknights-aliases/' + action, { method: 'POST', body: JSON.stringify({ ids }) });
    selected.clear();
    await refreshAliases({ force: true });
  } catch (error) {
    alert('操作失敗：' + error.message);
  } finally {
    for (const id of ids) busy.delete(id);
  }
}

async function submitAdd() {
  const alias = draftAlias.value.trim();
  const operator = draftOperator.value.trim();
  if (!alias || !operator) { addError.value = '別名和幹員都要填'; return; }
  adding.value = true;
  addError.value = '';
  try {
    await api('/api/arknights-aliases/add', { method: 'POST', body: JSON.stringify({ alias, operator }) });
    draftAlias.value = '';
    draftOperator.value = '';
    await refreshAliases({ force: true });
  } catch (error) {
    addError.value = error.message;
  } finally {
    adding.value = false;
  }
}
</script>

<template>
<section class="card">
  <h2>幹員別名 <span id="alias-count" class="muted">（{{ stats.total }} 條｜啟用 {{ stats.active }}｜已拒絕 {{ stats.rejected }}）</span></h2>
  <p v-if="missing" id="alias-missing" class="muted">還沒建立別名表；MCP 啟動後會自動抓 PRTS，下一次查幹員時也會等它，抓到就永久保留。</p>
  <p v-if="data.arknightsAliasesError" id="alias-load-error" class="muted" style="color:var(--danger)">讀取失敗：{{ data.arknightsAliasesError }}</p>
  <p v-if="corrupt" id="alias-corrupt" class="muted" style="color:var(--danger)">
    別名檔損毀：{{ data.arknightsAliases?.error }}。修好或刪掉 <code>state/arknights-aliases.json</code> 後，下一次查幹員會重建。
  </p>
  <div class="row" style="margin-bottom:10px">
    <input id="alias-add-alias" type="text" aria-label="新別名" placeholder="別名，例如 銀老闆" maxlength="40" v-model="draftAlias">
    <input id="alias-add-operator" type="text" list="alias-operators" aria-label="幹員名稱或 charId" placeholder="幹員正式名稱或 charId" maxlength="40" v-model="draftOperator">
    <datalist id="alias-operators">
      <option v-for="name in operatorNames" :key="name" :value="name" />
    </datalist>
    <button id="alias-add" type="button" :disabled="adding" @click="submitAdd">新增別名</button>
    <span id="alias-add-error" class="muted" style="color:var(--danger)">{{ addError }}</span>
  </div>
  <div class="row" style="margin-bottom:10px">
    <input id="alias-search" type="search" aria-label="搜尋別名" placeholder="搜尋別名、幹員、charId" style="max-width:280px"
           :value="aliasView.query" @input="setQuery">
    <div id="alias-filter" class="seg">
      <button type="button" :aria-pressed="aliasView.status === 'all'" @click="setStatus('all')">全部 {{ counts.all }}</button>
      <button type="button" :aria-pressed="aliasView.status === 'active'" @click="setStatus('active')">啟用 {{ counts.active }}</button>
      <button type="button" :aria-pressed="aliasView.status === 'rejected'" @click="setStatus('rejected')">已拒絕 {{ counts.rejected }}</button>
    </div>
    <button type="button" id="alias-refresh" class="ghost" @click="refreshAliases({ force: true })">重新整理</button>
  </div>
  <div class="row" style="margin-bottom:10px">
    <button type="button" id="alias-select-page" class="ghost" @click="togglePage">全選本頁</button>
    <button type="button" id="alias-batch-reject" @click="act('reject')">拒絕選取</button>
    <button type="button" id="alias-batch-restore" class="ghost" @click="act('restore')">恢復選取</button>
    <button type="button" id="alias-batch-delete" class="danger" @click="act('delete')">刪除選取</button>
    <span id="alias-selected" class="muted">{{ selected.size ? `已選 ${selected.size}` : '' }}</span>
  </div>
  <div class="table-wrap">
    <table style="min-width:720px">
      <colgroup><col style="width:40px"><col style="width:20%"><col><col style="width:10%"><col style="width:10%"><col style="width:18%"><col style="width:170px"></colgroup>
      <thead><tr><th></th><th>別名</th><th>幹員</th><th>來源</th><th>狀態</th><th>加入</th><th>操作</th></tr></thead>
      <tbody id="alias-rows">
        <tr v-for="entry in rows" :key="entry.id">
          <td><input type="checkbox" style="width:auto;margin:0" :aria-label="`選取 ${entry.alias}`"
                     :checked="selected.has(entry.id)" @change="toggleOne(entry, $event.target.checked)"></td>
          <td><strong>{{ entry.alias }}</strong></td>
          <td>{{ entry.name }} <span v-if="entry.charId" class="muted mono">{{ entry.charId }}</span></td>
          <td class="muted">{{ SOURCE_LABEL[entry.source] ?? entry.source }}</td>
          <td>{{ STATUS_LABEL[entry.status] ?? entry.status }}</td>
          <td class="muted">{{ fmtAgo(Date.parse(entry.addedAt)) }}</td>
          <td>
            <button v-if="entry.status === 'active'" class="ghost" :disabled="busy.has(entry.id)" @click="act('reject', entry)">拒絕</button>
            <button v-else class="ghost" :disabled="busy.has(entry.id)" @click="act('restore', entry)">恢復</button>
            <button class="danger" :disabled="busy.has(entry.id)" @click="act('delete', entry)">刪除</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="7" class="muted">{{ aliasView.query && !matched.length ? '沒有符合的項目。' : '還沒有別名。' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
  <Pager id="alias-pager" :page="page" :pages="pages" :total="shown.length" unit="條" @page="setPage" />
</section>
</template>
