import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMIT, prepare } from '../envelope.js';
import { wrapFetch } from '../transport.js';

const origin = 'http://localhost';
const endpoint = origin + '/api/backends/chat-completions/generate';
const enabled = { input: true, output: true, background: true };
const task = (patch = {}) => ({ type: 'quiet', chat_completion_source: 'custom', model: 'extra-model',
    custom_url: 'https://provider.invalid/v1', stream: false,
    messages: [{ role: 'system', content: '按指定格式完成任务。' }, { role: 'user', content: '待处理的材料' }], ...patch });
const result = text => ({ choices: [{ index: 0, finish_reason: 'tool_calls', message: {
    role: 'assistant', content: null, tool_calls: [{ id: 'answer', type: 'function',
        function: { name: EMIT, arguments: JSON.stringify({ content: text }) } }],
} }] });
const post = body => ({ method: 'POST', body: JSON.stringify(body) });

test('后台开关默认关闭，显式开启后接纳 quiet 和未标类型，未知类型始终旁路', () => {
    for (const type of ['quiet', undefined, null, '']) {
        const body = task({ type });
        assert.match(prepare(body, { input: true, output: true }).reason, /未开启后台/);
        assert.match(prepare(body, { ...enabled, background: 'true' }).reason, /未开启后台/);
        assert.equal(prepare(body, enabled).request.type, type);
    }
    for (const type of ['dry-run', 'embed', false, 1]) {
        assert.equal(prepare(task({ type }), enabled).request, undefined);
    }
    assert.ok(prepare(task({ type: 'normal' }), { input: true }).request);
    assert.ok(prepare(task({ type: 'normal' }), { output: true }).request);
});

test('总结副 API 和助手 normal 请求保留各自模型、鉴权、采样参数及原始请求', async () => {
    for (const type of ['quiet', 'normal', undefined]) {
        const body = task({ type, custom_include_headers: '{"Authorization":"Bearer test-custom"}',
            reverse_proxy: 'https://proxy.invalid/v1', proxy_password: 'test-proxy', max_tokens: 6000,
            temperature: 0.25, custom_prompt_post_processing: 'strict', user_name: '玩家',
        });
        const before = structuredClone(body);
        let calls = 0;
        const fetch = wrapFetch(async (_url, init) => {
            calls++;
            const sent = JSON.parse(init.body);
            for (const field of ['type', 'model', 'chat_completion_source', 'custom_url', 'custom_include_headers',
                'reverse_proxy', 'proxy_password', 'max_tokens', 'temperature', 'user_name']) {
                assert.equal(sent[field], body[field]);
            }
            assert.equal(sent.custom_prompt_post_processing, 'strict_tools');
            return Response.json(result('完整总结'));
        }, origin, () => enabled);
        const response = await fetch(endpoint, post(body));
        assert.equal((await response.json()).choices[0].message.content, '完整总结');
        assert.deepEqual(body, before);
        assert.equal(calls, 1);
    }
});

test('填表 JSON、更新指令和小剧场标签原样交回，工具协议不改变文本格式', async () => {
    for (const text of [' \n{"rows":[["甲",2]],"note":"\\n"}\n ',
        '<tableEdit>\nupdateRow(0, 1, {"状态":"已完成"});\n</tableEdit>', '<小剧场>\n“你好。”\n</小剧场>']) {
        for (const plain of [false, true]) {
            const fetch = wrapFetch(async () => Response.json(plain
                ? { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] }
                : result(text)), origin, () => enabled);
            const data = await (await fetch(endpoint, post(task()))).json();
            assert.equal(data.choices[0].message.content, text);
            assert.equal(data.choices[0].message.tool_calls, undefined);
        }
    }
});

