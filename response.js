import { extractContent, invalid } from './envelope.js';

function checkFinish(reason) {
    if (reason !== 'tool_calls' && reason !== 'stop') invalid(
        reason === 'length' ? '达到输出上限，未交付残缺的正文。' : '没有收到正常结束标记，未交付正文。');
}

function visibleText(message) {
    if (!message || (message.role != null && message.role !== 'assistant') || message.refusal || message.function_call ||
        (message.content != null && typeof message.content !== 'string')) invalid('模型回复的内容格式不支持。');
    return message.content ?? '';
}

function acceptPlain(text, finish, allowPlain) {
    if (!allowPlain || finish !== 'stop' || !text.trim()) invalid('没有收到完整的正文工具调用。');
    return text;
}

function oneChoice(choices) {
    if (!Array.isArray(choices) || choices.length !== 1 || !choices[0] || (choices[0].index ?? 0) !== 0) {
        invalid('预期收到唯一的回复候选。');
    }
    return choices[0];
}

function unwrapJson(data, allowPlain) {
    const c = oneChoice(data?.choices);
    checkFinish(c.finish_reason);
    const m = c.message;
    const text = visibleText(m);
    if (m.tool_calls != null && !Array.isArray(m.tool_calls)) invalid('工具调用列表格式不正确。');
    if (!m.tool_calls?.length) {
        acceptPlain(text, c.finish_reason, allowPlain);
        const { tool_calls, ...message } = m;
        return { data: { ...data, choices: [{ ...c, message }] }, plain: true };
    }
    if (text.trim()) invalid('工具调用与普通正文混杂。');
    if (m.tool_calls?.length !== 1) invalid('需要一次且仅一次正文工具调用。');
    const [call] = m.tool_calls;
    if (call?.type !== 'function' || typeof call.function?.arguments !== 'string') invalid('工具调用格式不正确。');
    const content = extractContent(call.function.name, call.function.arguments);
    const { tool_calls, ...message } = m;
    return { data: { ...data, choices: [{ ...c, logprobs: null, finish_reason: 'stop', message: { ...message, content } }] }, plain: false };
}

