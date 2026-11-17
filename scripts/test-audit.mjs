// Safe audit suite: fixtures and mocks only, never production Discord/DSH.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  // 共用安全邊界（SSRF、敏感資訊、MCP web-search）與純文字處理。
  'test-audit-security.mjs',
  'test-audit-security-mcp.mjs',
  'test-md-to-plain.mjs',
  'test-media-search.mjs',
  // DSH 連線層、事件流與會話佇列（inbox 投影）：Discord 橋接也用同一條鏈。
  'test-audit-protocol.mjs',
  'test-dsh-inbox-projection.mjs',
  'test-mux-reconnect.mjs',
  // preset bundle 形狀與守衛 fail-closed（離線，不需要 DSH）。
  'test-agent-preset-patches.mjs',
  // Discord 橋接：准入白名單、會話鍵（字串 snowflake）、@/回覆判斷、提問與審批配對、2000 字分條、
  // 會話映射檔容錯，以及 dc-chat preset 的守衛邊界（純離線，不需要 Discord/DSH）。
  'test-discord-bridge.mjs',
  'test-discord-image-jobs.mjs',
  'test-discord-memory.mjs',
  'test-discord-notes.mjs',
  'test-discord-dev-feedback.mjs',
  'test-discord-followup.mjs',
  'test-discord-slang.mjs',
  'test-discord-trigger-stats.mjs',
  // 令牌帳本／價目表（純函數）。
  'test-token-usage.mjs',
  // 控制台靜態契約（跑不了 Playwright 的環境下的替代回歸）。
  'test-console-static.mjs',
];
let failed = 0;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
    cwd: root, stdio: 'inherit', timeout: 60000,
  });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
  }
}
console.log(`\nAudit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;
