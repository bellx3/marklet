import { Filesystem, Directory } from '@capacitor/filesystem';

/**
 * 앱이 내부 저장소에 쌓아 둔 것들.
 *
 * ★★ 왜 보여 주는가. 이 앱은 사용자 파일을 건드리지 않는 대신 **앱 안에 사본을 만든다** —
 *   다시 못 여는 문서의 사본(snapshot), 저장 실패에 대비한 백업(backup),
 *   저장하지 않은 편집의 초안(draft). 셋 다 문서 전체 크기다.
 *
 *   그런데 이건 안드로이드 '앱 정보 → 저장공간' 에만 숫자로 뜬다. 사용자는
 *   **무엇이 얼마나 쌓였는지 알 방법이 없고**, 우리도 문의를 받았을 때 물어볼 게 없었다.
 *   (2026-08-06 실측: 에뮬레이터 한 대에 사본만 29개 28MB)
 *
 * ★ 개수로 초안을 지우지 않는다. 저장 안 된 사용자 글을 조용히 버리는 것이라
 *   이 앱이 하면 안 되는 일이다. 여기서는 **보여 주기만** 한다.
 */
export interface StorageBucket {
    /** 'snapshot' | 'backup' | 'draft' */
    name: string;
    files: number;
    bytes: number;
}

const BUCKETS = ['snapshot', 'backup', 'draft'] as const;

async function measure(name: string): Promise<StorageBucket> {
    try {
        const { files } = await Filesystem.readdir({ path: name, directory: Directory.Data });
        // ★ readdir 이 주는 size 를 쓴다. 파일마다 stat 을 부르면 수백 번 왕복한다.
        const bytes = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
        return { name, files: files.length, bytes };
    } catch {
        // 폴더가 아직 없다 = 아무것도 안 쌓였다.
        return { name, files: 0, bytes: 0 };
    }
}

export async function measureStorage(): Promise<StorageBucket[]> {
    return Promise.all(BUCKETS.map(measure));
}

/** 사람이 읽는 크기. home.ts 의 formatSize 와 규칙을 맞춘다. */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
