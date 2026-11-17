// 歷史歸檔的離線回歸：不需要 Qdrant，也不需要 oMLX。
//   node scripts/test-discord-history-archive.mjs
import {
  ARCHIVE_DIMENSIONS,
  archiveCollectionName,
  archiveText,
  createArchive,
  pointIdFor,
  worthArchiving,
} from '../src/core/discord-history-archive.mjs';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
}

const QD = 'http://q';
const EM = 'http://e';

/** 假 fetch：routes 逐條比對 "METHOD url"，回傳 [status, json]。 */
function fakeFetch(routes = []) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, body, headers: init.headers ?? {} });
    const key = `${method} ${url}`;
    const hit = routes.find(([match]) => (match instanceof RegExp ? match.test(key) : match === key));
    const [status, json] = hit ? hit[1] : [200, {}];
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json) };
  };
  impl.calls = calls;
  return impl;
}

const vector = (n = ARCHIVE_DIMENSIONS) => Array.from({ length: n }, () => 0.01);
const embedOk = (count) => ({ data: Array.from({ length: count }, () => ({ embedding: vector() })) });
const COLLECTION_OK = [200, { result: { config: { params: { vectors: { size: ARCHIVE_DIMENSIONS, distance: 'Cosine' } } } } }];
const USER = '1303011129936711771';

console.log('## 1. 純函式');
{
  const id = '1303011129936711771';
  ok(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pointIdFor(id)), '點 id 是 uuid v5 形狀');
  ok(pointIdFor(id) === pointIdFor(id), '同一個訊息 id 永遠同一個點');
  ok(pointIdFor(id) !== pointIdFor(`${id}1`), '不同訊息不同點');
  ok(archiveCollectionName('dc_history') === 'dc_history', '合法集合名稱');
  ok(archiveCollectionName('dc/../x') === 'dc_history', '非法集合名稱退回預設');
  let reserved = null;
  try { archiveCollectionName('personal_memory_v2'); } catch (e) { reserved = e; }
  ok(reserved && /personal_memory_v2/.test(reserved.message), '拒絕使用別的服務的集合');
  ok(archiveText({ author: '魚丸', text: ' 今天  好累 ' }) === '魚丸：今天 好累', '向量文字帶作者、壓掉多餘空白');
  ok(archiveText({ author: '', text: 'hi' }) === '某人：hi', '沒有名字標某人');
  ok(archiveText({ author: '魚丸', text: '' }) === '', '空訊息不進向量');
  ok(archiveText({ author: 'a', text: 'x'.repeat(2000) }).length === 1001, '向量文字截在 1000 字');
  ok(!worthArchiving('笑死'), '兩個字不進向量');
  ok(!worthArchiving('<:kekw:1234> 😂 https://x.tw/a'), '純表情與連結不進向量');
  ok(!worthArchiving('<@123456789012345678> +1'), '只有提及與 +1 不進向量');
  ok(worthArchiving('今天考試考完了'), '正常句子進向量');
}

console.log('## 2. 建立集合');
{
  const f = fakeFetch([['GET http://q/collections/dc_history', [404, {}]]]);
  const archive = createArchive({ qdrantUrl: QD, embedUrl: EM, fetchImpl: f });
  await archive.ensure();
  const create = f.calls.find((c) => c.method === 'PUT' && c.url === 'http://q/collections/dc_history');
  ok(Boolean(create), '沒有集合時才建立');
  ok(create.body.vectors.size === ARCHIVE_DIMENSIONS && create.body.vectors.distance === 'Cosine', '向量大小與距離');
  ok(create.body.quantization_config.scalar.type === 'int8', '開啟 int8 量化');
  ok(create.body.vectors.on_disk === true && create.body.hnsw_config.on_disk === true, '原始向量與 HNSW 放磁碟');
  ok(f.calls.some((c) => /\/index\?wait=false$/.test(c.url) && c.body.field_name === 'channelId'), '建立 channelId 索引');
  const before = f.calls.length;
  await archive.ensure();
  ok(f.calls.length === before, '第二次不再建集合');

  // 既有集合維度不對：直接停用，不要每次寫入都失敗。
  const wrong = fakeFetch([['GET http://q/collections/dc_history', [200, { result: { config: { params: { vectors: { size: 8, distance: 'Cosine' } } } } }]]]);
  const broken = createArchive({ qdrantUrl: QD, embedUrl: EM, fetchImpl: wrong });
  let mismatch = null;
  try { await broken.append([{ id: '1', author: 'a', text: '測試訊息' }]); } catch (e) { mismatch = e; }
  ok(mismatch && /1024/.test(mismatch.message), '既有集合維度不對就丟錯');
  ok(!wrong.calls.some((c) => c.method === 'PUT'), '維度不對時不寫入');
}

