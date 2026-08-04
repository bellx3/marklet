# 개인정보처리방침 사이트 — 게시용 원본

Play Console 은 **공개된 URL** 을 요구한다. 이 폴더는 그대로 올리면 되는 상태로 만들어 뒀다.
게시는 사람이 해야 한다(계정이 필요하다).

## 게시 절차 (15분)

1. GitHub 에서 새 저장소 `marklet-privacy` 를 만든다. **Public** 이어야 한다.
2. 이 폴더(`release/privacy-site/`)의 내용을 그 저장소 루트에 올린다.
   `README.md` 는 올리지 않아도 된다.
   ```
   index.md
   ko/index.md
   _config.yml
   ```
3. 저장소 → Settings → Pages → Source 를 `Deploy from a branch`,
   Branch 를 `main` / `/ (root)` 로 두고 저장한다.
4. 몇 분 뒤 아래 두 주소가 열리는지 **직접 확인한다.**
   - https://bellx3.github.io/marklet-privacy/
   - https://bellx3.github.io/marklet-privacy/ko/
5. Play Console → 앱 콘텐츠 → 개인정보처리방침에 **영어 주소**를 넣는다.

## 올리기 전에 반드시 고칠 것

- [ ] 두 파일의 `**Effective date / 시행일:** 2026-XX-XX` 를 실제 게시일로 바꾼다.
- [ ] 사용자 이름이 `bellx3` 가 아니면 주소가 달라진다. 그러면
      `src/app/screens/settings.ts` 의 `PRIVACY_URL_EN` / `PRIVACY_URL_KO` 도 같이 고쳐라.
      **앱 안 링크와 스토어 등재 주소가 다르면 심사에서 걸린다.**

## 이 문서가 사실과 어긋나면 안 되는 항목

방침 본문은 앱의 실제 동작을 그대로 적은 것이다. 아래를 바꾸면 방침도 같이 고쳐야 한다.

| 방침의 문장 | 근거가 되는 코드 |
|---|---|
| 저장소 권한을 선언하지 않는다 | `AndroidManifest.xml` — `READ/WRITE_EXTERNAL_STORAGE` 없음 |
| 광고 ID 를 쓰지 않는다 | `AndroidManifest.xml` — `AD_ID` 권한 없음 |
| 문서 내용을 전송하지 않는다 | 네트워크 호출 없음. `connect-src 'self'` (index.html CSP) |
| 기기에만 저장한다 | `@capacitor/preferences` + 앱 전용 저장소만 사용 |
| 결제 정보를 받지 않는다 | `tip-manager.ts` — 상품 ID 와 거래 ID 만 저장 |