test('后台请求沿用独立输入／输出开关，保留系统任务和助手预填', async () => {
    const body = task({ messages: [{ role: 'system', content: '只能输出 JSON。' },
        { role: 'user', content: '原始材料' }, { role: 'assistant', content: '{' }], stream: true });
    const inputOnly = prepare(body, { input: true, background: true });
    assert.equal(inputOnly.request.stream, true);
    assert.deepEqual(inputOnly.request.messages[0], body.messages[0]);
    assert.deepEqual(inputOnly.request.messages[2], body.messages[2]);
    assert.equal(JSON.parse(inputOnly.request.messages.at(-1).content).input, '原始材料');
    const outputOnly = prepare(body, { output: true, background: true });
    assert.equal(outputOnly.inputTurns, 0);
    assert.deepEqual(outputOnly.request.messages[1], body.messages[1]);
    const systemOnly = prepare(task({ messages: [body.messages[0]] }), { output: true, background: true });
    assert.ok(systemOnly.request.messages[0].content.startsWith('只能输出 JSON。'));
    assert.equal(prepare(task({ messages: [body.messages[0]] }), { input: true, background: true }).request, undefined);
});

test('后台开关不覆盖已有工具、Schema、其他连接及其他明确的跳过条件', async () => {
    const reports = [];
    for (const patch of [{ tools: [{ type: 'function', function: { name: 'updateTable' } }] },
        { tool_choice: 'none' }, { functions: [{ name: 'writeRow' }] }, { function_call: 'auto' },
        { messages: [{ role: 'tool', content: '工具结果' }] }, { json_schema: { name: 'rows', value: {} } },
        { response_format: { type: 'json_object' } }, { responseSchema: {} }, { responseMimeType: 'application/json' },
        { chat_completion_source: 'claude' }, { n: 2 }, { request_images: true }, { enable_web_search: true },
        { __blueprint_tool_input: {} }, { model: 'pg-gemini-3-pro-抗截断' }, { custom_prompt_post_processing: 'single' }]) {
        const init = post(task(patch));
        const response = new Response('由原插件处理');
        let calls = 0;
        const fetch = wrapFetch(async (url, actual) => {
            calls++;
            assert.equal(url, endpoint);
            assert.equal(actual, init);
            return response;
        }, origin, () => enabled, message => reports.push(message));
        assert.equal(await fetch(endpoint, init), response);
        assert.equal(calls, 1);
    }
    assert.ok(reports.every(message => message.startsWith('已跳过：')));
});

test('Request 写法支持封装，保留 HTTP 选项和取消信号且不消耗调用方原 body', async () => {
    const controller = new AbortController();
    const original = new Request(endpoint, { ...post(task()), credentials: 'include', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf-test', 'x-plugin': 'summary' },
        signal: controller.signal });
    let forwarded;
    const fetch = wrapFetch(async (resource, init) => {
        assert.equal(resource, original);
        forwarded = new Request(resource, init);
        assert.equal(forwarded.credentials, 'include');
        assert.equal(forwarded.cache, 'no-store');
        assert.equal(forwarded.headers.get('x-csrf-token'), 'csrf-test');
        assert.equal(forwarded.headers.get('x-plugin'), 'summary');
        assert.equal((await forwarded.json()).tools.at(-1).function.name, EMIT);
        return Response.json(result('后台结果'));
    }, origin, () => enabled);
    assert.equal((await (await fetch(original)).json()).choices[0].message.content, '后台结果');
    assert.equal(original.bodyUsed, false);
    assert.deepEqual(await original.json(), task());
    controller.abort();
    assert.equal(forwarded.signal.aborted, true);
});

test('Request 的 init 覆盖优先，旁路仍传递原 Request 和 init', async () => {
    const original = new Request(endpoint, post(task({ tools: [{}] })));
    const overrideController = new AbortController();
    const init = { ...post(task({ model: 'overridden-model' })), headers: { 'x-new': 'yes' }, signal: overrideController.signal };
    const fetch = wrapFetch(async (resource, actual) => {
        assert.equal(resource, original);
        assert.equal(actual.headers, init.headers);
        assert.equal(actual.signal, init.signal);
        assert.equal(JSON.parse(actual.body).model, 'overridden-model');
        return Response.json(result('覆盖结果'));
    }, origin, () => enabled);
    assert.equal((await (await fetch(original, init)).json()).choices[0].message.content, '覆盖结果');
    for (const [resource, extra, options] of [
        [new Request(endpoint, post(task())), undefined, { input: true }],
        [original, undefined, enabled],
        [new Request('https://elsewhere.invalid/api/backends/chat-completions/generate', post(task())), undefined, enabled],
        [original, { ...init, body: '{invalid' }, enabled],
        [new Request(endpoint), undefined, enabled],
        [original, { method: 'GET' }, enabled],
    ]) {
        let calls = 0;
        const pass = wrapFetch(async (url, options) => {
            calls++;
            assert.equal(url, resource);
            assert.equal(options, extra);
            assert.equal(resource.bodyUsed, false);
            return new Response('原样返回');
        }, origin, () => options);
        assert.equal(await (await pass(resource, extra)).text(), '原样返回');
        assert.equal(calls, 1);
    }
});

