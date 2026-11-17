// DSH 的 hedge LLM adapter。
//
// 為什麼要做在這一層：DSH 的 session 一次只跑一個模型，同一個 session 的 prompt 會排隊，
// 也沒有 per-request 換模型的參數。橋接層要並行只能 fork 第二個 session，輸的那邊可能已經
// 呼叫過 send_message，會重複發訊息。adapter 層拿到的是同一個 request，兩邊都還沒把 tool
// call 交給 agent loop，所以在這裡 abort 輸家是安全的。
//
// 流程：先打主線；afterMs 內拿到第一個 token 就只走主線。超過才啟動備援，兩個 stream
// 賽跑，第一個 token 勝出、另一個立刻 abort。主線本來就快時完全不碰備援。
import z from '@deepseek-ai/schemastery';

export const name = 'dsh-llm-hedge';
export const inject = ['llm', 'settings'];

const HEDGE = 'hedge';

export const Config = z.object({
  enabled: z.boolean().default(false).extra('volatile', true),
  afterMs: z.number().default(12000).extra('volatile', true),
  primaryProvider: z.string().default('commandcode').extra('volatile', true),
  primaryModel: z.string().default('deepseek/deepseek-v4.1-flash').extra('volatile', true),
  primaryEffort: z.string().default('').extra('volatile', true),
  fallbackProvider: z.string().default('opencode-go').extra('volatile', true),
  fallbackModel: z.string().default('deepseek-v4.1-flash').extra('volatile', true),
  fallbackEffort: z.string().default('').extra('volatile', true),
});

/** DSH 傳進來的 signal 不一定是同一個 realm 的 AbortSignal；包一層再交給 provider。 */
function sanitizeSignal(signal) {
  if (!signal) return undefined;
  if (signal instanceof AbortSignal) return signal;
  const controller = new AbortController();
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener?.('abort', () => controller.abort(signal.reason), { once: true });
  return controller.signal;
}

function combineSignals(...signals) {
  const list = signals.filter(Boolean).map(sanitizeSignal);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  // 不用 AbortSignal.any：DSH 傳進來的 signal 不一定通過它的 brand 檢查。
  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) { controller.abort(signal.reason); break; }
    signal.addEventListener?.('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/** 等 promise，但最多等 ms；逾時回 `{ type: 'timeout' }`，不會 reject。 */
function withTimeout(promise, ms) {
  if (ms === null || ms === undefined) return promise;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ type: 'timeout' }), Math.max(0, ms));
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); resolve({ type: 'error', error }); },
    );
  });
}

const pull = (iterator) => iterator.next().then(
  (result) => ({ type: 'value', result }),
  (error) => ({ type: 'error', error }),
);

const TOKEN_TYPES = new Set(['text-delta', 'reasoning-delta', 'tool-call-delta']);
const isTokenChunk = (chunk) => {
  if (!TOKEN_TYPES.has(chunk?.type)) return false;
  if (chunk.type === 'tool-call-delta') return (chunk.argumentsDelta ?? '') !== '' || chunk.name !== undefined;
  return (chunk.text ?? '') !== '';
};

const isErrorEnd = (state) => {
  const kind = state?.chunk?.reason?.kind;
  return kind === 'error' || kind === 'aborted';
};

/**
 * 拿到第一個 token；block-start 這類開場 chunk 先收集起來，
 * 不能拿它當「模型開始回答」——它可能在 HTTP 回應前就送出了。
 */
async function firstToken(iterator, timeoutMs) {
  const leading = [];
  const started = Date.now();
  let pending = pull(iterator);
  for (;;) {
    const left = timeoutMs === null ? null : Math.max(0, timeoutMs - (Date.now() - started));
    const raced = await withTimeout(pending, left);
    if (raced.type === 'timeout') return { type: 'timeout', pending, leading };
    if (raced.type === 'error') return { type: 'error', error: raced.error, leading };
    if (raced.result.done) return { type: 'end', chunk: null, leading };
    const chunk = raced.result.value;
    if (chunk?.type === 'finish') return { type: 'end', chunk, leading };
    if (!isTokenChunk(chunk)) { leading.push(chunk); pending = pull(iterator); continue; }
    return { type: 'token', chunk, leading };
  }
}

/** 逾時後回頭接上同一個 iterator 的第一個 token。 */
async function continueFirst(iterator, pending, leading) {
  const raced = await pending;
  if (raced.type === 'error') return { type: 'error', error: raced.error, leading };
  if (raced.result.done) return { type: 'end', chunk: null, leading };
  const chunk = raced.result.value;
  if (chunk?.type === 'finish') return { type: 'end', chunk, leading };
  if (!isTokenChunk(chunk)) return firstToken(iterator, null).then((next) => ({
    ...next,
    leading: [...leading, chunk, ...(next.leading ?? [])],
  }));
  return { type: 'token', chunk, leading };
}

