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

// 執行期白名單。已掛 mcp-web-search-safe（只讀搜尋/抓取）、mcp-discord（發訊息與頻道動作）
// 與 mcp-slang（自己查詞、收黑話與頻道標籤）；新增 MCP 時把命名空間前綴或精確工具名加在這裡，
// 並同步更新 docs/guides/DISCORD.md。
const SAFE_PREFIXES = ['mcp__web-search-safe__']
const WEB_SEARCH_TOOLS = ['mcp__web-search-safe__web_fetch', 'mcp__web-search-safe__web_search']
// 逐一列精確名稱，不放 mcp__discord__ 前綴：mcp-discord 新增工具時要有人看過才放行。
// 裸的 send_message 是 DSH 的 subagent 控制工具，留在 DANGEROUS。
const DISCORD_TOOLS = [
  'mcp__discord__send_message',
  'mcp__discord__send_sticker',
  'mcp__discord__add_reaction',
  'mcp__discord__edit_message',
  'mcp__discord__delete_message',
  'mcp__discord__create_poll',
  'mcp__discord__search_emojis',
  'mcp__discord__search_stickers',
  'mcp__discord__read_history',
  'mcp__discord__search_history',
  'mcp__discord__view_message',
  'mcp__discord__user_info',
  'mcp__discord__server_info',
  'mcp__discord__conversation_stats',
  'mcp__discord__remember_user',
  'mcp__discord__forget_user_fact',
]
// 黑話／頻道標籤也走橋接，跟 Discord 工具同一組開關：學習會話是純抽取器，不需要也不准寫詞庫。
const SLANG_TOOLS = [
  'mcp__slang__lookup_slang',
  'mcp__slang__record_slang',
  'mcp__slang__record_channel_tag',
]

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
 */
export function apply(ctx, config = {}) {
  const allowWebSearch = config?.allowWebSearch !== false
  const allowDiscordSend = config?.allowDiscordSend !== false
  const denyList = [
    ...DANGEROUS,
    ...(allowWebSearch ? [] : WEB_SEARCH_TOOLS),
    ...(allowDiscordSend ? [] : [...DISCORD_TOOLS, ...SLANG_TOOLS]),
  ]
  const exact = new Set(SAFE_EXACT)
  if (allowDiscordSend) for (const tool of [...DISCORD_TOOLS, ...SLANG_TOOLS]) exact.add(tool)
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

  ctx.tools.guard((exec) => {
    const named = exec?.name
    if (typeof named !== 'string' || named.length === 0) return '工具名無效，已拒絕'
    if (exact.has(named)) return
    // 抽取型 preset 明確關掉網路面：即使 MCP 工具僥倖還在 schema，也不准呼叫。
    if (!allowWebSearch && named.startsWith('mcp__web-search-safe__')) {
      return `工具 "${named}" 不在這個 preset 的白名單內，已拒絕`
    }
    if (SAFE_PREFIXES.some((prefix) => named.startsWith(prefix))) return
    return `工具 "${named}" 不在 Discord 橋接白名單內，已拒絕`
  })
}
