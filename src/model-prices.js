// DeepSeek 官方价目表与峰谷分时判定（桥接侧自行维护）。
//
// 为什么放在桥接里：DSH 自身不做任何货币换算（`dsh-llm-pi-ai` 明写 "no consumer reports
// spend"），provider 只回 token 数。所以「花多少钱」必须由消费方用价目表算。
//
// 口径（与官方英文文档一致，单位：美元 / 百万 token）：
//   扣减费用 = Σ(各桶 token 数 × 对应单价)
//   桶共三个：输入缓存命中 / 输入缓存未命中 / 输出。
//   空闲时段单价 = 高峰时段的一半。
//   高峰时段 = 北京时间周一至周五 9:00-12:00、14:00-18:00，且不含中国法定节假日；
//   其余时段（含周末与法定节假日全天）均为空闲时段。
//
// 中英文两页不是同一组数字：英文页 USD，中文页 CNY（两边有取整，不是精确汇率换算）。
// 这里照英文页收 USD。逐轮与基线的金额读取时才折算；被淘汰的 evict 汇总是淘汰当下的金额，
// 不随价目表重算。
//
// 注意 `dsh` 报的 token 桶是**互不重叠**的：
//   计费输入 = inputTokens(未命中) + cacheReadTokens + cacheWriteTokens
// 所以三个桶要分别计价再相加，不能把 cacheRead 当成 inputTokens 的一部分。
//
// 价目来源：https://api-docs.deepseek.com/quick_start/pricing/（2026-11-05 抓取）
// 节假日来源：国办发明电〔2025〕7 号（2026 年）、国办发明电〔2026〕10 号（2027 年）。

/** 价目表版本标记，仅用于控制台展示与排障（改了价目表就改这里）。 */
export const PRICE_TABLE_VERSION = '2026-11-07';

/**
 * 旧账本（人民币价目表时代）已落盘的金额换算成美元的比率。
 *
 * 英文页 USD 价 ≈ 中文页 CNY 价 × 0.15（flash 三项都正好 0.15，pro 约 0.1467）。
 * 旧 `evict` 行只存金额、没存模型，按 flash 的 0.15 换算，最坏误差约 2%。
 * 2026-11 之后写入的 `evict` 行带 `cur`，不再走这条换算。
 */
export const LEGACY_CNY_TO_USD = 0.15;

/**
 * 2026 年中国法定节假日（放假日，含调休连休段）。
 * 高峰时段判定要排除这些日期；周末（周六/周日）本身已因「非周一至周五」被判为空闲。
 * 调休上班的周六/周日仍按「非周一至周五」算空闲 —— 官方口径只认周一至周五。
 */
export const CN_HOLIDAYS_2026 = [
  // 元旦：1/1(周四)-1/3(周六)
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节：2/15(周日)-2/23(周一)
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明节：4/4(周六)-4/6(周一)
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节：5/1(周五)-5/5(周二)
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午节：6/19(周五)-6/21(周日)
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋节：9/25(周五)-9/27(周日)
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆节：10/1(周四)-10/7(周三)
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07'
];

/**
 * 2027 年法定节假日（国务院办公厅通知，放假调休段）。
 * 来源：国办发明电〔2026〕10 号（2026-11-05 发布）。
 *
 * 价目表只认这些日期：缺一天会把那天当高峰计价（2 倍），多写一天会把那天
 * 当空闲计价。两种情况都不报错，只让账单静默偏高或偏低，所以放假安排公布后
 * 要按实际日期更新本表（2026 年的表就是照国办发明电〔2025〕7 号写的）。
 */
