/**
 * 실기기/에뮬레이터 웹뷰에 붙어 표현식 하나를 평가한다 (12-3절 검증용 보조 도구).
 *
 * ★ 이건 진단 도구다. 앱 코드가 이걸 부르는 일은 없다.
 *   쓰기 전에 `adb forward tcp:<PORT> localabstract:webview_devtools_remote_<PID>` 를 걸어 둘 것.
 *
 *   사용: node scripts/cdp-eval.mjs <포트> "<자바스크립트 표현식>"
 */
const [port, expression] = process.argv.slice(2);
if (!port || !expression) {
    console.error('사용: node scripts/cdp-eval.mjs <포트> "<표현식>"');
    process.exit(1);
}

const targets = await (await fetch(`http://localhost:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) {
    console.error('페이지 타깃을 찾지 못했습니다. adb forward 가 걸려 있는지 확인하세요.');
    process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
ws.addEventListener('open', () => {
    ws.send(
        JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            // ★ awaitPromise + returnByValue 가 있어야 async 함수의 결과를 값으로 받는다.
            params: { expression, awaitPromise: true, returnByValue: true },
        }),
    );
});
ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id !== 1) return;
    const r = msg.result;
    if (r.exceptionDetails) console.error('예외:', r.exceptionDetails.text, r.result?.description);
    else console.log(JSON.stringify(r.result.value, null, 2));
    ws.close();
    process.exit(0);
});
ws.addEventListener('error', (e) => {
    console.error('연결 실패:', e.message ?? e);
    process.exit(1);
});
