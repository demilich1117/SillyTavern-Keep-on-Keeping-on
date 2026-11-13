import { wrapFetch } from './transport.js';

const key = 'keep_on_keeping_on';
const rootId = 'kok-envelope-settings';
const getContext = () => SillyTavern.getContext();
function settings() {
    return getContext().extensionSettings[key] ??= { input: false, output: false };
}
function init() {
    const container = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    if (!container || document.getElementById(rootId)) return;
    const root = document.createElement('div');
    root.id = rootId;
    root.innerHTML = '<details><summary class="inline-drawer-header"><b>Keep on Keeping on · 工具封装</b></summary>' +
        '<label class="checkbox_label"><input type="checkbox" data-option="input">把本轮输入放进工具结果</label>' +
        '<label class="checkbox_label"><input type="checkbox" data-option="output">用工具提交并提取回复正文</label>' +
        '<label class="checkbox_label"><input type="checkbox" data-option="strictOutput">强制模型调用正文工具</label>' +
        '<p><small>默认也接收模型正常结束时直接返回的正文。勾选强制调用后，仅接收工具正文。</small></p>' +
        '<p><small>最近请求：<span role="status">尚无</span></small></p></details>';
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
    const status = root.querySelector('[role="status"]');
    window.fetch = wrapFetch(window.fetch, window.location.origin, settings, message => { status.textContent = message; });
}

// At APP_READY the extension settings and their DOM container have both been loaded.
const { eventSource, eventTypes } = getContext();
eventSource.on(eventTypes.APP_READY, init);
