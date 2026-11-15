import { wrapFetch } from './transport.js';

const key = 'keep_on_keeping_on';
const rootId = 'kok-envelope-settings';
const getContext = () => SillyTavern.getContext();
function settings() {
    return getContext().extensionSettings[key] ??= { input: false, output: false, background: false };
}
function init() {
    const container = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    if (!container || document.getElementById(rootId)) return;
    const root = document.createElement('div');
    root.id = rootId;
    root.innerHTML = '<details><summary class="inline-drawer-header"><b>Keep on Keeping on · 工具封装</b></summary>' +
        '<label class="checkbox_label"><input type="checkbox" data-option="input">把本轮输入放进工具结果</label>' +
        '<label class="checkbox_label"><input type="checkbox" data-option="output">用工具提交并提取任务结果</label>' +
        '<label class="checkbox_label"><input type="checkbox" data-option="strictOutput">强制模型调用结果工具</label>' +
        '<p><small>默认也接收模型正常结束时直接返回的结果。开启输出封装后，完整结果校验完再交回，保留原任务要求的格式。</small></p>' +
        '<label class="checkbox_label"><input type="checkbox" data-option="background">也处理后台／未标类型请求</label>' +
        '<p><small>用于通过酒馆聊天补全接口发出的总结、填表、小剧场等任务，沿用各自的模型和 API。已有工具或结构化输出约束时自动跳过。助手发出的 normal 请求原本就受上方开关控制。</small></p>' +
        '<p><small>最近请求（最多 8 条，刷新清空）：</small></p>' +
        '<ul data-request-history role="log" aria-live="polite" aria-label="工具封装最近请求" style="padding-left:1.4em;overflow-wrap:anywhere;font-size:0.85em"><li>尚无</li></ul></details>';
    const syncControls = () => {
        root.querySelector('[data-option="strictOutput"]').disabled = !settings().output;
    };
    for (const el of root.querySelectorAll('input[data-option]')) {
        const option = el.dataset.option;
        el.checked = settings()[option] === true;
        el.addEventListener('change', () => {
            settings()[option] = el.checked;
            syncControls();
            getContext().saveSettingsDebounced();
        });
    }
    syncControls();
    container.append(root);
    const history = root.querySelector('[data-request-history]');
    const entries = new Map();
    let newestId = 0;
    window.fetch = wrapFetch(window.fetch, window.location.origin, settings, (message, detail) => {
        let entry = entries.get(detail.id);
        if (!entry) {
            // A slow request that has fallen out of the list must not displace
            // newer requests when it eventually completes.
            if (detail.id <= newestId) return;
            if (!entries.size) history.replaceChildren();
            newestId = detail.id;
            entry = document.createElement('li');
            entries.set(detail.id, entry);
            history.prepend(entry);
            if (entries.size > 8) {
                const oldest = entries.keys().next().value;
                entries.get(oldest).remove();
                entries.delete(oldest);
            }
        }
        const label = value => value.replace(/[\r\n\t]/g, ' ').slice(0, 100);
        entry.textContent = '#' + detail.id + ' · ' + label(detail.type) + ' · ' + label(detail.source) +
            ' · ' + label(detail.model) + '：' + message;
    });
}

// At APP_READY the extension settings and their DOM container have both been loaded.
const { eventSource, eventTypes } = getContext();
eventSource.on(eventTypes.APP_READY, init);
