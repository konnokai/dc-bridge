// 釘住 DSH 0.1.7 preset 裝配的「防漂移」契約（純離線，不需要 DSH 在跑）：
//   1. bundle patch 與倉庫權威源逐字一致；
//   2. patch 形狀符合新機制：insert 一條 @deepseek-ai/dsh-agent-preset 行，
//      config 帶 id/name/description/order/plugins；
//   3. 守衛行只能用「從 profile 目錄可解析」的裸說明符；
//   4. dc-tool-restrict 的 fail-closed 白名單仍然有效。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import {
  BUNDLE_DIR, DISCORD_PRESETS, REPO_ROOT, buildPatches, patchFileFor, presetRowId,
} from './build-agent-preset-patches.mjs';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
}

const read = (p) => fs.readFileSync(p, 'utf8');
const load = (p) => yaml.load(read(p));

console.log('## 1. 產物與源不漂移（--check 語義）');
{
  const results = buildPatches({ check: true, log: () => {} });
  for (const { file, changed } of results) {
    ok(!changed, `${path.relative(REPO_ROOT, file)} 與源一致（不一致請跑 node scripts/build-agent-preset-patches.mjs）`);
  }
}

console.log('## 2. patch 形狀符合 DSH 0.1.7 的 preset 機制');
for (const name of DISCORD_PRESETS) {
  const file = patchFileFor(name);
  ok(fs.existsSync(file), `${path.relative(REPO_ROOT, file)} 存在`);
  const doc = load(file);
  ok(Array.isArray(doc) && doc.length === 1 && Array.isArray(doc[0]?.insert), `${name}: 頂層是 [ { insert: [...] } ]`);
  const row = doc[0].insert[0];
  ok(row.id === presetRowId(name), `${name}: 行 id = ${presetRowId(name)}`);
  ok(row.name === '@deepseek-ai/dsh-agent-preset', `${name}: 行 name = @deepseek-ai/dsh-agent-preset`);
  ok(row.config?.id === name, `${name}: config.id = ${name}`);
  const meta = load(path.join(REPO_ROOT, 'dsh', 'agent-presets', name, 'preset.yml'));
  ok(row.config.name === meta.name && row.config.description === meta.description && row.config.order === meta.order,
    `${name}: preset.yml 的 name/description/order 原樣帶進 config`);
  ok(Array.isArray(row.config.plugins) && row.config.plugins.length > 0, `${name}: config.plugins 非空`);
  const guard = row.config.plugins.find((r) => r.id === 'dc-tool-restrict');
  ok(guard?.name === 'dc-agent-presets/dc-tool-restrict.mjs', `${name}: 守衛行存在且引用正確`);
  const badNames = row.config.plugins.filter((r) => typeof r.name === 'string'
    && (r.name.startsWith('.') || path.isAbsolute(r.name)));
  ok(badNames.length === 0, `${name}: 沒有相對／絕對路徑子行名${badNames.length ? `（${badNames.map((r) => r.name).join(', ')}）` : ''}`);

  const source = load(path.join(REPO_ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml'));
  const expected = structuredClone(source);
  for (const r of expected) {
    if (r.name === './dc-tool-restrict.mjs') r.name = 'dc-agent-presets/dc-tool-restrict.mjs';
    else if (r.name === './dc-session-token.mjs') r.name = 'dc-agent-presets/dc-session-token.mjs';
    else if (r.name === './dc-draw-image.mjs') r.name = 'dc-agent-presets/dc-draw-image.mjs';
  }
  assert.deepEqual(row.config.plugins, expected,
    `${name}: config.plugins 必須與 agent.cordis.yml 完全一致（相對插件名除外）`);
  ok(true, `${name}: config.plugins 與 agent.cordis.yml 逐字一致（${expected.length} 行）`);

  const srcPersona = source.find((r) => r.id === 'persona');
  const patchPersona = row.config.plugins.find((r) => r.id === 'persona');
  ok(typeof srcPersona?.config?.prefix === 'string' && srcPersona.config.prefix === patchPersona?.config?.prefix,
    `${name}: persona.prefix 逐字一致（${srcPersona?.config?.prefix?.length ?? 0} 字符）`);
}

console.log('## 3. bundle 宣告');
{
  const pkg = JSON.parse(read(path.join(BUNDLE_DIR, 'package.json')));
  const patches = pkg.dsh?.bundle?.patch;
  ok(Array.isArray(patches), 'dc-agent-presets 的 dsh.bundle.patch 是陣列');
  for (const name of DISCORD_PRESETS) {
    const declared = `./presets/${name}.patch.yml`;
    ok(patches?.includes(declared), `bundle 列出了 ${declared}`);
    ok(fs.existsSync(path.join(BUNDLE_DIR, declared)), `${declared} 存在`);
  }
}

console.log('## 4. 守衛 fail-closed');
{
  const guardPath = path.join(BUNDLE_DIR, 'dc-tool-restrict.mjs');
  const mod = await import(pathToFileURL(guardPath).href);
  ok(mod.name === 'dc-tool-restrict', '守衛導出 name');
  ok(Array.isArray(mod.inject) && mod.inject.includes('tools'), '守衛 inject tools');
  let guardFn;
  const restricted = [];
  mod.apply({
    tools: {
      restrict: ({ deny }) => restricted.push(...deny),
      guard: (fn) => { guardFn = fn; },
    },
  });
  ok(restricted.includes('pwsh') && restricted.includes('read') && restricted.includes('dev_install_package'),
    'restrict 名單含本地執行面與開發注入器工具');
  for (const name of ['ask_user_question', 'todo_write', 'mcp__web-search-safe__web_fetch']) {
    assert.equal(guardFn({ name }), undefined, `白名單應放行 ${name}`);
  }
  for (const name of ['bash', 'read', 'write', 'dev_future_unknown_tool', 'mcp__other__x', '', null, undefined, 123]) {
    ok(typeof guardFn({ name }) === 'string', `拒絕 ${JSON.stringify(name)}`);
  }
}

console.log(failures === 0 ? '\n✅ agent preset patch 契約通過' : `\n❌ ${failures} 項失敗`);
process.exit(failures === 0 ? 0 : 1);
