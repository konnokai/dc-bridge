import { reactive } from 'vue';

const KEY = 'dc-console-token';

export const auth = reactive({
  token: localStorage.getItem(KEY) || '',
  authed: false,
  gateError: '',
  configLoaded: false,
});

export function saveToken(value) {
  auth.token = value;
  localStorage.setItem(KEY, value);
}

export function clearToken() {
  auth.token = '';
  localStorage.removeItem(KEY);
}

// 支援 ?token=... 直接開：記進 localStorage 後把網址清乾淨，token 不會留在歷史紀錄。
export function takeTokenFromQuery() {
  const fromQuery = new URLSearchParams(location.search).get('token');
  if (!fromQuery) return;
  saveToken(fromQuery);
  history.replaceState(null, '', location.pathname + location.hash);
}

export function showGate(message = '') {
  auth.authed = false;
  auth.gateError = message;
}

export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}), authorization: 'Bearer ' + auth.token };
  if (options.body) headers['content-type'] = 'application/json';
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    showGate('token 不正確或已失效');
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || ('HTTP ' + res.status));
    error.status = res.status; // 讓呼叫端分辨「已經不在了」跟真正的失敗
    throw error;
  }
  return data;
}

// 控制台常跑在 http://（非 secure context），clipboard API 可能不存在；退回 execCommand。
export async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 改用下面的 textarea */ }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { copied = false; }
  area.remove();
  return copied;
}
