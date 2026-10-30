// web_fetch 只准 https/443；白名單要逐跳生效，預設呼叫端行為不變。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateFetchUrl } from '../src/safe-fetch.js';

const WEB_FETCH_OPTS = { allowProtocols: ['https:'], allowPorts: [443] };

test('web_fetch allowlist accepts https on 443 only', async () => {
  await validateFetchUrl('https://1.1.1.1/', WEB_FETCH_OPTS);
  await assert.rejects(validateFetchUrl('http://1.1.1.1/', WEB_FETCH_OPTS), /仅允许 https:/);
  await assert.rejects(validateFetchUrl('https://1.1.1.1:8443/', WEB_FETCH_OPTS), /端口 8443/);
});

test('callers without the allowlist keep the old behaviour', async () => {
  await validateFetchUrl('https://1.1.1.1:8443/');
});
