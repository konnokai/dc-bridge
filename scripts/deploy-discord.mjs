// 部署到 Discord 測試伺服器（Linux + pm2）。
//
// 伺服器 /home/jun/dc-bridge 是這個 repo 的 checkout（detached HEAD）。
// config.json、state/、node_modules/、audio/ 都是 gitignore 的未追蹤檔，checkout 不會碰它們，
// 所以部署就是：把本機 HEAD 推到 origin/main → 伺服器 fetch + checkout 同一個 commit
// → 遠端測試 → setup:discord（必要時）→ 重啟 → 健康檢查。
//
// 任何一步失敗就停。回退＝再部署一次舊的 commit：`--sha <舊的 sha>`。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULTS = {
  host: 'jun@192.168.98.21',
  dir: '/home/jun/dc-bridge',
  // 非互動 shell 的 PATH 沒有 node 與 pm2（版本記在 AGENTS.md）
  nodeBin: '$HOME/.nvm/versions/node/v26.12.1/bin',
};

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dryRun = flag('--dry-run');
const skipTests = flag('--skip-tests');
const host = value('--host') || DEFAULTS.host;
const remoteDir = value('--dir') || DEFAULTS.dir;
const wantedSha = value('--sha');

let target = null;
let previous = null;
let reloadedDsh = false;
let restarted = false;

function rollbackHint() {
  if (!previous || previous === target) return '';
  return `\n回退：node scripts/deploy-discord.mjs --sha ${previous}`;
}

function fail(message) {
  console.error(`\n✗ ${message}${rollbackHint()}`);
  process.exit(1);
}

function log(message) {
  console.log(`• ${message}`);
}

function local(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}

