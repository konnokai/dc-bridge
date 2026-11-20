<script setup>
import { computed, ref } from 'vue';
import { api } from '../api.js';
import { data, refresh } from '../store.js';
import { fmtAgo, fmtWait } from '../format.js';

const sessionCount = computed(() => `（${data.status?.sessions ?? data.sessions.length}）`);
const followupCount = computed(() => (data.followups?.enabled === false
  ? '（已關閉：config.json 的 discord.followup.enabled）'
  : `（${data.followups?.items?.length ?? 0} 個）`));
const ignoredCount = computed(() => `（${(data.ignored ?? []).length} 人）`);

const pending = ref('');

async function resetSession(session, reload) {
  const key = session.key;
  if (reload) {
    if (!confirm('重載 ' + key + ' 的提示詞？\n會排進這個會話的佇列；前面的回合結束後產生總結，再清除會話。\n下一則訊息會用新的 system prompt，並帶上總結。')) return;
  } else if (!confirm('重置 ' + key + '？下一則訊息會開新上下文。')) return;
  pending.value = key;
  try {
    if (reload) await api('/api/sessions/reload-system-prompt', { method: 'POST', body: JSON.stringify({ key }) });
    else await api('/api/sessions/reset', { method: 'POST', body: JSON.stringify({ key }) });
    await refresh();
  } catch (error) {
    alert((reload ? '重載失敗：' : '重置失敗：') + error.message);
  } finally {
    pending.value = '';
  }
}

async function cancelFollowup(item) {
  if (!confirm('取消這個回訪？時間到就不會再提醒模型了。')) return;
  pending.value = item.id;
  try {
    await api('/api/followups/delete', { method: 'POST', body: JSON.stringify({ id: item.id }) });
  } catch (error) {
    // 404＝已經被取消、或列被重新整理換掉了；重新整理就好，不用嚇使用者。
    if (error.status !== 404) alert('取消失敗：' + error.message);
  }
  pending.value = '';
  await refresh();
}

async function releaseIgnore(user) {
  if (!confirm('解除 ' + (user.name || user.userId) + ' 的不理？他的訊息會重新進來。')) return;
  pending.value = user.userId;
  try {
    await api('/api/ignore/remove', { method: 'POST', body: JSON.stringify({ userId: user.userId }) });
    await refresh();
  } catch (error) {
    alert('解除失敗：' + error.message);
  } finally {
    pending.value = '';
  }
}
</script>

<template>
<section class="card">
  <h2>會話 <span id="session-count" class="muted">{{ sessionCount }}</span></h2>
  <div class="table-wrap">
    <table style="min-width:780px">
      <colgroup><col style="width:20%"><col style="width:14%"><col style="width:14%"><col style="width:10%"><col style="width:8%"><col style="width:8%"><col style="width:26%"></colgroup>
      <thead><tr><th>會話</th><th>Session</th><th>Preset</th><th>最後活動</th><th>安靜到</th><th>等待中</th><th></th></tr></thead>
      <tbody id="sessions">
        <tr v-for="session in data.sessions" :key="session.key">
          <td :title="session.key">{{ session.label || session.key }}</td>
          <td class="mono">{{ session.sessionId }}</td>
          <td class="mono">{{ session.preset || '未知' }}</td>
          <td>{{ fmtAgo(session.lastActive) }}</td>
          <td class="muted">{{ session.quietUntil ? new Date(session.quietUntil).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '—' }}</td>
          <td>{{ session.pending ? (session.pending === 'question' ? '提問' : '審批') : '—' }}</td>
          <td>
            <div class="row">
              <button class="ghost" :disabled="pending === session.key" @click="resetSession(session, true)">重載提示詞</button>
              <button class="danger" :disabled="pending === session.key" @click="resetSession(session, false)">重置</button>
            </div>
          </td>
        </tr>
        <tr v-if="!data.sessions.length"><td colspan="7" class="muted">還沒有任何會話</td></tr>
      </tbody>
    </table>
  </div>
</section>

<section class="card">
  <h2>回訪排程 <span id="followup-count" class="muted">{{ followupCount }}</span></h2>
  <p class="muted" style="margin:0 0 10px;font-size:12px">模型用 schedule_followup 排的「之後回來看」（2 分鐘～1 個月）。時間到會給它一個提示，要不要說話由它決定；重啟不會清掉，停機超過 30 分鐘的會丟掉。</p>
  <div class="table-wrap">
    <table style="min-width:640px">
      <colgroup><col style="width:20%"><col><col style="width:13%"><col style="width:19%"><col style="width:9%"></colgroup>
      <thead><tr><th>會話</th><th>內容</th><th>剩餘</th><th>到點</th><th></th></tr></thead>
      <tbody id="followup-rows">
        <tr v-for="item in data.followups?.items ?? []" :key="item.id">
          <td><strong>{{ item.where || item.key }}</strong></td>
          <td>{{ item.note || '—' }}</td>
          <td class="num">{{ item.remainingMinutes > 0 ? fmtWait(item.remainingMinutes) : '已到點' }}</td>
          <td class="muted">{{ item.at ? new Date(item.at).toLocaleString() : '—' }}</td>
          <td><button class="danger" :disabled="pending === item.id" @click="cancelFollowup(item)">取消</button></td>
        </tr>
        <tr v-if="!(data.followups?.items ?? []).length">
          <td colspan="5" class="muted">{{ data.followups?.enabled === false ? '回訪功能關著。' : '現在沒有排回訪。' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</section>

<section class="card">
  <h2>模型自己不理的人 <span id="ignored-count" class="muted">{{ ignoredCount }}</span></h2>
  <p class="muted" style="margin:0 0 10px;font-size:12px">模型用 ignore_user 設的暫時名單，時間到自動失效。跟管理員封鎖（deny.users）、本人 /blacklist（deny.self）分開；這裡的人連 @ 都不處理。</p>
  <div class="table-wrap">
    <table style="min-width:600px">
      <colgroup><col style="width:20%"><col style="width:34%"><col style="width:20%"><col style="width:14%"><col style="width:12%"></colgroup>
      <thead><tr><th>群友</th><th>原因</th><th>到什麼時候</th><th>記下</th><th></th></tr></thead>
      <tbody id="ignored-rows">
        <tr v-for="user in data.ignored ?? []" :key="user.userId">
          <td>
            <strong>{{ user.name || user.userId }}</strong>
            <div class="muted" style="font-size:11px">{{ user.userId }}</div>
          </td>
          <td class="muted">{{ user.reason || '—' }}</td>
          <td>{{ new Date(user.until).toLocaleString('zh-TW', { hour12: false }) }}</td>
          <td class="muted">{{ fmtAgo(user.at) }}</td>
          <td><button class="danger" :disabled="pending === user.userId" @click="releaseIgnore(user)">解除</button></td>
        </tr>
        <tr v-if="!(data.ignored ?? []).length"><td colspan="5" class="muted">目前沒有。</td></tr>
      </tbody>
    </table>
  </div>
</section>
</template>
