<script setup>
import { onMounted, onUpdated, ref } from 'vue';
import { data, openDetail } from '../store.js';

const box = ref(null);
const stick = ref(true);

function onScroll() {
  const el = box.value;
  if (!el) return;
  stick.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
}
function expand() {
  openDetail({ title: '日誌', body: data.logs.map((l) => l.text).join('\n'), mono: true, wide: true, scrollToBottom: true });
}
onMounted(() => { stick.value = true; });
onUpdated(() => {
  if (stick.value && box.value) box.value.scrollTop = box.value.scrollHeight;
});
</script>

<template>
<section class="card">
  <h2>日誌 <button id="logs-expand" class="ghost" type="button" style="font-size:12px;padding:2px 8px;margin-left:8px" @click="expand">放大</button></h2>
  <pre id="logs" ref="box" @scroll="onScroll">{{ data.logs.map((l) => l.text).join('\n') }}</pre>
</section>
</template>
