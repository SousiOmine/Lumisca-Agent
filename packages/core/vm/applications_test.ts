/**
 * Reading the machine's freedesktop entries: the list `vm_launch` offers.
 *
 * The point of reading the same files a desktop menu reads is that
 * "installed" means one thing in both places. These pin the two ways that
 * could stop being true: an entry a desktop hides being offered anyway, and
 * an entry whose command line cannot be run from a shell.
 */
import { assertEquals } from "@std/assert";
import {
  applicationFromDesktopFile,
  describeApplications,
  sortApplications,
} from "./applications.ts";

const CHROMIUM = `[Desktop Entry]
Name=Chromium
GenericName=Web Browser
Comment=Access the internet
Exec=chromium %U
Terminal=false
Type=Application
Categories=Network;WebBrowser;
`;

Deno.test("a desktop entry becomes a launchable program", () => {
  const app = applicationFromDesktopFile("chromium.desktop", CHROMIUM);
  assertEquals(app?.id, "chromium");
  assertEquals(app?.name, "Chromium");
  assertEquals(app?.comment, "Access the internet");
  // The field code stands for a URL a desktop hands over; from a shell there
  // is nothing to hand over, so it must not reach the command line.
  assertEquals(app?.exec, "chromium");
});

Deno.test("an entry a desktop hides is not offered", () => {
  // Offering it would put a program in the list that a person at this
  // machine cannot see either.
  const hidden = CHROMIUM.replace("Type=Application", "NoDisplay=true");
  assertEquals(applicationFromDesktopFile("x.desktop", hidden), undefined);
  const reallyHidden = CHROMIUM.replace(
    "Type=Application",
    "Hidden=true",
  );
  assertEquals(
    applicationFromDesktopFile("x.desktop", reallyHidden),
    undefined,
  );
});

Deno.test("an entry that is not an application is not offered", () => {
  // A Link entry is a shortcut for a file manager this machine has not got.
  const link = CHROMIUM.replace("Type=Application", "Type=Link");
  assertEquals(applicationFromDesktopFile("x.desktop", link), undefined);
});

Deno.test("an entry without a name or a command is not offered", () => {
  const noName = CHROMIUM.replace("Name=Chromium\n", "");
  assertEquals(applicationFromDesktopFile("x.desktop", noName), undefined);
  const noExec = CHROMIUM.replace("Exec=chromium %U\n", "");
  assertEquals(applicationFromDesktopFile("x.desktop", noExec), undefined);
  // A command that is only field codes leaves nothing to run.
  const onlyCodes = CHROMIUM.replace("Exec=chromium %U", "Exec=%i %U");
  assertEquals(applicationFromDesktopFile("x.desktop", onlyCodes), undefined);
});

Deno.test("the icon field code takes its flag with it", () => {
  // `%i` expands to `--icon <name>`; removing the code alone would leave
  // `--icon` with no argument, and the program would refuse to start.
  const app = applicationFromDesktopFile(
    "x.desktop",
    CHROMIUM.replace("Exec=chromium %U", "Exec=chromium %i %U"),
  );
  assertEquals(app?.exec, "chromium");
});

Deno.test("a file that is not a desktop entry is skipped", () => {
  assertEquals(applicationFromDesktopFile("readme.txt", CHROMIUM), undefined);
  assertEquals(applicationFromDesktopFile("x.desktop", ""), undefined);
  assertEquals(
    applicationFromDesktopFile("x.desktop", "[Other]\nName=x\nExec=y\n"),
    undefined,
  );
});

Deno.test("the list reads the way a menu does, and says what it found", () => {
  const apps = [
    { id: "z", name: "zoom", exec: "zoom" },
    { id: "a", name: "Audacity", exec: "audacity" },
    { id: "b", name: "blender", exec: "blender" },
  ];
  // By the name a person reads, case-insensitively.
  assertEquals(
    sortApplications(apps).map((app) => app.name),
    ["Audacity", "blender", "zoom"],
  );
  const text = describeApplications(sortApplications(apps));
  assertEquals(text.includes("3 program(s)"), true, text);
  assertEquals(text.includes("`a`"), true, text);
  // An empty machine says so rather than returning a bare "0 program(s)".
  assertEquals(
    describeApplications([]).includes("No programs"),
    true,
  );
});
