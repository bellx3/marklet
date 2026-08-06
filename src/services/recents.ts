import { Preferences } from '@capacitor/preferences';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { MdFile, type MdDocument } from '../plugins/md-file';
import { mark, measure } from '../utils/perf';

/**
 * 최근 문서 (8-2절).
 *
 * ★ URI 문자열만 저장해서는 부족하다. ACTION_VIEW/ACTION_SEND 로 온 URI 는
 *   대개 영속화되지 않아 다음 실행에서 무효다. 영속화에 실패하면 **즉시 사본을 남기고**
 *   목록에 '읽기 전용 사본' 배지를 달아 보여준다. 목록에서 빼면
 *   "카톡으로 받은 문서가 목록에 없다"가 되고, 그건 앱이 고장난 것으로 보인다.
 */

const KEY = 'recentDocs';
/** 영속 URI 권한에는 앱당 상한이 있다(정확한 값 미확인). 넉넉히 아래로 잡는다. */
const MAX = 50;

export interface RecentDoc {
    uri: string;
    /** 표시 이름. URI 에서 다시 못 얻을 수 있으므로 따로 저장한다 */
    name: string;
    lastOpened: number;
    /** takePersistableUriPermission 성공 여부 */
    persisted: boolean;
    /** persisted 가 false 일 때 저장해 둔 사본 경로 */
    snapshotPath?: string;
    size: number;
    source: 'picker' | 'intent' | 'folder';
}

/**
 * 저장된 것을 **믿지 않고** 쓸 수 있는 항목만 남긴다.
 *
 * ★★★ 예전에는 `JSON.parse(value) as RecentDoc[]` 로 그대로 돌려줬다.
 *   그런데 배열이 아닌 값이 들어 있으면 시작 화면의 `recents.filter(...)` 가 터진다:
 *       TypeError: recents.filter is not a function
 *   이름이 없는 항목 하나만 있어도 `matchesName` 이 터진다:
 *       TypeError: Cannot read properties of null (reading 'normalize')
 *   둘 다 **시작 화면이 안 그려진다.** 저장된 값이라 켤 때마다 같은 자리에서 죽고,
 *   사용자는 앱 데이터를 지우는 것 말고는 길이 없다 — 설정 쪽과 같은 종류다(2026-08-06).
 *
 * ★ 못 쓰는 항목은 조용히 뺀다. 목록 한 줄이 사라지는 것과 앱이 안 켜지는 것은
 *   견줄 수 없다. (사본 파일은 pruneSnapshotOrphans 가 나중에 치운다.)
 */
function keepUsable(raw: unknown): RecentDoc[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is RecentDoc => {
        if (!r || typeof r !== 'object') return false;
        const v = r as Partial<RecentDoc>;
        return typeof v.uri === 'string' && typeof v.name === 'string';
    });
}

/**
 * 저장된 목록을 읽는다. **못 읽은 것과 비어 있는 것을 구분해서 돌려준다.**
 *
 * ★★★ 이 구분이 왜 필요한가 (2026-08-06). pruneSnapshotOrphans 는
 *   "목록이 안 가리키는 사본" 을 지운다. 그런데 못 읽은 것을 [] 로 퉁치면
 *   **모든 사본이 안 가리켜지는 것으로 보이고 통째로 지워진다.**
 *
 *   그리고 이건 JSON 이 깨진 드문 경우만이 아니다. Preferences.get 이 한 번
 *   실패하기만 해도 그렇다 — 그때 목록 자체는 멀쩡히 남아 있으므로,
 *   결과는 **목록은 그대로인데 그 사본들만 사라진** 상태다. 최근 목록에서 누르면
 *   "원본을 찾을 수 없습니다" 가 뜬다. 사본은 다시 못 여는 URI 의 **유일한 사본**이라
 *   카톡으로 받은 문서를 그대로 잃는다.
 *
 * ★ 화면에 뿌리는 쪽(loadRecents)은 지금까지대로 [] 로 흘러도 된다 — 한 번 못 읽은 것과
 *   비어 있는 것이 같아 보일 뿐 잃는 것이 없다. 지우는 쪽만 엄격해야 한다.
 */
type StoredRecents =
    /** 읽었다. 못 쓰는 항목은 이미 걸러졌다. */
    | { ok: true; list: RecentDoc[] }
    /** 네이티브를 못 불렀다 — **무엇이 있었는지 모른다.** 덮어쓰거나 지우면 안 된다. */
    | { ok: false; reason: 'native' }
    /** 값은 있는데 모양이 아니다 — 어차피 아무도 못 읽던 것이다. 새로 시작해도 된다. */
    | { ok: false; reason: 'corrupt' };

