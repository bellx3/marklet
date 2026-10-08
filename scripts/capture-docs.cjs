'use strict';

/**
 * README 쇼케이스 이미지 만들기 — `npm run docs:images [-- --out 폴더] [-- --exe 경로]`   (release 빌드가 먼저 있어야 한다: `npm run build:exe`)
 *
 * 실제 앱(웹 창 = WebView2)을 띄워 장면별로 캡처하고, Windows 11 창 틀(제목 표시줄 · 그림자)에 넣어 docs/images/ 에 쓴다. 맨 위 타이틀 배너(hero.png)도 같은 캡처로 만든다.
 *
 * ★ 문서는 docs/sample/ 의 **가상 예시**다. 실제 문서를 캡처하지 마라 — 경로 · 이름 · 내용이 그대로 공개 저장소에 올라간다.
 * ★ 입력은 SendInput 이 아니라 CDP(WebView2 의 원격 디버깅)와 페이지 안의 이벤트로 넣는다 — 마우스와 키보드를 뺏지 않는다.
 *   설정 · 웹뷰 데이터는 임시 프로필에 쓴다(scripts/lib/profile.cjs). 떠 있는 진짜 Marklet 은 먼저 끝낼 것(단일 인스턴스 규칙).
 * ★ 화면은 네이티브 뷰어가 아니라 **웹 창**이다(`MARKLET_NATIVE=0`) — 수식 · 다이어그램이 든 예시 문서가 그쪽이고, 창 틀은 직접 그린 것이다.
 *   그리는 크기는 CSS 1200×800 이고 결과 PNG 만 1.5 배다(Emulation.setDeviceMetricsOverride).
 */
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { isolate } = require('./lib/profile.cjs');

const profile = isolate('mk-docs');
const ROOT = path.join(__dirname, '..');
const arg = (name, def) => {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};
const EXE = arg('exe', path.join(ROOT, 'src-tauri', 'target', 'release', 'Marklet.exe'));
const OUT = path.resolve(arg('out', path.join(ROOT, 'docs', 'images')));
const SAMPLE = path.join(ROOT, 'docs', 'sample', '주문서비스_개편제안서.md');
const ICON = path.join(ROOT, 'src-tauri', 'icons', 'icon.png');
const DOC_NAME = path.basename(SAMPLE);
const CONTENT_W = 1200;
const CONTENT_H = 800;
const PAD = 56;
const TITLEBAR = 36;
const SCALE = 1.5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const f of [EXE, SAMPLE, ICON]) {
    if (!fs.existsSync(f)) {
        console.error(`없다: ${f}`);
        process.exit(2);
    }
}
const dataUrl = (file, mime = 'image/png') => `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
const dataUrlBuf = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;
const ICON_URL = dataUrl(ICON);

// ── CDP ─────────────────────────────────────────────────────────────────

const getJson = (url) =>
    new Promise((res, rej) => {
        http.get(url, (r) => {
            let b = '';
            r.on('data', (d) => (b += d));
            r.on('end', () => {
                try {
                    res(JSON.parse(b));
                } catch (e) {
                    rej(e);
                }
            });
        }).on('error', rej);
    });

/** 앱을 띄워(문서 인자는 선택) CDP 로 붙는다. 설정은 임시 프로필에 미리 써 둔다. */
async function launch(args, state) {
    const port = 9400 + Math.floor(Math.random() * 400);
    fs.writeFileSync(profile.stateFile, JSON.stringify({ theme: 'light', zoom: 1.0, remoteImages: false, keepWarm: false, nativeView: false, recent: [], ...state }));
    const child = spawn(EXE, args, {
        env: { ...process.env, MARKLET_NATIVE: '0', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
        stdio: 'ignore',
    });
    let target;
    for (let i = 0; i < 100 && !target; i++) {
        await sleep(300);
        try {
            target = (await getJson(`http://127.0.0.1:${port}/json`)).find((t) => t.type === 'page' && /tauri|localhost/.test(t.url));
        } catch {
            /* 아직 */
        }
    }
    if (!target) throw new Error('앱의 웹 창(CDP 대상)을 못 찾았다');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.id && pending.has(d.id)) {
            pending.get(d.id)(d);
            pending.delete(d.id);
        }
    };
    const send = (method, params = {}) =>
        new Promise((res) => {
            const i = ++id;
            pending.set(i, res);
            ws.send(JSON.stringify({ id: i, method, params }));
        });
    const js = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.result?.exceptionDetails) throw new Error(`페이지 스크립트 오류: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`);
        return r.result?.result?.value;
    };
    const stop = async () => {
        try {
            ws.close();
        } catch {
            /* */
        }
        try {
            execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
        } catch {
            /* 이미 끝났다 */
        }
        await sleep(800);
    };
    await send('Page.enable');
    await send('Runtime.enable');
    // 숨겨진 창은 포커스가 없어 :focus 스타일(메뉴 항목 강조)이 안 그려진다 — 포커스가 있는 것처럼 꾸민다.
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return { send, js, stop };
}

