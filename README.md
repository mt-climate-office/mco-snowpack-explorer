# Snow Drought Explorer

An interactive map explorer for daily snow data derived from the [NOAA SNODAS](https://nsidc.org/data/g02158) product, processed by the [Montana Climate Office](https://climate.umt.edu).

**Live at: <https://snow.climate.umt.edu>**

## About

The Snow Drought Explorer visualizes snowpack conditions across the western United States using Cloud Optimized GeoTIFFs (COGs) served as raster tiles in [MapLibre GL JS](https://maplibre.org). Data are processed and hosted by the Montana Climate Office at the University of Montana.

## Development

The app is a single-page static site — just open `index.html` in a browser or serve it locally:

```sh
# Python
python -m http.server 8000

# Node
npx serve .
```

## Deployment

The site is published via [GitHub Pages](https://pages.github.com) from the `main` branch.

## License

[MIT](LICENSE) — Copyright (c) 2025–present Montana Climate Office