async function* drain(iterator) {
  for (;;) {
    const result = await iterator.next();
    if (result.done) return;
    yield result.value;
  }
}

export class HedgeAdapter {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.liveCache = null;
  }

  providerInfo(provider) {
    return { id: provider, name: 'Hedge（主線 + 備援）' };
  }

  providerRetryPolicy() {
    return undefined;
  }

  imageRequestPricing() {
    return undefined;
  }

  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes };
  }

  /** apply() 拿到的 config 是啟動時快照；即時值要每個請求讀一次，短暫快取避免目錄查詢被拖慢。 */
  live() {
    const now = Date.now();
    if (this.liveCache && now - this.liveCache.at < 2000) return this.liveCache.value;
    let values = {};
    try {
      const settings = this.ctx.get?.('settings') ?? this.ctx.settings;
      const row = settings?.describe?.().find((item) => item.ns === 'llm-hedge');
      // DSH 0.2.1 寫完 settings 後 value 可能還是舊的；user 層是剛寫進去的值。
      // 橋接推送前已用 normalizeHedgeConfig 驗證，所以這裡直接覆蓋是安全的。
      values = { ...(row?.value ?? {}), ...(row?.user ?? {}) };
    } catch {
      values = {};
    }
    const read = (key) => {
      if (Object.hasOwn(values, key) && values[key] !== undefined) return values[key];
      const value = this.config?.[key];
      return value && typeof value.get === 'function' ? value.get() : value;
    };
    const value = { read };
    this.liveCache = { at: now, value };
    return value;
  }

  route(side, live = this.live()) {
    const read = (key) => String(live.read(key) ?? '').trim();
    const provider = read(`${side}Provider`);
    const model = read(`${side}Model`);
    return {
      provider,
      model,
      reasoningEffort: read(`${side}Effort`),
      ready: Boolean(provider && model),
    };
  }

  async listModels() {
    const primary = this.route('primary');
    if (!primary.ready || primary.provider === HEDGE) return [];
    try {
      const info = await this.ctx.llm.resolveModelInfo(primary.provider, primary.model);
      return [{
        provider: HEDGE,
        id: primary.model,
        name: info.name ?? primary.model,
        ...info.description === undefined ? {} : { description: info.description },
        inputModalities: info.inputModalities ?? ['text'],
        ...info.reasoning === undefined ? {} : { reasoning: info.reasoning },
      }];
    } catch {
      // 主線壞掉時仍要留下最小條目，控制台才能把主線改回來。
      return [{ provider: HEDGE, id: primary.model, name: primary.model, inputModalities: ['text'] }];
    }
  }

  async resolveModel(provider, model, signal) {
    const primary = this.route('primary');
    if (!primary.ready) throw new Error('dsh-llm-hedge: 主線 provider/model 是空的');
    if (primary.provider === HEDGE) throw new Error('dsh-llm-hedge: 主線不能再指回 hedge');
    const prepared = await this.ctx.llm.resolveModelInfo(primary.provider, primary.model, sanitizeSignal(signal));
    const info = prepared ?? {};
    return { ...info, provider, id: model, name: info.name ?? model };
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    };
  }

  /** 用同一個 request 打某條線路；signal 不能放進 config，DSH 會把它 clone 成普通物件。 */
  open(route, options, signal, inheritEffort = false) {
    const request = { ...options, provider: route.provider, model: route.model, signal };
    const effort = route.reasoningEffort || (inheritEffort ? options.reasoningEffort : '');
    if (effort) request.reasoningEffort = effort;
    else delete request.reasoningEffort;
    return this.ctx.llm.stream(request);
  }

  async *stream(options) {
    const live = this.live();
    const primary = this.route('primary', live);
    const fallback = this.route('fallback', live);
    if (!primary.ready) throw new Error('dsh-llm-hedge: 主線 provider/model 是空的');
    const primaryControl = new AbortController();
    let fallbackControl = null;
    let primaryIt = null;
    let fallbackIt = null;
    let activeIt = null;
    try {
      const primaryStream = this.open(primary, options, combineSignals(options.signal, primaryControl.signal), true);
      const enabled = live.read('enabled') !== false && fallback.ready && fallback.provider !== HEDGE;
      if (!enabled) {
        yield* primaryStream;
        return;
      }

      const afterMs = Math.max(0, Number(live.read('afterMs')) || 0);
      primaryIt = primaryStream[Symbol.asyncIterator]();
      const first = await firstToken(primaryIt, afterMs);
      if (first.type === 'token') {
        activeIt = primaryIt;
        yield* first.leading;
        yield first.chunk;
        yield* drain(primaryIt);
        return;
      }
      // 主線正常結束（例如空回覆）就直接用它，不要為了「沒有 token」再打備援。
      if (first.type === 'end' && !isErrorEnd(first)) {
        yield* first.leading;
        if (first.chunk) yield first.chunk;
        return;
      }
      // 使用者已經取消：不要再開備援。
      if (options.signal?.aborted) {
        yield* first.leading;
        if (first.chunk) yield first.chunk;
        return;
      }

      // 主線逾時、出錯或被取消才啟動備援。
      console.error(`[dsh-llm-hedge] 主線 ${afterMs}ms 沒有 token，啟動備援 ${fallback.provider}/${fallback.model}`);
      let fallbackState = null;
      try {
        fallbackControl = new AbortController();
        const fallbackStream = this.open(fallback, options, combineSignals(options.signal, fallbackControl.signal));
        fallbackIt = fallbackStream[Symbol.asyncIterator]();
        fallbackState = firstToken(fallbackIt, null);
      } catch (error) {
        console.error(`[dsh-llm-hedge] 備援線路啟動失敗（${fallback.provider}/${fallback.model}）：${error?.message ?? error}`);
      }

      let primaryState = first.type === 'timeout'
        ? continueFirst(primaryIt, first.pending, first.leading)
        : Promise.resolve(first);
      let primaryEnd = null;
      let fallbackEnd = null;
      let primaryError = null;
      let fallbackError = null;
      let winner = null;

      for (;;) {
        const races = [];
        if (primaryState) races.push(primaryState.then((state) => ({ side: 'primary', state })));
        if (fallbackState) races.push(fallbackState.then((state) => ({ side: 'fallback', state })));
        if (races.length === 0) break;
        const { side, state } = await Promise.race(races);
        if (state.type === 'token') { winner = { side, chunk: state.chunk, leading: state.leading ?? [] }; break; }
        if (state.type === 'end') {
          // 主線或備援正常結束（不是 error/aborted）就算勝出，不再等另一邊。
          if (!isErrorEnd(state)) { winner = { side, ...state }; break; }
          if (side === 'primary') { primaryEnd = state; primaryState = null; }
          else { fallbackEnd = state; fallbackState = null; }
          if (!primaryState && !fallbackState) {
            winner = primaryEnd ? { side: 'primary', ...primaryEnd } : { side: 'fallback', ...fallbackEnd };
            break;
          }
          continue;
        }
        if (state.type === 'error') {
          if (side === 'primary') { primaryError = state.error; primaryState = null; }
          else { fallbackError = state.error; fallbackState = null; }
          if (!primaryState && !fallbackState) {
            // 一邊出錯、另一邊已經結束：用結束的那邊，不要丟掉有效結果。
            if (primaryEnd) { winner = { side: 'primary', ...primaryEnd }; break; }
            if (fallbackEnd) { winner = { side: 'fallback', ...fallbackEnd }; break; }
            throw primaryError ?? fallbackError;
          }
        }
      }

      if (!winner) return;
      const winnerIt = winner.side === 'fallback' ? fallbackIt : primaryIt;
      const loserIt = winner.side === 'fallback' ? primaryIt : fallbackIt;
      const loserControl = winner.side === 'fallback' ? primaryControl : fallbackControl;
      if (loserControl) {
        loserControl.abort();
        try { loserIt?.return?.()?.catch?.(() => {}); } catch { /* 已經關了 */ }
      }
      activeIt = winnerIt;
      console.error(`[dsh-llm-hedge] ${winner.side === 'fallback' ? '備援' : '主線'}勝出`);
      yield* winner.leading ?? [];
      if (winner.chunk) yield winner.chunk;
      if (!winnerIt) return;
      yield* drain(winnerIt);
    } finally {
      // 消費者提早 break / return 時，底層 generator 也要收掉，不然 provider 連線會留著。
      // 輸家不能 await：它的 next() 可能卡在一個不理 abort 的等待，會拖住整個 stream。
      primaryControl.abort();
      fallbackControl?.abort();
      for (const iterator of [primaryIt, fallbackIt]) {
        if (!iterator) continue;
        let closing;
        try { closing = iterator.return?.(); } catch { closing = undefined; }
        if (iterator === activeIt) {
          try { await closing; } catch { /* 已經關了 */ }
        } else {
          void closing?.catch?.(() => {});
        }
      }
    }
  }
}

export function apply(ctx, config) {
  ctx.llm.registerAdapter([HEDGE], new HedgeAdapter(ctx, config));
}
