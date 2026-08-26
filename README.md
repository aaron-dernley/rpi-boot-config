# @aaronge/rpi-boot-config

Raspberry Pi boot configuration drift detection — EEPROM bootloader settings
(`rpi-eeprom-config`), `/boot/firmware/config.txt`, and
`/boot/firmware/cmdline.txt`, each captured verbatim and parsed, as a typed,
versioned Swamp model. Boot configuration is the class of setting that, when
wrong, produces a Pi that won't boot and offers no diagnostic — the point of
this model is the diff. Swamp versions every write, so comparing a snapshot
from before and after a change (a `raspi-config` edit, a manual config.txt
tweak, or the NVMe SSD migration) is free, as long as the raw text is stored
verbatim alongside the parsed view. It is.

Read-only: this model never writes config.txt, cmdline.txt, or the EEPROM.
None of its three sources need root on this hardware — `rpi-eeprom-config`,
config.txt, and cmdline.txt are all world-readable.

Contains no firmware *version* status (EEPROM current-vs-latest) — that's
`@aaronge/rpi-health`'s `readFirmware`, a different concern from the
bootloader *settings* read here. Nothing here is Pi-5-specific; all three
sources apply the same way back to the Pi 4.

## Installation

```sh
swamp extension pull @aaronge/rpi-boot-config
```

## Usage

```sh
swamp model create @aaronge/rpi-boot-config rpi-local

swamp model method run rpi-local readEeprom
swamp model method run rpi-local readConfigTxt
swamp model method run rpi-local readCmdline
```

Each method writes one resource: `eeprom`, `configTxt`, `cmdline`. Every
field is described — run `swamp model type describe @aaronge/rpi-boot-config`
to see the full schema.

Reference the latest snapshot from a workflow assert step or another model:

```yaml
expr: >-
  data.latest("rpi-local", "cmdline").attributes.rootParam != null
```

Compare against a specific prior version (e.g. before/after the NVMe
migration) with `data.version()`:

```yaml
expr: >-
  data.version("rpi-local", "cmdline", 1).attributes.rootParam
```

## Global arguments

| Arg                    | Default              | Notes                                                        |
| ----------------------- | --------------------- | ------------------------------------------------------------- |
| `bootFilesBasePath`     | `"/boot/firmware"`   | Override for older Raspberry Pi OS layouts using `/boot`.      |
| `rpiEepromConfigPath`   | `"rpi-eeprom-config"`| Override for odd installs where it isn't on PATH.               |

## How it works

- **`eeprom`** — parses `rpi-eeprom-config`'s `[section]`/`key=value`
  output (the same shape config.txt uses). `BOOT_ORDER` is decoded
  right-to-left into an ordered list of boot device names (the bootloader
  tries the *rightmost* hex digit first) — both the raw hex string and the
  decoded list are stored, since the point of this model is a diff and a
  raw-only diff is unreadable. An unrecognized boot-order digit decodes to
  `UNKNOWN_0x<digit>` rather than throwing, since new firmware occasionally
  adds codes. `PSU_MAX_CURRENT` is hoisted to `psuMaxCurrentMa` — directly
  relevant to the NVMe SSD's power budget on the Pi 5's ~5W PCIe slot.
  `BOOT_UART`/`POWER_OFF_ON_HALT`/`WAKE_ON_GPIO` are hoisted to booleans;
  any of these is `null` when unset in the EEPROM config, never a guessed
  default — null means unknown, not "off".
- **`configTxt`** — reads `config.txt` verbatim and parses `[section]`
  headers plus `key[=value]` lines. Entries are kept as a flat ordered list
  rather than collapsed into a map, because the same key legitimately
  repeats under different sections (e.g. a different `dtoverlay=` per
  `[cm4]`/`[cm5]`). A key/value pair before any `[section]` header is filed
  under `section: null`.
- **`cmdline`** — reads `cmdline.txt` verbatim and parses its
  whitespace-separated tokens, preserving duplicates (it legitimately
  repeats `console=` for multiple consoles). `rootParam` is hoisted from the
  `root=` token — this is the exact parameter the NVMe migration rewrites,
  from a PARTUUID on the SD card to one on the NVMe SSD.

Every method refuses to run on non-Pi hardware — checking
`/proc/device-tree/model` names a Raspberry Pi — before writing anything.

## Workflow

The extension ships an `rpi-boot-config` workflow: a `collect` job runs all
three methods in parallel, an `assert` job checks that decoded `BOOT_ORDER`
still contains every device named in the `expectedBootOrderDevices` input
(defaulting to this machine's pre-migration order, `SD_CARD_BOOT` →
`NVME_BOOT` → `USB_MSD_BOOT` → `RESTART`) and that `cmdline.txt` still has a
`root=` parameter, and a `report` job prints a one-screen summary regardless
of whether the assert job passed. Update `expectedBootOrderDevices` once the
NVMe migration reorders `BOOT_ORDER` to put `NVME_BOOT` first.

Boot configuration changes rarely, so this runs once a day
(`17 6 * * *`) via `trigger.schedule`, not every 5 minutes like the
telemetry-focused `@aaronge/host-health`/`@aaronge/rpi-health` workflows.

It intentionally does *not* check EEPROM firmware current-vs-latest (that's
`@aaronge/rpi-health`'s `readFirmware`) or that `cmdline.txt`'s `root=`
matches the filesystem `@aaronge/host-health` sees mounted at `/` — both are
cross-model checks that belong in a future `pre-migration-snapshot`
workflow, not duplicated into this extension's own.

## License

MIT — see LICENSE for details.
