// 歷史歸檔：把看得到的訊息 embed 後存進 Qdrant，之後用意思找回來。
//
// 邊界：
//   - 只有 discord.historyArchive.enabled 時才會碰到 oMLX 與 Qdrant；沒開就完全不連外。
//   - 只存 guild 頻道的人類訊息（deny／不理名單在前面就被擋掉了）。
//   - 點 id 由訊息 id 決定：同一則重送是 upsert，不會長出重複的點。
//   - Discord snowflake 超過 2^53，不能當 JSON 數字，所以用 sha1 造 UUID。
import { createHash } from 'node:crypto';

export const ARCHIVE_DIMENSIONS = 1024;
export const ARCHIVE_DEFAULT_COLLECTION = 'dc_history';
const DAY_MS = 24 * 60 * 60 * 1000;

/** 訊息 id → 穩定 UUID（Qdrant 的點 id 只收 uint64 或 uuid 字串）。 */
export function pointIdFor(id) {
  const hex = createHash('sha1').update(`dc-history:${String(id)}`).digest('hex');
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** 集合名稱會進 URL，只收英數與底線；別人的集合（例如既有的 personal_memory_v2）不能用。 */
const RESERVED_COLLECTIONS = new Set(['personal_memory_v2']);

export function archiveCollectionName(value, fallback = ARCHIVE_DEFAULT_COLLECTION) {
  const name = String(value ?? '').trim();
  if (RESERVED_COLLECTIONS.has(name)) throw new Error(`historyArchive.collection 不能用 ${name}：那是別的服務的集合`);
  return /^[a-z0-9_]{1,64}$/.test(name) ? name : fallback;
}

/**
 * 這則值不值得 embed：去掉提及、emoji、連結之後少於 4 個字的（「笑死」「+1」、純貼圖）
 * 跟任何查詢都像，只會洗掉搜尋結果。
 */
export function worthArchiving(text, min = 4) {
  const body = String(text ?? '')
    .replace(/<a?:[a-zA-Z0-9_]+:\d+>/g, ' ')
    .replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\s\p{P}\p{S}]/gu, '');
  return body.length >= min;
}

/** 一條訊息要進向量的文字：作者放前面，查名字也找得到。 */
export function archiveText({ author, text } = {}, max = 1000) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!body) return '';
  const who = String(author ?? '').replace(/\s+/g, ' ').trim().slice(0, 32) || '某人';
  const line = `${who}：${body}`;
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * Qdrant + oMLX 的最小客戶端。沒有第三方依賴：兩個服務都是 HTTP。
 * 失敗一律丟錯，呼叫端決定要不要記 log、丟掉這一批。
 */
