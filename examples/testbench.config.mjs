export default {
  name: "portable-example",
  baseUrl: "http://127.0.0.1:4173",
  webServer: {
    command: "npm run example:server",
    cwd: "..",
    healthUrl: "http://127.0.0.1:4173",
  },
  targets:
    process.platform === "darwin"
      ? [
          { name: "chrome", headless: true },
          { name: "firefox", headless: true },
          "safari",
          { name: "safari-ios", deviceName: "iPhone 16" },
          { name: "chrome-android", avd: "Browser_Testbench_API_36" },
        ]
      : [
          { name: "chrome", headless: true },
          { name: "firefox", headless: true },
          { name: "edge", headless: true },
          { name: "chrome-android", avd: "Browser_Testbench_API_36" },
        ],
  specs: ["smoke.spec.mjs"],
  artifactsDir: "../artifacts",
};
