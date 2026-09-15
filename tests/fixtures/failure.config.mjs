export default {
  name: "failure-artifact-verification",
  baseUrl: "http://127.0.0.1:4173",
  webServer: {
    command: "npm run example:server",
    cwd: "../..",
    healthUrl: "http://127.0.0.1:4173",
  },
  targets: [{ name: "chrome", headless: true }],
  specs: ["failure.spec.mjs"],
  artifactsDir: "../../artifacts",
};
