import { Preferences } from '@capacitor/preferences';
import { MdFile, type MdDocument } from '../plugins/md-file';
import { t, localeTag } from '../i18n';

/**
 * 내 폴더 (8-3절, M32) — 킬러 기능.
 *
 * 폴더(tree URI)는 영속 권한이 확실히 잡히므로 최근 문서와 분리해서 관리한다.
 * 앱을 열 때마다 listFolder() 로 갱신하면 사용자가 PC 에서 새로 만든 .md 도 자동으로
 * 나타난다. 경쟁 앱 대부분이 파일 하나씩만 여는 방식이라 여기서 차별화된다.
 */

const KEY = 'folders';

export interface Folder {
    uri: string;
    name: string;
    addedAt: number;
}

/**
 * 저장된 것을 **믿지 않고** 쓸 수 있는 폴더만 남긴다.
 *
 * ★ 배열이 아니면 시작 화면의 `folders.map(...)` 이 터지고, 이름이 없는 항목 하나면
 *   `matchesName` 이 터진다 — 둘 다 **시작 화면이 안 그려진다.** 저장된 값이라
 *   켤 때마다 같은 자리에서 죽는다(recents.ts keepUsable 주석과 같은 이유).
 */
function keepUsable(raw: unknown): Folder[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((f): f is Folder => {
        if (!f || typeof f !== 'object') return false;
        const v = f as Partial<Folder>;
        return typeof v.uri === 'string' && typeof v.name === 'string';
    });
}

/**
 * 저장된 목록을 읽는다. **못 읽은 것과 비어 있는 것을 구분한다.**
 *
 * ★★★ 이 파일도 읽고-고치고-쓴다(2026-08-06). 못 읽은 것을 [] 로 퉁치면
 *   addFolder 가 **다른 폴더를 전부 지우고 방금 것 하나만 남기고**,
 *   removeFolder 는 한 폴더를 지우려다 목록을 빈 것으로 덮어쓴다.
 *   폴더는 사용자가 시스템 선택기로 하나씩 골라 권한을 받아 둔 것이라,
 *   목록이 날아가면 전부 다시 골라야 한다.
 *
 * ★ 화면에 뿌리는 loadFolders 는 지금까지대로 [] 로 흘러도 된다 — 잃는 것이 없다.
 *   쓰는 쪽과 권한을 반납하는 쪽만 엄격해야 한다. (최근 문서 쪽과 같은 판단이다.)
 */
type StoredFolders =
    | { ok: true; list: Folder[] }
    /** 네이티브를 못 불렀다 — 무엇이 있었는지 모른다. */
    | { ok: false; reason: 'native' }
    /** 값은 있는데 모양이 아니다 — 어차피 아무도 못 읽던 것이다. */
    | { ok: false; reason: 'corrupt' };

async function readStoredFolders(): Promise<StoredFolders> {
    let value: string | null;
    try {
        ({ value } = await Preferences.get({ key: KEY }));
    } catch {
        return { ok: false, reason: 'native' };
    }
    if (!value) return { ok: true, list: [] };

    let raw: unknown;
    try {
        raw = JSON.parse(value);
    } catch {
        return { ok: false, reason: 'corrupt' };
    }
    if (!Array.isArray(raw)) return { ok: false, reason: 'corrupt' };
    return { ok: true, list: keepUsable(raw) };
}

export async function loadFolders(): Promise<Folder[]> {
    const stored = await readStoredFolders();
    return stored.ok ? stored.list : [];
}

async function persistFolders(list: Folder[]): Promise<void> {
    try {
        await Preferences.set({ key: KEY, value: JSON.stringify(list) });
    } catch (err) {
        console.error('폴더 목록 저장 실패:', err);
    }
}

export async function addFolder(): Promise<Folder | null> {
    const res = await MdFile.pickFolder();
    if (res.cancelled) return null;
    if (!res.persisted) {
        // 영속화가 안 된 폴더는 다음 실행에서 못 읽는다. 목록에 넣지 않는다.
        throw new Error(t.folders.noPermission);
    }
    /*
     * ★★ 목록을 못 읽었으면 **덮어쓰지 않고 사용자에게 알린다.**
     *   조용히 [] 로 흐르면 방금 고른 폴더 하나만 남고 나머지가 사라진다 —
     *   폴더를 하나 더한 결과가 '다른 폴더가 전부 없어짐' 이면 안 된다.
     *   (권한 자체는 살아 있으므로 다시 시도하면 된다. 그래서 던진다.)
     */
    const stored = await readStoredFolders();
    if (!stored.ok && stored.reason === 'native') throw new Error(t.folders.listUnavailable);
    const list = (stored.ok ? stored.list : []).filter((f) => f.uri !== res.uri);
    const folder: Folder = { uri: res.uri, name: res.name, addedAt: Date.now() };
    list.unshift(folder);
    await persistFolders(list);
    return folder;
}