export const CN_HOLIDAYS_2027 = [
  // 元旦：1/1(周五)-1/3(周日)
  '2027-01-01', '2027-01-02', '2027-01-03',
  // 春节：2/5(周五，除夕)-2/13(周六)
  '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09',
  '2027-02-10', '2027-02-11', '2027-02-12', '2027-02-13',
  // 清明节：4/3(周六)-4/5(周一)
  '2027-04-03', '2027-04-04', '2027-04-05',
  // 劳动节：5/1(周六)-5/5(周三)
  '2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05',
  // 端午节：6/9(周三) 1 天
  '2027-06-09',
  // 中秋节：9/15(周三) 1 天
  '2027-09-15',
  // 国庆节：10/1(周五)-10/7(周四)
  '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04',
  '2027-10-05', '2027-10-06', '2027-10-07'
];

/** 内置的全部法定节假日（跨年份）。 */
export const CN_HOLIDAYS = [...CN_HOLIDAYS_2026, ...CN_HOLIDAYS_2027];

/** 北京时间相对 UTC 的分钟偏移。 */
const BEIJING_OFFSET_MINUTES = 8 * 60;

/**
 * 默认价目表（美元 / 百万 token）。
 * `off` 为空闲时段单价；高峰时段单价 = 空闲单价 × `peakMultiplier`。
 * `cacheWrite` 缺省时按未命中价计费（DeepSeek 目前不单独报 cacheWrite，恒为 0）。
 */
export const DEFAULT_PRICE_TABLE = {
  version: PRICE_TABLE_VERSION,
  currency: 'USD',
  symbol: '$',
  unit: 1e6,
  peakMultiplier: 2,
  // 高峰时段窗口，按北京时间的小时数半开区间 [start, end)
  peakWindows: [[9, 12], [14, 18]],
  // 高峰时段只在周一至周五；1=周一 … 7=周日
  peakWeekdays: [1, 2, 3, 4, 5],
  holidays: CN_HOLIDAYS,
  models: {
    'deepseek-flash': {
      label: 'DeepSeek-V4.1-Flash',
      off: { cacheHit: 0.003, cacheMiss: 0.15, cacheWrite: 0.15, output: 0.6 }
    },
    // 實際送進 DSH 的模型 id（config 的 dsh.model）；少了這個別名，
    // 每一筆都會被當成未登記模型。價格與 deepseek-flash 相同。
    'deepseek-v4.1-flash': {
      label: 'DeepSeek-V4.1-Flash',
      off: { cacheHit: 0.003, cacheMiss: 0.15, cacheWrite: 0.15, output: 0.6 }
    },
    'deepseek-v4-flash': {
      label: 'DeepSeek-V4.1-Flash（旧模型名）',
      off: { cacheHit: 0.003, cacheMiss: 0.15, cacheWrite: 0.15, output: 0.6 }
    },
    'deepseek-v4-flash-vision-exp': {
      label: 'DeepSeek-V4.1-Flash（视觉实验名）',
      off: { cacheHit: 0.003, cacheMiss: 0.15, cacheWrite: 0.15, output: 0.6 }
    },
    'deepseek-v4-pro': {
      label: 'DeepSeek-V4-Pro-0813',
      off: { cacheHit: 0.022, cacheMiss: 0.66, cacheWrite: 0.66, output: 1.98 }
    },
    'deepseek-pro': {
      label: 'DeepSeek-V4-Pro-0813（旧模型名）',
      off: { cacheHit: 0.022, cacheMiss: 0.66, cacheWrite: 0.66, output: 1.98 }
    }
  },
  // 未知模型的兜底价：按 flash 计，并在返回值里标 estimated=true，控制台会提示。
  fallbackModel: 'deepseek-flash'
};

