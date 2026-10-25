#!/usr/bin/env bash
# Rebuild data/snodas-domain.geojson: the edge of the SNODAS grid, outlined in
# the gridded view so readers can see which areas it covers.
#
# NOHRSC and NSIDC publish no boundary file for SNODAS, only bounding boxes,
# so this is traced from the data: the valid (not NoData) cells of one day's
# SWE grid. The mask is fixed (2025-09-01 and 2026-02-15 match cell for cell).
# It is the lower 48 plus the Canadian part of the Columbia River basin: not
# the HUC2 regions, whose union also takes in Canadian Souris-Red-Rainy.
#
# Only outer boundaries are kept: the thousands of masked lakes inside the
# domain are holes the outline should not draw, and islands under 0.005 deg²
# are dropped. Simplified to 0.01° (about one SNODAS cell). Needs GDAL with
# SQLite/SpatiaLite, and Python 3.
set -euo pipefail
DATE="${1:-2026-02-15}"
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"

gdal_translate -q "/vsicurl/https://data2.climate.umt.edu/snodas/cogs/$DATE/snodas_swe_${DATE//-/}.tif" swe.tif
gdal_calc --quiet -A swe.tif --outfile=mask.tif --calc="A>=0" --type=Byte --NoDataValue=0 --overwrite
gdal_polygonize -q mask.tif -f GeoJSON cells.geojson cells
ogr2ogr -f GeoJSON -dialect sqlite \
  -sql "SELECT ST_SimplifyPreserveTopology(ST_Union(geometry), 0.01) AS geometry FROM cells WHERE DN = 1" \
  dissolved.geojson cells.geojson
python3 -I - dissolved.geojson outer.geojson <<'PY'
import json, sys
g = json.load(open(sys.argv[1]))['features'][0]['geometry']
polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
area = lambda r: abs(sum(r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1] for i in range(len(r) - 1)) / 2)
keep = [[p[0]] for p in polys if area(p[0]) > 0.005]
json.dump({'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'properties': {},
           'geometry': {'type': 'MultiPolygon', 'coordinates': keep}}]}, open(sys.argv[2], 'w'))
PY
rm -f "$here/data/snodas-domain.geojson"
ogr2ogr -f GeoJSON -lco COORDINATE_PRECISION=4 -dialect sqlite \
  -sql "SELECT ST_SimplifyPreserveTopology(geometry, 0.01) AS geometry FROM outer" \
  "$here/data/snodas-domain.geojson" outer.geojson
echo "data/snodas-domain.geojson: $(wc -c < "$here/data/snodas-domain.geojson") bytes (from $DATE)"
