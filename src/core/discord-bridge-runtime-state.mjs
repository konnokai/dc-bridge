// 橋接執行期的 per-key 狀態。
//
// 這些 Map／Set 只活在記憶體，而且都跟著會話走：/reset 之後不能留舊對話的東西。
// 集中在這裡是因為清單要只有一份。原本 retireSession 逐條 delete，新增一個
// per-key Map 忘了加進去就會漏清，而且要人工比對才看得出來。
//
// 每個 Map 都必須在下面分類一次：KEY_SCOPED（跟 key 走）、SESSION_SCOPED
// （跟 DSH sessionId 走）、PER_TURN（每回合覆寫，不需要清）、
// OWNED_ELSEWHERE（由別的模組用有副作用的方式清）。沒分類到的會讓測試失敗。
export function createRuntimeState() {
  const state = {
    // ── 這個會話帶過什麼、這一輪寫了幾次 ────────────────────────────────
    memoryShown: new Map(), // key -> Map<userId, { updatedAt, at }>
    memoryWrites: new Map(), // key -> 這一輪寫了幾次記憶
    notesShown: new Map(), // key -> Map<noteId, { at, shownAt }>
    noteWrites: new Map(), // key -> 這一輪寫了幾條頻道筆記
    knowledgeShown: new Map(), // key -> Map<知識 id, { updatedAt, at }>
    knowledgeWrites: new Map(), // key -> 這一輪提了幾條知識候選
    memeSaves: new Map(), // key -> 這一輪試著存了幾張梗圖
    devFeedbackWrites: new Map(), // key -> 這一輪送了幾筆開發回饋
    devFeedbackEdits: new Map(), // key -> 這一輪改了幾個開發回饋
    slangWrites: new Map(), // key -> 這一輪自己收錄了幾次黑話／標籤
    slangShown: new Map(), // key -> Map：帶過的黑話（逐條）和頻道風格區塊
    emojiShown: new Map(), // key -> Map：帶過的【常用表情】

    // ── 回合 ↔ 批次：DSH 依投遞順序跑回合，投遞時排進佇列、回合開始時取出 ──
    pendingUsers: new Map(), // key -> {{userId,name}[]}[]：已投遞、回合還沒開始的觸發者
    turnUsers: new Map(), // key -> 目前回合的觸發者
    pendingDirect: new Map(), // key -> { direct, ticket }[]
    turnDirect: new Map(), // key -> 目前這個回合的那批有沒有人叫 bot
    turnTickets: new Map(), // key -> { turn, ticket }：收尾只放自己那一張票
    pendingDirectMessages: new Map(), // key -> {{userId,id}[]}[]：模型要對哪一則按 ❌
    turnDirectMessages: new Map(), // key -> 目前這個回合直接叫 bot 的訊息
    turnStartedAt: new Map(), // key -> 這一輪 turn/start 的時間（攔補句的 log 用）
    turnFollowupTaken: new Set(), // key：這一輪已經攔過補句，一個回合只攔一次
    turnFollowupHeld: new Set(), // key：這一步已經攔過補句，同一步的其他 send 也先不送
    pendingLastMessages: new Map(), // key -> string[]：自由參與的回合記這批最後一則
    turnLastMessage: new Map(), // key -> 目前這個回合最後一則訊息 id
    turnMeta: new Map(), // key -> 批次旗標；null 表示不是橋接排的回合
    turnSentTexts: new Map(), // key -> string[]：這一輪送出的內容（餅要檢查原文連結）
    turnTools: new Map(), // key -> Set(這一輪呼叫過的工具)
    turnTtftMs: new Map(), // key -> 第一個 token 的毫秒數
    turnTriggerRecorded: new Set(), // key -> 這個回合已經記過觸發
    sandboxRuns: new Map(), // key -> 這個回合已經跑過幾次程式（目前上限 1）
    voicePerTurn: new Map(), // key -> 這個回合已經送出幾則語音
    voiceLastAt: new Map(), // key -> 上一則語音送出的時間（跨回合冷卻）
    // 背景語音：只放記憶體，合成幾十秒，橋接重啟就讓它重來，不用清理孤兒檔案。
    voiceJobs: new Map(), // jobId -> { key, sessionId, status, startedAt, at, ... }

    // ── 稍後要重試的提示 ──────────────────────────────────────────────
    noToolRemindedAt: new Map(), // key -> 上次提醒「只回文字、沒呼叫工具」的時間
    ttftTimers: new Map(), // sessionId -> { timer, key, done }
    ttftTimeouts: new Map(), // key -> 被 TTFT 超時取消的門檻（ms）
    ttftAbandonedTurns: new Map(), // key -> Set(turn)：保底放行後等遲到的 turn/end

    // ── 佇列與投遞 ────────────────────────────────────────────────────
    offlineQueue: new Map(), // key -> 等待 DSH 恢復的 job
    offlineHintAt: new Map(), // key -> 上次「已排隊」提示的時間
    primedKeys: new Set(), // 自由參與：這次啟動後已經帶過頻道上下文的會話
    silentPending: new Map(), // key -> 還沒被任何一批上下文帶到的「只當背景」訊息 id
    botLastByUser: new Map(), // key -> Map<userId, { ids, at, replyTo }>：讓位閘門只認同一個人的
    recentHumans: new Map(), // key -> { id, authorId, at }[]：最近的人類訊息（含 ⊘）
    needsOpening: new Set(), // key → 新會話的開場提示還沒真的送進模型

    // ── 綁在 DSH sessionId 上 ─────────────────────────────────────────
    collectors: new Map(), // sessionId -> turn collector
    modelApplied: new Set(), // 本程序內已 selectModel 過的會話
    lastTurns: new Map(), // sessionId -> 看過的最大 turn 編號
    openTurns: new Map(), // sessionId -> Set(turn)：有 start 還沒有 end 的回合
    snapshotReady: new Set(), // sessionId -> 收到 session/follow 的開場快照
  };

  const KEY_SCOPED = Object.freeze([
    'memoryShown', 'memoryWrites', 'notesShown', 'noteWrites', 'knowledgeShown',
    'knowledgeWrites', 'memeSaves', 'devFeedbackWrites', 'devFeedbackEdits',
    'slangWrites', 'slangShown', 'emojiShown',
    'pendingUsers', 'turnUsers', 'pendingDirect', 'turnDirect', 'turnTickets',
    'pendingDirectMessages', 'turnDirectMessages', 'turnStartedAt',
    'turnFollowupTaken', 'turnFollowupHeld', 'pendingLastMessages',
    'turnLastMessage', 'turnMeta', 'turnSentTexts', 'turnTools', 'turnTtftMs',
    'turnTriggerRecorded', 'sandboxRuns', 'voicePerTurn',
    'ttftTimeouts', 'ttftAbandonedTurns',
    'offlineQueue', 'offlineHintAt', 'primedKeys', 'silentPending',
    'botLastByUser', 'recentHumans', 'needsOpening',
  ]);
  const SESSION_SCOPED = Object.freeze(['collectors', 'modelApplied', 'lastTurns', 'openTurns', 'snapshotReady']);
  // 冷卻時間：/reset 不能清。清了等於讓使用者用 /reset 繞過語音冷卻與「沒呼叫工具」提醒。
  const SURVIVES_RESET = Object.freeze(['voiceLastAt', 'noToolRemindedAt']);
  // 由別的地方用有副作用的方式清：voiceJobs 要順便刪通知訊息，ttftTimers 要先 clearTimeout。
  const OWNED_ELSEWHERE = Object.freeze(['voiceJobs', 'ttftTimers']);

  const forgetKey = (key) => {
    for (const name of KEY_SCOPED) state[name].delete(key);
  };
  const forgetSession = (sessionId) => {
    for (const name of SESSION_SCOPED) state[name].delete(sessionId);
  };

  return { ...state, forgetKey, forgetSession, KEY_SCOPED, SESSION_SCOPED, SURVIVES_RESET, OWNED_ELSEWHERE };
}
