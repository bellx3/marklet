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
    // 실패하면 무슨 창이 남았는지 · 어디를 눌렀는지를 같이 남긴다(드물게 입력이 안 먹는 일이 있어서 원인을 가리려는 것)
    const why = ok && title === 'm3.md' ? '' : ` · 클릭 ${x},${y} (배율 ${scale.toFixed(2)}) · 제목 ${act(p.pid, 'title').title?.[0] ?? '?'} · 창 ${list(p.pid).map((s) => s.split(' | ').slice(0, 2).join('/')).join(' ; ')} · 생존 ${alive(p.pid)}`;
    check('19 수식 문서로 가는 링크를 누르면 웹 창으로 넘어간다', ok && title === 'm3.md', `웹 ${webs(p.pid).length} · 제목 ${title}${why}`);
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

// ── 21~26. 우클릭 · 더 보기(⋮) 메뉴 — 윈도우 기본 팝업이 아니라 창 안에 직접 그린다(src-tauri/src/preview/menu.rs). 모양은 웹 창의 메뉴와 같다.
// 화면은 px-probe 의 shot(창 전체의 BMP)으로 읽는다. 색은 밝은 테마의 팔레트(layout.rs `palette`)다.
const BG = [0xfb, 0xfb, 0xf9];
const ACCENT = [0x1f, 0x22, 0x29];
const near = (c, want, tol = 8) => c.every((v, i) => Math.abs(v - want[i]) <= tol);
/** px-probe 의 shot 이 쓴 BMP(32bpp)를 읽는다 */
const readBmp = (name) => {
    const b = fs.readFileSync(path.join(tmp, `${name}.bmp`));
    const w = b.readInt32LE(18);
    const hRaw = b.readInt32LE(22);
    const h = Math.abs(hRaw);
    const off = b.readUInt32LE(10);
    return {
        get: (x, y) => {
            const row = hRaw < 0 ? y : h - 1 - y;
            const i = off + (row * w + x) * 4;
            return [b[i + 2], b[i + 1], b[i]];
        },
    };
};
/** 창 안(CSS px)의 한 점을 입력용(클라이언트 물리 px)과 읽기용(창 전체 BMP 의 픽셀)으로 바꾼다. 기본 창 너비는 CSS 980px 이다. */
const geometry = (pid) => {
    const m = /^(-?\d+),(-?\d+) (\d+)x(\d+) client=(\d+)x(\d+)/.exec(act(pid, 'rect').rect?.[0] ?? '');
    if (!m) throw new Error('창 크기를 못 읽었다');
    const [W, H, cw, ch] = m.slice(3, 7).map(Number);
    const ox = (W - cw) / 2; // 왼쪽 틀
    const oy = H - ch - ox; // 제목 표시줄(아래 틀은 왼쪽 틀과 같다)
    const s = cw / 980;
    const at = (x, y) => [Math.round(ox + x * s), Math.round(oy + y * s)];
    return {
        cl: (x, y) => [Math.round(x * s), Math.round(y * s)],
        px: (bmp, x, y) => bmp.get(...at(x, y)),
        /** CSS 사각형 안의 어두운 픽셀 수(글자 · 아이콘) */
        dark: (bmp, x0, y0, x1, y1) => {
            const [a, b] = at(x0, y0);
            const [c, d] = at(x1, y1);
            let n = 0;
            for (let y = b; y < d; y++) for (let x = a; x < c; x++) {
                const [r, g, bl] = bmp.get(x, y);
                if (r * 0.3 + g * 0.59 + bl * 0.11 < 140) n++;
            }
            return n;
        },
    };
};
const popups = (pid) => list(pid).filter((x) => x.startsWith('#32768')).length;
// 본문은 왼쪽 위에 짧게만 둔다 — 메뉴가 뜨는 오른쪽 · 아래가 비어 있어야 '메뉴가 그려졌다'를 글자 픽셀로 가릴 수 있다
const menuDoc = (name, extra = []) => doc(name, ['[넷째로 가기](b4.md)', '', '## 둘째 절', '', ...['문단 1', '문단 2', '문단 3', '문단 4', '문단 5', '문단 6', ...extra].flatMap((s) => [s, ''])].join('\n'));
doc('b4.md', '# 넷째 문서\n\n링크 대상입니다.\n');
const MX = 640;
const MY = 300; // 메뉴를 열 자리(CSS px)
const LABEL = [MX + 19, MY + 14, MX + 100, MY + 34]; // 첫 항목 '모두 선택' 글자 자리
const SPOT = [MX + 130, MY + 24]; // 첫 항목의 빈 자리(이름과 단축키 사이)
const LINK = [169, 54]; // 첫 줄의 링크

