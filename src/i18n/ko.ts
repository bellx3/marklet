/**
 * 한국어 문자열.
 *
 * ★★ 타입이 `Catalog` 로 고정돼 있다. `en.ts` 에 키를 더하고 여기를 안 채우면
 *   **컴파일이 깨진다.** 그게 의도다 — 번역 누락은 조용히 지나가면 안 된다.
 *
 * ★ 조사(을/를, 이/가, 으로/로)를 조심해라. 파일 이름처럼 값이 끼어드는 문장에서
 *   앞말 받침에 따라 조사가 달라진다. 2026-08-04에 실제로 걸린 것:
 *   `'x.md' 으로 저장했습니다` → 받침이 없어 '로'여야 했다.
 *   **조사를 붙이지 않아도 되게 문장을 바꾸는 쪽이 항상 안전하다**
 *   ("새 파일에 저장했습니다: x.md").
 */
import type { Catalog } from './en';

export const ko: Catalog = {
    common: {
        cancel: '취소',
        confirm: '확인',
        close: '닫기',
        back: '뒤로',
        settings: '설정',
        share: '공유',
        open: '열기',
        unknownError: '알 수 없는 오류입니다.',
    },

    home: {
        /** ★ 초성 검색(8-5절)은 여기서 가르친다. 안 알려 주면 아무도 모르는 기능이다. */
        searchPlaceholder: '이름 찾기 · ㅁㅋ 도 됩니다',
        searchLabel: '문서 이름으로 찾기',
        openFile: '파일 열기',
        addFolder: '폴더 추가',
        example: '예제 문서',
        recents: '최근 문서',
        myFolders: '내 폴더',
        nothingYet:
            '아직 연 문서가 없습니다. 위에서 파일을 열거나 폴더를 더하세요. 어떤 앱인지 먼저 보려면 [예제 문서] 를 누르세요.',
        noMatchingDoc: '찾는 이름의 문서가 없습니다.',
        noMatchingFile: '찾는 이름의 파일이 없습니다.',
        emptyFolder: '이 폴더에는 마크다운 파일이 없습니다.',
        readOnlyCopy: '읽기 전용 사본',
        cannotReopen: '다시 열 수 없음',
        removeFromList: (name: string) => `${name} 목록에서 지우기`,
        removeFolder: (name: string) => `${name} 폴더 빼기`,
    },

    time: {
        justNow: '방금',
        minutesAgo: (n: number) => `${n}분 전`,
        hoursAgo: (n: number) => `${n}시간 전`,
        daysAgo: (n: number) => `${n}일 전`,
    },

    viewer: {
        toc: '목차',
        find: '문서에서 찾기',
        edit: '편집',
        more: '더 보기',
        shareFile: '파일로 공유',
        viewSettings: '보기 설정',
        openAnother: '다른 문서 열기',
        sharePlain: '보이는 대로 공유',
        shareSource: '마크다운 원문으로 공유',
        renderingAll: '문서를 모두 그리는 중…',
        renderingDoc: '문서를 그리는 중…',
        preparingText: '공유할 글을 만드는 중…',
        snapshotNotice: '사본을 보고 있습니다. 원본을 수정하려면 [파일 열기]로 다시 선택해 주세요.',
        readOnlyNotice: '읽기 전용 문서입니다. 편집하면 새 이름으로 저장하게 됩니다.',
    },

    search: {
        /*
         * ★ 여기는 초성 안내를 넣지 않는다. 이 바는 세는 칸과 버튼 3개를 함께 이고 있어서
         *   입력칸에 남는 폭이 134px 뿐이다(384px 화면 실측) — 넣어 봐야 잘려서 안 읽힌다.
         */
        placeholder: '문서에서 찾기',
        label: '문서에서 찾기',
        previous: '이전 결과',
        next: '다음 결과',
        close: '검색 닫기',
    },

    toc: {
        title: '목차',
        empty: '이 문서에는 제목이 없습니다.',
        untitled: '(제목 없음)',
    },

    view: {
        title: '보기 설정',
        theme: '테마',
        themeSystem: '시스템',
        themeLight: '라이트',
        themeDark: '다크',
        fontSize: '글자 크기',
        smaller: '글자 작게',
        bigger: '글자 크게',
        breaks: '한 줄 개행 유지',
        breaksHint:
            '엔터 한 번을 줄바꿈으로 봅니다. 메모 앱에서 쓴 글이 한 문단으로 뭉치지 않습니다.',
    },

    settings: {
        title: '설정',
        /** ★ 한글 판구름. 받침·모음이 골고루 들어가야 글자 크기를 가늠할 수 있다. */
        sizePreview: '이 크기로 문서를 읽게 됩니다. 다람쥐 헌 쳇바퀴에 타고파.',
        remoteImages: '원격 이미지 불러오기',
        remoteImagesHint: '기본은 꺼짐입니다. 문서를 여는 것만으로 외부 서버에 접속하지 않습니다.',
        language: '언어',
        languageSystem: '시스템',
        tip: '후원하기',
        supporter: '후원자',
        clearRecents: '최근 문서 목록 비우기',
        clearTitle: '최근 문서를 비울까요?',
        clearBody: '목록과 앱이 보관한 사본만 지웁니다. 원본 파일은 그대로 남습니다.',
        clearConfirm: '비우기',
        cleared: '최근 문서를 비웠습니다.',
        about: '앱 정보',
        version: '버전',
        licenses: '오픈소스 라이선스',
        privacy: '개인정보처리방침',
        tipNote: '후원 표시는 이 기기에만 저장됩니다. 앱을 지우면 사라집니다.',
    },

    tip: {
        title: '후원',
        intro:
            'Marklet 은 광고가 없고 기능 제한도 없습니다. 계속 그렇게 두고 싶습니다. ' +
            '마음이 내키실 때만, 부담 없이 부탁드립니다.',
        note:
            '가격은 스토어가 알려 주는 값입니다. 결제는 Google Play 를 통해 이루어지며 ' +
            'Marklet 은 결제 정보를 받지도, 저장하지도 않습니다.',
        thanks: (n: number) => `지금까지 ${n}번 후원해 주셨습니다. 정말 고맙습니다. ☕`,
        coffee: '커피 한 잔',
        lunch: '점심 한 끼',
        dinner: '저녁 한 끼',
        thanksToast: '고맙습니다! 큰 힘이 됩니다 ☕',
        cancelled: '취소되었습니다.',
        pending: '이전 후원을 정리하는 중입니다. 잠시 후 다시 시도해 주세요.',
        appOnly: '후원은 앱에서만 가능합니다.',
        noProducts: '상품 정보를 받지 못했습니다. 잠시 후 다시 시도해 주세요.',
        requestFailed: (msg: string) => `결제 요청 실패: ${msg}`,
    },

    editor: {
        title: '문서 편집',
        exitEdit: '편집 끝내기',
        save: '저장',
        breaksHint: '엔터 한 번은 뷰어에서 줄바꿈으로 보이지 않습니다.',
        breaksHintButton: '개행 유지 켜기',
    },

    diagnostics: {
        title: '진단',
        copy: '복사',
        clear: '지우기',
        copied: '복사했습니다.',
        copyFailed: '복사할 수 없어 화면에 펼쳤습니다. 길게 눌러 선택해 주세요.',
        empty: '아직 측정값이 없습니다. 문서를 한 번 열어 보세요.',
        storage: '앱이 보관 중인 사본',
        storageHint: '문의하실 때 이 숫자를 함께 알려 주시면 도움이 됩니다.',
        bucketSnapshot: '다시 못 여는 문서의 사본',
        bucketBackup: '저장 전 백업',
        bucketDraft: '저장하지 않은 편집',
    },

    diagram: {
        zoomOut: '축소',
        zoomIn: '확대',
        fit: '맞춤',
        label: '다이어그램',
        zoomHint: '탭하면 크게 보기',
    },

    frontmatter: {
        info: '문서 정보',
    },

    mermaid: {
        loadFailed: '다이어그램 기능을 불러오지 못했습니다',
        tooSlow: '다이어그램을 그리는 데 시간이 너무 오래 걸려 코드로 표시합니다',
        drawFailed: (reason: string) => `다이어그램을 그리지 못했습니다 — ${reason}`,
        unsupported: (kind: string) =>
            `'${kind}' 다이어그램은 이 버전에서 지원하지 않습니다 — 코드로 표시합니다`,
        syntaxError: '다이어그램 문법에 오류가 있어 코드로 표시합니다',
        sourceBelow: (message: string) => `${message}. 아래는 원본 코드입니다.`,
        blockLabel: 'Mermaid 다이어그램',
    },

    content: {
        tableScrollable: '표 (좌우로 넘길 수 있습니다)',
        image: '이미지',
        loadRemoteImage: (alt: string) => `🖼 이미지 불러오기 — ${alt}`,
        loadRemoteImageLabel: (alt: string) => `원격 이미지 불러오기: ${alt}`,
    },

    plain: {
        image: (alt: string) => `[이미지: ${alt}]`,
        noAlt: '설명 없음',
        diagram: '[다이어그램]',
    },

    gate: {
        notText: '이 파일은 텍스트 문서가 아닙니다. 마크다운 파일을 선택해 주세요.',
        cp949: '옛 한글 인코딩(CP949)으로 읽었습니다. 저장하면 UTF-8로 바뀝니다.',
        tooBigTitle: '문서가 너무 큽니다',
        tooBigBody: (mb: string) =>
            `이 문서는 ${mb} MB입니다. 안드로이드 화면 엔진의 한계로 ` +
            `서식을 적용하면 문서 끝까지 표시할 수 없습니다.\n` +
            `원문 그대로(서식 없이) 열 수 있습니다.`,
        tooBigConfirm: '텍스트로만 보기',
        longTitle: '긴 문서입니다',
        longBody: (mb: string) =>
            `이 문서는 ${mb} MB입니다. 여는 데 시간이 걸리고 기기가 느려질 수 있습니다.`,
        noPermission: '이 파일에 접근할 권한이 없습니다. [파일 열기]로 다시 선택해 주세요.',
        notFound: '파일을 찾을 수 없습니다. 이동되거나 삭제된 것 같습니다.',
        tooBig: '파일이 너무 커서 열 수 없습니다. (8MB 초과)',
        openError: (msg: string) => `파일을 여는 중 오류가 발생했습니다. (${msg})`,
        unknown: '알 수 없음',
        /*
         * ★ '열 수 없다' 로 끝내면 사용자는 앱을 의심한다. 원인과 할 일을 같이 준다.
         *   구글 드라이브가 .md 를 구글 문서로 바꿔 두면 더 이상 텍스트 파일이 아니라
         *   어떤 앱도 원문을 못 읽는다. 드라이브에서 내보내야 한다.
         */
        googleDoc:
            '이 파일은 구글 문서로 변환되어 있어 텍스트로 읽을 수 없습니다.\n' +
            '드라이브에서 [다운로드 → 일반 텍스트]로 내보낸 뒤 열어 주세요.',
    },

    save: {
        readOnly: '이 파일은 여기서 수정할 수 없습니다. 새 이름으로 저장해 주세요.',
        /*
         * ★ "파일은 그대로 남아 있습니다" 라고 쓰지 마라. 백업이 실패하는 이유는 둘인데
         *   ② 원본을 못 읽음(삭제·이동·권한 만료) 에서는 원본이 이미 없다 —
         *   그때 "그대로 남아 있다"는 거짓말이 된다. 참인 문장은 "우리가 건드리지 않았다" 뿐이다.
         */
        backupFailed:
            '원본을 백업하지 못해 저장을 중단했습니다. 이 앱은 원본 파일을 건드리지 않았습니다.',
        mismatch: '저장은 되었지만 내용이 일치하지 않습니다. 클라우드 동기화 중일 수 있습니다.',
        verifyFailed: '저장 후 확인에 실패했습니다. 파일을 다시 열어 내용을 확인해 주세요.',
        noPermission: '파일에 쓸 권한이 없습니다. 파일을 다시 열어 주세요.',
        readOnlyLocation: '이 위치에는 저장할 수 없습니다. 새 이름으로 저장해 주세요.',
        gone: '저장할 파일이 없습니다. 삭제되거나 이동된 것 같습니다. 새 이름으로 저장해 주세요.',
        ioError: '저장 중 오류가 발생했습니다. 저장 공간을 확인해 주세요.',
        failed: (msg: string) => `저장에 실패했습니다. (${msg})`,
        unknownError: '알 수 없는 오류',
    },

    folders: {
        noPermission: '이 폴더는 계속 사용할 권한을 받지 못했습니다. 다른 폴더를 선택해 주세요.',
        expired: '폴더 권한이 만료되었습니다. 폴더를 다시 추가해 주세요.',
        truncated: (n: number) =>
            `파일이 많아 ${n.toLocaleString()}개까지만 보여 줍니다. 하위 폴더로 나누면 전부 보입니다.`,
        depthLimited: (n: number) =>
            `하위 ${n}단계까지만 훑습니다. 더 깊은 폴더의 파일은 목록에 없습니다.`,
        readFailed: '폴더를 읽지 못했습니다.',
        listUnavailable: '폴더 목록을 읽지 못했습니다. 잠시 뒤에 다시 시도해 주세요.',
    },

    shell: {
        sharedText: '공유된 텍스트',
        cannotOpen: '문서를 열 수 없습니다',
        unsavedTitle: '저장하지 않은 편집이 있습니다',
        unsavedOpenBody:
            '지금 다른 문서를 열면 편집한 내용이 화면에서 사라집니다. (초안은 앱에 남습니다.)',
        openNew: '새 문서 열기',
        keepEditing: '계속 편집',
        openOriginal: '원본 열기',
        /*
         * ★ '에' 를 붙이지 마라. formatWhen 은 '3분 전' 뿐 아니라 '방금' 도 돌려주는데
         *   "방금에 편집하던" 이 된다(2026-08-03 에뮬레이터에서 실제로 나왔다).
         */
        draftBody: (when: string) =>
            `${when ? `${when} ` : ''}편집하던 내용이 앱에 남아 있습니다.
무엇을 열까요?`,
        resumeEditing: '이어서 편집',
        noOriginal:
            '원본을 찾을 수 없고 앱에 남은 사본도 없습니다. [파일 열기]로 다시 선택해 주세요.',
        pickFailed: (msg: string) => `파일을 선택할 수 없습니다. (${msg})`,
        folderAdded: (name: string) => `'${name}' 폴더를 추가했습니다.`,
        folderAddFailed: '폴더를 추가하지 못했습니다',
        guideTitle: 'Marklet 사용 설명서',
        cannotEditTitle: '편집할 수 없습니다',
        cannotEditBody:
            '이 문서는 파일이 아니라 공유받은 텍스트입니다. 편집하려면 먼저 파일로 저장해 주세요.',
        cloudTitle: '클라우드 문서입니다',
        cloudBody:
            '다른 기기에서 동시에 편집하지 마세요. 나중에 저장한 쪽이 상대의 편집을 덮어씁니다.',
        exitEditTitle: '저장하지 않은 편집이 있습니다',
        exitEditBody:
            '편집을 끝내면 화면에서는 사라집니다. 초안은 앱에 남아 다음에 다시 물어봅니다.',
        saved: '저장했습니다.',
        viewBackup: '백업 내용 보기',
        saveAsNew: '새 이름으로 저장',
        saveFailedTitle: '저장하지 못했습니다',
        saveAsFailedTitle: '새 파일에도 저장하지 못했습니다',
        /** ★ 조사를 피하려고 콜론을 쓴다. `'x.md' 으로` 같은 오류가 나지 않는다. */
        savedAsNew: (name: string) => `새 파일에 저장했습니다: ${name}`,
        createFailedTitle: '새 파일을 만들지 못했습니다',
        copySuffix: '사본',
        backupReadFailedTitle: '백업을 읽지 못했습니다',
        backupNotFound: '백업 파일을 찾을 수 없습니다.',
        backupTitle: '백업 내용',
        cannotShareFileTitle: '파일로 공유할 수 없습니다',
        cannotShareFileBody:
            '이 문서는 앱에 들어 있는 예제이거나 공유받은 텍스트라서 보낼 파일이 없습니다.',
        shareDialogTitle: '문서 공유',
        shareFileFailedTitle: '파일을 공유하지 못했습니다',
        tooBigTextTitle: '글자로 공유하기에는 너무 큽니다',
        tooBigTextBody: (limitKb: number, sizeKb: string) =>
            `글자 공유는 ${limitKb}KB 까지만 됩니다. 이 문서는 ${sizeKb}KB 입니다.\n` +
            '[파일로 공유] 를 쓰시면 크기 제한 없이 보낼 수 있습니다.',
        /**
         * ★ [파일로 공유] 가 없는 문서에 쓴다.
         * ★★ 이유를 한 가지로 못박지 마라 — 두 경우가 함께 온다.
         *   ① 공유받은 글·예제 문서: 애초에 파일이 아니다
         *   ② 사본으로 열린 문서: 파일이었지만 원본을 못 찾는다
         *   "파일이 아니라서" 라고 쓰면 ②에서 거짓말이 된다. 둘 다 참인 문장은
         *   "보낼 파일이 없다" 뿐이다(save.ts 의 백업 실패 문구와 같은 판단이다).
         */
        tooBigTextBodyNoFile: (limitKb: number, sizeKb: string) =>
            `글자 공유는 ${limitKb}KB 까지만 됩니다. 이 문서는 ${sizeKb}KB 입니다.\n` +
            '이 문서는 보낼 파일이 없어서 파일로도 보낼 수 없습니다.',
        plainNoticeTitle: '보이는 대로 보냅니다',
        plainNoticeBody:
            '#, |, ``` 같은 기호를 걷어내고 화면에 보이는 글자만 보냅니다.\n' +
            '다이어그램과 이미지는 글자로 옮길 수 없어 [다이어그램], [이미지] 로 표시됩니다.',
        sourceNoticeTitle: '원문 그대로 전달됩니다',
        sourceNoticeBody:
            '받는 분에게는 화면에 보이는 모습이 아니라 ' +
            '마크다운 원문(#, |, ```)이 글자 그대로 갑니다.\n' +
            '기호 없이 보내려면 [보이는 대로 공유] 를 쓰세요.',
        shareAsIs: '그대로 공유',
    },

    fatal: {
        bootFailed: '앱을 시작하지 못했습니다. 앱을 완전히 종료한 뒤 다시 실행해 주세요.',
    },
};
