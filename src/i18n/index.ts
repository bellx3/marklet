/**
 * 언어 (en · ko 두 개만 — 01_제품_결정서.md §"하지 않는 것").
 *
 * ★★ `t` 는 `export let` 이다. ESM 의 **살아 있는 바인딩**이라
 *   `setLanguage()` 로 바꾸면 이미 import 해 간 모듈에서도 새 값이 보인다.
 *   `export const t = CATALOGS[lang]` 로 쓰면 **모듈이 평가되는 순간**의 값이 박혀서
 *   부팅 때 고른 언어가 반영되지 않는다(import 는 main.ts 본문보다 먼저 평가된다).
 *
 * ★★ 그래서 **구조 분해로 받지 마라.**
 *       const { home } = t;          // ✗ 그 시점 값이 박힌다
 *       button.textContent = t.home.openFile;   // ✓ 쓸 때 읽는다
 *
 * ★ 언어를 바꾸면 앱을 **다시 읽는다**(location.reload). 화면들은 만들 때 한 번만
 *   글자를 넣으므로 다시 만들지 않으면 절반만 바뀐다. 화면을 전부 재구성하는 코드를
 *   따로 두는 것보다, 이미 있는 부팅 경로를 한 번 더 타는 쪽이 훨씬 덜 틀린다.
 *   설정·초안은 전부 저장돼 있으므로 잃는 것은 '지금 열려 있던 문서' 하나뿐이고
 *   그건 최근 문서에서 한 번에 다시 열린다.
 */
import { en, type Catalog } from './en';
import { ko } from './ko';

/** 실제로 화면에 쓰이는 언어 */
export type Lang = 'en' | 'ko';
/** 사용자가 고르는 값. `system` 은 기기 설정을 따른다 */
export type LangSetting = Lang | 'system';

const CATALOGS: Record<Lang, Catalog> = { en, ko };

/**
 * 지금 쓰는 문자열. **살아 있는 바인딩이다** (위 주석).
 * 기본값이 영어인 이유는 `en.ts` 가 카탈로그의 원본이기 때문이다.
 */
export let t: Catalog = en;

let active: Lang = 'en';

/** 지금 화면에 쓰이는 언어 */
export function getLang(): Lang {
    return active;
}

/**
 * `system` 을 실제 언어로 푼다.
 * ★ 한국어 판정은 접두사로 한다 — `ko`, `ko-KR`, `ko-Kore-KR` 이 모두 온다.
 *   그 외는 전부 영어로 떨어진다(en/ko 두 개만 있다).
 */
export function resolveLang(setting: LangSetting): Lang {
    if (setting === 'en' || setting === 'ko') return setting;
    /*
     * ★★ 모르는 값은 **영어로 떨어뜨린다.** 그냥 돌려주면 CATALOGS[그 값] 이 undefined 가
     *   되어 `t` 가 통째로 사라지고, 첫 `t.어쩌구` 에서 부팅이 죽는다.
     *   저장된 설정에 그런 값이 들어 있으면 **켤 때마다 실패 화면**이고
     *   앱 데이터를 지우는 것 말고는 빠져나갈 길이 없다(2026-08-06 실측).
     *   설정을 되돌리는 것(settings.ts)과 여기, 두 겹으로 막는다.
     */
    if (setting !== 'system') return 'en';
    const tags = navigator.languages?.length ? navigator.languages : [navigator.language ?? ''];

    /*
     * ★★★ **순서를 지킨다.** 예전에는 `tags.some(startsWith('ko'))` 였다 —
     *   목록 어딘가에 한국어가 있기만 하면 한국어를 골랐다. 그런데
     *   navigator.languages 는 **사용자가 매긴 우선순위 목록**이다.
     *
     *   실기기 확인(2026-08-07, S22 Ultra / 안드로이드 16):
     *   안드로이드 13+ 의 '앱별 언어' 로 마크릿만 영어로 지정하면
     *       navigator.languages = ['en-US', 'ko-KR']
     *   가 되는데, 화면은 **한국어로 떴다.** 사용자가 이 앱만 콕 집어 영어로 바꿨는데
     *   그 지정이 무시된 것이다. 시스템 언어 목록을 '영어 1순위, 한국어 2순위' 로
     *   둔 사람(한국어 사용자 중에 흔하다)도 똑같이 겪는다.
     *
     * ★ 모르는 언어는 건너뛰고 다음 순위를 본다 — ['ja','ko'] 는 한국어가 맞다.
     *   아는 것이 하나도 없으면 영어다(카탈로그가 en/ko 둘뿐이다).
     */
    for (const tag of tags) {
        const base = tag.toLowerCase().split('-')[0];
        if (base === 'ko') return 'ko';
        if (base === 'en') return 'en';
    }
    return 'en';
}

/**
 * 언어를 정한다. ★ 화면을 만들기 **전에** 불러야 한다(main.ts 의 loadSettings 안).
 */
export function setLanguage(setting: LangSetting): Lang {
    active = resolveLang(setting);
    t = CATALOGS[active];
    /*
     * ★ <html lang> 을 같이 맞춘다. 장식이 아니다 —
     *   TalkBack 이 이 값으로 발음할 언어를 고르고, 브라우저가 줄바꿈 규칙을 고른다.
     */
    document.documentElement.lang = active;

    /*
     * ★★ CSS 는 카탈로그를 못 읽는다. `content:` 로 들어가는 글자는 여기서 넣어 줘야
     *   번역에서 빠지지 않는다 — 2026-08-04에 영어 스크린샷을 찍다가
     *   다이어그램 아래에 '탭하면 크게 보기' 가 한국어로 박혀 있는 걸 발견했다.
     * ★ CSS <string> 이라 **따옴표까지 포함해서** 넣는다.
     */
    document.documentElement.style.setProperty(
        '--i18n-zoom-hint',
        JSON.stringify(t.diagram.zoomHint),
    );
    return active;
}

/**
 * 목록 정렬·날짜에 쓰는 BCP-47 태그.
 * ★ `localeCompare(a, b, 'ko')` 처럼 언어를 고정해 두지 마라 —
 *   영어 사용자에게 한국어 정렬 규칙이 적용된다.
 */
export function localeTag(): string {
    return active === 'ko' ? 'ko-KR' : 'en-US';
}
