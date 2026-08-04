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

export async function loadRecents(): Promise<RecentDoc[]> {
    try {
        const { value } = await Preferences.get({ key: KEY });
        if (!value) return [];
        return JSON.parse(value) as RecentDoc[];
    } catch {
        return [];
    }
}

async function saveRecents(list: RecentDoc[]): Promise<void> {
    try {
        await Preferences.set({ key: KEY, value: JSON.stringify(list) });
    } catch (err) {
        console.error('최근 문서 저장 실패:', err);
    }
}

export async function rememberDoc(
    doc: MdDocument,
    content: string,
    source: RecentDoc['source'],
): Promise<void> {
    const list = (await loadRecents()).filter((r) => r.uri !== doc.uri);

    let snapshotPath: string | undefined;
    if (!doc.persisted) {
        // 다시 못 열 URI 다. 지금 사본을 만들어 둔다.
        snapshotPath = `snapshot/${Date.now()}-${sanitizeFileName(doc.name)}`;
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
        if (dropped.snapshotPath) {
            await Filesystem.deleteFile({
                path: dropped.snapshotPath,
                directory: Directory.Data,
            }).catch(() => {});
        }
    }

    await saveRecents(list.slice(0, MAX));
}

/** 파일 이름에 쓸 수 없는 문자를 없앤다. 사본 경로가 깨지면 조용히 실패한다. */
export function sanitizeFileName(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'doc.md';
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

    const merged = list.map((r) => ({ ...r, persisted: live.has(r.uri) }));
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

export async function removeRecent(uri: string): Promise<RecentDoc[]> {
    const list = await loadRecents();
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
