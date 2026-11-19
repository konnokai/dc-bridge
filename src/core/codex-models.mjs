// Codex 的模型清單（$CODEX_HOME/models_cache.json）由 Codex 自己更新。
// Luna 的版本號會往上加（6 → 6.2 …），寫死 `gpt-6-luna` 之後會過時，所以從清單挑版本號最大的。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LUNA_SLUG = /^gpt-(\d+(?:\.\d+)*)-luna$/;

function compareVersion(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/** 目前帳號能用的最新 Luna；讀不到清單就退回已知可用的 gpt-6-luna。 */
export function latestLunaModel({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } = {}) {
  const file = path.join(codexHome, 'models_cache.json');
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    let best = null;
    for (const model of Array.isArray(doc?.models) ? doc.models : []) {
      const slug = String(model?.slug ?? '');
      const version = LUNA_SLUG.exec(slug)?.[1];
      // 只收 picker 看得到的模型；hide／none 可能是內部用或還沒開放。
      if (!version || (model?.visibility ?? 'list') !== 'list') continue;
      if (!best || compareVersion(version, best.version) > 0) best = { slug, version };
    }
    if (best) return best.slug;
    console.error(`[codex-models] 模型清單沒有可用的 Luna（${file}）；先用 gpt-6-luna`);
  } catch (error) {
    console.error(`[codex-models] 讀不到模型清單（${file}）：${error?.message ?? error}；先用 gpt-6-luna`);
  }
  return 'gpt-6-luna';
}
