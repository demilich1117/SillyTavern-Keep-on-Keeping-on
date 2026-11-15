import { EnvelopeError, prepare } from './envelope.js';
import { unwrapResponse } from './response.js';

const endpoint = '/api/backends/chat-completions/generate';

// Only ST's shared chat-completion route is eligible. Keep each caller's model,
// credentials, Request options and cancellation; never read unrelated traffic.
export function wrapFetch(next, origin, options, report = () => {}) {
    let sequence = 0;
    return async function (resource, init) {
        const pass = () => next.call(this, resource, init);
        const request = resource instanceof Request ? resource : null;
        if (!request && typeof resource !== 'string' && !(resource instanceof URL)) return pass();
        if ((init?.method ?? request?.method)?.toUpperCase() !== 'POST') return pass();
        let url;
        try { url = new URL(request ? request.url : resource, origin); } catch { return pass(); }
        if (url.origin !== origin || url.pathname !== endpoint) return pass();
        const mode = { ...options() };
        if (!mode.input && !mode.output) return pass();
        let raw = init?.body;
        if (raw == null && request) {
            // A clone keeps the caller's body intact, including on every bypass.
            try { raw = await request.clone().text(); } catch { return pass(); }
        }
        if (typeof raw !== 'string') return pass();
        let body;
        try { body = JSON.parse(raw); } catch { return pass(); }
        const detail = { id: ++sequence,
            type: typeof body?.type === 'string' && body.type ? body.type : '未标类型',
            model: typeof body?.model === 'string' ? body.model : '未指定模型',
            source: typeof body?.chat_completion_source === 'string' ? body.chat_completion_source : '未指定连接',
        };
        const update = message => report(message, detail);
        const plan = prepare(body, mode);
        if (!plan.request) {
            update('已跳过：' + plan.reason);
            return pass();
        }
        const parts = [];
        if (plan.inputTurns) {
            const processing = plan.request.custom_prompt_post_processing;
            parts.push('已封装 ' + plan.inputTurns + ' 条输入消息' + (processing ? '（' + processing + '）' : ''));
        } else if (mode.input) {
            parts.push('本轮仅处理输出');
        }
        update([...parts, plan.output ? '等待完整结果' : '等待响应'].join(' · '));
        try {
            const upstream = await next.call(this, resource, { ...init, body: JSON.stringify(plan.request) });
            const { response, plain } = await unwrapResponse(upstream, plan);
            if (response.ok) parts.push(plan.output ? (plain ? '模型直接返回结果' : '已提取工具结果') : '响应已交回调用方');
            if (!response.ok) parts.push('上游返回错误');
            update(parts.join(' · '));
            return response;
        } catch (e) {
            if (e instanceof EnvelopeError) {
                update(e.message);
                return new Response(JSON.stringify({ error: { message: '工具封装：' + e.message } }), {
                    status: 422, headers: { 'content-type': 'application/json' },
                });
            }
            const signal = init && Object.hasOwn(init, 'signal') ? init.signal : request?.signal;
            update(signal?.aborted || e.name === 'AbortError' ? '已停止生成' : '请求失败');
            throw e;
        }
    };
}