/** 合并用户配置的价目表覆盖项（config.json 的 `pricing` 字段），失败时回落到默认表。 */
export function resolvePriceTable(override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return { ...DEFAULT_PRICE_TABLE, models: { ...DEFAULT_PRICE_TABLE.models } };
  }
  const merged = {
    ...DEFAULT_PRICE_TABLE,
    ...override,
    // 币别固定跟内置单价表一致：只改 currency 不改单价，会把同一组数字当成另一种货币，
    // 账面上差好几倍而且不报错。要换币别就整张表一起换，不要只改这两个字段。
    currency: DEFAULT_PRICE_TABLE.currency,
    symbol: DEFAULT_PRICE_TABLE.symbol,
    models: { ...DEFAULT_PRICE_TABLE.models },
    peakWindows: Array.isArray(override.peakWindows) ? override.peakWindows : DEFAULT_PRICE_TABLE.peakWindows,
    peakWeekdays: Array.isArray(override.peakWeekdays) ? override.peakWeekdays : DEFAULT_PRICE_TABLE.peakWeekdays,
    holidays: Array.isArray(override.holidays) ? override.holidays : DEFAULT_PRICE_TABLE.holidays
  };
  if (override.models && typeof override.models === 'object' && !Array.isArray(override.models)) {
    for (const [name, entry] of Object.entries(override.models)) {
      const base = DEFAULT_PRICE_TABLE.models[name];
      if (!entry || typeof entry !== 'object') continue;
      const given = entry.off ?? {};
      const off = { ...(base?.off ?? DEFAULT_PRICE_TABLE.models[DEFAULT_PRICE_TABLE.fallbackModel].off), ...given };
      // 只有用户/内置条目**自己**没写 cacheWrite 时才跟随 cacheMiss；
      // 否则会从兜底模型继承一个不相干的 cacheWrite 价（静默算错钱）。
      if (!Number.isFinite(Number(given.cacheWrite))) off.cacheWrite = off.cacheMiss;
      merged.models[name] = { label: entry.label ?? base?.label ?? name, off };
    }
  }
  if (typeof merged.fallbackModel !== 'string' || !merged.models[merged.fallbackModel]) {
    merged.fallbackModel = DEFAULT_PRICE_TABLE.fallbackModel;
  }
  if (!Number.isFinite(merged.peakMultiplier) || merged.peakMultiplier <= 0) merged.peakMultiplier = 2;
  if (!Number.isFinite(merged.unit) || merged.unit <= 0) merged.unit = 1e6;
  if (typeof merged.version !== 'string' || !merged.version) merged.version = PRICE_TABLE_VERSION;
  return merged;
}

/** 把任意时间戳换算成北京时间的日历分量（不依赖运行机器的本地时区）。 */
export function beijingParts(atMs) {
  const d = new Date(Number(atMs) + BEIJING_OFFSET_MINUTES * 60000);
  const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // 1=周一 … 7=周日
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return {
    weekday,
    hour: d.getUTCHours(),
    date: `${d.getUTCFullYear()}-${month}-${day}`,
    clock: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  };
}

/** 判断某一时刻是否落在高峰时段。 */
export function isPeakAt(atMs, table = DEFAULT_PRICE_TABLE) {
  const ms = Number(atMs);
  if (!Number.isFinite(ms)) return false;
  const { weekday, hour, date } = beijingParts(ms);
  if (!table.peakWeekdays.includes(weekday)) return false;
  const holidays = table.holidays instanceof Set ? table.holidays : new Set(table.holidays ?? []);
  if (holidays.has(date)) return false;
  return (table.peakWindows ?? []).some(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && hour >= start && hour < end);
}

/** 取某模型在某一时刻生效的单价（含峰谷判定）。 */
export function ratesAt(model, atMs, table = DEFAULT_PRICE_TABLE) {
  const key = String(model ?? '').trim();
  const entry = table.models[key];
  const chosen = entry ?? table.models[table.fallbackModel];
  const off = chosen.off;
  const peak = isPeakAt(atMs, table);
  const factor = peak ? table.peakMultiplier : 1;
  return {
    model: key || table.fallbackModel,
    label: chosen.label,
    tier: peak ? 'peak' : 'off',
    tierLabel: peak ? '高峰时段' : '空闲时段',
    currency: table.currency,
    symbol: table.symbol,
    unit: table.unit,
    estimated: !entry,
    cacheHit: off.cacheHit * factor,
    cacheMiss: off.cacheMiss * factor,
    cacheWrite: (Number.isFinite(off.cacheWrite) ? off.cacheWrite : off.cacheMiss) * factor,
    output: off.output * factor
  };
}

