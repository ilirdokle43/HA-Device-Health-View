# Changelog

Releases are dated: `YEAR.MONTH.DAY`, matching how Home Assistant itself versions.
A second release on the same day gains a `.1`, a third a `.2`, and the suffix resets
when the date changes.

## 2026.8.29.4

### Fixed

- **Recovery is judged on the path that failed.** The previous check asked whether the *newest*
  entity of an integration was fresh, and a camera disproved it: when the TP-Link coordinator
  hangs, six entities freeze together while the live-view stream carries on, so the newest
  entity is the one thing that never broke - and a pending incident would have cleared on it.
  The evidence path is now the group of entities the coordinator writes **together**, found
  from shared `last_reported` timestamps rather than any hardcoded list, refined by
  intersection over successive passes. Recovery needs that group to advance on three
  consecutive passes; silence never counts and neither does an unrelated entity.
- **A known-broken integration no longer waits two hours to be reported.** Where an integration
  already has error evidence *and* its coordinator path has stopped moving - having previously
  demonstrated a cadence faster than the operational pass - the existing incident escalates.
  Cadence is learned from observation over a twelve-pass window, never assumed, and a
  transient error on a genuinely slow integration can never escalate because it never
  demonstrated speed. This is an extra line of evidence for the existing detector, not a stale
  telemetry monitor.
- **Every observed error is persisted immediately as evidence.** `system_log` is memory and
  also evicts: error-restart-error-restart-error used to look like three clean boots, and an
  incident could never form. Evidence accumulates under a stable `integ:<domain>` fingerprint
  with first seen, last seen and a cumulative count. Evidence is remembered, never displayed
  as a finding and never notified, until it meets the actionable rule.
- **Repeated restarts no longer leak through the unstable-device mask.** Fixed one-minute
  buckets had an edge - thirty devices dropping at :59 and forty at :00 is one restart and two
  buckets, neither reaching the threshold - and four restarts in twenty minutes found it. The
  mass-drop window slides now, the backend records real restart timestamps for the card to
  mask against, and overlapping windows merge so no unmasked slivers remain between them.

## 2026.8.29.3

### Fixed

- **Operational incidents no longer vanish when Home Assistant restarts.** Execution and
  integration errors are read from `system_log`, which is memory: a restart empties it, and
  every incident derived from it disappeared with it. A camera that had been failing for four
  days became "healthy" the instant Home Assistant was restarted for an unrelated reason, and
  a water pump's ninety-four failed shutdowns stopped being on the record. Incidents are now
  kept in the existing JSON store with their fingerprint, owner, one-line summary, count, first
  and last sighting, safety flag and status.
- **A restart no longer produces a false green.** An incident with no live evidence is not
  assumed healed. If Home Assistant restarted since it was last seen it becomes **pending** -
  *"previous failure, awaiting post-restart validation"* - which is shown, counted, and
  deliberately never notified. Fresh errors reactivate the same incident rather than starting a
  new one. A pending integration recovers only on evidence: three consecutive scans in which
  that integration is actually producing fresh telemetry, never on silence.
- Integration errors are consolidated **per integration** rather than per log line, so one
  failing camera is one row, and the fingerprint survives an upgrade moving the source line.
- Supervisor resolution issues are reported one row per issue type, so a single permanent one
  can be silenced without blinding the rest.

### Internal

- Only declared fields reach the incident store - an allow-list, not a filter - and the single
  free-text field is stripped of anything credential-shaped and capped at 160 characters.

## 2026.8.29.2

### Fixed

- **Unstable devices knew what happened yesterday but not what time it is.** A flat 24-hour
  window reported a plug as unstable at five in the afternoon on the strength of an outage
  that ended at half past eleven that morning. A device that is currently available and has
  had no genuine transition for **two hours** is now **Recently recovered**: it keeps every
  figure - availability, disconnect count, time offline - and gains "Stable for 4h 13m", but
  it is no longer red, no longer active, and cannot reach the main dashboard. It leaves the
  page when the outage itself ages out of the 24-hour window, not before. A transition masked
  as a restart never resets the clock, because it was never this device's transition.
- **A device's first hour is commissioning, not instability.** Pairing a Zigbee plug produces
  a run of rejoins before it settles - twelve in fifty-seven minutes on the device that
  prompted this - and every one of them was being counted. Transitions inside the first hour
  after the device registry created the device are now excluded, along with the downtime.
  The join time comes from `created_at` on the registry entry, so it is recorded rather than
  inferred; a device the registry cannot date simply gets no grace.
- Operational findings honour the ignore rules that already govern the configuration findings,
  so an add-on that stops itself by design can be silenced.
- The published operational document is rewritten whenever a field the page renders changes.
  `safety` was missing from that check, so labelling an automation safety-critical corrected
  the payload and never reached the page.

## 2026.8.29.1

### Added

