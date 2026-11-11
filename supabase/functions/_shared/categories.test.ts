import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1.0.19";
import { CATEGORIES, categoriesFor, guideFor } from "./categories.ts";

Deno.test("every category has a guide line, so the AI prompt never prints undefined", () => {
  const guide = guideFor(CATEGORIES);
  assert(!guide.includes("undefined"));
  assertEquals(guide.split("\n").length, CATEGORIES.length);
  assertMatch(guideFor(["Taxes"]), /F24/);
});

Deno.test("a user's list drops the built-ins they hid and adds their own", () => {
  const list = categoriesFor([
    { name: "Taxes", hidden: true }, { name: "Experiences", hidden: true },
    { name: "Gym", hidden: false }, { name: "Gifts", hidden: false },
  ]);
  assert(!list.includes("Taxes") && !list.includes("Experiences"));
  assertEquals(list.slice(-2), ["Gym", "Gifts"]);
  assert(list.includes("Transfer") && list.includes("Income"));
  assertEquals(categoriesFor([]), CATEGORIES);
  assertMatch(guideFor(["Gym"]), /- Gym: a category the user created/);
});
