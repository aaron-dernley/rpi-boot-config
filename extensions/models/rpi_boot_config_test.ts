// Run with `deno test -A`. -A is needed because assertRaspberryPiHardware and
// catFile shell out to `cat` for /proc and /boot/firmware reads — see
// rpi_health_test.ts / host_health_test.ts for why Deno's permission checker
// requires it even for world-readable files.
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20260824.32";
import {
  assertRaspberryPiHardware,
  decodeBootOrder,
  model,
  parseBoolFlag,
  parseCmdline,
  parseConfigTxt,
  parseEepromConfig,
} from "./rpi_boot_config.ts";

// createModelTestContext() returns a MethodContext typed with a default
// Record<string, unknown> globalArgs — narrower than each execute()'s own
// inline context type. This cast bridges that gap; the contextual type at
// each call site (inferred from execute()'s own parameter type) fills in T.
function asContext<T>(context: unknown): T {
  return context as T;
}

const DEFAULT_GLOBAL_ARGS = {
  bootFilesBasePath: "/boot/firmware",
  rpiEepromConfigPath: "rpi-eeprom-config",
};

// --- decodeBootOrder ------------------------------------------------------

Deno.test("decodeBootOrder reads right-to-left: 0xf461 tries SD, NVMe, USB-MSD, then restarts", () => {
  assertEquals(decodeBootOrder("0xf461"), [
    "SD_CARD_BOOT",
    "NVME_BOOT",
    "USB_MSD_BOOT",
    "RESTART",
  ]);
});

Deno.test("decodeBootOrder handles a single digit", () => {
  assertEquals(decodeBootOrder("0x1"), ["SD_CARD_BOOT"]);
});

Deno.test("decodeBootOrder falls back to UNKNOWN_0x<digit> for an unrecognized code rather than throwing", () => {
  assertEquals(decodeBootOrder("0xa"), ["UNKNOWN_0xa"]);
});

Deno.test("decodeBootOrder works without a 0x prefix", () => {
  assertEquals(decodeBootOrder("f461"), [
    "SD_CARD_BOOT",
    "NVME_BOOT",
    "USB_MSD_BOOT",
    "RESTART",
  ]);
});

Deno.test("decodeBootOrder throws on non-hex garbage rather than silently returning an empty list", () => {
  assertThrows(
    () => decodeBootOrder("not-hex"),
    Error,
    "Unexpected BOOT_ORDER value",
  );
});

// --- parseBoolFlag ----------------------------------------------------------

Deno.test("parseBoolFlag: '1' is true, '0' is false, undefined is null", () => {
  assertEquals(parseBoolFlag("1", "TEST"), true);
  assertEquals(parseBoolFlag("0", "TEST"), false);
  assertEquals(parseBoolFlag(undefined, "TEST"), null);
});

Deno.test("parseBoolFlag: unexpected value degrades to null with a warning, not a throw", () => {
  const warnings: string[] = [];
  const result = parseBoolFlag("maybe", "TEST", {
    info: () => {},
    warn: (msg) => warnings.push(msg),
  });
  assertEquals(result, null);
  assertEquals(warnings.length, 1);
});

// --- parseEepromConfig ------------------------------------------------------

// Captured live from `rpi-eeprom-config` on this Pi 5, unprivileged.
const REAL_EEPROM_CONFIG_OUTPUT = `[all]
BOOT_UART=1
BOOT_ORDER=0xf461
NET_INSTALL_AT_POWER_ON=1
`;

Deno.test("parseEepromConfig parses [all] section key=value lines", () => {
  const { entries, sections } = parseEepromConfig(REAL_EEPROM_CONFIG_OUTPUT);
  assertEquals(sections, ["all"]);
  assertEquals(entries, [
    { section: "all", key: "BOOT_UART", value: "1" },
    { section: "all", key: "BOOT_ORDER", value: "0xf461" },
    { section: "all", key: "NET_INSTALL_AT_POWER_ON", value: "1" },
  ]);
});

Deno.test('parseEepromConfig files pre-header lines under section "" rather than assuming [all]', () => {
  const { entries, sections } = parseEepromConfig(
    "BOOT_UART=1\n[pi5]\nBOOT_ORDER=0x6\n",
  );
  assertEquals(sections, ["pi5"]);
  assertEquals(entries[0], { section: "", key: "BOOT_UART", value: "1" });
  assertEquals(entries[1], { section: "pi5", key: "BOOT_ORDER", value: "0x6" });
});

