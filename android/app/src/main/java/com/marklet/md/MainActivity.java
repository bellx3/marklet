package com.marklet.md;

import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;
import com.marklet.md.mdfile.MdFilePlugin;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // ★ 반드시 super.onCreate() 앞. 순서를 바꾸면 플러그인이 등록되지 않고
        //   JS 에서 "MdFile is not implemented" 가 난다.
        //   BridgeActivity 의 bridgeBuilder 는 필드 선언 시점에 생기지만
        //   실제 Bridge 는 super.onCreate() 안에서 만들어진다.
        registerPlugin(MdFilePlugin.class);

        super.onCreate(savedInstanceState);

        // 릴리스 빌드에서 웹뷰 내부를 들여다볼 수 없게 한다.
        // 이 검사를 빼고 무조건 true 를 주면 스토어에 나간 앱을 USB 로 연결한 누구든
        // Chrome DevTools 로 내부를 볼 수 있다.
        //
        // BuildConfig.DEBUG 대신 ApplicationInfo 를 쓰는 이유: Capacitor 가 만든
        // MainActivity 는 앱 모듈의 BuildConfig 를 import 하지 않은 상태로 생성되고,
        // 패키지명을 바꾸면 import 경로가 어긋난다. 이 방식은 패키지명과 무관하다.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        applySafeAreaToWebView();
    }

    /**
     * 시스템 바·디스플레이 컷아웃 인셋을 CSS 커스텀 속성으로 웹에 넘긴다.
     *
     * ★ 왜 직접 해야 하는가 (2026-08-03 실기기에서 확인한 것):
     *   - targetSdk 36 이라 Android 15+ 가 edge-to-edge 를 강제한다.
     *     실제로 창이 frame=[0,0][1080,2316] 로 전체화면이고
     *     layoutInDisplayCutoutMode=always 라 펀치홀 영역에도 그린다.
     *   - 그런데 **상단 인셋을 아무도 주지 않는다.** 하단(내비게이션 바) 몫만 반영되어
     *     WebView 높이가 줄고, 상단은 그대로라 상단 바가 펀치홀·상태바와 겹친다.
     *   - CSS 의 env(safe-area-inset-top) 은 안드로이드 WebView 에서 **0px 이다**(실측).
     *     그 값은 컷아웃 전용이고 상태바를 포함하지 않는다.
     *   - Capacitor 8 의 내장 SystemBars 플러그인이 --safe-area-inset-* 를 주입하게
     *     되어 있으나 이 조합에서는 **주입되지 않았다**(웹에서 읽으면 비어 있었다).
     *
     *   그래서 표준 안드로이드 방식으로 직접 읽어 넘긴다. 웹 쪽은 base.css 의
     *   --safe-top / --safe-right / --safe-bottom / --safe-left 가 이 값을 받는다.
     */
    private void applySafeAreaToWebView() {
        final View root = getWindow().getDecorView();

        ViewCompat.setOnApplyWindowInsetsListener(root, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            float density = getResources().getDisplayMetrics().density;
            injectSafeArea(
                bars.top / density,
                bars.right / density,
                bars.bottom / density,
                bars.left / density
            );
            // 소비하지 않고 그대로 흘려보낸다. 다른 뷰도 인셋을 봐야 한다.
            return windowInsets;
        });

        ViewCompat.requestApplyInsets(root);
    }

    private void injectSafeArea(float top, float right, float bottom, float left) {
        final WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView == null) return;

        final String script = String.format(
            java.util.Locale.US,
            "(function(){var s=document.documentElement.style;" +
            "s.setProperty('--safe-area-inset-top','%.2fpx');" +
            "s.setProperty('--safe-area-inset-right','%.2fpx');" +
            "s.setProperty('--safe-area-inset-bottom','%.2fpx');" +
            "s.setProperty('--safe-area-inset-left','%.2fpx');})();",
            top, right, bottom, left
        );

        // 인셋 콜백은 메인 스레드에서 오지만 WebView 호출은 명시적으로 post 한다.
        webView.post(() -> webView.evaluateJavascript(script, null));
    }
}
