import { registerPlugin } from '@capacitor/core';

/**
 * 자체 네이티브 플러그인의 TypeScript 인터페이스.
 *
 * ★ 각 필드는 MdFilePlugin.java 의 call.resolve 에 넣은 키와 1:1이다.
 *   Java 를 고치면 여기를 같이 고쳐라.
 *   테스트에서 이 플러그인을 목으로 만들 때는 이 표가 아니라
 *   **Java 코드의 put( 호출을 보고** 만들어라(11장).
 */

export interface MdDocument {
    uri: string;
    name: string;
    size: number; // 알 수 없으면 -1
    mimeType: string | null;
    writable: boolean;
    persisted?: boolean;
    cancelled?: boolean;
    content?: string; // read()에만 존재
    encoding?: 'UTF-8' | 'EUC-KR'; // read()에만 존재
    sharedText?: string; // 파일이 아닌 텍스트가 공유된 경우
    lastModified?: number; // listFolder()에만 존재
}

export interface PersistedUri {
    uri: string;
    read: boolean;
    write: boolean;
    persistedTime: number;
}

export interface MdFilePlugin {
    /** 콜드 스타트로 들어온 문서를 가져온다. 한 번 가져가면 비워진다. */
    getPendingOpen(): Promise<Partial<MdDocument>>;
    read(options: { uri: string }): Promise<MdDocument>;
    write(options: {
        uri: string;
        content: string;
    }): Promise<{ bytesWritten: number; uri: string }>;
    pickFile(): Promise<MdDocument>;
    pickFolder(): Promise<{
        uri: string;
        name: string;
        persisted: boolean;
        cancelled?: boolean;
    }>;
    listFolder(options: { uri: string; maxDepth?: number }): Promise<{
        files: MdDocument[];
        /** 상한에서 멈췄는가. 화면이 "일부만 보여 준다" 고 알려야 한다. */
        truncated?: boolean;
        /** 그 상한 값 */
        limit?: number;
        /** 깊이 상한에 걸려 들여다보지 않은 하위 폴더가 있었는가 */
        depthLimited?: boolean;
        /** 그 깊이 값 */
        maxDepth?: number;
    }>;
    createFile(options: { name: string }): Promise<MdDocument>;
    /**
     * 원본 URI 를 그대로 넘겨 **파일 자체**를 공유한다 (5-8절).
     * ★ @capacitor/share 는 file:// 만 받으므로 이 경로가 따로 있다.
     * @returns completed 는 '공유 창이 정상 종료됐는가'일 뿐 전송 성공 여부가 아니다.
     */
    shareFile(options: {
        uri: string;
        name: string;
        mimeType?: string;
        dialogTitle?: string;
    }): Promise<{ completed: boolean }>;
    getPersistedUris(): Promise<{ uris: PersistedUri[] }>;
    releaseUri(options: { uri: string }): Promise<void>;
    getSystemFontScale(): Promise<{ scale: number }>;

    addListener(
        eventName: 'mdFileOpen',
        listener: (doc: MdDocument) => void,
    ): Promise<{ remove: () => Promise<void> }>;
}

export const MdFile = registerPlugin<MdFilePlugin>('MdFile');

/**
 * 네이티브 플러그인이 실제로 붙어 있는지.
 * 브라우저(`npm run dev`)에서는 없다 — 파일 기능을 감추는 데 쓴다.
 */
export async function isMdFileAvailable(): Promise<boolean> {
    try {
        await MdFile.getSystemFontScale();
        return true;
    } catch {
        return false;
    }
}
