<script setup>
defineProps({
  page: { type: Number, required: true },
  pages: { type: Number, required: true },
  total: { type: Number, default: 0 },
  unit: { type: String, default: '筆' },
});
defineEmits(['page']);
</script>

<template>
<div class="row pager">
  <template v-if="pages > 1">
    <button type="button" class="ghost" :disabled="page <= 1" @click="$emit('page', page - 1)">上一頁</button>
    <span class="muted">第 {{ page }} / {{ pages }} 頁（{{ total }} {{ unit }}）</span>
    <button type="button" class="ghost" :disabled="page >= pages" @click="$emit('page', page + 1)">下一頁</button>
  </template>
</div>
</template>