// ── 창 틀(Windows 11 느낌) ──────────────────────────────────────────────

const FONT_UI = "'Segoe UI Variable Text','Segoe UI','Noto Sans KR','Malgun Gothic',sans-serif";
const FONT_DISPLAY = "'Segoe UI Variable Display','Segoe UI Semibold','Noto Sans KR','Malgun Gothic',sans-serif";

const CHROME_CSS = `
.win{border-radius:10px;overflow:hidden;background:#fff;
  box-shadow:0 0 0 1px rgba(0,0,0,.14),0 28px 64px rgba(15,23,42,.30),0 6px 16px rgba(15,23,42,.14)}
.win .tb{height:${TITLEBAR}px;display:flex;align-items:center;background:#f3f3f3;color:#1a1a1a;font:12px ${FONT_UI}}
.win.dark{box-shadow:0 0 0 1px rgba(255,255,255,.10),0 28px 64px rgba(0,0,0,.55),0 6px 16px rgba(0,0,0,.35)}
.win.dark .tb{background:#202020;color:#f5f5f5}
.win .ic{width:16px;height:16px;margin:0 10px 0 12px;border-radius:3px}
.win .t{white-space:nowrap}
.win .sp{flex:1}
.win .cb{width:46px;height:${TITLEBAR}px;display:flex;align-items:center;justify-content:center}
.win .cb svg{width:10px;height:10px;stroke:currentColor;fill:none;stroke-width:1}
.win .shot{display:block;width:100%}
`;

function windowHtml(imgUrl, title, dark, width) {
    return `<div class="win ${dark ? 'dark' : ''}" style="width:${width}px">
  <div class="tb"><img class="ic" src="${ICON_URL}"><span class="t">${title}</span><span class="sp"></span>
    <span class="cb"><svg viewBox="0 0 10 10"><path d="M0 5h10"/></svg></span>
    <span class="cb"><svg viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9"/></svg></span>
    <span class="cb"><svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10"/></svg></span></div>
  <img class="shot" src="${imgUrl}">
</div>`;
}

let page; // 합성에 쓰는 페이지(앱 창을 그대로 쓴다) — ★ 합성은 페이지의 문서를 갈아 끼우므로 장면을 다 찍은 **뒤에** 한다
const scenes = []; // { name, png, title, dark }
const framed = async (name, png, title, dark) => void scenes.push({ name, png, title, dark });

/** HTML 을 페이지에 올려 w×h(CSS px) 를 1.5 배로 찍어 파일로 쓴다 */
async function render(html, w, h, outFile) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: SCALE, mobile: false });
    const frame = (await page.send('Page.getFrameTree')).result.frameTree.frame.id;
    await page.send('Page.setDocumentContent', { frameId: frame, html });
    await page.js('Promise.all([...document.images].map(i=>i.decode().catch(()=>{}))).then(()=>document.fonts.ready).then(()=>1)');
    await sleep(300);
    const r = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
    fs.writeFileSync(outFile, Buffer.from(r.result.data, 'base64'));
    console.log('  ->', path.relative(ROOT, outFile), `${w * SCALE}x${h * SCALE}`);
}

