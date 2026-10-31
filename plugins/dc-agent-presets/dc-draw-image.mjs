// 把 generate_image 的輸入與輸出鎖在橋接自己的目錄。
//
// 為什麼要另外包一層：
//   dsh-generate-image 讓呼叫端自己給 inputImage 和 outputDir。那個工具是給完整
//   權限的 coding agent 用的；dc-chat 沒有本機工具，放任它填任意路徑等於多出
//   「讀主機上任一張圖」和「寫任意目錄」兩個洞。
//   這裡在工具執行前改寫參數：inputImage 只認角色代號（換成 assets/ai-chan-sheets
//   裡的三視圖），outputDir 固定 state/discord-images。模型不用知道設定圖路徑，
//   換機器也不用改 persona。
//
// 為什麼用 tools/execute 而不是 guard：guard 拿到的 arguments 已凍結，改不了；
// tools/execute 是 around-dispatch，工具本體要到下一個 next() 才讀參數。
// 跟 dc-session-token 同一個機制，改完照樣讀回確認。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'dc-draw-image'

export const inject = ['tools']

// 安裝時這個檔案是 ~/.dsh/plugins/dc-agent-presets 的連結；realpath 解掉連結，
// 才會拿到 repo 裡的實際路徑（跟 dc-session-token.mjs 同一個做法）。
const MODULE_URL = fileURLToPath(import.meta.url)
const MODULE_FILE = fs.realpathSync(MODULE_URL)

// 直接用 dsh-generate-image 的引擎，但用自己的工具註冊把它包起來：
// 那個外掛的 Codex 是完整 coding agent（有 shell），Discord 的 prompt 來自群友，
// 不能讓它跑指令。這裡把 shell/exec 關掉、沙箱改成 read-only，工作目錄也換成
// state/ 底下的空目錄；scoped 工具會蓋掉 profile 註冊的 global generate_image。
//
// 套件要從 profile 的 node_modules 解析，不能從 repo 解析：安裝時這個檔案是
// profile/node_modules/dc-agent-presets 的連結，realpath 後就離開 profile 了。
async function loadCodex() {
  if (process.env.DC_AI_CODEX_MODULE) {
    try { return await import(pathToFileURL(path.resolve(process.env.DC_AI_CODEX_MODULE)).href) } catch (error) {
      console.error(`[dc-draw-image] 讀不到 DC_AI_CODEX_MODULE（${process.env.DC_AI_CODEX_MODULE}）：${error?.message ?? error}`)
      return null
    }
  }
  const bundleDir = path.dirname(MODULE_URL)
  if (path.basename(bundleDir) === 'dc-agent-presets' && path.basename(path.dirname(bundleDir)) === 'node_modules') {
    try {
      const profileDir = path.resolve(bundleDir, '../..')
      const require = createRequire(path.join(profileDir, 'package.json'))
      const resolved = require.resolve('dsh-generate-image/lib/codex.js')
      return await import(pathToFileURL(resolved).href)
    } catch { /* 版本沒有這個子路徑就退回下面的直接 import */ }
  }
  // 載入器若先把 symlink 解成 repo 路徑，上面就找不到 profile 的 node_modules；
  // 再從 DSH_HOME/profiles/*/node_modules 找一次（只會裝在某一兩個 profile）。
  try {
    const profilesDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles')
    for (const profile of fs.readdirSync(profilesDir).sort()) {
      const candidate = path.join(profilesDir, profile, 'node_modules', 'dsh-generate-image', 'lib', 'codex.js')
      if (fs.existsSync(candidate)) return await import(pathToFileURL(candidate).href)
    }
  } catch { /* 沒有 DSH_HOME 就往下試直接 import */ }
  try {
    return await import('dsh-generate-image/lib/codex.js')
  } catch (error) {
    console.error(`[dc-draw-image] 讀不到 dsh-generate-image/lib/codex.js：${error?.message ?? error}`)
    return null
  }
}
const codex = await loadCodex()

