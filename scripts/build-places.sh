#!/usr/bin/env bash
# Rebuild data/places/: the states, counties, cities and ZIP codes the map's
# search can jump to. Lower 48 + DC only, the area SNODAS covers on the US
# side; Canadian Columbia basins are found by basin name instead.
#
# Sources (US Census Bureau, public domain):
#   - 2026 Gazetteer files: counties, places (incorporated + CDPs), ZCTAs,
#     each with its internal point.
#   - 2025 cartographic boundaries (500k), read only for each state's and
#     county's bounding box. Only the four numbers ship.
#
# Rows are arrays, not objects, to keep the files small:
#   areas.json   [kind, name, st, w, s, e, n]   kind 's' state, 'c' county
#   places.json  [name, st, kind, lat, lon]     kind 'c' city, 't' town,
#                                                'v' village, 'b' borough,
#                                                'p' community (CDP)
#   zips.json    [zip, lat, lon]
# Needs curl, GDAL (ogr2ogr) and Python 3.
set -euo pipefail
GAZ=https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2026_Gazetteer
CB=https://www2.census.gov/geo/tiger/GENZ2025/shp
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"

for f in counties place zcta; do
  curl -fsSLO "$GAZ/2026_Gaz_${f}_national.zip" && unzip -oq "2026_Gaz_${f}_national.zip"
done
for f in state county; do
  curl -fsSLO "$CB/cb_2025_us_${f}_500k.zip"
  # Bounding boxes as CSV: GEOID,w,s,e,n.
  ogr2ogr -f CSV "$f.csv" "/vsizip/cb_2025_us_${f}_500k.zip" -dialect sqlite \
    -sql "SELECT GEOID, STUSPS, NAME, ST_MinX(geometry) w, ST_MinY(geometry) s, ST_MaxX(geometry) e, ST_MaxY(geometry) n FROM cb_2025_us_${f}_500k"
done

mkdir -p "$here/data/places"
python3 -I - "$here/data/places" <<'PY'
import csv, gzip, json, os, re, sys
out = sys.argv[1]
DROP = {'AK', 'HI', 'PR', 'VI', 'GU', 'AS', 'MP', 'UM'}
# The lower-48 bounds the map fits to (COG_BOUNDS in app.js).
W, S, E, N = -124.733, 24.95, -66.94, 52.875

def rows(path):
    with open(path, encoding='utf-8') as f:
        return [{k.strip(): v.strip() for k, v in r.items()} for r in csv.DictReader(f, delimiter='|')]

def r4(x): return round(float(x), 3)   # ~100 m, plenty for a camera target
def bbox(b): return [r4(b['w']), r4(b['s']), r4(b['e']), r4(b['n'])]

states = {b['GEOID']: b for b in csv.DictReader(open('state.csv'))}
counties = {b['GEOID']: b for b in csv.DictReader(open('county.csv'))}

areas = []
for b in sorted(states.values(), key=lambda b: b['NAME']):
    if b['STUSPS'] not in DROP: areas.append(['s', b['NAME'], b['STUSPS']] + bbox(b))
missing = []
for r in rows('2026_Gaz_counties_national.txt'):
    if r['USPS'] in DROP: continue
    b = counties.get(r['GEOID'])
    if b is None:
        missing.append(r['NAME'] + ', ' + r['USPS'])
        lat, lon = r4(r['INTPTLAT']), r4(r['INTPTLONG'])
        box = [lon - 0.25, lat - 0.25, lon + 0.25, lat + 0.25]   # a small box around the internal point
    else:
        box = bbox(b)
    areas.append(['c', r['NAME'], r['USPS']] + box)

# LSAD → kind, and the suffix the Gazetteer appends to the name.
KIND = {'25': 'c', '43': 't', '47': 'v', '21': 'b', '57': 'p'}
SUFFIX = re.compile(r'\s+(city and borough|consolidated government|metropolitan government|metro government|unified government|'
                    r'urban county|municipality|corporation|borough|village|town|city|CDP)$')
places = []
for r in rows('2026_Gaz_place_national.txt'):
    if r['USPS'] in DROP: continue
    name = SUFFIX.sub('', r['NAME'].replace(' (balance)', ''))
    places.append([name, r['USPS'], KIND.get(r['LSAD'], 'c'), r4(r['INTPTLAT']), r4(r['INTPTLONG'])])

zips = []
for r in rows('2026_Gaz_zcta_national.txt'):
    z, lat, lon = r['GEOID'], r4(r['INTPTLAT']), r4(r['INTPTLONG'])
    if z[:3] in {'006', '007', '008', '009', '967', '968', '969'} or z[:3] >= '995': continue
    if not (W <= lon <= E and S <= lat <= N): continue
    zips.append([z, lat, lon])

for name, data in (('areas', areas), ('places', places), ('zips', zips)):
    path = os.path.join(out, name + '.json')
    body = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    open(path, 'w', encoding='utf-8').write(body + '\n')
    print(f'data/places/{name}.json: {len(data):,} rows, {len(body.encode()):,} bytes, '
          f'{len(gzip.compress(body.encode())):,} gzipped')
if missing: print('counties with no boundary (point box used):', ', '.join(missing))
PY
