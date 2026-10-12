"""stores_cleaned.csv 의 '검색용주소'를 카카오 로컬 API 로 좌표 변환해 위도/경도 열을 채운다.

사용: KAKAO_REST_KEY=발급키 python3 maps/geocode_kakao.py maps/stores_cleaned.csv maps/stores_geocoded.csv
(키는 환경변수로만 받는다. 파일에 넣지 말 것)
"""
import csv, json, os, sys, time, urllib.parse, urllib.request

key = os.environ['KAKAO_REST_KEY']
src, out = sys.argv[1], sys.argv[2]

def geocode(q):
    url = 'https://dapi.kakao.com/v2/local/search/address.json?query=' + urllib.parse.quote(q)
    req = urllib.request.Request(url, headers={'Authorization': 'KakaoAK ' + key})
    with urllib.request.urlopen(req, timeout=15) as r:
        docs = json.load(r)['documents']
    return (docs[0]['y'], docs[0]['x']) if docs else None

rows = list(csv.DictReader(open(src, encoding='utf-8-sig')))
for i, r in enumerate(rows, 1):
    if r['위도'] and r['경도']:
        continue
    hit = geocode(r['검색용주소'])
    if hit:
        r['위도'], r['경도'] = hit
    else:
        r['주소유형'] = '확인필요'
    if i % 50 == 0:
        print(i, '/', len(rows), flush=True)
    time.sleep(0.05)

with open(out, 'w', newline='', encoding='utf-8-sig') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
print('완료. 좌표 없는 행:', sum(1 for r in rows if not r['위도']))
