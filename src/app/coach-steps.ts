import type { CoachStep } from './coach';
import { t } from '../i18n';

/**
 * 안내에 쓰는 단계들.
 *
 * ★ 대상은 **CSS 선택자가 아니라 data-coach 이름으로** 찾는다.
 *   `.home-actions .btn-primary` 같은 것으로 잡으면 버튼 순서를 바꾸거나 클래스를
 *   손보는 순간 아무 말 없이 엉뚱한 곳을 가리킨다. 이름은 화면 쪽 코드에도 적혀 있어서
 *   (home.ts · viewer-screen.ts) 옮길 때 같이 눈에 띈다.
 *
 * ★ 문구는 t 에서 **부를 때마다** 읽는다. 모듈 최상위에서 상수로 만들면
 *   언어가 정해지기 전 값이 박힌다(i18n/index.ts 주석).
 */

/** data-coach 이름으로 화면에서 찾는다. 화면이 안 떠 있으면 null 이다. */
export function coachTarget(name: string): HTMLElement | null {
    /*
     * ★ 숨은 화면의 것을 집으면 안 된다. 시작 화면과 뷰어에 같은 이름이 있어서가 아니라,
     *   화면들이 전부 DOM 에 남아 있고 hidden 으로만 갈리기 때문이다(shell.ts register).
     *   숨은 것을 집으면 크기가 0 이라 구멍이 화면 왼쪽 위에 찍힌다.
     */
    const all = Array.from(document.querySelectorAll<HTMLElement>(`[data-coach="${name}"]`));
    return all.find((el) => !el.closest('[hidden]')) ?? null;
}

const at = (name: string) => (): HTMLElement | null => coachTarget(name);

/** 시작 화면 — "문서를 어떻게 가져오나" 한 바퀴. */
export function homeSteps(): CoachStep[] {
    return [
        {
            target: at('example'),
            title: t.coach.homeExampleTitle,
            body: t.coach.homeExampleBody,
        },
        {
            target: at('open-file'),
            title: t.coach.homeOpenTitle,
            body: t.coach.homeOpenBody,
        },
        {
            target: at('add-folder'),
            title: t.coach.homeFolderTitle,
            body: t.coach.homeFolderBody,
        },
        {
            target: at('search'),
            title: t.coach.homeSearchTitle,
            body: t.coach.homeSearchBody,
        },
    ];
}

/** 뷰어 — "읽는 동안 쓸 것" 한 바퀴. 첫 단계는 가리킬 곳 없이 화면 전체를 말한다. */
export function viewerSteps(): CoachStep[] {
    return [
        {
            target: () => null,
            title: t.coach.viewerIntroTitle,
            body: t.coach.viewerIntroBody,
        },
        {
            target: at('toc'),
            title: t.coach.viewerTocTitle,
            body: t.coach.viewerTocBody,
        },
        {
            target: at('find'),
            title: t.coach.viewerFindTitle,
            body: t.coach.viewerFindBody,
        },
        {
            target: at('more'),
            title: t.coach.viewerMoreTitle,
            body: t.coach.viewerMoreBody,
        },
    ];
}