console.log('## 3. 寫入');
{
  const f = fakeFetch([
    ['GET http://q/collections/dc_history', COLLECTION_OK],
    [`POST ${EM}/embeddings`, [200, embedOk(2)]],
  ]);
  const archive = createArchive({ qdrantUrl: QD, embedUrl: EM, apiKey: 'k', fetchImpl: f });
  const n = await archive.append([
    { id: '1', guildId: 'g', channelId: 'c', authorId: 'u1', author: '魚丸', text: '喜歡無糖綠', at: 1000, mentionIds: ['9'], repliedUserId: '8' },
    { id: '2', guildId: 'g', channelId: 'c', authorId: 'u2', author: '阿明', text: '在準備考試', at: 2000 },
  ]);
  ok(n === 2, '寫入兩則');
  const embed = f.calls.find((c) => c.url === `${EM}/embeddings`);
  ok(embed.body.model === 'bge-m3-mlx-fp16' && embed.body.input.length === 2, '一次 embed 兩則');
  ok(embed.body.input[0] === '魚丸：喜歡無糖綠', 'embedding 文字帶作者');
  ok(embed.headers.authorization === 'Bearer k', '帶 API key');
  const put = f.calls.find((c) => c.method === 'PUT' && /\/points\?wait=true$/.test(c.url));
  ok(put.body.points.length === 2 && put.body.points[0].id === pointIdFor('1'), '點 id 由訊息 id 決定');
  ok(put.body.points[1].payload.at === 2000 && put.body.points[1].payload.text === '在準備考試', 'payload 帶時間與原文');
  ok(put.body.points[0].payload.messageId === '1' && put.body.points[0].payload.mentionIds[0] === '9', 'payload 帶訊息 id 與提及');
  ok(put.body.points[1].vector.length === ARCHIVE_DIMENSIONS, '向量長度 1024');

  const empty = await archive.append([]);
  ok(empty === 0, '空批次不呼叫任何服務');
  const blank = await archive.append([{ id: '3', text: '   ' }]);
  ok(blank === 0, '空訊息不寫');

  const counter = createArchive({ qdrantUrl: QD, embedUrl: EM, fetchImpl: fakeFetch([
    ['GET http://q/collections/dc_history', COLLECTION_OK],
    ['POST http://q/collections/dc_history/points/count', [200, { result: { count: 42 } }]],
  ]) });
  ok(await counter.count() === 42, '控制台的點數用近似 count');
}

console.log('## 4. 查詢');
{
  const f = fakeFetch([
    ['GET http://q/collections/dc_history', COLLECTION_OK],
    [`POST ${EM}/embeddings`, [200, { data: [{ embedding: vector() }] }]],
    ['POST http://q/collections/dc_history/points/query', [200, {
      result: { points: [
        { score: 0.91, payload: { channelId: 'c', authorId: 'u1', at: 1000, text: '喜歡無糖綠' } },
        { score: 0.2, payload: { channelId: 'c', authorId: 'u2', at: 2000, text: '在準備考試' } },
      ] },
    }]],
  ]);
  const archive = createArchive({ qdrantUrl: QD, embedUrl: EM, fetchImpl: f });
  const hits = await archive.search({ query: '喝什麼', channelId: 'c', limit: 5, minScore: 0.5 });
  ok(hits.length === 1 && hits[0].text === '喜歡無糖綠', '低於門檻的不回');
  ok(hits[0].score === 0.91, '回分數');
  const query = f.calls.find((c) => c.url === 'http://q/collections/dc_history/points/query');
  ok(query.body.filter.must[0].key === 'channelId' && query.body.filter.must[0].match.value === 'c', '只搜同一個頻道');
  ok(query.body.limit === 5 && query.body.with_payload === true, 'limit 與 payload');
  ok((await archive.search({ query: '', channelId: 'c' })).length === 0, '空查詢不查');
  ok((await archive.search({ query: 'x' })).length === 0, '沒有頻道不查');
}

