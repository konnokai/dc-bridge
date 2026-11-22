// 明日方舟練度統計：名稱比對、專精／模組排行、白名單與 setup-dsh 註冊。
// 只餵 fixture，不連網；上游格式改壞不會讓這支測試紅，資料錯誤由實際查詢才看得到。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { apply } from '../plugins/dc-agent-presets/dc-tool-restrict.mjs'
import { formatTraining, matchOperator } from '../src/core/arknights-training.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const skills3 = [{ skillName: '技能一' }, { skillName: '技能二' }, { skillName: '技能三' }]
const table = {
  char_103_angel: {
    charId: 'char_103_angel', name: '能天使', rarity: 6, profession: 'SNIPER',
    skills: [{ skillName: '冲锋模式' }, { skillName: '扫射模式' }, { skillName: '过载模式' }],
    equip: [{ typeName2: 'X', uniEquipName: '能天使的杰作' }, { typeName2: 'Y', uniEquipName: '欢迎光临，企鹅物流' }],
  },
  char_002_amiya: {
    charId: 'char_002_amiya', name: '阿米娅', rarity: 5, profession: 'CASTER',
    skills: [{ skillName: '战术咏唱·γ型' }, { skillName: '精神爆发' }, { skillName: '奇美拉' }],
    equip: [{ typeName2: 'Y', uniEquipName: 'DWDB-221E' }],
  },
  char_1001_amiya2: { charId: 'char_1001_amiya2', name: '阿米娅（近卫）', rarity: 5, profession: 'WARRIOR', skills: skills3, equip: [] },
  char_1037_amiya3: { charId: 'char_1037_amiya3', name: '阿米娅（医疗）', rarity: 5, profession: 'MEDIC', skills: skills3, equip: [] },
  char_010_chen: { charId: 'char_010_chen', name: '陈', rarity: 6, profession: 'WARRIOR', skills: skills3, equip: [] },
  char_1013_chen2: { charId: 'char_1013_chen2', name: '假日威龙陈', rarity: 6, profession: 'WARRIOR', skills: skills3, equip: [] },
  char_1050_chen3: { charId: 'char_1050_chen3', name: '赤刃明霄陈', rarity: 6, profession: 'WARRIOR', skills: skills3, equip: [] },
  char_502_nblade: { charId: 'char_502_nblade', name: '夜刀', rarity: 2, profession: 'SPECIAL', skills: [], equip: [] },
  char_1029_yato2: { charId: 'char_1029_yato2', name: '麒麟R夜刀', rarity: 6, profession: 'SPECIAL', skills: skills3, equip: [] },
  char_225_haak: { charId: 'char_225_haak', name: '阿', rarity: 6, profession: 'SPECIAL', skills: skills3, equip: [] },
  char_113_cqbw: { charId: 'char_113_cqbw', name: 'W', rarity: 6, profession: 'SNIPER', skills: skills3, equip: [] },
  char_263_skadi: { charId: 'char_263_skadi', name: '斯卡蒂', rarity: 6, profession: 'WARRIOR', skills: skills3, equip: [] },
  char_1012_skadi2: { charId: 'char_1012_skadi2', name: '浊心斯卡蒂', rarity: 6, profession: 'SUPPORT', skills: skills3, equip: [] },
  char_009_12fce: { charId: 'char_009_12fce', name: '12F', rarity: 2, profession: 'CASTER', skills: [], equip: [] },
  char_332_archet: { charId: 'char_332_archet', name: '空弦', rarity: 6, profession: 'SNIPER', skills: [{ skillName: '箭矢·散逸' }], equip: [{ typeName2: 'A', uniEquipName: '空弦特限证章' }] },
}

const angelStat = {
  charId: 'char_103_angel', own: 1000,
  elite: { 0: 100, 1: 100, 2: 800 },
  // key 4 以上是上游髒資料，不能算進 M1／M2／M3。
  skill1: { 0: 950, 3: 10, 7: 5 }, skill2: { 0: 960, 3: 5 }, skill3: { 0: 300, 1: 10, 2: 10, 3: 680, 10: 5 },
  equipX: { 0: 700, 3: 300 }, equipY: { 0: 700, 1: 50, 2: 30, 3: 120 },
}

