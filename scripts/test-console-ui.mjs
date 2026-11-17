#!/usr/bin/env node
/** Discord 控制台的離線瀏覽器回歸；只連測試自己起的 mock server。 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startConsole } from '../src/core/discord-console.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const original = false;

async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean)) {
    try { return require(candidate); } catch {}
  }
  throw new Error('Playwright not found. Install with npm install --no-save playwright, or set PLAYWRIGHT_MODULE to its package directory.');
}

const { chromium } = await loadPlaywright();
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || [
  join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
].find(x => existsSync(x));
let browser;
const results = [];
async function test(name, fn) {
  const start = Date.now();
  try { await fn(); results.push({ name, ok: true, durationMs: Date.now() - start }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.message, durationMs: Date.now() - start }); console.error(`FAIL ${name}: ${error.message}`); }
}

try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

  if (!original) await test('Discord 控制台：頻道風格可按頻道過濾，跟狀態過濾一起作用', async () => {
    const style = (id, channelId, channelName, status, guildName) => ({ id, kind: 'style', channelId, channelName, guildName, term: id, meaning: '描述', status, seen: 1 });
    let entries = [
      { id: 'w1', kind: 'slang', term: '難繃', meaning: '很難繃住', status: 'candidate', seen: 1 },
      ...Array.from({ length: 22 }, (_, i) => style(`chat${i}`, 'c1', '閒聊', i < 2 ? 'confirmed' : 'candidate')),
      style('gen-a', 'c2', 'general', 'confirmed', '伺服器甲'),
      style('gen-b', 'c3', 'general', 'candidate', '伺服器乙'),
      // 橋接查不到頻道名稱時 channelName 會退回 id
      style('gone', '999', '999', 'rejected'),
    ];
    const dc = await startConsole({
      port: 0, token: 't', htmlPath: join(here, '..', 'public', 'discord-console.html'),
      handlers: {
        status: () => ({ bot: null, dsh: {}, sessions: 0, pending: 0, allow: { guilds: 0, channels: 0, users: 0 }, ownerIds: [], media: {}, console: { host: '127.0.0.1', port: 0 } }),
        invite: () => ({}),
        usage: ({ range }) => ({ range, totals: {}, conversations: [], series: { buckets: [] } }),
        quota: async () => ({ skipped: true }),
        memory: () => ({ enabled: true, users: [] }),
        followups: () => ({ enabled: true, items: [] }),
        sessions: () => [],
        config: () => ({ allow: {}, deny: {}, ownerIds: [], media: {} }),
        slang: () => ({ entries, learning: { enabled: true } }),
        knowledge: () => ({ enabled: true, stats: { total: 0, candidate: 0, approved: 0, rejected: 0 }, entries: [] }),
        logs: () => [],
      },
    });
    const dcBase = `http://127.0.0.1:${dc.server.address().port}`;
    const dcContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const dcErrors = [];
      const p = await dcContext.newPage();
      p.setDefaultTimeout(8000);
      p.on('pageerror', error => dcErrors.push(error.message));
      await p.goto(`${dcBase}/?token=t#slang`);
      const select = p.locator('#style-channel');
      await p.waitForFunction(() => document.querySelectorAll('#style-channel option').length === 5);
      const optionTexts = await select.locator('option').allTextContents();
      assert.equal(optionTexts[0], '全部頻道（25）');
      // 中文排序依 ICU 版本可能不同，只比對集合。
      assert.deepEqual(optionTexts.slice(1).sort(), [
        '#999（1）', '#閒聊（22）', '#general · 伺服器甲（1）', '#general · 伺服器乙（1）',
      ].sort());
      assert.equal(await select.inputValue(), 'all');
      assert.equal(await select.getAttribute('aria-label'), '頻道');

      const styleRows = p.locator('#style-rows tr');
      const channelCells = () => p.locator('#style-rows tr td:nth-child(2)').allTextContents();
      await p.locator('#style-pager button', { hasText: '下一頁' }).click();
      assert.match(await p.locator('#style-pager').textContent(), /第 2 \/ 2 頁/);

      await select.selectOption('c1');
      assert.match(await p.locator('#style-pager').textContent(), /第 1 \/ 2 頁（22 筆）/, '換頻道要回到第 1 頁');
      assert.equal(await styleRows.count(), 20);
      assert((await channelCells()).every(text => text === '#閒聊'));

      await p.locator('#style-filter button[data-status="confirmed"]').click();
      assert.equal(await styleRows.count(), 2);
      assert.equal(await p.locator('#style-filter button[data-status="confirmed"]').textContent(), '已確認 2');
      assert.equal(await p.locator('#style-filter button[data-status="candidate"]').textContent(), '待確認 20', '狀態計數只算選到的頻道');

      await select.selectOption('c2');
      assert.deepEqual(await channelCells(), ['#general · 伺服器甲']);
      assert.equal(await p.locator('#style-filter button[data-status="confirmed"]').getAttribute('aria-pressed'), 'true', '換頻道不重設狀態過濾');

      await select.selectOption('999');
      assert.equal(await p.locator('#style-rows td').textContent(), '這個狀態沒有項目。');
      await p.locator('#style-filter button[data-status="all"]').click();
      assert.deepEqual(await channelCells(), ['#999']);
      assert.match(await p.locator('#style-count').textContent(), /待確認 0｜已確認 0｜已拒絕 1/);
      assert.equal(await p.locator('#slang-rows tr').count(), 1, '黑話卡片不受頻道選單影響');

      const refreshed = () => Promise.all([
        p.waitForResponse(r => new URL(r.url()).pathname === '/api/slang'),
        p.locator('#refresh').click(),
      ]);
      // 筆數變了但頻道沒增減：只改文字，不重建 option（重建會關掉使用者正打開的選單）。
      entries = [...entries, style('chat-new', 'c1', '閒聊', 'candidate')];
      await select.evaluate(node => { node.options[0].keep = true; });
      await refreshed();
      await p.waitForFunction(() => document.querySelector('#style-channel option').textContent === '全部頻道（26）');
      assert.equal(await select.evaluate(node => node.options[0].keep), true, '頻道沒增減時不重建選項');
      assert.equal(await select.inputValue(), '999', '重新整理後保留選到的頻道');

      entries = entries.filter(entry => entry.channelId !== '999');
      await refreshed();
      await p.waitForFunction(() => document.querySelectorAll('#style-channel option').length === 4);
      assert.equal(await select.inputValue(), 'all', '頻道已經沒有條目時退回全部頻道');
      assert.equal(await styleRows.count(), 20);
      assert.deepEqual(dcErrors, []);
    } finally {
      await dcContext.close();
      await dc.close();
    }
  });

  if (!original) await test('Discord 控制台：黑話批次確認與拒絕', async () => {
    const entries = [
      { id: 'c1', kind: 'slang', term: '難繃', meaning: '受不了', usage: '', status: 'candidate', seen: 1 },
      { id: 'c2', kind: 'slang', term: '破防', meaning: '心態崩', usage: '', status: 'candidate', seen: 1 },
      { id: 'c3', kind: 'slang', term: '大肥魚', meaning: 'AI 暱稱', usage: '', status: 'confirmed', seen: 3 },
    ];
    const calls = [];
    const dc = await startConsole({
      port: 0, token: 't', htmlPath: join(here, '..', 'public', 'discord-console.html'),
      handlers: {
        status: () => ({ bot: null, dsh: {}, sessions: 0, pending: 0, allow: { guilds: 0, channels: 0, users: 0 }, ownerIds: [], media: {}, console: { host: '127.0.0.1', port: 0 } }),
        invite: () => ({}),
        usage: ({ range }) => ({ range, totals: {}, conversations: [], series: { buckets: [] } }),
        quota: async () => ({ skipped: true }),
        memory: () => ({ enabled: true, users: [] }),
        followups: () => ({ enabled: true, items: [] }),
        sessions: () => [],
        config: () => ({ allow: {}, deny: {}, ownerIds: [], media: {} }),
        slang: () => ({ entries, learning: { enabled: true } }),
        slangConfirmMany: (ids) => { calls.push({ action: 'confirm', ids }); return { confirmed: ids.length, skipped: 0 }; },
        slangRejectMany: (ids) => { calls.push({ action: 'reject', ids }); return { rejected: ids.length, skipped: 0 }; },
        knowledge: () => ({ enabled: true, stats: { total: 0, candidate: 0, approved: 0, rejected: 0 }, entries: [] }),
        logs: () => [],
      },
    });
    const dcBase = `http://127.0.0.1:${dc.server.address().port}`;
    const dcContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const p = await dcContext.newPage();
      p.setDefaultTimeout(8000);
      await p.goto(`${dcBase}/?token=t#slang`);
      await p.waitForFunction(() => document.querySelectorAll('#slang-rows tr').length === 3);
      assert.equal(await p.locator('#slang-rows input[type="checkbox"]').count(), 2, '只有候選有勾選框');
      await p.locator('#slang-select-page').click();
      assert.equal(await p.locator('#slang-rows input[type="checkbox"]:checked').count(), 2, '全選本頁勾選候選');

      const confirmResp = p.waitForResponse(r => new URL(r.url()).pathname === '/api/slang/batch-confirm');
      p.once('dialog', (dialog) => dialog.accept());
      await p.locator('#slang-batch-confirm').click();
      await confirmResp;
      assert.deepEqual(calls.at(-1), { action: 'confirm', ids: ['c1', 'c2'] }, '批次確認只送候選 id');

      await p.locator('#slang-select-page').click();
      const rejectResp = p.waitForResponse(r => new URL(r.url()).pathname === '/api/slang/batch-reject');
      p.once('dialog', (dialog) => dialog.accept());
      await p.locator('#slang-batch-reject').click();
      await rejectResp;
      assert.deepEqual(calls.at(-1), { action: 'reject', ids: ['c1', 'c2'] }, '批次拒絕送同一批候選');
    } finally {
      await dcContext.close();
      await dc.close();
    }
  });

  if (!original) await test('Discord 控制台：群知識可確認、可從訊息連結新增', async () => {
    const entries = [
      {
        id: 'k1', title: '繪圖設定', body: '畫大肥魚時保留鯨魚尾', scope: 'guild', guildId: 'g1', channelId: 'c1',
        triggers: { always: false, keywords: ['畫圖'], tools: [] }, status: 'candidate', byName: 'Sora',
        guildName: '測試伺服器', channelName: '閒聊', updatedAt: '2026-11-10T00:00:00.000Z',
      },
      {
        id: 'k2', title: '群規', body: '不要貼政治', scope: 'channel', guildId: 'g1', channelId: 'c1',
        triggers: { always: true, keywords: [], tools: [] }, status: 'approved', byName: '管理員',
        guildName: '測試伺服器', channelName: '閒聊', updatedAt: '2026-11-10T00:00:00.000Z',
      },
    ];
    const writes = [];
    const dc = await startConsole({
      port: 0, token: 't', htmlPath: join(here, '..', 'public', 'discord-console.html'),
      handlers: {
        status: () => ({ bot: null, dsh: {}, sessions: 0, pending: 0, allow: { guilds: 0, channels: 0, users: 0 }, ownerIds: [], media: {}, console: { host: '127.0.0.1', port: 0 } }),
        invite: () => ({}),
        usage: ({ range }) => ({ range, totals: {}, conversations: [], series: { buckets: [] } }),
        quota: async () => ({ skipped: true }),
        memory: () => ({ enabled: true, users: [] }),
        followups: () => ({ enabled: true, items: [] }),
        sessions: () => [],
        config: () => ({ allow: {}, deny: {}, ownerIds: [], media: {} }),
        slang: () => ({ entries: [], learning: { enabled: true } }),
        knowledge: () => ({
          enabled: true,
          stats: { total: 2, candidate: 1, approved: 1, rejected: 0 },
          entries,
        }),
        knowledgeConfirm: (id, patch) => {
          writes.push({ action: 'confirm', id, patch });
          return entries.find((entry) => entry.id === id) ?? null;
        },
        knowledgeCreate: (body) => {
          writes.push({ action: 'create', body });
          return { ok: true, entry: { title: body.title || '#閒聊 的資料' } };
        },
        logs: () => [],
      },
    });
    const dcBase = `http://127.0.0.1:${dc.server.address().port}`;
    const dcContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const dcErrors = [];
      const p = await dcContext.newPage();
      p.setDefaultTimeout(8000);
      p.on('pageerror', error => dcErrors.push(error.message));
      await p.goto(`${dcBase}/?token=t#knowledge`);
      await p.waitForFunction(() => document.querySelectorAll('#knowledge-rows tr').length === 2);
      const bodyText = await p.locator('#knowledge-rows').textContent();
      assert.match(bodyText, /繪圖設定/);
      assert.match(bodyText, /詞：畫圖/);
      assert.match(bodyText, /每批/);
      assert.match(await p.locator('#knowledge-count').textContent(), /待確認 1｜已確認 1/);

      // 放大：表格只看得到前三行，彈窗要能看到完整正文。
      const viewButton = p.locator('#knowledge-rows tr').filter({ hasText: '繪圖設定' }).locator('button[data-action="view"]');
      await viewButton.click();
      assert.equal(await p.locator('#detail-modal').isVisible(), true);
      assert.equal(await p.locator('#detail-title').textContent(), '繪圖設定');
      assert.match(await p.locator('#detail-body').textContent(), /鯨魚尾/);
      await p.keyboard.press('Escape');
      assert.equal(await p.locator('#detail-modal').isVisible(), false, 'Esc 關閉');

      await viewButton.click();
      await p.mouse.click(4, 4);
      assert.equal(await p.locator('#detail-modal').isVisible(), false, '點背景關閉');

      await viewButton.click();
      await p.locator('#detail-close').click();
      assert.equal(await p.locator('#detail-modal').isVisible(), false);

      const confirmRequest = p.waitForRequest(r => new URL(r.url()).pathname === '/api/knowledge/confirm');
      await p.locator('#knowledge-rows tr').filter({ hasText: '繪圖設定' }).locator('button[data-action="confirm"]').click();
      assert.deepEqual((await confirmRequest).postDataJSON(), { id: 'k1', updatedAt: '2026-11-10T00:00:00.000Z' });

      await p.fill('#knowledge-link', 'https://discord.com/channels/1/2/3');
      await p.fill('#knowledge-title', '新的設定');
      await p.fill('#knowledge-keywords', '畫圖, 繪圖');
      await p.locator('#knowledge-create').click();
      await p.waitForFunction(() => document.querySelector('#knowledge-create-note').textContent.includes('已建立'));
      const create = writes.find((item) => item.action === 'create');
      assert.equal(create.body.link, 'https://discord.com/channels/1/2/3');
      assert.equal(create.body.title, '新的設定');
      assert.deepEqual(create.body.keywords, ['畫圖', '繪圖']);
      assert.equal(create.body.always, false);
      assert.equal(create.body.scope, 'guild');
      assert.equal(await p.locator('#knowledge-link').inputValue(), '', '建立後清空表單');
      assert.deepEqual(dcErrors, []);
    } finally {
      await dcContext.close();
      await dc.close();
    }
  });

  if (!original) await test('Discord 控制台：黑話與頻道標籤可搜尋', async () => {
    let entries = [
      { id: 's1', kind: 'slang', term: '大肥魚', meaning: '群內 AI 的暱稱', usage: '呼叫 AI 時用', status: 'confirmed', seen: 1 },
      { id: 's2', kind: 'slang', term: '破防', meaning: '心態崩了', usage: '自嘲時', status: 'rejected', seen: 2 },
      { id: 's3', kind: 'slang', term: '脆', meaning: 'Threads 平台', usage: '提到討論時', status: 'confirmed', seen: 3 },
      { id: 't1', kind: 'style', channelId: 'c1', channelName: '閒聊', term: '短句', meaning: '大家隨意聊', status: 'confirmed', seen: 1 },
      { id: 't2', kind: 'style', channelId: 'c2', channelName: 'general', guildName: '伺服器甲', term: '正式', meaning: '語氣正式', status: 'candidate', seen: 2 },
    ];
    const dc = await startConsole({
      port: 0, token: 't', htmlPath: join(here, '..', 'public', 'discord-console.html'),
      handlers: {
        status: () => ({ bot: null, dsh: {}, sessions: 0, pending: 0, allow: { guilds: 0, channels: 0, users: 0 }, ownerIds: [], media: {}, console: { host: '127.0.0.1', port: 0 } }),
        invite: () => ({}),
        usage: ({ range }) => ({ range, totals: {}, conversations: [], series: { buckets: [] } }),
        quota: async () => ({ skipped: true }),
        memory: () => ({ enabled: true, users: [] }),
        followups: () => ({ enabled: true, items: [] }),
        sessions: () => [],
        config: () => ({ allow: {}, deny: {}, ownerIds: [], media: {} }),
        slang: () => ({ entries, learning: { enabled: true } }),
        knowledge: () => ({ enabled: true, stats: { total: 0, candidate: 0, approved: 0, rejected: 0 }, entries: [] }),
        logs: () => [],
      },
    });
    const dcContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const dcErrors = [];
      const p = await dcContext.newPage();
      p.setDefaultTimeout(8000);
      p.on('pageerror', error => dcErrors.push(error.message));
      await p.goto(`http://127.0.0.1:${dc.server.address().port}/?token=t#slang`);
      await p.waitForFunction(() => document.querySelectorAll('#slang-rows tr').length === 3);
      const terms = () => p.locator('#slang-rows tr td:nth-child(2)').allTextContents();
      const tags = () => p.locator('#style-rows tr td:nth-child(3)').allTextContents();

      await p.fill('#slang-search', '心態');
      assert.deepEqual(await terms(), ['破防'], '搜得到意思');
      assert.equal(await p.locator('#slang-filter button[data-status="all"]').textContent(), '全部 1', '狀態計數只算搜尋結果');
      await p.fill('#slang-search', '呼叫');
      assert.deepEqual(await terms(), ['大肥魚'], '搜得到用法');
      await p.fill('#slang-search', 'threads');
      assert.deepEqual(await terms(), ['脆'], '不分大小寫');

      await p.fill('#style-search', 'general');
      assert.deepEqual(await tags(), ['正式'], '頻道標籤搜得到頻道名');
      assert.equal(await p.locator('#slang-rows tr').count(), 1, '兩張卡片的搜尋互不影響');
      await p.fill('#style-search', '甲');
      assert.deepEqual(await tags(), ['正式'], '頻道標籤搜得到伺服器名');
      await p.fill('#style-search', '隨意');
      assert.deepEqual(await tags(), ['短句'], '頻道標籤搜得到描述');
      await p.fill('#style-search', '正式');
      assert.deepEqual(await tags(), ['正式'], '頻道標籤搜得到標籤本身');

      await p.fill('#slang-search', '不存在');
      assert.match(await p.locator('#slang-rows').textContent(), /沒有符合的項目/);

      // 先搜一個會命中的字，重新整理後多一筆也命中的詞條，確認搜尋字真的有留下。
      await p.fill('#slang-search', '心態');
      entries = [...entries, { id: 's4', kind: 'slang', term: '佛系', meaning: '心態放平', usage: '不想爭時', status: 'candidate', seen: 1 }];
      await Promise.all([
        p.waitForResponse(r => new URL(r.url()).pathname === '/api/slang'),
        p.locator('#refresh').click(),
      ]);
      await p.waitForFunction(() => document.querySelectorAll('#slang-rows tr').length === 2);
      assert.deepEqual(await terms(), ['破防', '佛系'], '重新整理後仍套用搜尋字');
      assert.equal(await p.locator('#slang-filter button[data-status="all"]').textContent(), '全部 2', '重新整理後計數跟著搜尋結果');

      await p.locator('#slang-filter button[data-status="confirmed"]').click();
      assert.match(await p.locator('#slang-rows').textContent(), /這個狀態沒有項目/, '有搜尋結果、但被狀態過濾掉');
      await p.locator('#slang-filter button[data-status="all"]').click();
      await p.fill('#slang-search', '');
      assert.equal(await p.locator('#slang-rows tr').count(), 4, '清掉搜尋就回到全部');
      assert.deepEqual(dcErrors, []);
    } finally {
      await dcContext.close();
      await dc.close();
    }
  });

  await test('Discord 控制台：黑話／頻道表欄寬與列高固定，操作按鈕不隨內容位移', async () => {
    let entries = [
      { id: 's1', kind: 'slang', term: '短', meaning: '短', usage: '短', status: 'candidate', seen: 1 },
      { id: 's2', kind: 'slang', term: '長'.repeat(30), meaning: '長'.repeat(80), usage: '長'.repeat(80), status: 'confirmed', seen: 2 },
      { id: 's3', kind: 'slang', term: '拒絕', meaning: '拒絕的', usage: '', status: 'rejected', seen: 3 },
      { id: 't1', kind: 'style', channelId: 'c1', channelName: '短', term: '甲', meaning: '短描述', status: 'candidate', seen: 1 },
      { id: 't2', kind: 'style', channelId: 'c2', channelName: '長'.repeat(30), term: '乙', meaning: '長'.repeat(80), status: 'confirmed', seen: 2 },
    ];
    const dc = await startConsole({
      port: 0, token: 't', htmlPath: join(here, '..', 'public', 'discord-console.html'),
      handlers: {
        status: () => ({ bot: null, dsh: {}, sessions: 0, pending: 0, allow: { guilds: 0, channels: 0, users: 0 }, ownerIds: [], media: {}, console: { host: '127.0.0.1', port: 0 } }),
        invite: () => ({}),
        usage: ({ range }) => ({ range, totals: {}, conversations: [], series: { buckets: [] } }),
        quota: async () => ({ skipped: true }),
        memory: () => ({ enabled: true, users: [] }),
        followups: () => ({ enabled: true, items: [] }),
        sessions: () => [],
        config: () => ({ allow: {}, deny: {}, ownerIds: [], media: {} }),
        slang: () => ({ entries, learning: { enabled: true } }),
        knowledge: () => ({ enabled: true, stats: { total: 0, candidate: 0, approved: 0, rejected: 0 }, entries: [] }),
        logs: () => [],
      },
    });
    const dcContext = await browser.newContext({ viewport: { width: 648, height: 900 } });
    try {
      const p = await dcContext.newPage();
      p.setDefaultTimeout(8000);
      await p.goto(`http://127.0.0.1:${dc.server.address().port}/?token=t#slang`);
      await p.waitForFunction(() => document.querySelectorAll('#slang-rows tr').length === 3
        && document.querySelectorAll('#style-rows tr').length === 2);
      const metrics = (id) => p.locator(`#${id}`).evaluate((tbody) => {
        const rows = [...tbody.querySelectorAll('tr')];
        return {
          heights: rows.map((tr) => Math.round(tr.getBoundingClientRect().height)),
          editX: rows.map((tr) => Math.round(tr.querySelector('[data-action="edit"]').getBoundingClientRect().x)),
        };
      });
      const same = (m, name) => {
        assert(m.heights.every((h) => h > 0), `${name}：列高要大於 0`);
        assert.equal(new Set(m.editX).size, 1, `${name}：不同內容的列，編輯按鈕 x 要一樣`);
        assert.equal(new Set(m.heights).size, 1, `${name}：不同內容的列，列高要一樣`);
      };
      const before = await metrics('slang-rows');
      same(before, '黑話表');
      same(await metrics('style-rows'), '頻道表');

      entries = [{ ...entries[0], meaning: '很長'.repeat(300), usage: '很長'.repeat(300) }, ...entries.slice(1)];
      await Promise.all([
        p.waitForResponse(r => new URL(r.url()).pathname === '/api/slang'),
        p.locator('#refresh').click(),
      ]);
      await p.waitForFunction(() => document.querySelector('#slang-rows tr td:nth-child(3)').textContent.startsWith('很長'));
      const after = await metrics('slang-rows');
      assert.deepEqual(after, before, '內容變長後欄寬、列高與按鈕位置都不能變');
    } finally {
      await dcContext.close();
      await dc.close();
    }
  });

  if (!original) await test('Discord 控制台：已拒絕的黑話可以復原', async () => {
    let entries = [
      { id: 'r1', kind: 'slang', term: '拒絕', meaning: '拒絕的', usage: '', status: 'rejected', seen: 3 },
    ];
    let confirmedId = null;
    const dc = await startConsole({
      port: 0, token: 't', htmlPath: join(here, '..', 'public', 'discord-console.html'),
      handlers: {
        status: () => ({ bot: null, dsh: {}, sessions: 0, pending: 0, allow: { guilds: 0, channels: 0, users: 0 }, ownerIds: [], media: {}, console: { host: '127.0.0.1', port: 0 } }),
        invite: () => ({}),
        usage: ({ range }) => ({ range, totals: {}, conversations: [], series: { buckets: [] } }),
        quota: async () => ({ skipped: true }),
        memory: () => ({ enabled: true, users: [] }),
        followups: () => ({ enabled: true, items: [] }),
        sessions: () => [],
        config: () => ({ allow: {}, deny: {}, ownerIds: [], media: {} }),
        slang: () => ({ entries, learning: { enabled: true } }),
        slangConfirm: (id) => {
          confirmedId = id;
          entries = entries.map((entry) => (entry.id === id ? { ...entry, status: 'confirmed' } : entry));
          return entries.find((entry) => entry.id === id);
        },
        knowledge: () => ({ enabled: true, stats: { total: 0, candidate: 0, approved: 0, rejected: 0 }, entries: [] }),
        logs: () => [],
      },
    });
    const dcContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const p = await dcContext.newPage();
      p.setDefaultTimeout(8000);
      await p.goto(`http://127.0.0.1:${dc.server.address().port}/?token=t#slang`);
      await p.waitForFunction(() => document.querySelectorAll('#slang-rows tr').length === 1);
      const restore = p.locator('#slang-rows tr button[data-action="confirm"]');
      assert.equal(await restore.textContent(), '復原');
      const request = p.waitForRequest((r) => new URL(r.url()).pathname === '/api/slang/confirm' && r.method() === 'POST');
      const refreshed = p.waitForResponse((r) => new URL(r.url()).pathname === '/api/slang' && r.request().method() === 'GET');
      await restore.click();
      assert.deepEqual((await request).postDataJSON(), { id: 'r1' });
      await refreshed;
      assert.equal(confirmedId, 'r1');
      await p.waitForFunction(() => document.querySelector('#slang-rows tr td:nth-child(5)')?.textContent === '已確認');
    } finally {
      await dcContext.close();
      await dc.close();
    }
  });

  await test('Discord 控制台：對話表欄寬固定，換頁與內容變動不跳動', async () => {
    let users = Array.from({ length: 22 }, (_, i) => ({
      userId: String(1000 + i),
      name: `群友 ${i}`,
      count: 22 - i,
      drawCount: (i * 7) % 22,
      channelName: '#聊天區',
      lastAt: Date.now(),
      firstAt: Date.now(),
    }));
    const dc = await startConsole({
      port: 0, token: 't', htmlPath: join(here, '..', 'public', 'discord-console.html'),
      handlers: {
        status: () => ({ bot: null, dsh: {}, sessions: 0, pending: 0, allow: { guilds: 0, channels: 0, users: 0 }, ownerIds: [], media: {}, console: { host: '127.0.0.1', port: 0 } }),
        invite: () => ({}),
        usage: ({ range }) => ({ range, totals: {}, conversations: [], series: { buckets: [] } }),
        quota: async () => ({ skipped: true }),
        memory: () => ({ enabled: true, users: [] }),
        followups: () => ({ enabled: true, items: [] }),
        sessions: () => [],
        config: () => ({ allow: {}, deny: {}, ownerIds: [], media: {} }),
        slang: () => ({ entries: [], learning: { enabled: true } }),
        knowledge: () => ({ enabled: true, stats: { total: 0, candidate: 0, approved: 0, rejected: 0 }, entries: [] }),
        triggers: () => ({ todayUsers: users.length, totalUsers: users.length, totalTriggers: 100, totalDraws: 0, users }),
        logs: () => [],
      },
    });
    const dcContext = await browser.newContext({ viewport: { width: 1204, height: 1000 } });
    try {
      const p = await dcContext.newPage();
      p.setDefaultTimeout(8000);
      await p.goto(`http://127.0.0.1:${dc.server.address().port}/?token=t#triggers`);
      await p.waitForFunction(() => document.querySelectorAll('#trigger-rows tr').length === 20);
      const widths = () => p.locator('#trigger-rows tr:first-child td')
        .evaluateAll((tds) => tds.map((td) => Math.round(td.getBoundingClientRect().width)));
      const before = await widths();
      await p.locator('#trigger-pager button', { hasText: '下一頁' }).click();
      await p.waitForFunction(() => document.querySelector('#trigger-pager').textContent.includes('第 2 / 2 頁'));
      assert.deepEqual(await widths(), before, '換頁後欄寬不能變');

      const firstName = () => p.locator('#trigger-rows tr:first-child td strong').textContent();
      const sortHeader = (key) => p.locator(`#tab-triggers th[data-sort-key="${key}"]`);
      await sortHeader('count').locator('button').click();
      assert.equal(await firstName(), '群友 21', '次數第一次點擊改遞增');
      assert.equal(await sortHeader('count').getAttribute('aria-sort'), 'ascending');
      await sortHeader('count').locator('button').click();
      assert.equal(await firstName(), '群友 0', '再點一次改回遞減');
      assert.equal(await sortHeader('count').getAttribute('aria-sort'), 'descending');
      await sortHeader('drawCount').locator('button').click();
      assert.equal(await firstName(), '群友 3', '畫圖預設由多到少');
      assert.equal(await sortHeader('count').getAttribute('aria-sort'), null, '舊欄位的 aria-sort 要移除');
      assert.equal(await sortHeader('drawCount').getAttribute('aria-sort'), 'descending');

      users = users.map((user) => ({ ...user, name: `${user.name}${'很長'.repeat(20)}`, channelName: '#很長的頻道名稱' }));
      await Promise.all([
        p.waitForResponse((response) => new URL(response.url()).pathname === '/api/triggers'),
        p.locator('#refresh').click(),
      ]);
      await p.waitForFunction(() => document.querySelector('#trigger-rows tr:first-child td').textContent.includes('很長'));
      assert.deepEqual(await widths(), before, '內容變長後欄寬不能變');
    } finally {
      await dcContext.close();
      await dc.close();
    }
  });

  await test('Discord 控制台：手機寬度下各表儲存格內容不溢出到隔壁欄，排序同值保留伺服器順序', async () => {
    const old = Date.parse('2026-01-02T03:04:05Z');
    const dc = await startConsole({
      port: 0, token: 't', htmlPath: join(here, '..', 'public', 'discord-console.html'),
      handlers: {
        status: () => ({
          bot: null, dsh: {}, sessions: 1, pending: 0, allow: { guilds: 0, channels: 0, users: 0 }, ownerIds: [], media: {}, console: { host: '127.0.0.1', port: 0 },
          emoji: { entries: 1, guilds: 1, items: [{ guildId: '123456789012345678', guildName: '很長的伺服器名稱'.repeat(3), entries: 1234, builtAt: old }] },
          ignored: [{ userId: '123456789012345678', name: '群友', reason: '很長的原因'.repeat(10), until: old, at: old }],
        }),
        invite: () => ({}),
        usage: ({ range }) => ({
          range, totals: { cost: 9999 }, series: { buckets: [] },
          conversations: [{ key: 'discord:ch:123456789012345678', turns: 12345, steps: 123456, cost: 1234.56, buckets: { cacheMiss: 123456789, cacheHit: 98765432, output: 99999 } }],
        }),
        quota: async () => ({ skipped: true }),
        memory: () => ({ enabled: true, users: [{ userId: '1', name: '群友', facts: ['事情'], updatedAt: old }] }),
        followups: () => ({ enabled: true, items: [
          { id: 'f1', key: 'discord:ch:123456789012345678', where: '#很長的頻道名稱', note: '回來看很長很長的話題'.repeat(3), remainingMinutes: 25, at: new Date(old).toISOString() },
          { id: 'f2', key: 'discord:ch:123456789012345678', where: '#很長的頻道名稱', note: '一個半小時後', remainingMinutes: 90, at: new Date(old).toISOString() },
          { id: 'f3', key: 'discord:ch:223456789012345678', where: '#很長的頻道名稱', note: '月底再看', remainingMinutes: 43200, at: new Date(old).toISOString() },
        ] }),
        notes: () => ({ enabled: true, notes: [{ id: 'n1', channelId: '123456789012345678', channelName: '很長的頻道名稱', text: '筆記', by: 'summary', at: new Date(old).toISOString(), expiresAt: old }] }),
        sessions: () => [{ key: 'discord:ch:123456789012345678', label: '#很長的頻道名稱 · 很長的伺服器名稱', sessionId: 'ses_0123456789abcdefghijklmn', preset: 'dc-chat-open', lastActive: old, quietUntil: old, pending: 'question' }],
        config: () => ({ allow: {}, deny: {}, ownerIds: [], media: {} }),
        slang: () => ({ entries: [], learning: { enabled: true } }),
        knowledge: () => ({ enabled: true, stats: { total: 0, candidate: 0, approved: 0, rejected: 0 }, entries: [] }),
        // 伺服器已按「次數多、最近觸發」排好；同次數時前端不能再重排。
        triggers: () => ({ todayUsers: 2, totalUsers: 2, totalTriggers: 2, totalDraws: 0, users: [
          { userId: '2', name: 'b-user', count: 1, drawCount: 0, channelName: '#很長的頻道名稱', lastAt: old + 1000, firstAt: old },
          { userId: '1', name: 'a-user', count: 1, drawCount: 0, channelName: '#很長的頻道名稱', lastAt: old, firstAt: old },
        ] }),
        logs: () => [],
      },
    });
    const dcContext = await browser.newContext({ viewport: { width: 375, height: 900 } });
    try {
      const p = await dcContext.newPage();
      p.setDefaultTimeout(8000);
      await p.goto(`http://127.0.0.1:${dc.server.address().port}/?token=t#usage`);
      const overflowing = (tab) => p.locator(`#tab-${tab}`).evaluate((panel) => [...panel.querySelectorAll('th, td')]
        .filter((cell) => cell.scrollWidth > cell.clientWidth + 1)
        .map((cell) => `${cell.closest('tbody, thead').id || 'thead'}: ${cell.textContent.trim().slice(0, 30)}`));
      const tabs = [['usage', '#usage-rows tr.clickable'], ['settings', '#emoji-guilds tr td:nth-child(2)'], ['triggers', '#trigger-rows tr:nth-child(2)'],
        ['memory', '#note-rows button'], ['sessions', '#ignored-rows button']];
      for (const [tab, ready] of tabs) {
        await p.locator(`#tabbtn-${tab}`).click();
        await p.locator(ready).first().waitFor();
        assert.deepEqual(await overflowing(tab), [], `${tab} 分頁有儲存格溢出`);
      }
      assert.deepEqual(await p.locator('#trigger-rows tr td strong').allTextContents(), ['b-user', 'a-user']);
      assert.match(await p.locator('#sessions tr td:first-child').textContent(), /#很長的頻道名稱 · 很長的伺服器名稱/,
        '會話欄顯示頻道 + 伺服器名稱，不是 key');
      assert.equal(await p.locator('#sessions tr td:nth-child(3)').textContent(), 'dc-chat-open',
        '會話表顯示實際 preset');
      assert.match(await p.locator('#followup-rows tr td:nth-child(3)').first().textContent(), /25 分鐘/,
        '回訪卡片顯示剩餘時間');
      assert.deepEqual(await p.locator('#followup-rows tr td:nth-child(3)').allTextContents(), ['25 分鐘', '1.5 小時', '30 天'],
        '剩餘時間換算成小時與天');
    } finally {
      await dcContext.close();
      await dc.close();
    }
  });

  await test('Discord 控制台：群友記憶、頻道筆記、梗圖每頁 20 筆，可依名稱或 ID 篩選', async () => {
    const old = Date.parse('2026-01-02T03:04:05Z');
    const pad = (index) => String(index).padStart(2, '0');
    const userId = (index) => `9000000000000000${pad(index)}`;
    const dc = await startConsole({
      port: 0, token: 't', htmlPath: join(here, '..', 'public', 'discord-console.html'),
      handlers: {
        status: () => ({ bot: null, dsh: {}, sessions: 0, pending: 0, allow: {}, ownerIds: [], media: {}, console: { host: '127.0.0.1', port: 0 } }),
        invite: () => ({}),
        usage: ({ range }) => ({ range, totals: {}, conversations: [], series: { buckets: [] } }),
        quota: async () => ({ skipped: true }),
        memory: () => ({ enabled: true, users: Array.from({ length: 25 }, (_, i) => ({
          userId: userId(i), name: `群友${pad(i)}`, facts: ['事情'], updatedAt: old,
        })) }),
        followups: () => ({ enabled: true, items: [] }),
        notes: () => ({ enabled: true, notes: Array.from({ length: 25 }, (_, i) => ({
          id: `n${i}`, channelId: `2000000000000000${pad(i)}`, channelName: `頻道${pad(i)}`,
          text: `筆記${i}`, by: 'model', at: new Date(old).toISOString(), expiresAt: old,
        })) }),
        memes: () => ({ enabled: true, memes: Array.from({ length: 25 }, (_, i) => ({
          id: `m_${pad(i)}`, name: `梗圖${pad(i)}`, when: '', tags: [], guildName: '伺服器',
          createdBy: 'user', channelName: '頻道', uses: 0, width: 256, height: 256, bytes: 1024,
        })) }),
        memeImage: () => ({
          // 1×1 PNG：讓「放大後真的看得到圖」這條路徑有被測到。
          buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
          mime: 'image/png',
        }),
        sessions: () => [],
        config: () => ({ allow: {}, deny: {}, ownerIds: [], media: {} }),
        slang: () => ({ entries: [], learning: { enabled: true } }),
        knowledge: () => ({ enabled: true, stats: { total: 0, candidate: 0, approved: 0, rejected: 0 }, entries: [] }),
        logs: () => [],
      },
    });
    const dcContext = await browser.newContext({ viewport: { width: 1204, height: 1000 } });
    try {
      const p = await dcContext.newPage();
      p.setDefaultTimeout(8000);
      const pageErrors = [];
      p.on('pageerror', (error) => pageErrors.push(error.message));
      await p.goto(`http://127.0.0.1:${dc.server.address().port}/?token=t#memory`);
      await p.waitForFunction(() => document.querySelectorAll('#memory-rows tr').length === 20);
      assert.match(await p.locator('#memory-pager').textContent(), /第 1 \/ 2 頁（25 人）/);
      await p.locator('#memory-pager button', { hasText: '下一頁' }).click();
      assert.equal(await p.locator('#memory-rows tr').count(), 5, '群友記憶第 2 頁剩 5 筆');
      assert.match(await p.locator('#memory-rows tr').first().textContent(), /群友20/);

      await p.locator('#memory-search').fill('群友1');
      await p.waitForFunction(() => document.querySelectorAll('#memory-rows tr').length === 10);
      assert.equal(await p.locator('#memory-pager').textContent(), '', '一頁放得下就不顯示分頁');
      await p.locator('#memory-search').fill(userId(3));
      await p.waitForFunction(() => document.querySelectorAll('#memory-rows tr').length === 1);
      assert.match(await p.locator('#memory-rows tr').textContent(), /群友03/, '可用 user id 找到人');

      await p.waitForFunction(() => document.querySelectorAll('#note-rows tr').length === 20);
      assert.match(await p.locator('#note-pager').textContent(), /第 1 \/ 2 頁（25 條）/);
      await p.locator('#note-search').fill('頻道07');
      await p.waitForFunction(() => document.querySelectorAll('#note-rows tr').length === 1);
      assert.match(await p.locator('#note-rows tr').textContent(), /筆記7/);

      await p.waitForFunction(() => document.querySelectorAll('#meme-rows tr').length === 20);
      assert.match(await p.locator('#meme-pager').textContent(), /第 1 \/ 2 頁（25 張）/);
      await p.locator('#meme-pager button', { hasText: '下一頁' }).click();
      assert.equal(await p.locator('#meme-rows tr').count(), 5, '梗圖第 2 頁剩 5 筆');
      await Promise.all([
        p.waitForResponse((response) => new URL(response.url()).pathname === '/api/memes'),
        p.locator('#refresh').click(),
      ]);
      assert.equal(await p.locator('#meme-rows tr').count(), 5, '重新整理後仍停在第 2 頁');
      assert.match(await p.locator('#meme-pager').textContent(), /第 2 \/ 2 頁/, '重新整理不會把頁碼歸零');
      await p.locator('#meme-search').fill('梗圖');
      await p.waitForFunction(() => document.querySelectorAll('#meme-rows tr').length === 20);
      assert.match(await p.locator('#meme-pager').textContent(), /第 1 \/ 2 頁/, '換頁後再篩選會回到第 1 頁');
      await p.locator('#meme-search').fill('m_03');
      await p.waitForFunction(() => document.querySelectorAll('#meme-rows tr').length === 1);
      assert.match(await p.locator('#meme-rows tr').textContent(), /梗圖03/, '可用梗圖 id 找到圖');
      assert.match(await p.locator('#meme-rows tr').textContent(), /伺服器 · #頻道/, '來源顯示伺服器名');

      await p.locator('#meme-rows button[data-meme-view]').first().click();
      assert.equal(await p.locator('#detail-modal').isVisible(), true);
      assert.equal(await p.locator('#detail-title').textContent(), '梗圖03');
      assert.match(await p.locator('#detail-meta').textContent(), /使用：0 次/);
      assert.match(await p.locator('#detail-meta').textContent(), /伺服器 · #頻道/, '放大彈窗顯示伺服器名');
      assert.match(await p.locator('#detail-body').textContent(), /沒有寫使用情境/);
      await p.waitForFunction(() => document.querySelector('#detail-image').naturalWidth > 0);
      assert.equal(await p.locator('#detail-image').isVisible(), true, '放大後看得到圖');
      // 彈窗開著時每 5 秒會自動刷新；內容不能被換掉，圖也不能被 revoke。
      const src = await p.locator('#detail-image').getAttribute('src');
      await p.waitForTimeout(5500);
      assert.equal(await p.locator('#detail-title').textContent(), '梗圖03');
      assert.equal(await p.locator('#detail-image').getAttribute('src'), src);
      await p.locator('#detail-close').click();
      assert.equal(await p.locator('#detail-modal').isVisible(), false);
      assert.equal(await p.locator('#detail-image').getAttribute('src'), null, '關閉後清掉圖片');

      // 手機寬度：表格自己橫向捲動，頁面不能溢出，兩顆按鈕要在同一列。
      await p.setViewportSize({ width: 375, height: 812 });
      await p.waitForTimeout(150);
      const layout = await p.evaluate(() => {
        // 第一個 data-meme-view 是縮圖（高 54），要找文字「放大」那顆。
        const view = [...document.querySelectorAll('#meme-rows button[data-meme-view]')]
          .find((button) => button.textContent.includes('放大'));
        const del = document.querySelector('#meme-rows button[data-meme-id]');
        if (!view || !del) return null;
        const a = view.getBoundingClientRect();
        const b = del.getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          sameRow: Math.abs(a.top - b.top) < 2,
          height: a.height,
        };
      });
      assert.ok(layout);
      assert.equal(layout.overflow, false, '手機沒有頁面級橫向溢出');
      assert.equal(layout.sameRow, true, '放大與刪除在同一列');
      assert(layout.height >= 24 && layout.height <= 36, '按鈕沒有被壓成多行');
      assert.deepEqual(pageErrors, [], '頁面沒有 JS 錯誤');
    } finally {
      await dcContext.close();
      await dc.close();
    }
  });

  await test('Discord 控制台：梗圖載入失敗會提示', async () => {
    const dc = await startConsole({
      port: 0, token: 't', htmlPath: join(here, '..', 'public', 'discord-console.html'),
      handlers: {
        status: () => ({ bot: null, dsh: {}, sessions: 0, pending: 0, allow: { guilds: 0, channels: 0, users: 0 }, ownerIds: [], media: {}, console: { host: '127.0.0.1', port: 0 } }),
        invite: () => ({}),
        usage: ({ range }) => ({ range, totals: {}, conversations: [], series: { buckets: [] } }),
        quota: async () => ({ skipped: true }),
        memory: () => ({ enabled: true, users: [] }),
        followups: () => ({ enabled: true, items: [] }),
        notes: () => ({ notes: [] }),
        memes: () => ({
          enabled: true,
          memes: [{
            id: 'm_bad', name: '壞圖', when: '', tags: [], guildName: '伺服器',
            createdBy: 'user', channelName: '頻道', uses: 0, width: 100, height: 100, bytes: 100,
          }],
        }),
        memeImage: () => null,
        devFeedback: () => ({ items: [] }),
        sessions: () => [],
        config: () => ({ allow: {}, deny: {}, ownerIds: [], media: {} }),
        slang: () => ({ entries: [], learning: { enabled: true } }),
        knowledge: () => ({ enabled: true, stats: { total: 0, candidate: 0, approved: 0, rejected: 0 }, entries: [] }),
        logs: () => [],
        trade: async () => ({ enabled: false, reason: '未開啟' }),
      },
    });
    const dcBase = `http://127.0.0.1:${dc.server.address().port}`;
    const dcContext = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    try {
      const p = await dcContext.newPage();
      p.setDefaultTimeout(8000);
      await p.goto(`${dcBase}/?token=t#memory`);
      await p.waitForSelector('#meme-rows button[data-meme-view]');
      await p.locator('#meme-rows button[data-meme-view]').first().click();
      await p.waitForFunction(() => document.querySelector('#detail-meta').textContent.includes('圖片載入失敗'));
      assert.equal(await p.locator('#detail-image').isVisible(), false, '載入失敗不顯示空圖');
    } finally {
      await dcContext.close();
      await dc.close();
    }
  });

  await test('Discord 控制台：訂單與日誌可放大看完整內容', async () => {
    const order = {
      id: 1,
      account_id: 'user:637590163068813363',
      accountName: '阿華',
      symbol: '2330 台積電',
      side: 'buy',
      qty: 100,
      status: 'filled',
      fill_price_cents: 223818,
      fee_cents: 20,
      tax_cents: 0,
      reject_reason: '',
      reason: '測試備註',
      created_at: '2026-11-10T03:51:00.000Z',
    };
    const order2 = {
      id: 2,
      account_id: 'bot:bot',
      symbol: '2454 聯發科',
      side: 'sell',
      qty: 10,
      status: 'pending',
      fill_price_cents: null,
      fee_cents: null,
      tax_cents: null,
      reject_reason: '',
      reason: '',
      created_at: '2026-11-09T01:02:00.000Z',
    };
    let overviewOrders = [order];
    const dc = await startConsole({
      port: 0, token: 't', htmlPath: join(here, '..', 'public', 'discord-console.html'),
      handlers: {
        status: () => ({ bot: null, dsh: {}, sessions: 0, pending: 0, allow: { guilds: 0, channels: 0, users: 0 }, ownerIds: [], media: {}, console: { host: '127.0.0.1', port: 0 } }),
        invite: () => ({}),
        usage: ({ range }) => ({ range, totals: {}, conversations: [], series: { buckets: [] } }),
        quota: async () => ({ skipped: true }),
        memory: () => ({ enabled: true, users: [] }),
        followups: () => ({ enabled: true, items: [] }),
        notes: () => ({ notes: [] }),
        memes: () => ({ memes: [] }),
        devFeedback: () => ({ items: [] }),
        sessions: () => [],
        config: () => ({ allow: {}, deny: {}, ownerIds: [], media: {} }),
        slang: () => ({ entries: [], learning: { enabled: true } }),
        knowledge: () => ({ enabled: true, stats: { total: 0, candidate: 0, approved: 0, rejected: 0 }, entries: [] }),
        trade: async () => ({
          enabled: true,
          market: { label: '已收盤' },
          accounts: [{
            accountId: 'user:637590163068813363',
            accountName: '阿華',
            kind: 'user',
            cashCents: 95083003,
            reservedCents: 0,
            navCents: 0,
            returnPct: 0,
            positions: [{
              symbol: '2330 台積電', name: '台積電', qty: 100, avgCostCents: 223818,
              priceCents: null, marketValueCents: 0, unrealizedCents: 0,
            }],
          }],
          orders: overviewOrders,
          quotes: [],
          botRuns: [],
        }),
        logs: () => [{ text: '2026-11-10 23:00:00 [discord] 測試日誌' }],
      },
    });
    const dcBase = `http://127.0.0.1:${dc.server.address().port}`;
    const dcContext = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    try {
      const p = await dcContext.newPage();
      p.setDefaultTimeout(8000);
      const pageErrors = [];
      p.on('pageerror', (error) => pageErrors.push(error.message));
      await p.goto(`${dcBase}/?token=t#trade`);
      await p.waitForSelector('#trade-orders tr[data-order]');
      assert.match(await p.locator('#trade-accounts').textContent(), /阿華/, '帳戶表用顯示名稱');
      assert.match(await p.locator('#trade-positions').textContent(), /阿華/, '持股表也用顯示名稱');
      await p.locator('#trade-orders tr[data-order]').first().click();
      assert.equal(await p.locator('#detail-title').textContent(), '訂單 2330 台積電 買 100 股');
      const meta = await p.locator('#detail-meta').textContent();
      assert.match(meta, /阿華/);
      assert.match(meta, /637590163068813363/);
      assert.match(await p.locator('#detail-body').textContent(), /測試備註/);
      await p.locator('#detail-close').click();

      // 換一批訂單後，列的 index 要對到新的資料，不能開到舊的那一筆。
      overviewOrders = [order2, order];
      await Promise.all([
        p.waitForResponse((response) => new URL(response.url()).pathname === '/api/trade/overview'),
        p.locator('#refresh').click(),
      ]);
      await p.waitForSelector('#trade-orders tr[data-order]');
      assert.equal(await p.locator('#trade-orders tr[data-order]').count(), 2);
      await p.locator('#trade-orders tr[data-order]').nth(0).click();
      assert.equal(await p.locator('#detail-title').textContent(), '訂單 2454 聯發科 賣 10 股');
      await p.locator('#detail-close').click();
      await p.locator('#trade-orders tr[data-order]').nth(1).click();
      assert.equal(await p.locator('#detail-title').textContent(), '訂單 2330 台積電 買 100 股');
      await p.locator('#detail-close').click();

      await p.locator('#tabbtn-logs').click();
      await p.waitForFunction(() => document.querySelector('#logs').textContent.includes('測試日誌'));
      await p.locator('#logs-expand').click();
      assert.equal(await p.locator('#detail-title').textContent(), '日誌');
      assert.match(await p.locator('#detail-body').textContent(), /測試日誌/);
      assert.match(await p.locator('#detail-card').getAttribute('class'), /wide/);
      assert.match(await p.locator('#detail-body').getAttribute('class'), /mono/);
      assert.deepEqual(pageErrors, [], '頁面沒有 JS 錯誤');
    } finally {
      await dcContext.close();
      await dc.close();
    }
  });

  await test('Discord 控制台：單頻道 requireMentionInChannel 讀寫，沒開意圖時鎖住且不送', async () => {
    const posts = [];
    let current = {
      allow: {}, deny: {}, ownerIds: [], media: {},
      requireMentionInGuild: true, messageContentIntent: true,
      requireMentionInChannel: { '111111111111111111': false },
      slang: { jev: { mode: 'auto' } },
    };
    const dc = await startConsole({
      port: 0, token: 't', htmlPath: join(here, '..', 'public', 'discord-console.html'),
      handlers: {
        status: () => ({ bot: null, dsh: {}, sessions: 0, pending: 0, allow: { guilds: 0, channels: 0, users: 0 }, ownerIds: [], media: {}, requireMention: true, mentionOverrides: 1, console: { host: '127.0.0.1', port: 0 } }),
        invite: () => ({}),
        usage: ({ range }) => ({ range, totals: {}, conversations: [], series: { buckets: [] } }),
        quota: async () => ({ skipped: true }),
        memory: () => ({ enabled: true, users: [] }),
        followups: () => ({ enabled: true, items: [] }),
        sessions: () => [],
        config: () => current,
        updateConfig: async (body) => { posts.push(body); return current; },
        slang: () => ({ entries: [], learning: { enabled: true } }),
        knowledge: () => ({ enabled: true, stats: { total: 0, candidate: 0, approved: 0, rejected: 0 }, entries: [] }),
        logs: () => [],
      },
    });
    const dcContext = await browser.newContext({ viewport: { width: 1204, height: 1000 } });
    try {
      const p = await dcContext.newPage();
      p.setDefaultTimeout(8000);
      const base = `http://127.0.0.1:${dc.server.address().port}/?token=t`;
      await p.goto(`${base}#settings`);
      const box = p.locator('#require-mention-channels');
      await p.waitForFunction(() => document.querySelector('#require-mention-channels').value === '111111111111111111=false');
      // 每個區都要有中文區名；忘了把新前綴加進 FEATURE_SECTIONS 時，這裡會抓到英文 key。
      const unnamed = await p.locator('#feature-fields .fsec h3').evaluateAll((heads) => heads
        .filter((h) => {
          const key = h.querySelector('small')?.textContent?.replace(/\.\*$/, '');
          return key && h.firstChild.textContent === key;
        })
        .map((h) => h.firstChild.textContent));
      assert.deepEqual(unnamed, [], '每個功能區都有中文區名');
      assert.equal(await p.locator('#feature-fields input, #feature-fields textarea').count(), 52, '52 個功能欄位都還在');
      assert.equal(await p.locator('#cf-slang-jev-mode').inputValue(), 'auto', 'Jev 模式要從設定帶入');
      assert.equal(await p.locator('#fsec-tts #cf-tts-channels').count(), 1, 'TTS 欄位歸在語音區');
      assert.equal(await p.locator('#fsec-videoLinks #cf-videoLinks-enabled').count(), 1, '影片連結自己一區');
      await p.locator('#tabbtn-overview').click();
      await p.waitForFunction(() => document.body.textContent.includes('1 個頻道覆寫'));
      await p.locator('#tabbtn-settings').click();
      const submit = () => p.locator('#config-form button[type="submit"]').click();

      await box.fill('111111111111111111 = TRUE\n\n222222222222222222=false');
      await submit();
      await p.waitForFunction(() => document.querySelector('#config-msg').textContent.includes('已儲存'));
      assert.deepEqual(posts.at(-1).requireMentionInChannel, { '111111111111111111': true, '222222222222222222': false });
      assert.equal(posts.at(-1).requireMentionInGuild, true);

      await box.fill('abc=true');
      await submit();
      await p.waitForFunction(() => document.querySelector('#config-msg').textContent.includes('看不懂'));
      assert.equal(posts.length, 1, '格式錯就不送出');

      current = { ...current, messageContentIntent: false };
      await p.goto(`${base}#settings`);
      await p.waitForFunction(() => document.querySelector('#require-mention-channels').disabled);
      await submit();
      await p.waitForFunction(() => document.querySelector('#config-msg').textContent.includes('已儲存'));
      assert.equal(posts.length, 2);
      assert(!('requireMentionInChannel' in posts[1]) && !('requireMentionInGuild' in posts[1]), '鎖住時兩個 mention 欄位都不送');
    } finally {
      await dcContext.close();
      await dc.close();
    }
  });

  if (!original) await test('Discord 控制台：存功能設定不會把 Jev 設定改掉', async () => {
    const posts = [];
    const current = {
      allow: {}, deny: {}, ownerIds: [], media: {},
      slang: { jev: { mode: 'auto', confirmAt: 0.8, rejectBelow: 0.1 } },
    };
    const dc = await startConsole({
      port: 0, token: 't', htmlPath: join(here, '..', 'public', 'discord-console.html'),
      handlers: {
        status: () => ({ bot: null, dsh: {}, sessions: 0, pending: 0, allow: { guilds: 0, channels: 0, users: 0 }, ownerIds: [], media: {}, console: { host: '127.0.0.1', port: 0 } }),
        invite: () => ({}),
        usage: ({ range }) => ({ range, totals: {}, conversations: [], series: { buckets: [] } }),
        quota: async () => ({ skipped: true }),
        memory: () => ({ enabled: true, users: [] }),
        followups: () => ({ enabled: true, items: [] }),
        sessions: () => [],
        config: () => current,
        updateConfig: async (body) => { posts.push(body); return current; },
        slang: () => ({ entries: [], learning: { enabled: true } }),
        knowledge: () => ({ enabled: true, stats: { total: 0, candidate: 0, approved: 0, rejected: 0 }, entries: [] }),
        logs: () => [],
      },
    });
    const dcContext = await browser.newContext({ viewport: { width: 1204, height: 1000 } });
    try {
      const p = await dcContext.newPage();
      p.setDefaultTimeout(8000);
      await p.goto(`http://127.0.0.1:${dc.server.address().port}/?token=t#settings`);
      await p.waitForFunction(() => document.querySelector('#cf-slang-jev-mode')?.value === 'auto');
      assert.equal(await p.locator('#cf-slang-jev-confirmAt').inputValue(), '0.8', '確認門檻要從設定帶入');
      assert.equal(await p.locator('#cf-slang-jev-rejectBelow').inputValue(), '0.1', '拒絕門檻要從設定帶入');
      const response = p.waitForResponse(r => new URL(r.url()).pathname === '/api/config' && r.request().method() === 'POST');
      await p.locator('#feature-form button[type="submit"]').click();
      await response;
      assert.equal(posts.at(-1).slang.jev.mode, 'auto', '沒改的 Jev 模式要原樣送回');
      assert.equal(posts.at(-1).slang.jev.confirmAt, 0.8, '沒改的確認門檻要原樣送回');
      assert.equal(posts.at(-1).slang.jev.rejectBelow, 0.1, '沒改的拒絕門檻要原樣送回');
    } finally {
      await dcContext.close();
      await dc.close();
    }
  });

  if (!original) await test('Discord 控制台：回饋分頁列出意見、可跳到觸發訊息、不執行模型寫的 HTML', async () => {
    let items = [{
      id: 'df1',
      at: '2026-11-01T04:05:06.000Z',
      updatedAt: '2026-11-01T05:06:07.000Z',
      updatedBy: 'ch:9',
      updatedByLabel: '#別的頻道',
      key: 'ch:3',
      label: '#閒聊 · 伺服器',
      sessionId: 'ses_0123456789abcdefghijklmn',
      guildId: '2',
      channelId: '3',
      messageIds: ['4', '5'],
      users: [{ userId: '6', name: '小明' }],
      reason: '<img src=x onerror="window.__pwned=1">',
      need: '第一行\n第二行',
      expected: '能排版',
    }];
    let deleted = '';
    const dc = await startConsole({
      port: 0, token: 't', htmlPath: join(here, '..', 'public', 'discord-console.html'),
      handlers: {
        status: () => ({ bot: null, dsh: {}, sessions: 0, pending: 0, allow: { guilds: 0, channels: 0, users: 0 }, ownerIds: [], media: {}, console: { host: '127.0.0.1', port: 0 } }),
        invite: () => ({}),
        usage: ({ range }) => ({ range, totals: {}, conversations: [], series: { buckets: [] } }),
        quota: async () => ({ skipped: true }),
        memory: () => ({ enabled: true, users: [] }),
        followups: () => ({ enabled: true, items: [] }),
        notes: () => ({ enabled: true, notes: [] }),
        sessions: () => [],
        config: () => ({ allow: {}, deny: {}, ownerIds: [], media: {} }),
        slang: () => ({ entries: [], learning: { enabled: true } }),
        knowledge: () => ({ enabled: true, stats: { total: 0, candidate: 0, approved: 0, rejected: 0 }, entries: [] }),
        logs: () => [],
        devFeedback: () => ({ items }),
        deleteDevFeedback: (id) => {
          if (id !== 'df1') return false;
          items = items.filter((item) => item.id !== id);
          deleted = id;
          return true;
        },
      },
    });
    const dcContext = await browser.newContext({ viewport: { width: 1204, height: 1000 } });
    try {
      const p = await dcContext.newPage();
      p.setDefaultTimeout(8000);
      p.on('dialog', (dialog) => dialog.accept());
      await p.goto(`http://127.0.0.1:${dc.server.address().port}/?token=t#dev-feedback`);
      await p.waitForFunction(() => document.querySelectorAll('#dev-feedback-rows tr').length === 1);
      assert.equal(await p.locator('#dev-feedback-rows img').count(), 0, '模型寫的 HTML 不會變成節點');
      assert.equal(await p.evaluate(() => window.__pwned ?? 0), 0, 'onerror 不會執行');
      assert.match(await p.locator('#dev-feedback-rows td').nth(2).textContent(), /<img src=x/);
      assert.match(await p.locator('#dev-feedback-count').textContent(), /1 筆/);
      assert.match(await p.locator('#dev-feedback-rows td').nth(1).textContent(), /#閒聊 · 伺服器/);
      assert.match(await p.locator('#dev-feedback-rows td').nth(1).textContent(), /觸發：小明/);
      assert.match(await p.locator('#dev-feedback-rows td').nth(0).textContent(), /已編輯/);
      assert.match(await p.locator('#dev-feedback-rows td').nth(0).textContent(), /由 #別的頻道/);
      assert.equal(await p.locator('#dev-feedback-rows a').first().getAttribute('href'),
        'https://discord.com/channels/2/3/4', '第一則觸發訊息有 Discord 跳轉連結');

      const deletedResponse = p.waitForResponse((r) => new URL(r.url()).pathname === '/api/dev-feedback/delete');
      await p.locator('#dev-feedback-rows button[data-dev-feedback-id]').click();
      await deletedResponse;
      await p.waitForFunction(() => document.querySelector('#dev-feedback-rows td').textContent.includes('還沒有人'));
      assert.equal(deleted, 'df1', '刪除會呼叫 handler');
    } finally {
      await dcContext.close();
      await dc.close();
    }
  });
} finally {
  if (browser) await browser.close();
}
const failed = results.filter(x => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
