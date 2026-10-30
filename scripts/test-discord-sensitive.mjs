// 敏感閘門要先做偽裝歸一化再判定：全形、零寬、base64 都不能繞過；正常聊天不能誤擋。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SENSITIVE_PATTERN, SENSITIVE_RE } from '../src/sensitive.js';

test('obfuscated paths and credentials are still caught', () => {
  const hits = [
    'C:\\Users\\me\\secret.txt',
    'C：＼Users＼me＼secret.txt',
    'C:\u200b\\Users\\me\\secret.txt',
    't o k e n = abc',
    'to-ken=abc',
    Buffer.from('token=abcdef').toString('base64'),
  ];
  for (const text of hits) assert.equal(SENSITIVE_RE.test(text), true, text);
});

test('normal chat, URLs and hashes are not flagged', () => {
  const misses = [
    '今天天氣很好',
    'https://example.com/a?b=c',
    'md5=0123456789abcdef0123456789abcdef',
    '記得帶傘，晚上會下雨',
    'A: /reset 可以重來',
    'Q：/help',
    '方案B: /ask 試試',
  ];
  for (const text of misses) assert.equal(SENSITIVE_RE.test(text), false, text);
});

test('SENSITIVE_PATTERN keeps the raw regex shape for callers that rewrite text', () => {
  assert.equal(typeof SENSITIVE_PATTERN.source, 'string');
  assert.ok(SENSITIVE_PATTERN.source.length > 0);
});
