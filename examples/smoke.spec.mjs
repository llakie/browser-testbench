import assert from "node:assert/strict";

export default [
  {
    name: "form interaction",
    async run({ browser, step, screenshot }) {
      await step("enter name", async () => browser.$("#name").setValue("Testbench"));
      await step("submit", async () => browser.$("#submit").click());
      await step("verify result", async () => {
        await browser.$("#result").waitForDisplayed();
        assert.equal(await browser.$("#result").getText(), "Hello Testbench");
      });
      await screenshot("form-complete");
    },
  },
];