// 21~23. 열기 · 강조 · 고르기 · 닫기
{
    freshState({ theme: 'light' });
    const p = launch([menuDoc('menu.md')]);
    waitFor(() => views(p.pid).length === 1);
    sleep(700);
    const g = geometry(p.pid);
    const shot = (name) => {
        act(p.pid, `shot:${name}`);
        return readBmp(name);
    };
    const open = () => act(p.pid, `rclick:${g.cl(MX, MY).join(',')};wait:350`);
    const base = shot('m-base');
    const baseOk = g.dark(base, ...LABEL) === 0 && near(g.px(base, ...SPOT), BG, 6);
    open();
    const s1 = shot('m-open');
    check('21 우클릭하면 메뉴가 창 안에 그려진다(윈도우 기본 팝업이 아니다)', baseOk && g.dark(s1, ...LABEL) > 30 && popups(p.pid) === 0, `글자 픽셀 ${g.dark(s1, ...LABEL)} · 기본 팝업 ${popups(p.pid)}`);
    check('21b 처음에는 아무 항목도 강조되지 않는다', near(g.px(s1, ...SPOT), BG, 6), `색 ${g.px(s1, ...SPOT)}`);
    act(p.pid, 'key:down;wait:250');
    const s2 = shot('m-hot');
    check('21c ↓ 키가 첫 항목을 반전색으로 강조한다', near(g.px(s2, ...SPOT), ACCENT, 10), `색 ${g.px(s2, ...SPOT)}`);
    // 22. Enter 로 '모두 선택'을 고른다 → 메뉴가 닫히고 글이 모두 선택된다
    const clip = (act(p.pid, 'clearclip;key:enter;wait:300;chord:ctrl+c;clip').clip?.[0] ?? '').replace(/\\n/g, '\n');
    const s3 = shot('m-picked');
    check('22 Enter 로 모두 선택을 고르면 메뉴가 닫히고 글이 선택된다', g.dark(s3, ...LABEL) === 0 && clip.includes('문단 1') && clip.includes('문단 6'), `메뉴 글자 ${g.dark(s3, ...LABEL)} · 복사 ${JSON.stringify(clip.slice(0, 24))}`);
    // 23a. Esc 로 닫힌다
    open();
    act(p.pid, 'esc;wait:300');
    check('23a Esc 로 닫힌다', g.dark(shot('m-esc'), ...LABEL) === 0 && alive(p.pid));
    // 23b. 휠을 굴리면 닫힌다
    open();
    act(p.pid, 'wheel:-120;wait:300');
    check('23b 휠을 굴리면 닫힌다', g.dark(shot('m-wheel'), ...LABEL) === 0);
    // 23c. 바깥을 누르면 닫히기만 한다 — 그 누름이 아래 링크를 열지 않는다. 다시 누르면 링크가 열린다.
    open();
    act(p.pid, `click:${g.cl(...LINK).join(',')};wait:500`);
    const t1 = act(p.pid, 'title').title?.[0] ?? '';
    const closed = g.dark(shot('m-outside'), ...LABEL) === 0;
    act(p.pid, `click:${g.cl(...LINK).join(',')};wait:900`);
    const t2 = act(p.pid, 'title').title?.[0] ?? '';
    check('23c 바깥을 누르면 메뉴만 닫히고, 그 누름은 링크로 새지 않는다', closed && t1 === 'menu.md' && t2 === 'b4.md', `닫힘 ${closed} · 제목 ${t1} → ${t2}`);
    kill(p.pid);
}
// 24. 마우스: 항목 위에 올리면 강조되고 누르면 실행된다(목차 → 도크)
{
    freshState({ theme: 'light' });
    const p = launch([menuDoc('menu2.md')]);
    waitFor(() => views(p.pid).length === 1);
    sleep(700);
    const g = geometry(p.pid);
    const shot = (name) => {
        act(p.pid, `shot:${name}`);
        return readBmp(name);
    };
    const base = shot('m2-base');
    const dock = [18, 14, 70, 40]; // 도크 머리의 '목차' 글자 자리(도크가 없으면 비어 있다)
    // 목차는 셋째 항목(모두 선택 · ── · 편집 · 목차): 위에서 7 + 34 + 11 + 34 = 86 아래부터 34
    const TOC = [MX + 130, MY + 7 + 34 + 11 + 34 + 17];
    act(p.pid, `rclick:${g.cl(MX, MY).join(',')};wait:300;move:${g.cl(...TOC).join(',')};wait:250`);
    const hot = shot('m2-hot');
    check('24a 항목 위에 마우스를 올리면 그 항목이 강조된다', near(g.px(hot, ...TOC), ACCENT, 10), `색 ${g.px(hot, ...TOC)}`);
    act(p.pid, `click:${g.cl(...TOC).join(',')};wait:500`);
    const after = shot('m2-toc');
    check('24b 항목을 누르면 실행된다(목차 도크가 열리고 메뉴는 닫힌다)', g.dark(base, ...dock) === 0 && g.dark(after, ...dock) > 15 && g.dark(after, ...LABEL) === 0, `도크 글자 ${g.dark(base, ...dock)} → ${g.dark(after, ...dock)} · 메뉴 글자 ${g.dark(after, ...LABEL)}`);
    kill(p.pid);
}
// 25. 더 보기(⋮): 단추 아래에 오른쪽을 맞춰 열리고, 메뉴가 열려 있는 동안 컨트롤이 남는다. 닫으면 컨트롤도 걷힌다.
{
    freshState({ theme: 'light' });
    const p = launch([menuDoc('menu3.md')]);
    waitFor(() => views(p.pid).length === 1);
    sleep(700);
    const g = geometry(p.pid);
    const shot = (name) => {
        act(p.pid, `shot:${name}`);
        return readBmp(name);
    };
    const pill = [772, 14, 956, 54]; // 떠오르는 컨트롤 막대(아이콘이 든다)
    const kebab = [936, 34]; // 더 보기 단추
    const inner = [721 + 19, 57 + 14, 721 + 100, 57 + 34]; // 단추 아래 메뉴의 첫 항목 글자(상자: 오른쪽 953, 너비 232, 위 57)
    act(p.pid, `move:${g.cl(500, 400).join(',')};move:${g.cl(520, 410).join(',')};wait:300`);
    act(p.pid, `click:${g.cl(...kebab).join(',')};wait:500`);
    const s1 = shot('m3-open');
    check('25 ⋮ 를 누르면 단추 아래에 메뉴가 열리고 컨트롤은 그대로 보인다', g.dark(s1, ...inner) > 30 && g.dark(s1, ...pill) > 20 && popups(p.pid) === 0, `메뉴 글자 ${g.dark(s1, ...inner)} · 컨트롤 ${g.dark(s1, ...pill)}`);
    act(p.pid, 'esc;wait:400');
    const s2 = shot('m3-closed');
    check('25b Esc 로 닫으면 메뉴도 컨트롤도 걷힌다', g.dark(s2, ...inner) === 0 && g.dark(s2, ...pill) === 0, `메뉴 글자 ${g.dark(s2, ...inner)} · 컨트롤 ${g.dark(s2, ...pill)}`);
    kill(p.pid);
}
// 26. 키보드로 고르는 항목이 제 일을 한다: 원문 보기(서식 없이), 편집(웹 창으로 넘어간다)
{
    freshState({ theme: 'light' });
    const p = launch([menuDoc('menu4.md')]);
    waitFor(() => views(p.pid).length === 1);
    sleep(700);
    const g = geometry(p.pid);
    // 모두 선택 · 편집 · 목차 · 문서에서 찾기 · 원문 보기 — 다섯 번째
    const raw = (act(p.pid, `rclick:${g.cl(MX, MY).join(',')};wait:300;key:down;key:down;key:down;key:down;key:down;key:enter;wait:400;clearclip;chord:ctrl+a;chord:ctrl+c;clip`).clip?.[0] ?? '').replace(/\\n/g, '\n');
    check('26a 원문 보기를 고르면 서식 없는 원문이 보인다', raw.includes('## 둘째 절') && raw.includes('[넷째로 가기](b4.md)'), JSON.stringify(raw.slice(0, 30)));
    kill(p.pid);
}
{
    freshState({ theme: 'light' });
    const p = launch([menuDoc('menu5.md')]);
    waitFor(() => views(p.pid).length === 1);
    sleep(700);
    const g = geometry(p.pid);
    // 고른 글이 없으니 모두 선택 · 편집 — 둘째
    act(p.pid, `rclick:${g.cl(MX, MY).join(',')};wait:300;key:down;key:down;key:enter`);
    const ok = waitFor(() => webs(p.pid).length === 1 && views(p.pid).length === 0 && previews(p.pid).length === 0, 6000);
    check('26b 편집을 고르면 네이티브 창이 웹(편집) 창으로 바뀐다', ok && alive(p.pid), `웹 ${webs(p.pid).length} · 네이티브 ${views(p.pid).length}`);
    kill(p.pid);
}
// 27. 고른 글이 있으면 맨 위에 복사가 붙고, 고르면 클립보드로 간다. 28. 문서에서 찾기를 고르면 찾기 막대가 열린다.
{
    freshState({ theme: 'light' });
    const p = launch([menuDoc('menu6.md')]);
    waitFor(() => views(p.pid).length === 1);
    sleep(700);
    const g = geometry(p.pid);
    const copied = (act(p.pid, `chord:ctrl+a;clearclip;rclick:${g.cl(MX, MY).join(',')};wait:300;key:down;key:enter;wait:300;clip`).clip?.[0] ?? '').replace(/\\n/g, '\n');
    check('27 고른 글이 있으면 메뉴 맨 위가 복사이고, 고르면 클립보드로 간다', copied.includes('둘째 절') && copied.includes('문단 6'), JSON.stringify(copied.slice(0, 24)));
    // 고른 것을 풀고(빈 곳 클릭 대신 Esc 가 아니라 다시 열었을 때 첫 항목이 모두 선택인지로 확인하지 않는다) 찾기를 연다
    const band = [100, 8, 700, 36]; // 찾기 막대가 그려지는 띠(컨트롤 막대는 이 오른쪽, 본문 첫 줄은 이 아래다)
    const before = (() => {
        act(p.pid, 'shot:m6-before');
        return g.dark(readBmp('m6-before'), ...band);
    })();
    // 고른 글이 있어 항목이 하나 늘었다: 복사 · 모두 선택 · 편집 · 목차 · 문서에서 찾기 — 다섯째
    act(p.pid, `rclick:${g.cl(MX, MY).join(',')};wait:300;key:down;key:down;key:down;key:down;key:down;key:enter;wait:400;shot:m6-find`);
    const after = g.dark(readBmp('m6-find'), ...band);
    check('28 문서에서 찾기를 고르면 찾기 막대가 열린다', before === 0 && after > 40, `띠의 글자 픽셀 ${before} → ${after}`);
    kill(p.pid);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
process.exit(failed ? 1 : 0);