const ASSETS_DIR = path.resolve(path.dirname(MODULE_FILE), '../../assets/ai-chan-sheets')
const MANIFEST_FILE = process.env.DC_AI_CHAN_MANIFEST || path.join(ASSETS_DIR, 'characters.json')

// 設定圖清單壞掉時不要讓整個 preset 掛載失敗（那會連聊天都沒了）；
// 一般生圖照常，只有指定角色時才報錯。
let manifest = { characters: [] }
let manifestError = null
try {
  const parsed = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'))
  if (!Array.isArray(parsed?.characters)) throw new Error('characters.json 缺少 characters 陣列')
  manifest = parsed
} catch (error) {
  manifestError = error
  console.error(`[dc-draw-image] characters.json 讀不到（${MANIFEST_FILE}）：${error?.message ?? error}`)
}
export const CHARACTERS = manifest.characters

/** 產圖固定放這裡；send_image 只認這個目錄裡的檔名。 */
export const IMAGE_DIR = path.resolve(path.dirname(MODULE_FILE), '../../state/discord-images')

// 橋接每 5 分鐘把 Codex 額度快照寫進 state/；額度太低時這裡直接拒絕，不再開 Codex。
// 快照過期或不存在（橋接沒跑）就放行，避免額度其實已重置卻一直擋著。
const QUOTA_FILE = path.join(path.dirname(IMAGE_DIR), 'discord-codex-quota.json')
const QUOTA_MAX_AGE_MS = 10 * 60_000

// 背景生圖完成後要通知橋接；橋接的端點檔跟 dc-session-token 共用，重啟後埠會變，所以每次重讀。
const AGENT_ENDPOINT_FILE = process.env.DC_AGENT_FILE
  || path.join(path.dirname(IMAGE_DIR), 'discord-agent.json')
const REPORT_TIMEOUT_MS = 5000
// 背景工作每 15 秒問橋接還在不在：/reset 或會話結束時才能停掉 Codex。
const JOB_POLL_MS = Math.max(10, Number(process.env.DC_IMAGE_JOB_POLL_MS) || 15_000)
// 橋接重啟時 API 要等 Discord 登入完才開，連不上不能像 /reset 一樣馬上停。
const UNREACHABLE_MAX_MS = Math.max(50, Number(process.env.DC_IMAGE_UNREACHABLE_MAX_MS) || 3 * 60_000)
// 完成／失敗只送一次會撞上重啟；只有斷線、401 或 5xx 才退避重送，其他 4xx 直接放棄。
// 總共等約 3 分鐘，跟 poll 的容忍時間一致；橋接在這段時間內回來就送得成功。
const FINAL_REPORT_DELAYS_MS = (process.env.DC_IMAGE_REPORT_DELAYS_MS || '1000,2000,4000,8000,15000,30000,60000,60000')
  .split(',')
  .map((value) => Number(value))
  .filter((value) => Number.isFinite(value) && value >= 0)

