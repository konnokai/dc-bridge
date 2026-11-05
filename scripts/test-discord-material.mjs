// 每日重大訊息（MOPS）解析的離線回歸：只測解析，不打網路。
//   node scripts/test-discord-material.mjs
import { createMaterialProvider, parseTpexMaterial, parseTwseMaterial } from '../src/core/material-provider.mjs';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
}

const TWSE = [{
  出表日期: '1151105',
  發言日期: '1151104',
  發言時間: '130746',
  公司代號: '2330',
  公司名稱: '台積電',
  '主旨 ': '公告本公司董事會通過第三季合併財務報告',
  符合條款: '第31款',
  事實發生日: '1151104',
  說明: '1.提報董事會日期:115/11/04\n2.其他應敘明事項:無',
}];

const TPEX = [{
  Date: '1151105',
  發言日期: '1151104',
  發言時間: '94226',
  SecuritiesCompanyCode: '6488',
  CompanyName: '環球晶',
  主旨: '公告本公司代理發言人異動',
  符合條款: '第8款',
  事實發生日: '1151104',
  說明: '1.人員變動別:代理發言人\n2.發生變動日期:115/11/04',
}];

console.log('## 1. TWSE 重大訊息');
{
  const parsed = parseTwseMaterial(TWSE, '2026-11-04');
  const item = parsed.bySymbol.get('2330')?.[0];
  ok(parsed.total === 1, '只算指定公告日');
  ok(item?.time === '13:07', '發言時間轉 HH:MM');
  ok(item?.subject.includes('第三季'), '主旨');
  ok(item?.clause === '第31款', '符合條款');
  ok(parseTwseMaterial(TWSE, '2026-11-05').total === 0, '日期不符就回空');
}

console.log('## 2. TPEx 重大訊息');
{
  const parsed = parseTpexMaterial(TPEX, '2026-11-04');
  const item = parsed.bySymbol.get('6488')?.[0];
  ok(parsed.total === 1, '只算指定公告日');
  ok(item?.time === '09:42', '發言時間轉 HH:MM');
  ok(item?.subject.includes('代理發言人'), '主旨');
  ok(item?.clause === '第8款', '符合條款');
  ok(parseTpexMaterial(TPEX, '2026-11-05').total === 0, '日期不符就回空');
}

console.log('## 3. 最近交易日範圍、去重與排序');
{
  const older = { ...TWSE[0], 發言日期: '1151103', 主旨: '舊公告' };
  const duplicate = { ...TWSE[0] };
  const provider = createMaterialProvider({
    fetchImpl: async (url) => (url.includes('t187ap04') ? [TWSE[0], older, duplicate] : []),
  });
  const result = await provider.getForSymbols([{ symbol: '2330', exchange: 'TWSE' }], '2026-11-05', { since: '2026-11-03' });
  const items = result.bySymbol.get('2330') ?? [];
  ok(result.available === true, '範圍內有資料');
  ok(items.length === 2, '重複公告去重');
  ok(items[0].date === '2026-11-04' && items[1].date === '2026-11-03', '依日期新到舊排序');
}

console.log(failures ? `\n❌ ${failures} 項失敗` : '\n✅ 全部通過');
process.exitCode = failures ? 1 : 0;
