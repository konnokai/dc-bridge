<script setup>
const props = defineProps({
  entry: { type: Object, required: true },
  kind: { type: String, default: 'slang' },
  busy: { type: Boolean, default: false },
});
defineEmits(['action']);
</script>

<template>
<div class="entry-actions">
  <button v-if="entry.status === 'candidate'" data-action="confirm" :disabled="busy" @click="$emit('action', 'confirm')">確認</button>
  <button v-else-if="entry.status === 'rejected' && kind !== 'knowledge'" data-action="confirm" :disabled="busy" @click="$emit('action', 'confirm')">復原</button>
  <span v-else class="action-slot"></span>
  <button v-if="entry.status !== 'rejected'" class="ghost" data-action="reject" :disabled="busy" @click="$emit('action', 'reject')">拒絕</button>
  <span v-else class="action-slot"></span>
  <button class="ghost" data-action="edit" :disabled="busy" @click="$emit('action', 'edit')">編輯</button>
  <button class="danger" data-action="delete" :disabled="busy" @click="$emit('action', 'delete')">刪除</button>
</div>
</template>
