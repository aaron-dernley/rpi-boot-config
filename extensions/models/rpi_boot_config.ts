/**
 * Raspberry Pi boot configuration drift detection: EEPROM bootloader
 * settings (`rpi-eeprom-config`), `/boot/firmware/config.txt`, and
 * `/boot/firmware/cmdline.txt`, each captured verbatim plus parsed. All
 * three sources are world-readable on this hardware — no root, no sudoers
 * entry. Read-only: this model never writes config.txt, cmdline.txt, or the
 * EEPROM. The point is the diff — every write is versioned by swamp, so
 * comparing a snapshot from before and after the NVMe migration (or any
 * `raspi-config`/manual edit) is free as long as the raw text is stored
 * verbatim alongside the parsed view. See `@aaronge/rpi-health` for
 * firmware *version* status (EEPROM current-vs-latest) — that's a
 * different concern from the bootloader *settings* this model reads.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Minimal logger shape methods depend on — matches `context.logger`. */
export interface MinimalLogger {
  /** Log a user-visible progress or state-transition message. */
  info(msg: string, props?: Record<string, unknown>): void;
  /** Log a recoverable issue or degraded-behavior message. */
  warn(msg: string, props?: Record<string, unknown>): void;
}

/**
 * Read a text file via `cat` rather than `Deno.readTextFile`. `/proc` files
 * (like `/proc/device-tree/model`) report a `stat()` size of 0 and trip
 * Deno's permission checker into demanding the literal `--allow-all` flag —
 * no scoped `--allow-read` satisfies it, even though the file is
 * world-readable either way. Same workaround `@aaronge/host-health` and
 * `@aaronge/rpi-health` use; applied here uniformly to all three sources
 * even though config.txt/cmdline.txt live under `/boot`, not `/proc`, so
 * one code path covers all of them.
 */
