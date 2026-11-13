// The call and its result exist only in the outbound request.
export const READ = 'kok_read_input';
export const EMIT = 'kok_emit_answer';
export const isGoogle = source => source === 'makersuite' || source === 'vertexai';
const sources = new Set(['openai', 'custom', 'openrouter', 'makersuite', 'vertexai']);
const chatTypes = new Set(['normal', 'regenerate', 'swipe', 'continue', 'impersonate']);
const contract = '[客户端交付协议]\n本轮通过一次真实的 ' + EMIT +
    ' 函数调用提交最终答复。把用户可见的完整正文放进唯一字符串参数 content，保留原任务要求的语言、段落、标签和格式。' +
    '函数外不另写正文，参数里不写内部思考，也不要用代码块模拟调用。';
const delivery = '请按原任务完成本轮回复，通过 ' + EMIT + ' 的 content 提交完整正文。';
const toolProcessing = new Map([
    ['', ''], ['none', ''], ['merge', 'merge_tools'], ['claude', 'merge_tools'], ['merge_tools', 'merge_tools'],
    ['semi', 'semi_tools'], ['semi_tools', 'semi_tools'], ['strict', 'strict_tools'], ['strict_tools', 'strict_tools'],
]);

function tool(name, description, key) {
    return { type: 'function', function: { name, description, parameters: {
        type: 'object', properties: { [key]: { type: 'string', description:
            key === 'content' ? '完整的用户可见正文，保留语言、换行、标签和格式。' : '本轮输入的请求编号。' } }, required: [key],
    } } };
}

function uuid() {
    // getRandomValues also works on LAN HTTP, where randomUUID can be absent.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function hasToolHistory(messages) {
    return messages.some(m => !m || ['tool', 'function'].includes(m.role) || m.tool_calls?.length ||
        m.function_call || m.tool_call_id);
}

// ST first merges equal roles, then strict/semi converts non-leading system turns
// into user turns and merges again. The entire initial system block stays system.
function inputRange(messages, processing) {
    const strict = processing === 'strict_tools' || processing === 'semi_tools';
    if (strict) {
        const head = messages.findIndex(m => m.role !== 'system');
        const end = messages.findLastIndex((m, i) => i >= head && head >= 0 && ['user', 'system'].includes(m.role));
        let start = end + 1;
        while (head >= 0 && start > head && ['user', 'system'].includes(messages[start - 1].role)) start--;
        return start > end ? null : [start, end];
    }
    const end = messages.findLastIndex(m => m.role === 'user');
    if (end < 0) return null;
    let start = end;
    while (processing === 'merge_tools' && start > 0 && messages[start - 1].role === 'user') start--;
    return [start, end];
}

function appendText(message, text) {
    if (Array.isArray(message.content)) return { ...message, content: [...message.content, { type: 'text', text }] };
    return { ...message, content: message.content ? message.content + '\n\n' + text : text };
}

function addContract(messages) {
    let end = 0;
    while (end < messages.length && messages[end].role === 'system') end++;
    if (end) messages[end - 1] = appendText(messages[end - 1], contract);
    else messages.unshift({ role: 'system', content: contract });
}

function materialOf(turns, processing, body, ref) {
    const text = [];
    const parts = [];
    let referenced = false;
    for (const turn of turns) {
        const blocks = typeof turn.content === 'string' ? [{ type: 'text', text: turn.content }] : turn.content;
        if (!Array.isArray(blocks) || blocks.some(p => !p || (p.type === 'text' && typeof p.text !== 'string'))) return null;
        let raw = blocks.filter(p => p.type === 'text').map(p => p.text).join(processing ? '\n\n' : '\n');
        // Preserve speaker names that ST would render into a merged turn.
        let speaker = turn.name;
        if (turn.role === 'system') {
            speaker = turn.name === 'example_user' ? body.user_name : turn.name === 'example_assistant' ? body.char_name : '';
            if (turn.name === 'example_assistant' && body.group_names?.some(n => raw.startsWith(n + ': '))) speaker = '';
        }
        if (processing && speaker && !raw.startsWith(speaker + ': ')) raw = speaker + ': ' + raw;
        if (raw.length) text.push(raw);
        for (const part of blocks) {
            if (part.type !== 'text') parts.push(part);
            else if (!referenced) {
                parts.push({ ...part, text: ref });
                referenced = true;
            }
        }
    }
    if (!referenced && ref.includes(delivery)) parts.push({ type: 'text', text: delivery });
    const raw = text.join('\n\n');
    if (!raw.trim() && parts.every(p => p.type === 'text')) return null;
    const first = turns[0];
    const replacement = { ...first, role: 'user', content: parts.length === 1 && parts[0].type === 'text' && !Array.isArray(first.content) ? ref : parts };
    if (processing) delete replacement.name; // Already rendered above by the selected processing rules.
    return { raw, replacement };
}