export function createArchive({
  qdrantUrl,
  embedUrl,
  embedModel = 'bge-m3-mlx-fp16',
  apiKey = '',
  collection = ARCHIVE_DEFAULT_COLLECTION,
  retentionDays = 360,
  timeoutMs = 8000,
  fetchImpl = fetch,
} = {}) {
  const base = String(qdrantUrl ?? '').replace(/\/+$/, '');
  const embedBase = String(embedUrl ?? '').replace(/\/+$/, '');
  const name = archiveCollectionName(collection);
  let ready = null;

  async function request(url, init = {}) {
    const res = await fetchImpl(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    let json = null;
    try { json = body ? JSON.parse(body) : null; } catch { /* 非 JSON 錯誤內容 */ }
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} → ${res.status}：${String(body).slice(0, 200)}`);
    return json;
  }

  async function createCollection() {
    await request(`${base}/collections/${name}`, {
      method: 'PUT',
      body: JSON.stringify({
        // on_disk：原始 float32 向量不放記憶體；int8 量化那份留在 RAM。
        vectors: { size: ARCHIVE_DIMENSIONS, distance: 'Cosine', on_disk: true },
        quantization_config: { scalar: { type: 'int8', always_ram: true } },
        hnsw_config: { on_disk: true },
      }),
    });
  }

  /** 索引每次啟動都補送一次：舊集合可能沒有 `at` 索引，order_by 會直接 400。重送沒有副作用。 */
  async function ensureIndexes() {
    for (const [field_name, field_schema] of [['channelId', 'keyword'], ['authorId', 'keyword'], ['at', 'integer']]) {
      try {
        await request(`${base}/collections/${name}/index?wait=false`, {
          method: 'PUT',
          body: JSON.stringify({ field_name, field_schema }),
        });
      } catch { /* 索引失敗不擋寫入；list 會另外回報 */ }
    }
  }

  /** 既有的集合要跟我們建立的一模一樣：維度錯了硬寫只會每次失敗，不如啟動時講清楚。 */
  function checkCollection(info) {
    const vectors = info?.result?.config?.params?.vectors;
    const size = vectors?.size ?? vectors?.default?.size;
    const distance = vectors?.distance ?? vectors?.default?.distance;
    if (Number(size) !== ARCHIVE_DIMENSIONS || String(distance).toLowerCase() !== 'cosine') {
      throw new Error(`集合 ${name} 的向量設定不符（要 ${ARCHIVE_DIMENSIONS} 維 Cosine，實際 ${size ?? '?'} 維 ${distance ?? '?'}）`);
    }
  }

  /** 第一次用到才建集合；失敗後下次再試。索引每次都補送。 */
  function ensure() {
    if (!ready) {
      ready = (async () => {
        try {
          checkCollection(await request(`${base}/collections/${name}`));
        } catch (error) {
          if (!/→ 404/.test(String(error?.message ?? ''))) throw error;
          await createCollection();
        }
        await ensureIndexes();
      })().catch((error) => {
        ready = null;
        throw error;
      });
    }
    return ready;
  }

  async function embedTexts(texts) {
    if (!embedBase) throw new Error('沒有設定 historyArchive.embedUrl');
    const json = await request(`${embedBase}/embeddings`, {
      method: 'POST',
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      body: JSON.stringify({ model: embedModel, input: texts }),
    });
    const vectors = (json?.data ?? []).map((item) => item?.embedding);
    if (vectors.length !== texts.length || vectors.some((v) => !Array.isArray(v))) {
      throw new Error(`embedding 回應格式不對（要 ${texts.length} 個向量，收到 ${vectors.length} 個）`);
    }
    return vectors;
  }

  /** 刪除一定要帶條件：空的 filter 等於整個集合，這是不能出錯的地方。 */
  async function deleteByFilter(filter, { wait = true } = {}) {
    if (!Array.isArray(filter?.must) || filter.must.length === 0) {
      throw new Error('拒絕送出空的刪除條件');
    }
    return request(`${base}/collections/${name}/points/delete?wait=${wait ? 'true' : 'false'}`, {
      method: 'POST',
      body: JSON.stringify({ filter }),
    });
  }

  /** @param items {{ id, guildId, channelId, authorId, author, text, at, mentionIds?, repliedUserId? }[]} */
  async function append(items = []) {
    const rows = items.filter((item) => item?.id && archiveText(item));
    if (!rows.length) return 0;
    await ensure();
    const vectors = await embedTexts(rows.map((item) => archiveText(item)));
    // wait=true：寫進 WAL 之後才回應，失敗才看得到（背景批次不在乎多等幾毫秒）。
    const json = await request(`${base}/collections/${name}/points?wait=true`, {
      method: 'PUT',
      body: JSON.stringify({
        points: rows.map((item, index) => ({
          id: pointIdFor(item.id),
          vector: vectors[index],
          payload: {
            messageId: String(item.id),
            guildId: String(item.guildId ?? ''),
            channelId: String(item.channelId ?? ''),
            authorId: String(item.authorId ?? ''),
            author: String(item.author ?? '').slice(0, 64),
            mentionIds: Array.isArray(item.mentionIds) ? item.mentionIds.map(String) : [],
            repliedUserId: String(item.repliedUserId ?? ''),
            at: Number(item.at) || 0,
            text: String(item.text ?? '').slice(0, 2000),
          },
        })),
      }),
    });
    return rows.length;
  }

  /** 刪掉指定的訊息（被刪除、或 /forget 清佇列後補刪）。 */
  async function deletePoints(ids = []) {
    const points = ids.filter((id) => /^\d{17,20}$/.test(String(id))).map((id) => pointIdFor(id));
    if (!points.length) return 0;
    await ensure();
    await request(`${base}/collections/${name}/points/delete?wait=true`, {
      method: 'POST',
      body: JSON.stringify({ points }),
    });
    return points.length;
  }

  async function search({ query, channelId, limit = 8, minScore = 0, anyChannel = false } = {}) {
    const text = String(query ?? '').trim();
    if (!text || (!channelId && !anyChannel)) return [];
    await ensure();
    const [vector] = await embedTexts([text]);
    const json = await request(`${base}/collections/${name}/points/query`, {
      method: 'POST',
      body: JSON.stringify({
        query: vector,
        limit: Math.min(Math.max(1, Number(limit) || 8), 20),
        with_payload: true,
        ...(channelId ? { filter: { must: [{ key: 'channelId', match: { value: String(channelId) } }] } } : {}),
      }),
    });
    return (json?.result?.points ?? [])
      .filter((point) => minScore === null || Number(point?.score ?? 0) >= minScore)
      .map((point) => ({ score: Number(point.score) || 0, ...(point.payload ?? {}) }));
  }

  async function forgetUser(authorId) {
    const id = String(authorId ?? '');
    // 只收 Discord snowflake：空字串或亂填的 id 會變成「刪全部」。
    if (!/^\d{17,20}$/.test(id)) throw new Error(`authorId 不是 Discord id：「${id}」`);
    await ensure();
    await deleteByFilter({ must: [{ key: 'authorId', match: { value: id } }] });
    return id;
  }

  /** 刪掉超過保留期的點。回傳實際的截止時間（0 = 沒有有效的保留期，什麼都不做）。 */
  async function prune(now = Date.now()) {
    const at = Number(now);
    if (!Number.isFinite(at) || at <= 0) throw new Error('prune 的 now 不是有效時間');
    const days = Number(retentionDays);
    const cutoff = at - Math.max(1, Number.isFinite(days) ? days : 360) * DAY_MS;
    if (!Number.isFinite(cutoff) || cutoff >= at) throw new Error('prune 的截止時間算錯');
    await ensure();
    await deleteByFilter({ must: [{ key: 'at', range: { lt: cutoff } }] });
    return cutoff;
  }

  /**
   * 控制台的瀏覽：照 `at` 由新到舊。
   * order_by 不支援 offset 分頁，所以游標是「上一頁最後一筆的 at」加「那個 at 已經回過的點 id」
   * （start_from 是包含邊界）；Qdrant 用 has_id 把它們排除。
   * shortcut: skip 上限 500；同一個毫秒超過 500 則會停在那一頁，實務上不會發生。
   */
  async function list({ channelId = '', limit = 20, before = null, skip = [] } = {}) {
    await ensure();
    const size = Math.min(Math.max(1, Number(limit) || 20), 100);
    const must = [];
    if (channelId) must.push({ key: 'channelId', match: { value: String(channelId) } });
    const excluded = (Array.isArray(skip) ? skip : []).map(String).slice(0, 500);
    const body = {
      limit: size + 1,
      with_payload: true,
      with_vector: false,
      order_by: {
        key: 'at',
        direction: 'desc',
        ...(Number.isFinite(Number(before)) && Number(before) > 0 ? { start_from: Number(before) } : {}),
      },
    };
    if (must.length) body.filter = { must };
    if (excluded.length) body.filter = { ...(body.filter ?? {}), must_not: [{ has_id: excluded }] };
    const json = await request(`${base}/collections/${name}/points/scroll`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const points = json?.result?.points ?? [];
    const more = points.length > size;
    const page = points.slice(0, size).map((point) => ({
      pointId: point?.id,
      ...(point?.payload ?? {}),
      id: point?.payload?.messageId ?? '',
    }));
    const last = page.at(-1);
    // 下一頁要排除「跟最後一筆同一個 at」的點：start_from 包含邊界，不排會重複。
    // 舊的 skip 留著（它們都在游標上方，不影響結果），整頁同一個 at 時才不會卡住。
    const nextSkip = more && last
      ? [...new Set([
        ...excluded,
        ...page.filter((item) => Number(item.at) === Number(last.at)).map((item) => String(item.pointId)),
      ])].slice(0, 500)
      : [];
    return {
      items: page,
      next: more && last ? { before: Number(last.at) || null, skip: nextSkip } : null,
    };
  }

  /** 已經歸檔的頻道（給控制台的下拉選單）。 */
  async function channels({ limit = 100 } = {}) {
    await ensure();
    const json = await request(`${base}/collections/${name}/facet`, {
      method: 'POST',
      body: JSON.stringify({ key: 'channelId', limit, exact: false }),
    });
    return (json?.result?.hits ?? []).map((hit) => ({ channelId: String(hit.value ?? ''), count: Number(hit.count) || 0 }));
  }

  /** 點數（近似值）：控制台看得到量，不會因為幾十萬點而卡住。 */
  async function count() {
    await ensure();
    const json = await request(`${base}/collections/${name}/points/count`, {
      method: 'POST',
      body: JSON.stringify({ exact: false }),
    });
    return Number(json?.result?.count) || 0;
  }

  return { append, search, forgetUser, prune, deletePoints, list, channels, count, ensure, collection: name };
}
