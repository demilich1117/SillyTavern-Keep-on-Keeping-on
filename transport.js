import { EnvelopeError, prepare } from './envelope.js';
import { unwrapResponse } from './response.js';

const endpoint = '/api/backends/chat-completions/generate';

// This is the string URL + JSON BodyInit contract used by ST's sendOpenAIRequest.
// Stay transparent to Request objects, other extensions' network traffic and other origins.
export function wrapFetch(next, origin, options, report = () => {}) {
    return async function (resource, init) {
        const pass = () => next.call(this, resource, init);
        if (typeof resource !== 'string' && !(resource instanceof URL)) return pass();
        if (init?.method?.toUpperCase() !== 'POST' || typeof init.body !== 'string') return pass();
        const url = new URL(resource, origin);
        if (url.origin !== origin || url.pathname !== endpoint) return pass();
        const mode = options();
        if (!mode.input && !mode.output) return pass();
        let body;
        try { body = JSON.parse(init.body); } catch { return pass(); }
        const plan = prepare(body, mode);
        if (!plan.request) {
            if (body?.type !== 'quiet') report('已跳过：' + plan.reason);
            return pass();
        }
        const parts = [];
        if (plan.inputTurns) {
            const processing = plan.request.custom_prompt_post_processing;
            parts.push('已封装 ' + plan.inputTurns + ' 条输入消息' + (processing ? '（' + processing + '）' : ''));
        } else if (mode.input) {
            parts.push('本轮仅处理输出');
        }
        if (plan.output) report([...parts, '等待完整正文'].join(' · '));
        else report(parts.join(' · '));
        try {
            const upstream = await next.call(this, resource, { ...init, body: JSON.stringify(plan.request) });
            const { response, plain } = await unwrapResponse(upstream, plan);
            if (response.ok && plan.output) parts.push(plain ? '模型直接返回正文' : '已提取工具正文');
            if (!response.ok) parts.push('上游返回错误');
            report(parts.join(' · '));
            return response;
        } catch (e) {
            if (e instanceof EnvelopeError) {
                report(e.message);
                return new Response(JSON.stringify({ error: { message: '工具封装：' + e.message } }), {
                    status: 422, headers: { 'content-type': 'application/json' },
                });
            }
            report(init.signal?.aborted || e.name === 'AbortError' ? '已停止生成' : '请求失败');
            throw e;
        }
    };
}