// Read actual SSE frames, not HTTP chunks: a UTF-8 character, JSON escape or event
// separator can span reads. The stream belongs to this request and respects fetch abort.
async function* events(body) {
    if (!body) invalid('上游未返回响应体。');
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let eof = false;
    try {
        for (;;) {
            const chunk = await reader.read();
            eof = chunk.done;
            buffer += chunk.value ?? '';
            let boundary;
            while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
                const block = buffer.slice(0, boundary.index);
                buffer = buffer.slice(boundary.index + boundary[0].length);
                const data = block.split(/\r\n|\n|\r/).filter(l => l === 'data' || l.startsWith('data:'))
                    .map(l => l.replace(/^data:? ?/, '')).join('\n');
                if (!data) continue;
                if (data === '[DONE]') return;
                let event;
                try { event = JSON.parse(data); } catch { invalid('流中出现了不完整的 JSON 事件。'); }
                if (!event || typeof event !== 'object') invalid('收到无法识别的流事件。');
                if (event.error) invalid('上游在输出过程中返回了错误。');
                yield event;
            }
            if (eof) {
                if (buffer.trim() && !buffer.startsWith(':')) invalid('流在事件结束前断开。');
                return;
            }
        }
    } finally {
        if (!eof) await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

async function readOpenAI(body, allowPlain) {
    let name = '', args = '', callId, finish, usage, model, id;
    let text = '', sawCall = false;
    const thoughts = { reasoning: '', reasoning_content: '' };
    for await (const event of events(body)) {
        if (event.usage) usage = event.usage;
        model ??= event.model;
        id ??= event.id;
        if (event.choices?.length === 0) continue; // usage-only trailer
        const c = oneChoice(event.choices);
        const delta = c.delta ?? {};
        text += visibleText(delta);
        for (const key of Object.keys(thoughts)) {
            if (typeof delta[key] === 'string') thoughts[key] += delta[key];
        }
        if (delta.tool_calls != null && !Array.isArray(delta.tool_calls)) invalid('工具调用列表格式不正确。');
        if (delta.tool_calls?.length) {
            sawCall = true;
            if (finish || delta.tool_calls.length !== 1) invalid('同一回复出现了多次工具调用。');
            const call = delta.tool_calls[0];
            if (!call || (call.index ?? 0) !== 0 || (call.type && call.type !== 'function') ||
                (call.id && callId && call.id !== callId)) invalid('工具调用标识不一致。');
            if (call.id) callId = call.id;
            const fn = call.function ?? {};
            if ((fn.name != null && typeof fn.name !== 'string') ||
                (fn.arguments != null && typeof fn.arguments !== 'string')) invalid('工具增量格式不正确。');
            name += fn.name ?? '';
            args += fn.arguments ?? '';
        }
        if (c.finish_reason != null) {
            if (finish) invalid('同一回复出现了多个结束标记。');
            checkFinish(c.finish_reason);
            finish = c.finish_reason;
        }
    }
    checkFinish(finish);
    if (sawCall && text.trim()) invalid('工具调用与普通正文混杂。');
    const message = { role: 'assistant', content: sawCall ? extractContent(name, args) : acceptPlain(text, finish, allowPlain) };
    for (const [k, v] of Object.entries(thoughts)) if (v) message[k] = v;
    return { data: { id, model, usage, choices: [{ index: 0, message, finish_reason: 'stop' }] }, plain: !sawCall };
}

async function readGoogle(body, allowPlain) {
    let content, text = '', finished = false, usageMetadata;
    const thoughts = [];
    for await (const event of events(body)) {
        if (event.promptFeedback?.blockReason) invalid('上游未生成可交付的正文。');
        usageMetadata = event.usageMetadata ?? usageMetadata;
        if (!event.candidates?.length) continue;
        const c = oneChoice(event.candidates);
        for (const p of c.content?.parts ?? []) {
            if (p.functionCall) {
                if (finished || content !== undefined) invalid('同一回复出现了多次正文工具调用。');
                if (!p.functionCall.args || typeof p.functionCall.args !== 'object' ||
                    p.functionCall.partialArgs || p.functionCall.willContinue) invalid('未收到完整的 Gemini 函数参数。');
                content = extractContent(p.functionCall.name, p.functionCall.args);
            } else if (p.thought && typeof p.text === 'string') {
                thoughts.push(p);
            } else if (typeof p.text === 'string' && !p.thought) {
                text += p.text;
            } else if (p.inlineData || p.functionResponse || p.executableCode || p.codeExecutionResult) {
                invalid('模型返回了工具以外的内容，没有交付正文。');
            }
        }
        if (c.finishReason != null) {
            if (finished || c.finishReason !== 'STOP') invalid('Gemini 未正常完成工具答复。');
            finished = true;
        }
    }
    if (!finished) invalid('没有收到 Gemini 正常结束标记。');
    const plain = content === undefined;
    if (plain) content = acceptPlain(text, 'stop', allowPlain);
    else if (text.trim()) invalid('工具调用与普通正文混杂。');
    return { data: { choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        responseContent: { role: 'model', parts: [...thoughts, { text: content }] }, usageMetadata }, plain };
}

function replyResponse(original, body, mime) {
    const headers = new Headers(original.headers);
    for (const h of ['content-length', 'content-encoding', 'etag']) headers.delete(h);
    headers.set('content-type', mime);
    return new Response(body, { status: original.status, statusText: original.statusText, headers });
}

export async function unwrapResponse(response, plan) {
    if (!plan.output || !response.ok) return { response };
    const mime = response.headers.get('content-type') ?? '';
    let result;
    if (mime.includes('application/json') || (!plan.request.stream && !mime.includes('text/event-stream'))) {
        let raw;
        try { raw = await response.json(); } catch (e) {
            if (e.name !== 'SyntaxError') throw e;
            invalid('上游未返回完整的 JSON 响应。');
        }
        if (raw?.error) {
            // ST sometimes returns API errors with HTTP 200 (including for streaming requests).
            return { response: new Response(JSON.stringify(raw), { status: 502, headers: { 'content-type': 'application/json' } }) };
        }
        if (plan.google) invalid('预期 Gemini 返回含结束原因的事件流。');
        result = unwrapJson(raw, !plan.strictOutput);
    } else {
        result = await (plan.google ? readGoogle : readOpenAI)(response.body, !plan.strictOutput);
    }
    const { data, plain } = result;
    if (!plan.clientStream) return { response: replyResponse(response, JSON.stringify(data), 'application/json'), plain };
    // Never expose partial arguments or an executable tool call to ST's ToolManager.
    const frames = plan.google
        ? data.responseContent.parts.map((p, i, a) => ({ candidates: [{ index: 0, content: { role: 'model', parts: [p] },
            ...(i === a.length - 1 && { finishReason: 'STOP' }) }], ...(i === a.length - 1 && { usageMetadata: data.usageMetadata }) }))
        : [{ id: data.id, model: data.model, usage: data.usage, choices: [{ index: 0, delta: data.choices[0].message, finish_reason: 'stop' }] }];
    return { response: replyResponse(response, frames.map(f => 'data: ' + JSON.stringify(f) + '\n\n').join('') +
        'data: [DONE]\n\n', 'text/event-stream'), plain };
}
