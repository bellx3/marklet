# 출시 자산 (사람이 읽고 쓰는 것)

| 파일 | 쓰임 |
|---|---|
| `release-notes-console.txt` | Play Console 출시 노트 칸에 **그대로 붙여 넣는** 태그 포함 전문 |
| `store-listing.md` | 스토어 등재 문구 (제목·짧은 설명·전체 설명) |
| `privacy-site/` | GitHub Pages 로 띄우는 개인정보처리방침 |
| `프로덕션액세스_예상질의응답.md` | 비공개 테스트 14일이 끝난 뒤 낼 **프로덕션 액세스 신청** 답안 (빈칸 있음) |

## 출시 노트가 두 벌인 이유

| 파일 | 누가 읽는가 | 형식 |
|---|---|---|
| `android/app/src/main/play/release-notes/{en-US,ko-KR}/default.txt` | **Gradle Play Publisher** (`npm run publish:internal`) | 태그 없는 본문만 |
| `release/release-notes-console.txt` | **사람** — 콘솔에 손으로 붙여 넣을 때 | `<en-US>…</en-US>` 태그 포함 |

**★ 언어 태그를 `<locale>/default.txt` 안에 넣지 마라.** GPP 는 디렉터리 이름으로 이미 언어를 안다.
그 파일 안에 `<ko-KR>` 를 적으면 그 꺾쇠가 **출시 노트 본문 글자 그대로** 스토어에 올라간다.

반대로 Play Console 의 출시 노트 칸은 여러 언어를 한 번에 받을 때
`<en-US>…</en-US><ko-KR>…</ko-KR>` 형식을 쓴다. 그래서 붙여 넣기용을 따로 둔다.

**★★ 그 붙여 넣기용 파일을 `release-notes/` 안에 두지 마라.** GPP 가 빌드를 통째로 거부한다
(2026-08-04에 실제로 겪었다):

```
> Files are not allowed under the release-notes directory: console-all-locales.txt
```

그 디렉터리 밑에는 **로케일 디렉터리만** 있어야 한다. 그래서 여기(`release/`)로 뺐다.

## 고칠 때

**두 곳을 같이 고쳐라.** 한쪽만 고치면 손으로 올린 버전과 자동으로 올린 버전의
출시 노트가 달라지고, 그건 나중에 어느 쪽이 맞는지 알 방법이 없다.

- 언어당 **500자 상한**이다. 확인:
  ```bash
  node -e "const f=require('fs');for(const l of ['en-US','ko-KR'])console.log(l,f.readFileSync('android/app/src/main/play/release-notes/'+l+'/default.txt','utf8').trim().length)"
  ```
- 기본 언어는 **en-US** 다(`01_제품_결정서.md` 7.4절). 붙여 넣기용에서도 en-US 를 먼저 둔다.
- **빌드 번호를 문장에 넣지 마라.** "첫 내부 빌드입니다" 는 두 번째 빌드에서 거짓이 된다.

---

## 스크린샷

`screenshots/<locale>/*.png` — `npm run play:screenshots` 가 올린다.

**★ Play 는 긴 변이 짧은 변의 2배를 넘으면 거부한다.** 요즘 폰이 전부 여기 걸린다
(에뮬레이터 1080×2400 = 2.22배). 그래서 상태바를 잘라내고 **1080×2160** 으로 맞춘다 —
정확히 2배이고, Play 가 권하는 '기기 크롬 없는 화면'도 함께 만족한다.

```bash
# 에뮬레이터에서 찍은 원본을 규격에 맞게 다듬는다 (마지막 숫자는 상태바 높이 px)
python scripts/crop-shots.py <원본폴더> release/screenshots/en-US 63

npm run play:screenshots -- --dry   # 규격 검사만
npm run play:screenshots            # 올린다 (언어별로 먼저 비우고 새로 넣는다)
```

- 언어당 **2~8장**. 넘으면 거부된다
- **24비트 PNG** — `screencap` 은 RGBA 로 주므로 알파를 반드시 없앤다(crop-shots.py 가 한다)
- 언어별로 **앱 UI 언어를 맞춰서** 찍어라. 설정 → 언어에서 바꾸면 앱이 다시 읽힌다

### ★ 실기기로 찍지 마라

최근 문서 목록에 **사장님 개인 파일 이름이 그대로 나온다.** 에뮬레이터에 따로 문서를
밀어 넣고 찍는다.
