import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import {
  isLastStep,
  LOCAL_STEPS,
  nextStep,
  previousStep,
  setupSteps,
  stepNumber,
} from "./steps.ts";

const desktop = setupSteps(true);
const browser = setupSteps(false);

test("steps: the desktop wizard opens on the connection screen", () => {
  assertEquals(desktop[0], "server");
  // The local walk follows it unchanged: the gate is the only difference.
  assertEquals(desktop.slice(1), [...LOCAL_STEPS]);
});

test("steps: a browser page has no connection screen", () => {
  // No bridge: moving to another server there is the address bar's job, so
  // the wizard walks the local steps only.
  assertEquals(browser, LOCAL_STEPS);
  assertEquals(browser.includes("server"), false);
});

test("steps: next moves one screen forward, and stops at the last", () => {
  // The footer's one forward button reads this: `null` is where it finishes
  // the wizard instead of moving on.
  assertEquals(nextStep(desktop, "server"), "welcome");
  assertEquals(nextStep(desktop, "welcome"), "provider");
  assertEquals(nextStep(desktop, "provider"), "model");
  assertEquals(nextStep(desktop, "model"), "done");
  assertEquals(nextStep(desktop, "done"), null);
});

test("steps: back stops at the first screen, and reaches the gate", () => {
  assertEquals(previousStep(browser, "welcome"), null);
  assertEquals(previousStep(desktop, "welcome"), "server");
  assertEquals(previousStep(desktop, "server"), null);
  assertEquals(previousStep(desktop, "provider"), "welcome");
  assertEquals(previousStep(desktop, "model"), "provider");
  assertEquals(previousStep(desktop, "done"), "model");
});

test("steps: the last screen is the one that finishes the wizard", () => {
  assertEquals(LOCAL_STEPS.filter(isLastStep), ["done"]);
});

test("steps: the progress line counts the local walk only", () => {
  // The connection screen is a gate, not step 1 of 5: a reader who connects
  // to another server never sees the four, and a count that promised them
  // would misdescribe both paths.
  assertEquals(stepNumber("server"), null);
  assertEquals(LOCAL_STEPS.map(stepNumber), [1, 2, 3, 4]);
});
