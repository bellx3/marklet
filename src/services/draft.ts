import { Preferences } from '@capacitor/preferences';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { App } from '@capacitor/app';

/**
 * 편집 초안 (8-4절).
 *
 * ★ 핵심 결정: 편집 중에 원본 파일에 자동 저장하지 않는다.
 *   ① 원본 쓰기는 백업→쓰기→검증(5-6절)이라 비싸고 타이핑마다 돌릴 수 없다.
 *   ② 자동 저장은 '실수로 지운 것'까지 원본에 반영한다. 되돌릴 방법이 없다.
 *   대신 초안을 앱 내부에 자동 저장하고, 원본 쓰기는 [저장]을 누를 때만 한다.
 */

const INDEX_KEY = 'draftIndex';
const DEBOUNCE_MS = 800;

interface DraftIndex {
    [uri: string]: { path: string; savedAt: number };
}

/** djb2 변형. URI 를 파일 이름으로 쓸 수 있게 만든다. */
function draftPath(uri: string): string {
    let h = 5381;
    for (let i = 0; i < uri.length; i++) h = ((h * 33) ^ uri.charCodeAt(i)) >>> 0;
    return `draft/${h.toString(36)}.md`;
}

let pending: { uri: string; content: string } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** 타이핑마다 호출. 실제 쓰기는 디바운스된다. */
export function scheduleDraftSave(uri: string, content: string): void {
    pending = { uri, content };
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void flushDraft(), DEBOUNCE_MS);
}

/**
 * 앞선 쓰기가 끝날 때까지 줄을 세운다.
 *
 * ★★ 목록(index)은 **읽고-고치고-쓴다.** Preferences 는 JS↔네이티브 왕복이라
 *   두 flush 가 겹치면 나중 것이 앞 것을 못 본 채 목록을 통째로 덮어쓴다.
 *   그러면 초안 **파일은 남는데 목록이 가리키지 않는다** — readDraft 가 null 을
 *   돌려주니 "저장하지 않은 편집" 을 묻지도 않고, 사용자가 친 글이 조용히
 *   닿을 수 없는 곳으로 간다. 잃은 줄도 모르니 신고조차 안 된다.
 *
 *   겹치는 경로가 실제로 있다 — leaveEditor() 는 flushDraft() 를 기다리지 않고
 *   띄우고(그게 맞다, 화면을 붙잡을 이유가 없다), 곧바로 새 문서 편집이 시작된다.
 *   (2026-08-05 테스트로 재현)
 */
let writeQueue: Promise<void> = Promise.resolve();

/** 디바운스를 무시하고 즉시 쓴다. */
export function flushDraft(): Promise<void> {
    if (timer !== null) {
        clearTimeout(timer);
        timer = null;
    }
    const job = pending;
    pending = null;
    if (!job) return writeQueue;

    // ★ 앞 작업이 실패해도 줄이 끊기면 안 된다.
    writeQueue = writeQueue.then(
        () => writeDraft(job),
        () => writeDraft(job),
    );
    return writeQueue;
}

async function writeDraft(job: { uri: string; content: string }): Promise<void> {
    const path = draftPath(job.uri);
    try {
        await Filesystem.mkdir({
            path: 'draft',
            directory: Directory.Data,
            recursive: true,
        }).catch(() => {});
        await Filesystem.writeFile({
            path,
            directory: Directory.Data,
            data: job.content,
            encoding: Encoding.UTF8,
        });
        const index = await loadIndex();
        index[job.uri] = { path, savedAt: Date.now() };
        await Preferences.set({ key: INDEX_KEY, value: JSON.stringify(index) });
    } catch (err) {
        console.error('초안 저장 실패:', err);
    }
}

export async function readDraft(uri: string): Promise<string | null> {
    const index = await loadIndex();
    const entry = index[uri];
    if (!entry) return null;
    try {
        const f = await Filesystem.readFile({
            path: entry.path,
            directory: Directory.Data,
            encoding: Encoding.UTF8,
        });
        return f.data as string;
    } catch {
        return null;
    }
}

