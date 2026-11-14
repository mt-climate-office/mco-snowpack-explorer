# Snowpack Explorer

Daily snowpack percentiles for the lower 48 states and their watersheds, from
[NOAA SNODAS](https://nsidc.org/data/g02158), with per-watershed SWE and
HypsomeSWE plots. Built by the [Montana Climate Office](https://climate.umt.edu).

**Live at <https://snow.climate.umt.edu>.** Pushing `main` deploys it (GitHub
Pages from the repository root), so a push is a release.

## What it shows

Each day's snow water equivalent (SWE) is ranked against the same calendar day
in past years and colored with the U.S. Drought Monitor categories (D4 to W4).

- **Gridded**: the percentile of every 1 km SNODAS cell.
- **Zonal**: the percentile of each watershed's mean SWE, for USGS Watershed
  Boundary Dataset units at HUC2, HUC4, HUC6 and HUC8.
- **Normals**: the past years are turned into a range of normal snow in one of
  three ways, which the page can switch between: Smoothed (`smoothed`, the
  default), Fitted (`fitted`) and Empirical (`empirical`). The method is in
  [`gridded/normals/README.md`](https://data2.climate.umt.edu/snodas/gridded/normals/README.md)
  beside the data.
- **SNOTEL stations**: turned on with the SNOTEL chip in the bar, every NRCS SNOTEL station
  in the SNODAS domain, colored by its own SWE percentile for the date and
  flavor, against the `snodas` normals period (the SNODAS normals' reference
  years). Clicking one opens its seasonal SWE plot, in any of the three
  flavors, in the detail panel beside the map (full height under the bar on a phone). Read from `https://data2.climate.umt.edu/snotel/`, written by
  mco-snotel (its `CONSUMERS.md`). The map's date D shows SNOTEL's D − 1:
  SNODAS is the analysis at midnight Mountain as D begins, and mco-snotel
  stamps NRCS daily values at the end of their day, so that same midnight is
  its D − 1. The tooltip, panel and plot name both dates.
- **Ski areas**: every operating downhill ski area in the SNODAS domain
  (the Canadian Columbia basin's included) can be searched by name. From
  zoom 11 its name, downhill runs and lifts draw over the snow, the runs with
  their North American trail signs from zoom 13.
- **Watershed plots**: in the zonal view, clicking a watershed opens its SWE or
  HypsomeSWE plot for the date and normals shown, in the same detail panel. The plots are rendered by the
  pipeline, not the page.

## Where the data comes from

The snow data is read from `https://data2.climate.umt.edu/snodas/`, written by
the [mco-snodas](https://github.com/mt-climate-office/mco-snodas) pipeline (a
private repository; its `s3-docs/` are published as READMEs in the bucket).
The SNOTEL stations are read from `https://data2.climate.umt.edu/snotel/`,
written by [mco-snotel](https://github.com/mt-climate-office/mco-snotel)
(stations, the water year's percentiles, per-station normals and plots, as
its `CONSUMERS.md` describes).
The page has no backend.

Both buckets are read in their **layout v1** (mco-snotel's
`docs/bucket-layout.md`). Keys are by normals **period**, `wy{first}-{last}`,
and **flavor**, `smoothed`, `fitted` or `empirical`. The page reads the
`snodas` role's period, whose reference years are the SNODAS normals'. For
the current water year it takes the period from the latest manifests. For any
other year it uses the role's rule: the 30 water years before it, from WY2004.
For WY2027 that is `wy2004-2026`. `{day}` is the date's `MM-DD`.

| What | Path under `snodas/` |
|---|---|
| Newest published date and current period | `gridded/daily/latest/manifest.json` and `zonal/daily/latest/manifest.json` (`date`, `roles.snodas.period`; the earlier date wins) |
| Gridded percentiles (COG, 0–100) | `gridded/daily/percentiles/{period}/{date}/{period}_{flavor}_{date}_swe_ptile.tif` |
| Median for the date, for the hover (COG) | `gridded/normals/{period}/{flavor}/{period}_{flavor}_{day}_median.tif` |
| SNODAS SWE, for the hover (COG) | `raw/cog/{date}/snodas_swe_{date}.tif` |
| Normals provenance | `gridded/normals/{period}/provenance_{period}.json` |
| Watershed percentiles and normals (Parquet) | `zonal/daily/zones/{period}/{date}/zones_swe_{period}_{flavor}_{date}.parquet` |
| Elevation-band table (Parquet) | `zonal/daily/zones/{period}/{date}/zones_hypsomeswe_{period}_{flavor}_{date}.parquet` |
| Watershed boundaries (FlatGeobuf) | `zonal/zones_huc{2,4,6,8}.fgb` |
| Watershed plots (PNG) | `zonal/daily/plots/{period}/{date}/{flavor}/{huc}_{swe,hypsomeswe}_{period}_{flavor}_{date}.png` |
| A date's plots are complete | `zonal/daily/plots/{period}/{date}/index_{period}_{date}.json` |
| Which dates have plots | listing of `zonal/daily/plots/{period}/` |
| Water-year animations (MP4) | `zonal/animations/{period}/wy{wy}/{flavor}/{huc}_hypsomeswe_{period}_{flavor}_wy{wy}.mp4`, found by listing `zonal/animations/` and each period in it |

| What | Path under `snotel/` |
|---|---|
| Newest date, water year and current period | `daily/latest/manifest.json` (`date`, `water_year`, `roles.snodas.period`) |
| Stations | `stations.parquet` |
| The water year's percentiles | `daily/latest/percentiles_snodas.parquet` for the current water year, `daily/percentiles/{period}/percentiles_{period}_wy{wy}.parquet` for others |
| A station's normals | `normals/{period}/by_station/{station}_{period}.parquet` |
| Station plots (PNG) | `daily/plots/{period}/{date}/{flavor}/{station}_swe_{period}_{flavor}_{date}.png` |
| A date's plots are complete | `daily/plots/{period}/{date}/index_{period}_{date}.json` |
| Which dates have plots | listing of `daily/plots/{period}/` |

Percentiles and plots start on 2025-10-01, the first day of water year 2026,
the first the normals pipeline publishes. Plots are not published for every date yet; the
page says so and offers the nearest date that has them.

## URL parameters

The URL is the page's state, so a copied link reopens the same view. Defaults
are left out of the URL.

| Parameter | Values | Default |
|---|---|---|
| `date` | `YYYY-MM-DD` | the newest published date (always written) |
| `view` | `gridded`, `zonal` | `gridded` |
| `huc` | `8`, `6`, `4`, `2` (zonal view only) | `8` |
| `flavor` | `smoothed`, `fitted`, `empirical` | `smoothed` |
| `basin` | a HUC code, e.g. `1002`; opens its plots in the detail panel | none |
| `plot` | `swe`, `hypsomeswe` (with `basin`) | `swe` |
| `lng`, `lat`, `zoom` | the camera | Montana (the fit button shows the lower 48) |
| `theme` | `dark`, `light`, `high-contrast` | the system setting |
| `export` | `light`, `dark` (`true` also works): download the map as a PNG on load | none |
| `snotel` | `on`: show the SNOTEL stations | off |
| `station` | a station, e.g. `901_MT_SNTL`; opens its plot in the detail panel (and shows the stations) | none |
| `kbd` | `off`: turn off the `/` shortcut to the search box | on |

An old `?method=zig` or `?method=ecdf` link still opens on that flavor, as
does an old `?flavor=zig_smooth`, `zig` or `ecdf`; the URL is rewritten with
the new name. `anim` is a water year (October to September), as the
animations are.

## Files

- `index.html`: the page, its CSP, and app-only CSS.
- `app.js`: everything the page does. A classic script.
- `vendor/parquet.min.js`: hyparquet and fzstd, bundled and pinned by
  `scripts/vendor.sh` (bump a version there and re-run it).
- `data/snodas-domain.geojson`: the edge of the SNODAS grid, traced from its
  NoData mask (NOHRSC publishes no boundary file), outlined in the gridded
  view. `scripts/build-domain.sh` rebuilds it.
- `data/places/`: what the search box finds besides watersheds and ski areas. `areas.json`
  (states and counties, with their bounding boxes), `places.json` (cities,
  towns and Census-designated places) and `zips.json` (ZIP code areas), each
  as compact arrays, lower 48 and DC only. Built from the US Census 2026
  Gazetteer and 2025 cartographic boundaries (public domain) by
  `scripts/build-places.sh`. Watersheds come from the boundary files above.
- `data/ski/`: the ski areas and their runs and lifts. `areas.json` lists
  every operating area with downhill skiing whose middle falls inside the
  SNODAS domain, with its bounds; `runs/{key}.json` holds one area's runs
  (by difficulty), lifts and outline, fetched only when the map is zoomed in
  over it. From [OpenSkiMap](https://openskimap.org)'s daily GeoJSON, ©
  OpenStreetMap contributors, under the
  [Open Database License](https://opendatacommons.org/licenses/odbl/); the
  extract stays under the ODbL. `scripts/build-ski.sh` rebuilds it (about
  1 GB of downloads).
- `verify.config.mjs`: scenarios and probes for the house verify harness.
- `verify.mjs`: checks the page against the snow buckets' layout v1 (below).

The look, the controls and most behaviour come from the Montana Climate
Office's shared design system,
[mco-web-style](https://github.com/mt-climate-office/mco-web-style), pinned by
version with SRI hashes in `index.html` and `app.js`. Change shared behaviour
there, not here.

## Run it locally

Any static server works:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

## Check it

The house verify harness lives in mco-web-style. With that repository checked
out beside this one and its tooling installed (see its
`tools/verify/README.md`):

```sh
cd ../mco-web-style
node tools/verify/head.mjs       --root ../mco-snowpack-explorer
node tools/conformance.mjs              ../mco-snowpack-explorer
node tools/verify/lint-css.mjs   --root ../mco-snowpack-explorer
node tools/verify/axe-matrix.mjs --config ../mco-snowpack-explorer/verify.config.mjs --root ../mco-snowpack-explorer
node tools/verify/keyboard.mjs   --config ../mco-snowpack-explorer/verify.config.mjs --root ../mco-snowpack-explorer
```

The browser checks run against live data on data2, so they need a network
connection.

### Against the buckets' layout v1

`verify.mjs` checks two things. First, that every layout v1 key the page
reads for the newest date exists. Second, that the page, served from this
checkout, works against that data. It must draw the gridded and zonal maps,
a basin's plots, facts and band table, an animation, the SNOTEL stations and
a station's plot. It must also make no request to an old key and fail no
request.

The data can come from production, a test bucket or a local mirror laid out
as the bucket. Its two tools are pinned and not saved to the repository:

```sh
npm i --no-save playwright@1.62.1 @axe-core/playwright@4.13.0
npx playwright install chromium
node verify.mjs                                    # production, data2
node verify.mjs --data /path/to/mirror             # a mirror holding snodas/ and snotel/
node verify.mjs --snodas https://<bucket-base> --snotel https://<bucket-base>
node verify.mjs --list                             # print the keys it reads, and stop
node verify.mjs --keys-only                        # the keys, not the page
```

`--basin`, `--station` and `--anim` choose what to open. The defaults are
`1002`, `901_MT_SNTL` and the newest animated water year. A bucket URL's S3
listing must be public, as data2's is. Screenshots go to `verify-out/`.

## License

[MIT](LICENSE). Copyright (c) 2025–present Montana Climate Office.
`data/ski/` is © OpenStreetMap contributors under the ODbL (see Files).
