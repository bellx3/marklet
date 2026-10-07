'use strict';

/**
 * Marklet 데스크톱 — 메인 프로세스.
 *
 * 만들려는 것은 '마크다운을 위한 사진 뷰어'다. .md 를 더블클릭하면 그 문서만 보이는
 * 창이 뜬다. 화면에는 문서밖에 없고, 필요한 기능은 메뉴(Alt) · 우클릭 · 단축키로 닿는다.
 *
 * ★ 화면 그리기는 모바일 앱과 같은 코드를 쓴다(src/markdown/*). 여기는 그 바깥,
 *   즉 창 · 메뉴 · 파일 읽기 · 더블클릭 연결만 맡는다.
 */
const {
    app,
    BrowserWindow,
    Menu,
    dialog,
    shell,
    ipcMain,
    protocol,
    clipboard,
    nativeTheme,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { buildMenuTemplate, buildContextTemplate, pickStrings } = require('./menu.cjs');
const {
    decodeText,
    encodeText,
    detectEol,
    applyEol,
    DOC_EXTENSIONS,
    IMAGE_EXTENSIONS,
    hasExt,
} = require('./text.cjs');

const APP_SCHEME = 'marklet';
const IMAGE_SCHEME = 'marklet-local';
const APP_ORIGIN = `${APP_SCHEME}://app/`;
const DIST = path.join(__dirname, '..', 'dist-desktop');
/** 이보다 큰 파일은 열지 않는다. 문서 하나가 이만큼 크면 마크다운이 아니다. */
const MAX_BYTES = 64 * 1024 * 1024;
const ZOOM_LEVELS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const MAX_RECENT = 10;

/*
 * ★ 스킴 등록은 app 이 준비되기 **전에** 해야 한다. 그리고 file:// 로 곧바로 띄우지 않는 데에는
 *   이유가 있다 — CSP 의 script-src 'self' 가 file: 에서는 제대로 맞지 않고, 모듈 스크립트와
 *   동적 import(KaTeX · Mermaid 청크)가 출처 없는 페이지에서 막히는 일이 있다.
 *   표준 스킴 하나를 두고 거기서 서빙하면 모바일 WebView 와 같은 모양(https://localhost)이 된다.
 */
protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// ── 상태 (테마 · 확대 · 최근 문서 · 창 크기) ───────────────────────────

const stateFile = () => path.join(app.getPath('userData'), 'state.json');

const DEFAULT_STATE = { theme: 'system', zoom: 1, remoteImages: false, recent: [], bounds: null };
let state = { ...DEFAULT_STATE };

function loadState() {
    try {
        const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
        // ★ 저장된 값을 믿지 않는다. 깨진 값 하나가 부팅을 막으면 사용자는 앱 데이터를 지우러 간다.
        state = {
            theme: ['system', 'light', 'dark'].includes(raw.theme) ? raw.theme : 'system',
            zoom: ZOOM_LEVELS.includes(raw.zoom) ? raw.zoom : 1,
            remoteImages: raw.remoteImages === true,
            recent: Array.isArray(raw.recent)
                ? raw.recent.filter((p) => typeof p === 'string').slice(0, MAX_RECENT)
                : [],
            bounds:
                raw.bounds &&
                Number.isFinite(raw.bounds.width) &&
                Number.isFinite(raw.bounds.height)
                    ? raw.bounds
                    : null,
        };
    } catch {
        state = { ...DEFAULT_STATE };
    }
}

let saveTimer = null;
function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
            fs.writeFileSync(stateFile(), JSON.stringify(state));
        } catch (err) {
            console.error('상태 저장 실패:', err);
        }
    }, 200);
}

// ── 창 ─────────────────────────────────────────────────────────────────

/** webContents.id → { win, path, dir, ready, markReady, watcher } */
const windows = new Map();
let t = pickStrings('en');

