// Optional offline acceptance fixture. Point an isolated ST "Custom" connection at
// the printed URL and send exactly "封装验收" with both switches on.
import http from 'node:http';
import assert from 'node:assert/strict';
import { READ, EMIT } from '../envelope.js';

const port = Number(process.argv[2] || 18745);
const model = 'kok-fixture';
const text = '第一段：输入已收到。\n\n第二段：只交付正文。';
const server = http.createServer(async (req, res) => {
    const json = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
    };
    if (req.url === '/v1/models') return json(200, { data: [{ id: model, object: 'model' }] });
    const google = /^\/v1(beta)?\/models\/gemini-[^/]+:streamGenerateContent\?/.test(req.url);
    if ((!google && req.url !== '/v1/chat/completions') || req.method !== 'POST') return json(404, {});
    try {
        let raw = '';
        for await (const part of req) raw += part;
        const b = JSON.parse(raw);
        if (google) {
            const parts = b.contents.flatMap(t => t.parts);
            const call = parts.find(p => p.functionCall?.name === READ)?.functionCall;
            const result = parts.find(p => p.functionResponse?.name === READ)?.functionResponse;
            assert.ok(parts.some(p => p.text?.includes(call.args.request_id)));
            assert.match(result.response.content, /封装验收/);
            assert.ok(!parts.some(p => p.text?.includes('封装验收')));
            assert.ok(b.tools.some(t => t.function_declarations?.some(f => f.name === EMIT)));
            assert.ok(['AUTO', 'ANY'].includes(b.toolConfig.functionCallingConfig.mode));
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            return res.end('data: ' + JSON.stringify({ candidates: [{ index: 0, finishReason: 'STOP', content: {
                role: 'model', parts: [{ functionCall: { name: EMIT, args: { content: text } } }] } }] }) + '\n\n');
        }
        const user = b.messages.findLast(m => m.role === 'tool');
        const call = b.messages[b.messages.indexOf(user) - 1].tool_calls[0];
        assert.equal(call.function.name, READ);
        assert.equal(call.id, user.tool_call_id);
        const id = JSON.parse(call.function.arguments).request_id;
        assert.ok(b.messages.some(m => JSON.stringify(m.content)?.includes(id)));
        assert.match(user.content, /封装验收/);
        assert.ok(!b.messages.filter(m => m.role !== 'tool').some(m => JSON.stringify(m.content).includes('封装验收')));
        assert.ok(b.tools.some(t => t.function.name === EMIT));
        assert.ok(b.tool_choice === 'auto' || b.tool_choice?.function?.name === EMIT);
        const f = { name: EMIT, arguments: JSON.stringify({ content: text }) };
        if (b.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {
                tool_calls: [{ id: 'call_fixture', index: 0, type: 'function', function: f }] }, finish_reason: null }] }) + '\n\n');
            res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
        } else {
            json(200, { model, choices: [{ index: 0, message: { role: 'assistant', content: null,
                tool_calls: [{ type: 'function', id: 'call_fixture', function: f }] }, finish_reason: 'tool_calls' }] });
        }
    } catch {
        json(400, { error: { message: '验收请求未包含配对的读取记录和正文工具。' } });
    }
});
server.listen(port, '127.0.0.1', () => console.log('Offline fixture: http://127.0.0.1:' + port + '/v1'));
