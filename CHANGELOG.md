# Changelog

Releases are dated: `YEAR.MONTH.DAY`, matching how Home Assistant itself versions.
A second release on the same day gains a `.1`, a third a `.2`, and the suffix resets
when the date changes.

## 2026.8.25.3

### Fixed

- **Delete failed on every helper.** It asked for a websocket command
  `config_entries/delete`, which does not exist — Home Assistant answers
  `unknown_command`. Deleting a config entry is REST:
  `DELETE /api/config/config_entries/entry/<id>`, which is what the frontend itself uses.
  Nothing was ever removed by the broken path; it failed before touching anything.
- **A failed action now says why in the row**, not only in the button's tooltip. The old
  behaviour left "Failed" on screen with the reason hidden behind a hover.

## 2026.8.25.2

- **Delete, next to Open, when the thing holding a broken reference is used by nothing.**
  A helper or script that nothing references and that points at something gone is a dead
  end, not a repair job — removing it is usually the honest answer.
- The scan now records every reference that *resolves*, so "used by nothing" is established
  rather than assumed. That matters because a template helper can be referenced from another
  helper's options, which the frontend cannot see at all.
- One button per unreferenced holder, named when a reference has more than one, and only for
  the unreferenced ones — a row whose holders are all in use still shows Open alone.
  Two-step confirm, and Home Assistant performs the removal through its own APIs.
- Automations and scenes are never offered for deletion even when unreferenced: one nothing
  calls may still be triggered by time or state.

## 2026.8.25.1

- **Broken references now offer a way in rather than a dropdown.** A reference the card is
  confident about still shows **Fix**. Everything else now opens whatever holds the
  reference, so it can be corrected in Home Assistant's own editor:
  **Open helper** for a UI-built template helper, **Open dashboard** for a card,
  **Open automation / script / scene** for an editor-backed item.
- Previously every unconfident row said *Choose*, which offered a `<select>` of every entity
  in the domain — hundreds of sensors — and then rewrote the configuration. That picker
  remains only as a last resort, for a finding with nowhere to go.
- Home Assistant has no URL for a single config entry (`/config/helpers/edit/<id>` just
  renders the list), so a helper is reached through its own entity's more-info dialog, which
  carries the settings cog. The entity is resolved from the registry, the only place
  `config_entry_id` is exposed.

## 2026.8.25

### Broken references (new, optional)

- A **pyscript backend** (`pyscript/config_health.py` + `python_modules/ha_config_scan.py`)
  that finds dead entity references inside **UI-created template helpers** — configuration
  that lives in `.storage/core.config_entries` and is not exposed to the frontend, so the
  card's own inspector could never see it. A helper averaging a sensor you deleted last year
  looks healthy from the outside and quietly returns `unknown`.
- The card grows a **BROKEN REFERENCES** panel listing each dead reference with the helper
  that owns it, a Rescan button, and a per-row fix.
- Fixing refuses to rewrite anything under `.storage` (Home Assistant owns those at runtime);
  plain config files are backed up to `.bak-<timestamp>` first, and dashboard and helper
  references go through Home Assistant's own APIs instead.
- Entirely optional. Without the backend installed the panel does not appear, nothing errors
  and no counter changes.

### Fixed

- The broken-references panel no longer appears on the compact tiles. It is patched onto the
  shared prototype, so without a mode check every instance rendered it — including a tile
  meant to be one line tall. The tile keeps the count and links through.

### Also

- Command surfaces (`remote`, `infrared`, `radio_frequency`, `siren`) now count as a fault
  when `unavailable`, via `unavailable_is_fault_domains`. Their *idle* state looks bad, which
  is why they are otherwise ignored — but a device whose only entities are command surfaces
  was invisible to the page and could sit dead for hours behind a clean bill of health.

## 2026.8.22.1

- **The default battery threshold is now 18%**, down from 20%. Devices that live on a charger
  commonly rest at exactly 20%, so a threshold of 20 flagged them permanently. 18 leaves a
  couple of points of margin and reports only batteries that are genuinely heading down.
  `battery_threshold` still overrides it.

## 2026.8.22

### Skipping a device

- **Skip** on any device in Needs attention stops the card checking it — for devices that are
  off on purpose, like a desktop shut down when the house is empty.
- A **Skipped devices** section lists them with an **Un-skip** button, and is hidden entirely
  while nothing is skipped. Each row reports what the skip is currently suppressing, so a skip
  that has started hiding a real fault stays visible.
- A skipped device leaves the monitored population rather than being counted as healthy, and is
  excluded from the problem list, the low-battery list, the integration grid and shared-cause
  clustering.
- The list is a label on the device registry, so it is install-wide rather than per-browser, and
  can be managed from Settings → Devices. `skip_label` and `exclude_devices` configure it.

### Fixed

- `navigation_path` no longer defaults to a path that only existed on the author's install. The
  compact tiles are readouts until it is set, and no longer offer a tap that goes nowhere.

## 2026.8.17

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