function createWindow() {
    const b = state.bounds ?? { width: 980, height: 900 };
    // 창을 여럿 열면 겹치지 않게 조금씩 비껴 놓는다.
    const offset = windows.size * 28;
    const win = new BrowserWindow({
        width: b.width,
        height: b.height,
        x: Number.isFinite(b.x) ? b.x + offset : undefined,
        y: Number.isFinite(b.y) ? b.y + offset : undefined,
        minWidth: 360,
        minHeight: 280,
        show: false,
        title: 'Marklet',
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181c' : '#fbfbf9',
        autoHideMenuBar: true,
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            spellcheck: false,
        },
    });

    let markReady;
    const ready = new Promise((r) => (markReady = r));
    const info = {
        win,
        path: null,
        dir: null,
        ready,
        markReady,
        watcher: null,
        // ── 편집 · 저장 (파일을 읽을 때의 모양을 기억해 그대로 되돌려 쓴다)
        encoding: 'UTF-8',
        bom: false,
        eol: '\n',
        /** 마지막으로 읽거나 쓴 시점의 파일 수정 시각. 다른 곳에서 바뀌었는지 가린다. */
        mtime: null,
        dirty: false,
        /** 저장이 끝나면 이어서 할 일(닫기 · 다른 문서 열기) */
        afterSave: null,
        forceClose: false,
    };
    // ★ id 는 지금 잡아 둔다. 'closed' 가 불릴 때 win.webContents 는 이미 파괴돼 있어서
    //   거기서 읽으면 "Object has been destroyed" 로 메인 프로세스가 죽는다(2026-10-07 설치본에서 실제로 났다).
    const wcId = win.webContents.id;
    windows.set(wcId, info);

    win.once('ready-to-show', () => win.show());

    win.webContents.setWindowOpenHandler(({ url }) => {
        // 문서 안 링크는 기본 브라우저로 보낸다. 앱 창 안에서 남의 페이지를 열지 않는다.
        if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
        if (url.startsWith(APP_ORIGIN)) return;
        e.preventDefault();
        if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url);
    });
    // 제목은 우리가 정한다. 페이지 <title> 이 덮어쓰면 파일 이름이 사라진다.
    win.on('page-title-updated', (e) => e.preventDefault());

    win.webContents.on('did-finish-load', () => {
        win.webContents.setZoomFactor(state.zoom);
        sendSettings(win);
    });
    win.webContents.on('context-menu', (_e, params) => {
        popupContextMenu(win, !!params.selectionText);
    });

    win.on('focus', refreshMenu);
    win.on('close', (e) => {
        // ★ 저장하지 않은 편집이 있으면 창을 닫지 않고 먼저 묻는다. 안 묻으면 쓰던 글이 소리 없이 사라진다.
        if (info.dirty && !info.forceClose) {
            e.preventDefault();
            void askSaveThen(win, () => {
                info.forceClose = true;
                win.close();
            });
            return;
        }
        if (!win.isMaximized() && !win.isFullScreen()) {
            state.bounds = win.getBounds();
            saveState();
        }
    });
    win.on('closed', () => {
        info.watcher?.close();
        windows.delete(wcId);
        refreshMenu();
    });

    void win.loadURL(`${APP_ORIGIN}desktop.html`);
    return win;
}

/** 우클릭 메뉴. 떠오르는 컨트롤의 ⋮ 도 같은 것을 연다 — 메뉴를 두 벌 만들지 않는다. */
function popupContextMenu(win, hasSelection) {
    if (!win || win.isDestroyed()) return;
    const info = infoOf(win);
    Menu.buildFromTemplate(
        buildContextTemplate({ t, hasDoc: !!info?.path, hasSelection, actions: actions(win) }),
    ).popup({ window: win });
}

function infoOf(win) {
    return windows.get(win.webContents.id);
}

function sendSettings(win) {
    win.webContents.send('command', {
        name: 'settings',
        value: { theme: state.theme, remoteImages: state.remoteImages },
    });
}

// ── 문서 열기 ──────────────────────────────────────────────────────────

