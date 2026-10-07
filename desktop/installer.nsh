; 설치기에 덧붙이는 레지스트리 항목 (electron-builder 의 nsis.include).
;
; electron-builder 의 fileAssociations 는 ProgID 와 .md 연결만 쓴다. 그것만으로는
; 윈도우의 '연결 프로그램' 목록에 앱 이름이 안 뜬다(2026-10-07 설치본에서 확인).
; 목록은 Applications\<exe> 의 FriendlyAppName 과 SupportedTypes 를 보고,
; '설정 > 기본 앱' 은 Capabilities + RegisteredApplications 를 본다. 둘 다 쓴다.
;
; ★ 전부 HKCU(현재 사용자)다. 관리자 권한이 필요 없고, 이 설치기가 perMachine:false 인 것과 맞다.
; ★ 기본 앱을 '대신 정해 주지' 않는다 — 윈도우가 막아 두었고, 사용자의 선택을 덮어쓰면 안 된다.
;   우리는 후보로 보이게만 한다.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\Applications\Marklet.exe" "FriendlyAppName" "Marklet"
  WriteRegStr HKCU "Software\Classes\Applications\Marklet.exe\DefaultIcon" "" "$INSTDIR\Marklet.exe,0"
  WriteRegStr HKCU "Software\Classes\Applications\Marklet.exe\shell\open\command" "" '"$INSTDIR\Marklet.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Applications\Marklet.exe\SupportedTypes" ".md" ""
  WriteRegStr HKCU "Software\Classes\Applications\Marklet.exe\SupportedTypes" ".markdown" ""
  WriteRegStr HKCU "Software\Classes\Applications\Marklet.exe\SupportedTypes" ".mdown" ""
  WriteRegStr HKCU "Software\Classes\Applications\Marklet.exe\SupportedTypes" ".mkd" ""

  WriteRegStr HKCU "Software\Marklet\Capabilities" "ApplicationName" "Marklet"
  WriteRegStr HKCU "Software\Marklet\Capabilities" "ApplicationDescription" "Markdown viewer"
  WriteRegStr HKCU "Software\Marklet\Capabilities\FileAssociations" ".md" "Marklet.Markdown"
  WriteRegStr HKCU "Software\Marklet\Capabilities\FileAssociations" ".markdown" "Marklet.Markdown"
  WriteRegStr HKCU "Software\Marklet\Capabilities\FileAssociations" ".mdown" "Marklet.Markdown"
  WriteRegStr HKCU "Software\Marklet\Capabilities\FileAssociations" ".mkd" "Marklet.Markdown"
  WriteRegStr HKCU "Software\RegisteredApplications" "Marklet" "Software\Marklet\Capabilities"

  ; 탐색기에 연결이 바뀌었음을 알린다(SHCNE_ASSOCCHANGED).
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Applications\Marklet.exe"
  DeleteRegKey HKCU "Software\Marklet"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Marklet"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
