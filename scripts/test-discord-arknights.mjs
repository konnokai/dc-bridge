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
import {
  ALIAS_STATUS, addManualAlias, aliasStats, buildAliasStore, deleteAliases, readAliasStore, readAliasStoreStatus,
  recordAlias, setAliasStatus, writeAliasStore,
} from '../src/core/arknights-aliases.mjs'
import { fetchAliasPages, formatTraining, matchAlias, matchOperator } from '../src/core/arknights-training.mjs'

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
  char_172_svrash: { charId: 'char_172_svrash', name: '银灰', rarity: 6, profession: 'WARRIOR', skills: skills3, equip: [] },
  char_1052_kalts2: { charId: 'char_1052_kalts2', name: '凯尔希·思衡托', rarity: 6, profession: 'MEDIC', skills: skills3, equip: [] },
  char_291_aglina: { charId: 'char_291_aglina', name: '安洁莉娜', rarity: 6, profession: 'SUPPORT', skills: skills3, equip: [] },
  char_4080_lin: { charId: 'char_4080_lin', name: '林', rarity: 6, profession: 'SPECIAL', skills: skills3, equip: [] },
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
const kaltsStat = {
  charId: 'char_1052_kalts2', own: 500, elite: { 0: 10, 1: 40, 2: 450 },
  skill1: { 0: 480, 3: 20 }, skill2: { 0: 100, 3: 400 }, skill3: { 0: 300, 3: 200 },
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

// ── PRTS 別名表 ─────────────────────────────────────────────────────────────
const aliasPages = [
  { title: '银灰', redirects: [{ title: 'SilverAsh' }, { title: '银老板' }, { title: '同名' }] },
  { title: '假日威龙陈', redirects: [{ title: '水陈' }, { title: '陈' }] },
  { title: '凯尔希·思衡托', redirects: [{ title: '天猫' }, { title: '同名' }] },
  { title: '阿米娅(近卫)', redirects: [{ title: '近卫阿米娅' }] },
  { title: '安洁莉娜', redirects: [{ title: 'Angelina' }] },
  { title: '林', redirects: [{ title: 'Lin' }] },
  { title: '不存在的干员', redirects: [{ title: '路人' }] },
]
const aliasStore = buildAliasStore(aliasPages, table, '2026-01-01T00:00:00.000Z')
const aliasOf = (id) => aliasStore.entries.find((entry) => entry.id === id)
assert.equal(aliasOf('银老板')?.charId, 'char_172_svrash', 'PRTS redirect 進別名表')
assert.equal(aliasOf('银老板')?.aliasTw, '銀老闆', '別名另外存繁體，控制台搜尋用')
assert.equal(aliasOf('银老板')?.nameTw, '銀灰', '幹員名另外存繁體')
assert.equal(aliasOf('水陈')?.charId, 'char_1013_chen2', '水陈對到假日威龍陳')
assert.equal(aliasOf('天猫')?.charId, 'char_1052_kalts2', '天猫對到凱爾希異格')
assert.equal(aliasOf('近卫阿米娅')?.charId, 'char_1001_amiya2', '半形括號的頁面也要對得到')
assert.equal(aliasOf('陈'), undefined, '別名撞到正式名稱時跳過')
assert.equal(aliasOf('路人'), undefined, 'PRTS 有、一圖流沒有的頁面要跳過')
assert.equal(aliasOf('同名'), undefined, '兩個幹員搶同一個別名時丟掉')

assert.equal(matchAlias('银老板', table, aliasStore).operator.charId, 'char_172_svrash', '別名精確命中')
assert.equal(matchAlias('水陈', table, aliasStore).operator.charId, 'char_1013_chen2', '水陈不能被單字「陈」搶走')
assert.equal(matchAlias('飛天貓', table, aliasStore).operator.charId, 'char_1052_kalts2', '查詢包含 PRTS 別名「天猫」')
assert.equal(matchAlias('Angelina专三', table, aliasStore).operator.charId, 'char_291_aglina', '長別名包住短別名時取最長')
assert.equal(matchAlias('路人', table, aliasStore), null, '沒有別名時回 null')

const learned = JSON.parse(JSON.stringify(aliasStore))
assert.ok(recordAlias(learned, { alias: '飛天貓', charId: 'char_1052_kalts2', name: '凯尔希·思衡托', source: 'query' }), '查到的新別名要能加入')
assert.equal(recordAlias(learned, { alias: '飛天貓', charId: 'char_1052_kalts2', name: '凯尔希·思衡托' }), null, '重複的不再加')
const learnedEntry = learned.entries.find((entry) => entry.id === '飞天猫')
assert.equal(learnedEntry.status, ALIAS_STATUS.ACTIVE, '自動加入預設啟用')
assert.equal(learnedEntry.aliasTw, '飛天貓', '查詢別名也要存繁體')
assert.equal(learnedEntry.nameTw, '凱爾希·思衡托', '查詢別名的幹員名也要存繁體')
learnedEntry.status = ALIAS_STATUS.REJECTED
assert.match(matchAlias('飛天貓', table, learned).error, /拒絕/, '拒絕後同名查詢不再命中')
assert.equal(recordAlias(learned, { alias: '飛天貓', charId: 'char_1052_kalts2', name: '凯尔希·思衡托' }), null, '被拒絕的不會復活')
assert.equal(setAliasStatus(learned, ['飞天猫'], ALIAS_STATUS.ACTIVE), 1, '恢復別名')
assert.equal(setAliasStatus(learned, ['飞天猫'], ALIAS_STATUS.ACTIVE), 0, '已經是啟用就不算變更')
assert.equal(aliasStats(learned).rejected, 0, '統計跟著狀態')
assert.equal(deleteAliases(learned, ['飞天猫']), 1, '刪除別名')
assert.equal(learned.entries.some((entry) => entry.id === '飞天猫'), false, '刪除後不在表裡')

const manual = JSON.parse(JSON.stringify(aliasStore))
const manualByName = addManualAlias(manual, { alias: '小銀', charId: 'char_172_svrash', name: '银灰' })
assert.ok(manualByName.entry, '手動新增')
assert.equal(manualByName.entry.charId, 'char_172_svrash', '手動新增存 charId')
assert.equal(manualByName.entry.source, 'manual', '手動新增的來源')
assert.equal(matchAlias('小銀', table, manual).operator.charId, 'char_172_svrash', '手動別名可解析')
assert.match(addManualAlias(manual, { alias: '小銀', charId: 'char_172_svrash', name: '银灰' }).error, /已經有/, '重複別名要拒絕')
assert.match(addManualAlias(manual, { alias: '', charId: 'char_172_svrash', name: '银灰' }).error, /缺少別名/, '缺別名要拒絕')
assert.match(addManualAlias(manual, { alias: '小凱', charId: '', name: '' }).error, /缺少幹員/, '缺幹員要拒絕')
assert.match(addManualAlias(manual, { alias: '银灰', charId: 'char_172_svrash', name: '银灰' }).error, /正式名稱/, '別名不能等於正式名稱')
assert.equal(addManualAlias(manual, { alias: '小凱', charId: 'char_1052_kalts2', name: '凯尔希·思衡托' }).entry.charId, 'char_1052_kalts2', '手動新增另一個幹員')
assert.equal(matchAlias('小凱', table, manual).operator.charId, 'char_1052_kalts2', '手動別名可解析')

const aliasFile = path.join(os.tmpdir(), `ak-alias-${process.pid}-${Date.now()}.json`)
assert.equal(readAliasStoreStatus(aliasFile).state, 'missing', '沒有檔案時回 missing')
fs.writeFileSync(aliasFile, '{broken', 'utf8')
assert.equal(readAliasStoreStatus(aliasFile).state, 'corrupt', '壞 JSON 回 corrupt')
fs.writeFileSync(aliasFile, JSON.stringify({ version: 1, entries: 'nope' }), 'utf8')
assert.equal(readAliasStoreStatus(aliasFile).state, 'corrupt', 'entries 格式不對回 corrupt')
writeAliasStore(aliasStore, aliasFile)
assert.equal(readAliasStoreStatus(aliasFile).state, 'ok', '寫入後回 ok')
const persisted = readAliasStore(aliasFile)
assert.equal(persisted.entries.length, aliasStore.entries.length, '別名檔可讀回')
assert.equal(persisted.builtAt, aliasStore.builtAt, '別名檔保留建立時間')
fs.rmSync(aliasFile, { force: true })

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
async function lookupWithStub(tag, statsDoc, tableDoc, query = '能天使', aliasFile = undefined, onFetch = null) {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    onFetch?.(String(url))
    return jsonRes(isStats(String(url)) ? statsDoc : tableDoc)
  }
  try {
    const mod = await import(`../src/core/arknights-training.mjs?stub=${tag}`)
    return await mod.lookupTraining(query, { aliasFile })
  } finally {
    globalThis.fetch = original
  }
}
await assert.rejects(lookupWithStub('empty', { code: 200, data: [] }, table), /空的/, '空統計要當失敗，不能進快取')
await assert.rejects(lookupWithStub('bad-table', { code: 200, data: [angelStat] }, { foo: {} }), /幹員表格式不對/, '壞幹員表不能進快取')
assert.match(await lookupWithStub('good', { code: 200, data: [angelStat] }, table), /過載模式|过载模式/, '正常資料要能回答')

