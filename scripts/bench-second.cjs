'use strict';

/**
 * 이미 떠 있는 앱에 **문서를 하나 더 열 때**의 시작 속도 — `node scripts/bench-second.cjs [--runs N] [--targets tauri]`
 *
 * 첫 인스턴스를 문서 A 로 띄워 3초 둔 뒤(가만히 선 상태), 같은 exe 를 문서 B 로 한 번 더 실행한다. 단일 인스턴스라 두 번째 프로세스는
 * 문서를 넘기고 끝나고, 새 창은 첫 인스턴스에 생긴다. px-probe(PX_ATTACH)가 그 새 창에 글자가 보이는 시각을 잰다
 * (두 번째 실행을 시작한 순간 = 0). 처음 켤 때(bench-pixels.cjs)와 달리 WebView2 · Chromium 이 이미 떠 있다.
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
// --third: 문서 B 도 한 번 더 열어 둔 뒤(여분 창이 만들어질 시간을 준다) 문서 C 를 잰다 — 여럿 여는 사용 방식이다.
const THIRD = process.argv.includes('--third');
// --resident: 로그인 때 미리 켠 앱(--background)에서 시작한다 — 숨겨 둔 창을 쓰고 나면 다음 것을 만들어 둔다(Tauri 판만).
const RESIDENT = process.argv.includes('--resident');
const sampleDir = path.join(ROOT, 'docs', 'sample');
const DOC_B = arg('doc', path.join(sampleDir, fs.readdirSync(sampleDir).find((f) => f.endsWith('.md'))));
const DOC_A = path.join(os.tmpdir(), 'mk-second-a.md');
const DOC_MID = path.join(os.tmpdir(), 'mk-second-mid.md');
fs.writeFileSync(DOC_MID, '# 중간 문서\n\n둘째로 여는 문서다.\n');
fs.writeFileSync(DOC_A, '# 첫 문서\n\n이미 떠 있는 앱이다.\n');
const PROBE = path.join(__dirname, 'px-probe', 'target', 'release', 'px-probe.exe');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const TARGETS = {
    tauri: { exe: path.join(ROOT, 'src-tauri', 'target', 'release', 'Marklet.exe'), extra: () => [] },
};

function once(name) {
    const t = TARGETS[name];
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-2nd-'));
    const first = RESIDENT
        ? spawn(t.exe, ['--background'], { stdio: 'ignore', env: { ...process.env, MARKLET_BACKGROUND_DELAY_MS: '0' } })
        : spawn(t.exe, [...t.extra(ud), DOC_A], { stdio: 'ignore' });
    sleep(Number(arg('idle', 3500)));
    if (THIRD || RESIDENT) {
        spawnSync(t.exe, [...t.extra(ud), DOC_MID]);
        sleep(RESIDENT ? 4500 : 3500);
    }
    const r = spawnSync(PROBE, ['4000', '8000', t.exe, ...t.extra(ud), DOC_B], { encoding: 'utf8', env: { ...process.env, PX_ATTACH: String(first.pid) } });
    const [vis, txt, fin] = String(r.stdout).trim().split(' ').map(Number);
    try {
        execSync(`taskkill /F /T /PID ${first.pid}`, { stdio: 'ignore' });
    } catch {
        /* */
    }
    sleep(700);
    try {
        fs.rmSync(ud, { recursive: true, force: true });
    } catch {
        /* */
    }
    return { vis, txt, fin };
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const names = arg('targets', 'tauri').split(',');
const res = Object.fromEntries(names.map((n) => [n, []]));
for (const n of names) once(n);
for (let i = 0; i < RUNS; i++) for (const n of names) res[n].push(once(n));
console.log(`${RESIDENT ? '미리 켠 앱에서 두 번째 문서(앞 문서가 열려 있다)' : THIRD ? '세 번째 문서(앞에 둘이 열려 있다)' : '두 번째 문서'} | 판당 ${RUNS}회 | 새 창에 글자가 보인 시각(ms, 열기 직후=0)`);
for (const n of names) {
    const a = res[n].map((x) => x.txt);
    console.log(`${n.padEnd(10)} 글자 중앙값 ${String(median(a)).padStart(4)} ms | 새 창이 보인 시각 ${median(res[n].map((x) => x.vis))} ms | 진짜 렌더가 보인 시각 ${median(res[n].map((x) => x.fin))} ms | ${res[n].map((x) => x.fin).join(' ')}`);
}
