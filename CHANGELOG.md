# Changelog

Releases are dated: `YEAR.MONTH.DAY`, matching how Home Assistant itself versions.
A second release on the same day gains a `.1`, a third a `.2`, and the suffix resets
when the date changes.

## 2026.8.18

First public release.

### Runtime health

- Per-**device** health rather than per-entity: one physical device with four unavailable
  entities is one problem, not four. Entities belonging to no device are reported separately as
  entity-only problems.
- Four verdicts — **disconnected**, **offline**, **degraded** and **unknown** — decided from a
  device's runtime entities only, excluding disabled and hidden ones and the domains whose
  resting state looks like a fault.
- `off`, `not_home`, `idle`, `standby`, `paused`, `closed` and `docked` are never treated as
  faults.
- Low battery at or under a configurable threshold, deduplicated by device.
- **Probable shared causes**: several devices of one integration failing inside a short window
  are reported together, and a window that also takes down helpers and templates is attributed
  to Home Assistant rather than to the integration.
- **Recently recovered** and **recently deleted**, told apart by the device registry so that
  deleting a dead device does not read as good news.
- Per-integration status grid.

### Configuration inspector

- Read-only inspection of every automation, script, scene and Lovelace dashboard for references
  to entities, devices, entity-registry ids, areas, floors, labels, scripts, scenes, helpers,
  buttons and actions that no longer exist.
- Structural walking rather than string matching, so documentation and free text are never
  mistaken for references.
- Three confidences — `verified`, `warning`, `unvalidated` — with only verified findings reaching
  the red counters.
- Static entity references inside `states()`, `is_state()` and `state_attr()` templates are
  checked; dynamic ones are reported as unresolvable.
- Custom card registration and duplicate Lovelace resource registrations.
- Findings name the domain: "Missing button", "Missing helper", "Missing script".
- One rename inference only: `entity_id` gone while `entity_id_2` exists.
- Expanding a dashboard finding offers a button per affected view.
- The scan is shared by every card on the page and repeats only on a real change —
  `lovelace_updated`, `automation_reloaded`, the set of automation/script/scene entities, or the
  Rescan button. Nothing polls.

### Compact modes

- `mode: device-compact` and `mode: configuration-compact`: two small tiles for a main dashboard.
- Both disappear from the layout entirely when there is nothing to report — no zero, no empty
  card, no gap.
- If either has something to report both appear, so the row is full width and the quiet one goes
  grey.

### Layout

- Responsive to the card's own width via container queries, verified from 304px upwards.
- Sections with nothing in them are not rendered.
