/**
 * 잡히지 않은 예외에서 **멈춰서 진짜 호출 스택**을 받아 낸다 (진단 도구).
 *
 *   node scripts/cdp-catch.mjs <포트> [초]
 *
 * ★★ Runtime.exceptionThrown 만으로 부족할 때 쓴다. 네이티브가 문자열로 평가한
 *   코드(Capacitor 의 플러그인 콜백이 그렇다) 안에서 터지면 stackTrace 가 비어
 *   "https://localhost/:1:44" 밖에 안 나온다 — 그걸로는 어디인지 알 수 없다.
 *   Debugger.setPauseOnExceptions 로 멈추면 callFrames 가 통째로 온다.
 *
 * ★ 멈춘 뒤에는 곧바로 재개시키므로 앱은 그대로 흘러간다.
 */
const port = process.argv[2];
const seconds = Number(process.argv[3] ?? 20);
if (!port) {
    console.error('사용: node scripts/cdp-catch.mjs <포트> [초]');
    process.exit(1);
}

const targets = await (await fetch(`http://localhost:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) {
    console.error('페이지 타깃을 찾지 못했습니다.');
    process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const scripts = new Map(); // scriptId -> url
let id = 10;
let 잡음 = 0;

const send = (method, params = {}) => ws.send(JSON.stringify({ id: id++, method, params }));

ws.addEventListener('open', () => {
    send('Debugger.enable');
    send('Runtime.enable');
    send('Debugger.setPauseOnExceptions', { state: 'uncaught' });
});

ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);

    if (msg.method === 'Debugger.scriptParsed') {
        scripts.set(msg.params.scriptId, msg.params.url || '(이름 없는 스크립트)');
    }

    if (msg.method === 'Debugger.paused' && msg.params.reason === 'exception') {
        잡음++;
        const d = msg.params.data;
        console.log(`\n══ 예외 #${잡음}: ${d?.description ?? d?.className ?? '(모름)'}`);
        for (const f of msg.params.callFrames.slice(0, 12)) {
            const url = scripts.get(f.location.scriptId) ?? '(모름)';
            const 짧은 = url.replace(/^https?:\/\/[^/]+\//, '');
            console.log(
                `   ${(f.functionName || '(익명)').padEnd(28)} ${짧은}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1}`,
            );
        }
        send('Debugger.resume'); // 앱을 붙잡아 두지 않는다
    }
});

setTimeout(() => {
    console.log(잡음 === 0 ? '\n(그 사이에 잡히지 않은 예외는 없었다)' : `\n합계 ${잡음}건`);
    ws.close();
    process.exit(0);
}, seconds * 1000);
