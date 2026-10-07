import { MdFile, type MdDocument } from '../plugins/md-file';

export interface EntryHandlers {
    openDocument: (doc: MdDocument) => Promise<void>;
    openSharedText: (text: string) => Promise<void>;
    showHome: () => void;
    /** 저장하지 않은 편집이 있으면 true */
    hasUnsavedChanges: () => boolean;
    /** 사용자에게 버릴지 물어본다. 버려도 되면 true */
    confirmDiscard: () => Promise<boolean>;
}

let removeListener: (() => Promise<void>) | null = null;

/**
 * 콜드 스타트와 실행 중 진입은 **경로가 완전히 다르다.** 둘 다 처리해야 한다.
 *
 * ★ `@capacitor/app` 의 `appUrlOpen` 을 쓰지 마라. ACTION_SEND 를 버리고,
 *   `getLaunchUrl()` 은 두 번째 파일부터 낡은 값을 돌려준다(5-1절).
 */
export async function initDocumentEntry(h: EntryHandlers): Promise<void> {
    // (1) 실행 중 진입: 리스너를 '먼저' 붙인다.
    //     네이티브가 retain=true 로 이벤트를 보관하므로 늦게 붙어도 놓치지 않지만
    //     먼저 붙이는 편이 안전하다.
    const handle = await MdFile.addListener('mdFileOpen', (doc) => {
        void (async () => {
            // 저장하지 않은 편집이 있으면 먼저 확인받는다.
            // 이걸 빠뜨리면 사용자가 쓰던 내용이 소리 없이 사라진다.
            if (h.hasUnsavedChanges() && !(await h.confirmDiscard())) return;
            if (doc.uri) await h.openDocument(doc);
            else if (doc.sharedText) await h.openSharedText(doc.sharedText);
        })();
    });
    removeListener = handle.remove;

    // (2) 콜드 스타트 진입
    const pending = await MdFile.getPendingOpen();
    if (pending?.uri) {
        await h.openDocument(pending as MdDocument);
    } else if (pending?.sharedText) {
        await h.openSharedText(pending.sharedText);
    } else {
        h.showHome(); // 그냥 아이콘으로 실행한 경우
    }
}

/** 붙였으면 떼는 것도 같이 쓴다. 픽셀오아시스에서 이걸 빠뜨려 누수가 있었다. */
export async function destroyDocumentEntry(): Promise<void> {
    await removeListener?.();
    removeListener = null;
}
