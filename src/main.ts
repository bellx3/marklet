// ★ CSS import 순서가 중요하다. utilities.css 가 반드시 마지막이다(11-3절).
import './styles/base.css';
import './styles/markdown.css';
import './styles/hljs.css';
import './styles/components.css';
import './styles/utilities.css';

import { loadSettings, watchSystemTheme } from './services/settings';
import { t, setLanguage } from './i18n';
import { TipManager } from './services/tip-manager';
import { installDraftFlushHooks, pruneDraftOrphans } from './services/draft';
import { initRouter } from './app/router';
import { initDocumentEntry } from './services/document-entry';
import { reconcileRecents, pruneSnapshotOrphans } from './services/recents';
import { mark, measure, record } from './utils/perf';
import * as shell from './app/shell';

async function boot(): Promise<void> {
    mark('boot:start');

    // 1. 화면이 뜨기 전에 테마·글자 크기를 확정한다. 안 그러면 흰 화면이 번쩍인다.
    await loadSettings();
    watchSystemTheme();

    // 2. 뒤로가기 라우터를 먼저 건다. 이게 늦으면 초기 뒤로가기가 앱을 그냥 종료시킨다.
    initRouter();

    // 3. 셸(화면들 마운트)
    shell.mount(document.querySelector<HTMLElement>('#app')!);
    document.querySelector('#boot')?.remove();

    // 4. 문서 진입. 콜드 스타트로 파일이 들어왔으면 여기서 바로 연다.
    //    ★ 네이티브가 없는 브라우저에서도 화면이 뜨도록 실패를 삼킨다.
    try {
        await initDocumentEntry(shell.entryHandlers);
    } catch (err) {
        console.warn('문서 진입 초기화 실패 — 웹 환경으로 간주:', err);
        shell.entryHandlers.showHome();
    }
    measure('boot:first-screen', 'boot:start');
    /*
     * ★★★ 위 값은 **JS 부팅만** 잰다. 사용자가 기다리는 시간이 아니다 (2026-08-07 실측).
     *   같은 실행에서 —
     *       boot:first-screen        135ms   (boot() 안에서 흐른 시간)
     *       페이지 로드까지            583ms   (HTML·CSS·JS 받고 파싱)
     *       시스템 TotalTime         3578ms  (아이콘을 누른 순간부터)
     *   진단 화면만 보면 "0.1초 만에 뜬다" 로 읽힌다. 그런데 사용자는 3.6초를 기다렸다.
     *   그 상태로 "느리다" 는 문의를 받으면 **엉뚱한 데를 파게 된다.**
     *
     *   performance.now() 는 페이지 로드 시작 기준이므로 HTML·JS 받고 파싱한 시간까지
     *   포함한다. 네이티브 프로세스 시작·웹뷰 초기화는 여기서 볼 수 없지만,
     *   보이는 창이 5배 넓어지고 시스템 값과 나란히 놓고 읽을 수 있게 된다.
     */
    record('boot:page-to-screen', performance.now());

    // 5. 여기부터는 첫 화면 이후여도 되는 것들
    await hideSplash();
    await installDraftFlushHooks();
    void reconcileRecents().then(() => shell.refreshRecents());
    void TipManager.init(); // deviceready 를 기다리므로 await 하지 않는다

    /*
     * ★ 닿을 수 없게 된 초안 파일 정리. 첫 화면 뒤에 조용히 돈다 —
     *   부팅을 붙잡을 값어치가 없고, 실패해도 아무 일도 안 일어난다.
     */

    void pruneDraftOrphans();
    // ★ 사본도 같이 치운다. 예전 판이 남긴 것까지 여기서 정리된다(8-2절).
    void pruneSnapshotOrphans();
}

async function hideSplash(): Promise<void> {
    try {
        const { SplashScreen } = await import('@capacitor/splash-screen');
        await SplashScreen.hide();
    } catch {
        /* 웹 환경 */
    }
}

void boot().catch((err) => {
    // 부팅 실패를 흰 화면으로 남기지 마라. 픽셀오아시스 작업 #37 과 같은 종류의 사고다.
    console.error('부팅 실패:', err);
    const fatal = document.createElement('div');
    fatal.className = 'fatal';
    // ★ 여기까지 왔다면 loadSettings 가 실패했을 수 있다 — 언어가 아직 안 정해졌다.
    //   이 한 줄이 없으면 한국어 사용자가 부팅 실패 화면만 영어로 보게 된다.
    setLanguage('system');
    fatal.textContent = t.fatal.bootFailed;
    document.body.replaceChildren(fatal);
    void hideSplash();
});
