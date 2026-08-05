#!/usr/bin/env node

/**
 * 큰 문서 실측 — 기기에 밀어 둔 .md 를 인텐트로 열고 시간을 잰다.
 *
 *   node scripts/perf-run.mjs <포트> <기기경로> <라벨>
 *
 * ★ 여는 시간을 JS 안에서만 재면 **네이티브 읽기와 게이트 다이얼로그가 빠진다.**
 *   여기서는 인텐트를 쏜 순간부터 화면에 첫 글자가 붙을 때까지를 벽시계로 잰다 —
 *   사용자가 실제로 기다리는 시간이 그것이다.
 *   내부 계측(doc:parse, doc:complete)은 앱의 perf 링버퍼에서 따로 읽는다.
 */

import { execFileSync } from 'node:child_process';

const [port, contentUri, label] = process.argv.slice(2);
if (!port || !contentUri) {
    console.error('사용: node scripts/perf-run.mjs <포트> <content URI> [라벨]');
    process.exit(1);
}

const ADB = process.env.ADB ?? 'adb';
const sh = (args) =>
    execFileSync(ADB, args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });

/**
 * 웹뷰 디버그 소켓에 다시 붙는다.
 *
 * ★★ 콜드 스타트로 재면 **PID 가 바뀐다.** adb forward 의 대상은
 *   webview_devtools_remote_<pid> 라 앞의 포워드는 죽은 소켓을 가리킨다.
 *   이걸 안 하면 "첫 화면이 안 뜬다"로만 보이고 실제로는 못 물어본 것이다.
 */
function reforward() {
    try {
        const pid = sh(['shell', 'pidof', 'com.marklet.md.debug']).trim().split(/\s+/)[0];
        if (!pid) return false;
        sh(['forward', '--remove-all']);
        sh(['forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`]);
        return true;
    } catch {
        return false;
    }
}

async function evalInPage(expression) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) throw new Error('페이지 타깃 없음');
    const ws = new (globalThis.WebSocket ?? (await import('ws')).WebSocket)(
        page.webSocketDebuggerUrl,
    );
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('시간 초과')), 60000);
        ws.onopen = () =>
            ws.send(
                JSON.stringify({
                    id: 1,
                    method: 'Runtime.evaluate',
                    params: { expression, returnByValue: true, awaitPromise: true },
                }),
            );
        ws.onmessage = (m) => {
            const msg = JSON.parse(m.data.toString());
            if (msg.id !== 1) return;
            clearTimeout(timer);
            ws.close();
            if (msg.result?.exceptionDetails) {
                reject(new Error(msg.result.exceptionDetails.exception?.description ?? '오류'));
                return;
            }
            resolve(msg.result.result.value);
        };
        ws.onerror = (e) => reject(new Error(String(e?.message ?? e)));
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 2. 인텐트를 쏘고, 본문 첫 글자가 붙을 때까지 기다린다
// ★ 반드시 콜드 스타트로 잰다. 이미 떠 있으면 onNewIntent 경로라 조건이 달라진다.
sh(['shell', 'am', 'force-stop', 'com.marklet.md.debug']);
await sleep(1500);
const t0 = Date.now();
sh([
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-t',
    'text/markdown',
    '-d',
    contentUri,
    '--grant-read-uri-permission',
]);

let firstPaint = null;
let gate = null;
let attached = false;
for (let i = 0; i < 300; i++) {
    await sleep(100);
    // 새 프로세스가 뜰 때까지 계속 다시 붙어 본다.
    if (!attached) attached = reforward();
    const state = await evalInPage(`
      (() => {
        const dlg = document.querySelector('.dialog-backdrop:not([hidden])');
        if (dlg) return JSON.stringify({ gate: dlg.querySelector('.dialog-title')?.textContent ?? '?' });
        const target = document.querySelector('.screen-viewer .md-target');
        const shown = !document.querySelector('.screen-viewer')?.hidden;
        const len = target?.textContent?.length ?? 0;
        return JSON.stringify({ shown, len, plain: !!target?.querySelector('.md-plain') });
      })()`).catch(() => null);
    if (!state) continue;
    const s = JSON.parse(state);
    if (s.gate) {
        gate = s.gate;
        // 게이트가 뜨면 '열기'를 누른다 — 마지막 버튼이 진행이다.
        await evalInPage(
            `[...document.querySelectorAll('.dialog-actions .btn')].pop().click(), 1`,
        ).catch(() => {});
        continue;
    }
    if (s.shown && s.len > 0) {
        firstPaint = Date.now() - t0;
        break;
    }
}

