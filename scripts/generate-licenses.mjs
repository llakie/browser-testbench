import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getLicenseFileText } from "generate-license-file";

const CREDIT =
  "This file was generated with the generate-license-file npm package!\n" +
  "https://www.npmjs.com/package/generate-license-file";
const SEPARATOR = "-----------";

export class ThirdPartyLicenseGenerator {
  static async generate(
    packageJsonPath = "package.json",
    lockfilePath = "package-lock.json",
    configPath = ".glf.json",
  ) {
    const lockfile = JSON.parse(await readFile(lockfilePath, "utf8"));
    const platformPackages = this.findPlatformPackages(lockfile);
    const generated = await getLicenseFileText(packageJsonPath, {
      lineEnding: "lf",
      exclude: platformPackages.map(({ identifier }) => identifier),
      replace: await this.readReplacements(configPath),
    });

    const finalCreditPosition = generated.lastIndexOf(CREDIT);
    if (finalCreditPosition < 0) {
      throw new Error("Could not locate the license generator credit in its output.");
    }

    const platformSections = this.formatPlatformSections(platformPackages);
    return generated.slice(0, finalCreditPosition) + platformSections + CREDIT + "\n";
  }

  static async readReplacements(configPath) {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (typeof config.replace !== "object" || config.replace === null || Array.isArray(config.replace)) {
      throw new Error(`${configPath} does not contain a replace object.`);
    }
    return Object.fromEntries(
      Object.entries(config.replace).map(([packageName, replacementPath]) => {
        if (typeof replacementPath !== "string" || replacementPath.length === 0) {
          throw new Error(`Invalid license replacement for ${packageName} in ${configPath}.`);
        }
        return [packageName, resolve(dirname(configPath), replacementPath)];
      }),
    );
  }

  static findPlatformPackages(lockfile) {
    const packages = lockfile.packages;
    if (typeof packages !== "object" || packages === null) {
      throw new Error("package-lock.json does not contain a packages object.");
    }

    const platformPackagePaths = Object.entries(packages)
      .filter(([, metadata]) => metadata?.dev !== true && (metadata?.os?.length > 0 || metadata?.cpu?.length > 0))
      .map(([packagePath]) => packagePath);
    const selectedPaths = new Set();
    const pendingPaths = [...platformPackagePaths];

    while (pendingPaths.length > 0) {
      const packagePath = pendingPaths.pop();
      if (!packagePath || selectedPaths.has(packagePath)) continue;

      const metadata = packages[packagePath];
      if (!metadata) throw new Error(`Missing lockfile metadata for ${packagePath}.`);
      selectedPaths.add(packagePath);

      const dependencies = { ...metadata.dependencies, ...metadata.optionalDependencies };
      for (const dependencyName of Object.keys(dependencies)) {
        const dependencyPath = this.resolveDependencyPath(packagePath, dependencyName, packages);
        if (!dependencyPath) {
          throw new Error(`Could not resolve ${dependencyName}, required by ${packagePath}, in package-lock.json.`);
        }
        pendingPaths.push(dependencyPath);
      }
    }

    return [...selectedPaths]
      .map((packagePath) => {
        const metadata = packages[packagePath];
        const name = packagePath.slice(packagePath.lastIndexOf("node_modules/") + "node_modules/".length);
        if (!name || !metadata.version || !metadata.license) {
          throw new Error(`Incomplete package metadata for ${packagePath}.`);
        }
        return {
          identifier: `${name}@${metadata.version}`,
          license: metadata.license,
        };
      })
      .sort((left, right) => this.compare(left.identifier, right.identifier));
  }

  static resolveDependencyPath(packagePath, dependencyName, packages) {
    let parentPath = packagePath;
    while (parentPath) {
      const nestedPath = `${parentPath}/node_modules/${dependencyName}`;
      if (packages[nestedPath]) return nestedPath;

      const parentNodeModules = parentPath.lastIndexOf("/node_modules/");
      parentPath = parentNodeModules < 0 ? "" : parentPath.slice(0, parentNodeModules);
    }

    const rootPath = `node_modules/${dependencyName}`;
    return packages[rootPath] ? rootPath : undefined;
  }

  static formatPlatformSections(platformPackages) {
    const packagesByLicense = new Map();
    for (const platformPackage of platformPackages) {
      const identifiers = packagesByLicense.get(platformPackage.license) ?? [];
      identifiers.push(platformPackage.identifier);
      packagesByLicense.set(platformPackage.license, identifiers);
    }

    return [...packagesByLicense.entries()]
      .sort(([left], [right]) => this.compare(left, right))
      .map(([license, identifiers]) => {
        identifiers.sort(this.compare);
        const plural = identifiers.length !== 1;
        const heading = `The following npm package${plural ? "s" : ""} may be included in this product:`;
        const description = `${plural ? "These packages each contain" : "This package contains"} the following license:`;
        const packageList = identifiers.map((identifier) => ` - ${identifier}`).join("\n");
        return `${heading}\n\n${packageList}\n\n${description}\n\n${license}\n\n${SEPARATOR}\n\n`;
      })
      .join("");
  }

  static compare(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
  }
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  const outputPath = "THIRD_PARTY_LICENSES.txt";
  const generated = await ThirdPartyLicenseGenerator.generate();

  if (process.argv.includes("--check")) {
    const current = await readFile(outputPath, "utf8");
    if (current !== generated) {
      throw new Error(`${outputPath} is out of date. Run npm run licenses.`);
    }
  } else {
    await writeFile(outputPath, generated, "utf8");
  }
}
