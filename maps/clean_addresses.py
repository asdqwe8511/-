import csv, glob, re, sys, openpyxl

src = sys.argv[1]
out = sys.argv[2]
ws = openpyxl.load_workbook(src).active
rows = list(ws.iter_rows(values_only=True))
head, body = rows[0], rows[1:]

ROAD = re.compile(r'^(.*?(?:대로|로|길)\s?\d+(?:-\d+)?)(?=\s|,|\(|$)')
JIBUN = re.compile(r'^(.*?[동읍면리가]\s\d+(?:-\d+)?)(?=\s|,|\(|$)')

def clean(a):
    a = (a or '').strip()
    base = re.sub(r'\([^)]*\)', ' ', a)
    base = re.sub(r'\s+', ' ', base).strip()
    m = ROAD.match(base)
    kind = '도로명'
    if not m:
        m = JIBUN.match(base)
        kind = '지번'
    if not m:
        return base, '확인필요'
    c = m.group(1)
    c = re.sub(r'^경기 ', '경기도 ', c)
    c = re.sub(r'^서울 ', '서울특별시 ', c)
    c = re.sub(r'^서울특별시특별시', '서울특별시', c)
    return c, kind

with open(out, 'w', newline='', encoding='utf-8-sig') as f:
    w = csv.writer(f)
    w.writerow(list(head) + ['검색용주소', '주소유형', '위도', '경도'])
    for r in body:
        c, k = clean(r[6])
        w.writerow(list(r) + [c, k, '', ''])
print(len(body), 'rows')