if (firstPaint === null) {
    console.log(`${label ?? contentUri}: 첫 화면이 뜨지 않았다 (30초 초과)`);
    process.exit(1);
}

// ── 3. 배경 렌더가 끝날 때까지
let complete = null;
for (let i = 0; i < 600; i++) {
    await sleep(100);
    const busy = await evalInPage(`document.querySelector('.viewer-busy')?.hidden !== false`).catch(
        () => {
            reforward();
            return true;
        },
    );
    if (busy) {
        complete = Date.now() - t0;
        break;
    }
}

// ── 4. 검색 — 문서 맨 끝의 표시를 찾는다(뒷부분까지 훑는지 확인)
const searchStart = Date.now();
await evalInPage(`
  [...document.querySelectorAll('.viewer-bar > button')]
    .find(b => /찾기|Find/.test(b.getAttribute('aria-label') ?? '')).click(), 1`);
await sleep(300);
await evalInPage(`
  (() => { const i = document.querySelector('.search-bar .search-input');
           i.value = 'OMEGA_MARKER_END'; i.dispatchEvent(new Event('input')); return 1; })()`);

let searchMs = null;
let hits = 0;
for (let i = 0; i < 300; i++) {
    await sleep(100);
    const n = await evalInPage(`document.querySelectorAll('.md-target mark').length`).catch(
        () => 0,
    );
    if (n > 0) {
        hits = n;
        searchMs = Date.now() - searchStart;
        break;
    }
}
const counter = await evalInPage(
    `document.querySelector('.search-counter')?.textContent ?? ''`,
).catch(() => '');

// 검색 닫기
await evalInPage(`[...document.querySelectorAll('.search-bar button')].pop().click(), 1`).catch(
    () => {},
);
await sleep(300);

// ── 5. 목차 — 마지막 항목으로 뛴다(남은 청크를 전부 붙이는 경로)
const tocStart = Date.now();
await evalInPage(`
  [...document.querySelectorAll('.viewer-bar > button')]
    .find(b => /목차|Contents/.test(b.getAttribute('aria-label') ?? '')).click(), 1`);
await sleep(400);
const headings = await evalInPage(
    `document.querySelectorAll('[aria-labelledby="toc-title"] .toc-item').length`,
).catch(() => 0);
await evalInPage(
    `(() => { const it=[...document.querySelectorAll('[aria-labelledby="toc-title"] .toc-item')]; it[it.length-1]?.click(); return 1; })()`,
).catch(() => {});

let tocMs = null;
for (let i = 0; i < 600; i++) {
    await sleep(100);
    const busy = await evalInPage(`document.querySelector('.viewer-busy')?.hidden !== false`).catch(
        () => {
            reforward();
            return true;
        },
    );
    if (busy) {
        tocMs = Date.now() - tocStart;
        break;
    }
}

// ── 6. 앱 내부 계측
const samples = await evalInPage(`
  (() => {
    try { return JSON.stringify(window.__perf ?? null); } catch { return 'null'; }
  })()`).catch(() => 'null');

const chunks = await evalInPage(`document.querySelectorAll('.md-target .md-chunk').length`).catch(
    () => 0,
);
const plain = await evalInPage(`!!document.querySelector('.md-target .md-plain')`).catch(
    () => false,
);

console.log(
    JSON.stringify(
        {
            문서: label ?? contentUri,
            게이트: gate ?? '(없음)',
            원문만: plain,
            청크수: chunks,
            제목수: headings,
            '첫 글자까지(ms)': firstPaint,
            '전체 렌더(ms)': complete,
            '검색(ms)': searchMs,
            검색결과: counter || `${hits}건`,
            '목차 마지막으로(ms)': tocMs,
            내부계측: samples === 'null' ? '(노출 안 됨)' : samples,
        },
        null,
        0,
    ),
);
