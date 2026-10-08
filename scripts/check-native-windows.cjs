'use strict';

/**
 * 네이티브 뷰어의 창 수명 · 입력 점검 — `node scripts/check-native-windows.cjs` (release 빌드 + scripts/px-probe 필요)
 *
 * 읽기만 하는 문서는 WebView2 없이 네이티브 창(클래스 'MarkletView')이 끝까지 보여 준다. 여기서는 그 창들이 제대로 뜨고 · 닫히고 · 입력을 받고 ·
 * 웹 창으로 넘어가는지를 **진짜 실행과 진짜 입력(SendInput)** 으로 본다. 입력은 px-probe 의 PX_ACT, 창 목록 · 닫기는 PX_LIST · PX_CLOSE_ONE.
 * 웹 창의 수명은 check-tauri-windows.cjs(MARKLET_NATIVE=0)가 본다. 실패가 하나라도 있으면 종료 코드 1.
 *
 * ★ 입력을 쓰는 점검은 화면을 잠깐 점유한다(창이 앞으로 나오고 마우스가 움직인다). 점검하는 동안 건드리지 않는 것이 좋다.
 * ★ 설정은 임시 폴더(MARKLET_DATA_DIR)에 쓴다 — 이 PC 의 진짜 설정은 건드리지 않는다. 떠 있는 진짜 Marklet 은 점검 전에 끝낼 것.
 */
const { spawn, spawnSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'src-tauri', 'target', 'release', 'Marklet.exe');
const PROBE = path.join(__dirname, 'px-probe', 'target', 'release', 'px-probe.exe');
for (const f of [EXE, PROBE]) {
    if (!fs.existsSync(f)) {
        console.error(`없다: ${f}`);
        process.exit(2);
    }
}
const STATE_DIR = require('./lib/profile.cjs').isolate('mk-native-data').dir;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-native-'));
const doc = (name, body) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, body);
    return p;
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const list = (pid) => String(spawnSync(PROBE, [], { encoding: 'utf8', env: { ...process.env, PX_LIST: String(pid) } }).stdout).trim().split('\n').filter(Boolean);
const views = (pid) => list(pid).filter((x) => x.startsWith('MarkletView'));
const webs = (pid) => list(pid).filter((x) => x.startsWith('Tauri Window'));
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
    sleep(500);
};
const closeOne = (pid, cls) => spawnSync(PROBE, [], { env: { ...process.env, PX_CLOSE_ONE: String(pid), ...(cls ? { PX_CLASS: cls } : {}) } });
/** 진짜 입력을 넣고 `이름=값` 줄을 객체로 돌려준다(같은 이름이 여럿이면 배열) */
const act = (pid, script) => {
    const out = String(spawnSync(PROBE, [], { encoding: 'utf8', env: { ...process.env, PX_ACT: String(pid), PX_SCRIPT: script, PX_OUT: tmp } }).stdout);
    const res = {};
    for (const line of out.split('\n')) {
        const i = line.indexOf('=');
        if (i < 0) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).replace(/\r$/, '');
        (res[k] ??= []).push(v);
    }
    return res;
};
const webviewProcs = (pid) =>
    Number(
        String(
            spawnSync(
                'powershell',
                [
                    '-NoProfile',
                    '-Command',
                    `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name; function kids($p){ $all | Where-Object { $_.ParentProcessId -eq $p } | ForEach-Object { $_; kids $_.ProcessId } }; @(kids ${pid} | Where-Object { $_.Name -like 'msedgewebview2*' }).Count`,
                ],
                { encoding: 'utf8' },
            ).stdout,
        ).trim() || 0,
    );
const workingSetMB = (pid) =>
    Number(String(spawnSync('powershell', ['-NoProfile', '-Command', `[int](Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64/1MB`], { encoding: 'utf8' }).stdout).trim() || 0);
