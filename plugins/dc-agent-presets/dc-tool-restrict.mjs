// Discord 橋接的安全硬邊界：只允許無害的模型側工具。
//
// 為什麼要有 restrict（而不只靠 guard）：
//   guard 只能拒絕「執行」，工具名還是會出現在模型的 schema 裡，模型會一直想調它。
//   本機執行／檔案類工具必須在註冊期就從清單隱藏（同 QQ 版的鐵律 L7）。
//
// ⚠️ 下面的 DANGEROUS 名單與 plugins/qq-agent-presets/qq-tool-restrict.mjs 同步
//    （那份是逐個對賬 DSH 0.2.1 實際工具名的權威清單）。DSH 升級後新增危險工具時，
//    兩邊都要補；scripts/test-discord-bridge.mjs 會檢查關鍵名字還在不在。
//    兩個 bundle 各自獨立安裝，所以這裡只能是複本，不能 import 另一包。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dc-tool-restrict'

export const inject = ['tools']

const DANGEROUS = [
  // shell / 終端
  'pwsh', 'bash',
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  // 檔案讀寫與檢索
  'read', 'read_image', 'write', 'edit', 'str_replace_editor', 'glob', 'grep',
  // 自帶執行環境
  'load_workspace_dependencies',
  // 派生 agent / 工作流 / 團隊
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents', 'wait_agent',
  'workflow', 'ralph',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'subagent_codex', 'subagent_claude_code',
  // 宿主狀態與插件裝載權（＝任意程式碼執行）
  'cordis_inspect_list', 'cordis_inspect_query',
  'plugin_manager', 'plugin_market',
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  // 工作目錄／跨會話歷史
  'working_directory',
  'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace',
  // MCP 資源：可指向任一已掛載的 MCP server（等於繞過白名單）
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  // 任務／排程／交付面
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  'create_worktree',
  // 開發注入器（執行期才註冊；restrict 失敗由下面的 guard 兜底）
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
  'dev_build_plugin', 'dev_clear_routes', 'dev_fix_patch', 'dev_heal_links',
  'dev_inject_plugin', 'dev_injected_list', 'dev_install_package', 'dev_plugin_status',
  'dev_release_plugin', 'dev_reload_package', 'dev_scaffold_plugin', 'dev_self_test',
  'dev_stage_add', 'dev_stage_call', 'dev_stage_demote', 'dev_stage_list',
  'dev_stage_promote', 'dev_uninject_plugin',
]

// 執行期白名單。已掛 mcp-web-search-safe（只讀搜尋/抓取）、mcp-discord（發訊息與頻道動作）、
// mcp-slang（自己查詞、收黑話與頻道標籤）與 mcp-prts（只讀 PRTS 資料）；新增 MCP 時把命名空間前綴或精確工具名加在這裡，
// 並同步更新 docs/guides/DISCORD.md。
const SAFE_PREFIXES = ['mcp__web-search-safe__']
const WEB_SEARCH_TOOLS = ['mcp__web-search-safe__web_fetch', 'mcp__web-search-safe__web_search']
// 逐一列精確名稱，不放 mcp__discord__ 前綴：mcp-discord 新增工具時要有人看過才放行。
// 裸的 send_message 是 DSH 的 subagent 控制工具，留在 DANGEROUS。
const DISCORD_TOOLS = [
  'mcp__discord__send_message',
  'mcp__discord__send_image',
  'mcp__discord__cancel_image',
  'mcp__discord__send_prts_artwork',
  'mcp__discord__get_prts_artwork',
  'mcp__discord__send_sticker',
  'mcp__discord__add_reaction',
  'mcp__discord__remove_reaction',
  'mcp__discord__set_quiet',
  'mcp__discord__set_custom_status',
  'mcp__discord__ignore_user',
  'mcp__discord__schedule_followup',
  'mcp__discord__edit_message',
  'mcp__discord__delete_message',
  'mcp__discord__create_poll',
  'mcp__discord__search_emojis',
  'mcp__discord__search_stickers',
  'mcp__discord__search_gifs',
  'mcp__discord__run_script',
  'mcp__discord__read_history',
  'mcp__discord__search_history',
  'mcp__discord__view_message',
  'mcp__discord__user_info',
  'mcp__discord__server_info',
  'mcp__discord__conversation_stats',
  'mcp__discord__remember_user',
  'mcp__discord__forget_user_fact',
  'mcp__discord__note_event',
  'mcp__discord__search_notes',
  'mcp__discord__forget_note',
  'mcp__discord__save_meme',
  'mcp__discord__search_memes',
  'mcp__discord__forget_meme',
  'mcp__discord__submit_feedback',
  'mcp__discord__list_feedback',
  'mcp__discord__edit_feedback',
]
// 黑話／頻道標籤也走橋接，跟 Discord 工具同一組開關：學習會話是純抽取器，不需要也不准寫詞庫。
const SLANG_TOOLS = [
  'mcp__slang__lookup_slang',
  'mcp__slang__record_slang',
  'mcp__slang__record_channel_tag',
]

