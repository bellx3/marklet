/**
 * Tauri 판의 preload. Electron 판에서 desktop/preload.cjs 가 contextBridge 로 내밀던 `window.marklet` 을
 * Tauri 의 invoke(렌더러 → Rust)와 listen(Rust → 렌더러)으로 채운다.
 *
 * ★ 렌더러(src/desktop/main.ts)는 이 파일을 모른다. `window.marklet` 의 모양(bridge.ts)만 안다 —
 *   그래서 두 판이 같은 렌더러를 쓴다. main.ts 보다 **먼저** 실행돼야 한다(tauri-entry.ts 가 순서를 지킨다).
 * ★ 이 파일이 하는 일은 Electron 판에서 메인 프로세스 · 메뉴가 하던 일을 렌더러 쪽에서 메우는 것이다.
 *     · 단축키(메뉴 accelerator)   → shortcuts.ts
 *     · Alt 로 메뉴 막대 보이기      → toggle_menu 명령
 *     · 웹 링크를 기본 브라우저로    → window.open 가로채기
 *     · 문서 폴더의 그림 주소        → marklet-local 주소를 WebView2 가 아는 http://marklet-local.localhost 로
 */
import type { DesktopCommand, DesktopDoc, MarkletBridge } from './bridge';
import { shortcutFor } from './shortcuts';

interface TauriGlobal {
    core: {
        invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
        convertFileSrc(path: string, protocol?: string): string;
    };
    event: {
        listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<() => void>;
    };
}

declare global {
    interface Window {
        __TAURI__?: TauriGlobal;
    }
}

