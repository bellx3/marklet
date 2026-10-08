'use strict';

/**
 * 시작 속도 — `node scripts/bench-startup.cjs [옵션]`
 *
 * 더블클릭부터 **문서가 보일 때까지**를 웹 창(WebView2)에서 잰다(네이티브 뷰어는 DOM 이 없어 bench-pixels.cjs 로 잰다).
 *   --runs N        판마다 측정 횟수(기본 15). 첫 1회(워밍업)는 버린다.
 *   --targets a,b   잴 대상(기본 tauri)
 *   --doc 경로      열 문서(기본 docs/sample 의 예시 문서)
 *   --cold          매번 새 프로필(앱 데이터 · WebView2 캐시 없음)로 — 설치 직후 첫 실행에 가깝다.
 *   --env K=V       Tauri 실행에 환경변수를 더한다(WebView2 인자 시험: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=...). 여러 번 가능.
 *   --label 이름    결과 줄 앞에 붙일 이름(변형을 구분할 때)
 *
 * ★ 측정 방식: 실행 직전의 Date.now() 를 0 으로, 렌더러에 CDP 로 붙어 본문(h1)이 DOM 에 생기는 순간을
 *   MutationObserver 로 잡는다(없으면 폴링). 같은 PC · 같은 문서 · 같은 CDP 부하. 판을 번갈아 돌려 PC 의 잡음을 나눠 가진다.
 * ★ 구간(ms): spawn→navStart(네이티브 초기화) / navStart→DCL(HTML · JS 평가) / DCL→문서(IPC · 렌더).
 *   navStart 는 렌더러가 보고하는 performance.timeOrigin 이다.
 */
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 설정 · 웹뷰 데이터를 임시 폴더에 쓴다(이 PC 의 진짜 설정을 건드리지 않는다)
const profile = require('./lib/profile.cjs').isolate('mk-bench');

