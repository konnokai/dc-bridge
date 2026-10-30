#!/usr/bin/env node
/** Real-browser tests against an isolated fixture. Never starts qq-bridge or sends real messages. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startConsoleFixture } from './console-ui-fixture.mjs';
import { startConsole } from '../src/core/discord-console.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const original = args.includes('--original');
const record = args.includes('--record-baseline');
const artifacts = args.find(x => x.startsWith('--artifacts='))?.slice('--artifacts='.length);
const views = ['overview', 'sessions', 'persona', 'social-v2', 'social-v1', 'slang', 'usage', 'access', 'operations', 'reference'];
const legacyIds = JSON.parse((await readFile(join(here, 'console-ui-legacy-ids.json'), 'utf8')).replace(/^\uFEFF/, ''));
const baselinePath = join(here, 'console-ui-contracts.json');
if (record && !original) throw new Error('--record-baseline requires --original; only the pre-redesign console can define the baseline.');

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
const fixture = await startConsoleFixture({ original });
let browser;
const results = [];
const errors = [];
const blockedRequests = [];
async function test(name, fn) {
  const start = Date.now();
  try { await fn(); results.push({ name, ok: true, durationMs: Date.now() - start }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.message, durationMs: Date.now() - start }); console.error(`FAIL ${name}: ${error.message}`); }
}

try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  // Even if a future console accidentally references an external endpoint, tests cannot reach it.
  await context.route('**/*', async route => {
    const requested = new URL(route.request().url());
    if (requested.origin === fixture.url) return route.continue();
    blockedRequests.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('dialog', dialog => dialog.accept());
  await page.goto(fixture.url);
  await page.waitForFunction(() => document.getElementById('v2AgentPreset')?.value === 'qq-chat-v2' && document.getElementById('wlGroups')?.value.includes('123456789'));

  async function navigate(view) {
    if (original) return;
    if (await page.locator(`[data-page="${view}"]:visible`).count()) return;
    const nav = page.locator(`[data-view="${view}"]`).first();
    if (!await nav.isVisible()) {
      const toggle = page.locator('#navToggle, [data-nav-toggle], [aria-controls="sidebar"], button[aria-label*="导航"]').first();
      if (await toggle.count()) await toggle.click();
    }
    await nav.click();
  }
  async function reveal(selector) {
    const target = page.locator(selector).first();
    const view = await target.evaluate(el => el.closest('[data-page]')?.dataset.page);
    if (view) await navigate(view);
    for (const details of await target.locator('xpath=ancestor::details').all()) {
      if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
    }
    return target;
  }
  async function fill(id, value) { await (await reveal(`#${id}`)).fill(String(value)); }
  async function check(id, checked) { await (await reveal(`#${id}`)).setChecked(checked); }
  async function clickWrite(selector, path, method = 'POST') {
    const target = await reveal(selector);
    const [response] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === method),
      target.click(),
    ]);
    assert.equal(response.status(), 200, `${method} ${path} should succeed`);
    assert.equal((await response.json()).ok, true);
    return fixture.requests.at(-1)?.body;
  }

  await test('All 225 legacy IDs remain present and every DOM ID is unique', async () => {
    const ids = await page.locator('[id]').evaluateAll(nodes => nodes.map(x => x.id));
    assert.equal(legacyIds.length, 225);
    assert.deepEqual(legacyIds.filter(x => !ids.includes(x)), []);
    assert.equal(new Set(ids).size, ids.length, 'Duplicate DOM IDs detected');
  });

  if (!original) await test('All ten navigation destinations work and preserve unsaved form values across polling', async () => {
    for (const view of views) {
      await navigate(view);
      const visiblePages = await page.locator('[data-page]').evaluateAll(nodes => nodes.filter(x => x.getClientRects().length && getComputedStyle(x).visibility !== 'hidden').map(x => x.dataset.page));
      assert(visiblePages.length > 0, `${view} has no visible content`);
      assert(visiblePages.every(x => x === view), `${view} exposes another page: ${visiblePages.join(', ')}`);
    }
    const drafts = { wlGroups: '100001, 100002', roleInput: '未保存的角色', v2AgentPreset: 'draft-preset', sKeywords: '未保存关键词', slangMeaning: '未保存的含义', tsMsg: '未发送的测试消息' };
    for (const [id, value] of Object.entries(drafts)) await fill(id, value);
    await navigate('overview');
    await page.waitForTimeout(3300); // Exercise the real 3-second status polling interval.
    for (const [id, value] of Object.entries(drafts)) assert.equal(await (await reveal(`#${id}`)).inputValue(), value, `${id} lost its draft`);
    // Restore fixture defaults so the independent payload baseline remains deterministic.
    await page.reload();
    await page.waitForFunction(() => document.getElementById('v2AgentPreset')?.value === 'qq-chat-v2');
  });

  await test('Mode and preset contracts', async () => {
    for (const mode of ['chat', 'reserved', 'reserved2', 'closed-agent']) {
      assert.deepEqual(await clickWrite(`#modeRow [data-mode="${mode}"]`, '/api/mode'), { mode, closedAgentPreset: '' });
    }
    const select = await reveal('#closedPreset');
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/mode') && r.request().method() === 'POST'), select.selectOption('qq-chat-v2')]);
    assert.deepEqual(fixture.requests.at(-1).body, { mode: 'closed-agent', closedAgentPreset: 'qq-chat-v2' });
  });

  await test('Role creation, selection, clearing and silent-mode contracts', async () => {
    await fill('newRoleName', '契约测试角色');
    await fill('newRoleContent', '温柔、有耐心，回答简洁。');
    assert.deepEqual(await clickWrite('#roleCreate', '/api/roles/create'), { name: '契约测试角色', content: '温柔、有耐心，回答简洁。' });
    await fill('roleInput', '契约测试角色');
    assert.deepEqual(await clickWrite('#roleSet', '/api/role'), { role: '契约测试角色' });
    assert.deepEqual(await clickWrite('#roleClear', '/api/role'), { role: null });
    assert.deepEqual(await clickWrite('#silentOn', '/api/role-mode'), { mode: 'silent' });
    assert.deepEqual(await clickWrite('#silentOff', '/api/role-mode'), { mode: 'active' });
  });

  await test('Whitelist numeric parsing and security contracts', async () => {
    for (const [id, value] of Object.entries({ wlGroups: '123456789，100003', wlPrivate: '100001 100002', dnGroups: '800001,800002', dnPrivate: '900001', ownerQQ: '100001' })) await fill(id, value);
    assert.deepEqual(await clickWrite('#wlSave', '/api/whitelist'), { allow: { private: [100001, 100002], groups: [123456789, 100003] }, deny: { private: [900001], groups: [800001, 800002] }, ownerQQ: '100001' });
    await check('secInterceptNotify', false);
    assert.deepEqual(await clickWrite('#secSave', '/api/security'), { interceptNotify: false });
  });

  // state/ 的 ACL 收紧需要管理员权限，未提权时桥接会明确报告 hardened:false。
  // 控制台必须把这件事**显式**呈现（含可复制的提权命令），而不是让用户以为已经安全；
  // 用户按提示处理后点「重新检测」应当转为成功态。
  await test('Unhardened state directory surfaces a warning with the exact command', async () => {
    await navigate('access');
    await page.waitForFunction(() => document.getElementById('stateDirWarn')?.style.display !== 'none');
    const shown = await page.evaluate(() => ({
      path: document.getElementById('stateDirPath').textContent,
      cmd: document.getElementById('stateDirCmd').textContent,
    }));
    assert.match(shown.path, /state/, '应当显示 state 目录路径');
    assert.match(shown.cmd, /icacls/, '应当给出可复制的提权命令');
    // 只验证按钮确实发起「重新检测」请求，**不**写进/触发 baseline 的写载荷契约
    // （baseline 记录的是改版前控制台的表单写载荷，这条不算表单写）。
    await page.waitForFunction(() => document.getElementById('stateDirReharden') !== null);
    const [request] = await Promise.all([
      page.waitForRequest(r => new URL(r.url()).pathname === '/api/security' && r.method() === 'POST'),
      page.click('#stateDirReharden'),
    ]);
    assert.deepEqual(JSON.parse(request.postData() || '{}'), { rehardenStateDir: true });
    await page.waitForFunction(() => document.getElementById('stateDirWarn')?.style.display === 'none');
  });

  await test('Second-generation complete save payload, units, zero values and tool switches', async () => {
    await fill('v2AgentPreset', 'contract-v2');
    await fill('v2RecSleepMin', 7);
    await fill('v2SleepMinMs', 42);
    await fill('v2PreSleepWaitMin', 0);
    await fill('v2RecProb', 0);
    await fill('v2RecKeywords', '鲸鱼，DeepSeek, 测试');
    await fill('v2AutoReplyCheckSec', 17);
    await fill('v2WaitDefaultQuietMs', 0);
    await fill('v2MaxSendMin', 0);
    await check('v2ProvideRecommendations', false);
    const firstTool = page.locator('[data-v2-tool]').first();
    await reveal('[data-v2-tool]');
    await firstTool.setChecked(false);
    const body = await clickWrite('#v2ConfigSaveTop', '/api/socialV2/config');
    assert.equal(body.wake.recommendedSleepMinMs, 420000);
    assert.equal(body.wake.sleepMinMs, 42000);
    assert.equal(body.wake.preSleepWaitMs, 0);
    assert.equal(body.wake.recommendedProbability, 0);
    assert.deepEqual(body.wake.recommendedKeywords, ['鲸鱼', 'DeepSeek', '测试']);
    assert.equal(body.autoReplyCheckMs, 17000);
    assert.equal(body.wait.defaultQuietMs, 0);
    assert.equal(body.send.maxSendPerMinute, 0);
    assert.equal(body.provideRecommendations, false);
    assert.equal(body.tools[await firstTool.getAttribute('data-v2-tool')], false);
    // The lower save button must submit the same complete configuration.
    await page.waitForFunction(() => document.getElementById('v2AgentPreset').value === 'contract-v2');
    assert.deepEqual(await clickWrite('#v2ConfigSave', '/api/socialV2/config'), body);
    assert.deepEqual(await clickWrite('#v2PauseBtn', '/api/socialV2/activity'), { paused: true });
    assert.deepEqual(await clickWrite('#v2ResumeBtn', '/api/socialV2/activity'), { paused: false });
  });

  await test('First-generation social parameter and phase contracts', async () => {
    await fill('sTrigger', 0.35);
    await fill('sCheckMin', 12);
    await fill('sKeywords', '鲸鱼，测试');
    const body = await clickWrite('#socialSave', '/api/social');
    assert.equal(body.triggerProbability, 0.35);
    assert.equal(body.activeCheckMinMs, 12000);
    assert.deepEqual(body.mustReplyKeywords, ['鲸鱼', '测试']);
    await (await reveal('#sStateKey')).selectOption('group:123456789');
    assert.deepEqual(await clickWrite('#sStateIdle', '/api/social/state'), { key: 'group:123456789', phase: 'idle' });
    assert.deepEqual(await clickWrite('#socialFlush', '/api/social/flush'), {});
  });

  await test('Slang add, search, confirm modal, tab switching and parameter contracts', async () => {
    for (const [id, value] of Object.entries({ slangContent: '测试词条', slangMeaning: '很棒', slangUsage: '赞美', slangExample: '这个效果很棒。' })) await fill(id, value);
    assert.deepEqual(await clickWrite('#slangAdd', '/api/slang'), { content: '测试词条', meaning: '很棒', usage: '赞美', example: '这个效果很棒。' });
    await (await reveal('.slang-tab[data-slang-tab="confirmed"]')).click();
    await fill('slangSearchConfirmed', '测试词条');
    assert.equal(await page.locator('#slangConfirmedList tbody tr').count(), 2, 'Filtered table should contain header and one entry');
    await (await reveal('.slang-tab[data-slang-tab="candidate"]')).click();
    await page.locator('[data-slang-confirm="demo-candidate"]').click();
    await fill('slangModalMeaning', '感到安慰');
    await fill('slangModalUsage', '轻松聊天');
    await fill('slangModalExample', '有被治愈到。');
    await fill('slangModalRisk', '无');
    await fill('slangModalSources', 'https://example.invalid/offline-source');
    assert.deepEqual(await clickWrite('#slangModalDirectConfirm', '/api/slang/demo-candidate/confirm'), { meaning: '感到安慰', usage: '轻松聊天', example: '有被治愈到。', risk: '无', sources: ['https://example.invalid/offline-source'] });
    await fill('slangExtractMin', 14);
    await fill('slangThresholds', '3，6 12');
    const config = await clickWrite('#slangConfigSave', '/api/slang/config');
    assert.equal(config.extractMinMessages, 14);
    assert.deepEqual(config.inferenceThresholds, [3, 6, 12]);
  });

  await test('Test message and AI notification reach only the mock endpoints', async () => {
    await (await reveal('#tsKind')).selectOption('group');
    await fill('tsId', '123456789');
    await fill('tsMsg', '离线测试，不会发往 QQ。');
    assert.deepEqual(await clickWrite('#tsSend', '/api/test-send'), { kind: 'group', id: '123456789', message: '离线测试，不会发往 QQ。' });
    await (await reveal('#aiNotifyKind')).selectOption('private');
    await fill('aiNotifyId', '100001');
    await fill('aiNotifyMessage', '离线提醒，不会发往 DSH。');
    assert.deepEqual(await clickWrite('#aiNotifySend', '/api/console/notify-ai'), { key: 'private:100001', message: '离线提醒，不会发往 DSH。' });
  });

  if (record) {
    assert(results.every(x => x.ok), 'Cannot record a baseline from a failed suite');
    await writeFile(baselinePath, JSON.stringify(fixture.requests, null, 2) + '\n');
    console.log(`Recorded original API contracts: ${baselinePath}`);
  } else await test('All submitted payloads exactly match the pre-redesign console baseline', async () => {
    const expected = JSON.parse(await readFile(baselinePath, 'utf8'));
    assert.deepEqual(fixture.requests, expected);
  });

  if (!original) await test('Token usage panel renders totals, per-conversation and per-turn cost', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await navigate('usage');
    await page.waitForFunction(() => document.getElementById('metricUsageTokens')?.textContent !== '—');

    // 四个总览指标
    assert.match((await page.textContent('#metricUsageCost')).trim(), /^¥\d/, '总花费应渲染成货币金额');
    assert.match((await page.textContent('#metricUsageTokens')).trim(), /\d/, '累计 token 应有数值');
    assert.match((await page.textContent('#metricUsageHitRate')).trim(), /%$/, '缓存命中率应为百分比');
    assert.match((await page.textContent('#metricUsagePerTurn')).trim(), /^¥\d/, '平均每轮应为货币金额');

    // 按会话（群 / 私聊 / 内部）明细
    const conversations = await page.textContent('#usageConversations');
    assert.match(conversations, /group:123456789/, '按会话表应列出群会话');
    assert.match(conversations, /private:100001/, '按会话表应列出私聊会话');
    assert.match(conversations, /internal:黑话学习/, '按会话表应列出内部（黑话学习）用量');
    assert.match(conversations, /¥/, '按会话表应显示花费列');
    assert.match(conversations, /未命中输入/, '按会话表应拆分缓存命中 / 未命中');

    // 下钻逐轮：点会话行 → 加载该会话的逐轮花费
    await page.click('#usageConversations [data-usage-key="group:123456789"]');
    await page.waitForFunction(() => /#\d+/.test(document.getElementById('usageTurns')?.textContent || ''));
    const turns = await page.textContent('#usageTurns');
    assert.match(turns, /#42/, '逐轮明细应显示轮次编号');
    assert.match(turns, /步数/, '逐轮明细应显示步数');
    assert.match(turns, /空闲|高峰|跨时段/, '逐轮明细应标注峰谷时段');
    assert.match(turns, /¥/, '逐轮明细应显示每轮花费');

    // 会话下拉与逐轮表同步
    assert.equal(await page.inputValue('#usageKeySelect'), 'group:123456789', '下拉框应跟随选中的会话');

    // 实时流水与价目表
    assert.match(await page.textContent('#usageRecent'), /group:123456789|private:100001/, '最近流水应列出采样');
    assert.match(await page.textContent('#usagePrices'), /deepseek-flash/, '价目表应列出模型单价');
  });

  if (!original) await test('Token usage trend chart renders bars, tiers and range/metric switching', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await navigate('usage');
    await page.waitForFunction(() => document.querySelectorAll('#usageChart svg rect.usage-bar-off, #usageChart svg rect.usage-bar-peak').length > 0);

    // 柱：空闲与高峰两类都要画出来（fixture 按真实峰谷规则生成）
    const bars = await page.evaluate(() => ({
      off: document.querySelectorAll('#usageChart svg rect.usage-bar-off').length,
      peak: document.querySelectorAll('#usageChart svg rect.usage-bar-peak').length,
      mixed: document.querySelectorAll('#usageChart svg rect.usage-bar-mixed').length,
      grid: document.querySelectorAll('#usageChart svg line.usage-grid').length,
      axis: document.querySelectorAll('#usageChart svg text.usage-axis').length,
    }));
    assert(bars.off > 0 && bars.peak > 0, `走势图应画出空闲与高峰两类柱（${JSON.stringify(bars)}）`);
    assert.equal(bars.grid, 3, '应有 3 条横向网格线');
    assert(bars.axis >= 4, '应有纵轴刻度与横轴时间标签');

    // 悬停提示：每个柱都要带 <title>，能读出该格的花费与时段
    const titles = await page.$$eval('#usageChart svg title', (nodes) => nodes.map((n) => n.textContent));
    assert(titles.length > 0, '每个格子都应带悬停提示');
    assert(titles.some((t) => /花费：¥/.test(t)), '提示里应包含该格花费');
    assert(titles.some((t) => /时段：高峰/.test(t)), '提示里应标注高峰时段');

    // 汇总行与"图外还有多少"的说明
    assert.match(await page.textContent('#usageChartTotal'), /^¥\d/, '应显示窗口内合计花费');
    assert.match(await page.textContent('#usageChartHint'), /每格 \d+ 分钟/, '应说明每格代表多长时间');
    assert.match(await page.textContent('#usageChartNote'), /不在上图里/, '应说明时间轴之外还有多少花费（避免图合计 ≠ 总花费引起误解）');

    // 切范围：重新请求并按生产同一套桶宽阶梯换粒度
    // （24h→30min / 3d→2h / 7d→6h / 30d→24h，桶数始终 ≤ 48）
    await page.click('#usageChartControls [data-usage-hours="168"]');
    await page.waitForFunction(() => /每格 \d+ 分钟/.test(document.getElementById('usageChartHint')?.textContent || '')
      && document.querySelector('#usageChartControls [data-usage-hours="168"]')?.classList.contains('active'));
    assert.match(await page.textContent('#usageChartHint'), /每格 360 分钟/, '切到 7 天后桶宽变成 6 小时');

    // 粗桶会把高峰窗口整个包在中间 → 必须标『跨时段』（细桶边界对齐则不会，这也是真账本的行为）
    await page.click('#usageChartControls [data-usage-hours="720"]');
    await page.waitForFunction(() => /每格 \d+ 分钟/.test(document.getElementById('usageChartHint')?.textContent || '')
      && document.querySelector('#usageChartControls [data-usage-hours="720"]')?.classList.contains('active'));
    assert.match(await page.textContent('#usageChartHint'), /每格 1440 分钟/, '切到 30 天后桶宽变成 24 小时');
    const coarse = await page.evaluate(() => ({
      mixed: document.querySelectorAll('#usageChart svg rect.usage-bar-mixed').length,
      buckets: document.querySelectorAll('#usageChart svg rect.usage-hit').length,
    }));
    assert(coarse.mixed > 0, `跨时段的粗桶应标为「跨时段」（${JSON.stringify(coarse)}）`);
    assert(coarse.buckets <= 48, `30 天视图的桶数仍受上限约束（实得 ${coarse.buckets}）`);

    // 切纵轴：不重新请求，直接重画成 token
    await page.click('#usageChartControls [data-usage-metric="tokens"]');
    assert.match(await page.textContent('#usageChartTotal'), /token/, '切到 token 后合计显示 token 数');
    assert.equal(await page.getAttribute('#usageChartControls [data-usage-metric="tokens"]', 'class'), 'tag active', 'token 按钮应处于选中态');
    await page.click('#usageChartControls [data-usage-metric="cost"]');
    assert.match(await page.textContent('#usageChartTotal'), /^¥\d/, '切回花费');

    // 回到 24 小时，避免影响后续断言
    await page.click('#usageChartControls [data-usage-hours="24"]');
    await page.waitForFunction(() => document.querySelector('#usageChartControls [data-usage-hours="24"]')?.classList.contains('active'));
  });

  if (!original) await test('Mobile and tablet layouts have no document-level horizontal overflow', async () => {
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      for (const view of views) {
        await navigate(view);
        const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
        assert(dimensions.document <= dimensions.viewport + 1, `${width}px / ${view}: ${JSON.stringify(dimensions)}`);
        if (artifacts && width === 390 && ['overview', 'social-v2', 'slang'].includes(view)) {
          await mkdir(resolve(artifacts), { recursive: true });
          await page.screenshot({ path: resolve(artifacts, `mobile-${view}.png`), fullPage: true, animations: 'disabled' });
        }
      }
    }
  });

  if (!original) await test('Dark mode toggles, persists across reload and stays overflow-free', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const snapshot = () => page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      stored: localStorage.getItem('qq-console-theme'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      text: getComputedStyle(document.body).color,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      toggle: document.getElementById('themeToggle').getAttribute('aria-pressed'),
    }));
    const light = await snapshot();
    assert.equal(light.theme, 'light', '测试环境系统偏好为浅色，默认应为浅色');
    await page.locator('#themeToggle').click();
    const dark = await snapshot();
    assert.equal(dark.theme, 'dark');
    assert.equal(dark.stored, 'dark', '主题选择需要写入 localStorage');
    assert.equal(dark.toggle, 'true', 'aria-pressed 需要反映当前主题');
    assert.equal(dark.scheme, 'dark', 'color-scheme 需同步，滚动条与表单控件才会跟随');
    assert.notEqual(dark.bodyBg, light.bodyBg, 'body 背景色必须真的改变');
    assert.notEqual(dark.text, light.text, '正文颜色必须真的改变');
    const ratio = await page.evaluate(() => {
      const parse = value => value.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(Number);
      const luminance = rgb => { const [r, g, b] = rgb.map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const background = luminance(parse(getComputedStyle(document.body).backgroundColor));
      const heading = luminance(parse(getComputedStyle(document.querySelector('h1')).color));
      return (Math.max(background, heading) + 0.05) / (Math.min(background, heading) + 0.05);
    });
    assert(ratio >= 7, `深色下标题与背景对比度不足：${ratio.toFixed(2)}`);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('statusText')?.textContent !== '正在连接…');
    assert.equal((await snapshot()).theme, 'dark', '刷新后应保持深色');
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
      assert(dimensions.document <= dimensions.viewport + 1, `深色 ${width}px 出现横向溢出：${JSON.stringify(dimensions)}`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#themeToggle').click();
    assert.equal((await snapshot()).theme, 'light', '应能切回浅色');
  });

  if (!original) await test('Console follows the system preference when no theme was chosen', async () => {
    const systemDark = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark', serviceWorkers: 'block' });
    await systemDark.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort('blockedbyclient'));
    const systemPage = await systemDark.newPage();
    systemPage.on('pageerror', error => errors.push(error.message));
    await systemPage.goto(fixture.url);
    await systemPage.waitForFunction(() => document.getElementById('statusText')?.textContent !== '正在连接…');
    assert.equal(await systemPage.evaluate(() => document.documentElement.dataset.theme), 'dark', '系统偏好深色时应默认深色');
    await systemDark.close();
  });

  if (!original) await test('Reduced-motion preference disables decorative motion', async () => {
    const calm = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await calm.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort('blockedbyclient'));
    const calmPage = await calm.newPage();
    calmPage.on('pageerror', error => errors.push(error.message));
    await calmPage.goto(fixture.url);
    await calmPage.waitForFunction(() => document.getElementById('statusText')?.textContent !== '正在连接…');
    const motion = await calmPage.evaluate(() => ({
      decor: getComputedStyle(document.querySelector('.bg-decor'), '::before').animationName,
      page: getComputedStyle(document.querySelector('[data-page="overview"]')).animationName,
      transition: getComputedStyle(document.querySelector('button')).transitionDuration,
    }));
    assert.equal(motion.decor, 'none', '背景动效应在 reduced-motion 下关闭');
    assert.equal(motion.page, 'none', '页面切换动画应在 reduced-motion 下关闭');
    assert.equal(motion.transition, '0s', '过渡应在 reduced-motion 下关闭');
    await calm.close();
  });

  if (!original) await test('人格管理：新建 → 载入编辑 → 保存修改 → 重命名 → 删除', async () => {
    await navigate('persona');
    const created = '回归人格A';
    const renamed = '回归人格B';
    const namesInList = () => page.locator('#roleList .persona-item strong').allTextContents();
    await page.locator('#newRoleName').fill(created);
    await page.locator('#newRoleContent').fill('# 回归人格A\n\n- 性格：用于回归测试');
    const [createRes] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/roles/create' && r.request().method() === 'POST'),
      page.locator('#roleCreate').click(),
    ]);
    assert.equal(createRes.status(), 200);
    await page.waitForFunction((n) => [...document.querySelectorAll('#roleList .persona-item strong')].some((el) => el.textContent === n), created);
    // 点列表载入编辑：内容回填 + 按钮切到「保存修改」
    await page.locator('#roleList .persona-item').filter({ hasText: created }).first().click();
    await page.waitForFunction((n) => document.getElementById('newRoleName').value === n, created);
    assert.match(await page.locator('#newRoleContent').inputValue(), /用于回归测试/);
    assert.equal((await page.locator('#roleCreate').textContent()).trim(), '保存修改');
    // 保存修改
    await page.locator('#newRoleContent').fill('# 回归人格A\n\n- 性格：已修改');
    const [updateRes] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/roles/update' && r.request().method() === 'POST'),
      page.locator('#roleCreate').click(),
    ]);
    assert.equal(updateRes.status(), 200);
    // 重命名（编辑模式改名后再保存 = 先 rename 再 update），等列表真正刷新
    await page.locator('#newRoleName').fill(renamed);
    await page.locator('#roleCreate').click();
    await page.waitForFunction((n) => [...document.querySelectorAll('#roleList .persona-item strong')].some((el) => el.textContent === n), renamed);
    assert.match(await page.locator('#roleCreateMsg').textContent(), new RegExp(`已保存「${renamed}」`));
    assert.ok((await namesInList()).includes(renamed), '重命名后列表应出现新名字');
    assert.ok(!(await namesInList()).includes(created), '重命名后旧名字应消失');
    // 删除（会弹确认框，测试环境自动接受）
    const [deleteRes] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/roles/delete' && r.request().method() === 'POST'),
      page.locator('#roleDelete').click(),
    ]);
    assert.equal(deleteRes.status(), 200);
    await page.waitForFunction((n) => ![...document.querySelectorAll('#roleList .persona-item strong')].some((el) => el.textContent === n), renamed);
    assert.match(await page.locator('#roleCreateMsg').textContent(), /已删除/);
  });

  if (!original) await test('仿真提示词默认可查看、解锁后可编辑、保存后提示需重启 DSH', async () => {
    await navigate('persona');
    await page.waitForFunction(() => document.getElementById('simPromptText').value.length > 0);
    assert.equal(await page.locator('#simPromptText').getAttribute('readonly'), '', '默认应为只读');
    assert.equal(await page.locator('#simPromptSave').isDisabled(), true, '只读时不应能保存');
    assert.match(await page.locator('#layer-note, .layer-note').first().textContent(), /仿真提示词/, '页面应说明两层提示词的边界');
    await page.locator('#simPromptEdit').click();
    assert.equal(await page.locator('#simPromptText').getAttribute('readonly'), null, '解锁后应可编辑');
    assert.equal(await page.locator('#simPromptSave').isDisabled(), false);
    const edited = (await page.locator('#simPromptText').inputValue()) + '\n\n【回归追加】一句测试规则。';
    await page.locator('#simPromptText').fill(edited);
    const [saved] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/preset/sim-prompt' && r.request().method() === 'POST'),
      page.locator('#simPromptSave').click(),
    ]);
    assert.equal(saved.status(), 200);
    assert.equal((await saved.json()).ok, true);
    assert.match(await page.locator('#simPromptMsg').textContent(), /重启 DSH/, '保存后必须提示重启 DSH');
    assert.equal(await page.locator('#simPromptText').getAttribute('readonly'), '', '保存后应回到只读');
  });

  if (!original) await test('仿真提示词可切换到一代/二代，两代内容相互独立', async () => {
    await navigate('persona');
    await page.waitForFunction(() => document.getElementById('simPromptText').value.length > 0);
    const v2 = await page.locator('#simPromptText').inputValue();
    assert.match(await page.locator('#simPromptStatus').textContent(), /二代仿真|qq-chat-v2/);
    await page.locator('#simPromptPreset').selectOption('qq-chat');
    await page.waitForFunction((prev) => document.getElementById('simPromptText').value !== prev, v2);
    const v1 = await page.locator('#simPromptText').inputValue();
    assert.notEqual(v1, v2, '两代预设的提示词应各自独立');
    assert.match(await page.locator('#simPromptStatus').textContent(), /一代仿真|qq-chat/);
    // 切回二代，避免影响后续断言
    await page.locator('#simPromptPreset').selectOption('qq-chat-v2');
    await page.waitForFunction((prev) => document.getElementById('simPromptText').value === prev, v2);
  });

  if (!original) await test('人格注入上限可调，且随模式筛选后统计', async () => {
    await navigate('persona');
    await page.waitForFunction(() => document.querySelectorAll('#roleList .persona-item').length > 0);
    const before = await page.locator('#roleInjectMax').inputValue();
    assert.equal(Number(before), 8000, '默认上限应为 8000');
    await page.locator('#roleInjectMax').fill('8000');
    const [saved] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/roles/limit' && r.request().method() === 'POST'),
      page.locator('#roleInjectMaxSave').click(),
    ]);
    assert.equal(saved.status(), 200);
    assert.equal((await saved.json()).maxInjectChars, 8000);
    assert.match(await page.locator('#roleInjectMaxMsg').textContent(), /8000/);
    // 改回默认
    await page.locator('#roleInjectMax').fill('6000');
    await page.locator('#roleInjectMaxSave').click();
    await page.waitForFunction(() => document.getElementById('roleInjectMaxMsg').textContent.includes('6000'));
  });

  if (!original) await test('思考强度：档位来自 DSH、默认 max、可切换并明示全局副作用', async () => {
    await navigate('overview');
    await page.waitForFunction(() => document.getElementById('dshEffortSelect').options.length > 0);
    const options = await page.locator('#dshEffortSelect option').evaluateAll((nodes) => nodes.map((n) => n.value));
    assert.deepEqual(options, ['low', 'high', 'max'], `档位应来自 DSH 公布的能力，实际 ${options.join(',')}`);
    assert.equal(await page.locator('#dshEffortSelect').inputValue(), 'max', '默认应为 max');
    assert.match(await page.locator('#dshEffortSideEffect').textContent(), /全局默认/, '必须说明会连带改 DSH 全局默认');
    await page.locator('#dshEffortSelect').selectOption('high');
    const [saved] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/dsh/effort' && r.request().method() === 'POST'),
      page.locator('#dshEffortSave').click(),
    ]);
    assert.equal(saved.status(), 200);
    assert.equal((await saved.json()).reasoningEffort, 'high');
    assert.match(await page.locator('#dshEffortMsg').textContent(), /high/);
    // 改回默认，避免影响后续断言
    await page.locator('#dshEffortSelect').selectOption('max');
    await page.locator('#dshEffortSave').click();
    await page.waitForFunction(() => document.getElementById('dshEffortSelect').value === 'max');
  });

  if (artifacts) {
    await mkdir(resolve(artifacts), { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const view of original ? ['overview'] : ['overview', 'persona', 'social-v2', 'slang', 'access']) {
      await navigate(view);
      await page.screenshot({ path: resolve(artifacts, `${original ? 'original' : 'desktop'}-${view}.png`), fullPage: true, animations: 'disabled' });
    }
    if (!original) {
      await page.locator('#themeToggle').click();
      for (const view of ['overview', 'social-v2']) {
        await navigate(view);
        await page.screenshot({ path: resolve(artifacts, `dark-${view}.png`), fullPage: true, animations: 'disabled' });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await navigate('overview');
      await page.screenshot({ path: resolve(artifacts, 'dark-mobile-overview.png'), fullPage: true, animations: 'disabled' });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.locator('#themeToggle').click();
    }
  }
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
        sessions: () => [],
        config: () => ({ allow: {}, deny: {}, ownerIds: [], media: {} }),
        slang: () => ({ entries, learning: { enabled: true } }),
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
      const channelCells = () => p.locator('#style-rows tr td:first-child').allTextContents();
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
        sessions: () => [],
        config: () => ({ allow: {}, deny: {}, ownerIds: [], media: {} }),
        slang: () => ({ entries, learning: { enabled: true } }),
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
      await p.waitForFunction(() => document.querySelector('#slang-rows tr td:nth-child(2)').textContent.startsWith('很長'));
      const after = await metrics('slang-rows');
      assert.deepEqual(after, before, '內容變長後欄寬、列高與按鈕位置都不能變');
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
        sessions: () => [],
        config: () => ({ allow: {}, deny: {}, ownerIds: [], media: {} }),
        slang: () => ({ entries: [], learning: { enabled: true } }),
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
        notes: () => ({ enabled: true, notes: [{ id: 'n1', channelId: '123456789012345678', channelName: '很長的頻道名稱', text: '筆記', by: 'summary', at: new Date(old).toISOString(), expiresAt: old }] }),
        sessions: () => [{ key: 'discord:ch:123456789012345678', sessionId: 'ses_0123456789abcdefghijklmn', lastActive: old, quietUntil: old, pending: 'question' }],
        config: () => ({ allow: {}, deny: {}, ownerIds: [], media: {} }),
        slang: () => ({ entries: [], learning: { enabled: true } }),
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
    };
    const dc = await startConsole({
      port: 0, token: 't', htmlPath: join(here, '..', 'public', 'discord-console.html'),
      handlers: {
        status: () => ({ bot: null, dsh: {}, sessions: 0, pending: 0, allow: { guilds: 0, channels: 0, users: 0 }, ownerIds: [], media: {}, requireMention: true, mentionOverrides: 1, console: { host: '127.0.0.1', port: 0 } }),
        invite: () => ({}),
        usage: ({ range }) => ({ range, totals: {}, conversations: [], series: { buckets: [] } }),
        quota: async () => ({ skipped: true }),
        memory: () => ({ enabled: true, users: [] }),
        sessions: () => [],
        config: () => current,
        updateConfig: async (body) => { posts.push(body); return current; },
        slang: () => ({ entries: [], learning: { enabled: true } }),
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

  await test('No JavaScript errors, unknown API routes or external requests', async () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(fixture.unknownRequests, []);
    assert.deepEqual(blockedRequests, []);
  });
} finally {
  if (browser) await browser.close();
  await fixture.close();
  if (artifacts) {
    await mkdir(resolve(artifacts), { recursive: true });
    await writeFile(resolve(artifacts, 'test-results.json'), JSON.stringify({ original, results, requests: fixture.requests, errors, blockedRequests }, null, 2) + '\n');
  }
}
const failed = results.filter(x => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; ${fixture.requests.length} isolated mock writes.`);
if (failed.length) process.exitCode = 1;
