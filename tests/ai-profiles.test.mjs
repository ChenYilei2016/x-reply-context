import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const scope=vm.createContext({URL});vm.runInContext(await readFile(new URL('../extension/ai-config.js',import.meta.url),'utf8'),scope);
const config=scope.XReplyAIConfig;
const legacy={enabled:true,baseUrl:'https://provider.example/v1',apiKey:'fixture-key',model:'fixture-model',generatePrompt:'my ${post}',rewritePrompt:'my ${draft}'};
test('旧配置保留Key、模型、启用状态和共享Prompt，OpenAI预设不复制Key',()=>{
 const migrated=config.normalizeProfiles(legacy),active=config.activeConfig(migrated);
 for(const key of Object.keys(legacy))assert.equal(active[key],legacy[key]);
 assert.equal(migrated.profiles.length,2);assert.equal(migrated.profiles[1].apiKey,'');
 assert.equal(migrated.profiles[1].baseUrl,'https://api.openai.com/v1');
 assert.equal(migrated.profiles[1].model,'gpt-6-luna');
 assert.equal(JSON.stringify(config.normalizeProfiles(migrated)),JSON.stringify(migrated));
});
test('首次打开预置OpenAI但不自动启用；旧Prompt单独配置也保留',()=>{
 const value=config.normalizeProfiles({generatePrompt:'custom'});
 assert.equal(value.enabled,false);assert.equal(value.profiles.length,1);assert.equal(value.activeProfileId,'openai');
 assert.equal(value.generatePrompt,'custom');assert.equal(config.activeConfig(value).apiKey,'');
});
test('切换使用独立Key与模型，Prompt共用；启用空Key拒绝，原对象不变',()=>{
 const value=config.normalizeProfiles(legacy);
 assert.throws(()=>config.normalizeProfiles({...value,activeProfileId:'openai'}),/开启前/);
 assert.equal(value.activeProfileId,'current');
 const next=config.normalizeProfiles({...value,activeProfileId:'openai',profiles:value.profiles.map(p=>p.id==='openai'?{...p,apiKey:'second-test-key'}:p)});
 assert.equal(config.activeConfig(next).apiKey,'second-test-key');assert.equal(config.activeConfig(next).generatePrompt,legacy.generatePrompt);
 assert.equal(next.profiles[0].apiKey,legacy.apiKey);
});
test('列表大小、重复ID、失效选择、名称和域名受限，不静默丢配置',()=>{
 const value=config.normalizeProfiles(legacy);
 assert.throws(()=>config.normalizeProfiles({...value,activeProfileId:'missing'}),/有效/);
 assert.throws(()=>config.normalizeProfiles({...value,profiles:[value.profiles[0],value.profiles[0]]}),/重复/);
 assert.throws(()=>config.normalizeProfiles({...value,profiles:Array.from({length:11},(_,i)=>({...value.profiles[0],id:String(i)}))}),/1～10/);
 assert.throws(()=>config.normalizeProfiles({...value,profiles:[]}),/1～10/);
 assert.throws(()=>config.normalizeProfiles({...value,profiles:[{...value.profiles[0],name:''}]}),/名称/);
 assert.throws(()=>config.normalizeProfiles({...value,profiles:[{...value.profiles[0],baseUrl:'https://x.com/v1'}]}),/不能使用 X/);
});

test('处理模式按配置保存，旧配置默认跟随项目；已有模型不被新预设覆盖',()=>{
 const old=config.normalizeProfiles(legacy);
 assert.equal(old.profiles[0].serviceTier,'auto');assert.equal(old.profiles[1].serviceTier,'auto');
 old.profiles[1].model='gpt-5.4-mini';old.profiles[1].serviceTier='fast';
 const saved=config.normalizeProfiles(old);
 assert.equal(saved.profiles[1].model,'gpt-5.4-mini');assert.equal(saved.profiles[1].serviceTier,'fast');
 assert.equal(saved.profiles[0].serviceTier,'auto');
 assert.throws(()=>config.normalizeProfiles({...saved,profiles:[{...saved.profiles[0],serviceTier:'ultrafast'}]}),/处理模式/);
 assert.equal(config.isOpenAI('https://api.openai.com/v1'),true);
 assert.equal(config.isOpenAI('https://api.openai.com.example/v1'),false);
 assert.equal(config.isOpenAI('https://api.openai.com:444/v1'),false);
});