test('后台流式调用按各自 OpenAI／Gemini 格式交回完整结果', async () => {
    for (const google of [false, true]) for (const clientStream of [false, true]) {
        const content = '{"status":"完成"}';
        const fetch = wrapFetch(async (_resource, init) => {
            assert.equal(JSON.parse(init.body).stream, google);
            if (!google) return Response.json(result(content));
            const frame = { candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model',
                parts: [{ functionCall: { name: EMIT, args: { content } } }] } }] };
            return new Response('data: ' + JSON.stringify(frame) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
        }, origin, () => enabled);
        const response = await fetch(endpoint, post(task({ chat_completion_source: google ? 'makersuite' : 'custom', stream: clientStream })));
        if (clientStream) {
            const frame = JSON.parse((await response.text()).split('\n\n')[0].slice(6));
            assert.equal(google ? frame.candidates[0].content.parts[0].text : frame.choices[0].delta.content, content);
        } else {
            const data = await response.json();
            assert.equal(google ? data.responseContent.parts[0].text : data.choices[0].message.content, content);
        }
    }
});

test('并发任务分别报告状态，后台跳过可见，记录不包含输入、API 地址或鉴权', async () => {
    const pending = new Map();
    const reports = [];
    const fetch = wrapFetch((_url, init) => new Promise(resolve => pending.set(JSON.parse(init.body).model, resolve)),
        origin, () => enabled, (message, detail) => reports.push({ message, ...detail }));
    const a = fetch(endpoint, post(task({ model: 'summary', proxy_password: 'secret-token' })));
    const b = fetch(endpoint, post(task({ model: 'table', type: undefined })));
    pending.get('table')(Response.json(result('填表结果')));
    assert.equal((await (await b).json()).choices[0].message.content, '填表结果');
    pending.get('summary')(Response.json(result('总结结果')));
    assert.equal((await (await a).json()).choices[0].message.content, '总结结果');
    assert.deepEqual(reports.map(r => [r.id, r.model]), [[1, 'summary'], [2, 'table'], [2, 'table'], [1, 'summary']]);
    assert.doesNotMatch(JSON.stringify(reports), /secret-token|provider\.invalid|待处理的材料/);
    const skipped = wrapFetch(async () => new Response('未处理'), origin, () => ({ output: true }),
        (message, detail) => reports.push({ message, ...detail }));
    await skipped(endpoint, post(task()));
    assert.match(reports.at(-1).message, /已跳过.*后台/);
});

test('后台 Request 的取消、上游错误和截断不额外请求', async () => {
    const controller = new AbortController();
    controller.abort();
    const reports = [];
    let calls = 0;
    const cancelled = wrapFetch(async resource => {
        calls++;
        resource.signal.throwIfAborted();
    }, origin, () => enabled, message => reports.push(message));
    await assert.rejects(cancelled(new Request(endpoint, { ...post(task()), signal: controller.signal })), { name: 'AbortError' });
    assert.equal(calls, 1);
    assert.equal(reports.at(-1), '已停止生成');
    for (const fail of [new Response('错误', { status: 503 }), Response.json({ choices: [{ finish_reason: 'length', message: { content: '残缺' } }] })]) {
        let count = 0;
        const fetch = wrapFetch(async () => { count++; return fail; }, origin, () => enabled);
        const response = await fetch(endpoint, post(task()));
        assert.equal(response.status, fail.status === 503 ? 503 : 422);
        assert.equal(count, 1);
    }
});