/** 快照說額度太低時回原因；過期、壞掉或不存在回 null（放行）。 */
export function drawQuotaBlock() {
  const file = process.env.DC_CODEX_QUOTA_FILE || QUOTA_FILE
  let snapshot
  try { snapshot = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
  const age = Date.now() - snapshot?.fetchedAt
  if (!Number.isFinite(age) || age < 0 || age > QUOTA_MAX_AGE_MS) return null
  if (snapshot.drawAllowed !== false) return null
  return snapshot.drawBlockedReason || 'Codex 額度不足，先不畫圖'
}

/** adapter 會加 `-s`；wrapper 會拿掉並換成 permission profile。這裡保留 read-only 當 wrapper 失效時的 fallback。 */
export const CODEX_SANDBOX = 'read-only'
export const CODEX_EXTRA_ARGS = Object.freeze([
  '--disable', 'shell_tool',
  '--disable', 'unified_exec',
  '--disable', 'view_image',
  '--ignore-user-config',
  '--ignore-rules',
  '--ephemeral',
])
const WORK_DIR = path.resolve(path.dirname(IMAGE_DIR), 'discord-imagegen-work')
// 拿掉 adapter 的 -s，改用只 deny /mnt 的 permission profile。
const CODEX_WRAPPER = path.join(path.dirname(MODULE_FILE), 'codex-imagegen-wrapper.mjs')

// prompt 是模型寫的、模型會被群友帶偏；遇到明顯的路徑或指令就拒絕。
// 這只是第二層，真正的邊界是上面的 shell/exec 關閉與 read-only。
const PROMPT_DENY = /(ignore\s+(all\s+)?(previous|prior)\s+instructions|system\s+prompt|(?:https?|file):\/\/|(?:^|\s)\.\.[\\/]|(?:~[\\/]|\/home|\/etc|\/var|\/usr|\/opt|\/mnt|[a-z]:\\)[^\s]*|\.dsh|credentials\.yaml|discord-agent\.json)/i

/** 模型可以打中文名、英文名、資料夾名或別名；比對前先收斂大小寫、空白與標點。 */
function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_\-（）()·.、「」『』"'“”‘’《》]/g, '')
}

const BY_NAME = new Map()
for (const character of CHARACTERS) {
  for (const key of [character.id, character.name, character.dir, ...(character.aliases ?? [])]) {
    BY_NAME.set(normalizeName(key), character)
  }
}
const DEEPSEEK = CHARACTERS.find((character) => character.id === 'deepseek')
if (!DEEPSEEK) manifestError ??= new Error('characters.json 缺少 deepseek')
if (DEEPSEEK) {
  for (const alias of ['self', '自己', '大肥魚', '大肥鱼']) BY_NAME.set(normalizeName(alias), DEEPSEEK)
}

/** 畫大肥魚自己時用的三視圖；測試與舊呼叫端都靠這個名字。 */
export const SELF_SHEET = DEEPSEEK ? path.join(ASSETS_DIR, DEEPSEEK.reference) : null

/** 角色代號／名字 → 角色資料；不認得回 null。 */
export function resolveCharacter(value) {
  const key = normalizeName(value)
  return key ? (BY_NAME.get(key) ?? null) : null
}

/** 角色資料 → 圖檔絕對路徑；view 預設 reference（image_gen 用的三視圖）。 */
export function characterImage(character, view = 'reference') {
  const rel = view === 'reference' ? character?.reference : character?.views?.[view]
  return rel ? path.join(ASSETS_DIR, rel) : null
}

/** execute 只接受 manifest 裡的設定圖；guard 擋模型，這裡擋直接呼叫與被換掉的檔案。 */
const ALLOWED_IMAGES = new Set(
  CHARACTERS.map((character) => characterImage(character))
    .filter(Boolean)
    .map((file) => path.resolve(file)),
)

const PROMPT_MAX = 4000
const KEEP_IMAGES = 100
// 一張圖最多帶幾張設定圖；每張都是大圖，帶太多會拖慢生圖也吃 context。
const MAX_REFERENCES = 4
const REF_SEPARATOR = /[,，]/

/** 模型用逗號把角色代號串起來（`self,claude`）；單一角色也走這裡。 */
function splitReferences(value) {
  if (typeof value !== 'string') return []
  return value.split(REF_SEPARATOR).map((ref) => ref.trim()).filter(Boolean)
}

/** middleware 內部用 ASCII 逗號串絕對路徑；這裡只拆 ASCII，路徑裡的全形逗號才不會被拆壞。 */
function splitResolvedReferences(value) {
  // shortcut: 路徑本身含 ASCII 逗號仍會被拆開，真的遇到就把內部改成傳陣列。
  if (typeof value !== 'string') return []
  return value.split(',').map((ref) => ref.trim()).filter(Boolean)
}

