'use strict';

/**
 * 시작 구간 추적(Rust 쪽) — `node scripts/trace-startup.cjs [--runs N] [--env K=V ...] [--doc 경로] [--exe 경로]`
 *
 * Tauri 판을 `MARKLET_TRACE` 로 띄워 `main · setup · window-build · window-built · ready · painted · shown · preview-*` 같은 표지가
 * 실행 후 몇 ms 에 찍히는지 중앙값으로 보여 준다(첫 회는 워밍업). 어디서 시간이 새는지 보려는 것이다.
 * ★ Node 의 프로세스 생성 지연(≈25 ms)이 모든 값에 얹힌다 — 판 사이 비교에는 bench-pixels.cjs 를 쓴다.
 */
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 설정 · 웹뷰 데이터를 임시 폴더에 쓴다(이 PC 의 진짜 설정을 건드리지 않는다)
require('./lib/profile.cjs').isolate('mk-bench');
const ROOT = path.join(__dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const all = (n) => process.argv.flatMap((a, i) => (a === '--' + n ? [process.argv[i + 1]] : []));
const RUNS = Number(arg('runs', 8));
const EXE = arg('exe', path.join(ROOT, 'src-tauri', 'target', 'release', 'Marklet.exe'));
const EXTRA = Object.fromEntries(all('env').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
const sampleDir = path.join(ROOT, 'docs', 'sample');
const DOC = arg('doc', path.join(sampleDir, fs.readdirSync(sampleDir).find((f) => f.endsWith('.md'))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
(async () => {
    const rows = [];
    for (let i = 0; i < RUNS + 1; i++) {
        const tf = path.join(os.tmpdir(), `mk-trace-${process.pid}-${i}.txt`);
        fs.rmSync(tf, { force: true });
        const t0 = Date.now();
        const p = spawn(EXE, [DOC], { env: { ...process.env, ...EXTRA, MARKLET_TRACE: tf }, stdio: 'ignore' });
        await sleep(2500);
        try { execSync(`taskkill /F /T /PID ${p.pid}`, { stdio: 'ignore' }); } catch {}
        await sleep(500);
        const lines = fs.existsSync(tf) ? fs.readFileSync(tf, 'utf8').split('\n').filter(Boolean) : [];
        const m = {};
        for (const l of lines) { const sp = l.indexOf(' '); const name = l.slice(sp + 1); if (!(name in m)) m[name] = Number(l.slice(0, sp)) - t0; }
        if (i > 0) rows.push(m); // 첫 회는 워밍업
        fs.rmSync(tf, { force: true });
    }
    const names = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const ordered = names.sort((a, b) => median(rows.map((r) => r[a] ?? 1e9)) - median(rows.map((r) => r[b] ?? 1e9)));
    for (const n of ordered) {
        const v = rows.map((r) => r[n]).filter((x) => x !== undefined);
        console.log(n.padEnd(20), String(Math.round(median(v))).padStart(5), 'ms   [', v.map((x) => Math.round(x)).join(' '), ']');
    }
})();