Deno.test("parseEepromConfig skips comments and blank lines", () => {
  const { entries } = parseEepromConfig(
    "# a comment\n\n[all]\n\nBOOT_UART=1\n",
  );
  assertEquals(entries, [{ section: "all", key: "BOOT_UART", value: "1" }]);
});

Deno.test("parseEepromConfig keeps duplicate keys across sections rather than collapsing to a map", () => {
  const { entries } = parseEepromConfig(
    "[all]\nBOOT_ORDER=0x1\n[pi5]\nBOOT_ORDER=0x61\n",
  );
  assertEquals(entries.filter((e) => e.key === "BOOT_ORDER").length, 2);
});

// --- parseConfigTxt ----------------------------------------------------------

const REAL_CONFIG_TXT_EXCERPT = `# comment
dtparam=audio=on
camera_auto_detect=1

[cm4]
otg_mode=1

[cm5]
dtoverlay=dwc2,dr_mode=host

[all]
`;

Deno.test("parseConfigTxt files pre-header entries with section=null", () => {
  const { entries } = parseConfigTxt(REAL_CONFIG_TXT_EXCERPT);
  assertEquals(entries[0], {
    section: null,
    key: "dtparam",
    value: "audio=on",
  });
  assertEquals(entries[1], {
    section: null,
    key: "camera_auto_detect",
    value: "1",
  });
});

Deno.test("parseConfigTxt tracks [cm4]/[cm5]/[all] sections in file order", () => {
  const { sections } = parseConfigTxt(REAL_CONFIG_TXT_EXCERPT);
  assertEquals(sections, ["cm4", "cm5", "all"]);
});

Deno.test("parseConfigTxt assigns entries to the most recently seen section", () => {
  const { entries } = parseConfigTxt(REAL_CONFIG_TXT_EXCERPT);
  const otgMode = entries.find((e) => e.key === "otg_mode");
  assertEquals(otgMode?.section, "cm4");
  const dwc2 = entries.find((e) => e.key === "dtoverlay");
  assertEquals(dwc2?.section, "cm5");
  assertEquals(dwc2?.value, "dwc2,dr_mode=host");
});

Deno.test("parseConfigTxt treats a bare key with no '=' as value=null", () => {
  const { entries } = parseConfigTxt("start_x\n");
  assertEquals(entries, [{ section: null, key: "start_x", value: null }]);
});

Deno.test("parseConfigTxt handles an [all] section with no following entries (trailing header)", () => {
  const { entries, sections } = parseConfigTxt("[all]\n");
  assertEquals(sections, ["all"]);
  assertEquals(entries, []);
});

// --- parseCmdline -------------------------------------------------------------

// Captured live from /boot/firmware/cmdline.txt on this Pi 5.
const REAL_CMDLINE =
  "console=serial0,115200 console=tty1 root=PARTUUID=98ad41b8-02 rootfstype=ext4 fsck.repair=yes rootwait quiet splash plymouth.ignore-serial-consoles cfg80211.ieee80211_regdom=GB\n";

Deno.test("parseCmdline hoists rootParam from the root= token", () => {
  const { rootParam } = parseCmdline(REAL_CMDLINE);
  assertEquals(rootParam, "PARTUUID=98ad41b8-02");
});

Deno.test("parseCmdline preserves duplicate console= tokens rather than collapsing them", () => {
  const { params } = parseCmdline(REAL_CMDLINE);
  const consoleParams = params.filter((p) => p.key === "console");
  assertEquals(consoleParams.length, 2);
  assertEquals(consoleParams[0].value, "serial0,115200");
  assertEquals(consoleParams[1].value, "tty1");
});

Deno.test("parseCmdline treats a bare flag like rootwait as value=null", () => {
  const { params } = parseCmdline(REAL_CMDLINE);
  const rootwait = params.find((p) => p.key === "rootwait");
  assertEquals(rootwait?.value, null);
});

Deno.test("parseCmdline returns rootParam=null when no root= token is present", () => {
  const { rootParam } = parseCmdline("console=tty1 quiet\n");
  assertEquals(rootParam, null);
});

Deno.test("parseCmdline takes the last root= occurrence when duplicated", () => {
  const { rootParam } = parseCmdline("root=/dev/sda1 root=/dev/nvme0n1p2\n");
  assertEquals(rootParam, "/dev/nvme0n1p2");
});

