import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const files = ['ai-config.js', 'ai-context.js', 'ai-service.js',
  'creation/compose-prompt.js', 'creation/angle-model.js', 'creation/draft-model.js', 'creation/rewrite-model.js', 'creation/style-model.js'];
const sources = await Promise.all(files.map(name => readFile(new URL(`../extension/${name}`, import.meta.url), 'utf8')));
const profiles = [
  {id: 'main', name: '主用', baseUrl: 'https://model.example/v1', apiKey: 'main-key', model: 'writer'},
  {id: 'think', name: '推理', baseUrl: 'https://think.example/v1', apiKey: 'think-key', model: 'reasoner'}
];
const baseConfig = {enabled: false, profiles, activeProfileId: 'main', creationProfileIds: {angles: 'think'}};
const reply = content => new Response(JSON.stringify({choices: [{finish_reason: 'stop', message: {content}}]}), {headers: {'content-type': 'application/json'}});

function setup(fetchImpl = async () => reply('<reply>{"angles":[]}</reply>')) {
  let settings = structuredClone(baseConfig);
  const calls = [];
  const chrome = {
    runtime: {getURL: path => `chrome-extension://test/${path}`},
    storage: {local: {get: async () => ({aiConfig: settings}), set: async next => { settings = next.aiConfig; }}, onChanged: {addListener: () => {}}},
    permissions: {contains: async ({origins}) => !origins.includes('https://denied.example/*')}
  };
  const scope = vm.createContext({chrome, fetch: (...args) => { calls.push(args); return fetchImpl(...args); },
    URL, Headers, Response, TextDecoder, DOMException, AbortController, setTimeout, clearTimeout, Intl});
  sources.forEach(source => vm.runInContext(source, scope));
  const service = scope.XReplyAIService.create();
  return {service, calls, scope};
}

const studio = {url: 'chrome-extension://test/creation/studio.html', tab: {id: 3}};
const material = {kind: 'article', title: '新模型发布', text: '官方介绍了推理能力。', url: 'https://openai.com/news/1', source: 'OpenAI',
  coverage: 'excerpt', publishedAt: Date.now()};
const anglesRequest = (extra = {}) => ({type: 'AI_REQUEST', kind: 'studio', task: 'angles', id: 'angles-1',
  input: {materials: [material], references: [], persona: '写作台人设'}, ...extra});

test('写作台请求只接受写作台页面和已知步骤，输入无效时不发请求', async () => {
  const {service, calls} = setup();
  assert.match((await service.handle(anglesRequest(), {url: 'chrome-extension://test/creation/radar.html', tab: {id: 1}})).error, /仅写作台/);
  assert.match((await service.handle(anglesRequest({kind: 'compose'}), studio)).error, /无效/, '旧版写作面板的请求类型已移除');
  assert.match((await service.handle(anglesRequest(), {url: 'https://x.com/home', tab: {id: 1}})).error, /仅写作台/);
  assert.match((await service.handle(anglesRequest({task: 'publish'}), studio)).error, /未知的创作任务/);
  assert.match((await service.handle(anglesRequest({task: 'toString'}), studio)).error, /未知的创作任务/);
  assert.match((await service.handle(anglesRequest({input: {materials: [], persona: 'p'}}), studio)).error, /1～3/);
  assert.equal(calls.length, 0);
});

test('找角度用单独指定的 API，不要求开启 AI 回复；成稿未指定时跟随当前配置', async () => {
  const {service, calls} = setup();
  const result = await service.handle(anglesRequest(), studio);
  assert.equal(result.ok, true);
  assert.equal(result.text, '{"angles":[]}');
  assert.equal(calls[0][0], 'https://think.example/v1/chat/completions');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer think-key');
  const body = JSON.parse(calls[0][1].body);
  assert.equal(body.model, 'reasoner');
  assert.equal(body.temperature, 0.9);
  assert.match(body.messages[0].content, /写作台人设/);
  assert.match(body.messages[1].content, /<material id="M1"/);

  const drafts = await service.handle({type: 'AI_REQUEST', kind: 'studio', task: 'drafts', id: 'drafts-1',
    input: {materials: [material], format: 'short_opinion', persona: '写作台人设'}}, studio);
  assert.equal(drafts.ok, true);
  assert.equal(calls[1][0], 'https://model.example/v1/chat/completions');
  assert.match(JSON.parse(calls[1][1].body).messages[0].content, /「中短帖观点」/);

  const rewrite = await service.handle({type: 'AI_REQUEST', kind: 'studio', task: 'rewrite', id: 'rewrite-1',
    input: {materials: [material], style: 'hook', length: 'same', format: 'short_opinion', persona: '写作台人设'}}, studio);
  assert.equal(rewrite.ok, true);
  assert.equal(calls[2][0], 'https://model.example/v1/chat/completions', '改写与成稿共用「成稿」的 API');
  assert.match(JSON.parse(calls[2][1].body).messages[0].content, /风格「钩子开头」/);
});

