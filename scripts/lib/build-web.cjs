/**
 * 웹을 다시 만들고 안드로이드로 동기화한다 — **릴리스 경로에서 gradle 을 부르기 전에.**
 *
 * ★★ 왜 스크립트가 이걸 대신 해 주는가 (2026-08-07).
 *   `npm run build:aab` 와 `npm run publish:internal` 은 이름만 보면 "만들어서 올린다"
 *   인데 실제로는 **gradle 만 불렀다.** 웹 자산은 마지막으로 손수 `npm run build` 를
 *   돌린 그 시점 것이 그대로 들어갔다. 사람이 매번 기억해야 하는 순서를
 *   `02_기술_설계서.md` 가 적어 두기까지 했는데, 적어 두는 것으로는 안 걸린다 —
 *   1.0.6 이 설정 화면에 1.0.5 라고 쓴 채로 두 트랙에 올라갔다.
 *
 * ★ `npm run build` 를 부른다(vite build + 예산 검사 + 색 대비 검사).
 *   `vite build` 만 부르면 그 두 검사가 릴리스에서만 조용히 빠진다.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const isWindows = process.platform === 'win32';

function run(label, cmd, args) {
    console.log(`\n${label}`);
    const r = spawnSync(cmd, args, {
        cwd: repoRoot,
        stdio: 'inherit',
        shell: true, // Windows 의 npm/npx 는 .cmd 라 shell 이 필요하다
    });
    if (r.error) {
        console.error(`❌ ${cmd} 실행 실패:`, r.error.message);
        process.exit(1);
    }
    if (r.status !== 0) process.exit(r.status ?? 1);
}

/** 웹 빌드 + cap sync. 실패하면 프로세스를 끝낸다. */
function buildWebAndSync() {
    run('📦 웹 자산 빌드...', isWindows ? 'npm.cmd' : 'npm', ['run', 'build']);
    run('🔄 안드로이드로 동기화...', isWindows ? 'npx.cmd' : 'npx', ['cap', 'sync', 'android']);
}

module.exports = { buildWebAndSync };
