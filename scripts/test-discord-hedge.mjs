// dsh-llm-hedge 的離線回歸：用假的 ctx.llm 驗證「先主線、逾時才備援、第一個 token 勝出」。
//   node scripts/test-discord-hedge.mjs
import { HedgeAdapter } from '../plugins/dsh-llm-hedge/lib/index.js';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function config(values) {
  const merged = {
    enabled: true,
    afterMs: 50,
    primaryProvider: 'primary',
    primaryModel: 'primary/model',
    primaryEffort: '',
    fallbackProvider: 'fallback',
    fallbackModel: 'fallback/model',
    fallbackEffort: '',
    ...values,
  };
  return Object.fromEntries(Object.entries(merged).map(([key, value]) => [key, { get: () => value }]));
}

async function* chunks(label, { delayMs = 0, signal, record, empty = false, fail = false, ignoreAbort = false }) {
  let aborted = false;
  const onAbort = () => { aborted = true; record.aborted = true; };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (delayMs) {
      await (ignoreAbort ? sleep(delayMs) : Promise.race([sleep(delayMs), new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }))]));
    }
    if (aborted && !ignoreAbort) { yield { type: 'finish', reason: { kind: 'aborted' } }; return; }
    if (fail) { yield { type: 'finish', reason: { kind: 'error', failure: { message: `${label} failed` } } }; return; }
    if (empty) { yield { type: 'finish', reason: { kind: 'completed' } }; return; }
    yield { type: 'text-delta', text: `${label}-1` };
    yield { type: 'text-delta', text: `${label}-2` };
    yield { type: 'finish', reason: { kind: 'completed' } };
  } finally {
    record.closed = true;
  }
}

function fakeCtx({ primary = {}, fallback = {} } = {}) {
  const calls = { primary: 0, fallback: 0 };
  const records = { primary: { aborted: false, closed: false }, fallback: { aborted: false, closed: false } };
  const routes = { primary, fallback };
  return {
    calls,
    records,
    llm: {
      async resolveModelInfo(provider, model) {
        return { provider, id: model, name: `${provider} model`, inputModalities: ['text'] };
      },
      stream(request) {
        const side = request.provider;
        calls[side] = (calls[side] ?? 0) + 1;
        records[side].effort = request.reasoningEffort;
        const route = routes[side];
        if (!route) throw new Error(`no route ${side}`);
        if (route.prepareError) throw route.prepareError;
        return chunks(side, { ...route, signal: request.signal, record: records[side] });
      },
    },
    logger: { info: () => {}, warn: () => {} },
  };
}

async function collect(adapter, options = {}) {
  const out = [];
  for await (const chunk of adapter.stream({ provider: 'hedge', model: 'primary/model', messages: [], ...options })) {
    out.push(chunk);
  }
  return out;
}

const textOf = (chunks) => chunks.map((chunk) => chunk.text ?? chunk.type).join(',');

