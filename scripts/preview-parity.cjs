'use strict';

/**
 * 미리보기 배치가 렌더러와 맞는지 — `node scripts/preview-parity.cjs [문서.md]` (release 빌드 필요)
 *
 * 렌더러(WebView2)의 최상위 블록 위치를 CDP 로 뽑아 네이티브 미리보기의 값(`MARKLET_PREVIEW_DUMP`)과 나란히 놓고 Δy · Δh 를 보인다.
 * 블록 순서가 같다고 보고 줄을 맞댄다. 기대: 문단 · 제목 · 표 · 인용 · 목록 · 코드는 ±0.6 px. 수식(자리만 잡는다)과 Mermaid(렌더러는 나중에
 * 그림으로 바뀐다)가 낀 뒤로는 그 차이만큼 밀린다 — 그 뒤 블록은 앞 블록과의 **상대 간격**으로 본다.
 */
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 설정 · 웹뷰 데이터를 임시 폴더에 쓴다(이 PC 의 진짜 설정을 건드리지 않는다)
require('./lib/profile.cjs').isolate('mk-bench');

const ROOT = path.join(__dirname, '..');
const doc = process.argv[2] || path.join(ROOT, 'docs', 'sample', fs.readdirSync(path.join(ROOT, 'docs', 'sample')).find((f) => f.endsWith('.md')));
const exe = path.join(ROOT, 'src-tauri', 'target', 'release', 'Marklet.exe');
const port = 12300;
const dump = path.join(os.tmpdir(), 'preview-dump.txt');
fs.rmSync(dump, { force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const p = spawn(exe, [doc], { env: { ...process.env, MARKLET_NATIVE: '0', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, MARKLET_PREVIEW_DUMP: dump }, stdio: 'ignore' });
(async () => {
    await sleep(5500);
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = list.find((x) => x.type === 'page' && x.url.includes('tauri.localhost'));
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const ev = (expression) =>
        new Promise((resolve) => {
            const n = ++id;
            const h = (m) => {
                const d = JSON.parse(m.data);
                if (d.id === n) {
                    ws.removeEventListener('message', h);
                    resolve(d.result && d.result.result ? d.result.result.value : undefined);
                }
            };
            ws.addEventListener('message', h);
            ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
        });
    await sleep(1500);
    const web = JSON.parse(
        await ev(`JSON.stringify((() => {
          const out = [];
          const fm = document.querySelector('.md-frontmatter'); if (fm) { const r = fm.getBoundingClientRect(); out.push(['front', r.top + scrollY, r.height]); }
          for (const c of document.querySelectorAll('.md-target section > *')) { const r = c.getBoundingClientRect(); out.push([c.tagName.toLowerCase() + (c.className ? '.' + String(c.className).split(' ')[0] : ''), r.top + scrollY, r.height]); }
          return out;
        })())`),
    );
    const native = fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((l) => l.split(' ')) : [];
    console.log('웹(렌더러)                                   | 네이티브(미리보기)');
    const n = Math.max(web.length, native.length);
    for (let i = 0; i < n; i++) {
        const w = web[i] ? `${web[i][0].padEnd(22)} y ${web[i][1].toFixed(1).padStart(7)} h ${web[i][2].toFixed(1).padStart(6)}` : ''.padEnd(42);
        const m = native[i] ? `${native[i][0].padEnd(8)} y ${Number(native[i][1]).toFixed(1).padStart(7)} h ${Number(native[i][2]).toFixed(1).padStart(6)}` : '';
        const dy = web[i] && native[i] ? `  Δy ${(Number(native[i][1]) - web[i][1]).toFixed(1)} Δh ${(Number(native[i][2]) - web[i][2]).toFixed(1)}` : '';
        console.log(`${w} | ${m}${dy}`);
    }
    execSync(`taskkill /F /T /PID ${p.pid}`, { stdio: 'ignore' });
    process.exit(0);
})().catch((e) => {
    console.error(e);
    try {
        execSync(`taskkill /F /T /PID ${p.pid}`, { stdio: 'ignore' });
    } catch {
        /* */
    }
    process.exit(1);
});
