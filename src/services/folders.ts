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
}

/** 폴더 내용을 읽는다. 권한이 만료된 폴더는 error 를 담아 돌려준다(목록에서 지우지 않는다). */
export async function listFolder(folder: Folder): Promise<FolderListing> {
    try {
        const { files } = await MdFile.listFolder({ uri: folder.uri, maxDepth: 3 });
        // ★ 정렬 규칙을 'ko' 로 고정하지 마라 — 영어 사용자에게 한국어 규칙이 적용된다.
        files.sort((a, b) => a.name.localeCompare(b.name, localeTag()));
        return { folder, files };
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
