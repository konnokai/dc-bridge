// 敏感閘門要先做偽裝歸一化再判定：全形、零寬、base64 都不能繞過；正常聊天不能誤擋。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SENSITIVE_PATTERN, SENSITIVE_RE, matchSensitive } from '../src/sensitive.js';

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

test('a colon-separated value that is not an emoji shortcode still counts', () => {
  const hits = [
    'password:user:pass',
    'token:hunter2:',
    'token :hunter2:',
    'token: :hunter2:',
    'api_key:abcdef:',
    '密码 :hunter2:',
  ];
  for (const text of hits) assert.equal(SENSITIVE_RE.test(text), true, text);
});

test('traditional Chinese keywords are caught too', () => {
  const hits = [
    '密碼=hunter2',
    '密碼：hunter2',
    '我的密碼為 hunter2',
    '密鑰:abc123',
    '口令=abc123',
    '帳號密碼是 abc12345',
  ];
  for (const text of hits) assert.equal(SENSITIVE_RE.test(text), true, text);
  const misses = ['這是我家的密碼鎖', '密碼是對的', '忘記密碼了'];
  for (const text of misses) assert.equal(SENSITIVE_RE.test(text), false, text);
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

test('a hit reports its kind and the fragment that matched', () => {
  assert.deepEqual(matchSensitive('token=abcdef123456'), { rule: 'credential', match: 'token=abcdef123456' });
  assert.equal(matchSensitive('看 C:\\Users\\me\\secret.txt 這個')?.rule, 'path');
  assert.equal(matchSensitive('今天天氣很好'), null);
  // base64 也要講得出是被解碼後的哪一段命中。
  const encoded = Buffer.from('token=abcdef').toString('base64');
  assert.deepEqual(matchSensitive(encoded), { rule: 'credential', match: 'token=abcdef' });
});