const ROOT = path.join(__dirname, '..');
const arg = (name, def) => {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes('--' + name);
const all = (name) => process.argv.flatMap((a, i) => (a === '--' + name ? [process.argv[i + 1]] : []));

const RUNS = Number(arg('runs', 15));
const COLD = flag('cold');
const TRACE = flag('trace');
const traces = {};
const LABEL = arg('label', '');
const EXTRA_ENV = Object.fromEntries(all('env').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
const sampleDir = path.join(ROOT, 'docs', 'sample');
const DOC = arg('doc', path.join(sampleDir, fs.readdirSync(sampleDir).find((f) => f.endsWith('.md'))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --cold: 임시 프로필의 설정 · 웹뷰 데이터를 비운다(진짜 폴더는 건드리지 않는다)
const wipeTauriData = () => {
    fs.rmSync(profile.stateFile, { force: true });
    try {
        fs.rmSync(path.join(profile.dir, 'webview'), { recursive: true, force: true });
    } catch {
        /* 쥐고 있으면 다음 실행에 비운다 */
    }
};

const TARGETS = {
    tauri: {
        exe: path.join(ROOT, 'src-tauri', 'target', 'release', 'Marklet.exe'),
        start(port) {
            const extra = EXTRA_ENV.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS || '';
            return {
                args: [DOC],
                env: { ...EXTRA_ENV, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} ${extra}`.trim() },
            };
        },
        isPage: (u) => u.includes('tauri.localhost'),
    },
};

async function once(name) {
    const t = TARGETS[name];
    const port = 11000 + Math.floor(Math.random() * 800);
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-bench-'));
    if (name === 'tauri' && COLD) wipeTauriData();
    const { args, env } = t.start(port, ud);
    const traceFile = path.join(ud, 'trace.txt');
    if (TRACE && name === 'tauri') env.MARKLET_TRACE = traceFile;

    const t0 = Date.now();
    const p = spawn(t.exe, args, { env: { ...process.env, ...env }, stdio: 'ignore' });
    let page = null;
    while (!page && Date.now() - t0 < 30000) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
            page = list.find((x) => x.type === 'page' && t.isPage(x.url));
        } catch {
            /* 아직 */
        }
        if (!page) await sleep(5);
    }
    if (!page) throw new Error(`${name}: 페이지를 못 찾았다`);
    const tPage = Date.now() - t0;

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

    // 문서가 DOM 에 들어오는 순간을 잡는다(에폭 ms).
    // ★ 한 번만 붙이면 안 된다 — 문서가 커밋되기 전의 빈 문서에 붙이면 이동할 때 버려진다. 폴링할 때마다 확인해서 다시 붙인다.
    const probe = `(() => {
      if (!window.__bench) {
        window.__bench = { h1: 0, full: 0 };
        const check = () => {
          const now = performance.timeOrigin + performance.now();
          if (!window.__bench.h1 && document.querySelector('.md-body h1')) window.__bench.h1 = now;
          if (!window.__bench.full && document.querySelector('.md-body h1') && document.querySelector('.katex') && document.querySelector('.mermaid-svg svg')) window.__bench.full = now;
        };
        new MutationObserver(check).observe(document, { childList: true, subtree: true });
        check();
      }
      const n = performance.getEntriesByType('navigation')[0];
      return JSON.stringify({ b: window.__bench, origin: performance.timeOrigin, nav: n ? { dcl: n.domContentLoadedEventEnd } : null });
    })()`;

    let res = null;
    while (Date.now() - t0 < 30000) {
        const raw = await ev(probe);
        const j = raw && JSON.parse(raw);
        if (j && j.b && j.b.full) {
            res = j;
            break;
        }
        await sleep(10);
    }
    if (!res) throw new Error(`${name}: 문서가 안 떴다`);

    if (TRACE && name === 'tauri' && fs.existsSync(traceFile)) {
        for (const line of fs.readFileSync(traceFile, 'utf8').split(String.fromCharCode(10))) {
            const sp = line.indexOf(' ');
            if (sp > 0) (traces[line.slice(sp + 1)] ||= []).push(Number(line.slice(0, sp)) - t0);
        }
    }
    try {
        execSync(`taskkill /F /T /PID ${p.pid}`, { stdio: 'ignore' });
    } catch {
        /* 이미 끝남 */
    }
    await sleep(500);
    try {
        fs.rmSync(ud, { recursive: true, force: true });
    } catch {
        /* 잠겨 있으면 OS 가 치운다 */
    }

    const navStart = res.origin - t0;
    return {
        page: tPage,
        navStart: Math.round(navStart),
        dcl: Math.round(res.nav ? res.origin + res.nav.dcl - t0 - navStart : 0),
        h1: Math.round(res.b.h1 - t0),
        full: Math.round(res.b.full - t0),
    };
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const q = (a, f) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))];

(async () => {
    const names = arg('targets', 'tauri').split(',');
    const results = Object.fromEntries(names.map((n) => [n, []]));
    // 워밍업 1회씩
    for (const n of names) await once(n);
    // 번갈아 측정
    for (let i = 0; i < RUNS; i++) {
        for (const n of names) results[n].push(await once(n));
    }
    if (COLD) wipeTauriData();
    console.log(`문서: ${path.basename(DOC)} | 판당 ${RUNS}회 | ${COLD ? '새 프로필(cold)' : '재사용 프로필(warm)'}${LABEL ? ' | ' + LABEL : ''}`);
    console.log('판'.padEnd(10), 'h1 중앙값'.padEnd(11), '[p25 ~ p75]'.padEnd(14), '수식·도식까지'.padEnd(13), '네이티브초기화(→navStart)'.padEnd(22), 'HTML·JS(→DCL)'.padEnd(14));
    for (const n of names) {
        const r = results[n];
        const col = (k) => r.map((x) => x[k]);
        console.log(
            (LABEL ? `${n}/${LABEL}` : n).padEnd(10),
            `${median(col('h1'))} ms`.padEnd(11),
            `[${q(col('h1'), 0.25)} ~ ${q(col('h1'), 0.75)}]`.padEnd(14),
            `${median(col('full'))} ms`.padEnd(13),
            `${median(col('navStart'))} ms`.padEnd(22),
            `${median(col('dcl'))} ms`.padEnd(14),
        );
    }
    if (TRACE) {
        console.log('--- Tauri 내부 시각(실행 직전=0, 중앙값 ms) ---');
        for (const [k, v] of Object.entries(traces)) console.log(k.padEnd(18), String(Math.round(median(v))).padStart(5));
    }
    if (flag('raw')) for (const n of names) console.log(n, results[n].map((x) => x.h1).join(' '));
    process.exit(0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
