# Raw source data

Downloaded data stays outside Git. The environmental backend preserves NASA POWER compressed global chunks and their SHA-256/ETag inventory under `environment/power-grid/`, plus raw point API responses under `environment/`. Run `npm run data:sync` after setup to acquire data locally. See [data conventions](../README.md) for provenance and limits.
