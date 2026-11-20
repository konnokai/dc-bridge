// 有 dirty 旗標、延遲存檔的檔案 store。
//
// 這幾個 store 本來在入口是一字不差的同一段程式（setTimeout 2 秒、unref、失敗只寫 log），
// 只差檔名與 log 標籤。集中在這裡之後，存檔時機只有一份，也才有辦法在不啟動橋接的情況下測。
import { loadMemoryFile, saveMemoryFile } from './discord-memory.mjs';
import { loadNotesFile, saveNotesFile } from './discord-notes.mjs';
import { loadKnowledgeFile, saveKnowledgeFile } from './discord-knowledge.mjs';
import { loadMemesFile, saveMemesFile } from './discord-memes.mjs';
import { loadDevFeedbackFile, saveDevFeedbackFile } from './discord-dev-feedback.mjs';

/**
 * 一個 store：載入一次，之後靠 markDirty 排延遲存檔。
 * label 用在「存檔失敗」，warningLabel 用在「載入警告」——兩句原文不一樣，不要合併。
 */
export function createDirtyStore({ label, warningLabel = label, file, load, save, log, delayMs = 2000 }) {
  const loaded = load(file);
  if (loaded.warning) log(`⚠️ ${warningLabel}：${loaded.warning}`);
  let dirty = false;
  let timer = null;

  const flush = () => {
    if (!dirty) return;
    try {
      save(file, loaded.store);
      dirty = false;
    } catch (error) {
      log(`${label}存檔失敗：${error?.message ?? error}`);
    }
  };

  const markDirty = () => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, delayMs);
    // 不要為了等存檔而讓程序多活 2 秒；PM2 停止時會走 shutdown 的同步 flush。
    timer.unref?.();
  };

  return { store: loaded.store, warning: loaded.warning, markDirty, flush, isDirty: () => dirty };
}

/** 入口用的那一組。檔案路徑由呼叫端給，測試才能指到暫存目錄。 */
export function createStores({ log, files }) {
  const build = (name, options) => createDirtyStore({ ...options, log, file: files[name] });
  return {
    memory: build('memory', { label: '記憶', warningLabel: '記憶檔', load: loadMemoryFile, save: saveMemoryFile }),
    notes: build('notes', { label: '頻道筆記', load: loadNotesFile, save: saveNotesFile }),
    knowledge: build('knowledge', { label: '群知識', load: loadKnowledgeFile, save: saveKnowledgeFile }),
    memes: build('memes', { label: '梗圖索引', warningLabel: '梗圖庫', load: loadMemesFile, save: saveMemesFile }),
    devFeedback: build('devFeedback', { label: '開發回饋', load: loadDevFeedbackFile, save: saveDevFeedbackFile }),
  };
}
