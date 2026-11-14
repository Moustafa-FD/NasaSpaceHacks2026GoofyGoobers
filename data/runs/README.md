# Run artifacts

The environmental backend persists job records under `environment/{id}.json`. Completed results live in `data/processed/environment/run-{id}.json`; restarting preserves them. Queued/running records become failed with `INTERRUPTED` after restart; submit a new sync to reuse validated raw chunks. Logs and local process metadata may also live here. Generated files are ignored by Git.
