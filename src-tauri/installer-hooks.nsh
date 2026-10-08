; 설치기에 덧붙이는 레지스트리 항목 (tauri.conf.json 의 bundle.windows.nsis.installerHooks).
;
; Tauri 의 fileAssociations 는 ProgID 와 .md 연결만 쓴다. 그것만으로는 윈도우의 '연결 프로그램' 목록에
; 앱 이름이 안 뜬다. 목록은 Applications\<exe> 의 FriendlyAppName 과 SupportedTypes 를 보고,
; '설정 > 기본 앱' 은 Capabilities + RegisteredApplications 를 본다. 둘 다 쓴다.
;
; ★ 전부 HKCU(현재 사용자)다. 관리자 권한이 필요 없고, installMode 가 currentUser 인 것과 맞다.
; ★ 기본 앱을 '대신 정해 주지' 않는다 — 윈도우가 막아 두었고, 사용자의 선택을 덮어쓰면 안 된다.
;   우리는 후보로 보이게만 한다.

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Applications\Marklet.exe" "FriendlyAppName" "Marklet"
  WriteRegStr HKCU "Software\Classes\Applications\Marklet.exe\DefaultIcon" "" "$INSTDIR\Marklet.exe,0"
  WriteRegStr HKCU "Software\Classes\Applications\Marklet.exe\shell\open\command" "" '"$INSTDIR\Marklet.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Applications\Marklet.exe\SupportedTypes" ".md" ""
  WriteRegStr HKCU "Software\Classes\Applications\Marklet.exe\SupportedTypes" ".markdown" ""
  WriteRegStr HKCU "Software\Classes\Applications\Marklet.exe\SupportedTypes" ".mdown" ""
  WriteRegStr HKCU "Software\Classes\Applications\Marklet.exe\SupportedTypes" ".mkd" ""
  WriteRegStr HKCU "Software\Classes\Applications\Marklet.exe\SupportedTypes" ".txt" ""

  WriteRegStr HKCU "Software\Marklet\Capabilities" "ApplicationName" "Marklet"
  WriteRegStr HKCU "Software\Marklet\Capabilities" "ApplicationDescription" "Markdown viewer"
  WriteRegStr HKCU "Software\Marklet\Capabilities\FileAssociations" ".md" "Marklet.Markdown"
  WriteRegStr HKCU "Software\Marklet\Capabilities\FileAssociations" ".markdown" "Marklet.Markdown"
  WriteRegStr HKCU "Software\Marklet\Capabilities\FileAssociations" ".mdown" "Marklet.Markdown"
  WriteRegStr HKCU "Software\Marklet\Capabilities\FileAssociations" ".mkd" "Marklet.Markdown"
  ; .txt 는 '열기 후보'로만 올린다. 기본 연결(.txt 의 기본값)은 건드리지 않는다 —
  ; 메모장이 정해 둔 사용자의 선택을 우리가 덮어쓰면 안 된다.
  WriteRegStr HKCU "Software\Marklet\Capabilities\FileAssociations" ".txt" "Marklet.Text"
  WriteRegStr HKCU "Software\Classes\Marklet.Text" "" "Text document"
  ; .txt 는 .md 와 다른 아이콘을 쓴다 — 탐색기에서 두 종류가 한 모양으로 보이면 헷갈린다. txt.ico 는 tauri.conf.json 의
  ; bundle.resources 가 설치 폴더에 놓는다(scripts/make-txt-icon.mjs 가 만든다). 혹시 없으면 앱 아이콘으로 둔다.
  IfFileExists "$INSTDIR\txt.ico" 0 marklet_txt_icon_fallback
    WriteRegStr HKCU "Software\Classes\Marklet.Text\DefaultIcon" "" "$INSTDIR\txt.ico"
    Goto marklet_txt_icon_done
  marklet_txt_icon_fallback:
    WriteRegStr HKCU "Software\Classes\Marklet.Text\DefaultIcon" "" "$INSTDIR\Marklet.exe,0"
  marklet_txt_icon_done:
  WriteRegStr HKCU "Software\Classes\Marklet.Text\shell\open\command" "" '"$INSTDIR\Marklet.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\.txt\OpenWithProgids" "Marklet.Text" ""

  WriteRegStr HKCU "Software\RegisteredApplications" "Marklet" "Software\Marklet\Capabilities"

  ; 탐색기에 연결이 바뀌었음을 알린다(SHCNE_ASSOCCHANGED).
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Applications\Marklet.exe"
  DeleteRegKey HKCU "Software\Marklet"
  DeleteRegKey HKCU "Software\Classes\Marklet.Text"
  DeleteRegValue HKCU "Software\Classes\.txt\OpenWithProgids" "Marklet.Text"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Marklet"
  ; 보기 메뉴의 '로그인할 때 미리 켜 두기'를 켰다면 남아 있는 Run 항목도 지운다(없는 값을 지우는 것은 무해하다).
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Marklet"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

; ── 빠른 시작으로 숨겨 두고 기다리는 Marklet 정리 ─────────────────────────────────
; Marklet 은 마지막 창을 닫아도 몇 분 동안 창 없이 살아 있다(다음 문서를 바로 띄우려고). 그 상태에서 설치·제거를 하면 설치기의 '실행 중입니다'
; 확인 상자가 뜨는데 사용자는 아무 창도 못 본다. 그래서 먼저 `--quit-warm` 을 보낸다 — 숨겨 두고 기다리는 중이면 끝나고, **창이 떠 있으면
; 아무것도 하지 않는다**(그 경우는 설치기의 기본 확인 상자가 맡는다). 이 훅은 그 확인 상자보다 먼저 돈다.

!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\Marklet.exe" 0 marklet_skip_quit_warm_i
    ExecWait '"$INSTDIR\Marklet.exe" --quit-warm'
    Sleep 800
  marklet_skip_quit_warm_i:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  IfFileExists "$INSTDIR\Marklet.exe" 0 marklet_skip_quit_warm_u
    ExecWait '"$INSTDIR\Marklet.exe" --quit-warm'
    Sleep 800
  marklet_skip_quit_warm_u:
!macroend