// ── 名稱比對 ────────────────────────────────────────────────────────────────
assert.equal(matchOperator('能天', table).operator.charId, 'char_103_angel', '唯一片段比對')
assert.equal(matchOperator('濁心斯卡蒂', table).operator.charId, 'char_1012_skadi2', '繁體要轉簡體再比')
assert.equal(matchOperator('CHAR_103_ANGEL', table).operator.charId, 'char_103_angel', 'charId 不分大小寫')
assert.equal(matchOperator('w', table).operator.charId, 'char_113_cqbw', '英文名不分大小寫')
assert.equal(matchOperator('陈', table).operator.charId, 'char_010_chen', '單字名精確命中')
assert.equal(matchOperator('阿米娅(近卫)', table).operator.charId, 'char_1001_amiya2', '半形括號與全形等價')
assert.equal(matchOperator('阿米婭（近衛）', table).operator.charId, 'char_1001_amiya2', '繁體名稱')
assert.match(matchOperator('斯卡', table).error, /斯卡蒂、浊心斯卡蒂|浊心斯卡蒂、斯卡蒂/, '多個候選要列名字')
// 查詢裡含幹員名時不能自動選：單字名（陈、阿）最容易對錯人。
assert.match(matchOperator('假日陈', table).error, /假日威龙陈/, '假日陈不能答成陈')
assert.match(matchOperator('陈sir', table).error, /假日威龙陈、陈、赤刃明霄陈|陈、假日威龙陈/, '陈sir 要列候選')
assert.match(matchOperator('麒麟夜刀', table).error, /麒麟R夜刀/, '麒麟夜刀不能答成夜刀')
assert.match(matchOperator('近卫阿米娅', table).error, /阿米娅（近卫）/, '近衛阿米婭要列變體')
assert.match(matchOperator('不存在的幹員', table).error, /找不到/, '查不到要說清楚')
assert.match(matchOperator('', table).error, /請給幹員名稱/, '空字串要提示')

// ── 排行與比率 ──────────────────────────────────────────────────────────────
const angel = formatTraining(table.char_103_angel, angelStat)
assert.match(angel, /^能天使（6★ 狙擊，char_103_angel）/m, '標題帶星數與職業')
assert.match(angel, /1,000 人持有（精二 800 人；比率分母＝持有者）/, '持有與精二人數')
const skillLines = angel.split('\n').filter((line) => /^\d\. 第 \d 技能/.test(line))
assert.equal(skillLines.length, 3, '三個技能都要列')
assert.ok(angel.indexOf('第 3 技能') < angel.indexOf('第 1 技能'), '專三率高的技能排前面')
assert.match(angel, /第 3 技能「过载模式」：M3 68\.0%（M1 10／M2 10／M3 680）/, 'key 4 以上不能算進 M1／M2／M3')
const moduleLines = angel.split('\n').filter((line) => /^\d\. [A-Z] 模組/.test(line))
assert.equal(moduleLines.length, 2, '兩個模組都要列')
assert.match(moduleLines[0], /X 模組「能天使的杰作」：階段3 30\.0%（300 人），開啟 30\.0%（300 人）/, '模組階段 3 率與開啟率')
assert.match(moduleLines[1], /Y 模組.*階段3 12\.0%（120 人），開啟 20\.0%（200 人）/, '第二個模組的開啟率')

const noSkill = formatTraining(table.char_009_12fce, { charId: 'char_009_12fce', own: 500 })
assert.match(noSkill, /沒有技能/, '無技能幹員')
assert.match(noSkill, /沒有模組/, '無模組幹員')

const zeroModule = formatTraining(table.char_332_archet, { charId: 'char_332_archet', own: 500, skill1: { 3: 0 }, equipA: { 0: 500 } })
assert.match(zeroModule, /還沒有人開模組/, '全部沒開才說沒有資料')