function git(args) {
  const result = local('git', args);
  if (result.status !== 0) fail(`git ${args.join(' ')} 失敗：${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** 在伺服器的專案目錄跑一段 bash。 */
function remote(script) {
  const body = [
    `export PATH="${DEFAULTS.nodeBin}:$PATH"`,
    `cd ${remoteDir} || exit 90`,
    script,
  ].join('\n');
  const result = local('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, body]);
  if (result.status !== 0) fail(`遠端指令失敗：\n${script}\n${(result.stderr || '').trim()}`);
  return result;
}

/** 用 git diff 列出兩個 commit 之間的變更。 */
function changesBetween(from, to) {
  const raw = git(['-c', 'core.quotePath=false', 'diff', '-z', '--name-status', '-M', `${from}..${to}`]);
  const parts = raw.split('\0').filter(Boolean);
  const changed = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (status.startsWith('R')) changed.push(parts[++i], parts[++i]);
    else changed.push(parts[++i]);
  }
  return changed;
}

/** MCP server 會載入的本地檔案（含遞迴 import）。改到其中一個就得重啟 DSH。 */
function mcpInputs() {
  const seen = new Set();
  const queue = fs.readdirSync(path.join(ROOT, 'src'))
    .filter((name) => /^mcp-.*\.js$/.test(name))
    .map((name) => `src/${name}`);
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    let text = '';
    try {
      text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
    }
  }
  return seen;
}

function main() {
  console.log(`部署到 ${host}:${remoteDir}${dryRun ? '（dry run）' : ''}\n`);

  const dirty = git(['status', '--porcelain']);
  if (dirty && !dryRun) fail(`工作目錄不是乾淨的，先 commit：\n${dirty}`);
  if (dirty) console.warn('  ! 工作目錄不乾淨，只部署 commit 過的內容');

  // 1. 決定要部署哪個 commit
  target = wantedSha || git(['rev-parse', 'HEAD']);
  const short = (sha) => sha.slice(0, 7);
  if (local('git', ['cat-file', '-e', `${target}^{commit}`]).status !== 0) {
    fail(`本機沒有 commit ${target}，先 git fetch origin`);
  }
  git(['fetch', '--quiet', 'origin']);
  if (target === git(['rev-parse', 'HEAD'])) {
    const pushed = git(['rev-parse', 'origin/main']);
    if (pushed !== target) fail(`HEAD（${short(target)}）還沒推到 origin/main，先 push（或跑 /ship）`);
  } else if (local('git', ['merge-base', '--is-ancestor', target, 'origin/main']).status !== 0) {
    fail(`commit ${short(target)} 不在 origin/main 上，伺服器抓不到`);
  }

  // 2. 伺服器上的 repo 狀態
  const probe = remote('git rev-parse --show-toplevel 2>/dev/null || echo NOGIT').stdout.trim();
  if (probe === 'NOGIT') {
    fail(`${remoteDir} 還不是 git repo。一次性設定：\n  cd ${remoteDir} && git init && git remote add origin <repo url> && git fetch origin && git reset --hard origin/main`);
  }
  previous = remote('git rev-parse HEAD').stdout.trim();
  if (previous === target) {
    console.log(`伺服器已經是 ${short(target)}，沒有要部署的東西。`);
    return;
  }

  // 3. 這次會換掉哪些檔案（只用來決定要不要重啟 DSH）
  const changed = changesBetween(previous, target);
  console.log(`伺服器：${short(previous)} → ${short(target)}（${changed.length} 個檔案）`);
  if (changed.length) console.log(changed.slice(0, 40).map((f) => `  ${f}`).join('\n'));
  if (dryRun) {
    console.log('\n(dry run) 沒有動任何東西。');
    return;
  }

  // 4. 本機先過
  if (!skipTests) {
    log('本機檢查：preset patch 與 Discord 測試');
    const patch = local(process.execPath, [path.join(ROOT, 'scripts', 'build-agent-preset-patches.mjs'), '--check'], { stdio: 'inherit' });
    if (patch.status !== 0) fail('build-agent-preset-patches --check 失敗');
    const tests = local(process.execPath, [path.join(ROOT, 'scripts', 'test-discord-all.mjs')], { stdio: 'inherit' });
    if (tests.status !== 0) fail('npm run test:discord 失敗');
  } else {
    console.warn('  ! 跳過本機與遠端測試（--skip-tests）');
  }

  // 5. 伺服器 checkout。tracked 檔案被改過時 git 會拒絕，正好停在部署前。
  log(`伺服器 fetch + checkout ${short(target)}`);
  const after = remote(`git fetch --prune --quiet origin && git checkout --detach ${target} >/dev/null 2>&1 && git rev-parse HEAD`).stdout.trim();
  if (after !== target) fail(`伺服器 checkout 後是 ${short(after || '（空的）')}，不是 ${short(target)}`);
  const localChanges = remote('git status --porcelain --untracked-files=no').stdout.trim();
  if (localChanges) fail(`伺服器上的 tracked 檔案跟 commit 不一致：\n${localChanges}`);

  // 6. 遠端再驗一次
  if (!skipTests) {
    log('遠端檢查：preset patch 與 Discord 測試');
    remote('node scripts/build-agent-preset-patches.mjs --check');
    const remoteTests = remote(
      `for f in scripts/test-discord-*.mjs; do case "$f" in *test-discord-all*) continue;; esac; echo "Running $f"; node "$f" >/tmp/dc-test.log 2>&1 || { tail -30 /tmp/dc-test.log; exit 1; }; done`,
    );
    console.log(remoteTests.stdout.trim());
  }

  // 7. 同步 preset、重啟
  const inputs = mcpInputs();
  const needsDshReload = changed.some(
    (f) => inputs.has(f) || f.startsWith('dsh/agent-presets/') || f.startsWith('plugins/') || f === 'scripts/setup-dsh.mjs',
  );
  const needsRestart = needsDshReload || changed.some((f) => /^(src|public|dsh|plugins)\//.test(f));
  const errorLog = '$HOME/.pm2/logs/dc-bridge-error.log';
  const outLog = '$HOME/.pm2/logs/dc-bridge-out.log';
  const errorSize = Number(remote(`stat -c %s ${errorLog} 2>/dev/null || echo 0`).stdout.trim());
  const outSize = Number(remote(`stat -c %s ${outLog} 2>/dev/null || echo 0`).stdout.trim());

  if (!needsRestart) {
    log('只改了文件，不重啟');
  } else if (needsDshReload) {
    log('動到 preset／plugin／MCP：setup:discord + 重啟 dsh 與 dc-bridge');
    reloadedDsh = true;
    restarted = true;
    remote('npm run setup:discord');
    remote('pm2 stop dc-bridge >/dev/null && pm2 restart dsh >/dev/null && sleep 5 && pm2 start dc-bridge >/dev/null');
  } else {
    log('只重啟 dc-bridge');
    restarted = true;
    remote('pm2 restart dc-bridge >/dev/null');
  }

  // 8. 健康檢查：程序真的重啟、新的 log 有登入、error log 沒長大
  if (needsRestart) {
    log('等待程序穩定（最多 30 秒）');
    const jlist = `node -e "const{execSync}=require('child_process');const s=execSync('pm2 jlist',{encoding:'utf8'});const i=s.indexOf('[');for(const p of JSON.parse(s.slice(i)))console.log([p.name,p.pm2_env.status,Math.round((Date.now()-p.pm2_env.pm_uptime)/1000)].join(' '))"`;
    let fresh = '';
    let rows = [];
    // 登入不是同步的：一直查到看到「已登入：」為止，避免慢一點就誤判失敗
    for (let attempt = 1; attempt <= 6; attempt++) {
      remote('sleep 5');
      rows = remote(jlist).stdout.trim().split('\n').filter(Boolean).map((l) => l.trim().split(' '));
      fresh = remote(`tail -c +${outSize + 1} ${outLog}`).stdout;
      if (fresh.includes('已登入：') && rows.some((r) => r[0] === 'dc-bridge' && r[1] === 'online')) break;
    }
    console.log(rows.map((r) => '  ' + r.join(' ')).join('\n'));
    const row = (name) => rows.find((r) => r[0] === name);
    for (const name of reloadedDsh ? ['dc-bridge', 'dsh'] : ['dc-bridge']) {
      const found = row(name);
      if (!found || found[1] !== 'online') fail(`${name} 不是 online`);
      if (Number(found[2]) > 180) fail(`${name} 沒有重啟（已運行 ${found[2]} 秒）`);
    }
    const grown = Number(remote(`stat -c %s ${errorLog} 2>/dev/null || echo 0`).stdout.trim()) - errorSize;
    if (grown > 0) {
      fail(`重啟後 error log 多了 ${grown} bytes：\n${remote(`tail -c ${grown} ${errorLog}`).stdout.trim()}`);
    }
    const lastLines = fresh.trim().split('\n').slice(-12);
    console.log('  --- dc-bridge log ---');
    console.log(lastLines.map((l) => '  ' + l).join('\n'));
    if (!fresh.includes('已登入：')) fail('重啟後的新 log 沒有「已登入：」，bridge 可能沒登入 Discord');
    if (!fresh.includes('已註冊全域 slash command')) console.warn('  ! 新 log 沒看到「已註冊全域 slash command」');
  }

  log(`完成：${short(target)}`);
  console.log(rollbackHint());
}

main();
