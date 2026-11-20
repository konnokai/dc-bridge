<script setup>
import { reactive, ref } from 'vue';
import { api, copyText } from '../api.js';
import { data, refresh } from '../store.js';
import { fmtAgo } from '../format.js';

const copied = reactive({});
const pending = ref('');

function feedbackPrompt(item) {
  const at = Date.parse(item.at);
  const links = (item.messageIds ?? []).map((id, index) => (
    `- 訊息 ${index + 1}: https://discord.com/channels/${item.guildId || '@me'}/${item.channelId}/${id}`
  )).join('\n');
  const triggers = (item.users ?? []).map((user) => user.name || user.userId).filter(Boolean).join('、');
  const lines = [
    '請處理這筆 Discord bot 的開發回饋。',
    '',
    `回饋 ID：${item.id}`,
    `來源：${item.label || item.key}`,
    `時間：${Number.isFinite(at) ? new Date(at).toLocaleString('zh-TW', { hour12: false }) : item.at}`,
    `Session：${item.sessionId || '—'}`,
  ];
  if (triggers) lines.push(`觸發者：${triggers}`);
  if (links) lines.push('', '觸發訊息：', links);
  lines.push(
    '',
    '【模型遇到的問題】',
    item.reason || '—',
    '',
    '【模型要求的能力／修正】',
    item.need || '—',
    '',
    '【驗收標準】',
    item.expected || '—',
    '',
    '請先讀 AGENTS.md 與相關程式碼，確認回饋是否仍然成立；如果已經修過，說明證據並跳過。',
    '照專案規範直接實作、補測試、跑測試，不要只回建議。完成後回報改了哪些檔案、跑了哪些檢查、結果如何。',
  );
  return lines.join('\n');
}

function messageLinks(item) {
  return (item.messageIds ?? []).map((id, index) => ({
    href: `https://discord.com/channels/${item.guildId || '@me'}/${item.channelId}/${id}`,
    label: `訊息 ${index + 1}`,
  }));
}

function triggersOf(item) {
  return (item.users ?? []).map((user) => user.name || user.userId).filter(Boolean);
}

async function copyPrompt(item) {
  const ok = await copyText(feedbackPrompt(item));
  if (!ok) {
    alert('複製失敗，請手動選取回饋內容。');
    return;
  }
  copied[item.id] = true;
  setTimeout(() => { copied[item.id] = false; }, 1200);
}

async function remove(item) {
  if (!confirm('刪掉這筆回饋？')) return;
  pending.value = item.id;
  try {
    await api('/api/dev-feedback/delete', { method: 'POST', body: JSON.stringify({ id: item.id }) });
    await refresh();
  } catch (error) {
    alert('刪除失敗：' + error.message);
    await refresh();
  } finally {
    pending.value = '';
  }
}
</script>

<template>
<section class="card">
  <h2>功能申請與意見回饋 <span id="dev-feedback-count" class="muted">（{{ data.devFeedback?.items?.length ?? 0 }} 筆）</span></h2>
  <p class="muted" style="margin:0 0 10px;font-size:12px">模型用 submit_feedback 送出的意見，只存在本機 state/discord-dev-feedback.json，不會出現在頻道。時間下面的連結會開到觸發那一輪的訊息；session 是當時的 DSH 會話。</p>
  <div class="table-wrap">
    <table style="min-width:960px">
      <colgroup><col style="width:13%"><col style="width:18%"><col><col><col><col style="width:220px"></colgroup>
      <thead><tr><th>時間</th><th>頻道</th><th>原因</th><th>需求</th><th>預期結果</th><th></th></tr></thead>
      <tbody id="dev-feedback-rows">
        <tr v-for="item in data.devFeedback?.items ?? []" :key="item.id">
          <td>
            <div>{{ Number.isFinite(Date.parse(item.at)) ? new Date(item.at).toLocaleString('zh-TW', { hour12: false }) : item.at }}</div>
            <div class="muted" style="font-size:11px">{{ fmtAgo(Date.parse(item.at)) }}</div>
            <div v-if="item.updatedAt" class="muted" style="font-size:11px">
              已編輯 {{ fmtAgo(Date.parse(item.updatedAt)) }}{{ item.updatedBy && item.updatedBy !== item.key ? `（由 ${item.updatedByLabel || item.updatedBy}）` : '' }}
            </div>
            <div v-if="messageLinks(item).length" class="row" style="gap:6px;font-size:11px">
              <a v-for="link in messageLinks(item)" :key="link.href" :href="link.href" target="_blank" rel="noopener">{{ link.label }}</a>
            </div>
          </td>
          <td>
            <strong>{{ item.label || item.key }}</strong>
            <div class="muted" style="font-size:11px">{{ triggersOf(item).length ? `觸發：${triggersOf(item).join('、')}` : '觸發：自動參與' }}</div>
            <div class="muted mono" style="font-size:11px">{{ item.sessionId || '—' }}</div>
          </td>
          <td style="white-space:pre-wrap">{{ item.reason }}</td>
          <td style="white-space:pre-wrap">{{ item.need }}</td>
          <td style="white-space:pre-wrap">{{ item.expected }}</td>
          <td>
            <div class="row" style="gap:6px;flex-wrap:nowrap">
              <button :data-dev-feedback-copy="item.id" :disabled="pending === item.id" @click="copyPrompt(item)">{{ copied[item.id] ? '已複製' : '複製 prompt' }}</button>
              <button class="danger" :data-dev-feedback-id="item.id" :disabled="pending === item.id" @click="remove(item)">刪除</button>
            </div>
          </td>
        </tr>
        <tr v-if="!(data.devFeedback?.items ?? []).length"><td colspan="6" class="muted">還沒有人送過回饋。</td></tr>
      </tbody>
    </table>
  </div>
</section>
</template>