function isDocPath(p) {
    try {
        return hasExt(p, DOC_EXTENSIONS) && fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

/**
 * 파일 하나를 창에 띄운다. win 이 없으면 새 창을 만든다.
 * @returns 실제로 연 창 (실패하면 null)
 */
async function openFile(filePath, win, opts = {}) {
    const abs = path.resolve(filePath);
    if (!isDocPath(abs)) return null;

    const target = win && !win.isDestroyed() ? win : createWindow();
    const info = infoOf(target);
    await info.ready;

    // ★ 편집 중인 창에 다른 파일을 열면 쓰던 글이 사라진다. 먼저 묻는다(자동 갱신은 이 길로 오지 않는다).
    if (info.dirty && !opts.reload && info.path !== abs && !opts.force) {
        await askSaveThen(target, () => void openFile(abs, target, { force: true }));
        return null;
    }

    try {
        const stat = await fs.promises.stat(abs);
        if (stat.size > MAX_BYTES) {
            dialog.showErrorBox('Marklet', `${path.basename(abs)}: file is too large.`);
            return null;
        }
        const { text, encoding, bom } = decodeText(await fs.promises.readFile(abs));
        const changedFile = info.path !== abs;
        info.path = abs;
        info.dir = path.dirname(abs);
        info.encoding = encoding;
        info.bom = bom;
        info.eol = detectEol(text);
        info.mtime = stat.mtimeMs;
        info.dirty = false;
        updateTitle(info);
        target.webContents.send('document', {
            path: abs,
            name: path.basename(abs),
            dir: info.dir,
            size: stat.size,
            content: text,
            encoding,
            reload: !!opts.reload && !changedFile,
        });
        if (changedFile) watch(target, abs);
        if (!opts.reload) rememberRecent(abs);
        refreshMenu();
        return target;
    } catch (err) {
        dialog.showErrorBox('Marklet', `${path.basename(abs)}\n\n${err.message}`);
        return null;
    }
}

/** 창 제목 = 파일 이름. 저장하지 않은 편집이 있으면 앞에 ● 를 붙인다. */
function updateTitle(info) {
    if (info.win.isDestroyed() || !info.path) return;
    info.win.setTitle(`${info.dirty ? '● ' : ''}${path.basename(info.path)}`);
}

/**
 * 저장하지 않은 편집이 있을 때 묻는다 — 저장 · 저장 안 함 · 취소.
 * 저장을 고르면 렌더러에 저장을 시키고, **끝난 뒤에** proceed 를 부른다(saveDocument 의 afterSave).
 * 저장이 실패하거나 사용자가 취소하면 proceed 는 불리지 않고 창은 그대로 남는다.
 */
async function askSaveThen(win, proceed) {
    const info = infoOf(win);
    if (!info) return;
    const r = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: [t.dlgSave, t.dlgDontSave, t.dlgCancel],
        defaultId: 0,
        cancelId: 2,
        message: t.dlgSaveTitle,
        detail: info.path ? path.basename(info.path) : '',
    });
    if (r.response === 0) {
        info.afterSave = proceed;
        win.webContents.send('command', { name: 'save' });
    } else if (r.response === 1) {
        info.dirty = false;
        updateTitle(info);
        proceed();
    }
}

/**
 * 파일에 쓴다.
 *
 * ★ 열 때의 인코딩 · BOM · 줄바꿈 그대로 되돌려 쓴다. 한 글자도 안 고쳤는데 파일이 통째로 달라지면 안 된다.
 * ★ 임시 파일에 쓰고 이름을 바꿔 덮어쓴다. 쓰다가 멈춰도 원본은 온전하다.
 * ★ 열 때 이후 다른 곳에서 파일이 바뀌었으면 덮어쓰기 전에 묻는다.
 */
