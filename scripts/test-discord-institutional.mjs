// 三大法人日報的離線回歸：只測解析，不打網路。
//   node scripts/test-discord-institutional.mjs
import { parseTpexInstitutional, parseTwseInstitutional } from '../src/core/institutional-provider.mjs';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
}

const TWSE_DOC = {
  stat: 'OK',
  date: '20261104',
  fields: [
    '證券代號', '證券名稱',
    '外陸資買進股數(不含外資自營商)', '外陸資賣出股數(不含外資自營商)', '外陸資買賣超股數(不含外資自營商)',
    '外資自營商買進股數', '外資自營商賣出股數', '外資自營商買賣超股數',
    '投信買進股數', '投信賣出股數', '投信買賣超股數',
    '自營商買賣超股數', '自營商買進股數(自行買賣)', '自營商賣出股數(自行買賣)', '自營商買賣超股數(自行買賣)',
    '自營商買進股數(避險)', '自營商賣出股數(避險)', '自營商買賣超股數(避險)', '三大法人買賣超股數',
  ],
  data: [['2330', '台積電', '1,000', '2,000', '-1,000', '0', '0', '0', '500', '100', '400', '50', '0', '0', '50', '0', '0', '0', '-550']],
};

console.log('## 1. TWSE T86');
{
  const map = parseTwseInstitutional(TWSE_DOC, '2026-11-04');
  const row = map.get('2330');
  ok(row?.foreignNet === -1000, '外資買賣超');
  ok(row?.trustNet === 400, '投信買賣超');
  ok(row?.dealerNet === 50, '自營商買賣超');
  ok(row?.totalNet === -550, '三大法人合計');
  ok(parseTwseInstitutional(TWSE_DOC, '2026-11-05').size === 0, '日期不符就回空');
  ok(parseTwseInstitutional({ ...TWSE_DOC, fields: [] }, '2026-11-04').size === 0, '欄位不對就回空');
}

console.log('## 2. TPEx OpenAPI');
{
  const rows = [{
    Date: '1151105',
    SecuritiesCompanyCode: '6488',
    CompanyName: '環球晶',
    'Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Difference': '1,544,525',
    'SecuritiesInvestmentTrustCompanies-Difference': '-2,126,810',
    'Dealers-Difference': '89,497',
    TotalDifference: '-492,788',
  }];
  const map = parseTpexInstitutional(rows, '2026-11-05');
  const row = map.get('6488');
  ok(row?.foreignNet === 1_544_525, '外資買賣超');
  ok(row?.trustNet === -2_126_810, '投信買賣超');
  ok(row?.dealerNet === 89_497, '自營商買賣超');
  ok(row?.totalNet === -492_788, '三大法人合計');
  ok(parseTpexInstitutional(rows, '2026-11-04').size === 0, '日期不符就回空');
}

console.log(failures ? `\n❌ ${failures} 項失敗` : '\n✅ 全部通過');
process.exitCode = failures ? 1 : 0;