test('拆解风格只能从对标风格页发起，用「拆解风格」步骤的 API', async () => {
  const {service, calls} = setup();
  const posts = Array.from({length: 3}, (_, index) => ({text: `第 ${index + 1} 条帖子，先抛结论再补数据。`, views: 1000 * (index + 1)}));
  const request = {type: 'AI_REQUEST', kind: 'studio', task: 'styles', id: 'styles-1', input: {author: {handle: 'bob', name: '鲍勃'}, posts}};
  const page = {url: 'chrome-extension://test/creation/styles.html', tab: {id: 4}};
  const result = await service.handle(request, page);
  assert.equal(result.ok, true);
  assert.equal(calls[0][0], 'https://model.example/v1/chat/completions', '未单独指定时跟随当前配置');
  const body = JSON.parse(calls[0][1].body);
  assert.match(body.messages[0].content, /拆解 <posts> 中这位作者的写作风格/);
  assert.match(body.messages[1].content, /<posts author="鲍勃 @bob">/);
  assert.match((await service.handle({...request, id: 'styles-2', input: {posts: posts.slice(0, 2)}}, page)).error, /3～10 条/);
  assert.equal((await service.handle({type: 'AI_STUDIO_STATUS'}, page)).ok, true);
});

test('截断的响应不当作结果', async () => {
  const {service} = setup(async () => new Response(JSON.stringify({choices: [{finish_reason: 'length', message: {content: '<reply>{"angles":['}}]}),
    {headers: {'content-type': 'application/json'}}));
  const result = await service.handle(anglesRequest(), studio);
  assert.equal(result.ok, false);
  assert.match(result.error, /创作模型未完整返回/);
});

test('创作模型状态：每步的配置名、模型与授权情况，不返回 Key', async () => {
  const {service} = setup();
  assert.equal((await service.handle({type: 'AI_STUDIO_STATUS'}, {url: 'https://x.com/', tab: {id: 1}})).ok, false);
  const status = await service.handle({type: 'AI_STUDIO_STATUS'}, studio);
  assert.deepEqual({...status.tasks}, {angles: 'angles', drafts: 'drafts', rewrite: 'drafts', styles: 'styles'});
  assert.deepEqual(JSON.parse(JSON.stringify(status.steps.map(step => [step.id, step.name, step.model, step.permitted]))),
    [['angles', '推理', 'reasoner', true], ['drafts', '主用', 'writer', true], ['styles', '主用', 'writer', true]]);
  assert.equal(JSON.stringify(status).includes('key'), false);
});

test('配置：删除的配置编号回到跟随；保存时为单独指定的创作配置申请域名', () => {
  const {scope: {XReplyAIConfig: config}} = setup();
  const normalized = config.normalizeProfiles({...baseConfig, creationProfileIds: {angles: 'gone', drafts: 'think', extra: 'main'}});
  assert.deepEqual({...normalized.creationProfileIds}, {angles: '', drafts: 'think', styles: ''});
  assert.equal(config.creationProfile(normalized, 'angles').id, 'main');
  assert.deepEqual([...config.requiredOrigins(normalized)], ['https://think.example/*'], '未开启 AI 回复时只申请创作单独指定的域名');
  const legacy = config.normalizeProfiles({...baseConfig, creationProfileIds: undefined});
  assert.deepEqual({...legacy.creationProfileIds}, {angles: '', drafts: '', styles: ''});
  assert.deepEqual([...config.requiredOrigins(legacy)], []);
});
