<script setup>
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import { auth, clearToken, showGate, takeTokenFromQuery } from './api.js';
import {
  archiveState, closeDetail, data, loadArchive, loadArchiveChannels, loadConfig, markAuthed, refresh, refreshDevFeedback,
  refreshKnowledge, refreshTriggers, ui, verifyToken,
} from './store.js';
import { fmtUptime } from './format.js';
import Gate from './components/Gate.vue';
import DetailModal from './components/DetailModal.vue';
import OverviewTab from './tabs/OverviewTab.vue';
import UsageTab from './tabs/UsageTab.vue';
import SlangTab from './tabs/SlangTab.vue';
import KnowledgeTab from './tabs/KnowledgeTab.vue';
import TriggersTab from './tabs/TriggersTab.vue';
import MemoryTab from './tabs/MemoryTab.vue';
import SessionsTab from './tabs/SessionsTab.vue';
import DevFeedbackTab from './tabs/DevFeedbackTab.vue';
import TradeTab from './tabs/TradeTab.vue';
import SettingsTab from './tabs/SettingsTab.vue';
import LogsTab from './tabs/LogsTab.vue';

const TABS = [
  { key: 'overview', label: '總覽', component: OverviewTab },
  { key: 'usage', label: '花費', component: UsageTab },
  { key: 'slang', label: '黑話', component: SlangTab },
  { key: 'knowledge', label: '知識', component: KnowledgeTab },
  { key: 'triggers', label: '對話', component: TriggersTab },
  { key: 'memory', label: '記憶', component: MemoryTab },
  { key: 'sessions', label: '會話', component: SessionsTab },
  { key: 'dev-feedback', label: '回饋', component: DevFeedbackTab },
  { key: 'trade', label: '股盤', component: TradeTab },
  { key: 'settings', label: '設定', component: SettingsTab },
  { key: 'logs', label: '日誌', component: LogsTab },
];

const current = computed(() => TABS.find((tab) => tab.key === ui.tab) ?? TABS[0]);
const pills = computed(() => {
  const s = data.status;
  if (!s) return [];
  return [
    { text: s.bot ? s.bot.tag : 'Discord 未登入', tone: s.bot ? 'ok' : 'bad' },
    { text: 'DSH ' + (s.dsh.lastFrameAt ? '串流中' : '等待事件'), tone: s.dsh.lastFrameAt ? 'ok' : '' },
    { text: s.dsh.preset + ' / ' + s.dsh.model, tone: '' },
    { text: '上線 ' + fmtUptime(s.uptimeSec), tone: '' },
  ];
});

let timer = null;

function startTimer() {
  if (timer) return;
  timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
}
function stopTimer() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

function selectTab(key, { focus = false } = {}) {
  if (!TABS.some((tab) => tab.key === key)) key = TABS[0].key;
  ui.tab = key;
  closeDetail();
  if (focus) document.getElementById('tabbtn-' + key)?.focus();
}

function onTabClick(event) {
  const button = event.target.closest('[role="tab"]');
  if (button) selectTab(button.dataset.tab);
}

function onTabKeydown(event) {
  const index = TABS.findIndex((tab) => tab.key === document.activeElement?.dataset?.tab);
  if (index < 0) return;
  const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: TABS.length - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  selectTab(TABS[(next + TABS.length) % TABS.length].key, { focus: true });
}

function logout() {
  clearToken();
  stopTimer();
  showGate('');
}

async function manualRefresh() {
  await refresh();
}

async function bootstrap() {
  takeTokenFromQuery();
  ui.tab = TABS.some((tab) => '#' + tab.key === location.hash) ? location.hash.slice(1) : TABS[0].key;
  if (!auth.token) { showGate(''); return; }
  if (!(await verifyToken())) return;
  markAuthed();
}

watch(() => ui.tab, (key) => {
  if (location.hash !== '#' + key) history.replaceState(null, '', '#' + key);
  closeDetail();
  // 還沒登入時不要抓資料：深連結會先設分頁再驗 token，401 會汙染歸檔表。
  if (!auth.authed) return;
  if (key === 'triggers') void refreshTriggers();
  if (key === 'dev-feedback') void refreshDevFeedback();
  if (key === 'knowledge') void refreshKnowledge();
  if (key === 'memory' && !archiveState.loaded) {
    archiveState.loaded = true;
    void loadArchiveChannels().then(() => loadArchive(null));
  }
});

watch(() => auth.authed, async (on) => {
  if (!on) {
    stopTimer();
    // 下次登入要重新抓歸檔；舊的 loaded 會讓它在 401 之後永遠不再重試。
    archiveState.loaded = false;
    return;
  }
  startTimer();
  await Promise.allSettled([auth.configLoaded ? Promise.resolve() : loadConfig(), refresh()]);
}, { immediate: true });

function onHashChange() {
  selectTab(location.hash.slice(1));
}

onMounted(() => {
  void bootstrap();
  window.addEventListener('hashchange', onHashChange);
});
onBeforeUnmount(() => {
  stopTimer();
  window.removeEventListener('hashchange', onHashChange);
});
</script>

<template>
<Gate v-if="!auth.authed" />
<template v-else>
  <main id="console-app">
    <header>
      <h1>大肥魚 console</h1>
      <div id="pills" class="pills">
        <span v-for="(pill, index) in pills" :key="index" class="pill" :class="pill.tone">{{ pill.text }}</span>
      </div>
      <div class="actions">
        <button id="refresh" class="ghost" @click="manualRefresh">重新整理</button>
        <button id="logout" class="ghost" @click="logout">登出</button>
      </div>
    </header>

    <nav id="tabs" class="tabs" role="tablist" aria-label="控制台分頁" @click="onTabClick" @keydown="onTabKeydown">
      <button v-for="tab in TABS" :key="tab.key" :id="'tabbtn-' + tab.key" role="tab" type="button"
              :aria-controls="'tab-' + tab.key" :data-tab="tab.key"
              :aria-selected="ui.tab === tab.key" :tabindex="ui.tab === tab.key ? 0 : -1">{{ tab.label }}</button>
    </nav>

    <template v-for="tab in TABS" :key="tab.key">
      <div :id="'tab-' + tab.key" class="tab-panel" role="tabpanel" :aria-labelledby="'tabbtn-' + tab.key" :hidden="ui.tab !== tab.key">
        <component :is="tab.component" />
      </div>
    </template>
  </main>
  <DetailModal />
</template>
</template>
