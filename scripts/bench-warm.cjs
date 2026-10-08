'use strict';

/**
 * 창을 **닫았다가 다시 열 때**의 속도 — `node scripts/bench-warm.cjs [--runs N] [--targets tauri]`
 *
 * 문서 A 로 앱을 띄워 3초 둔 뒤 창을 닫고(WM_CLOSE) 1초 뒤 문서 B 를 연다. 그 뒤 앱이 어떻게 되는지는 앱이 정한 대로 둔다:
 *  · 빠른 시작이 켜져 있으면 창을 숨겨 둔 채 살아 있다 → 같은 프로세스의 새 창을 잰다.
 *  · 꺼져 있거나 네이티브 뷰어만 쓴 경우에는 마지막 창을 닫으면 프로세스가 끝난다 → 문서 B 는 처음 켜는 것과 같다(새 프로세스를 띄워 잰다).
 * 재는 값은 bench-pixels.cjs 와 같다: 글자가 처음 보이는 시각 · 진짜 렌더(미리보기가 아닌 창)가 보이는 시각, 문서 B 를 연 순간 = 0.
 */
const { spawn, spawnSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 설정 · 웹뷰 데이터를 임시 폴더에 쓴다(이 PC 의 진짜 설정을 건드리지 않는다)
require('./lib/profile.cjs').isolate('mk-bench');

const ROOT = path.join(__dirname, '..');
const arg = (n, d) => {
    const i = process.argv.indexOf('--' + n);
    return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const RUNS = Number(arg('runs', 8));
// --resident: 창을 닫는 대신 '로그인 때 미리 켠' 상태(--background)에서 시작한다
const RESIDENT = process.argv.includes('--resident');
const sampleDir = path.join(ROOT, 'docs', 'sample');
const DOC_B = path.join(sampleDir, fs.readdirSync(sampleDir).find((f) => f.endsWith('.md')));
const DOC_A = path.join(os.tmpdir(), 'mk-warm-a.md');
fs.writeFileSync(DOC_A, '# 첫 문서\n\n닫았다 다시 여는 시험의 앞 문서다.\n');
const PROBE = path.join(__dirname, 'px-probe', 'target', 'release', 'px-probe.exe');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};
const TARGETS = {
    tauri: { exe: path.join(ROOT, 'src-tauri', 'target', 'release', 'Marklet.exe'), extra: () => [] },
};

function once(name) {
    const t = TARGETS[name];
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-warmb-'));
    const first = RESIDENT
        ? spawn(t.exe, ['--background'], { stdio: 'ignore', env: { ...process.env, MARKLET_BACKGROUND_DELAY_MS: '0' } })
        : spawn(t.exe, [...t.extra(ud), DOC_A], { stdio: 'ignore' });
    sleep(3500);
    if (!RESIDENT) spawnSync(PROBE, [], { env: { ...process.env, PX_CLOSE_WINDOW: String(first.pid) } });
    sleep(1500);
    const stillThere = alive(first.pid);
    // 앱이 살아 있으면 그 프로세스의 새 창을, 끝났으면 새로 띄운 프로세스의 창을 잰다.
    const env = stillThere ? { ...process.env, PX_ATTACH: String(first.pid) } : { ...process.env };
    const r = spawnSync(PROBE, ['4000', '15000', t.exe, ...t.extra(ud), DOC_B], { encoding: 'utf8', env });
    const nums = String(r.stdout).trim().split(' ').map(Number);
    // 첫 실행 모드: vis txt fin gaps / 붙기 모드: vis txt fin
    const [vis, txt, fin] = nums;
    try {
        execSync(`taskkill /F /T /PID ${first.pid}`, { stdio: 'ignore' });
    } catch {
        /* */
    }
    sleep(900);
    try {
        fs.rmSync(ud, { recursive: true, force: true });
    } catch {
        /* */
    }
    return { vis, txt, fin, stillThere };
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const names = arg('targets', 'tauri').split(',');
const res = Object.fromEntries(names.map((n) => [n, []]));
for (const n of names) once(n);
for (let i = 0; i < RUNS; i++) for (const n of names) res[n].push(once(n));
console.log(`${RESIDENT ? '로그인 때 미리 켜 둔 앱에 열기' : '닫았다 다시 열기'} | 판당 ${RUNS}회 | 문서 B 를 연 순간 = 0`);
for (const n of names) {
    const r = res[n];
    console.log(
        `${n.padEnd(9)} 앱 생존 ${r.filter((x) => x.stillThere).length}/${r.length} | 창이 보임 ${median(r.map((x) => x.vis))} ms | 글자가 보임 ${median(r.map((x) => x.txt))} ms | 진짜 렌더가 보임 ${median(r.map((x) => x.fin))} ms | ${r.map((x) => x.fin).join(' ')}`,
    );
}
