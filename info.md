# HA - Health Check

Two questions, kept strictly apart: **is anything broken right now**, and **does everything my
configuration points at still exist**.

![The Health view](screenshots/health-view.png)

- **Runtime health**, per physical device rather than per entity — offline, disconnected,
  degraded, unknown and low battery, with `off`, `closed`, `idle` and `not_home` correctly
  ignored.
- **A read-only configuration inspector** that walks every automation, script, scene and Lovelace
  dashboard for references to entities, devices, areas, scripts, scenes, helpers, buttons and
  actions that no longer exist.
- **Conservative**: findings are `verified`, `warning` or `unvalidated`, and only verified ones
  reach the red counters. Templates it cannot resolve are reported as unresolvable, never as
  broken.
- **Two compact alert tiles** for a main dashboard that disappear entirely when nothing is wrong.

Uses only Home Assistant's own APIs. Nothing is ever written — it diagnoses and never repairs.

```yaml
type: custom:device-health-card
```

Full documentation in the [README](https://github.com/ilirdokle43/HA-Health-Check).
