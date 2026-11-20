<script setup>
import { computed, reactive, ref } from 'vue';
import { api } from '../api.js';
import { data, listView, openDetail, refresh } from '../store.js';
import { fmtWhen, splitCommaList } from '../format.js';
import EntryTable from '../components/EntryTable.vue';
import EntryActions from '../components/EntryActions.vue';

const KNOWLEDGE_LABEL = { candidate: '待確認', approved: '已確認', rejected: '已拒絕' };
const KNOWLEDGE_FILTERS = [['all', '全部'], ['candidate', '待確認'], ['approved', '已確認'], ['rejected', '已拒絕']];
const KNOWLEDGE_SCOPES = { global: '全域', guild: '同伺服器', channel: '只這個頻道' };

const busy = ref('');
const creating = ref(false);
const note = ref('');
const form = reactive({ link: '', title: '', keywords: '', tools: '', always: false, scope: 'guild', body: '' });

const entries = computed(() => data.knowledge?.entries ?? []);

const columns = [
  { key: 'title', label: '標題', width: '20%', title: (entry) => String(entry.body ?? '') },
  { key: 'triggers', label: '觸發', className: 'muted', width: '22%', title: (entry) => triggerLabel(entry) || '—' },
  { key: 'scope', label: '範圍', className: 'muted', width: '14%', title: (entry) => scopeText(entry) },
  { key: 'status', label: '狀態', className: 'nowrap', width: '64px', value: (entry) => KNOWLEDGE_LABEL[entry.status] ?? entry.status },
  { key: 'source', label: '來源', className: 'muted', width: '14%', title: (entry) => entry.byName || '' },
];

function triggerLabel(entry) {
  const triggers = entry.triggers ?? {};
  const parts = [];
  if (triggers.always) parts.push('每批');
  if (triggers.keywords?.length) parts.push('詞：' + triggers.keywords.join('、'));
  if (triggers.tools?.length) parts.push('工具：' + triggers.tools.join('、'));
  return parts.join('｜');
}

function where(entry) {
  if (entry.scope === 'channel') return `#${entry.channelName || entry.channelId}`;
  if (entry.scope === 'guild') return entry.guildName || entry.guildId;
  return '所有伺服器';
}

function scopeText(entry) {
  return `${KNOWLEDGE_SCOPES[entry.scope] ?? entry.scope}：${where(entry)}`;
}

function sourceLink(entry) {
  const source = (entry.sources ?? [])[0];
  if (!source) return null;
  return {
    href: `https://discord.com/channels/${entry.guildId}/${source.channelId}/${source.messageId}`,
    text: entry.byName || '原訊息',
  };
}

function showDetail(entry) {
  const meta = [
    ['狀態', KNOWLEDGE_LABEL[entry.status] ?? entry.status],
    ['範圍', scopeText(entry)],
    ['觸發', triggerLabel(entry) || '—'],
    ['來源', entry.byName || '—'],
    ['更新', fmtWhen(entry.updatedAt)],
  ];
  const source = (entry.sources ?? [])[0];
  if (source) {
    meta.push(['原訊息', { href: `https://discord.com/channels/${entry.guildId}/${source.channelId}/${source.messageId}`, text: '開啟' }]);
  }
  openDetail({ title: entry.title, meta, body: entry.body || '（沒有內容）' });
}

async function act(entry, action) {
  if (action === 'view') { showDetail(entry); return; }
  busy.value = entry.id;
  try {
    if (action === 'delete') {
      if (!confirm('刪除「' + entry.title + '」？')) return;
      await api('/api/knowledge/delete', { method: 'POST', body: JSON.stringify({ id: entry.id }) });
    } else if (action === 'edit') {
      const title = prompt('標題', entry.title);
      if (title === null) return;
      const keywords = prompt('關鍵字（逗號分開，可留空）', (entry.triggers?.keywords ?? []).join('，'));
      if (keywords === null) return;
      const tools = prompt('工具觸發（目前只有 generate_image，可留空）', (entry.triggers?.tools ?? []).join('，'));
      if (tools === null) return;
      const scope = prompt('範圍：global／guild／channel', entry.scope);
      if (scope === null) return;
      // 編輯不會動正文：要改長文就刪掉重貼一次，避免 prompt() 把換行壓成一條。
      await api('/api/knowledge/update', {
        method: 'POST',
        body: JSON.stringify({
          id: entry.id,
          title,
          keywords: splitCommaList(keywords),
          tools: splitCommaList(tools),
          scope: scope.trim(),
          // 原本是 always 的就維持，避免編輯一次就默默失去「每批都帶」。
          always: entry.triggers?.always === true,
        }),
      });
    } else {
      const payload = action === 'confirm' ? { id: entry.id, updatedAt: entry.updatedAt } : { id: entry.id };
      await api('/api/knowledge/' + action, { method: 'POST', body: JSON.stringify(payload) });
    }
    await refresh();
  } catch (error) {
    alert('操作失敗：' + error.message);
  } finally {
    busy.value = '';
  }
}

