import { test } from 'node:test';
import assert from 'node:assert/strict';
import { READ, EMIT, prepare } from '../envelope.js';
import { wrapFetch } from '../transport.js';

const path = '/api/backends/chat-completions/generate';
const both = { input: true, output: true };
const req = (overrides = {}) => ({ type: 'normal', chat_completion_source: 'custom', stream: false,
    model: 'test', messages: [{ role: 'user', content: '本轮原文' }], ...overrides });
const answer = '  第一段“正文” 🐈\n\n第二段："引号" 与 \\ 路径。  ';
const json = value => Response.json(value);
const fn = (name = EMIT, args = JSON.stringify({ content: answer })) => ({ name, arguments: args });
const completed = () => ({ model: 'test', usage: { total_tokens: 40 }, choices: [{ index: 0, finish_reason: 'tool_calls',
    message: { role: 'assistant', content: null, reasoning_content: '摘要', tool_calls: [{ id: 'abc', type: 'function', function: fn() }] } }] });

function harness(responder, options = both) {
    const calls = [];
    const wrapped = wrapFetch(async (url, init) => {
        calls.push({ url, init });
        return responder(JSON.parse(init.body), init);
    }, 'http://localhost', () => options);
    return { calls, send: (body, url = path, signal) => wrapped(url, { method: 'POST', signal, body: JSON.stringify(body) }) };
}

// Split bytes in the middle of both Unicode characters and SSE delimiters.
function stream(frames, done = true) {
    const bytes = new TextEncoder().encode(': keepalive\r\n\r\n' +
        frames.map(f => 'data: ' + JSON.stringify(f) + '\r\n\r\n').join('') + (done ? 'data: [DONE]\r\n\r\n' : ''));
    let i = 0;
    return new Response(new ReadableStream({ pull(c) {
        if (i >= bytes.length) return c.close();
        c.enqueue(bytes.slice(i, i + 7)); i += 7;
    } }), { headers: { 'content-type': 'text/event-stream' } });
}
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const toolChunk = (f, id) => chunk({ tool_calls: [{ index: 0, id, function: f }] });
const parseSse = text => text.split('\n\n').filter(s => s.startsWith('data: {')).map(s => JSON.parse(s.slice(6)));

test('最后一条 user 的文字只在工具结果里出现；保留媒体、历史、预填以及原请求', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } };
    const body = req({ messages: [{ role: 'user', content: '旧输入' }, { role: 'user', name: 'Alice',
        content: [image, { type: 'text', text: '材料一' }, { type: 'text', text: '材料二' }, image] },
        { role: 'assistant', content: '预填' }] });
    const original = structuredClone(body);
    const { messages, tools, tool_choice } = prepare(body, both).request;
    assert.deepEqual(body, original);
    assert.equal(messages[0].role, 'system');
    assert.deepEqual(messages[1], original.messages[0]);
    assert.deepEqual(messages[3], original.messages[2]);
    assert.equal(messages[2].name, 'Alice');
    assert.deepEqual(messages[2].content.filter(p => p.type === 'image_url'), [image, image]);
    const call = messages[4].tool_calls[0];
    assert.deepEqual(JSON.parse(messages[5].content), { request_id: JSON.parse(call.function.arguments).request_id, input: '材料一\n材料二' });
    assert.ok(messages[2].content.some(p => p.text?.includes(JSON.parse(call.function.arguments).request_id)));
    assert.equal(messages[5].tool_call_id, call.id);
    assert.equal(messages.at(-1).role, 'user');
    assert.deepEqual(tools.map(t => t.function.name), [READ, EMIT]);
    assert.equal(tool_choice, 'auto');
    assert.equal(JSON.stringify(messages).split('材料一').length, 2);
    assert.notEqual(prepare(body, both).request.messages[4].tool_calls[0].id, call.id);
});

test('图片输入和两种独立模式', async () => {
    const image = { type: 'image_url', image_url: { url: 'image' } };
    const original = req({ messages: [{ role: 'user', content: [image] }], stream: true });
    const response = new Response('未改变的流');
    const h = harness(body => {
        assert.equal(body.stream, true);
        assert.deepEqual(body.messages[0].content.filter(p => p.type !== 'text'), [image]);
        assert.equal(body.tool_choice, 'none');
        assert.equal(JSON.parse(body.messages.at(-1).content).input, '');
        return response;
    }, { input: true });
    assert.equal(await h.send(original), response);
    const out = prepare(original, { output: true }).request;
    assert.deepEqual(out.messages.at(-1).content[0], image);
    assert.deepEqual(out.tools.map(t => t.function.name), [EMIT]);
});

