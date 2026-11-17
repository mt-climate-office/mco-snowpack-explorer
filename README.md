# Snowpack Explorer

Daily snowpack percentiles for the lower 48 states and their watersheds, from NOAA SNODAS.

<https://snow.climate.umt.edu>

## Run it

```sh
python3 -m http.server 8000
# open http://localhost:8000/
```

## Deploy

Pushing `main` deploys it to GitHub Pages from the repository root. A push is a release.

## URL parameters

Defaults are left out of the URL.

| Parameter | Values | What it does |
|---|---|---|
| `date` | `YYYY-MM-DD` | The day shown. Default: the newest published date. |
| `view` | `gridded`, `zonal` | Grid cells or watersheds. Default `gridded`. |
| `huc` | `8`, `6`, `4`, `2` | Watershed level in the zonal view. Default `8`. |
| `flavor` | `smoothed`, `fitted`, `empirical` | Which normals. Default `smoothed`. Old `method` and `flavor` names are rewritten. |
| `basin` | a HUC code, e.g. `1002` | Opens that watershed's plots. |
| `plot` | `swe`, `hypsomeswe` | The plot shown with `basin`. Default `swe`. |
| `snotel` | `on` | Shows the SNOTEL stations. |
| `station` | e.g. `901_MT_SNTL` | Opens that station's plot. |
| `lng`, `lat`, `zoom` | numbers | The camera. Default: Montana. |
| `theme` | `dark`, `light`, `high-contrast` | The theme. Default: the system setting. |
| `export` | `light`, `dark` | Downloads the map as a PNG on load. |
| `kbd` | `off` | Turns off `/` and the arrow keys. |

## Data

- Snow: `https://data2.climate.umt.edu/snodas/`, written by [mco-snodas](https://github.com/mt-climate-office/mco-snodas).
- Stations: `https://data2.climate.umt.edu/snotel/`, written by [mco-snotel](https://github.com/mt-climate-office/mco-snotel).
- Both are read in layout v1. The key layout is in mco-snotel's `docs/bucket-layout.md`.
- The map's date D shows SNOTEL's D − 1. NRCS stamps a day's value at its end.
- Places, ski areas and the SNODAS edge are in `data/`, rebuilt by `scripts/`.
- `data/ski/` is © OpenStreetMap contributors, under the ODbL.

## Tests

From an mco-web-style checkout beside this one:

```sh
cd ../mco-web-style
node tools/verify/head.mjs       --root ../mco-snowpack-explorer
node tools/conformance.mjs              ../mco-snowpack-explorer
node tools/verify/lint-css.mjs   --root ../mco-snowpack-explorer
node tools/verify/axe-matrix.mjs --config ../mco-snowpack-explorer/verify.config.mjs --root ../mco-snowpack-explorer
node tools/verify/keyboard.mjs   --config ../mco-snowpack-explorer/verify.config.mjs --root ../mco-snowpack-explorer
```

Against the buckets, from this checkout:

```sh
npm i --no-save playwright@1.62.1 @axe-core/playwright@4.13.0
npx playwright install chromium
node verify.mjs                          # production data
node verify.mjs --data /path/to/mirror   # a local mirror
node verify.mjs --list                   # print the keys it reads
```

## Kit

mco-web-style 1.1.1, pinned with SRI in `index.html` and `app.js`.

Design rules: mco-web-style/HOUSE-STYLE.md