export function installTauriBridge(): void {
    const tauri = window.__TAURI__;
    // Tauri 밖(브라우저에서 열었거나 Electron)에서는 아무것도 하지 않는다. Electron 은 이미 window.marklet 이 있다.
    if (!tauri || window.marklet) return;
    const { invoke, convertFileSrc } = tauri.core;
    const { listen } = tauri.event;

    /** listen 은 비동기다. 등록이 끝나기 전에 ready 를 부르면 첫 문서를 놓친다. */
    const listening: Promise<unknown>[] = [];
    let onCommand: ((c: DesktopCommand) => void) | null = null;
    let docName = '';

    /** 문서마다 다른 이름이어야 한다 — 같은 이름이면 앞 문서의 알림(buffered)이 지금 문서의 것으로 오인된다. */
    let docSeq = 0;

    /**
     * 첫 블록이 DOM 에 들어가고, 그것을 그린 프레임이 **화면에 실제로 올라갔다는 알림**(Element Timing)까지 기다린다.
     * rAF 는 프레임을 만들기 *시작*할 때 불려서, 그것만 믿고 미리보기를 걷으면 아직 안 올라간 빈 프레임이 잠깐 비친다.
     * first-contentful-paint 는 페이지가 처음 뜰 때 한 번뿐이라, 숨겨 두었다가 다시 쓰는 창(문서가 바뀐다)에는 쓸 수 없다.
     * 알림이 안 오는 경우(블록에 글이 없다 · 지원하지 않는다)도 영영 기다리지 않게 0.4초, 문서가 아예 안 붙는 경우는 2.5초 상한을 둔다.
     */
    function firstPaint(): Promise<void> {
        return new Promise((resolve) => {
            // 글이 붙는 조각(.md-chunk) 자체를 본다. 서식 없이 보는 문서(.txt)는 조각이 <pre> 하나라 그 안에 자식 요소가 없다.
            const content = () => document.querySelector('.md-target .md-chunk, .md-frontmatter');
            const name = `marklet-first-block-${++docSeq}`;
            const watch = (root: Element) => {
                let po: PerformanceObserver | null = null;
                let timer = 0;
                const done = () => {
                    clearTimeout(timer);
                    po?.disconnect();
                    resolve();
                };
                try {
                    po = new PerformanceObserver((list) => {
                        if (
                            list
                                .getEntries()
                                .some(
                                    (e) =>
                                        (e as PerformanceEntry & { identifier?: string })
                                            .identifier === name,
                                )
                        ) {
                            done();
                        }
                    });
                    po.observe({ type: 'element', buffered: true });
                    // 위쪽 몇 블록에 달아 둔다. 첫 블록이 글 없는 것(가로줄 · 그림)이어도 다음 것이 알려 준다.
                    const blocks = root.children.length
                        ? Array.from(root.children).slice(0, 4)
                        : [root];
                    for (const b of blocks) b.setAttribute('elementtiming', name);
                } catch {
                    done();
                    return;
                }
                timer = window.setTimeout(done, 400);
            };
            const now = content();
            if (now) return watch(now);
            const mo = new MutationObserver(() => {
                const c = content();
                if (c) {
                    mo.disconnect();
                    watch(c);
                }
            });
            mo.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => {
                mo.disconnect();
                resolve();
            }, 2500);
        });
    }

    const bridge: MarkletBridge = {
        ready() {
            void Promise.all(listening).then(() => invoke('ready'));
        },
        onDocument(cb) {
            listening.push(
                listen<DesktopDoc>('document', (e) => {
                    // 문서를 받았다는 표시. 숨겨 두었다가 다시 쓰는 창이 살아 있는지를 Rust 가 이것으로 안다.
                    void invoke('received');
                    docName = e.payload.name;
                    cb(e.payload);
                    // 메인이 알리라고 한 문서가 화면에 그려지면 Rust 에 알린다. 네이티브 미리보기를 걷고 이 창을 보이는 신호다.
                    if (e.payload.announce) {
                        void firstPaint().then(async () => {
                            // 미리보기에서 이미 내려 읽고 있었으면 Rust 가 그 자리(CSS px)를 돌려준다 — 그 자리로 가서 넘긴다.
                            // 0 이면 Rust 가 이미 넘겼다(보통은 이쪽이다).
                            const y = await invoke<number>('painted');
                            if (y > 0.5) {
                                window.scrollTo(0, y);
                                await new Promise<void>((r) =>
                                    requestAnimationFrame(() => requestAnimationFrame(() => r())),
                                );
                                void invoke('swap');
                            }
                        });
                    }
                }),
            );
        },
        onCommand(cb) {
            onCommand = cb;
            listening.push(listen<DesktopCommand>('command', (e) => cb(e.payload)));
        },
        // 끌어다 놓기는 Tauri 가 창에서 직접 받아 Rust 가 연다(WindowEvent::DragDrop). 렌더러의 drop 은 오지 않는다.
        openPath() {},
        openLink: (href) => void invoke('open_link', { href }),
        zoom: (dir) => void invoke('zoom', { dir }),
        setTheme: (theme) => void invoke('set_theme', { theme }),
        run: (name) => void invoke('run', { name }),
        setDirty: (dirty) => void invoke('set_dirty', { dirty }),
        save: (content) => invoke<{ ok: boolean }>('save', { content }),
        async print(mode) {
            if (mode === 'pdf') return invoke<{ ok: boolean }>('print', { mode });
            // 미리보기: WebView2 가 Edge 와 같은 인쇄 미리보기 창을 띄운다(쪽 넘기기 · 배율 · PDF 로 저장).
            // 'PDF 로 저장'의 기본 파일 이름이 문서 제목이므로, 인쇄하는 동안만 제목을 문서 이름으로 둔다.
            const prev = document.title;
            if (docName) document.title = docName.replace(/\.[^.]+$/, '');
            await new Promise<void>((resolve) => {
                const done = () => {
                    window.removeEventListener('afterprint', done);
                    resolve();
                };
                window.addEventListener('afterprint', done);
                window.print();
                // afterprint 가 안 오는 환경에서도 영영 기다리지 않는다.
                setTimeout(done, 10 * 60 * 1000);
            });
            document.title = prev;
            return { ok: true };
        },
    };
    window.marklet = bridge;

    // ── 단축키 ─────────────────────────────────────────────────────────────
    window.addEventListener('keydown', (e) => {
        const s = shortcutFor(e);
        if (!s) return;
        e.preventDefault();
        if (s.kind === 'command') onCommand?.({ name: s.name });
        else if (s.kind === 'zoom') bridge.zoom(s.dir);
        else void invoke('run', { name: s.name });
    });

    // ── Alt: 메뉴 막대 ─────────────────────────────────────────────────────
    // Alt 만 눌렀다 떼면 보이고(또는 숨기고), Alt+다른 키는 그 키의 일이다.
    let altSolo = false;
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Alt') {
            if (!e.repeat) altSolo = true;
        } else {
            altSolo = false;
        }
    });
    window.addEventListener('keyup', (e) => {
        if (e.key === 'Alt' && altSolo) {
            altSolo = false;
            e.preventDefault();
            void invoke('toggle_menu');
        }
    });
    window.addEventListener('blur', () => (altSolo = false));

    // ── 웹 링크 → 기본 브라우저 ───────────────────────────────────────────────
    // 문서 안 웹 링크는 viewer.ts 가 window.open 으로 연다. 앱 창 안에서 남의 페이지를 열지 않는다.
    window.open = ((url?: string | URL) => {
        const u = String(url ?? '');
        if (/^(https?|mailto|tel):/i.test(u)) void invoke('open_external_url', { url: u });
        return null;
    }) as typeof window.open;

    // ── 문서 폴더의 그림 ───────────────────────────────────────────────────
    // 렌더러(local-image.ts)는 `marklet-local://f/<경로>` 를 만든다. WebView2 는 사용자 스킴을 몰라서
    // Tauri 가 `http://marklet-local.localhost/<경로>` 로 푼다. setAttribute 에서 한 번에 바꿔 준다.
    const base = convertFileSrc('x', 'marklet-local').replace(/x$/, '');
    const OLD = 'marklet-local://f/';
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name: string, value: string): void {
        if (name === 'src' && typeof value === 'string' && value.startsWith(OLD)) {
            value = `${base}f/${value.slice(OLD.length)}`;
        }
        setAttribute.call(this, name, value);
    };
}

installTauriBridge();
