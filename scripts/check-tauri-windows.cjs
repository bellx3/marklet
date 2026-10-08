'use strict';

/**
 * Tauri 판의 창 수명 점검 — `node scripts/check-tauri-windows.cjs` (release 빌드 + scripts/px-probe 필요)
 *
 * 창을 여럿 열고 · 미리보기를 일찍 닫고 · 문서 없이 켜는 경우에 창이 제대로 뜨고 사라지는지를 실제 실행으로 본다.
 * 창 목록 · 미리보기 닫기는 px-probe 의 PX_LIST · PX_CLOSE_PREVIEW 가 한다. 실패가 하나라도 있으면 종료 코드 1.
 * 설정은 임시 폴더(MARKLET_DATA_DIR)에 쓴다 — 이 PC 의 진짜 설정은 건드리지 않는다. 떠 있는 진짜 Marklet 은 점검 전에 끝낼 것.
 */
// 이 점검은 **웹(WebView2) 창의 수명**을 본다. 네이티브 뷰어는 읽기만 하는 문서를 WebView2 없이 보여 주므로 끈다 — 네이티브 쪽은 check-native-windows.cjs 가 본다.
process.env.MARKLET_NATIVE = process.env.MARKLET_NATIVE ?? '0';
const { spawn, spawnSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ★ 첫 시나리오부터 임시 프로필을 쓴다(앱을 띄우기 전에 환경을 정해야 자식 프로세스가 물려받는다)
const profile = require('./lib/profile.cjs').isolate('mk-windows-data');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'src-tauri', 'target', 'release', 'Marklet.exe');
const PROBE = path.join(__dirname, 'px-probe', 'target', 'release', 'px-probe.exe');
for (const f of [EXE, PROBE]) {
    if (!fs.existsSync(f)) {
        console.error(`없다: ${f}`);
        process.exit(2);
    }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-windows-'));
const doc = (name, body) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, body);
    return p;
};
const docs = ['a', 'b', 'c', 'd', 'e'].map((n) => doc(`${n}.md`, `# 문서 ${n}\n\n본문입니다.\n\n- 하나\n- 둘\n`));
const txt = doc('t.txt', Array.from({ length: 80 }, (_, i) => `줄 ${i + 1}: 서식 없이 보이는 글입니다. abc def`).join('\n'));

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const list = (pid) => String(spawnSync(PROBE, [], { encoding: 'utf8', env: { ...process.env, PX_LIST: String(pid) } }).stdout).trim().split('\n').filter(Boolean);
const real = (pid) => list(pid).filter((x) => x.startsWith('Tauri Window'));
const previews = (pid) => list(pid).filter((x) => x.startsWith('MarkletPreview'));
const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};
const kill = (pid) => {
    try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } catch {
        /* */
    }
    sleep(600);
};
const closeWindow = (pid) => spawnSync(PROBE, [], { env: { ...process.env, PX_CLOSE_WINDOW: String(pid) } });
const closePreviewWhenSeen = (pid) => {
    for (let i = 0; i < 400; i++) {
        if (previews(pid).length) {
            spawnSync(PROBE, [], { env: { ...process.env, PX_CLOSE_PREVIEW: String(pid) } });
            return true;
        }
        sleep(5);
    }
    return false;
};
let failed = 0;
const check = (name, ok, detail) => {
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

// A. 문서 셋을 잇달아 연다
{
    const first = spawn(EXE, [docs[0]], { stdio: 'ignore' });
    sleep(2500);
    spawnSync(EXE, [docs[1]]);
    sleep(1800);
    spawnSync(EXE, [docs[2]]);
    sleep(1800);
    check('A 잇달아 연 문서 셋이 다 뜬다', real(first.pid).length === 3 && previews(first.pid).length === 0, real(first.pid).length + '개');
    kill(first.pid);
}
// B. 둘째 창의 미리보기를 일찍 닫으면 그 문서의 창만 닫힌다
{
    const first = spawn(EXE, [docs[0]], { stdio: 'ignore' });
    sleep(2500);
    const before = real(first.pid).length;
    spawn(EXE, [docs[1]], { stdio: 'ignore' });
    const closed = closePreviewWhenSeen(first.pid);
    sleep(2500);
    check('B 둘째 미리보기를 닫으면 그 창만 닫히고 앱은 산다', closed && alive(first.pid) && real(first.pid).length === before && previews(first.pid).length === 0, `${before} → ${real(first.pid).length}`);
    kill(first.pid);
}
// C. .txt 는 미리보기가 없다 — 곧 보여야 한다(렌더러가 그린 뒤)
{
    const first = spawn(EXE, [docs[0]], { stdio: 'ignore' });
    sleep(2500);
    const t0 = Date.now();
    spawn(EXE, [txt], { stdio: 'ignore' });
    let seen = -1;
    for (let i = 0; i < 300 && seen < 0; i++) {
        if (real(first.pid).length >= 2) seen = Date.now() - t0;
        else sleep(10);
    }
    check('C .txt 창이 1.5초 안에 뜬다', seen > 0 && seen < 1500, `${seen} ms`);
    kill(first.pid);
}
// D. 첫 창의 미리보기를 닫으면 앱이 끝난다
{
    const p = spawn(EXE, [docs[0]], { stdio: 'ignore' });
    const closed = closePreviewWhenSeen(p.pid);
    sleep(1500);
    check('D 첫 미리보기를 닫으면 앱이 끝난다', closed && !alive(p.pid));
    kill(p.pid);
}
// E. 문서 없이 켠다
{
    const p = spawn(EXE, [], { stdio: 'ignore' });
    const t0 = Date.now();
    let seen = -1;
    for (let i = 0; i < 300 && seen < 0; i++) {
        if (real(p.pid).length) seen = Date.now() - t0;
        else sleep(10);
    }
    check('E 문서 없이 켜면 창이 1.5초 안에 뜬다', seen > 0 && seen < 1500, `${seen} ms`);
    kill(p.pid);
}
// F. 한 번에 문서 셋을 넘겨 켠다(탐색기에서 여러 개를 끌어다 exe 에 놓는 경우)
{
    const p = spawn(EXE, docs.slice(0, 3), { stdio: 'ignore' });
    sleep(5000);
    check('F 한 번에 넘긴 문서 셋이 다 뜬다', real(p.pid).length === 3 && previews(p.pid).length === 0, real(p.pid).length + '개');
    kill(p.pid);
}
// G. 앱이 떠 있을 때 문서 넷이 한꺼번에 들어온다(탐색기에서 여러 개를 골라 열기)
{
    const first = spawn(EXE, [docs[0]], { stdio: 'ignore' });
    sleep(2500);
    for (const d of docs.slice(1)) spawn(EXE, [d], { stdio: 'ignore' });
    sleep(6000);
    check('G 한꺼번에 들어온 문서 넷이 다 뜬다', real(first.pid).length === 5 && previews(first.pid).length === 0, real(first.pid).length + '개');
    kill(first.pid);
}

// ── 빠른 시작: 마지막 창을 닫아도 앱이 잠시 살아 있다가 다음 문서를 부팅 없이 띄운다 ──
const stateDir = profile.dir;
const stateFile = path.join(stateDir, 'state.json');
const setState = (obj) => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(obj));
};
const warmEnv = (secs) => ({ ...process.env, MARKLET_WARM_SECONDS: String(secs) });
// H. 닫았다 열기를 되풀이한다 — 닫아도 살아 있고 창은 안 보이며, 다음 문서가 그 창에 뜬다
{
    setState({ keepWarm: true });
    const first = spawn(EXE, [docs[0]], { stdio: 'ignore', env: warmEnv(60) });
    sleep(2500);
    let ok = true;
    const notes = [];
    for (let i = 1; i <= 3 && ok; i++) {
        closeWindow(first.pid);
        sleep(1000);
        const hidden = alive(first.pid) && list(first.pid).filter((x) => /^(Tauri Window|MarkletPreview)/.test(x)).length === 0;
        spawn(EXE, [docs[i]], { stdio: 'ignore' });
        let titled = false;
        for (let k = 0; k < 300 && !titled; k++) {
            titled = real(first.pid).some((x) => x.includes(`| ${path.basename(docs[i])} |`));
            if (!titled) sleep(10);
        }
        sleep(400);
        ok = hidden && titled && real(first.pid).length === 1 && previews(first.pid).length === 0;
        notes.push(`${i}: 숨김 ${hidden} · 새 문서 ${titled}`);
    }
    check('H 닫았다 열기를 3번 되풀이해도 그 창이 다시 쓰인다', ok, notes.join(' / '));
    kill(first.pid);
}
// I. 기다리는 시간이 지나면 앱이 끝난다
{
    setState({ keepWarm: true });
    const p = spawn(EXE, [docs[0]], { stdio: 'ignore', env: warmEnv(2) });
    sleep(2500);
    closeWindow(p.pid);
    sleep(1000);
    const aliveEarly = alive(p.pid);
    sleep(3500);
    check('I 기다리는 시간(2초)이 지나면 앱이 끝난다', aliveEarly && !alive(p.pid), `1초 뒤 생존 ${aliveEarly} · 4.5초 뒤 생존 ${alive(p.pid)}`);
    kill(p.pid);
}
// J. --quit-warm: 숨겨 두고 기다리는 중이면 끝내고, 창이 떠 있으면 건드리지 않는다
{
    setState({ keepWarm: true });
    const p = spawn(EXE, [docs[0]], { stdio: 'ignore', env: warmEnv(60) });
    sleep(2500);
    spawnSync(EXE, ['--quit-warm']);
    sleep(800);
    const keptWithWindow = alive(p.pid) && real(p.pid).length === 1;
    closeWindow(p.pid);
    sleep(1000);
    const warm = alive(p.pid);
    spawnSync(EXE, ['--quit-warm']);
    sleep(1500);
    check('J --quit-warm: 창이 떠 있으면 그대로, 숨겨 둔 중이면 끝', keptWithWindow && warm && !alive(p.pid), `창 있을 때 생존 ${keptWithWindow} · 숨김 중 ${warm} · 명령 뒤 생존 ${alive(p.pid)}`);
    kill(p.pid);
}
// K. 설정에서 끄면 닫을 때 앱이 끝난다
{
    setState({ keepWarm: false });
    const p = spawn(EXE, [docs[0]], { stdio: 'ignore', env: warmEnv(60) });
    sleep(2500);
    closeWindow(p.pid);
    sleep(1500);
    check('K 빠른 시작을 끄면 마지막 창을 닫을 때 앱이 끝난다', !alive(p.pid));
    kill(p.pid);
}
// L. 숨겨 둔 채 기다리는 앱을 문서 없이 다시 켜면 빈 창이 뜬다
{
    setState({ keepWarm: true });
    const first = spawn(EXE, [docs[0]], { stdio: 'ignore', env: warmEnv(60) });
    sleep(2500);
    closeWindow(first.pid);
    sleep(1000);
    spawn(EXE, [], { stdio: 'ignore' });
    let seen = false;
    for (let k = 0; k < 300 && !seen; k++) {
        seen = real(first.pid).length === 1;
        if (!seen) sleep(10);
    }
    check('L 문서 없이 다시 켜면 숨겨 둔 창이 빈 창으로 뜬다', seen && alive(first.pid));
    kill(first.pid);
}
// M. 끝내기(Ctrl+Q): 빠른 시작이 켜져 있어도 마지막 창을 숨기지 않고 앱이 끝난다 — 렌더러가 보내는 명령을 CDP 로 직접 부른다
{
    setState({ keepWarm: true });
    const port = 12950;
    const p = spawn(EXE, [docs[0]], { stdio: 'ignore', env: { ...warmEnv(60), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } });
    sleep(3000);
    // 셸을 거치지 않고 node 에 코드를 직접 넘긴다(따옴표가 깨지지 않게).
    const code = `(async () => {
        const l = await (await fetch('http://127.0.0.1:${port}/json')).json();
        const t = l.find((x) => x.type === 'page' && x.url.includes('tauri.localhost'));
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r) => (ws.onopen = r));
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: "window.__TAURI__.core.invoke('run', { name: 'quit' })" } }));
        await new Promise((r) => setTimeout(r, 300));
        console.log('sent');
        process.exit(0);
    })()`;
    const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 8000 });
    const sent = String(r.stdout).includes('sent');
    sleep(1800);
    check('M 끝내기를 누르면 빠른 시작이 켜져 있어도 앱이 끝난다', sent && !alive(p.pid), `명령 보냄 ${sent} · 생존 ${alive(p.pid)}`);
    kill(p.pid);
}
// N. 로그인 때 미리 켜는 모드(--background): 창 없이 떠서 숨겨 두고, 대기 시간이 지나도 끝나지 않으며, 문서를 주면 그 창이 받는다
{
    setState({ keepWarm: true });
    const bgEnv = { ...warmEnv(2), MARKLET_BACKGROUND_DELAY_MS: '0' };
    const p = spawn(EXE, ['--background'], { stdio: 'ignore', env: bgEnv });
    sleep(4000);
    const quiet = alive(p.pid) && list(p.pid).filter((x) => /^(Tauri Window|MarkletPreview)/.test(x)).length === 0;
    spawn(EXE, [docs[1]], { stdio: 'ignore' });
    let titled = false;
    for (let k = 0; k < 300 && !titled; k++) {
        titled = real(p.pid).some((x) => x.includes(`| ${path.basename(docs[1])} |`));
        if (!titled) sleep(10);
    }
    sleep(500);
    closeWindow(p.pid);
    sleep(4500); // 대기 시간(2초)보다 길게
    const stillResident = alive(p.pid);
    spawn(EXE, ['--background'], { stdio: 'ignore' }); // 이미 떠 있는 앱에 또 오면 아무 일도 없다
    sleep(1200);
    const noWindow = list(p.pid).filter((x) => /^(Tauri Window|MarkletPreview)/.test(x)).length === 0;
    spawnSync(EXE, ['--quit-warm']);
    sleep(1500);
    check('N --background: 창 없이 대기 · 문서를 받음 · 대기 시간이 지나도 안 끝남 · --quit-warm 으로 끝', quiet && titled && stillResident && noWindow && !alive(p.pid), `조용히 대기 ${quiet} · 문서 받음 ${titled} · 닫은 뒤 생존 ${stillResident} · 또 와도 무반응 ${noWindow} · 끝냄 ${!alive(p.pid)}`);
    kill(p.pid);
}
// O. 미리 켠 앱(--background)은 숨겨 둔 창을 쓰고 나면 다음 것을 만들어 둔다 — 문서를 연달아 열어도 매번 숨겨 둔 창이 쓰인다
{
    setState({ keepWarm: true });
    const traceFile = path.join(tmp, 'resident-trace.txt');
    const p = spawn(EXE, ['--background'], { stdio: 'ignore', env: { ...warmEnv(60), MARKLET_BACKGROUND_DELAY_MS: '0', MARKLET_TRACE: traceFile } });
    sleep(3500);
    spawn(EXE, [docs[0]], { stdio: 'ignore' });
    sleep(4000); // 첫 문서가 뜨고, 다음 숨겨 둔 창이 만들어질 시간
    spawn(EXE, [docs[1]], { stdio: 'ignore' });
    let titled = false;
    for (let k = 0; k < 300 && !titled; k++) {
        titled = real(p.pid).some((x) => x.includes(`| ${path.basename(docs[1])} |`));
        if (!titled) sleep(10);
    }
    sleep(500);
    const marks = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8') : '';
    const reuses = (marks.match(/warm-reuse/g) || []).length;
    check('O 미리 켠 앱: 연달아 연 두 문서가 모두 숨겨 둔 창을 쓴다', titled && reuses >= 2 && real(p.pid).length === 2, `창 ${real(p.pid).length}개 · 재사용 ${reuses}번`);
    kill(p.pid);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
process.exit(failed ? 1 : 0);
