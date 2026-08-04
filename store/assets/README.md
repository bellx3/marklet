# 스토어 그래픽 자산

| 파일 | 규격 | 쓰이는 곳 |
| --- | --- | --- |
| `app-icon-512.png` | 512×512, 32비트 PNG, 알파 없음 | Play 등재정보 · `scripts/make-icon.cjs` 의 원본 |
| `feature-graphic-1024x500.png` | 1024×500, 알파 없음 | Play 등재정보 '그래픽 이미지' |

## 아이콘을 바꿀 때

`app-icon-512.png` 하나만 갈아 끼우고 다시 뽑으면 런처 아이콘까지 함께 맞는다.

```bash
node scripts/make-icon.cjs
npm run sync:android
```

`ic_launcher_background.xml` 의 색도 원본 모서리에서 읽어 자동으로 맞춘다.
흰색으로 남겨 두면 어두운 아이콘 둘레에 흰 테가 생긴다.

## 알파 채널을 넣지 말 것

그래픽 이미지에 알파가 있으면 Play 가 반려한다. 아이콘도 투명 배경이면
Play 가 씌우는 마스크와 겹쳐 이상하게 나온다. **둘 다 불투명**이어야 한다.

## 크기를 맞출 때

생성 도구가 1024×496 처럼 어중간하게 뱉는 일이 있다. 이 그림은 종이가 위아래
가장자리에 닿아 있어서 **덧대면 종이 위에 검은 줄이 생긴다.** 그럴 때는
늘리는 쪽이 낫다(0.8% 는 눈에 안 띈다).

```bash
npx sharp-cli -i in.png -o out.png resize 1024 500 --fit fill
```