// PRTS 抓取：cmcontinue／rdcontinue 要合併，error 欄位要當失敗。
const originalStubFetch = globalThis.fetch
try {
  let redirectCalls = 0
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url))
    if (parsed.searchParams.get('list') === 'categorymembers') {
      if (!parsed.searchParams.get('cmcontinue')) {
        return jsonRes({ query: { categorymembers: [{ title: '银灰' }] }, continue: { cmcontinue: 'c1' } })
      }
      return jsonRes({ query: { categorymembers: [{ title: '凯尔希·思衡托' }] } })
    }
    redirectCalls += 1
    if (!parsed.searchParams.get('rdcontinue')) {
      return jsonRes({
        query: { pages: { a: { title: '银灰', redirects: [{ title: '银老板' }] }, b: { title: '凯尔希·思衡托', redirects: [{ title: '天猫' }] } } },
        continue: { rdcontinue: 'r1' },
      })
    }
    return jsonRes({ query: { pages: { a: { title: '银灰', redirects: [{ title: 'SilverAsh' }] } } } })
  }
  const pages = await fetchAliasPages(Date.now() + 10_000)
  const silver = pages.find((page) => page.title === '银灰')
  assert.equal(pages.length, 2, '分類跨頁要合併')
  assert.deepEqual(silver.redirects.map((row) => row.title), ['银老板', 'SilverAsh'], 'redirect 跨頁要合併')
  assert.equal(redirectCalls, 2, 'rdcontinue 要再抓一次')
} finally {
  globalThis.fetch = originalStubFetch
}
globalThis.fetch = async () => jsonRes({ error: { code: 'maxlag', info: 'lag' } })
const failedFetch = fetchAliasPages(Date.now() + 10_000)
globalThis.fetch = originalStubFetch
await assert.rejects(failedFetch, /PRTS API 錯誤/, 'PRTS error 欄位要當失敗')