/** 圖生圖的模型不知道附圖是什麼；用英文講清楚每一張是誰，畫出來才不會走形。 */
function referenceNote(characters) {
  if (characters.length === 1) {
    return `\n\nThe attached image is the canonical character sheet for ${characters[0].promptName}. `
      + 'Use it only as a design reference; do not reproduce the sheet layout or its multiple views. '
      + 'Draw a single new illustration. Keep the character\'s face, hair, outfit, colors, and distinctive accessories consistent with it. '
      + 'If the prompt describes the appearance differently, follow the sheet.'
  }
  const sheets = characters.map((character, index) => `image ${index + 1} = ${character.promptName}`).join('; ')
  return `\n\nThe attached images are canonical character sheets: ${sheets}. `
    + 'Use them only as design references; do not reproduce the sheet layout or its multiple views. '
    + 'Draw a single new illustration. Keep each character\'s face, hair, outfit, colors, and distinctive accessories consistent with its own sheet. '
    + 'If the prompt describes any character differently, follow that character\'s sheet.'
}

/** 只留最近幾張，避免每次畫圖都往 state/ 疊一個幾 MB 的檔。 */
function pruneImages() {
  try {
    const files = fs.readdirSync(IMAGE_DIR)
      .filter((file) => /\.(png|jpe?g|webp|gif)$/i.test(file))
      .map((file) => ({ file, time: fs.statSync(path.join(IMAGE_DIR, file)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
    for (const { file } of files.slice(KEEP_IMAGES)) {
      fs.rmSync(path.join(IMAGE_DIR, file), { force: true })
    }
  } catch {}
}

// Codex 的引擎用「$CODEX_HOME/generated_images 前後快照」找新圖；兩個頻道同時
// 生圖時會撿到對方的圖。所有 generate_image 呼叫共用這一條 queue，一次只跑一個。
export function createSerialQueue() {
  let tail = Promise.resolve()
  return (task) => {
    const run = tail.then(task, task)
    tail = run.catch(() => {})
    return run
  }
}
const serialize = createSerialQueue()

/** 生圖引擎的固定安全參數；測試直接驗這一份，避免 execute 裡漏掉。 */
export function codexOptions({ prompt, inputImage = null, signal } = {}) {
  return {
    prompt,
    workdir: WORK_DIR,
    sandbox: CODEX_SANDBOX,
    inputImage,
    extraArgs: CODEX_EXTRA_ARGS,
    signal,
  }
}

function renderResult(value) {
  return value.message ?? value.status
}

/** sessionId -> Set<AbortController>：會話被 DSH 移除時，取消還在跑或還在排隊的生圖。 */
const activeJobs = new Map()

function trackJob(sessionId, controller) {
  let set = activeJobs.get(sessionId)
  if (!set) {
    set = new Set()
    activeJobs.set(sessionId, set)
  }
  set.add(controller)
}

function releaseJob(sessionId, controller) {
  const set = activeJobs.get(sessionId)
  if (!set) return
  set.delete(controller)
  if (set.size === 0) activeJobs.delete(sessionId)
}

/**
 * 回報生圖狀態給橋接；由橋接排進會話閘門，不能直接 agent.followup。
 * 直接 followup 會搶在橋接正在等的批次前面，讓 /ask 與回合歸屬認錯。橋接沒跑就只留在 log。
 * @returns {{body: any, retry: boolean}} retry 代表斷線、401 或 5xx，值得重送；其他 4xx 不用。
 */
async function reportImageJob(payload, { quiet = false } = {}) {
  const logError = (message) => { if (!quiet) console.error(`[dc-draw-image] ${message}`) }
  let endpoint
  try {
    endpoint = JSON.parse(fs.readFileSync(AGENT_ENDPOINT_FILE, 'utf8'))
  } catch (error) {
    logError(`讀不到橋接端點（${AGENT_ENDPOINT_FILE}）：${error?.message ?? error}`)
    return { body: null, retry: true }
  }
  if (!endpoint?.url || !endpoint?.token) {
    logError('橋接端點檔缺少 url/token：本次生圖不通知頻道')
    return { body: null, retry: true }
  }
  try {
    const res = await fetch(`${endpoint.url}/imageJob`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-token': endpoint.token },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    })
    let body = null
    try { body = await res.json() } catch { body = null }
    if (!res.ok) {
      logError(`橋接拒絕生圖通知（${payload.phase}）：${body?.error ?? `HTTP ${res.status}`}`)
      // 401 是舊端點 token：橋接重啟後會換一組，重讀端點檔再送就好。
      return { body: null, retry: res.status >= 500 || res.status === 401 }
    }
    return { body, retry: false }
  } catch (error) {
    logError(`連不上橋接，生圖通知沒送出（${payload.phase}）：${error?.message ?? error}`)
    return { body: null, retry: true }
  }
}

/**
 * 背景生圖：execute 先回「已開始」，這裡才真的開 Codex。
 * 完成或失敗都回報橋接，由橋接排進同一個會話的閘門；1~3 分鐘的生成不會卡住其他訊息。
 * queue 仍是一條：Codex 的 generated_images 共用，兩個行程同時畫會撿到對方的圖。
 */
async function runGenerationJob({ sessionId, jobId, prompt, inputImage, inputImages, codexBin, controller }) {
  const signal = controller?.signal
  let dest = null
  let text
  let pollTimer = null
  let unreachableSince = null
  const poll = async () => {
    if (signal?.aborted) return
    const result = await reportImageJob({ phase: 'poll', sessionId, jobId }, { quiet: true })
    if (result.body?.cancel) {
      controller?.abort(new Error('生圖工作已取消'))
      return
    }
    if (result.body) {
      unreachableSince = null
      return
    }
    // 4xx 不用再等：這個會話或工作已經不被橋接承認。
    if (!result.retry) {
      controller?.abort(new Error('橋接拒絕生圖輪詢'))
      return
    }
    unreachableSince ??= Date.now()
    if (Date.now() - unreachableSince > UNREACHABLE_MAX_MS) {
      controller?.abort(new Error('連不上橋接，取消生圖'))
    }
  }
  pollTimer = setInterval(() => { void poll() }, JOB_POLL_MS)
  pollTimer.unref?.()
  try {
    const result = await serialize(() => {
      if (signal?.aborted) throw new Error('已取消')
      // 排隊期間額度可能用完；真正開 Codex 前再檢查一次。
      const queuedQuotaBlock = drawQuotaBlock()
      if (queuedQuotaBlock) throw new Error(queuedQuotaBlock)
      return codex.runCodexGenerate({
        ...codexOptions({ prompt, inputImage, signal }),
        codexBin: CODEX_WRAPPER,
        extraArgs: [
          ...CODEX_EXTRA_ARGS,
          ...inputImages.slice(1).flatMap((image) => ['-i', image]),
          '--dc-real-codex', codexBin,
        ],
        nodeBin: process.execPath,
        timeoutMs: codex.DEFAULT_TIMEOUT_MS,
      })
    })

    if (result.code !== 0) {
      const evErr = result.events.find((event) => event?.item?.type === 'error')
      const detail = String(evErr?.item?.message || result.stderr || result.stdoutTail || '').trim().slice(0, 600)
      throw new Error(`codex failed (exit ${result.code}): ${detail}`)
    }
    if (!result.file) throw new Error('codex finished but produced no image file; check the Codex model supports image generation.')

    dest = path.join(IMAGE_DIR, path.basename(result.file))
    fs.copyFileSync(result.file, dest)
    text = `【生圖完成】圖片已存到 ${dest}\n用 mcp__discord__send_image 送出（file 填這個路徑，content 帶一句話）。不要重新生圖。`
  } catch (error) {
    // 會話被 /reset 或移除：不用回報，橋接也已經不認這個 session。
    if (signal?.aborted) return
    text = `【生圖失敗】${String(error?.message ?? error).slice(0, 600)}\n跟頻道說這次沒畫成，不要假裝畫了；同一個要求最多再試一次。`
  } finally {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
    pruneImages()
    releaseJob(sessionId, controller)
  }
  const payload = {
    phase: dest ? 'done' : 'failed',
    sessionId,
    jobId,
    file: dest ?? undefined,
    text,
  }
  for (let attempt = 0; ; attempt += 1) {
    // 第一次與最後一次留 log；中間的重試只留給成功或放棄時看。
    const quiet = attempt > 0 && attempt < FINAL_REPORT_DELAYS_MS.length
    const result = await reportImageJob(payload, { quiet })
    if (result.body || !result.retry || attempt >= FINAL_REPORT_DELAYS_MS.length) break
    await new Promise((resolve) => setTimeout(resolve, FINAL_REPORT_DELAYS_MS[attempt]))
  }
}

export function apply(ctx) {
  // /reset 或會話結束：DSH 會移除 agent／session。還在跑或排隊的生圖要一起取消，
  // 不然會繼續吃 Codex 額度、佔共用 queue，完成後還對著舊會話回報。
  function cancelSessionJobs(sessionId) {
    const controllers = sessionId ? activeJobs.get(sessionId) : null
    if (!controllers) return
    for (const controller of controllers) controller.abort(new Error('會話已結束，取消背景生圖'))
    activeJobs.delete(sessionId)
  }
  ctx.on('agent/disposed', ({ agent } = {}) => cancelSessionJobs(agent?.id))
  ctx.on('session/disposed', (session) => cancelSessionJobs(session?.id))

  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'generate_image') return next()

    const args = exec.arguments ?? {}
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (!prompt) throw new Error('generate_image 需要 prompt（要畫什麼）')
    if (prompt.length > PROMPT_MAX) throw new Error(`generate_image 的 prompt 最多 ${PROMPT_MAX} 字`)
    if (PROMPT_DENY.test(prompt)) throw new Error('畫圖 prompt 含有路徑或指令字樣，已拒絕；只描述畫面')

    const rawRef = args.inputImage
    const refs = splitReferences(rawRef)
    if (rawRef !== undefined && rawRef !== null && rawRef !== '' && refs.length === 0) {
      throw new Error('generate_image 的 inputImage 只接受角色代號（例如 self、gpt、qwen），不要填路徑')
    }
    if (refs.length > MAX_REFERENCES) {
      throw new Error(`generate_image 一次最多帶 ${MAX_REFERENCES} 個角色`)
    }
    const characters = refs.map((ref) => {
      if (manifestError) {
        throw new Error(`角色設定圖清單讀不到（${MANIFEST_FILE}）：${manifestError.message}。確認 assets/ai-chan-sheets/characters.json`)
      }
      if (/[\\/:：／＼]/.test(ref) || ref.includes('..')) {
        throw new Error('generate_image 的 inputImage 只接受角色代號（例如 self、gpt、qwen），不要填路徑')
      }
      const character = resolveCharacter(ref)
      if (!character) {
        throw new Error(`不認得角色「${ref}」。可以用：${CHARACTERS.map((c) => c.id).join('、')}，或直接打中文名`)
      }
      return character
    })

    const nextArgs = { prompt, outputDir: IMAGE_DIR }
    if (characters.length > 0) {
      nextArgs.inputImage = characters.map((character) => characterImage(character)).join(',')
      nextArgs.prompt += referenceNote(characters)
    }
    nextArgs.prompt += '\n\nUse only the attached input images when any are provided. Never pass referenced_image_paths or read any other local file.'
    exec.arguments = nextArgs
    const written = exec.arguments
    if (written.outputDir !== IMAGE_DIR || (characters.length > 0 && written.inputImage !== nextArgs.inputImage)) {
      throw new Error('鎖定 generate_image 參數失敗（DSH 改了 tools/execute 的規則）：回報管理員')
    }

    try {
      return await next()
    } finally {
      pruneImages()
    }
  })

  // Scoped 工具會蓋掉 profile 註冊的 global generate_image。名字與介面一樣，
  // 但 Codex 只跑 read-only、shell/exec 關掉，工作目錄在 state/ 底下。
  ctx.tools.register({
    name: 'generate_image',
    description:
      'Start an image generation job from a text description, or use a reference image, with the local Codex image_gen tool. '
      + 'Returns immediately; the image arrives later in a follow-up message, then send it with send_image. '
      + 'The tool runs with shell and file writes disabled; '
      + 'inputImage is a character code (self, gpt, qwen, ...), comma-separated codes for multiple characters, or omitted.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the image to generate: scene, composition, style, colors, and expression. English works best.',
        },
        outputDir: {
          type: 'string',
          description: 'Do not set; the bridge fixes the output directory.',
        },
        inputImage: {
          type: 'string',
          description: 'Character code: self, gpt, qwen, ... or a Chinese character name. For multiple characters, separate codes with commas (for example "self,claude"), up to 4. Omit for a generic image.',
        },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Always "started"; the result arrives in a follow-up message' },
          message: { type: 'string', description: 'What to do next' },
        },
        required: ['status'],
      },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    // execute 立刻回，真正的 Codex 由模組層的 queue 排隊；這裡維持 exclusive，
    // 避免同一步同時排很多張圖。
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const quotaBlock = drawQuotaBlock()
      if (quotaBlock) throw new Error(quotaBlock)
      if (!codex) throw new Error('畫圖引擎沒載入（dsh-generate-image 沒裝或版本不相容）：回報管理員')
      if (typeof args?.prompt !== 'string' || !args.prompt.trim()) throw new Error('generate_image 需要 prompt（要畫什麼）')
      if (PROMPT_DENY.test(args.prompt)) throw new Error('畫圖 prompt 含有路徑或指令字樣，已拒絕；只描述畫面')
      const codexBin = codex.findCodexBin(process.env, {})
      if (!codexBin) throw new Error('找不到 codex CLI：先安裝並登入 Codex')

      const refs = splitResolvedReferences(args?.inputImage)
      if (refs.length > MAX_REFERENCES) throw new Error(`inputImage 一次最多 ${MAX_REFERENCES} 個角色`)
      const assetsRoot = refs.length > 0 ? fs.realpathSync(ASSETS_DIR) : null
      const inputImages = refs.map((ref) => {
        const full = path.resolve(ref)
        if (!ALLOWED_IMAGES.has(full)) throw new Error('inputImage 只能是 assets/ai-chan-sheets 裡的角色設定圖')
        let real
        try { real = fs.realpathSync(full) } catch { throw new Error(`inputImage 不存在：${full}`) }
        const rel = path.relative(assetsRoot, real)
        if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('inputImage 只能是 assets/ai-chan-sheets 裡的角色設定圖')
        if (!fs.statSync(real).isFile()) throw new Error(`inputImage 不是檔案：${full}`)
        return real
      })
      const inputImage = inputImages[0] ?? null

      fs.mkdirSync(IMAGE_DIR, { recursive: true })
      fs.mkdirSync(WORK_DIR, { recursive: true })
      const sessionId = exec?.agent?.id
      if (!sessionId) throw new Error('generate_image 需要會話身分（DSH 沒給 agent.id）：回報管理員')
      const jobId = randomUUID()
      const controller = new AbortController()
      trackJob(sessionId, controller)
      // 先回報開始，橋接才知道這張圖是誰要的；橋接沒受理就不畫，免得畫完沒人送。
      const reported = await reportImageJob({ phase: 'start', sessionId, jobId })
      if (!reported.body) {
        releaseJob(sessionId, controller)
        throw new Error('橋接沒有受理這次生圖（沒開或會話已結束），先不畫圖：回報管理員')
      }
      void runGenerationJob({ sessionId, jobId, prompt: args.prompt, inputImage, inputImages, codexBin, controller })
      return {
        status: 'started',
        message: '生圖已在背景開始，約 1~3 分鐘。先用 send_message 跟頻道說一聲，然後結束這一輪；'
          + '畫好後系統會送【生圖完成】給你，再用 send_image 送出。現在不要呼叫 send_image。',
      }
    },
  })
}
