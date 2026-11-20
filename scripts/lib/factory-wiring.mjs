// 結構檢查 G 項的共用實作：factory 呼叫的 deps 有沒有漏接。
//
// 只看「第一個參數是物件字面值」的呼叫；`createXxx(deps)` 或 `{ ...spread }` 無法
// 靜態核對，直接跳過（spread 可能補齊 key，報錯只會誤導）。
export function factoryCalls(ast) {
  const calls = [];
  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (callee?.type !== 'Identifier' || !/^create[A-Z]/.test(callee.name)) return;
    const arg = node.arguments[0];
    if (arg?.type !== 'ObjectExpression') return;
    let spread = false;
    const keys = [];
    for (const prop of arg.properties) {
      if (prop.type !== 'Property' || prop.computed) {
        spread = true;
        continue;
      }
      keys.push(prop.key.type === 'Identifier' ? prop.key.name : String(prop.key.value));
    }
    calls.push({ name: callee.name, keys, spread, line: node.loc.start.line });
  });
  return calls;
}

export function missingDeps(params, keys) {
  return params.filter((name) => !keys.includes(name));
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'range' || key === 'parent') continue;
    walk(value, visit);
  }
}
