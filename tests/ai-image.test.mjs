import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const sources = await Promise.all(['ai-config.js', 'creation/compose-prompt.js', 'creation/image-model.js', 'ai-image-service.js']
  .map(name => readFile(new URL(`../extension/${name}`, import.meta.url), 'utf8')));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';
const profiles = [
  {id: 'chat', name: '对话', baseUrl: 'https://relay.example/v1', apiKey: 'chat-key', model: 'gpt-6-luna'},
  {id: 'img', name: 'OpenAI 出图', baseUrl: 'https://api.openai.com/v1', apiKey: 'img-key', model: 'gpt-6-luna'}
];
const studio = {url: 'chrome-extension://test/creation/studio.html', tab: {id: 3}, documentId: 'doc'};
const input = {prompt: '一只戴墨镜的机器人坐在服务器机房里', style: 'cyberpunk', ratio: '16:9'};
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

function setup({fetchImpl = async () => json({data: [{b64_json: PNG}], output_format: 'png', size: '1536x864'}), config = {}, permitted = true} = {}) {
  const calls = [];
  const aiConfig = {enabled: false, profiles, activeProfileId: 'chat', creationProfileIds: {images: 'img'}, ...config};
  const chrome = {runtime: {getURL: path => `chrome-extension://test/${path}`},
    storage: {local: {get: async () => ({aiConfig})}}, permissions: {contains: async () => permitted}};
  const scope = vm.createContext({chrome, fetch: (...args) => { calls.push(args); return fetchImpl(...args); },
    URL, Response, Blob, TextDecoder, DOMException, AbortController, setTimeout, clearTimeout});
  sources.forEach(source => vm.runInContext(source, scope));
  return {service: scope.XReplyAIImageService.create(), calls, scope};
}

test('比例按模型映射尺寸：gpt-image-2 系列精确比例，其他模型用最接近的标准尺寸', () => {
  const {scope: {XReplyImageModel: image}} = setup();
  const wide = image.ImageRatio.from('16:9');
  assert.equal(image.sizeFor(wide, 'gpt-image-2'), '1536x864');
  assert.equal(image.sizeFor(wide, 'gpt-image-2.5-flare'), '1536x864');
  assert.equal(image.sizeFor(wide, 'gpt-image-1.5'), '1536x1024');
  assert.equal(image.sizeFor(image.ImageRatio.from('9:16'), 'my-relay-image'), '1024x1536');
  for (const ratio of image.ImageRatio.values()) {
    const [width, height] = ratio.exact.split('x').map(Number);
    assert.equal(width % 16 + height % 16, 0, '精确尺寸的边长是 16 的倍数');
  }
  assert.equal(image.ImageStyle.values().length, 8);
});

test('出图提示词请求与出图请求体：风格附在末尾、质量为 auto 时不传、空内容报错', () => {
  const {scope: {XReplyImageModel: image}} = setup();
  const request = image.buildPromptRequest({text: '黄仁勋交棒 <CEO>', style: 'news', ratio: '1:1'});
  assert.match(request.prompt, /新闻快讯/);
  assert.match(request.prompt, /方形 1:1/);
  assert.match(request.prompt, /最多一句不超过 8 个字的中文标题/);
  assert.equal(request.content, '<post>黄仁勋交棒 &lt;CEO&gt;</post>');
  assert.throws(() => image.buildPromptRequest({text: ' ', style: 'news', ratio: '1:1'}), /正文是空的/);
  const body = image.generationBody(input, {model: 'gpt-image-2', quality: 'auto'});
  assert.deepEqual(Object.keys(body).sort(), ['model', 'n', 'prompt', 'size']);
  assert.match(body.prompt, /整体风格：赛博朋克风格/);
  assert.equal(image.generationBody(input, {model: 'gpt-image-2', quality: 'low'}).quality, 'low');
  assert.throws(() => image.generationBody({...input, prompt: ''}, {model: 'm'}), /提示词是空的/);
  assert.throws(() => image.generationBody({...input, ratio: '4:3'}, {model: 'm'}), /风格和比例/);
  assert.throws(() => image.imageFromResponse({data: [{url: 'https://a/b.png'}]}), /只返回了图片链接/);
  assert.equal(image.imageFromResponse({data: [{b64_json: PNG}], output_format: 'webp'}).mime, 'image/webp');
});