async function saveDocument(info, content) {
    const win = info.win;
    const abs = info.path;
    if (!abs) return { ok: false };

    try {
        const st = await fs.promises.stat(abs);
        if (info.mtime !== null && st.mtimeMs !== info.mtime) {
            const r = await dialog.showMessageBox(win, {
                type: 'warning',
                buttons: [t.dlgOverwrite, t.dlgCancel],
                defaultId: 1,
                cancelId: 1,
                message: t.dlgConflictTitle,
                detail: `${path.basename(abs)}\n${t.dlgConflictBody}`,
            });
            if (r.response !== 0) return { ok: false };
        }
    } catch {
        // 파일이 사라졌으면 새로 만든다.
    }

    const text = applyEol(content, info.eol);
    let buf = encodeText(text, info.encoding, info.bom);
    if (!buf) {
        // 이 인코딩(EUC-KR)으로 표현 못 하는 글자가 들어왔다(이모지 등). 몰래 깨뜨리지 않고 묻는다.
        const r = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: [t.dlgSaveUtf8, t.dlgCancel],
            defaultId: 1,
            cancelId: 1,
            message: t.dlgEncodingTitle,
            detail: t.dlgEncodingBody,
        });
        if (r.response !== 0) return { ok: false };
        info.encoding = 'UTF-8';
        info.bom = false;
        buf = encodeText(text, 'UTF-8', false);
    }

    const tmp = `${abs}.marklet-tmp`;
    try {
        await fs.promises.writeFile(tmp, buf);
        await fs.promises.rename(tmp, abs);
    } catch (err) {
        await fs.promises.unlink(tmp).catch(() => {});
        dialog.showErrorBox('Marklet', `${path.basename(abs)}\n\n${err.message}`);
        return { ok: false };
    }

    // 우리가 쓴 것이 감시에 다시 걸려 '다른 곳에서 바뀜' 으로 오인되지 않게 시각을 기억한다.
    info.mtime = (await fs.promises.stat(abs)).mtimeMs;
    info.dirty = false;
    updateTitle(info);
    const after = info.afterSave;
    info.afterSave = null;
    after?.();
    return { ok: true };
}

/**
 * 다른 편집기에서 저장하면 따라 바뀐다.
 * ★ 파일이 아니라 **폴더**를 지켜본다. 많은 편집기가 임시 파일에 쓰고 이름을 바꿔 저장하므로
 *   파일 하나에 건 감시는 첫 저장 뒤에 조용히 끊긴다.
 */
function watch(win, abs) {
    const info = infoOf(win);
    info.watcher?.close();
    const name = path.basename(abs);
    let timer = null;
    try {
        info.watcher = fs.watch(path.dirname(abs), { persistent: false }, (_ev, changed) => {
            if (changed !== name) return;
            clearTimeout(timer);
            timer = setTimeout(async () => {
                if (win.isDestroyed() || info.path !== abs) return;
                // ★ 편집 중이면 갱신하지 않는다. 쓰던 글 위에 디스크 내용을 덮어씌우면 안 된다.
                //   저장할 때 saveDocument 가 '다른 곳에서 바뀜' 을 물어본다.
                if (info.dirty) return;
                try {
                    // 우리가 방금 쓴 것이면 무시한다.
                    if ((await fs.promises.stat(abs)).mtimeMs === info.mtime) return;
                } catch {
                    return;
                }
                void openFile(abs, win, { reload: true });
            }, 150);
        });
        info.watcher.on('error', () => {});
    } catch {
        // 감시를 못 붙여도 문서는 열린다. 그냥 자동 갱신만 없다.
    }
}

function rememberRecent(abs) {
    state.recent = [abs, ...state.recent.filter((p) => p !== abs)].slice(0, MAX_RECENT);
    saveState();
    try {
        app.addRecentDocument(abs);
    } catch {
        /* 점프 목록은 덤이다 */
    }
}

async function openDialog(win) {
    const r = await dialog.showOpenDialog(win ?? undefined, {
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: 'Markdown', extensions: DOC_EXTENSIONS.map((e) => e.slice(1)) },
            { name: '*', extensions: ['*'] },
        ],
    });
    if (r.canceled) return;
    // 첫 파일은 지금 창에, 나머지는 새 창에.
    for (let i = 0; i < r.filePaths.length; i++) {
        await openFile(r.filePaths[i], i === 0 ? win : null);
    }
}

