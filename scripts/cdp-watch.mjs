/**
 * 웹뷰에서 나는 예외·오류를 **스택까지** 받아 적는다 (진단 도구).
 *
 *   node scripts/cdp-watch.mjs <포트> [초]
 *
 * ★★ 왜 필요한가. logcat 의 `Capacitor/Console` 은 메시지 한 줄만 준다 —
 *   "Cannot read properties of null (reading 'style')" 만 보고는 어디인지 알 수 없다.
 *   그리고 페이지 안에 addEventListener('error') 를 심는 방법은 **심기 전에 난 것**을
 *   놓친다. 부팅 중에 나는 오류가 정확히 그 종류다.
 *
 *   CDP 의 Runtime.exceptionThrown 은 붙는 즉시부터 들어오고 스택을 함께 준다.
 *
 * ★ 앱 코드는 이걸 부르지 않는다. 쓰기 전에 adb forward 를 걸어 둘 것.
 */
const port = process.argv[2];
const seconds = Number(process.argv[3] ?? 20);
if (!port) {
    console.error('사용: node scripts/cdp-watch.mjs <포트> [초]');
    process.exit(1);
}

const targets = await (await fetch(`http://localhost:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) {
    console.error('페이지 타깃을 찾지 못했습니다. adb forward 가 걸려 있는지 확인하세요.');
    process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let n = 0;

const 자리 = (frame) =>
    frame ? `${frame.url || '(모름)'}:${frame.lineNumber + 1}:${frame.columnNumber + 1}` : '(모름)';

ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
    ws.send(JSON.stringify({ id: 2, method: 'Log.enable' }));
});

ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);

    if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        n++;
        console.log(`\n── 예외 #${n}: ${d.exception?.description ?? d.text}`);
        console.log(`   자리: ${자리(d)}`);
        for (const f of d.stackTrace?.callFrames?.slice(0, 8) ?? []) {
            console.log(`     ${f.functionName || '(익명)'} @ ${자리(f)}`);
        }
        if (!d.stackTrace) console.log('     (스택 없음 — 대개 리스너 안에서 난 것이다)');
    }

    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        const en = msg.params.entry;
        n++;
        console.log(`\n── 로그 오류 #${n}: ${en.text}`);
        console.log(`   자리: ${en.url ?? '(모름)'}:${en.lineNumber ?? '?'}`);
        for (const f of en.stackTrace?.callFrames?.slice(0, 8) ?? []) {
            console.log(`     ${f.functionName || '(익명)'} @ ${자리(f)}`);
        }
    }
});

setTimeout(() => {
    console.log(n === 0 ? '\n(그 사이에 아무 예외도 없었다)' : `\n합계 ${n}건`);
    ws.close();
    process.exit(0);
}, seconds * 1000);
