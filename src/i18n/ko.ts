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
    common: { close: '닫기' },
    viewer: {
        toc: '목차',
        find: '문서에서 찾기',
        edit: '편집',
        more: '더 보기',
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

    view: { theme: '테마' },

    desktop: {
        menuCopy: '복사',
        menuSelectAll: '모두 선택',
        menuSource: '원문 보기',
        menuOpen: '열기…',
        menuPrint: '인쇄…',
        menuPdf: 'PDF로 내보내기…',
        emptyHint: '마크다운 파일을 여기로 끌어다 놓거나\nCtrl+O 로 여세요',
    },
    diagram: {
        zoomOut: '축소',
        zoomIn: '확대',
        fit: '맞춤',
        label: '다이어그램',
        zoomHint: '클릭하면 크게 보기',
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
    shell: { saved: '저장했습니다.' },
};
