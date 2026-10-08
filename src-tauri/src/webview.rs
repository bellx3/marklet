//! WebView2 를 다듬는다. Tauri 가 직접 열어 주지 않는 설정과, PDF 만들기.
//!
//! 화면은 시스템에 깔린 WebView2(= Edge 의 엔진)가 그린다. 엔진은 설치 파일에 들어가지 않는다.

use tauri::WebviewWindow;

/// WebView2(Edge 엔진)에 주는 시작 인자 — **바깥으로 나가는 요청을 없앤다.**
///
/// 이 앱은 문서를 여는 동안 네트워크 요청이 0건이어야 한다. WebView2 는 가만히 두면 시작 직후에
///  · Edge 의 설정 서비스(config.edge.skype.com)를 부르고,
///  · 보안 DNS 확인용으로 dns.google 을 부른다(시스템 DNS 가 구글이면 특히)
/// 는 것을 net-log 로 확인했다(2026-10-07). 그래서:
///  · background-networking · component-update · sync · domain-reliability · pings · phishing-detection 을 끈다.
///  · 위 두 주소는 이름 해석 단계에서 막는다(host-resolver-rules). 시도는 하되 **이름 조회조차 밖으로 나가지 않는다.**
///    원격 이미지(사용자가 켠 경우)는 다른 주소라 영향이 없다.
///  · 첫 줄은 wry 가 기본으로 주던 인자다. additional_browser_args 를 주면 기본값이 대체되므로 그대로 넣는다.
pub const BROWSER_ARGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection ",
    "--disable-background-networking --disable-component-update --disable-sync ",
    "--disable-domain-reliability --no-pings --disable-client-side-phishing-detection ",
    "--host-resolver-rules=\"MAP dns.google ~NOTFOUND, MAP config.edge.skype.com ~NOTFOUND\""
);

/// 사진 뷰어에 필요 없는 브라우저 기능을 끈다.
///  - 브라우저 단축키(Ctrl+F 찾기 바 · Ctrl+U 소스 보기 · F5 새로고침 …): 우리 단축키와 겹친다.
///  - 상태 표시줄(링크 위에 마우스를 올리면 아래에 주소가 뜬다)
///  - 자동 완성 · 비밀번호 저장 팝업(검색 입력칸에 뜰 수 있다)
///  - 핀치 확대 · 스와이프 이동
pub fn harden(win: &WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Settings3, ICoreWebView2Settings4, ICoreWebView2Settings5,
        ICoreWebView2Settings6,
    };
    use windows::core::Interface;

    let _ = win.with_webview(|wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else {
            return;
        };
        let Ok(s) = core.Settings() else { return };
        let _ = s.SetIsStatusBarEnabled(false);
        if let Ok(s3) = s.cast::<ICoreWebView2Settings3>() {
            let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
        }
        if let Ok(s4) = s.cast::<ICoreWebView2Settings4>() {
            let _ = s4.SetIsGeneralAutofillEnabled(false);
            let _ = s4.SetIsPasswordAutosaveEnabled(false);
        }
        if let Ok(s5) = s.cast::<ICoreWebView2Settings5>() {
            let _ = s5.SetIsPinchZoomEnabled(false);
        }
        if let Ok(s6) = s.cast::<ICoreWebView2Settings6>() {
            let _ = s6.SetIsSwipeNavigationEnabled(false);
        }
    });
}

/// 창을 Win32 로 직접 숨긴다. tao 의 hide() 는 자기 기록(보임/안 보임)이 현재와 같다고 믿으면 아무 일도 안 한다.
pub fn force_hide(win: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    if let Ok(h) = win.hwnd() {
        unsafe {
            let _ = ShowWindow(HWND(h.0 as *mut _), SW_HIDE);
        }
    }
}

/// 숨겨 둔 창의 메모리 목표를 낮춘다(빠른 시작으로 닫은 뒤 대기하는 동안). 다시 쓸 때 원래대로 돌려 놓는다.
/// WebView2 가 캐시 · 사용하지 않는 자원을 풀어 준다. 지원하지 않는 런타임이면 조용히 넘어간다.
pub fn set_memory_low(win: &WebviewWindow, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows::core::Interface;

    let _ = win.with_webview(move |wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else {
            return;
        };
        let Ok(c) = core.cast::<ICoreWebView2_19>() else {
            return;
        };
        let _ = c.SetMemoryUsageTargetLevel(if low {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
        } else {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
        });
    });
}

/// 지금 문서를 PDF 로 만든다(DevTools 프로토콜의 Page.printToPDF).
///
/// ★ generateDocumentOutline: 제목(h1~h6)이 PDF 책갈피가 된다. generateTaggedPDF: 접근성 구조 태그.
/// 블로킹이다 — 메인 스레드에서 부르지 마라(WebView2 호출은 메인 스레드로 넘어가 돌고, 여기서 결과를 기다린다).
pub fn print_to_pdf(win: &WebviewWindow) -> Result<Vec<u8>, String> {
    use base64::Engine;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;

    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let params = r#"{"printBackground":true,"generateDocumentOutline":true,"generateTaggedPDF":true,"paperWidth":8.27,"paperHeight":11.69,"preferCSSPageSize":false}"#;

    let tx_call = tx.clone();
    win.with_webview(move |wv| unsafe {
        let core = match wv.controller().CoreWebView2() {
            Ok(c) => c,
            Err(e) => {
                let _ = tx_call.send(Err(format!("CoreWebView2: {e}")));
                return;
            }
        };
        let tx_done = tx_call.clone();
        let handler =
            CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |res, json| {
                let _ = tx_done.send(match res {
                    Ok(()) => Ok(json),
                    Err(e) => Err(format!("printToPDF: {e}")),
                });
                Ok(())
            }));
        if let Err(e) = core.CallDevToolsProtocolMethod(
            &HSTRING::from("Page.printToPDF"),
            &HSTRING::from(params),
            &handler,
        ) {
            let _ = tx_call.send(Err(format!("CallDevToolsProtocolMethod: {e}")));
        }
    })
    .map_err(|e| e.to_string())?;

    let json = rx
        .recv_timeout(std::time::Duration::from_secs(120))
        .map_err(|_| "PDF 를 만드는 데 너무 오래 걸립니다".to_string())??;
    let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let data = v
        .get("data")
        .and_then(|d| d.as_str())
        .ok_or("PDF 데이터가 없습니다")?;
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| e.to_string())
}