// 明日方舟 PRTS：全部是唯讀 wiki／遊戲資料查詢，沒有寫入或主機能力。
// 只在 dc-chat 放行；dc-learner 與 dc-trader 不需要這 24 個 schema。
// prts-mcp 升版新增工具時要同步這份清單（IMAGES_ENABLED=true 含 operator_artwork）。
const PRTS_TOOLS = [
  'mcp__prts__search_prts',
  'mcp__prts__prts_page',
  'mcp__prts__get_operator_archives',
  'mcp__prts__get_operator_voicelines',
  'mcp__prts__get_operator_basic_info',
  'mcp__prts__list_story_events',
  'mcp__prts__list_stories',
  'mcp__prts__get_story_summary',
  'mcp__prts__read_story',
  'mcp__prts__read_activity',
  'mcp__prts__search',
  'mcp__prts__search_stories',
  'mcp__prts__list_enemies',
  'mcp__prts__get_enemy_info',
  'mcp__prts__get_stage_enemies',
  'mcp__prts__get_enemy_appearances',
  'mcp__prts__list_stages',
  'mcp__prts__get_stage_info',
  'mcp__prts__list_items',
  'mcp__prts__get_item_info',
  'mcp__prts__get_operator_memoirs',
  'mcp__prts__find_character_appearances',
  'mcp__prts__find_speakers_in',
  'mcp__prts__operator_artwork',
]

// 模擬股票：玩家端與 Bot 端看到的工具不一樣。Bot 只能替自己下單，玩家永遠看不到
// bot_place_order；dc-learner 兩邊都不給。註冊期先藏，guard 再擋一次。
const TRADE_ALL_TOOLS = [
  'mcp__trade__get_quote',
  'mcp__trade__place_order',
  'mcp__trade__get_portfolio',
  'mcp__trade__get_leaderboard',
  'mcp__trade__get_bot_portfolio',
  'mcp__trade__bot_place_order',
]
const TRADE_PLAYER_TOOLS = [
  'mcp__trade__get_quote',
  'mcp__trade__place_order',
  'mcp__trade__get_portfolio',
  'mcp__trade__get_leaderboard',
  'mcp__trade__get_bot_portfolio',
]
const TRADE_BOT_TOOLS = [
  'mcp__trade__get_quote',
  'mcp__trade__get_bot_portfolio',
  'mcp__trade__bot_place_order',
]

// Bot 的搜尋／抓取上限放在橋接的 config，preset 只寫硬上限。橋接啟動與改設定時把
// 實際數字寫進 state/discord-trade-limits.json；這裡同步讀，避免 preset 與 config 各說各話。
const MODULE_FILE = fs.realpathSync(fileURLToPath(import.meta.url))
const LIMITS_FILE = process.env.DC_TRADE_LIMITS_FILE
  || path.resolve(path.dirname(MODULE_FILE), '../../state/discord-trade-limits.json')
let limitsCache = { mtime: -1, value: null }

function readTradeLimits() {
  try {
    const stat = fs.statSync(LIMITS_FILE)
    if (limitsCache.mtime === stat.mtimeMs) return limitsCache.value
    const doc = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8'))
    const value = {
      maxWebSearchesPerTurn: Number(doc.maxWebSearchesPerTurn),
      maxWebFetchesPerTurn: Number(doc.maxWebFetchesPerTurn),
    }
    limitsCache = { mtime: stat.mtimeMs, value }
    return value
  } catch {
    return null
  }
}

const SAFE_EXACT = new Set([
  'ask_user_question', // 提問轉到 Discord
  'todo_write',        // 只維護任務列表
])

/**
 * 抽取型 preset（dc-learner）不需要網路面：config 設 `allowWebSearch: false`
 * 會在註冊期把 MCP web search 從工具清單移除，執行期再擋一次。
 * 預設 true，dc-chat 的行為不變。
 *
 * `allowDiscordSend: false` 同理：學習會話是純抽取器，所有 Discord 工具（含唯讀的）都拿掉，
 * 不該有辦法把字送進頻道，也不需要讀頻道。
 *
 * `allowImageGen: true` 才放行 `generate_image`（dc-chat 專用）。這個工具會 spawn Codex
 * 並寫檔，參數由 dc-draw-image 在執行前鎖成固定設定圖與固定目錄；學習會話不需要畫圖，
 * 所以預設隱藏並拒絕。
 */