const openNoStage3 = formatTraining(table.char_332_archet, { charId: 'char_332_archet', own: 500, skill1: {}, equipA: { 0: 400, 1: 100 } })
assert.match(openNoStage3, /階段3 0\.0%（0 人），開啟 20\.0%（100 人）/, '有人開但沒升到階段 3 也要列')

const noM3 = formatTraining(table.char_263_skadi, { charId: 'char_263_skadi', own: 500, skill1: {}, skill2: {}, skill3: {} })
assert.match(noM3, /還沒有人把技能專三/, '沒有 M3 資料時照實說')

// ── 白名單：跟 PRTS 同一組開關 ──────────────────────────────────────────────
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
const chat = harness(presetConfig('dc-chat'))
assert.ok(!chat.denied.includes('mcp__arknights__get_operator_training'), 'dc-chat 不該藏練度統計')
assert.equal(chat.guard({ name: 'mcp__arknights__get_operator_training' }), undefined, 'dc-chat 要放行練度統計')
assert.equal(typeof chat.guard({ name: 'mcp__arknights__future_tool' }), 'string', '名單外的 arknights 工具要拒絕')
for (const name of ['dc-learner', 'dc-trader']) {
  const other = harness(presetConfig(name))
  assert.ok(other.denied.includes('mcp__arknights__get_operator_training'), `${name} 註冊期要藏練度統計`)
  assert.equal(typeof other.guard({ name: 'mcp__arknights__get_operator_training' }), 'string', `${name} 執行期要擋`)
}
assert.equal(typeof chat.guard({ name: 'mcp__other__anything' }), 'string', '未知命名空間仍要擋')

// ── 上游格式驗證（stub fetch；每個 tag 都是新的模組實例＝空快取） ─────────────
const jsonRes = (data) => ({ ok: true, status: 200, json: async () => data })
const isStats = (url) => url.includes('ak-operator-statistics')
async function lookupWithStub(tag, statsDoc, tableDoc) {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => jsonRes(isStats(String(url)) ? statsDoc : tableDoc)
  try {
    const mod = await import(`../src/core/arknights-training.mjs?stub=${tag}`)
    return await mod.lookupTraining('能天使')
  } finally {
    globalThis.fetch = original
  }
}
await assert.rejects(lookupWithStub('empty', { code: 200, data: [] }, table), /空的/, '空統計要當失敗，不能進快取')
await assert.rejects(lookupWithStub('bad-table', { code: 200, data: [angelStat] }, { foo: {} }), /幹員表格式不對/, '壞幹員表不能進快取')
assert.match(await lookupWithStub('good', { code: 200, data: [angelStat] }, table), /過載模式|过载模式/, '正常資料要能回答')

// ── setup-dsh 註冊 ──────────────────────────────────────────────────────────
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-arknights-setup-'))
fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true })
fs.writeFileSync(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), '', 'utf8')
fs.writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }, null, 2), 'utf8')
const setup = spawnSync(process.execPath, [path.join(ROOT, 'scripts/setup-dsh.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, DSH_HOME: home, DC_BRIDGE_SKIP_DSH_INSTALL: '1', PATH: path.dirname(process.execPath) },
  timeout: 60000,
})
assert.equal(setup.status, 0, setup.stderr || setup.error?.message)
const doc = yaml.load(fs.readFileSync(path.join(home, 'profiles/web/cordis.patch.yml'), 'utf8'))
const entry = doc.flatMap((operation) => operation.insert ?? []).find((row) => row.id === 'mcp-arknights')
assert.ok(entry, 'setup-dsh 要掛 mcp-arknights')
assert.equal(entry.config.serverName, 'arknights')
assert.equal(entry.config.command, process.execPath)
assert.match(entry.config.args[0], /src[\\/]mcp-arknights\.js$/)

try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }

console.log('Arknights: 名稱比對、專精／模組排行、上游格式驗證、白名單與 setup-dsh 註冊正常')
