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
    root.innerHTML = `
        <details>
            <summary class="inline-drawer-header"><b>Keep on Keeping on · 工具封装</b></summary>
            <div class="kok-panel">
                <div class="kok-options">
                    <label><span>封装本轮输入</span><input type="checkbox" data-option="input"></label>
                    <label><span>提取工具输出</span><input type="checkbox" data-option="output"></label>
                    <label class="kok-dependent" hidden><span>强制使用输出工具</span><input type="checkbox" data-option="strictOutput"></label>
                </div>
                <label><span>包含后台请求</span><input type="checkbox" data-option="background"></label>
                <details class="kok-history">
                    <summary>最近请求 <span data-history-count></span></summary>
                    <ul data-request-history role="log" aria-label="最近请求"><li>暂无请求记录</li></ul>
                </details>
            </div>
        </details>`;
    const strictRow = root.querySelector('.kok-dependent');
    const syncControls = () => {
        strictRow.hidden = settings().output !== true;
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
    const count = root.querySelector('[data-history-count]');
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
            const status = document.createElement('span');
            const meta = document.createElement('span');
            meta.className = 'kok-meta';
            const label = value => value.replace(/[\r\n\t]/g, ' ').slice(0, 100);
            meta.textContent = ['#' + detail.id, detail.type, detail.source, detail.model].map(label).join(' · ');
            entry.append(status, meta);
            entries.set(detail.id, entry);
            history.prepend(entry);
            if (entries.size > 8) {
                const oldest = entries.keys().next().value;
                entries.get(oldest).remove();
                entries.delete(oldest);
            }
            count.textContent = String(entries.size);
        }
        entry.firstElementChild.textContent = message;
    });
}

// At APP_READY the extension settings and their DOM container have both been loaded.
const { eventSource, eventTypes } = getContext();
eventSource.on(eventTypes.APP_READY, init);