// ── 메뉴 · 동작 ────────────────────────────────────────────────────────

function actions(win) {
    return {
        open: () => void openDialog(win),
        openRecent: (p) => {
            if (isDocPath(p)) void openFile(p, win);
            else {
                state.recent = state.recent.filter((x) => x !== p);
                saveState();
                refreshMenu();
            }
        },
        clearRecent: () => {
            state.recent = [];
            saveState();
            refreshMenu();
        },
        reveal: () => {
            const i = win && infoOf(win);
            if (i?.path) shell.showItemInFolder(i.path);
        },
        copyPath: () => {
            const i = win && infoOf(win);
            if (i?.path) clipboard.writeText(i.path);
        },
        closeWindow: () => win?.close(),
        command: (name) => win?.webContents.send('command', { name }),
        zoom: (dir) => stepZoom(dir),
        setTheme: (theme) => {
            state.theme = theme;
            nativeTheme.themeSource = theme;
            saveState();
            for (const i of windows.values()) sendSettings(i.win);
            refreshMenu();
        },
        setRemoteImages: (on) => {
            state.remoteImages = !!on;
            saveState();
            for (const i of windows.values()) sendSettings(i.win);
            refreshMenu();
        },
        fullscreen: () => win?.setFullScreen(!win.isFullScreen()),
        // 윈도우는 기본 앱을 프로그램이 직접 바꾸지 못하게 막아 두었다. 그 설정 화면을 열어 준다.
        setDefault: () => void shell.openExternal('ms-settings:defaultapps'),
        about: () =>
            void dialog.showMessageBox(win ?? undefined, {
                type: 'info',
                title: 'Marklet',
                message: 'Marklet',
                detail: `v${app.getVersion()}`,
            }),
    };
}

function stepZoom(dir) {
    let i = ZOOM_LEVELS.indexOf(state.zoom);
    if (i < 0) i = ZOOM_LEVELS.indexOf(1);
    if (dir === 0) i = ZOOM_LEVELS.indexOf(1);
    else i = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, i + (dir > 0 ? 1 : -1)));
    state.zoom = ZOOM_LEVELS[i];
    saveState();
    for (const w of windows.values()) w.win.webContents.setZoomFactor(state.zoom);
}

function refreshMenu() {
    const focused = BrowserWindow.getFocusedWindow();
    const info = focused && windows.get(focused.webContents.id);
    const menu = Menu.buildFromTemplate(
        buildMenuTemplate({
            t,
            state,
            hasDoc: !!info?.path,
            // 메뉴는 앱 전체에 하나다. 동작은 '지금 초점이 있는 창'에 간다.
            actions: new Proxy(
                {},
                {
                    get:
                        (_o, key) =>
                        (...args) => {
                            const win = BrowserWindow.getFocusedWindow() ?? focused;
                            return actions(win)[key](...args);
                        },
                },
            ),
        }),
    );
    Menu.setApplicationMenu(menu);
}

// ── IPC (렌더러 → 메인). 보내는 쪽이 우리 페이지인지 매번 확인한다 ─────────

function trusted(e) {
    return !!e.senderFrame && e.senderFrame.url.startsWith(APP_ORIGIN);
}

ipcMain.on('renderer-ready', (e) => {
    if (!trusted(e)) return;
    windows.get(e.sender.id)?.markReady();
});

ipcMain.on('open-path', (e, p) => {
    if (!trusted(e) || typeof p !== 'string') return;
    const info = windows.get(e.sender.id);
    void openFile(p, info?.win);
});

ipcMain.on('dirty', (e, dirty) => {
    if (!trusted(e)) return;
    const info = windows.get(e.sender.id);
    if (!info) return;
    info.dirty = dirty === true;
    updateTitle(info);
});

ipcMain.handle('save', async (e, content) => {
    if (!trusted(e) || typeof content !== 'string') return { ok: false };
    const info = windows.get(e.sender.id);
    return info ? saveDocument(info, content) : { ok: false };
});

