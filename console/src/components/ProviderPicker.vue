<script setup>
import { computed, watch } from 'vue';

const props = defineProps({
  side: { type: String, required: true },
  heading: { type: String, required: true },
  model: { type: Object, default: null },
  items: { type: Array, default: () => [] },
  filter: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  error: { type: String, default: '' },
});
const emit = defineEmits(['update:model', 'update:filter']);

const optionValue = (choice) => (choice ? JSON.stringify([choice.provider, choice.model]) : '');

const selectedValue = computed(() => optionValue(props.model));

const filtered = computed(() => {
  const query = props.filter.trim().toLowerCase();
  if (!query) return props.items;
  return props.items.filter((item) => `${item.provider} ${item.providerName} ${item.model} ${item.name} ${item.description}`.toLowerCase().includes(query));
});

const groups = computed(() => {
  const map = new Map();
  for (const item of filtered.value) {
    const rows = map.get(item.provider) ?? { id: item.provider, name: item.providerName, items: [] };
    rows.items.push({ value: optionValue(item), label: `${item.name}${item.description ? ` — ${item.description}` : ''}` });
    map.set(item.provider, rows);
  }
  return [...map.values()];
});

const found = computed(() => props.items.some((item) => item.provider === props.model?.provider && item.model === props.model?.model));
const shown = computed(() => props.items.find((item) => item.provider === props.model?.provider && item.model === props.model?.model));

const efforts = computed(() => shown.value?.efforts ?? []);
const effortValue = computed(() => {
  const current = props.model?.reasoningEffort ?? '';
  // '' 是「預設（不指定）」，清單裡一定有；不要把它換成 defaultEffort。
  if (current === '' || efforts.value.includes(current)) return current;
  const fallback = shown.value?.defaultEffort ?? '';
  return efforts.value.includes(fallback) ? fallback : '';
});
const chosenText = computed(() => {
  if (props.error) return props.error;
  if (!props.model) return '尚未選擇';
  return `已選：${props.model.provider} / ${props.model.model}${props.model.reasoningEffort ? ` / ${props.model.reasoningEffort}` : ''}`
    + (shown.value ? '' : ' ⚠️ 目錄裡找不到');
});

function pick(value) {
  if (!value) return;
  let provider;
  let model;
  try { [provider, model] = JSON.parse(value); } catch { return; }
  const item = props.items.find((entry) => entry.provider === provider && entry.model === model);
  // 新模型也支援原本的強度時留著，跟舊版一樣。
  const previous = props.model?.reasoningEffort ?? '';
  const effort = previous === '' || (item?.efforts ?? []).includes(previous)
    ? previous
    : (item?.defaultEffort && item.efforts.includes(item.defaultEffort) ? item.defaultEffort : '');
  emit('update:model', { provider, model, reasoningEffort: effort });
}
function pickEffort(value) {
  if (!props.model) return;
  emit('update:model', { ...props.model, reasoningEffort: value });
}

// 選單顯示什麼就送什麼：已存的值不在清單裡時，不能留著舊值去餵伺服器。
// 目錄整個讀不到時（items 空）不要動，不然會把設定裡的值洗掉。
watch([() => props.model, efforts], () => {
  if (!props.model || !props.items.length) return;
  const wanted = effortValue.value;
  if ((props.model.reasoningEffort ?? '') !== wanted) emit('update:model', { ...props.model, reasoningEffort: wanted });
}, { immediate: true });
</script>

<template>
<div class="provider-picker" style="grid-column:1/-1">
  <div class="provider-picker-head">{{ heading }}</div>
  <input :id="'provider-' + side + '-filter'" placeholder="輸入關鍵字篩選模型" autocomplete="off" :disabled="disabled"
         :value="filter" @input="$emit('update:filter', $event.target.value)">
  <select :id="'provider-' + side + '-select'" size="8" :aria-label="heading" :disabled="disabled" :value="selectedValue" @change="pick($event.target.value)">
    <option v-if="model && !found" :value="selectedValue">⚠️ 目前設定（目錄裡找不到）：{{ model.provider }} / {{ model.model }}</option>
    <optgroup v-for="group in groups" :key="group.id" :label="group.name">
      <option v-for="option in group.items" :key="option.value" :value="option.value">{{ option.label }}</option>
    </optgroup>
  </select>
  <label>思考強度
    <select :id="'provider-' + side + '-effort'" :aria-label="heading + '思考強度'" :disabled="disabled || efforts.length === 0"
            :value="effortValue" @change="pickEffort($event.target.value)">
      <option value="">預設（不指定）</option>
      <option v-for="effort in efforts" :key="effort" :value="effort">{{ effort }}</option>
    </select>
  </label>
  <div :id="'provider-' + side + '-chosen'" class="muted">{{ chosenText }}</div>
</div>
</template>
