import { Overlay } from './overlay';
import { t } from '../i18n';

/**
 * 스포트라이트 안내 (코치마크).
 *
 * 화면을 어둡게 덮고 **한 곳만 구멍을 내어** 밝게 남긴 뒤, 그 옆에 말풍선으로 설명한다.
 * 마크다운이 처음인 사용자가 "이 앱으로 무엇을, 어디를 눌러서 하는가"를 한 바퀴 보게 하는 것이
 * 목적이다 — 기능 자랑이 아니라 첫 관문 넘기기다.
 *
 * ★ 구멍은 SVG 마스크가 아니라 **거대한 box-shadow** 로 판다(components.css 참고).
 *   상자 하나에 그림자를 화면보다 크게 주면 그 상자를 뺀 전부가 어두워진다.
 *   마스크보다 훨씬 싸고, 웹뷰 판올림에 덜 민감하다.
 *
 * ★★ 어두운 부분을 그리는 상자(.coach-hole)와 **탭을 받는 상자(.coach-backdrop)는 따로다.**
 *   box-shadow 로 칠한 영역은 포인터 이벤트를 받지 않는다. 그것만 두면 안내가 떠 있는데도
 *   뒤의 버튼이 그대로 눌린다 — 사용자는 설명을 읽다 말고 엉뚱한 화면으로 끌려간다.
 *
 * ★ 하이라이트된 것을 눌러도 아무 일도 일어나지 않는다. 일부러 그렇게 뒀다.
 *   안내 중에 진짜 파일 선택기가 열리면 안내와 화면이 어긋나고, 되돌아왔을 때
 *   몇 번째 단계였는지 아무도 모른다. 진행은 [다음]·[건너뛰기] 두 버튼으로만 한다.
 */

export type CoachResult = 'done' | 'skipped' | 'interrupted';

export interface CoachStep {
    /**
     * 하이라이트할 대상을 그때그때 찾는다. **미리 받아 두지 않는 것이 중요하다** —
     * 화면은 다시 그려질 수 있고, 그러면 붙잡아 둔 노드는 이미 문서에서 빠져 있다.
     * null 을 돌려주면 구멍 없이 화면 가운데에 말풍선만 띄운다.
     */
    target(): HTMLElement | null;
    title: string;
    body: string;
}

/** 구멍이 대상에 딱 붙지 않게 남기는 여백 */
const HOLE_PAD = 6;
/** 말풍선과 구멍 사이 */
const GAP = 12;
/** 말풍선이 화면 가장자리에 붙지 않게 */
const EDGE = 12;

let openCoach: (() => void) | null = null;

/** 지금 안내가 떠 있는가. 다른 화면 전환이 이걸 보고 자기 안내를 미룬다. */
export function isCoachOpen(): boolean {
    return openCoach !== null;
}

/**
 * 떠 있으면 즉시 닫는다(문서가 밖에서 들어오는 것처럼 화면이 통째로 바뀔 때).
 *
 * ★ 이때는 'interrupted' 로 끝난다 — **'봤다' 로 세면 안 된다.**
 *   카톡에서 .md 를 눌러 들어온 사람은 안내를 읽은 적이 없는데, 그걸 건너뛴 것으로
 *   치면 안내가 영영 다시 안 뜬다. 그 사람이야말로 안내가 필요한 사람이다.
 */
export function closeCoach(): void {
    openCoach?.();
}

/**
 * 안내를 한 바퀴 돌린다.
 *
 * @returns 끝까지 봤으면 'done', 건너뛰거나 뒤로가기로 닫았으면 'skipped',
 *   화면이 바뀌어 중간에 걷힌 것이면 'interrupted'.
 *   부르는 쪽은 이 값으로 "이 안내만 껐다"·"안내를 그만 보겠다"·"아직 안 봤다"를 가른다.
 */
