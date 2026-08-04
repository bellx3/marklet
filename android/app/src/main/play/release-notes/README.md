# 출시 노트 — 파일이 두 벌인 이유

| 파일 | 누가 읽는가 | 형식 |
|---|---|---|
| `en-US/default.txt` · `ko-KR/default.txt` | **Gradle Play Publisher** (`npm run publish:internal`) | 태그 없는 본문만 |
| `console-all-locales.txt` | **사람** — Play Console 에 손으로 붙여 넣을 때 | `<en-US>…</en-US>` 태그 포함 |

## ★ 언어 태그를 `<locale>/default.txt` 안에 넣지 마라

GPP 는 **디렉터리 이름으로 이미 언어를 안다.** 그 파일 안에 `<ko-KR>` 를 적으면
그 꺾쇠가 **출시 노트 본문 글자 그대로** 스토어에 올라간다.

반대로 Play Console 의 출시 노트 칸은 여러 언어를 한 번에 받을 때
`<en-US>…</en-US><ko-KR>…</ko-KR>` 형식을 쓴다. 그래서 붙여 넣기용을 따로 둔다.

## 고칠 때

**두 곳을 같이 고쳐라.** 한쪽만 고치면 손으로 올린 버전과 자동으로 올린 버전의
출시 노트가 달라지고, 그건 나중에 어느 쪽이 맞는지 알 방법이 없다.

- 언어당 **500자 상한**이다. 확인:
  ```bash
  node -e "const f=require('fs');for(const l of ['en-US','ko-KR'])console.log(l,f.readFileSync('android/app/src/main/play/release-notes/'+l+'/default.txt','utf8').trim().length)"
  ```
- 기본 언어는 **en-US** 다(01_제품_결정서.md 7.4절). 붙여 넣기용 파일에서도 en-US 를 먼저 둔다.
