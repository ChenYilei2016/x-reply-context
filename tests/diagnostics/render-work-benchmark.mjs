// Count work using the existing controlled DOM fixture; these are call counts, not browser frame timings.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const fixture=await readFile(new URL('../notification-controls.test.mjs',import.meta.url),'utf8');
const body=fixture.slice(fixture.indexOf('function setup('),fixture.indexOf('\ntest('));
const source=(await Promise.all(['card-filter.js','notification-filter.js'].map(file=>process.argv[2]?
 execFileSync('git',['show',`${process.argv[2]}:extension/${file}`],{encoding:'utf8'}):readFile(new URL('../../extension/'+file,import.meta.url),'utf8')))).join('\n');
const setup=new Function('vm','source','assert',body+'\nreturn setup;')(vm,source,assert);
const {env,filter,control}=setup();await filter.refresh();
const controls=['xrc-notification-controls','xrc-notification-filter','xrc-notification-replied','xrc-filter-apply','xrc-filter-auto'].map(control);
const before=controls.reduce((n,c)=>n+c.writes,0);env.cardScans=0;env.layoutChecks=0;
for(let i=0;i<100;i++)await filter.refresh();
console.log(JSON.stringify({fixture:true,ref:process.argv[2]||'worktree',unchangedRefreshes:100,
 propertyWrites:controls.reduce((n,c)=>n+c.writes,0)-before,cardScans:env.cardScans,layoutChecks:env.layoutChecks,classifyCallsIncludingWarmup:env.calls},null,2));