export function apply(ctx, config = {}) {
  const allowWebSearch = config?.allowWebSearch !== false
  const allowDiscordSend = config?.allowDiscordSend !== false
  const allowImageGen = config?.allowImageGen === true
  const allowPrts = config?.allowPrts === true
  const tradeMode = config?.trade === 'player' || config?.trade === 'bot' ? config.trade : 'none'
  const allowedTrade = new Set(tradeMode === 'player' ? TRADE_PLAYER_TOOLS : (tradeMode === 'bot' ? TRADE_BOT_TOOLS : []))
  const ceilingSearches = Number.isInteger(config?.maxWebSearchesPerTurn) ? Math.max(0, config.maxWebSearchesPerTurn) : 3
  const ceilingFetches = Number.isInteger(config?.maxWebFetchesPerTurn) ? Math.max(0, config.maxWebFetchesPerTurn) : 2
  const denyList = [
    ...DANGEROUS,
    ...(allowWebSearch ? [] : WEB_SEARCH_TOOLS),
    ...(allowDiscordSend ? [] : [...DISCORD_TOOLS, ...SLANG_TOOLS]),
    ...(allowPrts ? [] : PRTS_TOOLS),
    ...TRADE_ALL_TOOLS.filter((tool) => !allowedTrade.has(tool)),
    // 不能在這裡 restrict generate_image：preset 的 scoped 安全版和這條 restrict
    // 同屬 preset generation layer，restrict 會連安全版一起藏掉。allowImageGen
    // 時改用 guard 檢查 scoped 版的 description；沒有安全版就 fail closed。
    ...(allowImageGen ? [] : ['generate_image']),
  ]
  const exact = new Set(SAFE_EXACT)
  if (allowImageGen) exact.add('generate_image')
  if (allowDiscordSend) for (const tool of [...DISCORD_TOOLS, ...SLANG_TOOLS]) exact.add(tool)
  if (allowPrts) for (const tool of PRTS_TOOLS) exact.add(tool)
  for (const tool of allowedTrade) exact.add(tool)
  const failed = []
  for (const tool of denyList) {
    try {
      ctx.tools.restrict({ deny: [tool] })
    } catch (error) {
      // 這個 DSH 版本沒有這個名字是正常的（可選 bundle／已改名）。
      failed.push({ tool, message: String(error?.message ?? error) })
    }
  }
  if (failed.length > 0) {
    // 只記一行，避免啟動日誌被幾十條「工具不存在」淹掉；真正的邊界是下面的 guard。
    console.error(`[dc-tool-restrict] restrict 未生效 ${failed.length}/${denyList.length}（多為該版本沒有此工具）：${failed[0].tool}: ${failed[0].message}`)
    // 注入器的工具可能在 preset apply 之後才註冊進全域層；3 秒後補藏一次。
    const timer = setTimeout(() => {
      let hidden = 0
      for (const { tool } of failed) {
        try { ctx.tools.restrict({ deny: [tool] }); hidden += 1 } catch {}
      }
      if (hidden > 0) console.error(`[dc-tool-restrict] 延遲重試補藏 ${hidden} 個`)
    }, 3000)
    timer?.unref?.()
  }

  // Bot 的一次性會話等於一回合：用 sessionId 計數，回合結束會話就歸檔，不需要歸零。
  const webCounts = new Map()
  function countWeb(agentId, kind) {
    let counts = webCounts.get(agentId)
    if (!counts) {
      if (webCounts.size >= 500) webCounts.delete(webCounts.keys().next().value)
      counts = { search: 0, fetch: 0 }
      webCounts.set(agentId, counts)
    }
    counts[kind] += 1
    return counts[kind]
  }

  ctx.tools.guard((exec) => {
    const named = exec?.name
    if (typeof named !== 'string' || named.length === 0) return '工具名無效，已拒絕'
    if (tradeMode === 'bot' && (named === 'mcp__web-search-safe__web_search' || named === 'mcp__web-search-safe__web_fetch')) {
      const agentId = String(exec?.agent?.id ?? exec?.agentId ?? 'unknown')
      const kind = named.endsWith('web_search') ? 'search' : 'fetch'
      const bridgeLimits = readTradeLimits()
      const configured = kind === 'search' ? bridgeLimits?.maxWebSearchesPerTurn : bridgeLimits?.maxWebFetchesPerTurn
      const ceiling = kind === 'search' ? ceilingSearches : ceilingFetches
      const limit = Number.isFinite(configured) ? Math.min(ceiling, configured) : ceiling
      const used = countWeb(agentId, kind)
      if (used > limit) {
        return `這一輪最多${kind === 'search' ? '搜尋' : '抓取'} ${limit} 次，已用完；用現有資料做決定`
      }
    }
    if (named.startsWith('mcp__trade__')) {
      if (allowedTrade.has(named)) return
      return `工具 "${named}" 不在這個 preset 的白名單內，已拒絕`
    }
    if (named.startsWith('mcp__prts__')) {
      if (!allowPrts || !exact.has(named)) return `工具 "${named}" 不在這個 preset 的白名單內，已拒絕`
      // prts-mcp 3.2.4 起 large 可以到 8 MiB，但原圖不經縮圖直接進模型；模型看圖上限
      // media.maxModelBytes 預設 1MB，所以 large 一律導去橋接的 get_prts_artwork。
      if (named === 'mcp__prts__operator_artwork') {
        const args = exec?.arguments ?? {}
        if (args.action === 'get' && args.variant !== 'preview') {
          return 'operator_artwork 的 large 會把 8MB 原圖直接送進模型；要看 1024px 立繪用 mcp__discord__get_prts_artwork（會先縮圖），要生圖參考直接在 generate_image 填 prts:<幹員>/<檔名>'
        }
      }
      return
    }
    // 畫圖的參數鎖在 dc-draw-image（tools/execute）；這裡先擋一次原始參數，
    // 外掛萬一沒載入也不會變成「讀主機任一張圖／寫任意目錄」的通道。
    if (named === 'generate_image' && allowImageGen) {
      // 只有 dc-draw-image 註冊的 scoped 安全版（description 有這句）才放行。
      // 外掛沒載入或 row 被移除時，global 的 generate_image 仍有 shell，必須 fail closed。
      let tool = null
      try { tool = ctx.tools.get?.('generate_image', exec?.agent) } catch { /* 當作沒載入 */ }
      if (!tool?.description?.includes('shell and file writes disabled')) {
        return 'generate_image 的安全鎖（dc-draw-image）沒載入，已拒絕'
      }
      const args = exec?.arguments ?? {}
      const ref = args.inputImage
      if (ref !== undefined && ref !== null && ref !== '') {
        // 只放行短代號（self、gpt、大肥魚…）、群友貼的圖（ref:#編號/張數）與 PRTS 立繪（prts:幹員/檔名）；
        // 多個用逗號串起來。路徑一定含 / \ : 或 ..。上限跟 dc-draw-image 一致，外掛沒載入時也要擋。
        const refs = typeof ref === 'string' ? ref.split(/[,，]/).map((part) => part.trim()).filter(Boolean) : []
        const hint = 'generate_image 的 inputImage 只接受角色代號（例如 self、gpt、qwen）、ref:#編號/張數，或 prts:<幹員>/<立繪檔名>，不要填路徑'
        if (refs.length === 0) return hint
        if (refs.length > 4) return 'generate_image 的 inputImage 一次最多 4 個參考（角色代號、群友的圖或 PRTS 立繪）'
        let userRefs = 0
        let prtsRefs = 0
        for (const item of refs) {
          if (/^prts:/i.test(item)) {
            prtsRefs += 1
            if (prtsRefs > 2) return 'generate_image 一次最多 2 張 PRTS 立繪'
            if (item.includes('..')) return hint
            if (!/^prts:(?:[^\s/\\:：]{1,40}\/)?[^/\\:：]{1,160}\.(?:png|jpe?g|webp)$/i.test(item)) return hint
            continue
          }
          if (/^ref:/i.test(item)) {
            userRefs += 1
            if (userRefs > 2) return 'generate_image 一次最多 2 張群友貼的圖'
            if (!/^ref:#?[0-9a-z]{4,12}(?:\/[1-9]\d?)?$/i.test(item)) return hint
            continue
          }
          if (item.length > 60 || /[\\/:：／＼]/.test(item) || item.includes('..') || /\.[a-z0-9]{2,5}$/i.test(item)) {
            return hint
          }
        }
      }
      if (args.outputDir !== undefined && args.outputDir !== null && args.outputDir !== '') return 'generate_image 的 outputDir 由外掛固定，不要填'
      return
    }
    if (exact.has(named)) return
    // 抽取型 preset 明確關掉網路面：即使 MCP 工具僥倖還在 schema，也不准呼叫。
    if (!allowWebSearch && named.startsWith('mcp__web-search-safe__')) {
      return `工具 "${named}" 不在這個 preset 的白名單內，已拒絕`
    }
    if (SAFE_PREFIXES.some((prefix) => named.startsWith(prefix))) return
    return `工具 "${named}" 不在 Discord 橋接白名單內，已拒絕`
  })
}
