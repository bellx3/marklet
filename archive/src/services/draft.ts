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

        /*
         * ★★★ **목록을 먼저 적고 파일을 나중에 쓴다** (2026-08-06).
         *
         *   예전에는 반대였다. 그러면 이런 순서가 난다 —
         *     ① writeFile 이 사용자 글을 디스크에 올린다
         *     ② Preferences.set 전에 앱이 저메모리로 죽는다
         *     ③ 파일은 있는데 목록이 그 파일을 모른다
         *     ④ 다음 부팅의 pruneDraftOrphans 가 '닿을 수 없는 파일' 로 보고 **지운다**
         *   ②의 창은 좁지만 ④가 지우는 것은 **저장하지 않은 사용자 글**이다.
         *   mtime 60초 가드는 동시 실행 경합만 막는다 — 죽었다가 1분 뒤에 돌아오면
         *   그대로 지워진다. 잃은 줄도 모르니 신고조차 안 된다.
         *
         *   순서를 뒤집으면 **파일이 목록에 없는 상태가 아예 안 생긴다.**
         *   중간에 죽으면 목록만 남고 파일이 없는데, 그건 readDraft 가 null 을 돌려
         *   "초안 없음" 으로 흐를 뿐 아무것도 잃지 않는다. 잃는 방향이 아니다.
         */
        const index = (await loadIndex()) ?? {};
        index[job.uri] = { path, savedAt: Date.now() };
        await Preferences.set({ key: INDEX_KEY, value: JSON.stringify(index) });

        await Filesystem.writeFile({
            path,
            directory: Directory.Data,
            data: job.content,
            encoding: Encoding.UTF8,
        });
    } catch (err) {
        console.error('초안 저장 실패:', err);
    }
}

export async function readDraft(uri: string): Promise<string | null> {
    const entry = (await loadIndex())?.[uri];
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
    return (await loadIndex())?.[uri]?.savedAt ?? null;
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
    // ★ 목록을 못 읽었으면 아무것도 지우지 않는다. 지우는 쪽이 되돌릴 수 없는 방향이다.
    if (!index) return;
    const entry = index[uri];
    if (!entry) return;
    delete index[uri];
    await Preferences.set({ key: INDEX_KEY, value: JSON.stringify(index) });
    await Filesystem.deleteFile({ path: entry.path, directory: Directory.Data }).catch(() => {});
}

/**
 * 목록이 가리키지 않는 초안 파일을 지운다.
 *
 * ★★ 이런 파일은 **닿을 수 없다.** readDraft 는 목록을 거쳐서만 파일을 찾으므로,
 *   목록에 없는 파일은 영원히 아무도 못 읽는다 — 자리만 차지한다.
 *   v1.0.3 이하에서 쓰기가 겹쳐 목록이 덮여 쓰인 기기에 실제로 남아 있을 수 있다.
 *
 * ★ 개수나 나이로 지우지 않는다. 그건 **저장 안 된 사용자 글을 조용히 버리는 것**이라
 *   이 앱이 하면 안 되는 일이다. 여기서 지우는 것은 이미 닿을 수 없게 된 것뿐이다.
 *
 * ★★ 반드시 쓰기 큐에 태운다. 안 그러면 이런 순서가 난다 —
 *     ① writeDraft 가 파일을 쓴다
 *     ② (목록 갱신 전) 정리가 끼어들어 "목록에 없네" 하고 **방금 쓴 초안을 지운다**
 *     ③ 목록에는 있는데 파일이 없다
 *   지우는 쪽이 데이터를 없애는 방향이라 더 나쁘다.
 */
export function pruneDraftOrphans(): Promise<void> {
    writeQueue = writeQueue.then(removeOrphanDrafts, removeOrphanDrafts);
    return writeQueue;
}

async function removeOrphanDrafts(): Promise<void> {
    try {
        const index = await loadIndex();
        /*
         * ★★★ 목록을 **못 읽었으면 한 개도 지우지 않는다.**
         *   예전에는 loadIndex 가 실패해도 {} 를 돌려줬다. 그러면 known 이 비어
         *   **디스크의 모든 초안이 '버려진 것' 으로 보이고 통째로 지워진다.**
         *   저장 한 번 안 된 사용자 글이 설정 하나 깨진 것 때문에 사라지는 셈이다.
         *   청소는 하면 좋은 것이지 꼭 해야 하는 것이 아니다 — 확신이 없으면 손을 뗀다.
         */
        if (!index) return;
        const known = new Set(Object.values(index).map((e) => e.path));

        const { files } = await Filesystem.readdir({
            path: 'draft',
            directory: Directory.Data,
        });

        for (const f of files) {
            const path = `draft/${f.name}`;
            if (known.has(path)) continue;
            /*
             * ★★ 갓 쓰인 파일은 건드리지 않는다 — **두 번째 그물이다.**
             *   writeDraft 가 목록을 먼저 적게 바뀌어서(위 주석) 이 창은 원래 닫혔다.
             *   그래도 남겨 둔다: 옛 버전이 남긴 파일, 그리고 아직 못 본 다른 순서.
             *   사본 쪽(recents.ts)에서는 같은 경합을 실기기로 잡았다(2026-08-06).
             *   쓰레기 수집기는 **확실히 버려진 것**만 건드려야 한다.
             */
            if (typeof f.mtime === 'number' && f.mtime > 0 && Date.now() - f.mtime < 60_000) {
                continue;
            }
            await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => {});
            console.warn('닿을 수 없는 초안을 정리했다:', path);
        }
    } catch {
        // 폴더가 아직 없거나 읽지 못했다. 정리는 하면 좋은 것이지 꼭 해야 하는 것이 아니다.
    }
}

/**
 * 저장된 목록을 **믿지 않는다.**
 *
 * ★★★ 읽지 못한 것과 '비어 있다'를 구분해서 돌려준다 — 못 읽었으면 null 이다.
 *   이게 중요한 이유는 removeOrphanDrafts 다. 그쪽은 "목록에 없는 파일"을 지우는데,
 *   목록을 못 읽어 {} 로 퉁치면 **모든 초안 파일이 한꺼번에 버려진 것으로 보인다.**
 *   그리고 지워진다. 설정·최근 문서는 검증 실패해도 기본값으로 되돌리면 그만이지만,
 *   초안은 되돌릴 원본이 없다 — 사용자가 아직 아무 데도 저장하지 않은 글이다.
 *
 * ★ 항목 하나가 망가진 것은 그것만 버린다. 나머지 초안까지 인질로 잡을 이유가 없다.
 */
async function loadIndex(): Promise<DraftIndex | null> {
    let value: string | null;
    try {
        ({ value } = await Preferences.get({ key: INDEX_KEY }));
    } catch {
        return null; // 네이티브를 못 불렀다. 비었다고 단정하면 안 된다.
    }
    if (!value) return {}; // 한 번도 쓴 적이 없다 — 이건 진짜로 비어 있는 것이다

    let raw: unknown;
    try {
        raw = JSON.parse(value);
    } catch {
        return null; // 깨진 JSON. 무엇이 있었는지 모른다.
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;

    const out: DraftIndex = {};
    for (const [uri, entry] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof entry !== 'object' || entry === null) continue;
        const { path, savedAt } = entry as { path?: unknown; savedAt?: unknown };
        if (typeof path !== 'string' || !path) continue;
        out[uri] = { path, savedAt: typeof savedAt === 'number' ? savedAt : 0 };
    }
    return out;
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
