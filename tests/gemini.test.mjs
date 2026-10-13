import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiHandler, MAX_REQUEST_BYTES } from '../server/gemini.mjs';

const env = { GEMINI_API_KEY:'test-key-not-a-real-secret', STICKER_AI_ACCESS_CODE:'test-access-code', STICKER_ALLOWED_ORIGINS:'http://localhost:3000,https://studio.example' };
const source = { id:'ABC123', status:'collected', text:'Nas etiquetas: Ana-Clara e João, 75 cada.' };
const result = { orders:[{id:'ABC123',status:'found',reason:'',names:[
  {name:'Ana-Clara',quantity:75,evidence:source.text}, {name:'João',quantity:75,evidence:source.text},
]}] };
function request(body = {orders:[source]}, headers = {}, method = 'POST') {
  return new Request('http://localhost:3000/api/lapis/extract', {method, headers:{origin:'http://localhost:3000','content-type':'application/json','x-sticker-access-code':'test-access-code',...headers},
    ...(method === 'GET' || method === 'OPTIONS' ? {} : {body: typeof body === 'string' ? body : JSON.stringify(body)})});
}
const upstream = payload => new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(payload)}]}}]}), {headers:{'content-type':'application/json'}});

test('authorization and Origin are enforced before fetch or quota', async () => {
  let calls=0,quotas=0;
  const handler=createGeminiHandler({env,fetchImpl:async()=>{calls++;return upstream(result);},consumeQuota:async()=>{quotas++;return true;}});
  for(const code of ['', 'wrong']) assert.equal((await handler(request(undefined,{'x-sticker-access-code':code}))).status,401);
  for(const origin of ['', 'null','https://studio.example.evil','https://studio.example/']) assert.equal((await handler(request(undefined,{origin}))).status,403);
  assert.equal(calls,0);assert.equal(quotas,0);
});
test('valid Gemini request uses compatible REST schema, header key and configurable model', async () => {
  let options,url,quotaOrders;
  const handler=createGeminiHandler({env:{...env,GEMINI_MODEL:'gemini-test-flash'},consumeQuota:async value=>{quotaOrders=value.orders;return true;},fetchImpl:async(u,o)=>{url=u;options=o;return upstream(result);}});
  const response=await handler(request());
  assert.equal(response.status,200);
  assert.ok(url.endsWith('/models/gemini-test-flash:generateContent'));
  assert.ok(!url.includes('test-key'));assert.equal(options.headers['x-goog-api-key'],env.GEMINI_API_KEY);
  const body=JSON.parse(options.body);
  assert.equal(body.generationConfig.responseMimeType,'application/json');
  assert.deepEqual(body.generationConfig.responseJsonSchema.properties.orders.items.properties.id.enum,['ABC123']);
  assert.equal(body.generationConfig.responseFormat,undefined);
  assert.equal(body.generationConfig.maxOutputTokens,8192);
  assert.equal(body.generationConfig.temperature,0.1);
  assert.ok(body.systemInstruction.parts[0].text.includes('não confiáveis'));
  assert.equal(quotaOrders,1);
  assert.equal(response.headers.get('access-control-allow-origin'),'http://localhost:3000');
  assert.equal((await response.json()).orders[0].names[1].name,'João');
});
test('default model and env function are supported',async()=>{
  let url;
  const handler=createGeminiHandler({env:name=>env[name],fetchImpl:async(u)=>{url=u;return upstream(result);}});
  assert.equal((await handler(request())).status,200);assert.ok(url.includes('gemini-3.8-flash'));
});
test('browser preflight requires permitted origin and POST, makes no paid calls',async()=>{
  let calls=0;const handler=createGeminiHandler({env,fetchImpl:async()=>{calls++;return upstream(result);}});
  const response=await handler(request(null,{'x-sticker-access-code':'','access-control-request-method':'POST'},'OPTIONS'));
  assert.equal(response.status,204);assert.ok(response.headers.get('access-control-allow-headers').includes('x-sticker-access-code'));
  assert.equal((await handler(request(null,{'access-control-request-method':'DELETE'},'OPTIONS'))).status,405);
  assert.equal((await handler(request(null,{},'GET'))).status,405);assert.equal(calls,0);
});
test('missing and unsafe server configuration fails closed',async()=>{
  for(const partial of [{...env,GEMINI_API_KEY:''},{...env,STICKER_AI_ACCESS_CODE:''},{...env,STICKER_ALLOWED_ORIGINS:''},{...env,STICKER_ALLOWED_ORIGINS:'*'},{...env,GEMINI_MODEL:'../bad'}]){
    let calls=0;const handler=createGeminiHandler({env:partial,fetchImpl:async()=>{calls++;return upstream(result);}});
    assert.equal((await handler(request())).status,503);assert.equal(calls,0);
  }
});
test('input count, UTF8 byte cap, duplicate IDs and status/text types prevent upstream',async()=>{
  let calls=0;const handler=createGeminiHandler({env,fetchImpl:async()=>{calls++;return upstream(result);}});
  for(const body of [{orders:[]},{orders:Array.from({length:11},(_,i)=>({...source,id:`ABC${i}`}))},{orders:[source,source]},
    {orders:[{...source,text:'A'.repeat(12001)}]},{orders:[{...source,status:'found'}]}, {orders:[{...source,text:''}]},'not json']){
    assert.equal((await handler(request(body))).status,400);
  }
  assert.equal((await handler(request({}, {'content-length':String(MAX_REQUEST_BYTES+1)}))).status,413);
  assert.equal((await handler(request(' '.repeat(MAX_REQUEST_BYTES+1)))).status,413);
  assert.equal((await handler(request(undefined,{'content-type':'text/plain'}))).status,415);assert.equal(calls,0);
});
test('quota counts collected orders only; rejects exhaustion and DB errors without fetch',async()=>{
  for(const consumeQuota of [async()=>false,async()=>{throw new Error('database sensitive details');},async()=>undefined]){
    let calls=0;const handler=createGeminiHandler({env,consumeQuota,fetchImpl:async()=>{calls++;return upstream(result);}});
    const response=await handler(request());assert.ok([429,503].includes(response.status));assert.equal(calls,0);
    assert.ok(!(await response.text()).includes('sensitive'));
  }
  let quota=0,fetches=0;
  const handler=createGeminiHandler({env,consumeQuota:async()=>{quota++;return true;},fetchImpl:async()=>{fetches++;return upstream(result);}});
  const response=await handler(request({orders:[{id:'MISSING',status:'not_found',text:''},{id:'FAILED',status:'error',text:'',error:'Timeout'}]}));
  assert.equal(response.status,200);assert.deepEqual((await response.json()).orders.map(o=>o.status),['not_found','review']);
  assert.equal(quota,0);assert.equal(fetches,0);
});
test('upstream failures are safe, with no body or secrets in client errors',async()=>{
  for(const status of [400,401,403,429,500]){
    const handler=createGeminiHandler({env,fetchImpl:async()=>new Response('sensitive provider body test-key-not-a-real-secret',{status})});
    const response=await handler(request());assert.equal(response.status,status===429?429:502);
    const body=await response.text();assert.ok(!body.includes('sensitive'));assert.ok(!body.includes(env.GEMINI_API_KEY));
  }
  const handler=createGeminiHandler({env,fetchImpl:async()=>{throw new Error('secret provider failure');}});
  const response=await handler(request());assert.equal(response.status,502);assert.ok(!(await response.text()).includes('secret'));
});
test('timeout bounds mocks ignoring abort as well as upstream body reads',async()=>{
  const handler=createGeminiHandler({env,timeoutMs:10,fetchImpl:async()=>new Promise(()=>{})});
  assert.equal((await handler(request())).status,504);
  const streaming=createGeminiHandler({env,timeoutMs:10,fetchImpl:async()=>new Response(new ReadableStream({start(){}}))});
  assert.equal((await streaming(request())).status,504);
});
test('invalid model output never becomes not_found or reaches labels',async()=>{
  for(const payload of [{orders:[]},{orders:[{...result.orders[0],id:'OTHER'}]},{orders:[{...result.orders[0],names:[{name:'Inventado',quantity:null,evidence:source.text}]}]},
    {orders:[{...result.orders[0],names:[{name:'João',quantity:null,evidence:'not literal'}]}]}]){
    const handler=createGeminiHandler({env,fetchImpl:async()=>upstream(payload)});
    assert.equal((await handler(request())).status,502);
  }
  for(const response of [new Response('not JSON'),new Response(' '.repeat(256001)),new Response(JSON.stringify({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:JSON.stringify(result)}]}}]}))]){
    const handler=createGeminiHandler({env,fetchImpl:async()=>response});assert.equal((await handler(request())).status,502);
  }
});
