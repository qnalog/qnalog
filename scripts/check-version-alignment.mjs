import { readFileSync } from "node:fs";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const manifest = readJson("manifest.json");
const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const versions = readJson("versions.json");
const current = String(manifest.version || "").trim();
const failures = [];

if (!current) failures.push("manifest.json 缺少 version");
if (packageJson.version !== current) {
  failures.push(`package.json=${packageJson.version || "<missing>"}`);
}
if (packageLock.version !== current) {
  failures.push(`package-lock.json=${packageLock.version || "<missing>"}`);
}
if (packageLock.packages?.[""]?.version !== current) {
  failures.push(`package-lock root=${packageLock.packages?.[""]?.version || "<missing>"}`);
}
if (!Object.prototype.hasOwnProperty.call(versions, current)) {
  failures.push(`versions.json 缺少 ${current}`);
} else if (versions[current] !== manifest.minAppVersion) {
  failures.push(`versions.json[${current}]=${versions[current]}，manifest minAppVersion=${manifest.minAppVersion}`);
}

if (failures.length) {
  console.error(`[versions] 版本文件不一致：${failures.join("；")}`);
  process.exit(1);
}

console.log(`[versions] OK: ${current}`);
