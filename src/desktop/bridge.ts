/**
 * desktop/preload.cjs 가 contextBridge 로 내민 것의 타입.
 * ★ preload 를 고치면 여기를 같이 고쳐라. 이름이 어긋나면 컴파일은 되고 런타임에 조용히 죽는다.
 */
export interface DesktopDoc {
    path: string;
    name: string;
    /** 문서가 있는 폴더(절대 경로). 상대 경로 그림의 기준이다. */
    dir: string;
    size: number;
    content: string;
    encoding: 'UTF-8' | 'EUC-KR';
    /** 같은 파일이 디스크에서 바뀌어 다시 읽은 것이다. 읽던 자리를 지킨다. */
    reload: boolean;
}

export type DesktopCommand =
    | { name: 'toc' | 'find' | 'source' | 'print' | 'pdf' | 'edit' | 'save' }
    | { name: 'settings'; value: { theme: 'system' | 'light' | 'dark'; remoteImages: boolean } };

export interface MarkletBridge {
    ready(): void;
    onDocument(cb: (doc: DesktopDoc) => void): void;
    onCommand(cb: (cmd: DesktopCommand) => void): void;
    openPath(file: File): void;
    openLink(href: string): void;
    zoom(dir: -1 | 0 | 1): void;
    setTheme(theme: 'system' | 'light' | 'dark'): void;
    /** 메인이 맡은 동작(파일 열기 대화상자) */
    run(name: 'open'): void;
    setDirty(dirty: boolean): void;
    /** 메인이 열 때의 인코딩 · 줄바꿈 그대로 파일에 쓴다. 충돌 · 인코딩 확인 대화상자도 메인이 띄운다. */
    save(content: string): Promise<{ ok: boolean }>;
    /** 메인이 PDF 를 만들어 미리보기 창을 열거나(preview) 저장 대화상자로 내보낸다(pdf). */
    print(mode: 'preview' | 'pdf'): Promise<{ ok: boolean }>;
}

declare global {
    interface Window {
        marklet?: MarkletBridge;
    }
}
