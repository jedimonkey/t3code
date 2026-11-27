# Thread summary eval

Run from `evals/` with an authenticated Codex instance:

```sh
pnpm thread-summaries --out runs/summary-review
```

The runner uses the real summary prompt and two synthetic threads. It reports invalid message references. Review each result against its rubric. Check that the brief fits at a glance, that any user action comes first, and that details retain relevant decisions without resurrecting superseded ones. Repeat when comparing prompt changes, using the same model on both runs.
