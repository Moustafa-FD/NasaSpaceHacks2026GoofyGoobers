# Data conventions

`examples/scenario.json` is entirely synthetic. Its bounding box is a UI example, not evidence about a location, facility, tariff or environmental condition. No live NASA or utility data is included.

- `raw/`: immutable, dated source downloads and acquisition metadata; ignored by Git.
- `processed/`: quality-controlled, unit-normalized tables/raster products; ignored by Git.
- `runs/`: future persisted scenario manifests, charts and layer artifacts; ignored by Git. The current API stores runs in memory only.
- `examples/`: small, redistributable synthetic inputs suitable for tests and demonstration.

Future acquired datasets need source URL/DOI, collection/version, retrieval date, license, geographic/time coverage, units, quality flags, processing steps and checksum. Credentials and Earthdata login files must stay outside Git. See [resource catalog](../docs/resources.md) and [modeling rules](../docs/modeling.md).
