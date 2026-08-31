import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * 부팅 감시 (public/webview-check.js).
 *
 * ★★ 이 파일은 번들에 들어가지 않는다. index.html 이 별도 <script> 로 먼저 부른다.
 *   그래서 import 가 아니라 **원본을 읽어 실행한다** — 실제로 배포되는 그 글자를 시험한다.
 *
 * ★ 여기서 지키려는 것은 두 가지다.
 *   1) 번들이 못 뜨는 기기에서 **흰 화면 대신 할 일이 뜬다.**
 *   2) 멀쩡히 뜬 앱을 **덮지 않는다.** 이걸 어기면 안전망이 사고의 원인이 된다.
 */

const SOURCE = readFileSync('public/webview-check.js', 'utf8');

/** 실제 배포 경로와 같게 — 문서에 #app 이 있는 상태에서 스크립트를 실행한다. */
function run(): void {
    document.body.innerHTML = '<div id="app"><div id="boot" class="boot-screen"></div></div>';
    new Function(SOURCE)();
}

function fatalText(): string | null {
    return document.querySelector('#app .fatal')?.textContent ?? null;
}

/** 모듈 스크립트의 구문 오류가 window 로 올라오는 모습을 흉내 낸다. */
function raiseSyntaxError(): void {
    const e = new ErrorEvent('error', {
        message: "SyntaxError: Unexpected token '?'",
        error: new SyntaxError("Unexpected token '?'"),
    });
    window.dispatchEvent(e);
}

beforeEach(() => {
    vi.useFakeTimers();
    delete (window as { __markletBooted?: boolean }).__markletBooted;
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('ko-KR');
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('부팅 감시', () => {
    it('구문 오류가 나면 WebView 를 갱신하라고 안내한다', () => {
        run();
        raiseSyntaxError();

        expect(fatalText()).toContain('WebView');
        // 사용자가 **무엇을 하면 되는지**가 있어야 한다. 원인만 적으면 안내가 아니다.
        expect(fatalText()).toContain('업데이트');
        // 부팅 화면은 걷어낸다 — 남겨 두면 안내가 그 뒤에 가린다.
        expect(document.querySelector('#boot')).toBeNull();
    });

    it('★ 앱이 뜬 뒤의 오류에는 손대지 않는다 — 읽던 문서를 빼앗으면 안 된다', () => {
        run();
        window.__markletBooted = true;

        raiseSyntaxError();
        vi.advanceTimersByTime(60000);

        expect(fatalText()).toBeNull();
    });

    it('★ 20초 안에 뜨면 덮지 않는다 (느린 기기의 콜드 스타트)', () => {
        run();

        vi.advanceTimersByTime(19000);
        window.__markletBooted = true;
        vi.advanceTimersByTime(60000);

        expect(fatalText()).toBeNull();
    });

    it('오류도 없이 20초가 지나면 다시 실행해 보라고 안내한다', () => {
        run();

        vi.advanceTimersByTime(20001);

        expect(fatalText()).toContain('시작하지 못했습니다');
        expect(fatalText()).toContain('WebView');
    });

    it('안내는 한 번만 뜬다 (오류가 연달아 나도 화면을 다시 갈아엎지 않는다)', () => {
        run();
        raiseSyntaxError();
        const first = document.querySelector('#app .fatal');

        raiseSyntaxError();
        vi.advanceTimersByTime(60000);

        expect(document.querySelectorAll('#app .fatal')).toHaveLength(1);
        expect(document.querySelector('#app .fatal')).toBe(first);
    });

    it('영어 기기에는 영어로 뜬다 — 카탈로그를 못 쓰므로 이 파일이 직접 들고 있다', () => {
        vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
        run();
        raiseSyntaxError();

        expect(fatalText()).toContain('WebView');
        expect(fatalText()).not.toMatch(/[가-힣]/);
    });
});

describe('★ 안전망 자신이 낡은 웹뷰에서 돌아야 한다', () => {
    /*
     * 이 파일이 파싱에 실패하면 안내를 띄울 코드마저 사라진다. 그래서 ES5 만 쓴다.
     * 아래는 '옛 문법 검사'가 아니라 **금지 목록**이다 — 실수로 최신 문법이 섞이는 것을 막는다.
     */
    it.each([
        ['화살표 함수', /=>/],
        ['const · let', /\b(const|let)\s/],
        ['템플릿 문자열', /`/],
        ['옵셔널 체이닝 · 널 병합', /\?\.|\?\?/],
        ['전개 구문', /\.\.\./],
    ])('%s 를 쓰지 않는다', (_name, pattern) => {
        // 주석은 뺀다 — 근거를 적은 글에 기호가 들어갈 수 있다.
        const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(code).not.toMatch(pattern);
    });

    it('CSP 가 막는 eval 계열을 쓰지 않는다', () => {
        // new Function 으로 구문을 시험하면 script-src 'self' 에서 EvalError 가 나고,
        // 그걸 '못 쓰는 기기'로 오판하면 **멀쩡한 기기를 전부 막는다.**
        const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');
        expect(code).not.toMatch(/\beval\s*\(|new\s+Function\s*\(/);
    });
});
