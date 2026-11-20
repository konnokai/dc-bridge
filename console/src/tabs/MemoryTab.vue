<script setup>
import { computed, ref, watch } from 'vue';
import { api } from '../api.js';
import {
  LIST_PAGE_SIZE, archiveState, data, fetchMemeThumb, loadArchive, memeThumbs,
  openMemeDetail, pagedLists, pruneMemeThumbs, refresh, searchArchive,
} from '../store.js';
import { archiveTime, fmtAgo } from '../format.js';
import Pager from '../components/Pager.vue';

function paginate(kind, all, fields) {
  const view = pagedLists[kind];
  const query = view.query.trim().toLowerCase();
  const matched = query
    ? all.filter((row) => fields(row).some((value) => String(value ?? '').toLowerCase().includes(query)))
    : all;
  const pages = Math.max(1, Math.ceil(matched.length / LIST_PAGE_SIZE));
  const page = Math.min(Math.max(1, view.page), pages);
  return { rows: matched.slice((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE), pages, total: matched.length, matched, page };
}

const memoryRows = computed(() => paginate('memory', data.memory?.users ?? [], (user) => [user.name, user.userId]));
const noteRows = computed(() => paginate('note', data.notes?.notes ?? [], (note) => [note.channelName, note.channelId]));
const memeRows = computed(() => paginate('meme', data.memes?.memes ?? [], (meme) => [meme.name, meme.id]));

// 縮圖要帶 Authorization 標頭，抓回來才顯示；清單變動時放掉不在清單裡的 blob。
watch(memeRows, (result) => {
  const alive = new Set((data.memes?.memes ?? []).map((meme) => meme.id));
  pruneMemeThumbs(alive);
  for (const meme of result.rows) void fetchMemeThumb(meme.id);
}, { immediate: true });

function setQuery(kind, event) {
  pagedLists[kind].query = event.target.value;
  pagedLists[kind].page = 1;
}
function setPage(kind, page) {
  pagedLists[kind].page = Number(page) || 1;
}

const archiveStatus = computed(() => {
  const a = data.archive;
  if (!a?.enabled) return '沒有開啟（config.json 的 discord.historyArchive.enabled）。';
  const parts = [
    `集合 ${a.collection}`,
    a.count === null ? `點數：${a.countError || '查不到'}` : `${a.count} 個點（近似）`,
    `保留 ${a.retentionDays} 天`,
    `佇列 ${a.queued} 則`,
    a.lastFlushAt ? `最後送出 ${fmtAgo(a.lastFlushAt)}` : '還沒送出過',
    a.flushed ? `累計 ${a.flushed} 則` : '',
  ].filter(Boolean);
  return parts.join('｜') + (a.lastError ? `；最近錯誤：${a.lastError}` : '');
});

const archiveSearch = ref('');
const archivePending = ref(false);

function archiveNote() {
  if (archiveState.status) return archiveState.status;
  return '';
}

async function archiveList(cursor) {
  archivePending.value = true;
  await loadArchive(cursor);
  archivePending.value = false;
}
async function archiveSearchSubmit() {
  archivePending.value = true;
  await searchArchive(archiveSearch.value);
  archivePending.value = false;
}
async function archiveLatest() {
  archiveState.stack = [];
  archiveSearch.value = '';
  await archiveList(null);
}
async function archiveChannelChange(event) {
  archiveState.channelId = event.target.value;
  archiveState.stack = [];
  await archiveList(null);
}
async function archiveNext() {
  if (!archiveState.next) return;
  archiveState.stack.push(archiveState.next);
  await archiveList(archiveState.next);
}
async function archivePrev() {
  if (!archiveState.stack.length) return;
  archiveState.stack.pop();
  await archiveList(archiveState.stack.at(-1) ?? null);
}
async function archiveDelete(item) {
  const preview = String(item.text || '').slice(0, 40);
  if (!confirm(`從歸檔刪掉這則？\n${item.author || ''}：${preview}\n\n刪了救不回來；這則之後被編輯會再收進來。`)) return;
  try {
    await api('/api/archive/delete', { method: 'POST', body: JSON.stringify({ id: String(item.id) }) });
    await archiveList(archiveState.stack.at(-1) ?? null);
  } catch (error) {
    alert('刪除失敗：' + error.message);
  }
}

async function deleteNote(note) {
  if (!confirm('刪掉這條筆記？模型之後就看不到了。')) return;
  try {
    await api('/api/notes/delete', { method: 'POST', body: JSON.stringify({ id: note.id }) });
    await refresh();
  } catch (error) {
    alert('刪除失敗：' + error.message);
    await refresh();
  }
}

async function deleteMeme(meme) {
  if (!confirm('刪掉這張梗圖？模型之後就送不出它了。')) return;
  try {
    await api('/api/memes/delete', { method: 'POST', body: JSON.stringify({ id: meme.id }) });
    await refresh();
  } catch (error) {
    alert('刪除失敗：' + error.message);
    await refresh();
  }
}
</script>

<template>
<section class="card">
  <h2>群友記憶 <span id="memory-count" class="muted">{{ data.memory?.enabled ? `（${(data.memory?.users ?? []).length} 人）` : '（已關閉：config.json 的 discord.memory.enabled）' }}</span></h2>
  <p class="muted" style="margin:0 0 10px;font-size:12px">模型用 remember_user 記下的事，唯讀。要刪請當事人用 /forget。</p>
  <div class="row" style="margin-bottom:10px">
    <input id="memory-search" type="search" aria-label="搜尋群友記憶" placeholder="搜尋名稱或 user id" style="max-width:260px"
           :value="pagedLists.memory.query" @input="setQuery('memory', $event)">
  </div>
  <div class="table-wrap">
    <table style="min-width:480px">
      <colgroup><col style="width:20%"><col><col style="width:20%"></colgroup>
      <thead><tr><th>群友</th><th>記得的事</th><th>更新</th></tr></thead>
      <tbody id="memory-rows">
        <tr v-for="user in memoryRows.rows" :key="user.userId">
          <td><strong>{{ user.name || user.userId }}</strong></td>
          <td>
            <div v-for="(fact, index) in user.facts" :key="index">{{ index + 1 }}. {{ fact }}</div>
            <div v-if="user.profile" class="muted">側寫：{{ user.profile }}</div>
          </td>
          <td class="muted">{{ fmtAgo(user.updatedAt) }}</td>
        </tr>
        <tr v-if="!memoryRows.rows.length">
          <td colspan="3" class="muted">{{ pagedLists.memory.query && !memoryRows.matched.length ? '沒有符合的項目。' : '還沒有記住任何人。' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
  <Pager id="memory-pager" :page="memoryRows.page" :pages="memoryRows.pages" :total="memoryRows.total" unit="人"
         @page="setPage('memory', $event)" />
</section>

<section class="card">
  <h2>歷史歸檔 <span id="archive-count" class="muted">{{ data.archive?.count == null || !data.archive?.enabled ? '' : `（${data.archive.count} 個點）` }}</span></h2>
  <p class="muted" style="margin:0 0 10px;font-size:12px">頻道訊息 embed 後存進 Qdrant，給 recall_history 用。端點與 key 在 config.json；開關與保留天數在「設定」頁，重啟後生效。<strong>這裡看得到所有已歸檔頻道的原文。</strong></p>
  <p id="archive-status" class="muted">{{ archiveStatus }}</p>
  <div class="row" style="margin:10px 0">
    <select id="archive-channel" aria-label="歸檔頻道" :value="archiveState.channelId" @change="archiveChannelChange">
      <option value="">全部頻道</option>
      <option v-for="channel in archiveState.channels" :key="channel.channelId" :value="String(channel.channelId)">
        {{ channel.name ? '#' + channel.name : channel.channelId }}（{{ channel.count }}）
      </option>
    </select>
    <input id="archive-search" v-model="archiveSearch" type="search" aria-label="搜尋歸檔" placeholder="用一句話搜尋（不用關鍵字）" style="max-width:320px"
           @keydown.enter.prevent="archiveSearchSubmit">
    <button id="archive-search-btn" type="button" class="ghost" :disabled="archivePending" @click="archiveSearchSubmit">搜尋</button>
    <button id="archive-latest" type="button" class="ghost" :disabled="archivePending" @click="archiveLatest">最新</button>
  </div>
  <div class="table-wrap">
    <table style="min-width:760px">
      <colgroup><col style="width:17%"><col style="width:15%"><col style="width:13%"><col><col style="width:9%"></colgroup>
      <thead><tr><th>時間</th><th>頻道</th><th>作者</th><th>內容</th><th></th></tr></thead>
      <tbody id="archive-rows">
        <tr v-for="item in archiveState.items" :key="item.id">
          <td class="muted">{{ archiveTime(item.at) }}</td>
          <td>{{ archiveState.names[String(item.channelId)] || item.channelId || '—' }}</td>
          <td>{{ item.author || '某人' }}</td>
          <td :title="item.text || ''">{{ String(item.text || '').slice(0, 200) }}</td>
          <td><button type="button" class="ghost" @click="archiveDelete(item)">刪除</button></td>
        </tr>
        <tr v-if="!archiveState.items.length">
          <td colspan="5" class="muted">{{ archiveNote() || '沒有資料。' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
  <div id="archive-pager" class="row pager">
    <button type="button" class="ghost" id="archive-prev" :disabled="archiveState.stack.length === 0" @click="archivePrev">上一頁</button>
    <span class="muted">{{ archiveState.search ? `搜尋「${archiveState.search}」` : `第 ${archiveState.stack.length + 1} 頁` }}</span>
    <button type="button" class="ghost" id="archive-next" :disabled="!archiveState.next" @click="archiveNext">下一頁</button>
  </div>
</section>

<section class="card">
  <h2>頻道筆記 <span id="notes-count" class="muted">{{ data.notes?.enabled ? `（${(data.notes?.notes ?? []).length} 條）` : '（已關閉：config.json 的 discord.notes.enabled）' }}</span></h2>
  <p class="muted" style="margin:0 0 10px;font-size:12px">模型用 note_event 記下的事，加上每天自動產生的頻道摘要。刪掉後模型就看不到那條。</p>
  <div class="row" style="margin-bottom:10px">
    <input id="note-search" type="search" aria-label="搜尋頻道筆記" placeholder="搜尋頻道名稱或 channel id" style="max-width:260px"
           :value="pagedLists.note.query" @input="setQuery('note', $event)">
  </div>
  <div class="table-wrap">
    <table style="min-width:720px">
      <colgroup><col style="width:16%"><col style="width:38%"><col style="width:10%"><col style="width:12%"><col style="width:12%"><col style="width:12%"></colgroup>
      <thead><tr><th>頻道</th><th>筆記</th><th>種類</th><th>記下</th><th>過期</th><th></th></tr></thead>
      <tbody id="note-rows">
        <tr v-for="note in noteRows.rows" :key="note.id">
          <td class="mono">#{{ note.channelName || note.channelId }}</td>
          <td>{{ note.text }}</td>
          <td class="muted">{{ note.by === 'summary' ? '每日摘要' : '模型' }}</td>
          <td class="muted">{{ fmtAgo(Date.parse(note.at)) }}</td>
          <td class="muted">{{ note.expiresAt ? new Date(note.expiresAt).toLocaleDateString() : '永久' }}</td>
          <td><button class="danger" @click="deleteNote(note)">刪除</button></td>
        </tr>
        <tr v-if="!noteRows.rows.length">
          <td colspan="6" class="muted">{{ pagedLists.note.query && !noteRows.matched.length ? '沒有符合的項目。' : '還沒有筆記。' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
  <Pager id="note-pager" :page="noteRows.page" :pages="noteRows.pages" :total="noteRows.total" unit="條"
         @page="setPage('note', $event)" />
</section>

<section class="card">
  <h2>梗圖 <span id="memes-count" class="muted">{{ data.memes?.enabled ? `（${(data.memes?.memes ?? []).length} 張）` : '（已關閉：config.json 的 discord.memes.enabled）' }}</span></h2>
  <p class="muted" style="margin:0 0 10px;font-size:12px">模型用 save_meme 存下的小圖，用 send_image 的 meme:名稱 送出。刪掉後模型就送不出那張；梗圖庫所有伺服器共用。</p>
  <div class="row" style="margin-bottom:10px">
    <input id="meme-search" type="search" aria-label="搜尋梗圖" placeholder="搜尋名稱或梗圖 id" style="max-width:260px"
           :value="pagedLists.meme.query" @input="setQuery('meme', $event)">
  </div>
  <div class="table-wrap">
    <table style="min-width:760px">
      <colgroup><col style="width:12%"><col style="width:42%"><col style="width:18%"><col style="width:15%"><col style="width:13%"></colgroup>
      <thead><tr><th>預覽</th><th>名稱與情境</th><th>來源</th><th>使用／尺寸</th><th></th></tr></thead>
      <tbody id="meme-rows">
        <tr v-for="meme in memeRows.rows" :key="meme.id">
          <td>
            <button class="thumb-button" title="放大" :data-meme-view="meme.id" @click="openMemeDetail(meme)">
              <img class="meme-thumb" :src="memeThumbs[meme.id] || undefined" :alt="meme.name" :width="meme.width" :height="meme.height">
            </button>
          </td>
          <td>
            <div>{{ meme.name }}</div>
            <div class="muted">{{ meme.when }}</div>
            <div v-if="meme.tags?.length" class="muted meme-tags">{{ meme.tags.join('、') }}</div>
          </td>
          <td class="muted">{{ (meme.createdBy === 'bot' ? '大肥魚自己的圖' : '群友的圖') + ' · ' + (meme.guildName || '—') + ' · #' + meme.channelName }}</td>
          <td class="muted">{{ meme.uses }} 次 · {{ meme.width }}×{{ meme.height }} · {{ Math.round(meme.bytes / 1024) }}KB</td>
          <td>
            <div class="entry-actions">
              <button :data-meme-view="meme.id" @click="openMemeDetail(meme)">放大</button>
              <button class="danger" :data-meme-id="meme.id" @click="deleteMeme(meme)">刪除</button>
            </div>
          </td>
        </tr>
        <tr v-if="!memeRows.rows.length">
          <td colspan="5" class="muted">{{ pagedLists.meme.query && !memeRows.matched.length ? '沒有符合的項目。' : '還沒有梗圖。' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
  <Pager id="meme-pager" :page="memeRows.page" :pages="memeRows.pages" :total="memeRows.total" unit="張"
         @page="setPage('meme', $event)" />
</section>
</template>
