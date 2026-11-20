export const fmtUptime = (sec) => {
  if (!Number.isFinite(sec)) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return d + ' 天 ' + h + ' 小時';
  if (h) return h + ' 小時 ' + m + ' 分';
  return m + ' 分 ' + Math.floor(sec % 60) + ' 秒';
};

export const fmtAgo = (ts) => {
  if (!ts) return '—';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return sec + ' 秒前';
  if (sec < 3600) return Math.round(sec / 60) + ' 分前';
  if (sec < 86400) return Math.round(sec / 3600) + ' 小時前';
  return new Date(ts).toLocaleString();
};

// 回訪可以排到一個月，剩餘時間要換算，不然會看到「43200 分鐘」。
export const fmtWait = (minutes) => {
  if (minutes >= 1440) return `${Number((minutes / 1440).toFixed(1))} 天`;
  if (minutes >= 60) return `${Number((minutes / 60).toFixed(1))} 小時`;
  return `${minutes} 分鐘`;
};

export const lines = (value) => String(value ?? '').split('\n').map((s) => s.trim()).filter(Boolean);

export function parseMentionChannels(value) {
  const out = {};
  for (const raw of lines(value)) {
    const match = raw.match(/^(\d{5,25})\s*=\s*(true|false)$/i);
    if (!match) throw new Error(`requireMentionInChannel 這行看不懂：${raw}（要 頻道ID=true 或 false）`);
    out[match[1]] = match[2].toLowerCase() === 'true';
  }
  return out;
}

export const usageNum = (value) => {
  const n = Number(value) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 億';
  if (n >= 1e5) return Math.round(n / 1e4) + ' 萬';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 萬';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

export const usageMoney = (value, symbol) => {
  const sym = symbol || '$';
  const n = Number(value) || 0;
  if (n === 0) return sym + '0';
  if (n < 0.01) return sym + Number(n.toPrecision(3));
  return sym + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

export const usagePct = (value) => (Number.isFinite(Number(value)) ? (Number(value) * 100).toFixed(1) + '%' : '—');

export const pad2 = (n) => String(n).padStart(2, '0');

export const usageClock = (at, bucketMs) => {
  const d = new Date(at);
  if (bucketMs >= 3600_000) return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad2(d.getHours()) + ':00';
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
};

export function untilText(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return days + ' 天 ' + hours + ' 小時';
  if (hours > 0) return hours + ' 小時 ' + (minutes % 60) + ' 分';
  return minutes + ' 分';
}

export function quotaProviderLabel(provider) {
  if (provider === 'commandcode') return 'Command Code';
  if (provider === 'opencode-go') return 'OpenCode Go';
  return provider || '訂閱';
}

export function tradeMoney(cents) {
  const value = Number(cents);
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(Math.round(value));
  return `${sign}NT$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

export function tradePct(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${number >= 0 ? '+' : ''}${number.toFixed(2)}%`;
}

export function tradeAccountName(id, name = '') {
  if (name) return name;
  const text = String(id ?? '');
  if (text.startsWith('bot:')) return '🤖 Bot';
  // 橋接查不到名字時才退回 uid 末六碼；完整 id 在放大視窗看。
  return text.startsWith('user:') ? `玩家 …${text.slice(-6)}` : text;
}

export const archiveTime = (at) => {
  const time = Number(at);
  return Number.isFinite(time) && time > 0 ? new Date(time).toLocaleString('zh-TW', { hour12: false }) : '—';
};

export function fmtWhen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-TW', {
    hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export const splitCommaList = (value) => String(value ?? '').split(/[,，、]+/).map((item) => item.trim()).filter(Boolean);
