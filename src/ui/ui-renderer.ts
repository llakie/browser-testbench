import { join } from "node:path";
import { Eta } from "eta";
import { TestbenchPaths } from "../infrastructure/paths.js";

export class UiRenderer {
  private static readonly templates = new Eta({
    views: join(TestbenchPaths.projectRoot, "templates", "ui"),
    cache: true,
  });

  static setup(): string {
    return this.templates.render("./setup", { title: "Browser Testbench" });
  }
}
