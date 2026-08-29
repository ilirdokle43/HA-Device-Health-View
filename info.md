# HA - Device Health view

Two questions, kept strictly apart: **is anything broken right now**, and **does everything my
configuration points at still exist**.

![The Health view](screenshots/health-view.png)

- **Runtime health**, per physical device rather than per entity — offline, disconnected,
  degraded, unknown and low battery, with `off`, `closed`, `idle` and `not_home` correctly
  ignored.
- **A read-only configuration inspector** that walks every automation, script, scene and Lovelace
  dashboard for references to entities, devices, areas, scripts, scenes, helpers, buttons and
  actions that no longer exist.
- **Conservative**: findings are `broken`, `impaired`, `warning` or `unvalidated`, and only
  broken ones reach the red counters. Templates it cannot resolve are reported as unresolvable,
  never as broken.
- **Impaired, not broken**: a configuration whose references all exist but one of which is
  silent right now gets its own tier, and the name of the device responsible.
- **Ignore what you have already decided about**, in six scopes, each showing what it would
  hide before you commit.
- **Two compact alert tiles** for a main dashboard that disappear entirely when nothing is wrong.
- **Unstable devices** — the ones that come and go rather than staying down, measured over a
  day with Home Assistant's own restarts masked out so a reboot is not blamed on a device.
- **System health**: integrations that are failing, add-ons that did not start, Repairs,
  Supervisor issues, backup age, and automations or scripts that ran and failed.
- **Findings survive a restart.** Home Assistant's error log is memory; restarting empties it.
  Incidents are persisted, so a fault recurring for days does not read as healthy the moment
  you reboot for something unrelated.
- **An optional pyscript backend** that reads the YAML packages and UI helpers the frontend
  cannot, and turns the result into health entities, a report file and a notification when
  something new breaks.

Uses only Home Assistant's own APIs. Nothing is ever written — it diagnoses and never repairs.

```yaml
type: custom:device-health-card
```

Full documentation in the [README](https://github.com/ilirdokle43/HA-Device-Health-View).
