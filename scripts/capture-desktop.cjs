'use strict';

/**
 * README 쇼케이스 이미지 생성 — `npx electron scripts/capture-desktop.cjs`
 *
 * 실제 앱 화면(dist-desktop)을 띄워 장면별로 캡처하고, Windows 11 창 틀(제목 표시줄 · 그림자)에
 * 넣어 docs/images/ 에 쓴다. 맨 위 타이틀 배너(hero.png)도 같은 캡처로 만든다.
 *
 * ★ 문서는 docs/sample/ 의 **가상 예시**다. 실제 문서를 캡처하지 마라 — 경로 · 이름 · 내용이
 *   그대로 공개 저장소에 올라간다.
 * ★ 먼저 `npm run desktop:build` 로 dist-desktop 을 만들어 둬야 한다.
 *
 * 화면은 앱의 진짜 경로(preload → document / command 이벤트)로 움직인다. CSS 클래스를 손으로 덮어쓰는 것은
 * '컨트롤이 보이는 순간'을 흉내 낼 때만 쓴다(마우스 이동을 보낼 수 없어서).
 */
const { app, BrowserWindow, protocol, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

// 사진 · 포스터에 쓸 만큼 또렷하게. 창 크기는 CSS 픽셀 그대로고 결과 PNG 만 1.5 배다.
app.commandLine.appendSwitch('force-device-scale-factor', '1.5');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist-desktop');
const OUT = path.join(ROOT, 'docs', 'images');
const SAMPLE = path.join(ROOT, 'docs', 'sample', '주문서비스_개편제안서.md');
const ICON = path.join(ROOT, 'desktop', 'icon.png');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'marklet-shots-'));

const CONTENT_W = 1200;
const CONTENT_H = 800;
const PAD = 56;
const TITLEBAR = 36;
const DOC_NAME = path.basename(SAMPLE);

// ★ 설정(테마 등)이 설치된 앱의 데이터 폴더에 섞이지 않게 임시 폴더를 쓴다. 안 그러면 지난 실행의 다크 테마가
//   남아 '라이트' 장면이 어둡게 찍히고, 사용자의 앱 저장소도 건드린다.
app.setPath('userData', path.join(TMP, 'user-data'));

