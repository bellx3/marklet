'use strict';

/**
 * 메모리 — `node scripts/bench-memory.cjs [--runs N] [--idle ms]`
 * 문서를 띄우고 가만히 둔 뒤(기본 6초), 그 프로세스 **트리 전체**(WebView2 · Chromium 자식 포함)의 작업 집합 · 개인 메모리를 더한다.
 * ★ WebView2 의 일부 메모리는 같은 PC 의 다른 WebView2 앱과 공유된다 — 합은 이 앱 때문에 늘어난 양의 상한이다.
 */
const { spawn, execSync } = require('node:child_process');
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
const RUNS = Number(arg('runs', 3));
const IDLE = Number(arg('idle', 6000));
const sampleDir = path.join(ROOT, 'docs', 'sample');
const DOC = arg('doc', path.join(sampleDir, fs.readdirSync(sampleDir).find((f) => f.endsWith('.md'))));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const TARGETS = {
    tauri: { exe: path.join(ROOT, 'src-tauri', 'target', 'release', 'Marklet.exe'), extra: () => [] },
};

function tree(rootPid) {
    // PowerShell 2.0 호환: WMI 로 부모 관계, Get-Process 로 메모리
    const ps = `$all = Get-WmiObject Win32_Process | ForEach-Object { $_.ProcessId.ToString() + ',' + $_.ParentProcessId.ToString() }; $all -join ';'`;
    const pairs = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8' }).trim().split(';').map((x) => x.split(',').map(Number));
    const mine = new Set([rootPid]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const [pid, ppid] of pairs) if (!mine.has(pid) && mine.has(ppid)) { mine.add(pid); grew = true; }
    }
    const ids = [...mine].join(',');
    const out = execSync(`powershell -NoProfile -Command "Get-Process -Id ${ids} -ErrorAction SilentlyContinue | ForEach-Object { $_.WorkingSet64.ToString() + ',' + $_.PrivateMemorySize64.ToString() }"`, { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean).map((l) => l.split(',').map(Number));
    return { n: out.length, ws: out.reduce((a, b) => a + b[0], 0) / 1048576, priv: out.reduce((a, b) => a + b[1], 0) / 1048576 };
}

function once(name) {
    const t = TARGETS[name];
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-mem-'));
    const p = spawn(t.exe, [...t.extra(ud), DOC], { stdio: 'ignore' });
    sleep(IDLE);
    const r = tree(p.pid);
    try { execSync(`taskkill /F /T /PID ${p.pid}`, { stdio: 'ignore' }); } catch { /* */ }
    sleep(800);
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch { /* */ }
    return r;
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const names = ['tauri'];
const res = Object.fromEntries(names.map((n) => [n, []]));
for (let i = 0; i < RUNS; i++) for (const n of names) res[n].push(once(n));
console.log(`문서를 띄우고 ${IDLE / 1000}초 둔 뒤 | ${RUNS}회 중앙값`);
for (const n of names) {
    const r = res[n];
    console.log(`${n.padEnd(9)} 프로세스 ${median(r.map((x) => x.n))}개 | 작업 집합 ${Math.round(median(r.map((x) => x.ws)))} MB | 개인 ${Math.round(median(r.map((x) => x.priv)))} MB`);
}
