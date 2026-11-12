// 模擬股票的商品主檔：ETF 規則、常用股票別名與顯示名稱。
//
// 一般上市／上櫃普通股不再靠這份清單把關：查價與下單會用官方行情確認代號，
// 4 位數代號（00 開頭 ETF、91 開頭 TDR 除外）就當一般股票。ETF 的 tick、證交稅與漲跌幅
// 逐檔不同，所以 ETF 仍留在這裡；沒設定的 ETF 不開放。
//
// 上市與上櫃分開記：兩邊的 OpenAPI、收盤更新時間與行事曆都不一樣。

export const TRADE_SYMBOLS = Object.freeze([
  // 上市（TWSE）
  ...twse('2330', '台積電', ['台積', 'TSMC', '護國神山']),
  ...twse('2317', '鴻海', ['富士康', 'Foxconn']),
  ...twse('2454', '聯發科', ['MediaTek']),
  ...twse('2412', '中華電', ['中華電信', 'CHT']),
  ...twse('2308', '台達電', ['台達']),
  ...twse('2881', '富邦金', ['富邦']),
  ...twse('2882', '國泰金', ['國泰']),
  ...twse('2884', '玉山金', ['玉山']),
  ...twse('2886', '兆豐金', ['兆豐']),
  ...twse('2891', '中信金', ['中信']),
  ...twse('2880', '華南金', ['華南']),
  ...twse('2892', '第一金', ['第一']),
  ...twse('2885', '元大金', ['元大']),
  ...twse('2801', '彰銀', ['彰化銀行']),
  ...twse('5871', '中租-KY', ['中租']),
  ...twse('1301', '台塑', []),
  ...twse('1303', '南亞', []),
  ...twse('2002', '中鋼', ['中國鋼鐵']),
  ...twse('1503', '士電', ['士林電機']),
  ...twse('1519', '華城', ['華城電機']),
  ...twse('2603', '長榮', ['長榮海運']),
  ...twse('2609', '陽明', ['陽明海運']),
  ...twse('2615', '萬海', []),
  ...twse('1216', '統一', ['統一企業']),
  ...twse('2207', '和泰車', ['和泰']),
  ...twse('2303', '聯電', ['聯華電子', 'UMC']),
  ...twse('2382', '廣達', ['Quanta']),
  ...twse('2357', '華碩', ['ASUS']),
  ...twse('3008', '大立光', ['Largan']),
  ...twse('3711', '日月光投控', ['日月光', 'ASE']),
  ...twse('1101', '台泥', ['台灣水泥']),
  ...twse('2105', '正新', []),
  ...twse('6196', '帆宣', ['帆宣系統', 'Marketech']),
  ...twse('3042', '晶技', ['TXC']),

  // 上櫃（TPEx）
  ...tpex('6488', '環球晶', ['GlobalWafers']),
  ...tpex('5347', '世界', ['世界先進']),
  ...tpex('8069', '元太', ['E Ink']),
  ...tpex('8299', '群聯', ['Phison']),
  ...tpex('3529', '力旺', ['eMemory']),
  ...tpex('3105', '穩懋', ['Win Semiconductors']),
  ...tpex('5483', '中美晶', []),
  ...tpex('6182', '合晶', []),
  ...tpex('3707', '漢磊', []),
  ...tpex('3260', '威剛', ['ADATA']),
  ...tpex('6147', '頎邦', ['Chipbond']),
  ...tpex('3374', '精材', []),
  ...tpex('3131', '弘塑', []),
  ...tpex('5536', '聖暉*', ['聖暉']),
  ...tpex('6274', '台燿', []),
  ...tpex('8358', '金居', []),
  ...tpex('3227', '原相', ['PixArt']),
  ...tpex('4966', '譜瑞-KY', ['譜瑞', 'Parade']),
  ...tpex('5274', '信驊', ['Aspeed']),
  ...tpex('4743', '合一', []),
  ...tpex('4128', '中天', []),
  ...tpex('8446', '華研', []),
  ...tpex('6510', '精測', ['中華精測', 'CHPT']),

  // ETF（只收國內成分；漲跌幅逐檔對過證交所 TWT84U，不能從代號推）
  ...etf('0050', '元大台灣50', ['台灣50']),
  ...etf('0056', '元大高股息', ['高股息']),
  ...etf('006208', '富邦台50', []),
  ...etf('00692', '富邦公司治理', []),
  ...etf('00713', '元大台灣高息低波', []),
  ...etf('00878', '國泰永續高股息', []),
  ...etf('00919', '群益台灣精選高息', []),
  ...etf('00929', '復華台灣科技優息', []),
  ...etf('00632R', '元大台灣50反1', ['反1']),
  ...etf('00631L', '元大台灣50正2', ['正2'], 20),
]);