protocol.registerSchemesAsPrivileged([
    { scheme: 'marklet', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: 'marklet-local', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function registerProtocols() {
    protocol.handle('marklet', async (req) => {
        try {
            const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'desktop.html';
            const full = path.normalize(path.join(DIST, rel));
            if (full !== DIST && !full.startsWith(DIST + path.sep)) return new Response('forbidden', { status: 403 });
            return new Response(await fs.promises.readFile(full), { headers: { 'content-type': mimeOf(full) } });
        } catch {
            return new Response('not found', { status: 404 });
        }
    });
    protocol.handle('marklet-local', async () => new Response('not found', { status: 404 }));
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
  <div class="tb"><img class="ic" src="${pathToFileURL(ICON).href}"><span class="t">${title}</span><span class="sp"></span>
    <span class="cb"><svg viewBox="0 0 10 10"><path d="M0 5h10"/></svg></span>
    <span class="cb"><svg viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9"/></svg></span>
    <span class="cb"><svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10"/></svg></span></div>
  <img class="shot" src="${imgUrl}">
</div>`;
}

let stage;
async function render(html, w, h, outFile) {
    const f = path.join(TMP, `p${Date.now()}.html`);
    fs.writeFileSync(f, html);
    if (!stage || stage.isDestroyed()) {
        stage = new BrowserWindow({ show: false, useContentSize: true, width: w, height: h, frame: false, webPreferences: { sandbox: true } });
    }
    stage.setContentSize(w, h);
    await stage.loadFile(f);
    await stage.webContents.executeJavaScript('Promise.all([...document.images].map(i=>i.decode().catch(()=>{}))).then(()=>document.fonts.ready).then(()=>1)');
    await sleep(250);
    const img = await stage.webContents.capturePage();
    fs.writeFileSync(outFile, img.toPNG());
    console.log('  ->', path.relative(ROOT, outFile), `${img.getSize().width}x${img.getSize().height}`);
}

/** 캡처한 화면(png) 한 장을 창 틀에 넣어 파일로 쓴다 */
async function framed(name, png, title, dark) {
    const shot = path.join(TMP, `${name}.png`);
    fs.writeFileSync(shot, png);
    const w = CONTENT_W;
    const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;overflow:hidden}
    body{padding:${PAD}px;box-sizing:border-box;background:linear-gradient(135deg,#e4eaf5 0%,#f5f7fb 52%,#e1e8f3 100%)}
    ${CHROME_CSS}</style>${windowHtml(pathToFileURL(shot).href, title, dark, w)}`;
    await render(html, w + PAD * 2, CONTENT_H + TITLEBAR + PAD * 2, path.join(OUT, `${name}.png`));
}

/** 맨 위 타이틀 배너 */
async function hero(lightPng, darkPng) {
    const light = path.join(TMP, 'hero-light.png');
    const dark = path.join(TMP, 'hero-dark.png');
    fs.writeFileSync(light, lightPng);
    fs.writeFileSync(dark, darkPng);
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
      <div class="brand"><img src="${pathToFileURL(ICON).href}"><h1>Marklet</h1></div>
      <p class="tag">AI가 써 준 마크다운을,<br><em>받은 그대로</em> 읽습니다.</p>
      <p class="sub">문서만 보이는 Windows 뷰어. 표 · 수식 · 다이어그램까지 그대로 그리고, 가볍게 고치고 저장합니다. 오프라인으로, 광고 없이.</p>
      <div class="pills"><span>표 · KaTeX · Mermaid</span><span>Ctrl+E 편집</span><span>.md · .txt</span><span>다크 테마</span></div>
    </div>
    <div class="w2">${windowHtml(pathToFileURL(dark).href, DOC_NAME, true, 500)}</div>
    <div class="w1">${windowHtml(pathToFileURL(light).href, DOC_NAME, false, 540)}</div>`;
    await render(html, 1280, 640, path.join(OUT, 'hero.png'));
}

// ── 장면 ────────────────────────────────────────────────────────────────

async function main() {
    registerProtocols();
    fs.mkdirSync(OUT, { recursive: true });

    const win = new BrowserWindow({
        width: CONTENT_W,
        height: CONTENT_H,
        useContentSize: true,
        show: false,
        backgroundColor: '#fbfbf9',
        webPreferences: {
            preload: path.join(ROOT, 'desktop', 'preload.cjs'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
        },
    });
    const ready = new Promise((r) => ipcMain.once('renderer-ready', r));
    await win.loadURL('marklet://app/desktop.html');
    await ready;
    await sleep(500);

    const js = (code) => win.webContents.executeJavaScript(code);
    const cmd = (name, value) => win.webContents.send('command', value ? { name, value } : { name });
    const snap = async () => (await win.webContents.capturePage()).toPNG();
    /** 마우스를 움직였을 때의 모습 — 실제 마우스 이동은 보낼 수 없어서 컨트롤을 직접 보이게 한다 */
    const pill = (on) => js(`document.querySelector('.desktop-controls')?.classList.toggle('is-shown', ${on})`);
    const headingTop = (prefix) =>
        js(`(()=>{const h=[...document.querySelectorAll('.md-body h2')].find(x=>x.textContent.trim().startsWith(${JSON.stringify(prefix)}));
            if(h){h.scrollIntoView({block:'start'});window.scrollBy(0,-28)}})()`);

    // ★ 전환(transition)을 끈다. 숨겨진 창은 프레임이 캡처할 때만 나가서 전환이 중간(반투명)에서 멈춘 채 찍힌다.
    await js(`(()=>{const st=document.createElement('style');st.textContent='*,*::before,*::after{transition:none!important;animation:none!important}';document.head.appendChild(st)})()`);

    console.log('장면 캡처');
    // 항상 라이트에서 시작한다(시스템 테마와 무관하게).
    cmd('settings', { theme: 'light', remoteImages: false });
    await sleep(600);
    await framed('01-home', await snap(), 'Marklet', false);

    win.webContents.send('document', {
        path: SAMPLE,
        name: DOC_NAME,
        dir: path.dirname(SAMPLE),
        size: fs.statSync(SAMPLE).size,
        content: fs.readFileSync(SAMPLE, 'utf8'),
        encoding: 'UTF-8',
        reload: false,
    });
    await sleep(3800); // 수식 · 코드 · Mermaid 가 다 그려질 때까지

    // 1) 읽기 (컨트롤이 떠 있는 순간)
    await js('window.scrollTo(0,0)');
    await pill(true);
    await sleep(500);
    const lightPng = await snap();
    await framed('06-reading', lightPng, DOC_NAME, false);

    // 2) 목차 도크
    await pill(false);
    cmd('toc');
    await sleep(700);
    await framed('04-toc', await snap(), DOC_NAME, false);
    cmd('toc');
    await sleep(500);

    // 3) 검색
    cmd('find');
    await sleep(400);
    await js(`(()=>{const i=document.querySelector('.search-bar input');i.value='결제';i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await sleep(700);
    await framed('05-search', await snap(), DOC_NAME, false);
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await sleep(400);

    // 4) 구조도 + 수식
    await headingTop('2.');
    await sleep(900);
    await framed('03-diagram', await snap(), DOC_NAME, false);

    // 5) 표
    await headingTop('1.');
    await sleep(600);
    await framed('02-tables', await snap(), DOC_NAME, false);

    // 6) 편집
    cmd('edit');
    await sleep(700);
    await js(`(()=>{const e=document.querySelector('.desktop-editor');e.scrollTop=0;e.setSelectionRange(0,0)})()`);
    await pill(true);
    await sleep(500);
    // 제목의 ● 는 '저장하지 않은 편집' 표시다 — 편집 중임을 보여 준다.
    await framed('07-editor', await snap(), `● ${DOC_NAME}`, false);
    cmd('edit');
    await sleep(900);

    // 7) 다크
    cmd('settings', { theme: 'dark', remoteImages: false });
    await sleep(1000);
    await js('window.scrollTo(0,0)');
    await pill(true);
    await sleep(500);
    const darkPng = await snap();
    await framed('08-dark', darkPng, DOC_NAME, true);

    // 8) 타이틀 배너
    console.log('타이틀 배너');
    await hero(lightPng, darkPng);

    console.log('완료');
    // 임시 폴더는 Electron 이 아직 쥐고 있어 지금은 못 지운다. 종료 뒤 정리를 시도하되 실패해도 무시한다.
    app.once('quit', () => {
        try {
            fs.rmSync(TMP, { recursive: true, force: true });
        } catch {
            /* 임시 폴더 — OS 가 치운다 */
        }
    });
    app.quit();
}

app.whenReady().then(main).catch((e) => {
    console.error(e);
    app.exit(1);
});
