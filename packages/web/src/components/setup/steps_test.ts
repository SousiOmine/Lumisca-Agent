import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import {
  isLastStep,
  nextStep,
  previousStep,
  SETUP_STEPS,
  stepNumber,
} from "./steps.ts";

test("steps: the wizard starts at the welcome step", () => {
  assertEquals(SETUP_STEPS[0], "welcome");
});

test("steps: next moves one step forward, and stops at the last", () => {
  // The footer's one forward button reads this: `null` is where it finishes
  // the wizard instead of moving on.
  assertEquals(nextStep("welcome"), "provider");
  assertEquals(nextStep("provider"), "model");
  assertEquals(nextStep("model"), "done");
  assertEquals(nextStep("done"), null);
});

test("steps: back stops at the first", () => {
  assertEquals(previousStep("welcome"), null);
  assertEquals(previousStep("provider"), "welcome");
  assertEquals(previousStep("model"), "provider");
  assertEquals(previousStep("done"), "model");
});

test("steps: the last step is the one that finishes the wizard", () => {
  assertEquals(SETUP_STEPS.filter(isLastStep), ["done"]);
});

test("steps: the progress line counts from one", () => {
  assertEquals(SETUP_STEPS.map(stepNumber), [1, 2, 3, 4]);
});
