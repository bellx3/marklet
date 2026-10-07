/*
 * 부팅 감시 — **번들이 아예 못 뜨는 경우**를 위한 마지막 안전망.
 *
 * ★★ 왜 필요한가. main.ts 의 부팅 실패 처리(try/catch)는 **자기 번들이 실행될 때만** 돈다.
 *   번들이 구문 오류로 파싱조차 못 되면 그 catch 는 존재하지도 않고, 사용자는
 *   index.html 의 #boot 화면(빈 배경)만 영원히 본다. 원인도, 할 일도 화면에 없다.
 *
 * ★★ 그 일이 실제로 일어날 수 있다. 빌드 타깃이 es2020(= Chrome 80)인데,
 *   minSdk 26(Android 8)의 **공장 출하 WebView 는 Chrome 60** 이다. WebView 는 Play 로
 *   따로 갱신되므로 대개는 최신이지만, Play 가 없거나 갱신이 막힌 기기는 60 언저리에
 *   머문다 — 그런 기기에서 이 앱은 지금 흰 화면이다.
 *   (2026-08-31 Android 7 기기 확인 중에 발견. 그 기기는 WebView 제공자가 Chrome 103
 *    이라 잘 돌았지만, 같은 세대라도 그렇지 않은 기기가 있을 수 있다는 것이 요점이다.)
 *
 * ★ 이 파일의 규칙 세 가지. 어기면 안전망이 같이 무너진다.
 *   1) **ES5 만 쓴다.** 화살표 함수·const·템플릿 문자열 금지. 이 파일이 파싱에 실패하면
 *      안내를 띄울 코드마저 없어진다.
 *   2) **버전 판정을 하지 않는다.** `new Function` 으로 구문을 시험하는 방법이 있지만
 *      CSP 가 `script-src 'self'`(unsafe-eval 없음)라 **EvalError 로 막힌다** —
 *      멀쩡한 기기를 전부 '못 쓰는 기기'로 판정하게 된다. UA 문자열 표를 두는 것도
 *      기기마다 어긋난다. 그래서 **결과만 본다**: 앱이 떴는가, 오류가 났는가.
 *   3) **문구를 카탈로그에서 가져오지 않는다.** i18n 은 번들 안에 있고, 지금은 그 번들이
 *      죽은 상황이다. 여기서만 예외로 두 언어를 직접 들고 있는다.
 */
(function () {
    'use strict';

    /** 앱이 화면을 띄우면 main.ts 가 이 값을 true 로 만든다. */
    function booted() {
        return window.__markletBooted === true;
    }

    var shown = false;

    var TEXT = {
        ko: {
            old:
                '이 기기의 시스템 WebView가 오래되어 Marklet을 실행할 수 없습니다.\n\n' +
                'Play 스토어에서 "Android System WebView"와 Chrome을 업데이트한 뒤 다시 열어 주세요.',
            stuck:
                '앱을 시작하지 못했습니다. 앱을 완전히 종료한 뒤 다시 실행해 주세요.\n\n' +
                '계속 같은 화면이면 Play 스토어에서 "Android System WebView"와 Chrome을 업데이트해 주세요.',
        },
        en: {
            old:
                'This device’s system WebView is too old to run Marklet.\n\n' +
                'Update "Android System WebView" and Chrome in the Play Store, then open the app again.',
            stuck:
                'The app did not start. Close it completely and open it again.\n\n' +
                'If you keep seeing this, update "Android System WebView" and Chrome in the Play Store.',
        },
    };

    function pick(kind) {
        var tag = (navigator.language || '') + '';
        var lang = tag.toLowerCase().indexOf('ko') === 0 ? 'ko' : 'en';
        return TEXT[lang][kind];
    }

    function show(kind) {
        if (shown || booted()) return;
        shown = true;

        var app = document.getElementById('app');
        if (!app) return;

        /*
         * ★ CSS 는 <link> 로 따로 오므로 번들이 죽어도 살아 있다. 그래서 .fatal 을 쓴다.
         *   혹시 CSS 마저 없더라도 글자는 읽힌다 — 스타일 없는 <p> 로 남을 뿐이다.
         */
        var box = document.createElement('div');
        box.className = 'fatal';
        box.style.whiteSpace = 'pre-wrap';
        box.textContent = pick(kind);

        while (app.firstChild) app.removeChild(app.firstChild);
        app.appendChild(box);
    }

    /*
     * 1. 번들이 못 뜨는 경우.
     *
     * ★ 모듈 스크립트의 **구문 오류도 window 의 error 이벤트로 올라온다.** 그것을 잡는다.
     *   부팅 전에 올라온 오류만 본다 — 앱이 뜬 뒤의 오류는 앱이 알아서 처리할 몫이고,
     *   여기서 화면을 갈아엎으면 읽던 문서를 빼앗는 꼴이 된다.
     */
    window.addEventListener(
        'error',
        function (e) {
            if (booted()) return;
            var msg = (e && e.message ? e.message : '') + '';
            var isSyntax =
                (e && e.error && e.error.name === 'SyntaxError') ||
                msg.indexOf('SyntaxError') >= 0 ||
                msg.indexOf('Unexpected token') >= 0 ||
                msg.indexOf('Unexpected identifier') >= 0;
            show(isSyntax ? 'old' : 'stuck');
        },
        true,
    );

    /*
     * 2. 오류도 없이 그냥 멎는 경우(자원 로드 실패 등).
     *
     * ★ 넉넉히 기다린다. 저사양 기기의 콜드 스타트를 오해하면 **멀쩡한 부팅을 실패로
     *   덮어쓴다.** 실측 기준: Galaxy S6(2015년 기기)에서 첫 화면까지 3초 남짓이었다.
     *   20초는 "느린 것"이 아니라 "안 되는 것"이다.
     */
    setTimeout(function () {
        show('stuck');
    }, 20000);
})();
