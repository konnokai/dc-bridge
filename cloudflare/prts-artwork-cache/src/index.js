// PRTS 圖片快取 Worker：只服務 bridge，R2 存圖；抓不到就回 502，讓 bridge 直連。
//
// 為什麼不讓 Worker 自己算 MediaWiki 路徑：bridge 已經算好 media.prts.wiki 的
// 完整網址，Worker 只驗證 host／路徑並快取，避免在 Worker 裡再實作一次 MD5。
const IMAGE_HOSTS = new Set(['media.prts.wiki', 'prts.wiki']);
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_BYTES = 8 * 1024 * 1024;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const USER_AGENT = 'PRTS-MCP-Cache/1.0 (+https://github.com/konnokai/dc-bridge)';

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/** 只收 media.prts.wiki／prts.wiki 的 MediaWiki 圖片路徑。 */
export function allowedImageUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443')) return null;
  if (!IMAGE_HOSTS.has(url.hostname)) return null;
  if (url.search || url.hash) return null;
  // 縮圖：/thumb/<h1>/<h1h2>/<file>/<width>px-<file>
  // 原圖：/<h1>/<h1h2>/<file>
  if (!/^\/thumb\/[0-9a-f]\/[0-9a-f]{2}\//i.test(url.pathname)
    && !/^\/[0-9a-f]\/[0-9a-f]{2}\//i.test(url.pathname)) return null;
  return url;
}

export function imageMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

function cacheKey(url) {
  return `v1/${url.hostname}${url.pathname}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json(200, { status: 'ok' });
    if (request.method !== 'GET') return json(405, { error: 'method not allowed' });
    if (!env.PRTS_PROXY_TOKEN || request.headers.get('x-prts-token') !== env.PRTS_PROXY_TOKEN) {
      return json(401, { error: 'unauthorized' });
    }

    const target = allowedImageUrl(url.searchParams.get('u'));
    if (!target) return json(400, { error: 'url not allowed' });
    const key = cacheKey(target);

    const hit = await env.PRTS_CACHE.get(key);
    if (hit) {
      const headers = {
        'content-type': hit.httpMetadata?.contentType || 'application/octet-stream',
        'cache-control': CACHE_CONTROL,
        'x-prts-cache': 'hit',
      };
      if (hit.httpEtag) headers.etag = hit.httpEtag;
      return new Response(hit.body, { headers });
    }

    let upstream;
    try {
      upstream = await fetch(target.toString(), {
        headers: {
          'user-agent': USER_AGENT,
          accept: 'image/*,*/*;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      return json(502, { error: `fetch failed: ${error?.message ?? error}` });
    }
    if (!upstream.ok) {
      // MediaWiki 對「這個寬度沒有縮圖」有時回 400；對 bridge 來說跟 404 一樣，換下一個候選。
      const status = upstream.status === 400 || upstream.status === 404 ? 404 : 502;
      return json(status, { error: `upstream HTTP ${upstream.status}` });
    }

    const finalUrl = new URL(upstream.url);
    if (finalUrl.protocol !== 'https:' || (finalUrl.port && finalUrl.port !== '443') || !IMAGE_HOSTS.has(finalUrl.hostname)) {
      return json(502, { error: `upstream host not allowed: ${finalUrl.hostname}` });
    }
    const declared = String(upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_MIMES.has(declared)) {
      return json(502, { error: `upstream content-type not allowed: ${declared || 'unknown'}` });
    }
    const length = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_BYTES) {
      return json(502, { error: `upstream too large: ${length}` });
    }

    const bytes = new Uint8Array(await upstream.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) {
      return json(502, { error: `upstream too large: ${bytes.byteLength}` });
    }
    const mime = imageMime(bytes);
    if (!mime) return json(502, { error: 'upstream is not a supported image' });

    try {
      await env.PRTS_CACHE.put(key, bytes, {
        httpMetadata: { contentType: mime, cacheControl: CACHE_CONTROL },
      });
    } catch (error) {
      // R2 寫入失敗不擋這次回應；下次再抓一次就好。
      console.warn(`[prts-cache] R2 put failed: ${error?.message ?? error}`);
    }
    return new Response(bytes, {
      headers: {
        'content-type': mime,
        'cache-control': CACHE_CONTROL,
        'x-prts-cache': 'miss',
      },
    });
  },
};