// 別名查詢：讀既有別名檔 → 命中「天猫」→ 把「飛天貓」補進檔案。
const liveAliasFile = path.join(os.tmpdir(), `ak-alias-live-${process.pid}-${Date.now()}.json`)
writeAliasStore(aliasStore, liveAliasFile)
try {
  const text = await lookupWithStub('alias', { code: 200, data: [angelStat, kaltsStat] }, table, '飛天貓', liveAliasFile)
  assert.match(text, /凯尔希·思衡托/, '別名查詢要對到幹員')
  const saved = readAliasStore(liveAliasFile)
  const queryAlias = saved.entries.find((entry) => entry.id === '飞天猫')
  assert.equal(queryAlias?.charId, 'char_1052_kalts2', '查到的別名要寫回檔案')
  assert.equal(queryAlias?.source, 'query', '查詢別名的來源要標清楚')

  const beforePunct = readAliasStore(liveAliasFile).entries.length
  const punctText = await lookupWithStub('alias-punct', { code: 200, data: [angelStat, kaltsStat] }, table, '天猫?', liveAliasFile)
  assert.match(punctText, /凯尔希·思衡托/, '標點不影響別名命中')
  assert.equal(readAliasStore(liveAliasFile).entries.length, beforePunct, '標點不會存成新別名')
} finally {
  fs.rmSync(liveAliasFile, { force: true })
}

// 壞檔：不重抓 PRTS、不覆蓋，退回正式名稱查詢。
const corruptFile = path.join(os.tmpdir(), `ak-alias-corrupt-${process.pid}-${Date.now()}.json`)
fs.writeFileSync(corruptFile, '{broken', 'utf8')
let prtsCalls = 0
try {
  const text = await lookupWithStub('corrupt', { code: 200, data: [angelStat, kaltsStat] }, table, '銀老闆', corruptFile,
    (url) => { if (url.includes('prts.wiki')) prtsCalls += 1 })
  assert.match(text, /找不到/, '壞檔時退回正式名稱查詢')
  assert.equal(prtsCalls, 0, '壞檔不應該重抓 PRTS')
  assert.equal(fs.readFileSync(corruptFile, 'utf8'), '{broken', '壞檔不能被覆蓋')
} finally {
  fs.rmSync(corruptFile, { force: true })
}

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
