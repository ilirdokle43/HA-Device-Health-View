# HA - Device Health view

A Home Assistant card that answers two questions and keeps them strictly apart:
**is anything broken right now**, and **does everything my configuration points at still exist**.

![The Health view](screenshots/health-view.png)

Home Assistant will happily run an automation that references an entity you deleted six months
ago. It fails silently, at three in the morning, and nothing tells you. Meanwhile a sensor that
went offline yesterday looks exactly like one that is merely switched off. This card separates
the two and reports both.

| | Question | Example |
|---|---|---|
| **Runtime health** | is anything unhealthy *right now*? | `sensor.outdoor_temperature` exists but reads `unavailable` — a device problem |
| **Configuration health** | does everything the configuration *points at* still exist? | an automation names `sensor.old_outdoor_temperature`, which was deleted — a configuration problem |
| **The join between them** | is anything *structurally fine but unable to run today*? | an automation whose sensor exists but has been silent for four hours — **impaired**, not broken |

A device card never becomes a broken-automation card, and neither counter ever counts the
other's findings.

Everything comes from Home Assistant's own APIs — the state machine, the entity/device/area
registries, `automation/config`, `script/config`, the scene editor endpoint, `lovelace/config`,
`lovelace/resources` and `get_services`. No third-party integration is required for any of it,
and the card never writes to your configuration on its own.