/** 폴더 하나를 뺀다. **못 읽었으면 null 을 돌려주고 아무것도 하지 않는다.** */
export async function removeFolder(uri: string): Promise<Folder[] | null> {
    /*
     * ★★★ **목록을 먼저 읽고, 그다음에 권한을 반납한다** (2026-08-06).
     *
     *   예전에는 반대였다. 그러면 읽기가 실패했을 때 이미 권한을 놓아 버린 뒤라
     *   되돌릴 수 없고, 이어서 [] 를 저장해 **폴더 목록까지 통째로 덮어썼다.**
     *   폴더 하나를 빼려던 사용자가 등록해 둔 폴더를 전부 잃는다 —
     *   하나씩 시스템 선택기로 다시 골라야 한다.
     *
     *   반납은 되돌릴 수 없는 쪽이므로 **확실해진 다음에** 한다.
     */
    const stored = await readStoredFolders();
    if (!stored.ok && stored.reason === 'native') return null;
    const before = stored.ok ? stored.list : [];
    const list = before.filter((f) => f.uri !== uri);

    await MdFile.releaseUri({ uri }).catch(() => {});
    await persistFolders(list);
    return list;
}

export interface FolderListing {
    folder: Folder;
    files: MdDocument[];
    error?: string;
    /**
     * 네이티브가 상한에서 멈췄다.
     *
     * ★★ 이걸 화면까지 올리지 않으면 **조용히 잘린다.** 사용자는 폴더에 파일이 더 있는데
     *   목록에 없는 것을 보고 "이 앱이 내 파일을 못 찾는다" 고 판단한다.
     *   원인은 화면 어디에도 안 남고, 문의를 받아도 물어볼 게 없다.
     */
    truncated?: boolean;
    /** 상한 값. 안내 문구에 숫자를 넣기 위한 것 — 코드에 박아 두면 네이티브와 어긋난다. */
    limit?: number;
    /**
     * 깊이 상한에 걸려 **들여다보지 않은 하위 폴더가 있었는가.**
     *
     * ★ 개수 상한(위)과 증상이 똑같다. 개수는 알려 주면서 깊이는 조용히 넘어가고 있었다 —
     *   옵시디언처럼 폴더를 겹겹이 쓰는 사람이 바로 걸린다(2026-08-06).
     */
    depthLimited?: boolean;
    /** 그 깊이 값 */
    maxDepth?: number;
}

/** 폴더 내용을 읽는다. 권한이 만료된 폴더는 error 를 담아 돌려준다(목록에서 지우지 않는다). */
export async function listFolder(folder: Folder): Promise<FolderListing> {
    try {
        const { files, truncated, limit, depthLimited, maxDepth } = await MdFile.listFolder({
            uri: folder.uri,
            maxDepth: 3,
        });
        // ★ 정렬 규칙을 'ko' 로 고정하지 마라 — 영어 사용자에게 한국어 규칙이 적용된다.
        files.sort((a, b) => a.name.localeCompare(b.name, localeTag()));
        /*
         * ★ 폴더 안의 파일은 **폴더의 트리 권한으로 다시 열린다.**
         *   addFolder() 가 영속화되지 않은 폴더를 아예 거부하므로(위) 여기 온 파일은 전부 그렇다.
         *   이 표시가 없으면 최근 목록에서 '읽기 전용 사본' 으로 뜨고 사본까지 만들어진다.
         */
        return {
            folder,
            files: files.map((f) => ({ ...f, persisted: true })),
            truncated: !!truncated,
            limit,
            depthLimited: !!depthLimited,
            maxDepth,
        };
    } catch (e) {
        // ★ 권한이 만료된 폴더를 자동으로 지우지 마라. SD 카드를 잠깐 뺐을 뿐일 수 있다.
        return {
            folder,
            files: [],
            error:
                (e as { code?: string })?.code === 'EPERM'
                    ? t.folders.expired
                    : t.folders.readFailed,
        };
    }
}