test('非流式只交付原样正文；保留用量及独立思考，没有额外请求', async () => {
    const h = harness(() => json(completed()));
    const reply = await (await h.send(req())).json();
    assert.equal(h.calls.length, 1);
    assert.equal(reply.choices[0].finish_reason, 'stop');
    assert.deepEqual(reply.choices[0].message, { role: 'assistant', content: answer, reasoning_content: '摘要' });
    assert.deepEqual(reply.usage, { total_tokens: 40 });
});

test('不接管外部请求、静默生成、其他工具、非工具型后处理和结构化输出', async () => {
    for (const [body, url, opts] of [
        [req(), 'https://elsewhere.invalid' + path], [req(), '/api/other'], [req(), path, {}],
        ...[{ type: 'quiet' }, { chat_completion_source: 'claude' }, { tools: [{}] }, { tool_choice: 'none' },
            { messages: [{ role: 'tool', content: 'x' }] }, { custom_prompt_post_processing: 'single' },
            { model: 'pg-gemini-3-pro-抗截断' },
            { __blueprint_tool_input: { id: 'script-owned' } },
            { json_schema: {} }, { n: 3 }, { request_images: true }, { enable_web_search: true }].map(v => [req(v), path]),
    ]) {
        const res = new Response('ok');
        const h = harness(b => { assert.deepEqual(b, body); return res; }, opts);
        assert.equal(await h.send(body, url), res);
    }
});

test('严格和半严格按最终 user 分组，将协议写入初始系统区末尾，结果原文压轴', () => {
    for (const processing of ['strict', 'strict_tools', 'semi', 'semi_tools']) {
        const b = req({ custom_prompt_post_processing: processing, messages: [
            { role: 'system', content: '角色卡' }, { role: 'system', content: '世界设定' },
            { role: 'user', content: '历史输入' }, { role: 'assistant', content: '上一轮' },
            { role: 'system', content: '时间线' }, { role: 'user', name: '玩家', content: '过桥' },
            { role: 'system', content: '<格式>两段</格式>' },
        ] });
        const { request, inputTurns } = prepare(b, both);
        assert.equal(inputTurns, 3);
        assert.equal(request.custom_prompt_post_processing, processing.split('_')[0] + '_tools');
        assert.equal(b.custom_prompt_post_processing, processing);
        assert.deepEqual(request.messages[0], b.messages[0]);
        assert.ok(request.messages[1].content.startsWith('世界设定\n\n'));
        assert.ok(request.messages[1].content.includes(EMIT));
        assert.equal(request.messages.at(-1).role, 'tool');
        assert.equal(JSON.parse(request.messages.at(-1).content).input, '时间线\n\n玩家: 过桥\n\n<格式>两段</格式>');
        assert.ok(request.messages.at(-3).content.includes(EMIT));
        assert.equal(JSON.stringify(request.messages).split('过桥').length, 2);
    }
});

test('首轮系统区、合并 user、尾部预填和继续生成', () => {
    const messages = [{ role: 'system', content: '设定一' }, { role: 'system', content: '设定二' },
        { role: 'user', content: 'A' }, { role: 'user', content: 'B' }, { role: 'system', content: '尾注' }];
    for (const [processing, expected] of [['strict', 'A\n\nB\n\n尾注'], ['merge', 'A\n\nB'], ['', 'B']]) {
        const plan = prepare(req({ messages, custom_prompt_post_processing: processing }), { input: true });
        assert.equal(JSON.parse(plan.request.messages.at(-1).content).input, expected);
    }
    const b = req({ messages: [...messages, { role: 'assistant', content: '预填' }], custom_prompt_post_processing: 'strict' });
    assert.equal(prepare(b, { input: true }).request.messages.at(-3).content, '预填');
    const cont = prepare({ ...b, type: 'continue' }, both);
    assert.equal(cont.inputTurns, 3);
    assert.deepEqual(cont.request.tools.map(t => t.function.name), [READ, EMIT]);
    const tail = prepare({ ...b, type: 'continue' }, { input: true }).request.messages.slice(-3);
    assert.equal(tail[0].content, '预填');
    assert.equal(tail[2].tool_call_id, tail[1].tool_calls[0].id);
    assert.deepEqual(JSON.parse(tail[2].content), { request_id: JSON.parse(tail[1].tool_calls[0].function.arguments).request_id, input: 'A\n\nB\n\n尾注' });
});