ipcMain.on('set-theme', (e, theme) => {
    if (!trusted(e) || !['system', 'light', 'dark'].includes(theme)) return;
    actions(windows.get(e.sender.id)?.win ?? null).setTheme(theme);
});

ipcMain.on('show-menu', (e) => {
    if (!trusted(e)) return;
    popupContextMenu(windows.get(e.sender.id)?.win, false);
});

ipcMain.on('zoom', (e, dir) => {
    if (!trusted(e)) return;
    stepZoom(dir > 0 ? 1 : dir < 0 ? -1 : 0);
});

/**
 * 문서 안의 상대 링크. 다른 .md 만 연다.
 * ★ 그 밖의 파일(.exe · .bat …)은 **열지 않는다.** 마크다운은 출처를 모르는 입력이다.
 */
ipcMain.on('open-link', (e, href) => {
    if (!trusted(e) || typeof href !== 'string') return;
    const info = windows.get(e.sender.id);
    if (!info?.dir || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
    let rel;
    try {
        rel = decodeURIComponent(href.split('#')[0].split('?')[0]);
    } catch {
        return;
    }
    if (!rel) return;
    void openFile(path.resolve(info.dir, rel), info.win);
});

// ── 앱 안의 두 스킴 ────────────────────────────────────────────────────

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.avif': 'image/avif',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';

function registerProtocols() {
    // 앱 자신: dist-desktop 안의 파일만 내준다.
    protocol.handle(APP_SCHEME, async (req) => {
        try {
            const url = new URL(req.url);
            const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'desktop.html';
            const full = path.normalize(path.join(DIST, rel));
            // ★ '..' 로 dist 밖을 읽지 못하게 한다.
            if (full !== DIST && !full.startsWith(DIST + path.sep)) {
                return new Response('forbidden', { status: 403 });
            }
            const data = await fs.promises.readFile(full);
            return new Response(data, { headers: { 'content-type': mimeOf(full) } });
        } catch {
            return new Response('not found', { status: 404 });
        }
    });

    // 문서가 참조하는 그림(상대 경로). 그림 확장자만 내준다.
    protocol.handle(IMAGE_SCHEME, async (req) => {
        try {
            const url = new URL(req.url);
            const file = path.normalize(decodeURIComponent(url.pathname).replace(/^\/+/, ''));
            if (!hasExt(file, IMAGE_EXTENSIONS)) return new Response('forbidden', { status: 403 });
            const data = await fs.promises.readFile(file);
            return new Response(data, { headers: { 'content-type': mimeOf(file) } });
        } catch {
            return new Response('not found', { status: 404 });
        }
    });
}

// ── 시작 ───────────────────────────────────────────────────────────────

/** 명령줄에서 문서 경로를 뽑는다. 개발 중(electron .)에는 앞의 인자 하나가 더 있다. */
function docsFromArgv(argv, cwd) {
    const args = argv.slice(app.isPackaged ? 1 : 2);
    return args
        .filter((a) => !a.startsWith('--') && !a.startsWith('-'))
        .map((a) => path.resolve(cwd, a))
        .filter(isDocPath);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    // 이미 떠 있는 앱에서 또 더블클릭하면 새 창으로 연다.
    app.on('second-instance', (_e, argv, cwd) => {
        const files = docsFromArgv(argv, cwd);
        if (files.length === 0) {
            const w = BrowserWindow.getAllWindows()[0];
            if (w) {
                if (w.isMinimized()) w.restore();
                w.focus();
            }
            return;
        }
        for (const f of files) void openFile(f, null);
    });

    app.whenReady().then(() => {
        loadState();
        t = pickStrings(app.getLocale());
        nativeTheme.themeSource = state.theme;
        registerProtocols();
        refreshMenu();

        const files = docsFromArgv(process.argv, process.cwd());
        if (files.length === 0) createWindow();
        else for (const f of files) void openFile(f, null);
    });

    app.on('window-all-closed', () => app.quit());
}
