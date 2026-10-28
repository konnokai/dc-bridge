// 把橋接的會話令牌自動補進 Discord／黑話工具，模型不用再抄。
//
// 為什麼是 tools/execute 而不是 guard：
//   guard 拿到的 exec.arguments 已經被 DSH deepFreeze，改不了；tools/execute 這個
//   around-dispatch 階段 exec 還沒凍結，工具本體要到 dispatch 當下才讀 arguments。
//   這是踩在 DSH 的實作上（官方註解說 wrapper 只該換 exec.signal），DSH 升級可能失效，
//   所以每次覆寫後都讀回確認：不對就讓呼叫失敗，不要靜默送不出去。
//
// 為什麼要問橋接：
//   mcp-discord 是 DSH 拉起的單一行程，所有會話共用，MCP 協定只送 name + arguments，
//   server 分不出呼叫來自哪個會話。外掛這邊有 exec.agent.id（＝橋接的 sessionId），
//   拿它向橋接換令牌，再補進參數。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dc-session-token'

// 橋接在 state/discord-agent.json 寫的端點（url + x-agent-token）。
// 安裝時這個檔案是 ~/.dsh/plugins/dc-agent-presets 的連結；realpath 解掉連結，
// 才會拿到 repo 裡的實際路徑（預設載入器不一定會先解）。
const MODULE_FILE = fs.realpathSync(fileURLToPath(import.meta.url))
const ENDPOINT_FILE = process.env.DC_AGENT_FILE
  || path.resolve(path.dirname(MODULE_FILE), '../../state/discord-agent.json')

const TOKEN_TOOLS = /^mcp__(?:discord|slang)__/

// 跟 src/core/discord-agent.mjs 的 resolve() 同步：只有這一種失敗可以重試，
// 白名單、額度、會話已結束的 403 重送還是會被擋，重試沒有意義。
export const TOKEN_EXPIRED = '會話令牌過期或不是最新的'

function readEndpoint(file) {
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error('橋接端點還沒就緒（state/discord-agent.json 讀不到）：確認 dc-bridge 正在執行')
  }
  if (!doc?.url || !doc?.token) throw new Error('橋接端點檔缺少 url/token：重啟 dc-bridge')
  return doc
}

/** 結果的文字內容（工具失敗時是 `Error: …`）。 */
function resultText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  return blocks.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n')
}

export function apply(ctx, config = {}) {
  const endpointFile = config.endpointFile || ENDPOINT_FILE
  const tokens = new Map() // sessionId -> 會話令牌
  let secret = '' // 上次看到的端點 secret；橋接重啟會換，快取要跟著作廢

  async function fetchToken(sessionId) {
    const { url, token } = readEndpoint(endpointFile)
    // 橋接每次重啟都換一組端點 secret，也換掉所有會話令牌。secret 一變就整張快取清掉，
    // 這樣「橋接重啟後工具全掛」不必靠錯誤字串比對才解得開。
    if (token !== secret) {
      secret = token
      tokens.clear()
    }
    const cached = tokens.get(sessionId)
    if (cached) return cached
    let res
    try {
      res = await fetch(`${url}/sessionToken`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-token': token },
        body: JSON.stringify({ sessionId }),
        signal: AbortSignal.timeout(5000),
      })
    } catch (error) {
      throw new Error(`連不上橋接（${url}）：${error?.message ?? error}`)
    }
    let body = null
    try { body = await res.json() } catch { body = null }
    if (!res.ok || typeof body?.token !== 'string' || !body.token) {
      throw new Error(String(body?.error ?? `橋接回應 HTTP ${res.status}`))
    }
    tokens.set(sessionId, body.token)
    return body.token
  }

  function setToken(exec, token) {
    try {
      exec.arguments = { ...(exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}), token }
    } catch (error) {
      throw new Error(`自動帶入會話令牌失敗（DSH 改了 tools/execute 的規則）：${error?.message ?? error}`)
    }
    if (exec.arguments.token !== token) throw new Error('自動帶入會話令牌沒生效（DSH 改了 tools/execute 的規則）：回報管理員')
  }

  /** 拿令牌；失敗轉成一句模型看得懂、會去回報的話。 */
  async function tokenFor(sessionId) {
    try {
      return await fetchToken(sessionId)
    } catch (error) {
      throw new Error(`自動帶入會話令牌失敗：${error?.message ?? error}。這批不要送，回報管理員`)
    }
  }

  ctx.on('tools/execute', async (exec, next) => {
    if (!TOKEN_TOOLS.test(exec.name)) return next()
    const sessionId = exec.agent?.id
    if (!sessionId) return next() // 沒有會話身分：讓工具自己回「沒有帶令牌」

    setToken(exec, await tokenFor(sessionId))

    const result = await next()
    if (!result?.isError || !resultText(result).includes(TOKEN_EXPIRED)) return result

    // 橋接重啟後舊令牌全換：清快取重查一次。令牌過期在送出前就被擋掉，
    // 這次呼叫沒有任何效果，所以重送是安全的。
    tokens.delete(sessionId)
    setToken(exec, await tokenFor(sessionId))
    return next()
  })
}