- **EXECUTION ERROR, a fourth configuration tier.** A configuration can be entirely valid and
  the house still not do as it was told. On the install this was built for, a water-safety
  automation tried to switch off a running pump 94 times in 93 minutes and failed every time -
  every reference valid, every entity present, the page reporting perfect health. Failures are
  read from Home Assistant's own deduplicated error store, so 94 failures arrive as **one**
  incident carrying the failing step, the error text, the first and latest failure, how many
  landed in the last hour and whether it is still recurring. Three failures in an hour make it
  actionable; one does not. An automation labelled `safety_critical` in the entity registry is
  actionable on the first failure - a label someone applied, never inferred from a name. When
  the failures stop the incident stays as recently recovered for a day and then goes.
- **A SYSTEM section**, hidden completely when there is nothing wrong. Add-ons that are in an
  error state or were set to start on boot and did not; the age of the last successful
  automatic backup; a count of active native Home Assistant repairs; supervisor resolution
  issues; and integrations that keep throwing behind a config entry that still says `loaded`.
- **Unstable devices.** The same devices the page already lists, seen over a day instead of at
  an instant: availability, disconnect count and longest outage over 24 hours. A device that is
  up when you look and spent six hours unreachable this morning was previously invisible here.
  Transitions caused by a Home Assistant or coordinator restart are excluded - the restart is
  recognised from its own shape, a third of the house dropping inside one minute, so it covers
  restarts of things that have no entity to watch.
- Two published sensors, `sensor.config_health_execution_errors` and `sensor.config_health_system`,
  and notifications for both new tiers, sharing the incident store so nothing is reported twice.

### Changed

- The main-dashboard tile now rises for a currently failing automation, an add-on in an error
  state, a stale or failed backup, an integration that has been failing for hours, and a device
  below 80% availability. It deliberately does **not** rise for a repair, a supervisor issue, a
  device between 95% and 99%, or a recovered execution error.

## 2026.8.29

### Fixed

- **The version banner told the truth about the wrong build.** `CARD_VERSION` had not been
  bumped in four releases, so the line the card prints to the console named a build from
  three days earlier. A page still running an older bundle and a freshly updated one
  therefore looked identical, which is exactly the case the banner exists to tell apart.
  A test now refuses to pass unless the constant matches the newest heading in this file.

### Changed

- **Skip can sit on a single entity, not only on its device.** The backend has always
  honoured a `skip_health_checks` label on either; the card only looked at the device. One
  sensor that reports nonsense while the rest of the machine is fine can now be silenced on
  its own. As before, only the runtime verdicts go quiet - a reference to an entity that has
  actually been deleted is still broken.

### Internal

- The offline harness dropped registry labels when it rebuilt `hass` from a dump, so no tool
  or test built from real data could see skip at all: they reported findings for devices the
  browser hides. Labels now survive on both devices and entities.

## 2026.8.28.3

### Fixed

- **Skip now means skipped everywhere.** Skipping a device took it out of the device list but
  left every configuration item that references it reporting as impaired - a 3D printer that
  travels between two houses put seven rows on a dashboard for being switched off in the house
  it was not in. The runtime join and the backend both honour the skip label now, so the page,
  the health sensors and the notifications agree. Only the runtime verdicts go quiet:
  **a reference to an entity that has actually been deleted is still broken**, skipped device
  or not. `exclude_devices` in the card's own YAML skips the same way.

## 2026.8.28.2

### Fixed

- **A stem is not a broken reference.** Custom cards routinely take a *prefix* and build the
  real entity id from it - a button-card template doing
  `entity: [[[ return variables.batt_sensor + '_battery' ]]]` turns
  `batt_sensor: sensor.tab_hall` into `sensor.tab_hall_battery`. The value written in the
  configuration is not an entity and never was, but the card-option rule flagged every one of
  them, putting a row per tablet on a real dashboard: nine findings, eight of them wrong.
  A weak card-option reference that is the strict prefix of an entity that *does* exist is now
  left alone entirely. A deleted entity being the prefix of a living one is vanishingly rare;
  a stem being one is the whole point of a stem, and that asymmetry is what makes the rule
  safe. Anything that is nobody's stem is still reported - as unvalidated, never as broken -
  which is how the one genuine typo in that set survived the change.

## 2026.8.28.1

### Fixed

- **A button nobody has pressed is not impaired.** A `button` entity's state is the timestamp
  of its last press, so one not pressed since Home Assistant started reads `unknown` forever -
  200 of 220 buttons on the install this was found on. The impaired join treated every one of
  them as a dependency in trouble, so a dashboard referencing a button was reported as impaired
  while working perfectly. `unknown` no longer creates an impaired finding for the command
  surfaces whose resting state it is - buttons, scenes, events, notify targets, images, TTS and
  the rest of the list already excluded from device health for the same reason. **`unavailable`
  still does**: a button that has gone unavailable means the hardware has left the network, and
  that is worth knowing. The card and the backend share the rule, so the page, the sensors and
  the notifications agree.
- **Reworded the impaired message.** "Referenced entity is unknown" read as "I do not recognise
  this entity", which is the one thing it never meant - a reference to something that genuinely
  does not exist is reported as missing, in red, before that check ever runs. It now says
  **"Referenced entity has never reported a value"**.

## 2026.8.28