// --- Method-level tests against real files on this Pi ------------------------
//
// This model refuses to run at all off Pi hardware, so — like
// @aaronge/rpi-health's and @aaronge/host-health's method-level tests —
// these exercise the real rpi-eeprom-config/config.txt/cmdline.txt on
// whatever host runs the suite, and assert invariants rather than exact
// values (except rootParam, which is asserted against the actual value
// this repo observed on the target machine's SD card boot).

Deno.test("readEeprom writes an eeprom resource from real rpi-eeprom-config output", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "readEeprom",
  });

  await model.methods.readEeprom.execute({}, asContext(context));

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "eeprom");
  const data = written[0].data as {
    raw: string;
    bootOrderRaw: string | null;
    bootOrderDecoded: string[] | null;
    capturedAt: string;
  };
  assert(data.raw.length > 0);
  assert(typeof data.capturedAt === "string");
  if (data.bootOrderRaw !== null) {
    assert(
      data.bootOrderDecoded !== null,
      "bootOrderDecoded should be set whenever bootOrderRaw is",
    );
    assert(data.bootOrderDecoded!.length > 0);
  }
});

Deno.test("readEeprom throws a clean error when rpi-eeprom-config exits non-zero with no output", async () => {
  const { context } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "readEeprom",
  });

  await assertRejects(
    () =>
      withMockedCommand((command) => {
        if (command === "cat") {
          return { stdout: "Raspberry Pi 5 Model B Rev 1.1\0", code: 0 };
        }
        return { stdout: "", stderr: "permission denied", code: 1 };
      }, () => model.methods.readEeprom.execute({}, asContext(context))).then((
        r,
      ) => r.result),
    Error,
    "rpi-eeprom-config failed",
  );
});

Deno.test("readEeprom warns and parses anyway when rpi-eeprom-config exits non-zero but still produced output", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "readEeprom",
  });

  const { result } = await withMockedCommand((command) => {
    if (command === "cat") {
      return { stdout: "Raspberry Pi 5 Model B Rev 1.1\0", code: 0 };
    }
    return { stdout: "[all]\nBOOT_ORDER=0xf461\n", stderr: "oddity", code: 1 };
  }, () => model.methods.readEeprom.execute({}, asContext(context)));

  assert(result.dataHandles.length === 1);
  const data = getWrittenResources()[0].data as { bootOrderRaw: string | null };
  assertEquals(data.bootOrderRaw, "0xf461");
});

Deno.test("readEeprom surfaces a clean not-found error when rpi-eeprom-config is not on PATH", async () => {
  const { context } = createModelTestContext({
    globalArgs: {
      ...DEFAULT_GLOBAL_ARGS,
      rpiEepromConfigPath: "/nonexistent/rpi-eeprom-config",
    },
    methodName: "readEeprom",
  });

  await assertRejects(
    () => model.methods.readEeprom.execute({}, asContext(context)),
    Error,
    "not found on PATH",
  );
});

Deno.test("readConfigTxt writes a configTxt resource with the raw file content preserved verbatim", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "readConfigTxt",
  });

  await model.methods.readConfigTxt.execute({}, asContext(context));

  const data = getWrittenResources()[0].data as {
    raw: string;
    entries: Array<{ key: string }>;
    sections: string[];
  };
  assert(data.raw.length > 0);
  assert(data.entries.length > 0);
  assert(Array.isArray(data.sections));
});

Deno.test("readCmdline writes a cmdline resource with rootParam matching the machine's current root device", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "readCmdline",
  });

  await model.methods.readCmdline.execute({}, asContext(context));

  const data = getWrittenResources()[0].data as {
    raw: string;
    rootParam: string | null;
  };
  assert(data.raw.length > 0);
  // Compare against the kernel's own view of the running root rather than
  // a hardcoded PARTUUID: the original SD-card value (98ad41b8-02) went
  // stale with the NVMe migration, which is exactly the change this model
  // exists to catch.
  const running = (await Deno.readTextFile("/proc/cmdline"))
    .split(/\s+/)
    .find((t) => t.startsWith("root="))
    ?.slice("root=".length) ?? null;
  assertEquals(data.rootParam, running);
});

Deno.test("assertRaspberryPiHardware strips the trailing NUL from /proc/device-tree/model on this real Pi 5", async () => {
  const hardware = await assertRaspberryPiHardware();
  assert(!hardware.model.includes("\0"));
  assertEquals(hardware.model, hardware.model.trim());
  assert(hardware.model.includes("Raspberry Pi"));
});
