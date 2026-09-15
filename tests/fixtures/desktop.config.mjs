export default {
  name: "parallel-desktop-verification",
  baseUrl: "http://127.0.0.1:4173",
  webServer: {
    command: "npm run example:server",
    cwd: "../..",
    healthUrl: "http://127.0.0.1:4173",
  },
  targets: [
    { name: "chrome", headless: true },
    { name: "firefox", headless: true },
  ],
  specs: ["../../examples/smoke.spec.mjs"],
  artifactsDir: "../../artifacts",
  maxDesktopWorkers: 2,
};