/**
 * 把 usage 归一化成四个互不重叠的计费桶。
 *
 * 同时接受两种键名，这一点是**必须**的：
 *   - DSH 原始口径：`inputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `outputTokens`；
 *   - 账本落盘口径：`cacheMiss` / `cacheHit` / `cacheWrite` / `output`。
 * 只认一种会在「写盘 → 重新载入」时把桶读成 0（花费凭空少一截），所以两种都读。
 */
export function normalizeUsage(usage) {
  const pick = (value, ...keys) => {
    for (const key of keys) {
      const v = Number(value?.[key]);
      if (Number.isFinite(v) && v > 0) return Math.round(v);
    }
    return 0;
  };
  if (!usage || typeof usage !== 'object') {
    return { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  }
  return {
    // DSH 的 inputTokens 是「未命中」部分，不是总输入。
    cacheMiss: pick(usage, 'cacheMiss', 'uncachedInputTokens', 'inputTokens'),
    cacheHit: pick(usage, 'cacheHit', 'cacheReadTokens'),
    cacheWrite: pick(usage, 'cacheWrite', 'cacheWriteTokens'),
    output: pick(usage, 'output', 'outputTokens'),
    reasoning: pick(usage, 'reasoning', 'reasoningTokens')
  };
}

/** 四个桶求和（token 总量）。 */
export function totalTokensOf(buckets) {
  return (buckets?.cacheMiss ?? 0) + (buckets?.cacheHit ?? 0) + (buckets?.cacheWrite ?? 0) + (buckets?.output ?? 0);
}

/**
 * 按单价把 token 桶折算成金额。
 * @param buckets 归一化后的四个桶
 * @param rates   `ratesAt()` 的返回值
 * @returns 分项金额与合计（单位同 rates.currency）
 */
export function costOfBuckets(buckets, rates) {
  const b = buckets ?? {};
  const cacheHit = ((b.cacheHit ?? 0) / rates.unit) * rates.cacheHit;
  const cacheMiss = ((b.cacheMiss ?? 0) / rates.unit) * rates.cacheMiss;
  const cacheWrite = ((b.cacheWrite ?? 0) / rates.unit) * rates.cacheWrite;
  const output = ((b.output ?? 0) / rates.unit) * rates.output;
  return {
    cacheHit,
    cacheMiss,
    cacheWrite,
    output,
    total: cacheHit + cacheMiss + cacheWrite + output
  };
}

/** 一步到位：给桶 + 时间 + 模型，直接算钱。 */
export function priceUsage(buckets, { model, at, table = DEFAULT_PRICE_TABLE } = {}) {
  const rates = ratesAt(model, at, table);
  return { rates, cost: costOfBuckets(buckets, rates) };
}

/** 空桶常量（避免各处重复字面量）。 */
export const ZERO_BUCKETS = Object.freeze({ cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 });

/** 桶相加。 */
export function addBuckets(a, b) {
  return {
    cacheMiss: (a?.cacheMiss ?? 0) + (b?.cacheMiss ?? 0),
    cacheHit: (a?.cacheHit ?? 0) + (b?.cacheHit ?? 0),
    cacheWrite: (a?.cacheWrite ?? 0) + (b?.cacheWrite ?? 0),
    output: (a?.output ?? 0) + (b?.output ?? 0),
    reasoning: (a?.reasoning ?? 0) + (b?.reasoning ?? 0)
  };
}

/** 桶相减（用于「基线之后」的增量），逐桶下限为 0。 */
export function subBuckets(a, b) {
  const s = (x, y) => Math.max(0, (x ?? 0) - (y ?? 0));
  return {
    cacheMiss: s(a?.cacheMiss, b?.cacheMiss),
    cacheHit: s(a?.cacheHit, b?.cacheHit),
    cacheWrite: s(a?.cacheWrite, b?.cacheWrite),
    output: s(a?.output, b?.output),
    reasoning: s(a?.reasoning, b?.reasoning)
  };
}