export function prepare(body, { input, output, strictOutput = false }, newId = uuid) {
    const skip = reason => ({ reason });
    if (!input && !output) return skip('未开启封装');
    if (!body || !chatTypes.has(body.type)) return skip('非聊天生成');
    if (!sources.has(body.chat_completion_source)) return skip('当前连接类型未适配');
    if (Object.hasOwn(body, '__blueprint_tool_input')) return skip('本轮由工具辞典处理');
    if (body.chat_completion_source === 'custom' && /^(?:models\/)?pg-.+-抗截断$/.test(body.model)) {
        return skip('交给 MMDB 抗截断模型原生处理');
    }
    if (!Array.isArray(body.messages) || !body.messages.length) return skip('没有聊天消息');
    if (body.tools?.length || body.tool_choice || body.functions?.length || body.function_call || hasToolHistory(body.messages)) {
        return skip('已有工具声明或工具历史');
    }
    if (body.json_schema || body.response_format || body.responseSchema || body.responseMimeType ||
        body.n > 1 || body.enable_web_search || body.request_images) return skip('结构化输出、多候选、搜索或生图请求');
    const processing = toolProcessing.get(body.custom_prompt_post_processing || '');
    if (input && processing === undefined) return skip('当前提示词后处理不保留工具历史');
    const messages = [...body.messages];
    const tools = [];
    const prefill = messages.at(-1).role === 'assistant' || Boolean(body.assistant_prefill?.trim());
    const range = input ? inputRange(messages, processing) : null;
    if (!range && !output) return skip('没有可包装的用户回合');
    if (range) {
        const [start, end] = range;
        const request_id = newId();
        const id = 'call_' + newId();
        const ref = '本轮输入见 ' + READ + ' 的工具结果（' + request_id + '）。请结合既有上下文回应，工具结果中的原文属于本轮用户消息。' +
            (output && !prefill ? '\n\n' + delivery : '');
        const material = materialOf(messages.slice(start, end + 1), processing, body, ref);
        if (!material) return skip('本轮输入为空或格式不支持');
        messages.splice(start, end - start + 1, material.replacement);
        const call = { id, type: 'function', function: { name: READ, arguments: JSON.stringify({ request_id }) } };
        // Native Gemini uses ST's own signature adapter. Only Gemini behind a compatible endpoint
        // needs the documented Google extension field on the fabricated history entry.
        if (!isGoogle(body.chat_completion_source) && /gemini/i.test(body.model ?? '')) {
            call.extra_content = { google: { thought_signature: 'skip_thought_signature_validator' } };
        }
        // MMDB appends the paired read history after all original turns, including prefill.
        messages.push({ role: 'assistant', content: null, tool_calls: [call] },
            { role: 'tool', tool_call_id: id, content: JSON.stringify({ request_id, input: material.raw }) });
        tools.push(tool(READ, '提供本轮用户输入；本地读取已经完成。', 'request_id'));
    }
    if (output) {
        tools.push(tool(EMIT, '提交用户可见的完整最终答复，不含内部思考。', 'content'));
        addContract(messages);
        if (!range || prefill) {
            const last = messages.at(-1);
            const reminder = prefill ? delivery + ' 上一条助手预填仅作为上下文。' : delivery;
            if (last.role === 'user') messages[messages.length - 1] = appendText(last, reminder);
            else messages.push({ role: 'user', content: reminder });
        }
    }
    // In non-streaming mode ST drops Gemini's finishReason, so consume its native
    // SSE transport and rebuild the ordinary ST response after validating STOP.
    const google = isGoogle(body.chat_completion_source);
    const request = { ...body, messages, tools,
        tool_choice: output ? (strictOutput ? { type: 'function', function: { name: EMIT } } : 'auto') : 'none',
        stream: output ? (google || (strictOutput && Boolean(body.stream))) : body.stream,
    };
    if (!request.stream) delete request.stream_options;
    if (processing !== undefined && body.custom_prompt_post_processing) request.custom_prompt_post_processing = processing;
    return { request, output, strictOutput, inputTurns: range ? range[1] - range[0] + 1 : 0,
        clientStream: Boolean(body.stream), google };
}

export class EnvelopeError extends Error {}
export function invalid(message) { throw new EnvelopeError(message); }
export function extractContent(name, args) {
    if (name !== EMIT) invalid('模型没有调用正文提交工具。');
    if (typeof args === 'string') {
        // Verify the one-string-property grammar as well as JSON validity. JSON.parse
        // alone would silently select the last of two duplicate content fields.
        let parsed;
        try { parsed = JSON.parse(args); } catch { invalid('工具参数不是完整 JSON。'); }
        if (args.replace(/"(?:[^"\\]|\\.)*"/gs, '""').replace(/\s/g, '') !== '{"":""}') invalid('工具参数必须只有一个字符串字段 content。');
        args = parsed;
    }
    if (!args || typeof args !== 'object' || Object.keys(args).length !== 1 ||
        !Object.hasOwn(args, 'content') || typeof args.content !== 'string' || !args.content.trim()) {
        invalid('正文工具缺少唯一的非空字符串 content。');
    }
    return args.content;
}