console.log('## 4b. 瀏覽（控制台）');
{
  const point = (id, at, messageId) => ({ id, payload: { messageId, at, author: '魚丸', text: `t${at}`, channelId: 'c1' } });
  const f = fakeFetch([
    ['GET http://q/collections/dc_history', COLLECTION_OK],
    ['POST http://q/collections/dc_history/points/scroll', [200, { result: {
      points: [point('u1', 3000, '1303011129936711771'), point('u2', 2000, '1303011129936711772'), point('u3', 2000, '1303011129936711773')],
    } }]],
  ]);
  const archive = createArchive({ qdrantUrl: QD, embedUrl: EM, fetchImpl: f });
  const page = await archive.list({ channelId: 'c1', limit: 2 });
  ok(page.items.length === 2 && page.items[0].messageId === '1303011129936711771', '回訊息 id 與 payload');
  ok(page.items[0].pointId === 'u1', '同時回點 id（游標用）');
  ok(page.next.before === 2000 && page.next.skip.includes('u2'), '下一頁跳過同一個 at 已經回過的點');
  const body = f.calls.at(-1).body;
  ok(body.order_by.key === 'at' && body.order_by.direction === 'desc', 'order_by 是物件、由新到舊');
  ok(body.limit === 3, '多抓一筆判斷有沒有下一頁');
  ok(body.with_vector === false && body.with_payload === true, '只抓 payload');
  ok(!('offset' in body) && body.order_by.start_from === undefined, '第一頁不帶游標');
  ok(body.filter.must.some((m) => m.key === 'channelId' && m.match.value === 'c1'), '頻道過濾');

  await archive.list({ channelId: 'c1', limit: 2, before: 2000, skip: ['u2'] });
  const second = f.calls.at(-1).body;
  ok(second.order_by.start_from === 2000, '第二頁用 start_from');
  ok(second.filter.must_not[0].has_id[0] === 'u2', '第二頁排除已回過的點');

  const empty = fakeFetch([
    ['GET http://q/collections/dc_history', COLLECTION_OK],
    ['POST http://q/collections/dc_history/points/scroll', [200, { result: { points: [point('u1', 3000, '1')] } }]],
  ]);
  const one = createArchive({ qdrantUrl: QD, embedUrl: EM, fetchImpl: empty });
  const last = await one.list({ channelId: 'c1', limit: 20 });
  ok(last.next === null, '不足一頁就不給下一頁');

  const facets = fakeFetch([
    ['GET http://q/collections/dc_history', COLLECTION_OK],
    ['POST http://q/collections/dc_history/facet', [200, { result: { hits: [{ value: 'c1', count: 12 }, { value: 'c2', count: 3 }] } }]],
  ]);
  const channels = await createArchive({ qdrantUrl: QD, embedUrl: EM, fetchImpl: facets }).channels();
  ok(channels.length === 2 && channels[0].channelId === 'c1' && channels[0].count === 12, '頻道清單用 facet');
}

console.log('## 5. 刪除與保留期');{
  const f = fakeFetch([
    ['GET http://q/collections/dc_history', COLLECTION_OK],
    ['POST http://q/collections/dc_history/points/delete?wait=true', [200, { result: { operation_id: 7 } }]],
  ]);
  const archive = createArchive({ qdrantUrl: QD, embedUrl: EM, retentionDays: 360, fetchImpl: f });
  ok(await archive.forgetUser(USER) === USER, '忘了某個人');
  const forget = f.calls.find((c) => c.url.endsWith('/points/delete?wait=true'));
  ok(forget.body.filter.must[0].key === 'authorId' && forget.body.filter.must[0].match.value === USER, '用 authorId 刪');
  let empty = null;
  try { await archive.forgetUser(''); } catch (e) { empty = e; }
  ok(empty && /Discord id/.test(empty.message), '空的 authorId 直接丟錯');
  ok(!f.calls.some((c) => c.body?.filter?.must?.length === 0), '不會送出空的刪除條件');
  const now = 400 * 24 * 60 * 60 * 1000;
  const cutoff = await archive.prune(now);
  ok(cutoff === now - 360 * 24 * 60 * 60 * 1000, '保留期從訊息時間算');
  const prune = f.calls.at(-1);
  ok(prune.body.filter.must[0].key === 'at' && prune.body.filter.must[0].range.lt === cutoff, '只刪超過保留期的點');
  let bad = null;
  try { await archive.prune(Number.NaN); } catch (e) { bad = e; }
  ok(bad && /時間/.test(bad.message), 'NaN 的 now 直接丟錯');
  ok(await archive.deletePoints(['not-an-id']) === 0, '不是 snowflake 的 id 不刪');
  ok(await archive.deletePoints([USER]) === 1, '依訊息 id 刪點');
  const byPoints = f.calls.at(-1);
  ok(byPoints.body.points[0] === pointIdFor(USER), '刪除用的是點 id');
}

console.log('## 6. 失敗處理');
{
  const f = fakeFetch([
    ['GET http://q/collections/dc_history', [500, { status: 'error' }]],
  ]);
  const archive = createArchive({ qdrantUrl: QD, embedUrl: EM, fetchImpl: f });
  let error = null;
  try { await archive.append([{ id: '1', author: 'a', text: 'x' }]); } catch (e) { error = e; }
  ok(error && /500/.test(error.message), 'Qdrant 壞掉會丟錯');
  const readyCalls = f.calls.filter((c) => c.url === 'http://q/collections/dc_history' && c.method === 'GET').length;
  ok(readyCalls === 1, '失敗後不會卡在壞掉的狀態（下次會再試）');
  const again = createArchive({ qdrantUrl: QD, embedUrl: EM, fetchImpl: fakeFetch([
    ['GET http://q/collections/dc_history', [404, {}]],
    ['PUT http://q/collections/dc_history', [200, { result: true }]],
    [`POST ${EM}/embeddings`, [200, embedOk(1)]],
  ]) });
  ok(await again.append([{ id: USER, author: 'a', text: '這是一句測試' }]) === 1, '重新建立後可以寫入');
}

if (failures) {
  console.error(`\n${failures} 項失敗`);
  process.exit(1);
}
console.log('\n全部通過');
