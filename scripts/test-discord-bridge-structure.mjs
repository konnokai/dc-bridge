// 結構檢查：抓「執行時才會炸、node --check 看不出來」的搬檔錯誤。
//
// 這些都真的發生過：
//   A. 接線傳了入口的 let → 模組拿到快照，控制台改設定後不生效（emojiCatalogs）
//   B. 接線的名字在 factory 呼叫之後才宣告（const）→ 啟動就 ReferenceError（enqueuePrompt）
//   C. 模組用到別的 core 模組的函式但忘了 import → 只有走到那條分支才炸（formatQuietUntil 等）
//   D. 模組引用了沒 import 也沒接 deps 的名字（fs、path、sentImageOwners、SLANG_STATUS_TEXT）
//      → node:fs／node:path 這種不是 core export，C 項掃不到，要用範圍分析才抓得到
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import * as eslintScope from 'eslint-scope';
import * as espree from 'espree';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'discord-bridge.js');
const CORE = path.join(ROOT, 'src', 'core');

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
};

const entry = fs.readFileSync(ENTRY, 'utf8').split(/\r?\n/);
const entryFull = fs.readFileSync(ENTRY, 'utf8');

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
    if (arg) { names.push(arg[1]); continue; }
    // `key: value,` 形式的接線：檢查的是 value 那個名字
    const keyed = /^    [A-Za-z_$][\w$]*: ([A-Za-z_$][\w$]*),$/.exec(entry[j]);
    if (keyed) names.push(keyed[1]);
  }
  factories.push({ name: m[1], line: i + 1, names });
});
ok(factories.length > 0, `找到 ${factories.length} 個 factory 接線區塊`);

// 名字在入口的宣告位置與種類：含 import、模組層級、主體層級與解構（單行與多行）
const declarations = new Map();
const mainStart = entry.findIndex((line) => line.startsWith('async function main()'));
entry.forEach((line, i) => {
  if (i < mainStart) {
    // import 行先剝掉 `} from '...'` 再掃名字，不然尾端名字（unwrap }）會漏掉
    const importLine = /^\s*import\s/.test(line) ? line.replace(/\}\s*from\s+.*/, '') : line;
    for (const m of importLine.matchAll(/([A-Za-z_$][\w$]*)\s*(?:,|$)/g)) {
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
  // 單行解構：const { a, b } = ...（一行擠多個名字也一樣切開登記）
  const inline = /^  (const|let|var) \{(.*)\}\s*=/.exec(line);
  if (inline) {
    for (const part of inline[2].split(',')) {
      const name = part.trim().split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name) && !declarations.has(name)) {
        declarations.set(name, { line: i + 1, kind: inline[1] });
      }
    }
  }
});
// 多行解構：const { a, b\n  c } = ...
entry.forEach((line, i) => {
  if (!/^  \} = /.test(line)) return;
  let start = i;
  while (start > 0 && !/^  (const|let|var) \{/.test(entry[start])) start -= 1;
  const kind = /^  (const|let|var) \{/.exec(entry[start])?.[1] ?? 'const';
  for (let j = start + 1; j < i; j += 1) {
    for (const part of entry[j].split(',')) {
      const name = part.trim().replace(/,$/, '').split(':')[0].trim();
      if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      if (!declarations.has(name)) declarations.set(name, { line: start + 1, kind });
    }
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
  // 宣告掃描涵蓋 import、單行／多行解構與一般宣告；還找不到就是真的沒宣告，直接紅
  ok(unknown.length === 0,
    `${factory.name}：接線的名字都在入口找得到宣告${unknown.length ? `（沒有：${unknown.join(', ')}）` : ''}`);
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

// ── D：範圍分析——模組裡引用了沒 import、沒接 deps、也沒宣告的名字 ──────
// 函式體內的引用也算（那些是延遲執行）；node:fs／node:path 與非 core 的
// import（discord.js、twitter-post 等）C 項掃不到，只有這項會抓。
const GLOBALS = new Set([
  // JS 內建與 node 全域（粗清單，夠用就好；新的內建加在這裡）
  'console', 'process', 'Buffer', 'globalThis', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'queueMicrotask', 'fetch', 'structuredClone', 'URL', 'URLSearchParams',
  'TextDecoder', 'TextEncoder', 'AbortController', 'AbortSignal', 'performance',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date', 'Map', 'Set',
  'Promise', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'RegExp', 'Symbol', 'BigInt',
  'WeakMap', 'WeakSet', 'Intl', 'Reflect', 'Proxy', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'NaN', 'Infinity', 'undefined', 'null', 'true', 'false', 'this', 'arguments', 'require',
  'module', 'exports', 'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent',
]);
for (const file of bridgeModules) {
  const text = fs.readFileSync(path.join(CORE, file), 'utf8');
  const ast = espree.parse(text, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });
  const scopeManager = eslintScope.analyze(ast, { sourceType: 'module', ecmaVersion: 2024 });
  const unresolved = new Map(); // name -> [line, ...]
  for (const ref of scopeManager.globalScope.through) {
    const name = ref.identifier.name;
    if (GLOBALS.has(name)) continue;
    const line = ref.identifier.loc.start.line;
    if (!unresolved.has(name)) unresolved.set(name, []);
    unresolved.get(name).push(line);
  }
  const list = [...unresolved.entries()].map(([name, lines]) => `${name}@${lines.slice(0, 3).join(',')}`);
  ok(unresolved.size === 0, `${file}：引用的名字都有 import／deps／宣告${list.length ? `（漏 ${list.join(', ')}）` : ''}`);
}

// ── E：入口 import 沒有死 binding ─────────────────────────────────
// 每拆一塊就會多一批沒人用的 import；留著只會讓下一個人不確定能不能刪。
{
  const ast = espree.parse(entryFull, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });
  const sm = eslintScope.analyze(ast, { ecmaVersion: 2024, sourceType: 'module' });
  const unused = [];
  for (const scope of [sm.globalScope, ...sm.globalScope.childScopes]) {
    for (const variable of scope.variables) {
      const def = variable.defs[0];
      if (!def || def.type !== 'ImportBinding') continue;
      if (variable.references.length === 0) unused.push(`${variable.name}@${def.node.loc.start.line}`);
    }
  }
  ok(unused.length === 0, `discord-bridge.js：沒有未使用的 import${unused.length ? `（${unused.join(', ')}）` : ''}`);
}

console.log(failures === 0 ? '\n✅ 結構檢查通過' : `\n❌ ${failures} 項失敗`);
process.exit(failures === 0 ? 0 : 1);