/** 캡처한 화면 한 장을 창 틀에 넣어 파일로 쓴다 */
async function compose(name, png, title, dark) {
    const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;overflow:hidden}
    body{padding:${PAD}px;box-sizing:border-box;background:linear-gradient(135deg,#e4eaf5 0%,#f5f7fb 52%,#e1e8f3 100%)}
    ${CHROME_CSS}</style>${windowHtml(dataUrlBuf(png), title, dark, CONTENT_W)}`;
    await render(html, CONTENT_W + PAD * 2, CONTENT_H + TITLEBAR + PAD * 2, path.join(OUT, `${name}.png`));
}

/** 맨 위 타이틀 배너 */
async function hero(lightPng, darkPng) {
    const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:1280px;height:640px;overflow:hidden}
    .tag,.sub{word-break:keep-all}
    body{position:relative;background:
      radial-gradient(900px 520px at 78% 10%,rgba(111,179,242,.20),transparent 60%),
      radial-gradient(700px 480px at 6% 100%,rgba(120,140,255,.16),transparent 62%),
      linear-gradient(160deg,#0b0f14 0%,#121922 55%,#0d131a 100%);color:#fbfbf9}
    .grid{position:absolute;inset:0;opacity:.07;
      background-image:linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px);background-size:40px 40px;
      -webkit-mask-image:radial-gradient(700px 400px at 70% 40%,#000,transparent 75%)}
    .left{position:absolute;left:72px;top:0;bottom:0;width:560px;display:flex;flex-direction:column;justify-content:center}
    .brand{display:flex;align-items:center;gap:22px}
    .brand img{width:84px;height:84px;border-radius:20px;box-shadow:0 10px 30px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.12)}
    .brand h1{margin:0;font:600 92px/1 ${FONT_DISPLAY};letter-spacing:-3px}
    .tag{margin:34px 0 0;font:700 34px/1.38 ${FONT_UI};letter-spacing:-.5px;color:#fbfbf9}
    .tag em{font-style:normal;color:#6fb3f2}
    .sub{margin:16px 0 0;font:400 19px/1.6 ${FONT_UI};color:#9aa0a9}
    .pills{margin-top:30px;display:flex;gap:10px;flex-wrap:wrap}
    .pills span{padding:7px 14px;border-radius:999px;font:500 15px ${FONT_UI};color:#d6d9de;
      background:rgba(255,255,255,.07);box-shadow:inset 0 0 0 1px rgba(255,255,255,.14)}
    .w2{position:absolute;left:768px;top:44px;transform:rotate(1.4deg)}
    .w1{position:absolute;left:690px;top:176px;transform:rotate(-1deg)}
    ${CHROME_CSS}
    .win{box-shadow:0 0 0 1px rgba(255,255,255,.10),0 34px 70px rgba(0,0,0,.6)}
    </style><div class="grid"></div>
    <div class="left">
      <div class="brand"><img src="${ICON_URL}"><h1>Marklet</h1></div>
      <p class="tag">AI가 써 준 마크다운을,<br><em>받은 그대로</em> 읽습니다.</p>
      <p class="sub">문서만 보이는 Windows 뷰어. 표 · 수식 · 다이어그램까지 그대로 그리고, 가볍게 고치고 저장합니다. 오프라인으로, 광고 없이.</p>
      <div class="pills"><span>표 · KaTeX · Mermaid</span><span>Ctrl+E 편집</span><span>.md · .txt</span><span>다크 테마</span></div>
    </div>
    <div class="w2">${windowHtml(dataUrlBuf(darkPng), DOC_NAME, true, 500)}</div>
    <div class="w1">${windowHtml(dataUrlBuf(lightPng), DOC_NAME, false, 540)}</div>`;
    await render(html, 1280, 640, path.join(OUT, 'hero.png'));
}

// ── 장면 ────────────────────────────────────────────────────────────────

const FREEZE_CSS =
    '*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0.001s!important;animation-delay:0s!important;animation-fill-mode:both!important;caret-color:transparent!important}';

async function viewport(app) {
    await app.send('Emulation.setDeviceMetricsOverride', { width: CONTENT_W, height: CONTENT_H, deviceScaleFactor: SCALE, mobile: false });
    // ★ 전환(transition)을 끈다. 프레임이 캡처할 때만 나가는 창은 전환이 중간(반투명)에서 멈춘 채 찍힌다. 애니메이션은 끝 상태로 고정한다.
    await app.js(`(()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(FREEZE_CSS)};document.head.appendChild(s)})()`);
}
const snap = async (app) => {
    await sleep(500);
    const r = await app.send('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(r.result.data, 'base64');
};

async function main() {
    fs.mkdirSync(OUT, { recursive: true });

    console.log('빈 화면');
    let app = await launch([], {});
    page = app;
    await sleep(2500);
    await viewport(app);
    await compose('01-home', await snap(app), 'Marklet', false);
    await app.stop();

    console.log('장면 캡처');
    app = await launch([SAMPLE], {});
    page = app;
    const key = (k, o = {}) =>
        app.js(`(document.activeElement||document.body).dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},ctrlKey:${!!o.ctrl},bubbles:true,cancelable:true}))`);
    // 문서(제목 · 수식 · 다이어그램)가 다 그려질 때까지
    for (let i = 0; i < 80; i++) {
        if (await app.js(`!!document.querySelector('.md-body h1') && !!document.querySelector('.mermaid-block[data-mermaid-state="done"]') && !!document.querySelector('.katex')`)) break;
        await sleep(400);
    }
    await sleep(1200);
    await viewport(app);
    /** 마우스를 움직였을 때의 모습 — 컨트롤을 직접 보이게 한다 */
    const pill = (on) => app.js(`document.querySelector('.desktop-controls')?.classList.toggle('is-shown', ${on})`);
    const headingTop = (prefix) =>
        app.js(`(()=>{const h=[...document.querySelectorAll('.md-body h2')].find(x=>x.textContent.trim().startsWith(${JSON.stringify(prefix)}));
            if(h){h.scrollIntoView({block:'start'});window.scrollBy(0,-28)}})()`);

    // 1) 읽기 (컨트롤이 떠 있는 순간)
    await app.js('window.scrollTo(0,0)');
    await pill(true);
    const lightPng = await snap(app);
    await framed('06-reading', lightPng, DOC_NAME, false);

    // 2) 목차 도크
    await pill(false);
    await key('t', { ctrl: true });
    await sleep(700);
    await framed('04-toc', await snap(app), DOC_NAME, false);
    await key('t', { ctrl: true });
    await sleep(500);

    // 3) 검색
    await key('f', { ctrl: true });
    await sleep(400);
    await app.js(`(()=>{const i=document.querySelector('.search-bar input');i.value='결제';i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await sleep(700);
    await framed('05-search', await snap(app), DOC_NAME, false);
    await key('Escape');
    await sleep(400);

    // 4) 구조도 + 수식
    await headingTop('2.');
    await sleep(900);
    await framed('03-diagram', await snap(app), DOC_NAME, false);

    // 5) 표
    await headingTop('1.');
    await sleep(600);
    await framed('02-tables', await snap(app), DOC_NAME, false);

    // 5b) 더 보기 메뉴 — 항목마다 단축키가 적혀 있다
    await app.js('window.scrollTo(0,0)');
    await pill(true);
    await app.js(`document.querySelector('.desktop-controls .desktop-ctl:last-child').click()`);
    await pill(true); // 케밥을 누르면 컨트롤이 거둬진다 — 메뉴와 함께 찍으려고 다시 보이게 한다
    await app.js(`[...document.querySelectorAll('.mk-menu-item')].find((b) => b.textContent.startsWith('목차'))?.focus()`);
    await sleep(500);
    await framed('09-menu', await snap(app), DOC_NAME, false);
    await key('Escape');
    await pill(false);
    await sleep(400);

    // 6) 편집
    await key('e', { ctrl: true });
    await sleep(700);
    await app.js(`(()=>{const e=document.querySelector('.desktop-editor');e.scrollTop=0;e.setSelectionRange(0,0)})()`);
    await pill(true);
    // 제목의 ● 는 '저장하지 않은 편집' 표시다 — 편집 중임을 보여 준다.
    await framed('07-editor', await snap(app), `● ${DOC_NAME}`, false);
    await key('e', { ctrl: true });
    await sleep(900);

    // 7) 다크
    await app.js(`document.documentElement.dataset.theme='dark'`);
    await sleep(600);
    await app.js('window.scrollTo(0,0)');
    await pill(true);
    const darkPng = await snap(app);
    await framed('08-dark', darkPng, DOC_NAME, true);

    // 8) 합성 — 앱의 DOM 을 더 쓸 일이 없으니 이 페이지에 창 틀 · 배너를 그린다
    console.log('창 틀 합성');
    for (const sc of scenes) await compose(sc.name, sc.png, sc.title, sc.dark);
    console.log('타이틀 배너');
    await hero(lightPng, darkPng);

    await app.stop();
    console.log('완료 —', OUT);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
