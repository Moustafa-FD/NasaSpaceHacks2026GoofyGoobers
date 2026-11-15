# EXR-derived sky environments

The three source HDRIs are by Greg Zaal, distributed by Poly Haven under
[CC0](https://polyhaven.com/license). Full-resolution source files are not shipped
to browsers. `scripts/build-sky-environments.py` downloads verified 1K OpenEXR
files into ignored `tmp/sky-sources`, then writes 1024×512 tone-mapped JPEGs and
linear HDR ambient chromaticity. Browser images total less than 100 KB.

- [Clear sky](https://polyhaven.com/a/kloofendal_43d_clear)
- [Scattered clouds](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky)
- [Overcast](https://polyhaven.com/a/kloofendal_overcast)

The photographic ground is excluded from the displayed sky. The HDR ambient
term is isotropic diffuse lighting; there is no prefiltered specular cubemap.
These are artistic backgrounds chosen using regional context, not photographs
of current local cloud conditions or a weather forecast. Foreground geometry is
excluded from the sky pass, and the existing separate cloud clumps remain sparse.

Build-time dependencies only: OpenEXR, numpy, Pillow. Cesium uses ordinary GPU
textures; no browser EXR decoder, large float texture, or runtime dependency is
required. Per-file attribution, checksums and download URLs are in
`environments.json`.
