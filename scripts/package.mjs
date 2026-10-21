import { mkdir, readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../",import.meta.url));
const extension = path.join(root,"extension");
const manifest = JSON.parse(await readFile(path.join(extension,"manifest.json"),"utf8"));
await mkdir(path.join(root,"dist"),{ recursive:true });
const output = path.join(root,"dist",`x-reply-context-${manifest.version}.zip`);
const files = (await readdir(extension)).filter(file => !file.startsWith(".")).sort();
execFileSync("zip",["-q","-j",output,...files],{ cwd:extension });
const entries = execFileSync("unzip",["-Z1",output],{ encoding:"utf8" }).trim().split("\n").sort();
if (JSON.stringify(entries) !== JSON.stringify(files)) throw new Error("安装包目录与扩展源码不一致");
console.log(output);