const freshState = (json) => {
    fs.rmSync(path.join(STATE_DIR, 'state.json'), { force: true });
    if (json) fs.writeFileSync(path.join(STATE_DIR, 'state.json'), JSON.stringify(json));
};
const readState = () => {
    try {
        return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'state.json'), 'utf8'));
    } catch {
        return {};
    }
};
const launch = (args, env) => {
    const p = spawn(EXE, args, { stdio: 'ignore', env: { ...process.env, MARKLET_NATIVE: '1', ...(env || {}) } });
    return p;
};
const waitFor = (fn, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (fn()) return true;
        sleep(50);
    }
    return fn();
};
let failed = 0;
const check = (name, ok, detail) => {
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

const docs = ['a', 'b', 'c'].map((n) => doc(`${n}.md`, `# 문서 ${n}\n\n본문입니다.\n\n- 하나\n- 둘\n\n[다른 문서](b.md)\n`));
const mathDoc = doc('math.md', '# 수식\n\n본문 $E = mc^2$ 입니다.\n\n$$\\frac{a}{b}$$\n');
const txt = doc('t.txt', Array.from({ length: 40 }, (_, i) => `줄 ${i + 1}: 서식 없이 보이는 글입니다. abc def`).join('\n'));

// 1. 문서 셋을 잇달아 연다 — 셋 다 네이티브 창, WebView2 는 하나도 없다
{
    freshState();
    const first = launch([docs[0]]);
    sleep(1500);
    spawnSync(EXE, [docs[1]], { env: { ...process.env, MARKLET_NATIVE: '1' } });
    sleep(900);
    spawnSync(EXE, [docs[2]], { env: { ...process.env, MARKLET_NATIVE: '1' } });
    sleep(900);
    const v = views(first.pid).length;
    const w = webs(first.pid).length + previews(first.pid).length;
    const procs = webviewProcs(first.pid);
    check('1 잇달아 연 문서 셋이 네이티브 창으로 뜬다', v === 3 && w === 0, `네이티브 ${v} · 웹/미리보기 ${w}`);
    check('1b WebView2 프로세스가 하나도 없다', procs === 0, `${procs}개`);
    // 2. 하나를 닫으면 나머지는 산다
    closeOne(first.pid);
    sleep(700);
    check('2 하나를 닫으면 나머지 둘과 앱은 산다', alive(first.pid) && views(first.pid).length === 2, `${views(first.pid).length}개`);
    // 3. 다 닫으면 앱이 끝난다
    closeOne(first.pid);
    sleep(500);
    closeOne(first.pid);
    check('3 마지막 창을 닫으면 앱이 끝난다', waitFor(() => !alive(first.pid), 3000));
    kill(first.pid);
}
// 4. .txt 도 네이티브로 보인다(서식 없이)
{
    freshState();
    const p = launch([txt]);
    const ok = waitFor(() => views(p.pid).length === 1, 3000);
    sleep(500);
    const r = act(p.pid, 'clearclip;chord:ctrl+a;chord:ctrl+c;clip');
    const clip = (r.clip?.[0] ?? '').replace(/\\n/g, '\n');
    check('4 .txt 가 네이티브 창에 원문으로 보이고 전체 복사가 된다', ok && clip.startsWith('줄 1: 서식 없이') && clip.includes('줄 40:') && webviewProcs(p.pid) === 0, `${clip.split('\n').length}줄`);
    kill(p.pid);
}
// 5. 수식이 있는 문서는 웹 창으로 간다(미리보기 → 웹)
{
    freshState();
    const p = launch([mathDoc]);
    sleep(3500);
    check('5 수식 문서는 웹 창이 그린다(미리보기는 걷혔다)', webs(p.pid).length === 1 && views(p.pid).length === 0 && previews(p.pid).length === 0 && webviewProcs(p.pid) > 0, `웹 ${webs(p.pid).length} · 네이티브 ${views(p.pid).length} · 미리보기 ${previews(p.pid).length}`);
    kill(p.pid);
}
// 6. 네이티브 창과 웹 창이 같이 떠 있어도 서로 상관없이 닫힌다
{
    freshState();
    const p = launch([docs[0]]);
    sleep(1500);
    spawnSync(EXE, [mathDoc], { env: { ...process.env, MARKLET_NATIVE: '1' } });
    sleep(3500);
    const both = views(p.pid).length === 1 && webs(p.pid).length === 1;
    closeOne(p.pid, 'Tauri Window');
    sleep(900);
    const afterWeb = alive(p.pid) && views(p.pid).length === 1;
    closeOne(p.pid, 'MarkletView');
    check('6 네이티브 + 웹을 같이 띄우고 웹을 닫아도 네이티브는 산다, 마지막을 닫으면 끝난다', both && afterWeb && waitFor(() => !alive(p.pid), 3000), `같이 ${both} · 웹 닫은 뒤 ${afterWeb}`);
    kill(p.pid);
}
// 7. Ctrl+E — 네이티브 창이 웹 창(편집)으로 넘어간다
{
    freshState();
    const p = launch([docs[0]]);
    waitFor(() => views(p.pid).length === 1);
    sleep(500);
    act(p.pid, 'chord:ctrl+e');
    const ok = waitFor(() => webs(p.pid).length === 1 && views(p.pid).length === 0 && previews(p.pid).length === 0, 6000);
    check('7 Ctrl+E 로 네이티브 창이 웹(편집) 창으로 바뀐다', ok && alive(p.pid), `웹 ${webs(p.pid).length} · 네이티브 ${views(p.pid).length}`);
    kill(p.pid);
}
// 8. 다른 곳에서 파일이 바뀌면 따라 바뀐다
{
    freshState();
    const f = doc('live.md', '# 처음\n\nalpha 문장입니다.\n');
    const p = launch([f]);
    waitFor(() => views(p.pid).length === 1);
    sleep(600);
    fs.writeFileSync(f, '# 바뀜\n\nbeta 문장입니다.\n');
    sleep(1500);
    const r = act(p.pid, 'clearclip;chord:ctrl+a;chord:ctrl+c;clip');
    const clip = r.clip?.[0] ?? '';
    check('8 파일이 바뀌면 창이 다시 읽는다', clip.includes('beta') && !clip.includes('alpha'), clip.slice(0, 40));
    kill(p.pid);
}
// 9. 문서 안의 상대 링크(다른 .md)는 같은 창에 연다
{
    freshState();
    const b = doc('b2.md', '# 둘째 문서\n\n링크 대상입니다.\n');
    const a = doc('a2.md', '[둘째로 가기](b2.md)\n');
    const p = launch([a]);
    waitFor(() => views(p.pid).length === 1);
    sleep(600);
    const info = act(p.pid, 'rect');
    const m = /client=(\d+)x(\d+)/.exec(info.rect?.[0] ?? '');
    const scale = m ? Number(m[1]) / 980 : 1.5;
    // 첫 글줄: 위 여백 40px + 줄 높이의 절반, 본문 칸 왼쪽 끝에서 조금 안쪽
    const x = Math.round(((980 - 10 - 736) / 2 + 32 + 20) * scale);
    const y = Math.round((40 + 14) * scale);
    act(p.pid, `click:${x},${y}`);
    sleep(900);
    const t = act(p.pid, 'title').title?.[0] ?? '';
    check('9 상대 링크를 누르면 같은 창에 그 문서가 열린다', t === 'b2.md' && views(p.pid).length === 1, `제목 ${t}`);
    kill(p.pid);
}
// 10. 전체 선택 + 복사
{
    freshState();
    const f = doc('copy.md', '# 제목\n\n첫 문단입니다.\n\n- 하나\n- 둘\n\n| a | b |\n| - | - |\n| 1 | 2 |\n');
    const p = launch([f]);
    waitFor(() => views(p.pid).length === 1);
    sleep(600);
    const clip = (act(p.pid, 'clearclip;chord:ctrl+a;chord:ctrl+c;clip').clip?.[0] ?? '').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    check('10 Ctrl+A · Ctrl+C 가 문서의 글을 순서대로 복사한다(표는 탭 · 줄바꿈)', clip.startsWith('제목\n\n첫 문단입니다.\n\n하나\n둘') && clip.includes('a\tb\n1\t2'), JSON.stringify(clip.slice(0, 50)));
    kill(p.pid);
}
// 11. 문서 크기 한도: 700KB 는 네이티브, 900KB 는 웹
{
    freshState();
    const para = '이것은 한 문단입니다. 마크다운 뷰어의 큰 문서 점검을 위한 글이며 여러 번 되풀이됩니다. ';
    // 한글은 글자당 3바이트다 — 바이트 수로 채운다
    const big = (kb) => {
        const parts = [];
        let bytes = 0;
        for (let i = 0; bytes < kb * 1024; i++) {
            const part = `## 절 ${i}\n\n${para}\n`;
            parts.push(part);
            bytes += Buffer.byteLength(part) + 1;
        }
        return parts.join('\n');
    };
    const f700 = doc('big700.md', big(700));
    const p = launch([f700]);
    const ok700 = waitFor(() => views(p.pid).length === 1, 5000);
    const mem = workingSetMB(p.pid);
    kill(p.pid);
    freshState();
    const f900 = doc('big900.md', big(900));
    const q = launch([f900]);
    sleep(4500);
    const web900 = webs(q.pid).length === 1 && views(q.pid).length === 0;
    kill(q.pid);
    check('11 700KB 문서는 네이티브로, 900KB 문서는 웹으로', ok700 && web900, `700KB → 네이티브 ${ok700}(작업 집합 ${mem}MB) · 900KB → 웹 ${web900}`);
}
// 12. 어두운 테마 설정
{
    freshState({ theme: 'dark' });
    const p = launch([docs[0]]);
    waitFor(() => views(p.pid).length === 1);
    sleep(700);
    act(p.pid, 'shot:dark');
    const bmp = fs.readFileSync(path.join(tmp, 'dark.bmp'));
    // 가운데 한 점의 밝기(본문 바탕): 어두운 테마 #16181c
    const w = bmp.readInt32LE(18);
    const h = Math.abs(bmp.readInt32LE(22));
    const off = bmp.readUInt32LE(10);
    const px = (x, y) => {
        const i = off + (y * w + x) * 4;
        return (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3;
    };
    const luma = px(Math.floor(w / 2), Math.floor(h * 0.8));
    check('12 설정이 어두우면 창이 어둡게 그려진다', luma < 60, `바탕 밝기 ${luma.toFixed(0)}`);
    kill(p.pid);
}
// 13. 확대는 모든 창에 적용되고 저장된다
{
    freshState();
    const p = launch([docs[0]]);
    waitFor(() => views(p.pid).length === 1);
    sleep(600);
    act(p.pid, 'chord:ctrl+plus;wait:400');
    const z1 = readState().zoom;
    act(p.pid, 'chord:ctrl+0;wait:400');
    const z2 = readState().zoom;
    check('13 Ctrl++ 로 확대하고 Ctrl+0 으로 되돌린다(설정에 저장)', z1 > 1 && z2 === 1, `확대 ${z1} → ${z2}`);
    kill(p.pid);
}
// 14. Alt 로 메뉴 막대가 나왔다 들어간다
{
    freshState();
    const p = launch([docs[0]]);
    waitFor(() => views(p.pid).length === 1);
    sleep(600);
    const h0 = Number(/client=\d+x(\d+)/.exec(act(p.pid, 'rect').rect?.[0] ?? '')?.[1]);
    const h1 = Number(/client=\d+x(\d+)/.exec(act(p.pid, 'key:alt;wait:400;rect').rect?.[0] ?? '')?.[1]);
    const h2 = Number(/client=\d+x(\d+)/.exec(act(p.pid, 'key:alt;wait:400;rect').rect?.[0] ?? '')?.[1]);
    check('14 Alt 를 누르면 메뉴 막대가 나오고 다시 누르면 들어간다', h1 < h0 && h2 === h0, `클라이언트 높이 ${h0} → ${h1} → ${h2}`);
    kill(p.pid);
}
// 15. Ctrl+W 는 그 창만, Ctrl+Q 는 모두 닫는다
{
    freshState();
    const p = launch([docs[0]]);
    sleep(1500);
    spawnSync(EXE, [docs[1]], { env: { ...process.env, MARKLET_NATIVE: '1' } });
    sleep(900);
    act(p.pid, 'chord:ctrl+w;wait:500');
    const one = alive(p.pid) && views(p.pid).length === 1;
    act(p.pid, 'chord:ctrl+q;wait:500');
    check('15 Ctrl+W 는 그 창만, Ctrl+Q 는 앱을 끝낸다', one && waitFor(() => !alive(p.pid), 3000), `Ctrl+W 뒤 ${one ? '1개' : '?'}`);
    kill(p.pid);
}
// 16. 미리 켠 앱(--background): 네이티브 문서는 WebView2 없이 뜨고, 닫아도 앱은 산다
{
    freshState();
    const p = spawn(EXE, ['--background'], { stdio: 'ignore', env: { ...process.env, MARKLET_NATIVE: '1', MARKLET_BACKGROUND_DELAY_MS: '0' } });
    sleep(2500);
    spawnSync(EXE, [docs[0]], { env: { ...process.env, MARKLET_NATIVE: '1' } });
    sleep(900);
    const opened = views(p.pid).length === 1;
    const procs = webviewProcs(p.pid);
    closeOne(p.pid);
    sleep(900);
    check('16 미리 켠 앱: 네이티브 문서는 WebView2 없이 뜨고, 닫아도 앱은 산다', opened && procs === 0 && alive(p.pid), `창 ${opened} · WebView2 ${procs}개 · 닫은 뒤 생존 ${alive(p.pid)}`);
    spawnSync(EXE, ['--quit-warm'], { env: { ...process.env } });
    kill(p.pid);
}
// 17. 네이티브 끄기: 설정(nativeView:false)이면 읽기만 하는 문서도 웹 창이다
{
    freshState({ nativeView: false });
    const p = launch([docs[0]]);
    sleep(3500);
    check('17 설정에서 빠른 보기를 끄면 웹 창이 그린다', webs(p.pid).length === 1 && views(p.pid).length === 0, `웹 ${webs(p.pid).length} · 네이티브 ${views(p.pid).length}`);
    kill(p.pid);
}
// 18. 메모리: 문서 하나를 연 네이티브 앱의 작업 집합
{
    freshState();
    const p = launch([docs[0]]);
    waitFor(() => views(p.pid).length === 1);
    sleep(1500);
    const mem = workingSetMB(p.pid);
    check('18 네이티브 뷰어 한 창의 메모리(작업 집합)가 150MB 아래다', mem > 0 && mem < 150, `${mem}MB`);
    kill(p.pid);
}

// 19. 뷰어에서 연 링크가 수식 문서이면 같은 창이 웹 창으로 넘어간다
{
    freshState();
    const m = doc('m3.md', '# 수식 문서\n\n$$x^2$$\n');
    const a = doc('a3.md', '[수식으로 가기](m3.md)\n');
    const p = launch([a]);
    waitFor(() => views(p.pid).length === 1);
    sleep(600);
    const info = act(p.pid, 'rect');
    const mm = /client=(\d+)x(\d+)/.exec(info.rect?.[0] ?? '');
    const scale = mm ? Number(mm[1]) / 980 : 1.5;
    const x = Math.round(((980 - 10 - 736) / 2 + 32 + 20) * scale);
    const y = Math.round((40 + 14) * scale);
    act(p.pid, `click:${x},${y}`);
    const ok = waitFor(() => webs(p.pid).length === 1 && views(p.pid).length === 0 && previews(p.pid).length === 0, 6000);
    const title = (webs(p.pid)[0] ?? '').split(' | ')[1] ?? '';
    check('19 수식 문서로 가는 링크를 누르면 웹 창으로 넘어간다', ok && title === 'm3.md', `웹 ${webs(p.pid).length} · 제목 ${title}`);
    kill(p.pid);
}
// 20. 닫을 때 창 크기 · 자리를 저장한다
{
    freshState();
    const p = launch([docs[0]]);
    waitFor(() => views(p.pid).length === 1);
    sleep(600);
    act(p.pid, 'chord:ctrl+w');
    waitFor(() => !alive(p.pid), 3000);
    const b = readState().bounds;
    check('20 창을 닫으면 크기와 자리가 저장된다', !!b && Math.abs(b.width - 980) < 4 && Math.abs(b.height - 900) < 4 && Number.isFinite(b.x), JSON.stringify(b));
    kill(p.pid);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
process.exit(failed ? 1 : 0);
