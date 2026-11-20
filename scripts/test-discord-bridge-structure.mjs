// 結構檢查：抓「執行時才會炸、node --check 看不出來」的三類搬檔錯誤。
//
// 這三類都真的發生過：
//   A. 接線傳了入口的 let → 模組拿到快照，控制台改設定後不生效（emojiCatalogs）
//   B. 接線的名字在 factory 呼叫之後才宣告（const）→ 啟動就 ReferenceError（enqueuePrompt）
//   C. 模組用到別的 core 模組的函式但忘了 import → 只有走到那條分支才炸（formatQuietUntil 等）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'discord-bridge.js');
const CORE = path.join(ROOT, 'src', 'core');

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
};

const entry = fs.readFileSync(ENTRY, 'utf8').split(/\r?\n/);

// ── A/B：factory 接線（只看物件字面值第一層，4 個空白縮排的 `名字,`） ──
const factories = [];
entry.forEach((line, i) => {
  const m = /^  const \w+ = (create\w+)\(\{$/.exec(line);
  if (!m) return;
  let end = i + 1;
  while (end < entry.length && entry[end] !== '  });') end += 1;
  const names = [];
  for (let j = i + 1; j < end; j += 1) {
    const arg = /^    ([A-Za-z_$][\w$]*),$/.exec(entry[j]);
    if (arg) names.push(arg[1]);
  }
  factories.push({ name: m[1], line: i + 1, names });
});
ok(factories.length > 0, `找到 ${factories.length} 個 factory 接線區塊`);

// 名字在入口的宣告位置與種類：含 import、模組層級、主體層級與多行解構
const declarations = new Map();
const mainStart = entry.findIndex((line) => line.startsWith('async function main()'));
entry.forEach((line, i) => {
  if (i < mainStart) {
    for (const m of line.matchAll(/([A-Za-z_$][\w$]*)\s*(?:,|$)/g)) {
      const name = m[1];
      if (name && !declarations.has(name)) declarations.set(name, { line: i + 1, kind: 'import' });
    }
    const top = /^(?:const|let|var) ([A-Za-z_$][\w$]*) =/.exec(line);
    if (top) declarations.set(top[1], { line: i + 1, kind: line.startsWith('let') ? 'let' : 'const' });
    const topFn = /^(?:async )?function ([A-Za-z_$][\w$]*)/.exec(line);
    if (topFn) declarations.set(topFn[1], { line: i + 1, kind: 'function' });
    return;
  }
  const fn = /^  (?:async )?function (\w+)/.exec(line);
  if (fn) declarations.set(fn[1], { line: i + 1, kind: 'function' });
  const one = /^  (const|let|var) (\w+) =/.exec(line);
  if (one && !declarations.has(one[2])) declarations.set(one[2], { line: i + 1, kind: one[1] });
});
// 多行解構：const { a, b } = ...
entry.forEach((line, i) => {
  if (!/^  \} = /.test(line)) return;
  let start = i;
  while (start > 0 && !/^  (const|let|var) \{/.test(entry[start])) start -= 1;
  const kind = /^  (const|let|var) \{/.exec(entry[start])?.[1] ?? 'const';
  for (let j = start + 1; j < i; j += 1) {
    const raw = entry[j].trim().replace(/,$/, '');
    if (!raw || raw.includes(':') || !/^[A-Za-z_$][\w$]*$/.test(raw)) continue;
    if (!declarations.has(raw)) declarations.set(raw, { line: start + 1, kind });
  }
});

for (const factory of factories) {
  const mutable = [];
  const later = [];
  const unknown = [];
  for (const name of factory.names) {
    const decl = declarations.get(name);
    if (!decl) { unknown.push(name); continue; }
    if (decl.kind === 'let' || decl.kind === 'var') mutable.push(`${name}@${decl.line}`);
    if (decl.line > factory.line && decl.kind !== 'function') later.push(`${name}@${decl.line}`);
  }
  ok(mutable.length === 0,
    `${factory.name}：接線沒有用到入口的 let／var${mutable.length ? `（${mutable.join(', ')}）` : ''}`);
  ok(later.length === 0,
    `${factory.name}：接線的名字都在呼叫前宣告${later.length ? `（${later.join(', ')}）` : ''}`);
  // 找不到宣告的名字（多半在 import 或多行解構裡）不在這裡判，交給 B/C 兩項各自的掃描。
  if (unknown.length > 0) console.log(`   （${factory.name}：${unknown.length} 個名字在入口找不到宣告，略過）`);
}

// ── C：bridge 模組用到 core 的 export 就必須 import ──────────────────
const coreExports = new Map();
for (const file of fs.readdirSync(CORE).filter((name) => name.endsWith('.mjs'))) {
  const text = fs.readFileSync(path.join(CORE, file), 'utf8');
  for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    coreExports.set(m[1], file);
  }
}
ok(coreExports.size > 0, `core 模組共有 ${coreExports.size} 個 export`);

const bridgeModules = fs.readdirSync(CORE).filter((name) => /^discord-bridge-.+\.mjs$/.test(name)).sort();
ok(bridgeModules.length > 0, `找到 ${bridgeModules.length} 個 discord-bridge-*.mjs`);

for (const file of bridgeModules) {
  const text = fs.readFileSync(path.join(CORE, file), 'utf8');
  const declared = new Set();
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) declared.add(part.trim().split(/\s+as\s+/).pop().trim());
  }
  for (const m of text.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) declared.add(m[1]);
  for (const m of text.matchAll(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) declared.add(m[1]);
  for (const m of text.matchAll(/^\s*(?:const|let|var)\s*\{([^}]*)\}\s*=/gm)) {
    for (const part of m[1].split(',')) declared.add(part.trim().replace(/,$/, '').split(':')[0].trim());
  }

  const missing = [];
  for (const [name, from] of coreExports) {
    if (from === file || declared.has(name)) continue;
    // 只認「呼叫」：屬性名或區域變數剛好同名的不算
    if (!new RegExp(`\\b${name}\\s*\\(`).test(text)) continue;
    missing.push(`${name}（${from}）`);
  }
  ok(missing.length === 0, `${file}：用到的 core 函式都 import 了${missing.length ? `（漏 ${missing.join(', ')}）` : ''}`);
}

console.log(failures === 0 ? '\n✅ 結構檢查通過' : `\n❌ ${failures} 項失敗`);
process.exit(failures === 0 ? 0 : 1);
