# Local API and worker contracts

This is the starter's local, illustrative API. Examples use `http://127.0.0.1:3000`; use the configured port if changed. Public deployment would use HTTPS/WSS behind an authenticated gateway. The starter has no authentication and must not be exposed as a public service.

## Endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/health` | Health response: `{"status":"ok","schemaVersion":"1.0","mode":"illustrative"}` |
| GET | `/v1/domains` | Domain registry showing implemented illustrative accounting and unavailable/planned domains |
| POST | `/v1/runs` | Validate scenario, create background job, return `202` and run URLs |
| GET | `/v1/runs/{id}` | Retrieve authoritative run status and scenario snapshot |
| GET | `/v1/runs/{id}/results` | Return completed result manifest; `409` if not completed |
| WebSocket | `/v1/runs/{id}/events` | Immediately send current status, then push status changes |

No update, cancellation, login, live-data ingestion, or raster-tile endpoint is implemented. Those require separate future contracts.

## Submit a scenario

Set `Content-Type: application/json`. Use [the checked-in example](../data/examples/scenario.json) as the starting request body.

```json
{
  "schemaVersion": "1.0",
  "mode": "illustrative",
  "name": "Synthetic expansion example",
  "region": {
    "id": "demo-region",
    "name": "Synthetic accounting region",
    "bbox": [-80, 43, -79, 44]
  },
  "years": { "start": 2026, "end": 2030 },
  "assumptions": {
    "itLoadMw": 10,
    "utilization": 0.7,
    "pue": 1.3,
    "annualGrowthRate": 0.05,
    "gridKgCo2ePerKwh": 0.25,
    "wueLitresPerItKwh": 0.5,
    "electricityPricePerKwh": 0.1,
    "currency": "USD"
  }
}
```

These are invented inputs for testing the workflow, not measurements of a facility within the bounding box. Bounding boxes use longitude/latitude in `[west, south, east, north]` order. The current contract does not support a box crossing the antimeridian.

| Assumption | Meaning |
| --- | --- |
| `itLoadMw` | Starting rated IT power in MW, before utilization |
| `utilization` | Fraction of that power used, from 0 to 1 |
| `pue` | Facility electricity divided by IT electricity |
| `annualGrowthRate` | Constant annual growth fraction for this illustrative scenario |
| `gridKgCo2ePerKwh` | Fixed supplied grid emission factor; not a forecast from the API |
| `wueLitresPerItKwh` | Supplied onsite cooling-water-use factor per IT kWh; not net basin depletion |
| `electricityPricePerKwh` | Fixed energy-only price; excludes demand charges, taxes, and household tariffs |
| `currency` | Three-uppercase-letter label for the supplied price |

The requested years must be ordered and between 2000 and 2100, with a span of at most 80 years. Accepted numeric ranges are demo guardrails, not physical or regulatory limits. See the implementation's validator and the [worker README](../services/models/README.md) for exact checks and arithmetic. Extending a constant assumption to 2100 does not turn it into a validated forecast.

Successful submission returns `202 Accepted`:

```json
{
  "id": "<run-id>",
  "status": "queued",
  "statusUrl": "/v1/runs/<run-id>",
  "resultUrl": "/v1/runs/<run-id>/results",
  "eventsUrl": "/v1/runs/<run-id>/events"
}
```

Returned paths are relative to the configured API origin. Use the returned paths rather than rebuilding them from the ID.

## Status and events

A status response contains `id`, `status`, `progress`, `createdAt`, `updatedAt`, and `scenario`. Terminal failures additionally include `error: {code, message}`. A completed run can include its `resultUrl`.

States are `queued`, `running`, `completed`, and `failed`. Progress is a number from 0 to 100 describing the job lifecycle; it is not a calibrated estimate of scientific iteration completion or remaining time. Timestamps are ISO 8601 strings.

Connect to the returned events path using the WebSocket scheme:

```text
http://127.0.0.1:3000 + /v1/runs/<id>/events
                         becomes
ws://127.0.0.1:3000/v1/runs/<id>/events
```

For a deployed HTTPS API use `wss://`, never mixed insecure WebSockets. On connection the server sends the latest snapshot immediately, even if the job finished before the client subscribed:

```json
{
  "type": "run.status",
  "run": {
    "id": "<run-id>",
    "status": "running",
    "progress": 10,
    "createdAt": "<ISO-8601 timestamp>",
    "updatedAt": "<ISO-8601 timestamp>",
    "scenario": { "...": "submitted scenario" }
  }
}
```

The same envelope carries subsequent status changes. Client-to-server WebSocket commands are not supported. After a disconnect, retrieve the HTTP status and reconnect if useful. There is no event cursor, stored event replay, or guarantee that a reconnecting client sees every intermediate transition. Polling the status URL is also sufficient for a simple first client.

## Completed result manifest

The manifest has this structure; ellipses below describe omitted fields rather than a literal request/response fixture:

```text
schemaVersion, runId, mode, modelVersion, scenarioName, region, years
provenance:
  kind, sourceIds, assumptions, warnings
metrics[]:
  id, label, domain, unit, status
  spatialResolution, temporalResolution
  uncertainty: {status, reason}
  series[]: {year, value}
unavailable[]: {domain, reason}
layers[]
```

Currently `mode` and metric `status` are `illustrative`, source provenance is synthetic, uncertainty is not quantified, and `layers` is empty. The worker computes annual facility electricity, grid-emissions accounting, onsite cooling-water use, and an energy-only facility bill. It does not return noise levels, pollution-concentration maps, water quality, water stress, household bill impacts, employment, population, or land/ecosystem predictions.

Render unavailable outputs as unavailable. Do not substitute zero or interpolate a spatial map from a regional total. Future `layers` entries will need their own contract for URL, time, CRS, bounds, units, resolution, nodata, attribution, and expiry. This starter does not host those layers.

## Error handling

| HTTP status | Meaning | Client behavior |
| --- | --- | --- |
| 400 | Malformed JSON | Correct the request encoding |
| 413 | Request body too large | Reduce request size |
| 422 | Invalid scenario | Display validation feedback; correct the assumptions |
| 404 | Unknown run/path | Stop displaying the missing run; a server restart may have removed it |
| 409 | Results unavailable for a queued, running, or failed run | Read run status; show a failed job's error rather than waiting forever |
| 503 | Capacity/run limit reached | Show capacity feedback and retry deliberately later |

A worker timeout or nonzero exit becomes a failed run. Do not keep waiting for a completed result after `failed`. The registry is in memory, not durable storage.

## Node-to-worker protocol

Node starts the Python worker asynchronously with an argument array, not a shell command assembled from user inputs. It writes exactly one JSON object to stdin, then closes stdin:

```json
{ "runId": "<run-id>", "scenario": { "...": "validated scenario" } }
```

The worker writes exactly one result-manifest JSON object to stdout and exits successfully. Diagnostic errors go to stderr with a nonzero exit. Node owns HTTP/WebSocket status updates; the worker's stdout must not contain progress logs. A future durable queue or independent model service can replace this transport while retaining the scenario/result contracts.