test('自动交付接受正常结束的纯正文，强制模式、截断和混杂回复仍然拒绝', async () => {
    for (const google of [false, true]) for (const streaming of [false, true]) {
        const b = req({ chat_completion_source: google ? 'makersuite' : 'custom', stream: streaming });
        const reply = () => google ? stream([{ candidates: [{ content: { parts: [{ text: answer }] }, finishReason: 'STOP' }] }])
            : streaming ? stream([chunk({ content: answer }), chunk({}, 'stop')])
            : json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: answer } }] });
        const h = harness(reply);
        const response = await h.send(b);
        assert.equal(response.status, 200);
        const frames = streaming ? parseSse(await response.text()) : null;
        assert.equal(streaming ? (google ? frames[0].candidates[0].content.parts[0].text : frames[0].choices[0].delta.content)
            : (await response.json()).choices[0].message.content, answer);
        const strict = harness(reply, { ...both, strictOutput: true });
        assert.equal((await strict.send(b)).status, 422);
        assert.equal(JSON.parse(strict.calls[0].init.body).tool_choice.function.name, EMIT);
    }
    for (const frames of [[chunk({ content: answer }), chunk({}, 'length')], [chunk({ content: answer }), toolChunk(fn()), chunk({}, 'stop')]]) {
        assert.equal((await harness(() => stream(frames)).send(req({ stream: true }))).status, 422);
    }
});

test('OpenAI 流：跨帧参数、分段函数名、用量尾帧；没有原始工具增量', async () => {
    const args = fn().arguments;
    const h = harness(() => stream([chunk({ reasoning_content: '想法' }), toolChunk({ name: 'kok_', arguments: args.slice(0, 9) }, 'call1'),
        toolChunk({ name: 'emit_answer', arguments: args.slice(9) }), chunk({}, 'tool_calls'), { choices: [], usage: { total_tokens: 99 } }]));
    const [frame] = parseSse(await (await h.send(req({ stream: true }))).text());
    assert.deepEqual(frame.choices[0].delta, { role: 'assistant', content: answer, reasoning_content: '想法' });
    assert.equal(frame.usage.total_tokens, 99);
});

test('自动输出在兼容接口取完整 JSON，再按酒馆流式协议交付', async () => {
    const h = harness(body => {
        assert.equal(body.stream, false);
        assert.equal(body.stream_options, undefined);
        return json(completed());
    });
    const res = await h.send(req({ stream: true, stream_options: { include_usage: true } }));
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const [frame] = parseSse(await res.text());
    assert.equal(frame.choices[0].delta.content, answer);
    assert.equal(frame.choices[0].delta.tool_calls, undefined);
    assert.equal(h.calls.length, 1);
});

test('Gemini：要求原生 STOP，向非流式和流式酒馆分别交付宿主格式', async () => {
    for (const clientStream of [false, true]) {
        const h = harness(body => {
            assert.equal(body.stream, true);
            return stream([{ candidates: [{ content: { parts: [{ thought: true, text: '摘要' }] } }] },
                { candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: EMIT, args: { content: answer } } }] } }] }], false);
        });
        const response = await h.send(req({ chat_completion_source: 'makersuite', stream: clientStream }));
        const parts = clientStream ? parseSse(await response.text()).flatMap(f => f.candidates[0].content.parts)
            : (await response.json()).responseContent.parts;
        assert.deepEqual(parts, [{ thought: true, text: '摘要' }, { text: answer }]);
    }
});

test('截断、未知工具、多调用、混入普通正文、伪调用或重复参数：明确失败不补发', async () => {
    for (const change of [
        c => c.finish_reason = 'length', c => c.finish_reason = null,
        c => c.message.tool_calls[0].function = fn('other'), c => c.message.tool_calls.push(c.message.tool_calls[0]),
        c => c.message.content = '普通文本', c => c.message.tool_calls = [],
        ...['{"content":', '{"content":42}', '{"content":"  "}', '{"content":"a","content":"b"}',
            '{"content":"a","extra":false}'].map(args => c => c.message.tool_calls[0].function = fn(EMIT, args)),
    ]) {
        const h = harness(() => { const data = completed(); change(data.choices[0]); return json(data); });
        const res = await h.send(req());
        assert.equal(res.status, 422);
        assert.match((await res.json()).error.message, /工具封装/);
        assert.equal(h.calls.length, 1);
    }
    for (const frames of [[toolChunk(fn())], [toolChunk(fn(), 'a'), toolChunk(fn(), 'b'), chunk({}, 'stop')],
        [toolChunk(fn()), chunk({}, 'length')], [{ error: true }]]) {
        assert.equal((await harness(() => stream(frames)).send(req({ stream: true }))).status, 422);
    }
    const gg = req({ chat_completion_source: 'vertexai' });
    assert.equal((await harness(() => stream([{ candidates: [{ finishReason: 'MAX_TOKENS' }] }])).send(gg)).status, 422);
});

test('上游 HTTP 错误和取消不重试，不篡改信号', async () => {
    const fail = new Response('后端错误', { status: 503 });
    assert.equal(await harness(() => fail).send(req()), fail);
    const controller = new AbortController();
    const h = harness((_b, init) => { assert.equal(init.signal, controller.signal); init.signal.throwIfAborted(); });
    controller.abort();
    await assert.rejects(h.send(req(), path, controller.signal), { name: 'AbortError' });
    assert.equal(h.calls.length, 1);
});