async function readStoredRecents(): Promise<StoredRecents> {
    let value: string | null;
    try {
        ({ value } = await Preferences.get({ key: KEY }));
    } catch {
        return { ok: false, reason: 'native' };
    }
    if (!value) return { ok: true, list: [] }; // 한 번도 쓴 적이 없다 — 진짜로 비어 있다

    let raw: unknown;
    try {
        raw = JSON.parse(value);
    } catch {
        return { ok: false, reason: 'corrupt' };
    }
    if (!Array.isArray(raw)) return { ok: false, reason: 'corrupt' };
    return { ok: true, list: keepUsable(raw) };
}

export async function loadRecents(): Promise<RecentDoc[]> {
    const stored = await readStoredRecents();
    return stored.ok ? stored.list : [];
}

async function saveRecents(list: RecentDoc[]): Promise<void> {
    try {
        await Preferences.set({ key: KEY, value: JSON.stringify(list) });
    } catch (err) {
        console.error('최근 문서 저장 실패:', err);
    }
}

/**
 * 갓 쓰인 파일인가.
 *
 * ★★★ 정리기는 **쓰는 쪽과 같은 순간에 돈다** (2026-08-06 실기기에서 잡았다).
 *   부팅 직후 pruneSnapshotOrphans() 가 뜨는 동안, 인텐트로 들어온 문서가
 *   rememberDoc() 으로 사본을 쓴다. rememberDoc 은 **파일을 먼저 쓰고 목록을 나중에**
 *   저장하므로, 그 사이에 정리기가 목록을 읽으면 방금 쓴 사본이 '아무도 안 가리키는
 *   파일' 로 보인다 — 그리고 지운다.
 *
 *   실기기 증거: 목록은 `snapshot/haeqg4-mk-normal-500.md` 를 가리키는데
 *   파일은 없었다. 사본은 **다시 못 여는 URI 의 유일한 사본**이다. 그게 사라지면
 *   최근 목록에서 그 문서를 여는 순간 "원본을 찾을 수 없습니다" 가 뜬다 —
 *   카톡으로 받은 문서를 다시 못 보게 되는 것이다.
 *
 * ★ 순서를 바꿔 좁히는 것으로는 부족하다. 이건 **쓰레기 수집기**이고,
 *   쓰레기 수집기는 '확실히 버려진 것' 만 건드려야 한다.
 *   최근에 손댄 파일은 그냥 다음 기회로 미룬다 — 급할 것이 없는 일이다.
 */
const RECENTLY_WRITTEN_MS = 60_000;

function justWritten(mtime: number | undefined): boolean {
    if (typeof mtime !== 'number' || mtime <= 0) return false;
    return Date.now() - mtime < RECENTLY_WRITTEN_MS;
}

/** 사본 파일 하나를 지운다. 없어도 조용히 넘어간다. */
async function dropSnapshot(path: string | undefined): Promise<void> {
    if (!path) return;
    await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => {});
}