export function runCoach(steps: CoachStep[]): Promise<CoachResult> {
    if (steps.length === 0) return Promise.resolve('done');
    // 겹쳐 뜨면 뒤엣것이 앞엣것의 초점을 빼앗는다. 새로 열지 않고 그대로 둔다.
    if (openCoach) return Promise.resolve('interrupted');

    const root = document.createElement('div');
    root.className = 'coach-backdrop';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'coach-title');

    const hole = document.createElement('div');
    hole.className = 'coach-hole';
    // 장식이다. 스크린 리더가 읽을 것이 없다.
    hole.setAttribute('aria-hidden', 'true');
    hole.hidden = true;

    const card = document.createElement('div');
    card.className = 'coach-card';

    const count = document.createElement('p');
    count.className = 'coach-count';

    const title = document.createElement('h2');
    title.className = 'coach-title';
    title.id = 'coach-title';

    const body = document.createElement('p');
    body.className = 'coach-body';

    const actions = document.createElement('div');
    actions.className = 'coach-actions';

    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'btn btn-compact coach-skip';
    skip.textContent = t.coach.skip;

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'btn btn-primary btn-compact';
    /*
     * ★ 초점은 [다음] 이 받는다. 토크백 사용자는 이 버튼만 연타해도 끝까지 갈 수 있고,
     *   하드웨어 키보드에서도 엔터만 누르면 된다.
     */
    next.dataset.autofocus = '';

    actions.append(skip, next);
    card.append(count, title, body, actions);
    root.append(hole, card);
    document.body.appendChild(root);

    let index = 0;
    let settle: ((r: CoachResult) => void) | null = null;
    let result: CoachResult = 'skipped';

    const overlay = new Overlay(root, 'coach', () => {
        // ★ 닫힘 애니메이션까지 끝난 뒤에 치운다. 먼저 지우면 초점이 body 로 떨어진다.
        root.remove();
        window.removeEventListener('resize', place);
        window.removeEventListener('orientationchange', place);
        openCoach = null;
        settle?.(result);
        settle = null;
    });

    function finish(how: CoachResult): void {
        result = how;
        overlay.hide();
    }

    /**
     * 구멍과 말풍선을 놓는다.
     *
     * ★ 대상이 화면 밖이거나 크기가 0이면 **구멍을 포기하고** 가운데 말풍선으로 간다.
     *   억지로 0×0 짜리 구멍을 그리면 화면 왼쪽 위에 점 하나가 빛나고, 사용자는
     *   그 점이 무엇인지 찾다가 안내를 닫는다. jsdom(테스트)도 이 길로 온다.
     */
    function place(): void {
        const el = steps[index].target();
        const r = el?.getBoundingClientRect();
        const ok = !!r && r.width > 0 && r.height > 0;

        hole.hidden = !ok;
        card.classList.toggle('coach-card--center', !ok);
        /*
         * ★★ 구멍이 없으면 **배경을 직접 어둡게 한다.**
         *   화면을 덮는 어둠은 구멍의 그림자가 그리는 것이라, 구멍을 숨기면 어둠도 같이
         *   사라진다. 2026-08-31 실기기에서 그대로 나왔다 — 뷰어 첫 단계(가리킬 곳 없음)에서
         *   문서가 멀쩡히 밝은 채 말풍선만 떠서, 안내인지 문서 일부인지 알 수 없었다.
         *   게다가 탭은 backdrop 이 먹고 있으니 '눌러도 반응 없는 화면' 이 된다.
         */
        root.classList.toggle('coach-backdrop--dim', !ok);

        if (!ok || !r) {
            card.style.top = '';
            return;
        }

        const top = r.top - HOLE_PAD;
        const left = r.left - HOLE_PAD;
        hole.style.top = `${top}px`;
        hole.style.left = `${left}px`;
        hole.style.width = `${r.width + HOLE_PAD * 2}px`;
        hole.style.height = `${r.height + HOLE_PAD * 2}px`;

        /*
         * 말풍선은 구멍 아래에 두되, 아래가 좁으면 위로 올린다.
         * ★ 높이는 **지금 화면에 있는 상자에서 잰다.** 글자 크기 설정과 번역 길이에 따라
         *   두 배까지 차이가 나므로 어림값을 박아 두면 어느 언어에서는 반드시 잘린다.
         */
        const vh = window.innerHeight || document.documentElement.clientHeight || 0;
        const h = card.getBoundingClientRect().height;
        const below = top + r.height + HOLE_PAD * 2 + GAP;
        const above = top - GAP - h;
        const fitsBelow = below + h + EDGE <= vh;
        const y = fitsBelow ? below : Math.max(EDGE, above);
        card.style.top = `${Math.min(y, Math.max(EDGE, vh - h - EDGE))}px`;
    }

    function render(): void {
        const step = steps[index];
        const last = index === steps.length - 1;

        count.textContent = t.coach.progress(index + 1, steps.length);
        title.textContent = step.title;
        body.textContent = step.body;
        next.textContent = last ? t.coach.done : t.coach.next;
        // 마지막 단계에서는 [건너뛰기] 가 할 일이 없다 — [시작하기] 와 같은 말이 된다.
        skip.hidden = last;

        /*
         * 대상이 화면 밖이면 끌어온다. 상단 바에 있는 것들은 늘 보이지만,
         * 화면이 작거나 글자가 크면 시작 화면의 단추가 접혀 내려갈 수 있다.
         */
        const el = step.target();
        const r = el?.getBoundingClientRect();
        if (r && r.height > 0 && (r.top < 0 || r.bottom > (window.innerHeight || 0))) {
            el?.scrollIntoView({ block: 'center' });
        }

        place();
    }

    skip.addEventListener('click', () => finish('skipped'));
    next.addEventListener('click', () => {
        if (index === steps.length - 1) {
            finish('done');
            return;
        }
        index++;
        render();
    });

    window.addEventListener('resize', place);
    window.addEventListener('orientationchange', place);

    /*
     * 뒤로가기로 닫는 것도 '건너뛰기'다(Overlay 가 레이어를 얹어 준다).
     * result 의 기본값이 'skipped' 라 따로 붙일 것이 없다.
     */
    openCoach = () => finish('interrupted');

    const done = new Promise<CoachResult>((r) => {
        settle = r;
    });

    render();
    overlay.show();
    // ★ 한 번 더 놓는다. show() 가 hidden 을 떼기 전 높이는 0 이라 첫 계산이 빗나간다.
    place();

    return done;
}