The two halves of the scanner now share one dependency universe, and the whole thing grew an
operational layer: health entities, a Rescan button, notifications and a report file.

### Added

- **Health entities.** Six registry entities over MQTT discovery, grouped under one service
  device called **Home Assistant Health**: `sensor.config_health_status` (`healthy` ·
  `warning` · `impaired` · `broken` · `error`), `sensor.config_health_broken`,
  `sensor.config_health_impaired`, `sensor.config_health_warnings`,
  `sensor.config_health_last_scan` and `button.config_health_rescan`. They appear in entity
  pickers, work in automations and templates, and survive a restart. Without a broker they
  simply do not appear and nothing else changes.
- **Notifications for genuinely new problems.** After a scheduled scan the backend compares
  the current actionable findings against what it has already told you about, fingerprinted by
  kind, reference and owner, and pushes only what is new. Broken findings notify at once;
  impaired findings must have been continuously impaired for five minutes first, because a
  device blinking out for three seconds is not news. A finding that clears is forgotten, so
  its return counts as a new incident. Ten new findings are one message. Warnings, ignored and
  unvalidated findings never notify, a scan you ask for by hand never notifies, and nothing is
  sent for ten minutes after a restart.
- **A report file** at `config/config_health_report.txt`, rewritten after every completed
  scan, naming the owner, the reference, the problem, its location and — for impaired
  findings — how long it has been that way.
- **`config/config_health_options.json`** for the two settings that are specific to one house:
  the notify action and where a tap should land.
- **The Ignore UI.** The eye-off button on any counted finding offers the scopes that apply,
  each showing how many findings it would hide before you commit. An **Ignored** panel lists
  every rule with what it is hiding and a **Show again** button.
- **`pyscript.config_health_deps`** returns the full dependency universe; `config_health_rescan`
  now answers with a summary an automation can act on.
- **Top-level `variables` and `trigger_variables`** on automations and scripts are walked, as
  is a script's `fields.default`. Its `description`, `example` and `selector` are documentation
  for the run dialog and are still left alone.
- **A custom card's own option names** are recognised by the shape of their value, so
  `rain_sensor: binary_sensor.rain` becomes a dependency. A guess that does not resolve is
  reported as unvalidated, never as broken.

### Changed

- **One dependency universe.** The backend now hands the card every reference that *resolves*,
  with the file, line and owner that names it, so a dependency in a YAML package,
  `templates.yaml`, `sensors.yaml` or a helper's config entry takes part in the impaired join.
  A reference both halves of the scanner see is one dependency with two witnesses, not two
  rows saying the same thing.
- **One classification, used by both halves**, with fixed precedence: missing beats disabled
  beats unavailable beats unknown, and everything else is a working entity doing its job.
  A disabled reference is a warning; it was previously reported by only one half.
- **Ignore rules are actually applied.** They were stored and republished but never consulted.
  All six scopes now hold across the page, the counters, the compact tiles, the health
  entities and notifications.
- **The compact tiles honour impaired.** Either tile appears for broken *or* impaired work,
  distinguished by colour; warnings and ignored findings never raise one on their own.
- The page footer says when the last scan ran and when the next one is due, dropping the
  schedule below 560px and the timestamp below 340px so it costs no height on a narrow card.
- The published broken-reference list is folded into the card's own model rather than
  overwriting its counters, so a finding only the browser can see is no longer discarded.

### Fixed

- **Prose is no longer mistaken for configuration.** `description`, `example`, `url`, `note`,
  `comment`, `event_type`, `logger`, `unique_id` and `webhook_id` are dropped by both halves of
  the scanner, including a folded description that runs over several lines. An automation whose
  description deliberately names a deleted sensor — to say which one *not* to use — was being
  reported as broken.
- **Renaming, deleting or disabling an entity now updates the page.** `entity_registry_updated`,
  `service_registered` and `service_removed` re-judge the configuration already in hand against
  a fresh registry: one round trip and about fifteen milliseconds, rather than the hundreds a
  full rescan costs. `scene_reloaded` triggers a full rescan alongside the existing events.
- A failed scan publishes `status: error` and keeps the previous counts. It no longer reports
  zero problems because it could not read the configuration, and it never notifies.
- The field path on a helper's finding read `.options.state` rather than `options.state`.
- The house tile no longer appears for configuration warnings alone.

## 2026.8.25.4

### Fixed

- **The page now follows the scan.** Deleting or fixing a reference asked for a rescan, the
  rescan republished — and nothing redrew, so the reference stayed on screen looking
  untouched. The card decides whether to re-render from a signature over the states that can
  change what it draws, and the scan entity is not one of them.
  The panel and the CONFIGURATION HEALTH counters now follow that entity whoever asked for
  the scan: this card, another tab, or the nightly one.
- **Rescan redraws.** The panel's own Rescan button asked for a scan and then left the old
  results on screen.
- A delete waits for Home Assistant to flush `.storage` before rescanning. The scanner reads
  those files rather than the running registry, so scanning the instant a delete returns
  could read the pre-delete file and leave the row up — indistinguishable from a failure.

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
