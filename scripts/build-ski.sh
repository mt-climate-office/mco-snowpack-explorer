#!/usr/bin/env bash
# Rebuild data/ski/: the ski areas the map's search can jump to, and their
# downhill runs and lifts, drawn when the map is zoomed in. Every operating
# area with downhill skiing inside the SNODAS domain (data/snodas-domain.geojson,
# so the Canadian Columbia basin's resorts too), wherever its middle falls.
#
# Source: OpenSkiMap (https://openskimap.org), built daily from OpenStreetMap.
# © OpenStreetMap contributors, under the Open Database License (ODbL 1.0):
# data/ski/ is a derived database and stays under the ODbL, credited on the
# map and in the info modal.
#
#   areas.json      [key, name, st, region, w, s, e, n, runs]
#                   key   the area's file under runs/ (OpenSkiMap id, first 10)
#                   st    state or province code ('MT', 'BC'); region its name
#                   w..n  bounds of the area and its runs and lifts together
#                   runs  1 if runs/{key}.json exists (it has runs or lifts)
#   runs/{key}.json a FeatureCollection with one property each:
#                   {d}   a run: 'e' easy (novice, easy), 'i' intermediate,
#                         'a' advanced, 'x' expert (expert, extreme,
#                         freeride), 'u' not given in OSM
#                   {l:1} a lift
#                   {o:1} the area's outline, when OSM maps one
# Coordinates are rounded to 5 decimals (about 1 m). Needs curl, GDAL
# (ogr2ogr) and Python 3.
set -euo pipefail
SRC=https://tiles.openskimap.org/geojson
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"

curl -fsSL --compressed -o ski_areas.geojson "$SRC/ski_areas.geojson"
for f in runs lifts; do
  curl -fsSL --compressed -o "$f.geojson" "$SRC/$f.geojson"
  # The worldwide runs file is ~800 MB; cut it to the domain's box first.
  ogr2ogr -f GeoJSON -dim XY -spat -124.8 24.9 -66.9 52.9 "${f}_box.geojson" "$f.geojson"
done

rm -rf "$here/data/ski"
mkdir -p "$here/data/ski/runs"
python3 -I - "$here/data/ski" "$here/data/snodas-domain.geojson" <<'PY'
import gzip, json, os, sys
out, domain = sys.argv[1], sys.argv[2]

# The domain's outer rings, each with its bounding box, for point-in-polygon.
rings = []
for f in json.load(open(domain))['features']:
    g = f['geometry']
    for poly in (g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]):
        r = poly[0]
        rings.append((min(p[0] for p in r), min(p[1] for p in r), max(p[0] for p in r), max(p[1] for p in r), r))

def in_domain(x, y):
    for w, s, e, n, r in rings:
        if not (w <= x <= e and s <= y <= n): continue
        c, j = False, len(r) - 1
        for i in range(len(r)):
            (xi, yi), (xj, yj) = r[i], r[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi: c = not c
            j = i
        if c: return True
    return False

def points(c):
    if isinstance(c[0], (int, float)): yield c
    else:
        for x in c: yield from points(x)

def bounds(gs):
    pts = [p for g in gs for p in points(g['coordinates'])]
    return [min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)]

def r5(c):
    return [round(c[0], 5), round(c[1], 5)] if isinstance(c[0], (int, float)) else [r5(x) for x in c]

def geom(g): return {'type': g['type'], 'coordinates': r5(g['coordinates'])}

areas = {}
for f in json.load(open('ski_areas.geojson'))['features']:
    p = f['properties']
    if p.get('status') != 'operating' or 'downhill' not in (p.get('activities') or []): continue
    w, s, e, n = bounds([f['geometry']])
    if not in_domain((w + e) / 2, (s + n) / 2): continue
    place = (p.get('places') or [{}])[0]
    code = place.get('iso3166_2') or ''
    region = ((place.get('localized') or {}).get('en') or {}).get('region') or ''
    areas[p['id']] = {'name': p.get('name') or '', 'st': code.split('-')[-1], 'region': region,
                      'geom': f['geometry'], 'features': []}
    if f['geometry']['type'] in ('Polygon', 'MultiPolygon'):
        areas[p['id']]['features'].append({'type': 'Feature', 'properties': {'o': 1}, 'geometry': geom(f['geometry'])})

def owner(p):
    for a in p.get('skiAreas') or []:
        if a['properties']['id'] in areas: return areas[a['properties']['id']]

DIFF = {'novice': 'e', 'easy': 'e', 'intermediate': 'i', 'advanced': 'a',
        'expert': 'x', 'extreme': 'x', 'freeride': 'x'}
lines = {}
for f in json.load(open('runs_box.geojson'))['features']:
    p = f['properties']
    if p.get('status') != 'operating' or 'downhill' not in (p.get('uses') or []): continue
    a = owner(p)
    if a is None: continue
    a['features'].append({'type': 'Feature', 'properties': {'d': DIFF.get(p.get('difficulty'), 'u')}, 'geometry': geom(f['geometry'])})
for f in json.load(open('lifts_box.geojson'))['features']:
    p = f['properties']
    if p.get('status') != 'operating': continue
    a = owner(p)
    if a is None: continue
    a['features'].append({'type': 'Feature', 'properties': {'l': 1}, 'geometry': geom(f['geometry'])})

rows, keys, total = [], set(), 0
for id_, a in areas.items():
    key = id_[:10]
    assert key not in keys, f'duplicate key {key}'
    keys.add(key)
    w, s, e, n = (round(v, 4) for v in bounds([a['geom']] + [x['geometry'] for x in a['features']]))
    has = any('o' not in x['properties'] for x in a['features'])
    if has:
        body = json.dumps({'type': 'FeatureCollection', 'features': a['features']}, separators=(',', ':'))
        open(os.path.join(out, 'runs', key + '.json'), 'w').write(body + '\n')
        total += len(body.encode())
    rows.append([key, a['name'], a['st'], a['region'], w, s, e, n, int(has)])
rows.sort(key=lambda r: (r[1].lower(), r[2]))

body = json.dumps(rows, ensure_ascii=False, separators=(',', ':'))
open(os.path.join(out, 'areas.json'), 'w', encoding='utf-8').write(body + '\n')
print(f'data/ski/areas.json: {len(rows):,} areas, {len(body.encode()):,} bytes, '
      f'{len(gzip.compress(body.encode())):,} gzipped')
print(f'data/ski/runs/: {sum(r[8] for r in rows):,} files, {total:,} bytes')
PY