export async function rememberDoc(
    doc: MdDocument,
    content: string,
    source: RecentDoc['source'],
): Promise<void> {
    /*
     * ★★★ 목록을 못 읽었으면 **아무것도 쓰지 않는다** (2026-08-06).
     *
     *   여기는 읽고-고치고-쓴다. 못 읽은 것을 [] 로 퉁치면 아래에서
     *   `saveRecents(list.slice(0, MAX))` 가 **최근 목록 전체를 이번 문서 하나로
     *   덮어쓴다.** 문서 하나 연 것으로 나머지가 통째로 날아가고, 그 항목들의 사본은
     *   참조를 잃어 정리기가 나중에 지운다 — 카톡으로 받아 둔 문서들을 그대로 잃는다.
     *
     *   이번 문서를 최근 목록에 못 남기는 것은 다음에 열면 회복된다.
     *   목록을 덮어쓰는 것은 회복되지 않는다. 잃지 않는 쪽으로 기운다.
     *
     * ★ 'corrupt' 는 다르다. 그 값은 이미 아무도 못 읽던 것이라 새로 시작하는 편이 낫다 —
     *   안 그러면 최근 목록이 영영 안 쌓인다.
     */
    const stored = await readStoredRecents();
    if (!stored.ok && stored.reason === 'native') return;
    const all = stored.ok ? stored.list : [];
    const list = all.filter((r) => r.uri !== doc.uri);

    /*
     * ★★ 같은 URI 의 옛 항목을 목록에서 빼면 **그 사본 파일은 참조를 잃는다.**
     *   지우지 않으면 영영 남는다 — 다시 못 여는 URI 는 열 때마다 새 사본을 만들므로
     *   같은 문서를 스무 번 열면 사본 스무 개 중 열아홉 개가 쓰레기다.
     *   (ACTION_VIEW 로 온 URI 는 영속 권한을 못 받는데, 파일 관리자에서 같은 파일을
     *    다시 여는 것은 아주 흔한 일이다. URI 는 대개 그대로다.)
     *
     * ★ 초안(pruneDraftOrphans)에는 이 정리가 있었는데 사본에는 없었다.
     */
    const nextPath = snapshotPathFor(doc.uri, doc.name);
    // 이번에 남길 사본. 이제 원본을 다시 열 수 있으면(persisted) 사본은 필요 없다.
    const keeping = doc.persisted ? undefined : nextPath;
    for (const old of all) {
        if (old.uri === doc.uri && old.snapshotPath !== keeping) {
            await dropSnapshot(old.snapshotPath);
        }
    }

    let snapshotPath: string | undefined;
    if (!doc.persisted) {
        // 다시 못 열 URI 다. 지금 사본을 만들어 둔다.
        snapshotPath = nextPath;
        try {
            await Filesystem.mkdir({
                path: 'snapshot',
                directory: Directory.Data,
                recursive: true,
            }).catch(() => {});
            await Filesystem.writeFile({
                path: snapshotPath,
                directory: Directory.Data,
                data: content,
                encoding: Encoding.UTF8,
            });
        } catch {
            snapshotPath = undefined;
        }
    }

    list.unshift({
        uri: doc.uri,
        name: doc.name,
        lastOpened: Date.now(),
        persisted: !!doc.persisted,
        snapshotPath,
        size: doc.size,
        source,
    });

    // 넘치는 항목은 권한까지 반납해서 상한에 걸리지 않게 한다.
    for (const dropped of list.slice(MAX)) {
        if (dropped.persisted) await MdFile.releaseUri({ uri: dropped.uri }).catch(() => {});
        await dropSnapshot(dropped.snapshotPath);
    }

    await saveRecents(list.slice(0, MAX));
}

/**
 * 목록에서 아무도 가리키지 않는 사본 파일을 지운다.
 *
 * ★ 첫 화면 뒤에 조용히 돈다. 실패해도 아무 일도 안 일어난다 —
 *   초안 쪽 pruneDraftOrphans() 와 같은 자리, 같은 이유다.
 * ★★ 이미 새어 나간 것들을 치우려면 이게 필요하다. rememberDoc 을 고쳐도
 *   **어제까지 쌓인 사본은 그대로 남는다.**
 */
export async function pruneSnapshotOrphans(): Promise<void> {
    try {
        const stored = await readStoredRecents();
        /*
         * ★★ 목록을 못 읽었으면 한 개도 지우지 않는다 — 깨진 경우도 마찬가지다.
         *   깨진 목록의 사본은 '어차피 못 여는 것' 이 맞지만, 그 판단이 틀렸을 때
         *   잃는 것은 **다시 못 여는 URI 의 유일한 사본**이다. 청소는 미뤄도 되는 일이고
         *   지우는 것은 되돌릴 수 없다. 다음에 제대로 읽히면 그때 치운다.
         */
        if (!stored.ok) return;
        const used = new Set(
            stored.list
                .map((r) => r.snapshotPath)
                .filter((p): p is string => typeof p === 'string'),
        );
        const { files } = await Filesystem.readdir({
            path: 'snapshot',
            directory: Directory.Data,
        });
        for (const f of files) {
            const path = `snapshot/${f.name}`;
            if (used.has(path)) continue;
            if (justWritten(f.mtime)) continue; // 쓰는 중일 수 있다(아래 주석)
            await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => {});
        }
    } catch {
        // 폴더가 아직 없거나 웹 환경이다. 할 일이 없다.
    }
}

/** 파일 이름에 쓸 수 없는 문자를 없앤다. 사본 경로가 깨지면 조용히 실패한다. */
export function sanitizeFileName(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'doc.md';
}

/**
 * 사본이 놓일 자리. **같은 문서는 늘 같은 자리다.**
 *
 * ★★ 예전에는 `Date.now()` 를 앞에 붙였다. 그래서 같은 문서를 다시 열 때마다
 *   **새 파일이 생기고 옛 파일은 참조를 잃었다.** 게다가 같은 밀리초에 이름이 같은
 *   두 문서가 들어오면 경로가 겹쳐서 **한쪽이 다른 쪽의 내용을 보게** 된다.
 *   URI 로 자리를 정하면 두 문제가 같이 사라진다 — 다시 열면 제자리에 덮어쓴다.
 *
 * ★ 이름을 함께 남기는 이유는 진단 화면에서 사람이 알아볼 수 있어야 하기 때문이다.
 *   (이름이 바뀌면 경로도 바뀌므로 옛 파일은 rememberDoc 이 지운다.)
 */