async function create() {
  const link = form.link.trim();
  if (!link) {
    note.value = '先貼一則訊息連結：建立時要用它決定伺服器和頻道。';
    return;
  }
  creating.value = true;
  note.value = '建立中…';
  try {
    const result = await api('/api/knowledge/create', {
      method: 'POST',
      body: JSON.stringify({
        link,
        title: form.title.trim(),
        body: form.body.trim(),
        keywords: splitCommaList(form.keywords),
        tools: splitCommaList(form.tools),
        always: form.always,
        scope: form.scope,
      }),
    });
    note.value = `已建立「${result.entry?.title ?? ''}」`;
    form.link = '';
    form.title = '';
    form.keywords = '';
    form.tools = '';
    form.body = '';
    form.always = false;
    await refresh();
  } catch (error) {
    note.value = '失敗：' + error.message;
  } finally {
    creating.value = false;
  }
}

function setQuery(event) {
  listView.knowledge.query = event.target.value;
  listView.knowledge.page = 1;
}
</script>

<template>
<EntryTable
  kind="knowledge"
  title="群知識"
  :entries="entries"
  :fields="(entry) => [
    entry.title,
    entry.body,
    (entry.triggers?.keywords ?? []).join(' '),
    (entry.triggers?.tools ?? []).join(' '),
    entry.byName,
    entry.guildName,
    entry.channelName,
  ]"
  :columns="columns"
  :filters="KNOWLEDGE_FILTERS"
  empty="還沒有群知識。群友請模型記下設定時會進候選；也可以直接貼訊息連結新增。"
  description="群友提供的設定、規則、世界觀。候選要確認後才會進 prompt：「每批」= 每次對話都帶（單條 300 字以內）、「關鍵字」= 這批訊息命中才帶、「工具」= 呼叫那個工具時由橋接帶（生圖目前是 generate_image）。"
>
  <template #toolbar>
    <input id="knowledge-search" type="search" aria-label="搜尋群知識" placeholder="搜尋標題、內容、觸發詞、來源" style="max-width:300px"
           :value="listView.knowledge.query" @input="setQuery">
  </template>
  <template #cell-title="{ e }">
    <div class="cell-title">
      <strong>{{ e.title }}</strong>
      <button class="link-button" data-action="view" @click="act(e, 'view')">放大</button>
    </div>
    <div class="muted cell-clamp">{{ e.body }}</div>
  </template>
  <template #cell-triggers="{ e }"><div class="cell-clamp">{{ triggerLabel(e) || '—' }}</div></template>
  <template #cell-scope="{ e }"><div class="cell-clamp">{{ scopeText(e) }}</div></template>
  <template #cell-source="{ e }">
    <div class="cell-clamp">
      <a v-if="sourceLink(e)" :href="sourceLink(e).href" target="_blank" rel="noreferrer">{{ sourceLink(e).text }}</a>
      <template v-else>{{ e.byName || '—' }}</template>
    </div>
  </template>
  <template #actions="{ e }"><EntryActions :entry="e" kind="knowledge" :busy="busy === e.id" @action="act(e, $event)" /></template>
</EntryTable>

<section class="card">
  <h2>新增（直接生效）</h2>
  <p class="muted" style="margin:0 0 10px;font-size:12px">貼一則 Discord 訊息連結就抓原文當內容；也可以自己填。建立後立刻生效，不用再按確認。</p>
  <div class="row" style="margin-bottom:8px">
    <input id="knowledge-link" v-model="form.link" type="url" placeholder="https://discord.com/channels/伺服器/頻道/訊息" style="flex:1;min-width:280px" aria-label="訊息連結">
    <select id="knowledge-scope" v-model="form.scope" aria-label="可見範圍">
      <option value="guild">同伺服器</option>
      <option value="channel">只這個頻道</option>
      <option value="global">所有伺服器</option>
    </select>
  </div>
  <div class="row" style="margin-bottom:8px">
    <input id="knowledge-title" v-model="form.title" maxlength="60" placeholder="標題（最多 60 字）" style="flex:1;min-width:240px" aria-label="標題">
  </div>
  <div class="row" style="margin-bottom:8px">
    <input id="knowledge-keywords" v-model="form.keywords" placeholder="關鍵字，逗號分開（最多 8 個）" style="flex:1;min-width:260px" aria-label="關鍵字">
    <input id="knowledge-tools" v-model="form.tools" placeholder="工具觸發（目前只有 generate_image）" style="flex:1;min-width:240px" aria-label="工具觸發">
    <label style="display:flex;align-items:center;gap:6px;white-space:nowrap"><input id="knowledge-always" v-model="form.always" type="checkbox" style="width:auto"> 每批都帶</label>
  </div>
  <textarea id="knowledge-body" v-model="form.body" rows="6" maxlength="2000" placeholder="內容（最多 2000 字）；貼了連結就留空用原文" style="margin-bottom:8px"></textarea>
  <div class="row">
    <button id="knowledge-create" :disabled="creating" @click="create">建立</button>
    <span id="knowledge-create-note" class="muted" style="font-size:12px">{{ note }}</span>
  </div>
</section>
</template>
