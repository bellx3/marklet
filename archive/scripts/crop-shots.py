# -*- coding: utf-8 -*-
"""
스토어 스크린샷을 Play 규격에 맞게 다듬는다.

★ Play 는 **긴 변이 짧은 변의 2배를 넘으면 거부한다.**
  에뮬레이터가 1080×2400 이라 그대로는 2.22배로 안 된다.
  상태바를 잘라내고 위에서부터 2160px 만 쓴다 — 정확히 2배이고,
  Play 가 권하는 '기기 크롬 없는 화면' 도 함께 만족한다.

★ 알파 채널을 반드시 없앤다. Play 는 24비트 PNG 만 받는다.
  screencap 은 RGBA 로 준다.

사용법: python scripts/crop-shots.py <입력폴더> <출력폴더> <상태바높이px>
"""
import os
import sys
from PIL import Image

src, dst, top = sys.argv[1], sys.argv[2], int(sys.argv[3])
TARGET_H = 2160

os.makedirs(dst, exist_ok=True)

for name in sorted(os.listdir(src)):
    if not name.endswith('.png'):
        continue
    im = Image.open(os.path.join(src, name))
    w, h = im.size

    # 상태바 아래부터. 남은 높이가 모자라면 아래에 붙여서 자른다.
    y0 = min(top, max(0, h - TARGET_H))
    im = im.crop((0, y0, w, y0 + TARGET_H))

    # ★ 알파 제거. 흰 배경에 합성하지 말고 그냥 RGB 로 떨어뜨린다 —
    #   스크린샷은 이미 불투명하다.
    if im.mode != 'RGB':
        im = im.convert('RGB')

    out = os.path.join(dst, name)
    im.save(out, 'PNG', optimize=True)
    ratio = max(im.size) / min(im.size)
    ok = '✓' if ratio <= 2.0 and min(im.size) >= 320 and max(im.size) <= 3840 else '✗'
    print(f'  {ok} {name}  {im.size[0]}x{im.size[1]}  비율 {ratio:.2f}  {os.path.getsize(out)//1024}KB')
