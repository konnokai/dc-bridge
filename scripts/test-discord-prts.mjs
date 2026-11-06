// PRTS 工具白名單：dc-chat 放行清單內的工具，dc-learner／dc-trader 在註冊期隱藏、執行期再擋一次。
// 另外驗證 setup-dsh --discord 產生的 mcp-prts 條目（transport、URL）與冪等性。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { apply } from '../plugins/dc-agent-presets/dc-tool-restrict.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function presetConfig(name) {
  const rows = yaml.load(fs.readFileSync(path.join(ROOT, 'dsh/agent-presets', name, 'agent.cordis.yml'), 'utf8'))
  return rows.find((row) => row.id === 'dc-tool-restrict')?.config ?? {}
}

function harness(config) {
  const denied = []
  let guard
  apply({
    tools: {
      restrict: ({ deny }) => denied.push(...deny),
      guard: (fn) => { guard = fn },
    },
  }, config)
  return { denied, guard }
}

// 直接拿三個 preset 的實際 config，避免測試跟 preset 各說各話。
const chat = harness(presetConfig('dc-chat'))
assert.equal(presetConfig('dc-chat').allowPrts, true, 'dc-chat 要開 allowPrts')
assert.ok(!chat.denied.includes('mcp__prts__search_prts'), 'dc-chat 不該藏 PRTS 工具')
assert.equal(chat.guard({ name: 'mcp__prts__search_prts' }), undefined, 'dc-chat 放行查詞條')
assert.equal(chat.guard({ name: 'mcp__prts__get_operator_basic_info' }), undefined, 'dc-chat 放行查幹員')
assert.equal(chat.guard({ name: 'mcp__prts__operator_artwork', arguments: { action: 'list' } }), undefined, 'dc-chat 放行立繪清單')
assert.equal(chat.guard({ name: 'mcp__prts__operator_artwork', arguments: { action: 'get', variant: 'preview' } }), undefined, 'dc-chat 放行 256px 立繪')
assert.match(chat.guard({ name: 'mcp__prts__operator_artwork', arguments: { action: 'get', variant: 'large' } }), /get_prts_artwork/, 'large 要指路到橋接工具')
assert.match(chat.guard({ name: 'mcp__prts__operator_artwork', arguments: { action: 'get' } }), /get_prts_artwork/, '省略 variant 等於 large，也要擋')
assert.equal(chat.guard({ name: 'mcp__discord__get_prts_artwork' }), undefined, 'dc-chat 放行橋接的 1024px 立繪')
// prts-mcp 升版多出工具時，沒在清單裡的一律拒絕（要有人看過才放行）。
assert.equal(typeof chat.guard({ name: 'mcp__prts__future_tool' }), 'string', '名單外的 PRTS 工具要拒絕')

for (const name of ['dc-learner', 'dc-trader']) {
  const other = harness(presetConfig(name))
  assert.notEqual(presetConfig(name).allowPrts, true, `${name} 不該開 allowPrts`)
  assert.ok(other.denied.includes('mcp__prts__search_prts'), `${name} 註冊期要藏 PRTS 工具`)
  assert.equal(typeof other.guard({ name: 'mcp__prts__search_prts' }), 'string', `${name} 執行期要擋`)
  assert.equal(typeof other.guard({ name: 'mcp__prts__operator_artwork' }), 'string', `${name} 執行期也要擋立繪`)
}

// setup --discord：連跑兩次只能有一條 mcp-prts，而且 transport／URL 都要對。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-prts-setup-'))
for (let i = 0; i < 2; i++) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/setup-dsh.mjs'), '--discord'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home, QQ_BRIDGE_SKIP_DSH_INSTALL: '1', PATH: path.dirname(process.execPath) },
    timeout: 60000,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
}
const doc = yaml.load(fs.readFileSync(path.join(home, 'profiles/web/cordis.patch.yml'), 'utf8'))
const entries = doc.flatMap((operation) => operation.insert ?? [])
const prts = entries.filter((entry) => entry.id === 'mcp-prts')
assert.equal(prts.length, 1, 'mcp-prts 只能有一條')
assert.equal(prts[0].config.transport, 'streamable-http', 'PRTS 走 HTTP')
assert.equal(prts[0].config.url, 'http://127.0.0.1:3011/mcp', 'PRTS URL 要對')
assert.equal(prts[0].config.command, undefined, 'HTTP 不寫 command')
assert.equal(prts[0].config.args, undefined, 'HTTP 不寫 args')
assert.equal(prts[0].config.env, undefined, 'env 在 container，不在 DSH')
assert.equal(entries.find((entry) => entry.id === 'mcp-discord').config.command, process.execPath, '本機 MCP 仍用同一個 node')

try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 清不掉就算了，不影響斷言 */ }

console.log('PRTS: dc-chat 放行清單、其他 preset 隱藏並拒絕；setup --discord 條目與冪等性正常')