async function catFile(path: string): Promise<string> {
  const cmd = new Deno.Command("cat", {
    args: [path],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    throw new Error(
      `cat ${path} failed: ${new TextDecoder().decode(output.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(output.stdout);
}

/** Result of the hardware guard every method runs before doing real work. */
export interface PiHardwareInfo {
  /** `/proc/device-tree/model`, NUL byte stripped. */
  model: string;
}

/**
 * Hardware guard every method calls before writing any resource. Refuses to
 * run on non-Pi hardware. Unlike `@aaronge/rpi-health`, nothing here is
 * Pi-5-specific — EEPROM bootloader config, config.txt, and cmdline.txt all
 * apply the same way back to the Pi 4 — so this only checks for "some
 * Raspberry Pi", not a specific model.
 */
export async function assertRaspberryPiHardware(): Promise<PiHardwareInfo> {
  let rawModel: string;
  try {
    rawModel = await catFile("/proc/device-tree/model");
  } catch (error) {
    throw new Error(
      `This model requires Raspberry Pi hardware: /proc/device-tree/model ` +
        `is missing or unreadable (${
          error instanceof Error ? error.message : String(error)
        }).`,
    );
  }
  // The kernel reports this value NUL-terminated, not newline-terminated.
  const model = rawModel.replace(/\0+$/, "").trim();
  if (!model.includes("Raspberry Pi")) {
    throw new Error(
      `This model requires Raspberry Pi hardware: /proc/device-tree/model ` +
        `reports "${model}", which does not contain "Raspberry Pi".`,
    );
  }
  return { model };
}

// --- BOOT_ORDER decoding ---------------------------------------------------

/**
 * Boot device codes per the Raspberry Pi bootloader's own BOOT_ORDER
 * documentation. New firmware revisions occasionally add codes; an unknown
 * digit decodes to `UNKNOWN_0x<digit>` rather than throwing — see the
 * "parse defensively" design principle this whole family follows.
 */
const BOOT_ORDER_DEVICE_NAMES: Record<string, string> = {
  "0": "NONE",
  "1": "SD_CARD_BOOT",
  "2": "NETWORK_BOOT",
  "3": "RPIBOOT_BOOT",
  "4": "USB_MSD_BOOT",
  "5": "BCM_USB_MSD_BOOT",
  "6": "NVME_BOOT",
  "7": "HTTP_BOOT",
  "f": "RESTART",
};

/**
 * Decode a BOOT_ORDER hex string (e.g. "0xf461") into an ordered list of
 * boot device names. The bootloader reads BOOT_ORDER digits right-to-left —
 * the rightmost hex digit is tried first — so "0xf461" tries SD card, then
 * NVMe, then USB-MSD, then restarts and retries the whole list. Unknown
 * digits become `UNKNOWN_0x<digit>` instead of throwing.
 */
export function decodeBootOrder(hex: string): string[] {
  const digits = hex.trim().toLowerCase().replace(/^0x/, "");
  if (digits.length === 0 || !/^[0-9a-f]+$/.test(digits)) {
    throw new Error(`Unexpected BOOT_ORDER value: "${hex}"`);
  }
  return digits.split("").reverse().map((d) =>
    BOOT_ORDER_DEVICE_NAMES[d] ?? `UNKNOWN_0x${d}`
  );
}

/** Parse a "0"/"1" flag string into a boolean, or null for anything else. */
export function parseBoolFlag(
  value: string | undefined,
  fieldName: string,
  logger?: MinimalLogger,
): boolean | null {
  if (value === undefined) return null;
  if (value === "1") return true;
  if (value === "0") return false;
  logger?.warn(
    `Unexpected boolean value for {fieldName}: "{value}" (expected "0" or "1"); leaving null`,
    { fieldName, value },
  );
  return null;
}

// --- rpi-eeprom-config parsing ---------------------------------------------

/** One `key=value` line from `rpi-eeprom-config` output, with its `[section]`. */
export interface EepromConfigEntry {
  /** The `[section]` header this line falls under, e.g. "all", "pi5". */
  section: string;
  key: string;
  value: string;
}

/** Parsed `rpi-eeprom-config` output. */
export interface EepromConfigParsed {
  entries: EepromConfigEntry[];
  sections: string[];
}

/**
 * Parse `rpi-eeprom-config` output — the same `[section]` / `key=value` INI
 * shape as config.txt. Every real Pi 5 output observed so far opens with an
 * implicit or explicit `[all]` section; a `key=value` line before any
 * `[section]` header is filed under section "" defensively rather than
 * assumed to mean "all".
 */
export function parseEepromConfig(raw: string): EepromConfigParsed {
  const entries: EepromConfigEntry[] = [];
  const sections: string[] = [];
  let currentSection = "";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const sectionMatch = /^\[(.+)\]$/.exec(trimmed);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!sections.includes(currentSection)) sections.push(currentSection);
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    entries.push({
      section: currentSection,
      key: trimmed.slice(0, eq).trim(),
      value: trimmed.slice(eq + 1).trim(),
    });
  }
  return { entries, sections };
}

/** Look up the last value for `key` across all sections (later lines win, matching file order). */
function lastValue(
  entries: EepromConfigEntry[],
  key: string,
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].key === key) return entries[i].value;
  }
  return undefined;
}

// --- config.txt parsing -----------------------------------------------------

/** One `key=value` line from config.txt, with its `[section]` (null before any header). */
export interface ConfigTxtEntry {
  /** The `[section]` header this line falls under (e.g. "pi5", "all", "cm4"), or null if before any header. */
  section: string | null;
  key: string;
  /** null for a bare flag with no "=" (rare, but config.txt allows it). */
  value: string | null;
}

/** Parsed config.txt. */
export interface ConfigTxtParsed {
  entries: ConfigTxtEntry[];
  /** Unique section names encountered, in file order. Does not include the implicit null (pre-header) section. */
  sections: string[];
}

/**
 * Parse config.txt: `[section]` headers, `key=value` and bare-`key` lines,
 * `#`-comments and blank lines skipped. Sections are significant — the same
 * key can legitimately appear under multiple sections (e.g. different
 * `dtoverlay=` per `[cm4]`/`[cm5]`) — so entries are kept as a flat ordered
 * list rather than collapsed into one map.
 */
export function parseConfigTxt(raw: string): ConfigTxtParsed {
  const entries: ConfigTxtEntry[] = [];
  const sections: string[] = [];
  let currentSection: string | null = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const sectionMatch = /^\[(.+)\]$/.exec(trimmed);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!sections.includes(currentSection)) sections.push(currentSection);
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      entries.push({ section: currentSection, key: trimmed, value: null });
      continue;
    }
    entries.push({
      section: currentSection,
      key: trimmed.slice(0, eq).trim(),
      value: trimmed.slice(eq + 1).trim(),
    });
  }
  return { entries, sections };
}

// --- cmdline.txt parsing -----------------------------------------------------

/** One whitespace-separated token from cmdline.txt. */
export interface CmdlineParam {
  key: string;
  /** null for a bare flag with no "=" (e.g. "rootwait", "quiet"). */
  value: string | null;
}

/** Parsed cmdline.txt. */
export interface CmdlineParsed {
  params: CmdlineParam[];
  /** Value of the last "root" token found, or null if absent. This is the parameter that changes during the NVMe migration. */
  rootParam: string | null;
}

/**
 * Parse cmdline.txt: a single line of whitespace-separated tokens, each
 * either `key=value` or a bare flag. Duplicate keys are preserved in order
 * (cmdline.txt legitimately repeats "console=" for multiple consoles) —
 * only `rootParam` is hoisted, taking the last "root" occurrence to match
 * kernel parsing behavior for a duplicated single-value parameter.
 */
export function parseCmdline(raw: string): CmdlineParsed {
  const tokens = raw.trim().split(/\s+/).filter((t) => t.length > 0);
  const params: CmdlineParam[] = tokens.map((token) => {
    const eq = token.indexOf("=");
    if (eq === -1) return { key: token, value: null };
    return { key: token.slice(0, eq), value: token.slice(eq + 1) };
  });
  let rootParam: string | null = null;
  for (const p of params) {
    if (p.key === "root" && p.value !== null) rootParam = p.value;
  }
  return { params, rootParam };
}

// --- Schemas -----------------------------------------------------------------

const GlobalArgsSchema = z.object({
  bootFilesBasePath: z.string().default("/boot/firmware").describe(
    "Directory containing config.txt and cmdline.txt. Override for older " +
      "Raspberry Pi OS layouts that use /boot instead of /boot/firmware.",
  ),
  rpiEepromConfigPath: z.string().default("rpi-eeprom-config").describe(
    "Path to the rpi-eeprom-config binary. Override for odd installs.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const EepromConfigEntrySchema = z.object({
  section: z.string().describe(
    'The [section] header this line falls under, e.g. "all".',
  ),
  key: z.string(),
  value: z.string(),
});

const EepromSchema = z.object({
  raw: z.string().describe(
    "Verbatim rpi-eeprom-config output. Stored so a diff against a later " +
      "snapshot is meaningful even for fields this model doesn't parse out.",
  ),
  entries: z.array(EepromConfigEntrySchema).describe(
    "Every key=value line, flat and ordered, with its [section]. The same " +
      "key can appear more than once under different sections.",
  ),
  sections: z.array(z.string()).describe(
    "Unique [section] headers encountered, in file order.",
  ),
  bootOrderRaw: z.string().nullable().describe(
    'Verbatim BOOT_ORDER value, e.g. "0xf461". Null when BOOT_ORDER is not ' +
      "set (the bootloader then uses its own compiled-in default).",
  ),
  bootOrderDecoded: z.array(z.string()).nullable().describe(
    "BOOT_ORDER decoded right-to-left into an ordered list of boot device " +
      'names actually tried, e.g. ["SD_CARD_BOOT","NVME_BOOT",' +
      '"USB_MSD_BOOT","RESTART"]. Null when bootOrderRaw is null.',
  ),
  bootUart: z.boolean().nullable().describe(
    "BOOT_UART as a boolean. Null when unset in the EEPROM config.",
  ),
  powerOffOnHalt: z.boolean().nullable().describe(
    "POWER_OFF_ON_HALT as a boolean. Null when unset.",
  ),
  wakeOnGpio: z.boolean().nullable().describe(
    "WAKE_ON_GPIO as a boolean. Null when unset.",
  ),
  psuMaxCurrentMa: z.number().nullable().describe(
    "PSU_MAX_CURRENT in milliamps, directly relevant to the NVMe SSD's " +
      "power budget on the ~5W PCIe slot. Null when unset (no limit " +
      "configured, not a measured zero draw).",
  ),
  capturedAt: z.string().describe(
    "ISO-8601 timestamp when this snapshot was captured.",
  ),
});

const ConfigTxtEntrySchema = z.object({
  section: z.string().nullable().describe(
    "The [section] header this line falls under, or null if it appears " +
      "before any header.",
  ),
  key: z.string(),
  value: z.string().nullable().describe('null for a bare flag with no "=".'),
});

const ConfigTxtSchema = z.object({
  raw: z.string().describe(
    "Verbatim config.txt contents, comments and blank lines included. " +
      "Stored so a before/after diff around the NVMe migration is meaningful.",
  ),
  entries: z.array(ConfigTxtEntrySchema).describe(
    "Every key[=value] line, flat and ordered, with its [section]. Kept " +
      "flat (not collapsed into a map) because the same key legitimately " +
      "repeats under different sections, e.g. per-board dtoverlay lines.",
  ),
  sections: z.array(z.string()).describe(
    "Unique [section] headers encountered, in file order.",
  ),
  capturedAt: z.string().describe(
    "ISO-8601 timestamp when this snapshot was captured.",
  ),
});

const CmdlineParamSchema = z.object({
  key: z.string(),
  value: z.string().nullable().describe(
    'null for a bare flag with no "=", e.g. "rootwait".',
  ),
});

const CmdlineSchema = z.object({
  raw: z.string().describe(
    "Verbatim cmdline.txt contents (single line, trailing newline trimmed).",
  ),
  params: z.array(CmdlineParamSchema).describe(
    "Every whitespace-separated token, in order, duplicates preserved " +
      '(cmdline.txt legitimately repeats "console=" for multiple consoles).',
  ),
  rootParam: z.string().nullable().describe(
    'The "root=" value, hoisted — this is the parameter that changes ' +
      "during the NVMe migration (e.g. from a PARTUUID on the SD card to " +
      "one on the NVMe SSD). Null if absent.",
  ),
  capturedAt: z.string().describe(
    "ISO-8601 timestamp when this snapshot was captured.",
  ),
});

/** Model definition for `@aaronge/rpi-boot-config` — Pi boot configuration drift detection. */
export const model = {
  type: "@aaronge/rpi-boot-config",
  version: "2026.08.26.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    eeprom: {
      description:
        "rpi-eeprom-config bootloader settings: BOOT_ORDER (decoded), " +
        "BOOT_UART, POWER_OFF_ON_HALT, WAKE_ON_GPIO, PSU_MAX_CURRENT.",
      schema: EepromSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    configTxt: {
      description:
        "/boot/firmware/config.txt, raw and parsed, sections preserved.",
      schema: ConfigTxtSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    cmdline: {
      description: "/boot/firmware/cmdline.txt, raw and parsed, root= hoisted.",
      schema: CmdlineSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    readEeprom: {
      description: "Run rpi-eeprom-config, parse BOOT_ORDER/BOOT_UART/" +
        "POWER_OFF_ON_HALT/WAKE_ON_GPIO/PSU_MAX_CURRENT, and write the " +
        "eeprom resource.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: MinimalLogger;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        await assertRaspberryPiHardware();
        const capturedAt = new Date().toISOString();
        const eepromConfigPath = context.globalArgs.rpiEepromConfigPath;

        context.logger.info(
          "Reading bootloader settings via rpi-eeprom-config",
        );
        let raw: string;
        try {
          const cmd = new Deno.Command(eepromConfigPath, {
            args: [],
            stdout: "piped",
            stderr: "piped",
          });
          const output = await cmd.output();
          const stdout = new TextDecoder().decode(output.stdout);
          if (!output.success) {
            if (stdout.trim().length === 0) {
              throw new Error(
                `rpi-eeprom-config failed: ${
                  new TextDecoder().decode(output.stderr).trim()
                }`,
              );
            }
            context.logger.warn(
              "rpi-eeprom-config exited non-zero but produced output; " +
                "parsing it anyway rather than discarding a usable read",
            );
          }
          raw = stdout;
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            throw new Error(
              `rpi-eeprom-config not found on PATH (looked for ` +
                `"${eepromConfigPath}"). It ships in rpi-eeprom. Set the ` +
                `rpiEepromConfigPath global argument if it lives somewhere ` +
                `nonstandard.`,
            );
          }
          throw error;
        }

        const { entries, sections } = parseEepromConfig(raw);
        const bootOrderRaw = lastValue(entries, "BOOT_ORDER") ?? null;
        let bootOrderDecoded: string[] | null = null;
        if (bootOrderRaw !== null) {
          try {
            bootOrderDecoded = decodeBootOrder(bootOrderRaw);
          } catch (error) {
            context.logger.warn(
              "Could not decode BOOT_ORDER {bootOrderRaw}: {message}; " +
                "leaving bootOrderDecoded null rather than guessing",
              {
                bootOrderRaw,
                message: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
        const bootUart = parseBoolFlag(
          lastValue(entries, "BOOT_UART"),
          "BOOT_UART",
          context.logger,
        );
        const powerOffOnHalt = parseBoolFlag(
          lastValue(entries, "POWER_OFF_ON_HALT"),
          "POWER_OFF_ON_HALT",
          context.logger,
        );
        const wakeOnGpio = parseBoolFlag(
          lastValue(entries, "WAKE_ON_GPIO"),
          "WAKE_ON_GPIO",
          context.logger,
        );
        const psuMaxCurrentRaw = lastValue(entries, "PSU_MAX_CURRENT");
        let psuMaxCurrentMa: number | null = null;
        if (psuMaxCurrentRaw !== undefined) {
          const parsed = Number(psuMaxCurrentRaw);
          if (Number.isFinite(parsed)) {
            psuMaxCurrentMa = parsed;
          } else {
            context.logger.warn(
              "Could not parse PSU_MAX_CURRENT as a number: {value}; leaving null",
              { value: psuMaxCurrentRaw },
            );
          }
        }

        context.logger.info(
          "Captured eeprom config: bootOrderRaw={bootOrderRaw} psuMaxCurrentMa={psuMaxCurrentMa}",
          { bootOrderRaw, psuMaxCurrentMa },
        );

        const handle = await context.writeResource("eeprom", "eeprom", {
          raw,
          entries,
          sections,
          bootOrderRaw,
          bootOrderDecoded,
          bootUart,
          powerOffOnHalt,
          wakeOnGpio,
          psuMaxCurrentMa,
          capturedAt,
        });
        return { dataHandles: [handle] };
      },
    },
    readConfigTxt: {
      description:
        "Read config.txt verbatim, parse [section]/key=value structure, " +
        "and write the configTxt resource.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: MinimalLogger;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        await assertRaspberryPiHardware();
        const capturedAt = new Date().toISOString();
        const path = `${context.globalArgs.bootFilesBasePath}/config.txt`;

        context.logger.info("Reading {path}", { path });
        const raw = await catFile(path);
        const { entries, sections } = parseConfigTxt(raw);

        context.logger.info(
          "Captured config.txt: {entryCount} entries across sections {sections}",
          { entryCount: entries.length, sections: sections.join(", ") },
        );

        const handle = await context.writeResource("configTxt", "configTxt", {
          raw,
          entries,
          sections,
          capturedAt,
        });
        return { dataHandles: [handle] };
      },
    },
    readCmdline: {
      description:
        "Read cmdline.txt verbatim, parse whitespace-separated params, " +
        "hoist root=, and write the cmdline resource.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: MinimalLogger;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        await assertRaspberryPiHardware();
        const capturedAt = new Date().toISOString();
        const path = `${context.globalArgs.bootFilesBasePath}/cmdline.txt`;

        context.logger.info("Reading {path}", { path });
        const raw = await catFile(path);
        const { params, rootParam } = parseCmdline(raw);

        context.logger.info("Captured cmdline.txt: rootParam={rootParam}", {
          rootParam,
        });

        const handle = await context.writeResource("cmdline", "cmdline", {
          raw: raw.trimEnd(),
          params,
          rootParam,
          capturedAt,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
