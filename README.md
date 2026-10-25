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
  three ways, which the page can switch between: Smoothed (`zig_smooth`, the
  default), Fitted (`zig`) and Empirical (`ecdf`). The method is in
  [`normals/README.md`](https://data2.climate.umt.edu/snodas/normals/README.md)
  beside the data.
- **Watershed plots**: in the zonal view, clicking a watershed opens its SWE or
  HypsomeSWE plot for the date and normals shown. The plots are rendered by the
  pipeline, not the page.

## Where the data comes from

Everything is read from `https://data2.climate.umt.edu/snodas/`, written by the
[mco-snodas](https://github.com/mt-climate-office/mco-snodas) pipeline (a
private repository; its `s3-docs/` are published as READMEs in the bucket).
The page has no backend.

| What | Path under `snodas/` |
|---|---|
| Newest published date | `latest/manifest.json` (`date`) |
| Gridded percentiles (COG, 0–100) | `normals/gridded/{flavor}/{date}/{date}_{flavor}_swe_ptile.tif` |
| Normals provenance | `normals/gridded/{flavor}/{date}/{date}_{flavor}_provenance.json` |
| Watershed percentiles and normals (Parquet) | `normals/zonal/wbd/{flavor}/{date}/{date}_{flavor}_swe_normals.parquet` |
| Elevation-band table (Parquet) | `normals/zonal/wbd/{flavor}/{date}/{date}_{flavor}_hypsomeswe_normals.parquet` |
| Watershed boundaries (FlatGeobuf) | `cache/data/fgb/huc{2,4,6,8}.fgb` |
| Watershed plots (PNG) | `plots/{date}/{flavor}/{swe,hypsomeswe}/usdm/{huc}.png` |
| A date's plots are complete | `plots/{date}/index.json` |

Percentiles start on 2025-09-01, the first day of the first snow year the
normals pipeline has built. Plots are not published for every date yet; the
page says so and offers the nearest date that has them.

## URL parameters

The URL is the page's state, so a copied link reopens the same view. Defaults
are left out of the URL.

| Parameter | Values | Default |
|---|---|---|
| `date` | `YYYY-MM-DD` | the newest published date (always written) |
| `view` | `gridded`, `zonal` | `gridded` |
| `huc` | `2`, `4`, `6`, `8` (zonal view only) | `2` |
| `flavor` | `zig_smooth`, `zig`, `ecdf` | `zig_smooth` |
| `basin` | a HUC code, e.g. `1002`; opens its plot dialog | none |
| `plot` | `swe`, `hypsomeswe` (with `basin`) | `swe` |
| `lng`, `lat`, `zoom` | the camera | the lower 48 |
| `theme` | `dark`, `light`, `high-contrast` | the system setting |
| `export` | `light`, `dark` (`true` also works): download the map as a PNG on load | none |

An old `?method=zig` or `?method=ecdf` link still opens on that flavor.

## Files

- `index.html`: the page, its CSP, and app-only CSS.
- `app.js`: everything the page does. A classic script.
- `vendor/parquet.min.js`: hyparquet and fzstd, bundled and pinned by
  `scripts/vendor.sh` (bump a version there and re-run it).
- `verify.config.mjs`: scenarios and probes for the house verify harness.

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

## License

[MIT](LICENSE). Copyright (c) 2025–present Montana Climate Office.