console.log('## dsh-llm-hedge');
{
  // 主線很快：完全不啟動備援。
  const fast = fakeCtx({ primary: { delayMs: 5 }, fallback: { delayMs: 5 } });
  const fastAdapter = new HedgeAdapter(fast, config({ afterMs: 100 }));
  const fastChunks = await collect(fastAdapter);
  ok(textOf(fastChunks) === 'primary-1,primary-2,finish', '主線在門檻內就先吐 token，只走主線');
  ok(fast.calls.fallback === 0, '主線夠快時不啟動備援');

  // 主線太慢：備援第一個 token 勝出，主線被 abort。
  const slow = fakeCtx({ primary: { delayMs: 200 }, fallback: { delayMs: 10 } });
  const slowAdapter = new HedgeAdapter(slow, config({ afterMs: 30 }));
  const slowChunks = await collect(slowAdapter);
  ok(textOf(slowChunks) === 'fallback-1,fallback-2,finish', '主線逾時後由備援接手');
  ok(slow.records.primary.aborted === true, '備援勝出後 abort 主線');

  // 兩邊都慢，但主線的第一個 token 還是先到：主線勝出、備援被 abort。
  const race = fakeCtx({ primary: { delayMs: 60 }, fallback: { delayMs: 200 } });
  const raceAdapter = new HedgeAdapter(race, config({ afterMs: 20 }));
  const raceChunks = await collect(raceAdapter);
  ok(textOf(raceChunks) === 'primary-1,primary-2,finish', '備援啟動後主線仍可勝出');
  ok(race.records.fallback.aborted === true, '主線勝出後 abort 備援');

  // 輸家不理 abort：不能讓它的 return() 拖住整個 stream。
  const stuck = fakeCtx({ primary: { delayMs: 200, ignoreAbort: true }, fallback: { delayMs: 5 } });
  const stuckAdapter = new HedgeAdapter(stuck, config({ afterMs: 1 }));
  const stuckStarted = Date.now();
  const stuckChunks = await collect(stuckAdapter);
  const stuckElapsed = Date.now() - stuckStarted;
  ok(textOf(stuckChunks) === 'fallback-1,fallback-2,finish', '輸家不理 abort 時備援仍完成');
  ok(stuckElapsed < 100, '輸家卡住不會拖住 stream');

  // 備援線路壞掉：主線照常跑完。
  const broken = fakeCtx({ primary: { delayMs: 40 }, fallback: { prepareError: new Error('no key') } });
  const brokenAdapter = new HedgeAdapter(broken, config({ afterMs: 10 }));
  const brokenChunks = await collect(brokenAdapter);
  ok(textOf(brokenChunks) === 'primary-1,primary-2,finish', '備援啟動失敗時主線照常完成');

  // 關閉備援：只走主線。
  const off = fakeCtx({ primary: { delayMs: 40 }, fallback: { delayMs: 1 } });
  const offAdapter = new HedgeAdapter(off, config({ enabled: false, afterMs: 1 }));
  const offChunks = await collect(offAdapter);
  ok(textOf(offChunks) === 'primary-1,primary-2,finish', '備援關閉時只走主線');
  ok(off.calls.fallback === 0, '備援關閉時不建立備援線路');

  // 備援 effort 留空時不能繼承主線的 effort。
  const efforts = fakeCtx({ primary: { delayMs: 1 }, fallback: { delayMs: 20 } });
  const effortsAdapter = new HedgeAdapter(efforts, config({ afterMs: 5, primaryEffort: 'high', fallbackEffort: '' }));
  await collect(effortsAdapter, { reasoningEffort: 'max' });
  ok(efforts.records.primary.effort === 'high', '主線用自己的 effort');
  ok(efforts.records.fallback.effort === undefined, '備援留空時不繼承主線 effort');

  // 主線正常結束（沒有 token）：直接用主線結果，不啟動備援。
  const emptyPrimary = fakeCtx({ primary: { empty: true }, fallback: { delayMs: 1 } });
  const emptyAdapter = new HedgeAdapter(emptyPrimary, config({ afterMs: 5 }));
  const emptyChunks = await collect(emptyAdapter);
  ok(textOf(emptyChunks) === 'finish', '主線正常結束就不啟動備援');
  ok(emptyPrimary.calls.fallback === 0, '空回覆不浪費備援請求');

  // 主線出錯、備援正常回答：用備援的 token。
  const errorThenToken = fakeCtx({ primary: { fail: true }, fallback: { delayMs: 1 } });
  const errorThenTokenAdapter = new HedgeAdapter(errorThenToken, config({ afterMs: 5 }));
  const errorThenTokenChunks = await collect(errorThenTokenAdapter);
  ok(textOf(errorThenTokenChunks) === 'fallback-1,fallback-2,finish', '主線出錯時由備援接手回答');

  // 主線出錯、備援正常結束：用備援的結束結果，不要丟錯。
  const errorThenEnd = fakeCtx({ primary: { fail: true }, fallback: { empty: true } });
  const errorThenEndAdapter = new HedgeAdapter(errorThenEnd, config({ afterMs: 5 }));
  const errorThenEndChunks = await collect(errorThenEndAdapter);
  ok(textOf(errorThenEndChunks) === 'finish', '主線出錯時由備援的結束結果接手');

  // 兩邊都出錯：回傳主線的錯誤 finish（runtime 會把它變成失敗）。
  const bothFail = fakeCtx({ primary: { fail: true }, fallback: { fail: true } });
  const bothFailAdapter = new HedgeAdapter(bothFail, config({ afterMs: 5 }));
  const bothFailChunks = await collect(bothFailAdapter);
  const lastBoth = bothFailChunks.at(-1);
  ok(lastBoth?.type === 'finish' && lastBoth?.reason?.kind === 'error', '兩邊都出錯時回傳錯誤 finish');

  // afterMs = 0：立即啟動備援，不能無限等主線。
  const zero = fakeCtx({ primary: { delayMs: 50 }, fallback: { delayMs: 5 } });
  const zeroAdapter = new HedgeAdapter(zero, config({ afterMs: 0 }));
  const zeroChunks = await collect(zeroAdapter);
  ok(textOf(zeroChunks) === 'fallback-1,fallback-2,finish', 'afterMs=0 時立即由備援接手');

  // 消費者提早結束：底層 generator 要收到 return。
  const early = fakeCtx({ primary: { delayMs: 1 }, fallback: { delayMs: 1 } });
  const earlyAdapter = new HedgeAdapter(early, config({ afterMs: 1 }));
  const iterator = earlyAdapter.stream({ provider: 'hedge', model: 'primary/model', messages: [] });
  await iterator.next();
  await iterator.return();
  await sleep(5);
  ok(early.records.primary.closed === true, '消費者提早結束時關掉底層 stream');

  // 目錄與模型資訊：對外只露出一個 hedge 模型，provider 換成 hedge。
  const meta = fakeCtx({ primary: { delayMs: 1 } });
  const metaAdapter = new HedgeAdapter(meta, config({}));
  const models = await metaAdapter.listModels();
  ok(models.length === 1 && models[0].provider === 'hedge' && models[0].id === 'primary/model', '目錄只露出主線的 model id');
  const info = await metaAdapter.resolveModel('hedge', 'primary/model');
  ok(info.provider === 'hedge' && info.id === 'primary/model' && info.name === 'primary model', '模型資訊換成 hedge provider');

  // 主線指回 hedge 會無限遞迴，必須直接拒絕。
  const recursive = fakeCtx({ primary: { delayMs: 1 } });
  const recursiveAdapter = new HedgeAdapter(recursive, config({ primaryProvider: 'hedge' }));
  let recursiveError = null;
  try { await recursiveAdapter.resolveModel('hedge', 'primary/model'); } catch (error) { recursiveError = error; }
  ok(recursiveError && /hedge/.test(String(recursiveError.message)), '主線指回 hedge 要拒絕');
}

console.log(failures === 0 ? '\n✅ dsh-llm-hedge 通過' : `\n❌ ${failures} 項失敗`);
process.exit(failures === 0 ? 0 : 1);