function twse(symbol, name, aliases) {
  return [entry(symbol, name, aliases, 'TWSE')];
}

function tpex(symbol, name, aliases) {
  return [entry(symbol, name, aliases, 'TPEx')];
}

function entry(symbol, name, aliases, exchange) {
  return Object.freeze({
    symbol,
    name,
    aliases: Object.freeze(aliases),
    market: 'TW',
    exchange,
    currency: 'TWD',
    type: 'stock',
    limitPct: 10,
    tradable: true,
  });
}

/** ETF 走白名單：漲跌幅逐檔不同（一般 10%、槓桿 20%），不能用代號推。目前 10 檔都在上市。 */
function etf(symbol, name, aliases, limitPct = 10) {
  return [Object.freeze({ ...entry(symbol, name, aliases, 'TWSE'), type: 'etf', limitPct })];
}

const bySymbol = new Map(TRADE_SYMBOLS.map((item) => [item.symbol, item]));

export function findSymbol(symbol) {
  return bySymbol.get(String(symbol ?? '').trim().toUpperCase()) ?? null;
}

/**
 * 一般上市／上櫃普通股：4 位數代號，排除 00 開頭的 ETF 與 91 開頭的 TDR。
 * 官方行情清單也含特別股與 ETN，這裡只放行一般股票。
 */
export function isOrdinaryStockCode(symbol) {
  const code = String(symbol ?? '').trim();
  return /^[1-9]\d{3}$/.test(code) && !code.startsWith('91');
}

/**
 * 列出可交易主檔；query 用代號、名稱或別名做子字串比對。
 * 這裡只是查清單、不動錢，所以不用 resolveSymbol 的嚴格規則。
 */
export function listSymbols(query = '') {
  const text = String(query ?? '').trim();
  if (!text) return TRADE_SYMBOLS;
  const needle = text.toLowerCase();
  return TRADE_SYMBOLS.filter((item) => item.symbol.toLowerCase().includes(needle)
    || item.name.toLowerCase().includes(needle)
    || item.aliases.some((alias) => alias.toLowerCase().includes(needle)));
}

/**
 * 名稱比對：精確代號 → 精確名稱 → 別名 → 子字串。
 * 命中多個就回候選，不替玩家選；模型不該自己猜。
 */
export function resolveSymbol(query, { strict = false } = {}) {
  const text = String(query ?? '').trim();
  if (!text) return { match: null, candidates: [] };
  const upper = text.toUpperCase();
  const exact = bySymbol.get(upper);
  if (exact) return { match: exact, candidates: [] };
  const exactName = TRADE_SYMBOLS.find((item) => item.name === text);
  if (exactName) return { match: exactName, candidates: [] };
  const aliasHits = TRADE_SYMBOLS.filter((item) => item.aliases.some((alias) => alias.toUpperCase() === upper));
  if (aliasHits.length === 1) return { match: aliasHits[0], candidates: [] };
  if (aliasHits.length > 1) return { match: null, candidates: aliasHits };
  // 下單是動錢的動作：只接受代號、完整名稱或唯一別名，不用部分比對。
  if (strict) return { match: null, candidates: [] };
  const needle = text.toLowerCase();
  const candidates = TRADE_SYMBOLS.filter((item) => item.name.toLowerCase().includes(needle)
    || item.symbol.toLowerCase().includes(needle)
    || item.aliases.some((alias) => alias.toLowerCase().includes(needle)));
  if (candidates.length === 1) return { match: candidates[0], candidates: [] };
  return { match: null, candidates };
}
