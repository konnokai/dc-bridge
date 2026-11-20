<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { closeDetail, detail } from '../store.js';

const card = ref(null);
const closeButton = ref(null);
let pointerDown = null;

watch(() => detail.open, async (open) => {
  if (!open) return;
  await nextTick();
  if (detail.scrollToBottom && card.value) card.value.scrollTop = card.value.scrollHeight;
  closeButton.value?.focus();
});

function onBackdropDown(event) {
  pointerDown = event.target;
}
function onBackdropClick(event) {
  // 只在背景按下、也在背景放開時才關；卡片內拖選文字到背景放開不關。
  if (event.target === event.currentTarget && pointerDown === event.currentTarget) closeDetail();
  pointerDown = null;
}
function onKeydown(event) {
  if (event.key === 'Escape' && detail.open) closeDetail();
}
onMounted(() => document.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
<div id="detail-modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="detail-title"
     :hidden="!detail.open" @mousedown="onBackdropDown" @click="onBackdropClick">
  <div id="detail-card" ref="card" class="modal-card" :class="{ wide: detail.wide }" role="document">
    <div class="modal-head">
      <h2 id="detail-title">{{ detail.title }}</h2>
      <button id="detail-close" ref="closeButton" class="ghost" type="button" @click="closeDetail">關閉</button>
    </div>
    <div id="detail-meta" class="modal-meta" :hidden="detail.meta.length === 0">
      <div v-for="([label, value], index) in detail.meta" :key="index">
        <span class="muted">{{ label }}：</span>
        <a v-if="value && value.href" :href="value.href" target="_blank" rel="noreferrer">{{ value.text }}</a>
        <template v-else>{{ value }}</template>
      </div>
    </div>
    <img id="detail-image" class="detail-image" :alt="detail.title" :src="detail.imageUrl || undefined" :hidden="!detail.imageUrl">
    <div id="detail-body" class="modal-body" :class="{ mono: detail.mono }" :hidden="!detail.body">{{ detail.body }}</div>
  </div>
</div>
</template>
