'use strict';

/**
 * 시작 속도 — **눈에 보이는 시각** 기준. `node scripts/bench-pixels.cjs [--runs N] [--targets tauri] [--min 1500] [--env K=V ...]`
 *
 * bench-startup.cjs 는 렌더러 DOM 에 본문이 생긴 순간을 CDP 로 잰다. 네이티브 미리보기에는 DOM 이 없고, DOM 시각은 화면에 그려지기
 * 직전이라 두 판을 같은 잣대로 견주려면 **화면에 실제로 글이 나타난 순간**이 필요하다. scripts/px-probe 가 그것을 잰다:
 * 실행 직전부터 앱의 창을 PrintWindow 로 계속 떠서, 본문 영역에 글자의 가장자리(가로로 이웃한 픽셀의 밝기가 크게 바뀌는 곳)가
 * --min 개 넘게 처음 생기는 시각. ★ 짙은 픽셀 수로 세면 속는다 — 아직 그려지지 않은 WebView2 창은 PrintWindow 에서 검게 나온다.
 * 판을 번갈아 돌려 PC 의 잡음을 나눠 가진다. 첫 1회(워밍업)는 버린다.
 */
const { spawnSync, execFileSync } = require('node:child_process');
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
const all = (n) => process.argv.flatMap((a, i) => (a === '--' + n ? [process.argv[i + 1]] : []));
const RUNS = Number(arg('runs', 10));
const MIN = arg('min', '4000');
const LABEL = arg('label', '');
const EXTRA_ENV = Object.fromEntries(all('env').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
const sampleDir = path.join(ROOT, 'docs', 'sample');
const DOC = arg('doc', path.join(sampleDir, fs.readdirSync(sampleDir).find((f) => f.endsWith('.md'))));

const PROBE_DIR = path.join(__dirname, 'px-probe');
const PROBE = path.join(PROBE_DIR, 'target', 'release', 'px-probe.exe');
if (!fs.existsSync(PROBE)) {
    console.log('px-probe 를 빌드한다…');
    execFileSync('cargo', ['build', '--release'], { cwd: PROBE_DIR, stdio: 'inherit' });
}

const TARGETS = {
    tauri: { exe: path.join(ROOT, 'src-tauri', 'target', 'release', 'Marklet.exe'), args: () => [DOC] },
};

function once(name) {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-px-'));
    const t = TARGETS[name];
    const r = spawnSync(PROBE, [MIN, '15000', t.exe, ...t.args(ud)], { encoding: 'utf8', env: { ...process.env, ...EXTRA_ENV } });
    const [vis, txt, fin, gaps] = String(r.stdout).trim().split(' ').map(Number);
    const ms = { vis, txt, fin, gaps };
    // 프로세스가 완전히 내려갈 때까지 잠깐
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
    try {
        fs.rmSync(ud, { recursive: true, force: true });
    } catch {
        /* */
    }
    return ms;
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const q = (a, f) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))];

const names = arg('targets', 'tauri').split(',');
const res = Object.fromEntries(names.map((n) => [n, []]));
for (const n of names) once(n);
for (let i = 0; i < RUNS; i++) for (const n of names) res[n].push(once(n));

console.log(`문서: ${path.basename(DOC)} | 판당 ${RUNS}회 | 글자 가장자리 ${MIN}개가 처음 화면에 보인 시각(ms, 실행 직전=0)${LABEL ? ' | ' + LABEL : ''}`);
for (const n of names) {
    const a = res[n].map((x) => x.txt);
    const v = res[n].map((x) => x.vis);
    const f = res[n].map((x) => x.fin);
    const gp = res[n].map((x) => x.gaps);
    console.log(`${(LABEL ? n + '/' + LABEL : n).padEnd(14)} 글자 중앙값 ${String(median(a)).padStart(4)} ms [p25 ${q(a, 0.25)} ~ p75 ${q(a, 0.75)}] | 창이 처음 보인 시각 ${median(v)} ms | 최종 화면(진짜 렌더)이 보인 시각 ${median(f)} ms | 글자 없는 순간 관측 ${gp.join('/')}회 | ${a.join(' ')}`);
}