test('设置：出图模型与质量默认值和校验；出图地址换成 /images/generations', () => {
  const {scope: {XReplyAIConfig: config}} = setup();
  const normalized = config.normalizeProfiles({profiles, activeProfileId: 'chat'});
  assert.equal(config.imageModel(normalized), 'gpt-image-2');
  assert.equal(config.imageModel(config.normalizeProfiles({profiles, activeProfileId: 'chat', imageModel: 'gpt-image-2.5-flare'})), 'gpt-image-2.5-flare',
    '旧版的出图模型设置迁入配图模型');
  assert.equal(normalized.imageQuality, 'medium');
  assert.throws(() => config.normalizeProfiles({profiles, activeProfileId: 'chat', models: {images: 'bad model!'}}), /「配图」的模型名/);
  assert.throws(() => config.normalizeProfiles({profiles, activeProfileId: 'chat', imageQuality: 'ultra'}), /出图质量/);
  assert.equal(config.imagesEndpoint('https://relay.example/v1/chat/completions').href, 'https://relay.example/v1/images/generations');
});

test('出图：用「配图」步骤的 API 配置和出图模型，返回 data URL', async () => {
  const {service, calls} = setup({config: {models: {images: 'gpt-image-2.5-flare'}, imageQuality: 'high'}});
  const result = await service.handle({type: 'AI_IMAGE_GENERATE', id: 'img-1', input}, studio);
  assert.equal(result.ok, true);
  assert.equal(result.image.dataUrl, `data:image/png;base64,${PNG}`);
  assert.equal(result.size, '1536x864');
  assert.equal(calls[0][0], 'https://api.openai.com/v1/images/generations');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer img-key');
  const body = JSON.parse(calls[0][1].body);
  assert.equal(body.model, 'gpt-image-2.5-flare');
  assert.equal(body.quality, 'high');
});

test('出图失败：显示接口给出的原因；只接受写作台；未授权、未配置时不请求', async () => {
  const rejected = setup({fetchImpl: async () => json({error: {message: 'Your request was rejected by the safety system.'}}, 400)});
  const result = await rejected.service.handle({type: 'AI_IMAGE_GENERATE', id: 'img-2', input}, studio);
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 400.*safety system/);

  const {service, calls} = setup({permitted: false});
  assert.match((await service.handle({type: 'AI_IMAGE_GENERATE', id: 'a', input}, {url: 'https://x.com/', tab: {id: 1}})).error, /仅写作台/);
  const unpermitted = await service.handle({type: 'AI_IMAGE_GENERATE', id: 'b', input}, studio);
  assert.match(unpermitted.error, /尚未授权/);
  assert.equal(unpermitted.origin, 'https://api.openai.com/*');
  assert.equal(calls.length, 0);
  const missing = setup({config: {profiles: [{...profiles[0], apiKey: ''}], creationProfileIds: {}}});
  assert.match((await missing.service.handle({type: 'AI_IMAGE_GENERATE', id: 'c', input}, studio)).error, /选择填好地址和 Key/);
});

test('取消出图：返回 cancelled，不当作错误', async () => {
  let release;
  const {service} = setup({fetchImpl: (url, options) => new Promise((resolve, reject) => {
    release = resolve;
    options.signal.addEventListener('abort', () => reject(options.signal.reason));
  })});
  const pending = service.handle({type: 'AI_IMAGE_GENERATE', id: 'img-3', input}, studio);
  await new Promise(resolve => setTimeout(resolve, 10));
  await service.handle({type: 'AI_IMAGE_CANCEL', ids: ['img-3']}, studio);
  assert.deepEqual({...await pending}, {ok: false, cancelled: true});
  assert.ok(release);
});
