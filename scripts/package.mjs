import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../",import.meta.url));
const extension = path.join(root,"extension");
const manifest = JSON.parse(await readFile(path.join(extension,"manifest.json"),"utf8"));
await mkdir(path.join(root,"dist"),{ recursive:true });
const output = path.join(root,"dist",`x-reply-context-${manifest.version}.zip`);
// 包含子目录（如 creation/），保留相对路径；跳过隐藏文件。
const entriesOnDisk = await readdir(extension,{ recursive:true,withFileTypes:true });
const files = entriesOnDisk.filter(entry => entry.isFile())
  .map(entry => path.relative(extension,path.join(entry.parentPath,entry.name)))
  .filter(file => !file.split(path.sep).some(part => part.startsWith(".")))
  .sort();
await rm(output,{ force:true });
execFileSync("zip",["-q",output,...files],{ cwd:extension });
const entries = execFileSync("unzip",["-Z1",output],{ encoding:"utf8" }).trim().split("\n").sort();
if (JSON.stringify(entries) !== JSON.stringify(files)) throw new Error("安装包目录与扩展源码不一致");
// 仓库只保留当前版本的安装包，历史版本可从 git 历史取回。
const releases = (await readdir(path.join(root,"dist"))).filter(file => /^x-reply-context-.+\.zip$/.test(file));
for (const file of releases) if (path.join(root,"dist",file) !== output) await rm(path.join(root,"dist",file));
console.log(output);
