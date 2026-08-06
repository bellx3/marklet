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

export async function loadFolders(): Promise<Folder[]> {
    try {
        const { value } = await Preferences.get({ key: KEY });
        if (!value) return [];
        return JSON.parse(value) as Folder[];
    } catch {
        return [];
    }
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
    const list = (await loadFolders()).filter((f) => f.uri !== res.uri);
    const folder: Folder = { uri: res.uri, name: res.name, addedAt: Date.now() };
    list.unshift(folder);
    await persistFolders(list);
    return folder;
}

export async function removeFolder(uri: string): Promise<Folder[]> {
    await MdFile.releaseUri({ uri }).catch(() => {});
    const list = (await loadFolders()).filter((f) => f.uri !== uri);
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
