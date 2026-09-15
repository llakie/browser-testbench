import assert from "node:assert/strict";

export default [
  {
    name: "intentional failure captures diagnostics",
    async run({ browser }) {
      assert.equal(await browser.$("h1").getText(), "This assertion intentionally fails");
    },
  },
];