/** 초안이 저장된 시각. 다이얼로그에 "N분 전"을 쓰기 위한 것. */
export async function draftSavedAt(uri: string): Promise<number | null> {
    const index = await loadIndex();
    return index[uri]?.savedAt ?? null;
}

export async function clearDraft(uri: string): Promise<void> {
    /*
     * ★★ 대기 중인 쓰기를 **먼저 취소한다.** 안 그러면 지운 직후에 디바운스가 깨어나
     *   방금 지운 초안을 되살린다. 저장 직후가 정확히 그 상황이다 —
     *   마지막 타이핑에서 800ms 안에 [저장]을 누르면 pending 이 아직 살아 있다.
     *
     *   같은 파일에 저장했을 때는 초안 내용이 원본과 같아져서 resolveDraft 가 조용히
     *   지워 주지만, **[새 이름으로 저장] 에서는 그렇지 않다.** 옛 URI 의 초안이 되살아나
     *   나중에 그 파일을 열면 있지도 않은 "저장하지 않은 편집" 을 묻게 된다
     *   (2026-08-04 코드 점검에서 발견).
     */
    if (pending?.uri === uri) {
        pending = null;
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    }

    /*
     * ★ 지우기도 목록을 읽고-고치고-쓴다. 쓰기와 같은 줄에 세우지 않으면
     *   진행 중인 초안 저장과 겹쳐 서로의 변경을 덮어쓴다 — 지운 초안이
     *   되살아나거나, 남아야 할 초안이 목록에서 사라진다.
     */
    writeQueue = writeQueue.then(
        () => removeDraft(uri),
        () => removeDraft(uri),
    );
    return writeQueue;
}

async function removeDraft(uri: string): Promise<void> {
    const index = await loadIndex();
    const entry = index[uri];
    if (!entry) return;
    delete index[uri];
    await Preferences.set({ key: INDEX_KEY, value: JSON.stringify(index) });
    await Filesystem.deleteFile({ path: entry.path, directory: Directory.Data }).catch(() => {});
}

async function loadIndex(): Promise<DraftIndex> {
    try {
        const { value } = await Preferences.get({ key: INDEX_KEY });
        if (!value) return {};
        return JSON.parse(value) as DraftIndex;
    } catch {
        return {};
    }
}

// ────────────────────────────────────────────────────────────
// 백그라운드 전환 시 flush — 이걸 빠뜨리면 데이터가 사라진다
// ────────────────────────────────────────────────────────────

let unbind: (() => void) | null = null;

/**
 * 픽셀오아시스 커밋 be7e44f: saveProgress() 가 1초 디바운스인데 백그라운드 전환 시
 * flush 하지 않아, 프로세스가 회수되면 그 1초 안의 변경이 사라졌다. 사용자가 직접 보고했다.
 * 편집 앱에서는 더 치명적이다 — 홈키 한 번에 사용자 문서가 날아간다.
 *
 * ★ beforeunload 는 안드로이드 WebView 에서 믿을 수 없다. 쓰지 마라.
 */
export async function installDraftFlushHooks(): Promise<void> {
    if (unbind) return;

    const onVisibility = () => {
        if (document.visibilityState === 'hidden') void flushDraft();
    };
    document.addEventListener('visibilitychange', onVisibility);

    // visibilitychange 가 안 오는 경우를 대비한 두 번째 그물
    let removeAppListener: (() => void) | null = null;
    try {
        const handle = await App.addListener('appStateChange', ({ isActive }) => {
            if (!isActive) void flushDraft();
        });
        removeAppListener = () => void handle.remove();
    } catch {
        /* 웹 환경 */
    }

    // 붙였으면 떼는 것도 같이 쓴다 (픽셀오아시스 a811c3f: 리스너 해제 누락 누수)
    unbind = () => {
        document.removeEventListener('visibilitychange', onVisibility);
        removeAppListener?.();
    };
}

export function uninstallDraftFlushHooks(): void {
    unbind?.();
    unbind = null;
}
