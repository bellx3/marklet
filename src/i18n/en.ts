/**
 * 영어 문자열 — **카탈로그의 원본이다.**
 *
 * ★ 왜 영어가 원본인가. 안드로이드 리소스와 같은 규칙으로 맞췄다 —
 *   `res/values/` 가 영어(기본)이고 `res/values-ko/` 가 한국어 덮어쓰기다.
 *   Play 스토어 기본 언어도 en-US 다(01_제품_결정서.md 7.4절).
 *   한 곳에서만 규칙이 뒤집히면 나중에 어느 쪽이 기준인지 헷갈린다.
 *
 * ★★ 여기에 키를 더하면 `ko.ts` 는 **컴파일 오류가 난다.** 그게 의도다.
 *   번역이 빠진 채로 배포되면 한국어 화면에 영어가 섞여 나오고, 그건 조용히 지나간다.
 *   타입이 대신 잡아 주게 만들어 두었다(`ko: Catalog`).
 *
 * ★ 콘솔 메시지(console.warn/error)는 여기 넣지 마라. 그건 개발자용이고
 *   릴리스 빌드에서 지워진다. 사용자 눈에 닿는 글자만 카탈로그로 옮긴다.
 */

export const en = {
    common: {
        cancel: 'Cancel',
        confirm: 'OK',
        close: 'Close',
        back: 'Back',
        settings: 'Settings',
        share: 'Share',
        open: 'Open',
        unknownError: 'An unknown error occurred.',
    },

    home: {
        /** ★ 한국어에만 초성 안내가 붙는다. 영어에는 그런 개념이 없다. */
        searchPlaceholder: 'Search by name',
        searchLabel: 'Search documents by name',
        openFile: 'Open file',
        addFolder: 'Add folder',
        example: 'Example',
        recents: 'RECENT',
        myFolders: 'MY FOLDERS',
        noMatchingDoc: 'No document matches that name.',
        noMatchingFile: 'No file matches that name.',
        emptyFolder: 'This folder has no Markdown files.',
        readOnlyCopy: 'Read-only copy',
        cannotReopen: 'Cannot reopen',
        removeFromList: (name: string) => `Remove ${name} from the list`,
        removeFolder: (name: string) => `Remove folder ${name}`,
    },

    time: {
        justNow: 'just now',
        minutesAgo: (n: number) => `${n} min ago`,
        hoursAgo: (n: number) => `${n} hr ago`,
        daysAgo: (n: number) => (n === 1 ? 'yesterday' : `${n} days ago`),
    },

    viewer: {
        toc: 'Table of contents',
        find: 'Find in document',
        edit: 'Edit',
        more: 'More',
        shareFile: 'Share as file',
        viewSettings: 'Reading options',
        openAnother: 'Open another document',
        sharePlain: 'Share as plain text',
        shareSource: 'Share Markdown source',
        renderingAll: 'Rendering the whole document…',
        renderingDoc: 'Rendering…',
        preparingText: 'Preparing the text to share…',
        snapshotNotice:
            'You are viewing a copy. To edit the original, choose it again with [Open file].',
        readOnlyNotice: 'This document is read-only. Editing it will save under a new name.',
    },

    search: {
        placeholder: 'Find in document',
        label: 'Find in document',
        previous: 'Previous match',
        next: 'Next match',
        close: 'Close search',
    },

    toc: {
        title: 'Contents',
        empty: 'This document has no headings.',
        untitled: '(untitled)',
    },

    view: {
        title: 'Reading options',
        theme: 'Theme',
        themeSystem: 'System',
        themeLight: 'Light',
        themeDark: 'Dark',
        fontSize: 'Text size',
        smaller: 'Smaller text',
        bigger: 'Larger text',
        breaks: 'Keep single line breaks',
        breaksHint:
            'Treat one Enter as a line break, so notes written in a memo app do not collapse into one paragraph.',
    },

    settings: {
        title: 'Settings',
        /** ★ 글자 크기 미리보기. 한국어는 한글 판구름(pangram)을 쓴다. */
        sizePreview:
            'This is how documents will read. The quick brown fox jumps over the lazy dog.',
        remoteImages: 'Load remote images',
        remoteImagesHint:
            'Off by default. Opening a document never reaches out to an external server on its own.',
        language: 'Language',
        languageSystem: 'System',
        tip: 'Support the app',
        supporter: 'Supporter',
        clearRecents: 'Clear recent documents',
        clearTitle: 'Clear recent documents?',
        clearBody:
            'This only clears the list and the copies the app kept. Your original files stay.',
        clearConfirm: 'Clear',
        cleared: 'Recent documents cleared.',
        about: 'ABOUT',
        version: 'Version',
        licenses: 'Open-source licenses',
        privacy: 'Privacy policy',
        tipNote: 'Supporter status is stored on this device only. It is lost if you uninstall.',
    },

    tip: {
        title: 'Support',
        intro:
            'Marklet has no ads and locks nothing behind a paywall. I would like to keep it that way. ' +
            'Only if you feel like it, and with no pressure at all.',
        note:
            'Prices come from the store. Payment goes through Google Play, and ' +
            'Marklet never receives or stores your payment details.',
        thanks: (n: number) =>
            n === 1
                ? 'You have supported this app once. Thank you so much. ☕'
                : `You have supported this app ${n} times. Thank you so much. ☕`,
        /*
         * ★ Play Console 에 등록한 **상품 이름과 글자를 맞춘다.**
         *   결제 확인창은 우리 라벨이 아니라 콘솔 이름을 보여 주므로,
         *   버튼에 'A coffee' 라고 써 놓고 구글 창에 'Buy me a coffee' 가 뜨면
         *   사용자는 다른 걸 누른 줄 안다. 한국어는 양쪽 다 '커피 한 잔' 이라 문제없다.
         */
        coffee: 'Buy me a coffee',
        lunch: 'Buy me lunch',
        dinner: 'Buy me dinner',
        thanksToast: 'Thank you! It really helps ☕',
        cancelled: 'Cancelled.',
        pending: 'A previous purchase is still being settled. Please try again in a moment.',
        appOnly: 'Supporting is only available in the app.',
        noProducts: 'Could not load the products. Please try again in a moment.',
        requestFailed: (msg: string) => `Purchase request failed: ${msg}`,
    },

    editor: {
        title: 'Edit document',
        exitEdit: 'Finish editing',
        save: 'Save',
        breaksHint: 'A single Enter will not show as a line break in the viewer.',
        breaksHintButton: 'Turn on line breaks',
    },

    diagnostics: {
        title: 'Diagnostics',
        copy: 'Copy',
        clear: 'Clear',
        copied: 'Copied.',
        copyFailed: 'Could not copy, so the values are shown below. Long-press to select them.',
        empty: 'No measurements yet. Try opening a document first.',
        storage: 'Copies kept by the app',
        storageHint: 'Including these numbers in a report helps a lot.',
        bucketSnapshot: 'Copies of documents that cannot be reopened',
        bucketBackup: 'Backups taken before saving',
        bucketDraft: 'Unsaved edits',
    },

    diagram: {
        /*
         * ★ 확대·축소 단추는 화면에 '−' '+' 만 보인다. 그대로 두면 스크린 리더가
         *   기호를 그대로 읽어 무슨 단추인지 알 수 없다 — 이름을 따로 준다.
         */
        zoomOut: 'Zoom out',
        zoomIn: 'Zoom in',
        fit: 'Fit',
        label: 'Diagram',
        /** ★ CSS ::after 로 들어간다. setLanguage() 가 --i18n-zoom-hint 에 넣는다. */
        zoomHint: 'Tap to enlarge',
    },

    frontmatter: {
        /*
         * ★ 제목으로 쓸 **키**는 여기서 오지 않는다. frontmatter.ts 의 TITLE_KEYS 가
         *   언어와 무관하게 title·document·문서·제목 넷을 본다 —
         *   예전에는 이 라벨을 키로 써서 소문자 `document` 를 못 찾았다.
         */
        info: 'Document info',
    },

    mermaid: {
        loadFailed: 'Could not load diagram support',
        tooSlow: 'The diagram took too long to draw, so the code is shown instead',
        drawFailed: (reason: string) => `Could not draw the diagram — ${reason}`,
        unsupported: (kind: string) =>
            `'${kind}' diagrams are not supported in this version — showing the code instead`,
        syntaxError: 'The diagram has a syntax error, so the code is shown instead',
        sourceBelow: (message: string) => `${message}. The original code is below.`,
        blockLabel: 'Mermaid diagram',
    },

    content: {
        tableScrollable: 'Table (scrollable sideways)',
        image: 'Image',
        loadRemoteImage: (alt: string) => `Load image — ${alt}`,
        loadRemoteImageLabel: (alt: string) => `Load remote image: ${alt}`,
    },

    plain: {
        image: (alt: string) => `[Image: ${alt}]`,
        noAlt: 'no description',
        diagram: '[Diagram]',
    },

    gate: {
        notText: 'This file is not a text document. Please choose a Markdown file.',
        cp949: 'Read using the legacy Korean encoding (CP949). Saving will convert it to UTF-8.',
        tooBigTitle: 'Document is too large',
        tooBigBody: (mb: string) =>
            `This document is ${mb} MB. Because of a limit in the Android rendering engine, ` +
            `formatting it would cut off the end of the document.\n` +
            `It can be opened as plain source instead.`,
        tooBigConfirm: 'View as plain text',
        longTitle: 'Long document',
        longBody: (mb: string) =>
            `This document is ${mb} MB. It will take a while to open and may slow the device down.`,
        noPermission: 'No permission to read this file. Please choose it again with [Open file].',
        notFound: 'File not found. It looks like it was moved or deleted.',
        tooBig: 'The file is too large to open. (over 8 MB)',
        openError: (msg: string) => `Something went wrong while opening the file. (${msg})`,
        unknown: 'unknown',
        googleDoc:
            'This file has been converted to a Google Doc, so it cannot be read as text.\n' +
            'Please export it from Drive with [Download → Plain text] and open that.',
    },

    save: {
        readOnly: 'This file cannot be modified here. Please save it under a new name.',
        backupFailed:
            'Saving was stopped because the original could not be backed up. This app did not touch your original file.',
        mismatch:
            'The file was written but the contents do not match. A cloud sync may be in progress.',
        verifyFailed:
            'Could not verify the file after saving. Please reopen it and check the contents.',
        noPermission: 'No permission to write this file. Please open it again.',
        readOnlyLocation: 'This location cannot be written to. Please save under a new name.',
        gone: 'The file is gone. It looks like it was deleted or moved. Please save it under a new name.',
        ioError: 'Something went wrong while saving. Please check your storage space.',
        failed: (msg: string) => `Saving failed. (${msg})`,
        unknownError: 'unknown error',
    },

    folders: {
        noPermission: 'This folder did not grant lasting access. Please choose a different folder.',
        expired: 'Folder access expired. Please add the folder again.',
        /** ★ 상한은 네이티브가 정한다. 여기에 숫자를 박으면 둘이 어긋난다. */
        truncated: (n: number) =>
            `Too many files — showing the first ${n.toLocaleString()}. Split them into subfolders to see all.`,
        depthLimited: (n: number) =>
            `Only ${n} levels of subfolders are scanned. Files deeper than that are not listed.`,
        readFailed: 'Could not read the folder.',
    },

    shell: {
        sharedText: 'Shared text',
        cannotOpen: 'Cannot open the document',
        unsavedTitle: 'You have unsaved edits',
        unsavedOpenBody:
            'Opening another document now will clear your edits from the screen. (The draft stays in the app.)',
        openNew: 'Open the new document',
        keepEditing: 'Keep editing',
        openOriginal: 'Open the original',
        /*
         * ★ 시각 어구를 **문장 뒤에** 붙인다. 한국어 카탈로그를 그대로 옮겨
         *   앞에 붙였더니 "just now You have edits left in the app." 이 나왔다
         *   (2026-08-06 실기기). 한국어는 '방금 편집하던…' 이 자연스럽지만
         *   영어는 시각이 뒤로 가야 문장이 된다. 어순은 언어마다 다르다 —
         *   틀을 베끼지 말고 그 언어로 읽어 봐라.
         */
        draftBody: (when: string) =>
            `You have edits left in the app${when ? ` from ${when}` : ''}.
Which one would you like to open?`,
        resumeEditing: 'Resume editing',
        noOriginal:
            'The original is gone and no copy is left in the app. Please choose it again with [Open file].',
        pickFailed: (msg: string) => `Could not choose a file. (${msg})`,
        folderAdded: (name: string) => `Added the folder '${name}'.`,
        folderAddFailed: 'Could not add the folder',
        guideTitle: 'Marklet guide',
        cannotEditTitle: 'Cannot edit',
        cannotEditBody:
            'This document is shared text, not a file. Save it as a file first to edit it.',
        cloudTitle: 'This is a cloud document',
        cloudBody:
            'Do not edit it on two devices at once. Whichever saves last overwrites the other.',
        exitEditTitle: 'You have unsaved edits',
        exitEditBody:
            'Finishing will clear them from the screen. The draft stays in the app and we will ask again next time.',
        saved: 'Saved.',
        viewBackup: 'View the backup',
        saveAsNew: 'Save under a new name',
        saveFailedTitle: 'Could not save',
        saveAsFailedTitle: 'Could not save to a new file either',
        savedAsNew: (name: string) => `Saved to a new file: ${name}`,
        createFailedTitle: 'Could not create the new file',
        copySuffix: 'copy',
        backupReadFailedTitle: 'Could not read the backup',
        backupNotFound: 'The backup file could not be found.',
        backupTitle: 'Backup contents',
        cannotShareFileTitle: 'Cannot share as a file',
        cannotShareFileBody:
            'This document is a built-in example or shared text, so there is no file to send.',
        shareDialogTitle: 'Share document',
        shareFileFailedTitle: 'Could not share the file',
        tooBigTextTitle: 'Too large to share as text',
        tooBigTextBody: (limitKb: number, sizeKb: string) =>
            `Text sharing works up to ${limitKb} KB. This document is ${sizeKb} KB.\n` +
            'Use [Share as file] to send it without a size limit.',
        plainNoticeTitle: 'Sending it as it looks',
        plainNoticeBody:
            'Symbols like #, |, and ``` are stripped, and only the text you see is sent.\n' +
            'Diagrams and images cannot be turned into text, so they appear as [Diagram] and [Image].',
        sourceNoticeTitle: 'The raw source is sent',
        sourceNoticeBody:
            'The recipient gets the Markdown source (#, |, ```) as literal text, ' +
            'not the rendered view.\n' +
            'To send it without the symbols, use [Share as plain text].',
        shareAsIs: 'Share as-is',
    },

    fatal: {
        bootFailed: 'The app could not start. Please close it completely and open it again.',
    },
} as const;

/**
 * 카탈로그의 모양. ★ `as const` 를 벗겨 낸 넓은 타입이다 —
 * 안 그러면 `ko` 의 값이 영어 리터럴과 같아야 해서 번역을 못 넣는다.
 */
export type Catalog = {
    [S in keyof typeof en]: {
        [K in keyof (typeof en)[S]]: (typeof en)[S][K] extends (...args: infer A) => string
            ? (...args: A) => string
            : string;
    };
};
