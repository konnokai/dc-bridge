<script setup>
import { ref } from 'vue';
import { auth, saveToken } from '../api.js';
import { markAuthed, verifyToken } from '../store.js';

const token = ref('');
const busy = ref(false);
const error = ref('');

async function submit() {
  const value = token.value.trim();
  if (!value) return;
  error.value = '';
  busy.value = true;
  saveToken(value);
  const ok = await verifyToken();
  busy.value = false;
  if (!ok) {
    error.value = auth.gateError || 'token 不正確';
    return;
  }
  markAuthed();
}
</script>

<template>
<div id="gate-panel" class="gate">
  <form id="gate-form" @submit.prevent="submit">
    <h1>dc-bridge 控制台</h1>
    <p class="muted" style="margin:0">貼上啟動日誌裡的 console token。</p>
    <input id="gate-token" v-model="token" type="password" autocomplete="off" placeholder="console token" required>
    <button type="submit" :disabled="busy">進入</button>
    <p id="gate-error" class="msg err" role="status">{{ error || auth.gateError }}</p>
  </form>
</div>
</template>