function snapshotPathFor(uri: string, name: string): string {
    let h = 5381; // djb2 변형 — save.ts backupName 과 같은 방식
    for (let i = 0; i < uri.length; i++) h = ((h * 33) ^ uri.charCodeAt(i)) >>> 0;
    return `snapshot/${h.toString(36)}-${sanitizeFileName(name)}`;
}

/**
 * 앱 시작 시 1회. 저장된 목록과 실제 권한을 대조한다.
 * 사용자가 파일을 지웠거나 권한이 회수된 항목을 표시하기 위한 것.
 */
export async function reconcileRecents(): Promise<RecentDoc[]> {
    const list = await loadRecents();
    if (list.length === 0) return list;

    let live: Set<string>;
    try {
        const { uris } = await MdFile.getPersistedUris();
        live = new Set(uris.map((u) => u.uri));
    } catch {
        // 브라우저(npm run dev)에는 네이티브가 없다. 저장된 값을 그대로 믿는다.
        return list;
    }

    /*
     * ★ 정확히 일치하는 것만 보면 **폴더 안의 파일이 전부 탈락한다.**
     *   폴더는 트리 URI 하나로 권한을 받고(`.../tree/<트리ID>`),
     *   그 안의 파일은 `.../tree/<트리ID>/document/<문서ID>` 처럼 트리 URI 로 시작한다.
     *   즉 트리 권한이 살아 있으면 그 아래 파일도 다시 열린다.
     */
    const trees = [...live].filter((u) => u.includes('/tree/'));
    const stillOpenable = (uri: string) => live.has(uri) || trees.some((t) => uri.startsWith(t));

    const merged = list.map((r) => ({ ...r, persisted: stillOpenable(r.uri) }));
    await saveRecents(merged);
    return merged;
}

/** 최근 항목 열기: 원본 → 사본 순으로 시도한다. */
export async function openRecent(
    r: RecentDoc,
): Promise<{ doc: MdDocument; content: string; fromSnapshot: boolean } | null> {
    try {
        // 진단 화면에 읽기 시간이 남게 한다(12-3절). 최근 문서가 가장 흔한 재열기 경로다.
        mark('doc:read');
        const doc = await MdFile.read({ uri: r.uri });
        measure('doc:read', 'doc:read');
        return { doc, content: doc.content ?? '', fromSnapshot: false };
    } catch {
        if (!r.snapshotPath) return null;
        try {
            const f = await Filesystem.readFile({
                path: r.snapshotPath,
                directory: Directory.Data,
                encoding: Encoding.UTF8,
            });
            const doc: MdDocument = {
                uri: r.uri,
                name: r.name,
                size: r.size,
                mimeType: 'text/markdown',
                writable: false, // ★ 사본은 절대 저장 대상이 아니다
                persisted: false,
            };
            return { doc, content: f.data as string, fromSnapshot: true };
        } catch {
            return null;
        }
    }
}

/**
 * 한 줄을 지운다. **못 읽었으면 null 을 돌려주고 아무것도 하지 않는다.**
 *
 * ★★ [] 를 돌려주면 안 된다. 그러면 호출한 화면이 그것을 새 목록으로 알고
 *   **최근 문서를 통째로 지운 것처럼 그린다.** 게다가 여기서 [] 로 흐르면
 *   target 을 못 찾아 권한도 사본도 안 치우면서 목록만 빈 것으로 덮어쓴다 —
 *   사용자는 한 줄을 지우려 했는데 전부 사라진다.
 *   지우기가 한 번 안 되는 것은 다시 누르면 되지만, 이건 안 그렇다.
 */
export async function removeRecent(uri: string): Promise<RecentDoc[] | null> {
    const stored = await readStoredRecents();
    if (!stored.ok && stored.reason === 'native') return null;
    const list = stored.ok ? stored.list : [];
    const target = list.find((r) => r.uri === uri);
    if (target?.persisted) await MdFile.releaseUri({ uri }).catch(() => {});
    if (target?.snapshotPath) {
        await Filesystem.deleteFile({
            path: target.snapshotPath,
            directory: Directory.Data,
        }).catch(() => {});
    }
    const next = list.filter((r) => r.uri !== uri);
    await saveRecents(next);
    return next;
}

export async function clearRecents(): Promise<void> {
    for (const r of await loadRecents()) {
        if (r.persisted) await MdFile.releaseUri({ uri: r.uri }).catch(() => {});
        if (r.snapshotPath) {
            await Filesystem.deleteFile({
                path: r.snapshotPath,
                directory: Directory.Data,
            }).catch(() => {});
        }
    }
    await saveRecents([]);
}