One optional extra goes further: a [pyscript backend](#the-backend-optional) that reads what
the frontend cannot — YAML packages, `templates.yaml`, and the helper configuration buried in
`.storage` — and turns the whole thing into health entities, a report file and a notification
when something new breaks. That part *can* repair a reference, but only when you press the
button, and it never rewrites a `.storage` file Home Assistant owns.

## Features

- **Device-oriented, not entity-oriented.** One physical device with four unavailable entities
  is one problem, not four. Entities that belong to no device are reported separately.
- **`off` is not a fault.** A light that is off, a cover that is closed, a media player that is
  idle, a person who is `not_home` — none of these are health problems, and the card never
  pretends otherwise.
- **Broken references, found statically.** Automations, scripts, scenes and every Lovelace
  dashboard are walked structurally for references to entities, devices, areas, floors, labels,
  scripts, scenes, helpers, buttons and actions that no longer exist.
- **Conservative by design.** Every finding is `broken`, `impaired`, `warning` or `unvalidated`,
  and only broken findings reach the red counters. A template it cannot resolve is reported as
  unresolvable, never as broken.
- **Impaired, not broken.** A configuration whose references all exist but one of which is
  `unavailable` or `unknown` right now cannot do its job today. It gets its own tier, its own
  colour, and the name of the device responsible.
- **Ignore what you have already decided about.** Six scopes — one reference, a glob, one
  configuration item, one kind of finding, that kind on that item, or anything carrying a
  label — each showing how many findings it would hide *before* you commit to it.
- **Two alert tiles** for a main dashboard that show nothing at all when nothing is wrong.
- **Probable shared causes.** When several devices on one integration fail within minutes of
  each other, it says so — and distinguishes that from a Home Assistant restart.
- **Responsive to the card's own width**, not the browser's, so it behaves the same in a narrow
  dashboard column as on a phone.
- **No polling.** Runtime health follows the state machine; the configuration scan runs once and
  repeats only when something it read has actually changed.
- **System health.** Integrations that are failing, add-ons that did not start, Home Assistant
  Repairs, Supervisor issues and the age of the last successful backup, each with its own tier.
- **Execution errors.** Automations and scripts that ran and failed — the step that failed and
  how many times — rather than only configurations that are wrong on paper.
- **Unstable devices.** Devices that come and go rather than staying down, measured over a day
  and with Home Assistant's own restarts masked out so a reboot is not charged to a device.
- **Incidents survive a restart.** `system_log` is memory: restarting Home Assistant empties it.
  Findings are persisted, so a fault that has been recurring for days does not read as healthy
  the moment you reboot for something unrelated.

## Installation

### HACS (custom repository)

1. HACS → ⋮ → **Custom repositories**
2. URL: `https://github.com/ilirdokle43/HA-Device-Health-View`, type: **Dashboard**
3. Install, then reload your browser.

### Manual

Copy `device-health-card.js` into `config/www/` and add the resource:

```yaml
url: /local/device-health-card.js
type: module
```

## Configuration

### The full page

```yaml
type: custom:device-health-card
```

That is the whole configuration. Everything below is optional.

| Option | Default | What it does |
|---|---|---|
| `mode` | `full` | `full`, `device-compact`, `configuration-compact`, `conflicts-compact` or `overall-compact` |
| `battery_threshold` | `18` | Percent at or under which a battery needs attention |
| `degraded_ratio` | `0.5` | Fraction of a device's entities that must be unavailable before it is "degraded" rather than "offline" |
| `recovery_minutes` | `120` | How long a recovered or deleted device stays listed |
| `ignored_domains` | see below | Domains whose resting state looks like a fault |
| `exclude_integrations` | `[]` | Integrations to leave out entirely |
| `exclude` | `[]` | Regular expressions matched against entity ids |
| `skip_label` | `skip_health_checks` | Label id that marks a device as skipped |
| `exclude_devices` | `[]` | Device ids to skip without using a label |
| `sections` | all | Which sections to render, in order |
| `cluster` | see below | Shared-cause detection thresholds |
| `navigation_path` | none | Path the compact tiles open on tap. Unset, they are readouts and do not react to a tap |

A worked example:

```yaml
type: custom:device-health-card
battery_threshold: 15
exclude_integrations:
  - mobile_app
exclude:
  - '^sensor\..*_uptime$'
cluster:
  window_minutes: 10
  min_devices: 3
```

### The two compact tiles

For a main dashboard, where you normally want to see nothing at all:

```yaml
type: custom:device-health-card
mode: device-compact
navigation_path: /my-dashboard/health
grid_options: { columns: 6, rows: auto }
```
```yaml
type: custom:device-health-card
mode: configuration-compact
navigation_path: /my-dashboard/health
grid_options: { columns: 6, rows: auto }
```

![The two compact tiles](screenshots/compact-tiles.png)

**The pair lives or dies together.** When neither has anything to report, both disappear
completely — not a green card, not a zero, no empty cell; the dashboard closes the space. When
*either* has something, both appear so the row is full width, and the quiet one goes grey.

Set `navigation_path` to wherever you put the full page and a tap will open it. Leave it out and
the tiles are readouts.

Placed on their own, without the other, each tile simply hides itself when it has nothing to
say.

## Skipping a device

Some devices are off on purpose — a desktop shut down when the house is empty, a socket cut
at the wall for the winter — and reporting them as unreachable is noise rather than news.

Expand any device in **Needs attention** and press **Skip**. It leaves the checks
immediately and moves to a **Skipped devices** section, which is hidden entirely while
nothing is skipped. Each row there shows what the skip is currently suppressing, so a device
skipped a year ago that is now genuinely dead is still easy to notice, and an **Un-skip**
button puts it back.

A skipped device leaves the monitored population altogether rather than being counted as
healthy: calling a deliberately powered-off machine "online" would be as wrong as calling it
offline.

**Skipping also silences the configuration half.** An automation or dashboard that references a
skipped device stops being reported as impaired, because "this device is off on purpose" and
"this automation cannot run today" are the same fact told twice. A 3D printer that travels
between two houses is switched off in one of them by definition. What skipping does *not* hide
is a reference to an entity that has genuinely been deleted — that is broken configuration
whether or not the device is skipped.

The list is stored as a **label on the device registry**, not in the browser, for two
reasons: it is install-wide, so skipping a device at a desk also skips it on every wall
tablet; and it is visible and removable in **Settings → Devices**, so the state is never
trapped inside this card. The label is created the first time it is needed.

That also gives you two other ways in, for a device that is currently healthy and so has no
card to press Skip on: add the label by hand in Settings, or name the device in
`exclude_devices`.

## The backend (optional)

The inspector above reads what Home Assistant will serve over its API. That leaves a blind
spot roughly a third of the configuration wide: **YAML packages and included files**, and
**helpers created in the UI**, whose configuration lives inside `.storage/core.config_entries`
and is never exposed to the frontend. A helper averaging a sensor you deleted last year looks
perfectly healthy from the outside and quietly returns `unknown`.

An optional pyscript backend closes that gap. It walks the configuration files and the
relevant `.storage` entries, publishes what it finds on `pyscript.config_health`, and the
card grows a **BROKEN REFERENCES** panel listing each dead reference with the helper that
owns it. It also hands the card every reference that *resolves*, so a dependency the browser
cannot see still takes part in the impaired join — and it publishes health entities, writes a
report file and sends a notification when something new appears.

### Installing it

Requires the [pyscript](https://github.com/custom-components/pyscript) integration.

1. Copy `pyscript/config_health.py` into `config/pyscript/`
2. Copy `python_modules/ha_config_scan.py` into `config/python_modules/`
3. Reload pyscript

Without it the card behaves exactly as before — the panel simply does not appear. Nothing
errors, and no counter changes.

### Services

| Service | What it does |
|---|---|
| `pyscript.config_health_rescan` | Re-runs the scan and republishes everything. Answers with a summary (`status`, `broken`, `impaired`, `warnings`, `ignored`, `generated`) so an automation can act on the result without reading an entity back. Also runs at startup and daily at 04:17. |
| `pyscript.config_health_deps` | Returns the full dependency universe — every reference that resolves, with the file, line and owner that names it. Response-only, because it is far too large for a state attribute. |
| `pyscript.config_health_fix` | Replaces one missing reference with an existing entity. |
| `pyscript.config_health_ignore` | Accepts a finding so it stops being reported. `scope` is one of `ref`, `pattern`, `item`, `kind`, `label`. |
| `pyscript.config_health_unignore` | Withdraws one rule by `rule_id`, or all of them with `all_rules: true`. |

### Health entities

The backend publishes six entities over MQTT discovery, grouped under one service device
called **Home Assistant Health**. They are ordinary registry entities: they appear in entity
pickers, work in automations and templates, and survive a restart.

| Entity | State | Attributes |
|---|---|---|
| `sensor.config_health_status` | `healthy` · `warning` · `impaired` · `broken` · `error` | last successful scan, next scheduled scan, files scanned, dependencies tracked, scan duration, error |
| `sensor.config_health_broken` | count of broken **items** | a breakdown per owner type, and the number of distinct references |
| `sensor.config_health_impaired` | count of impaired items | the same shape |
| `sensor.config_health_warnings` | count of warnings | — |
| `sensor.config_health_last_scan` | timestamp | — |
| `sensor.config_health_execution_errors` | count of automations/scripts that ran and failed | the failing item, the step, first and last occurrence |
| `sensor.config_health_system` | count of live system findings | integration, add-on, Repairs, Supervisor and backup findings |
| `button.config_health_rescan` | — | presses run the same scan the card's Rescan button does |

Requires the MQTT integration. Without a broker the card and the panel work exactly as
before; the entities simply never appear.

A failed scan publishes `status: error` and **keeps the previous counts**. It never reports
zero problems because it could not read the configuration, and it never notifies.

### Notifications

After a *scheduled* scan — never after one you asked for by hand — the backend compares the
current actionable findings against what it has already told you about, and pushes only what
is new:

- a **broken** finding notifies as soon as a background scan sees it;
- an **impaired** finding has to have been continuously impaired for five minutes first,
  because a device blinking out for three seconds is not news;
- a finding already notified never notifies again;
- a finding that clears is forgotten, so if it comes back it counts as a new incident;
- warnings, ignored and unvalidated findings never notify at all;
- ten new findings are one message, not ten.

Nothing is pushed for ten minutes after a restart, so a house coming back up is not reported
as a house full of new problems.

To switch it on, create `config/config_health_options.json`:

```json
{
  "notify_service": "mobile_app_my_phone",
  "notify_url": "/lovelace/health"
}
```

`notify_service` is the part after `notify.` in **Developer tools → Actions**; `notify_url`
is where tapping the notification should land. Leave the file out and notifications stay
off — everything else still works. Incident state lives in
`config/config_health_notification_state.json`, which is small and readable.

### Report file

Every completed scan rewrites `config/config_health_report.txt`:

```text
HOME ASSISTANT CONFIGURATION HEALTH

Generated: 2026-08-28 04:17
Status: HEALTHY

BROKEN:   0
IMPAIRED: 0
WARNINGS: 0
IGNORED:  0
...
```

When something is wrong it names the owner, the reference, the problem, where it was found,
and — for impaired findings — how long it has been that way. Ignored findings are listed
apart from the actionable ones. It contains entity ids, friendly names and file positions;
`secrets.yaml` is never scanned and the keys that could carry a URL or a token are dropped
before a reference is ever recorded.

### What it will and will not rewrite

`config_health_fix` **refuses to touch anything under `.storage`** — Home Assistant owns
those files at runtime and would overwrite the edit. For plain config files it copies the
file to `<name>.bak-<timestamp>` before writing, then reloads the affected domain.

Dashboard and helper references, which do live in `.storage`, are changed from the card
through Home Assistant's own APIs instead — `lovelace/config/save` for a dashboard, the
options flow for a helper — so Home Assistant performs the write.

A one-click **Fix** is only offered when a rename is near-certain. Anything less confident
does not guess — it gives you a way in instead, opening whatever holds the reference so you
can correct it in Home Assistant's own editor:

| Where the reference lives | Button |
|---|---|
| A template helper built in the UI | **Open helper** — its more-info dialog, and the settings cog |
| A dashboard card | **Open dashboard** |
| An automation, script or scene | **Open automation** / **script** / **scene**, straight to the editor |

And when the helper or script holding the reference is itself **referenced by nothing**, a
**Delete** button appears beside it. A dead end is usually better removed than repaired.

"Used by nothing" is established, not assumed: the scan records every reference that
resolves, across the YAML config, the dashboards and the helper options — the last of which
the frontend cannot see, so a helper called only from another helper is still correctly
counted as used. Deleting asks for confirmation and is carried out by Home Assistant's own
APIs. Automations and scenes are never offered for deletion even when unreferenced, since
one nothing calls may still be triggered by time or state.

## How runtime health is decided

Health is evaluated per **device**, from that device's *runtime entities*: registry entities
that are not disabled, not hidden, and not in a domain whose bad-looking state is its resting
state — buttons, update entities, notify targets, presence and command surfaces are all
excluded.

| Verdict | Rule |
|---|---|
| **Disconnected** | a `binary_sensor` with `device_class: connectivity` reading `off`, or an entity whose state literally says `offline` / `disconnected` / `unreachable` / `not_connected` / `not_responding` |
| **Offline** | *every* runtime entity of the device is `unavailable` |
| **Degraded** | at least half the runtime entities are `unavailable`, but not all |
| **Unknown** | no runtime entity has a usable value and at least one is `unknown` rather than `unavailable` |

`off`, `not_home`, `idle`, `standby`, `paused`, `closed` and `docked` are never faults. Duration
comes from the earliest `last_changed` among the entities responsible for the verdict.

A device can leave the problem list for two very different reasons, and the device registry is
what tells them apart: still registered means it started answering again (**recovered**, green);
gone from the registry means it was deleted (**deleted**, grey and deliberately uncelebratory).

## System health

Separate from both device health and configuration health: things that are wrong with Home
Assistant itself rather than with a device or a reference. Each finding carries one of
`BROKEN` · `EXECUTION ERROR` · `IMPAIRED` · `WARNING`, and only the first three reach the
compact tiles.

| Finding | What raises it |
|---|---|
| **Execution errors** | An automation or script that ran and failed — which step, what the error was, how many times and over what span. Repeated failures of the same step are one incident, not ninety-four. |
| **Integration failures** | An integration logging errors persistently. Judged on the integration's own data path, so a fault is not masked by an unrelated entity of the same integration that happens to be fine. |
| **Add-ons** | An add-on in an error state, or one set to start on boot that is not running. An add-on set to start manually and currently stopped is working as configured and is never reported. |
| **Repairs** | Home Assistant's own repair issues, counted by severity. |
| **Supervisor issues** | Unresolved supervisor issues, one row each. |
| **Backups** | The age of the last *successful* automatic backup, and whether the most recent attempt failed. A failed attempt is reported immediately rather than waiting for the age threshold. |

### Incidents survive restarts

`system_log` is in memory. Restarting Home Assistant empties it, so anything derived from it
disappears — which is how a fault that had been recurring for days could read as healthy the
moment you restarted for an unrelated reason.

Findings are written to `config/config_health_incidents.json` and reconciled on every pass.
An incident with no current evidence is not deleted: if Home Assistant restarted since it was
last seen it becomes **pending** — it was real, and nothing has checked since — and it clears
only on sustained healthy evidence, never on silence alone. Restarts are detected from the
Core process's own identity, so reloading pyscript is not mistaken for a restart.

Only a declared set of fields is persisted, and free text is stripped of anything
credential-shaped and hard-capped, because the file sits next to the configuration.

### Unstable devices

A device that is *down* is already reported. This is the other failure: one that comes and
goes. Availability is measured over 24 hours from recorder history, and Home Assistant's own
restarts — plus mass-disconnect events, such as a Zigbee coordinator taking the mesh with it —
are masked out, so a reboot is never charged to a device. A device recently added is given a
commissioning grace period, and one that has been quiet for hours is reported as *recently
recovered* rather than as currently unstable.

### A note on freshness, if you are reading the source

In-process freshness comes from the `State.last_reported` **attribute**. Do not substitute
`state.as_dict()["last_reported"]`, `as_dict_json`, or the websocket's `last_reported`: those
are served from a cached representation. `State._as_dict` is an `@under_cached_property`, and
a write that produces the same state *and* the same attributes takes Home Assistant's fast
path, mutating the attribute on the existing object without rebuilding that cache. For an
entity whose value does not change, the serialised timestamp freezes at the moment the object
was created while the attribute keeps advancing. `last_updated` is not a substitute either —
it only moves when the value actually changes.

## The configuration inspector

Read-only. It diagnoses and never repairs, rewrites or deletes anything.

It walks the configuration of every automation, script, scene and dashboard **structurally** — a
string is only a reference because of the key above it, so `example: "switch.foo"` in a script's
field documentation is never mistaken for a call. Every finding carries a confidence:

| | Meaning | Counted as broken? |
|---|---|---|
| **broken** 🔴 | static reference, in a slot that can only hold that kind of object, and the object is in none of the registries | yes |
| **impaired** 🟠 | every reference exists, but one of them is `unavailable` or `unknown` right now, so the item cannot do its job today | no — its own counter |
| **warning** 🟡 | a legitimate explanation exists — the object is disabled, its integration is not loaded, or the reference sits in a block that is switched off | no |
| **unvalidated** ⚪ | the slot holds a template or a runtime variable | never |

An item whose *only* findings are unvalidated never appears on the page at all.

What is checked: entities (naming the domain — "Missing button", "Missing helper", "Missing
script"), devices and entity-registry ids inside device automations, areas, floors, labels,
actions/services, static entity references inside `states()` / `is_state()` / `state_attr()`
templates, top-level `variables` and `trigger_variables`, a script's `fields.default`,
Lovelace cards and badges at any nesting depth, a custom card's own option names, custom card
registration, and duplicate Lovelace resource registrations.

### One dependency universe

A reference that *resolves* is not a finding, but it is a dependency: if that entity later
goes quiet, the thing naming it stops working while remaining perfectly valid. Both halves
of the scanner record those edges into one index — the browser for what it can read over the
API, the backend for what it cannot: YAML packages, `templates.yaml`, `sensors.yaml` and
every helper's config entry. A reference both halves see is one dependency with two
witnesses, never two rows saying the same thing.

The runtime join then walks only the entities that are not answering. One classification is
used by both halves, and its precedence is fixed:

```text
missing      in neither the state machine nor the registry   -> BROKEN
disabled     in the registry, disabled_by set                -> WARNING
unavailable  exists, enabled, state is "unavailable"         -> IMPAIRED
unknown      exists, enabled, state is "unknown"             -> IMPAIRED
anything else                                                -> healthy
```

`off`, `closed`, `idle`, `standby` and `not_home` are a working entity doing its job.

### Ignoring a finding

The eye-off button on any counted finding offers the scopes that apply to it, each with the
number of findings it would hide. Rules live in `config/config_health_ignores.json` — on the
Home Assistant side, not in one browser, because the same answer has to hold on every tablet
and survive a restart. An **Ignored** panel lists every rule with what it is hiding and a
**Show again** button. Ignored findings never reach a counter, the compact tiles or a
notification.

Two rules matter more than the rest:

- **An entity is not missing because the state machine has no value for it.** An integration that
  failed to load leaves its entities in the registry. Only an object in neither the state machine
  nor any registry is a candidate.
- **`entity_id` gone while `entity_id_2` exists** is the one rename inference made, because Home
  Assistant creates that suffix itself when re-registering a taken id. Nothing looser is
  attempted.

Expanding a finding gives you somewhere to go: an automation, script or scene opens its
more-info dialog, and a dashboard offers one button per affected view.

### When it rescans

The scan is hundreds of round trips, so it runs once after the page paints and is shared by
every card on the page. It repeats when — and only when — something it read has changed:

| Change | How it is noticed |
|---|---|
| an automation, script or scene added or deleted | the scan signature is the set of those entity ids |
| a dashboard saved | `lovelace_updated` on the event bus |
| an automation saved or reloaded | `automation_reloaded` on the event bus |
| a scene reloaded | `scene_reloaded` on the event bus |
| an entity renamed, deleted, disabled or re-enabled | `entity_registry_updated` — answered by re-judging the configuration already in hand against a fresh registry, one round trip rather than hundreds |
| an action registered or withdrawn | `service_registered` / `service_removed` |
| the backend republished a scan | the scan entity's own timestamp |
| anything else | the **Rescan** button, or `button.config_health_rescan` |

None of it polls. The backend adds a five-minute runtime pass that re-evaluates state against
the dependency index it already holds — no file reading — and a nightly scan at 04:17.

## Layout

```
HOUSE HEALTH           one verdict line: devices, then configuration
DEVICE STATUS          Offline | Unknown | Degraded | Online | Battery
CONFIGURATION HEALTH   Automations | Scripts | Scenes | Dashboards | Other + Rescan
PROBABLE SHARED CAUSE  integration-wide failures and whole-install events
NEEDS ATTENTION        filter chips + one expandable card per problem device
BROKEN CONFIGURATION   filter chips + one expandable card per broken config item
LOW BATTERY            devices at or under the threshold
INTEGRATIONS           every integration with a device, problems highlighted
RECENTLY RECOVERED     devices that came back
RECENTLY DELETED       devices removed from the registry
SKIPPED DEVICES        devices you have told the card to leave alone
ENTITY-ONLY PROBLEMS   device-less helpers and templates, grouped by integration
```

Sections with nothing in them are not rendered, so a healthy install collapses to the summaries,
two green "all good" lines and the integration grid.

<p align="center">
  <img src="screenshots/health-view-narrow.png" width="374" alt="The same card on a phone">
</p>

## Known limitations

- **Automations and scripts that are not loaded cannot be inspected.** Home Assistant only serves
  the configuration of an entity that exists, so an automation that failed to set up is reported
  as "failed to load" rather than having its references checked.
- **Editing an automation's contents is invisible** until it is reloaded or you press Rescan —
  nothing in the frontend's state changes when a config is rewritten in place.
- **A template sitting in a reference slot is not resolved.** `entity_id: "{{ states('sensor.x')
  }}"` is reported as unresolvable rather than having `sensor.x` checked. A template in any
  other position *is* read for the references it names.
- **Adding or removing a Lovelace resource needs a browser reload**, which is Home Assistant's
  constraint rather than this card's: a custom element cannot be un-defined in a running page.
- **Recovery tracking has no backend.** The recovered and deleted lists are a diff against a
  snapshot in `localStorage`, so only transitions a browser actually observed are caught. A
  wall tablet that is always on catches nearly all of them; a laptop that is opened once a day
  catches few.
- **Dynamic references are never validated.** `states('sensor.' ~ variable)` is reported as
  unresolvable, and no attempt is made to guess.
- **Deleting an area, floor, label or device does not invalidate the page by itself.** Only the
  entity registry is watched; the rest is picked up by the next scan.
- **The health entities need MQTT.** Without a broker the card, the panel, the report and the
  notifications all still work; only the health entities and the Rescan button are absent.
- **Add-on, Repairs and Supervisor findings need the Supervisor.** On a Home Assistant Core or
  container install those checks are silently skipped rather than reported as failures.
- **Unstable-device history needs the recorder.** With recorder disabled or a very short
  retention, the 24-hour availability measurement has nothing to read and the section stays
  empty.

## Licence

MIT
