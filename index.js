import {
    ALLOWED_PRESETS,
    MAX_CUSTOM_INSTRUCTIONS,
    MAX_INPUT_BYTES,
    buildChatIdentity,
    buildChatReadbackRequest,
    buildTransformPayload,
    clearPendingAttempt,
    createRequestId,
    extensionForMimeType,
    extractTransformResult,
    isLifecycleGenerationCurrent,
    normalizeMimeType,
    parseImageDataUrl,
    readPendingAttempt,
    removeExtensionSettings,
    requiresPaidRetryConfirmation,
    verifyChatPersistenceReadback,
    verifyPendingAttempt,
    withCrossTabPaidLock,
    writePendingAttempt,
} from './utils.mjs';
import { editImage, validateProviderConfig } from './provider.mjs';

const EXTENSION_ID = 'cloud-realify';
const SETTINGS_KEY = 'cloudRealify';
const ROOT_ID = 'cloud-realify-root';
const IMAGE_UPLOAD_ENDPOINT = '/api/images/upload';

const PROVIDER_DEFAULTS = Object.freeze({
    venice: Object.freeze({ baseUrl: 'https://api.venice.ai', model: 'qwen-edit-uncensored' }),
    openai: Object.freeze({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1' }),
});

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    preset: 'photoreal',
    customInstructions: '',
    safeMode: true,
    saveToChat: true,
    provider: 'venice',
    baseUrl: PROVIDER_DEFAULTS.venice.baseUrl,
    model: PROVIDER_DEFAULTS.venice.model,
});

const PRESET_LABELS = Object.freeze({
    photoreal: '自然写实',
    cinematic: '电影感写实',
    'soft-portrait': '柔和人像',
});

const chatInstanceTokens = new WeakMap();
let chatInstanceSequence = 0;

const state = {
    lifecycleGeneration: 0,
    active: false,
    mounted: false,
    context: null,
    settings: null,
    root: null,
    elements: Object.create(null),
    cleanupCallbacks: [],
    mutationObserver: null,
    decorateScheduled: false,
    selectedSource: null,
    selectedPreviewUrl: null,
    result: null,
    resultObjectUrl: null,
    operation: null,
    transformController: null,
    persistenceController: null,
    inFlight: false,
    persistenceInFlight: false,
    requiresPaidRetryConfirmation: false,
    pendingLockReplacementAuthorized: false,
    // Never copy this field into settings, chat, storage, or diagnostic output.
    apiKey: '',
    connectionConfigured: false,
};

function isCurrentLifecycle(generation) {
    return isLifecycleGenerationCurrent({
        capturedGeneration: generation,
        currentGeneration: state.lifecycleGeneration,
        active: state.active,
        mounted: state.mounted,
    });
}

function assertCurrentLifecycle(generation) {
    if (isCurrentLifecycle(generation)) return;
    const error = new Error('Cloud Realify lifecycle changed while an asynchronous operation was running.');
    error.name = 'AbortError';
    error.code = 'lifecycle_stale';
    throw error;
}

function createElement(tagName, options = {}, children = []) {
    const element = document.createElement(tagName);
    if (options.id) element.id = options.id;
    if (options.className) element.className = options.className;
    if (options.text !== undefined) element.textContent = String(options.text);
    if (options.type) element.type = options.type;
    if (options.name) element.name = options.name;
    if (options.value !== undefined) element.value = String(options.value);
    if (options.title) element.title = options.title;
    if (options.hidden) element.hidden = true;
    if (options.disabled) element.disabled = true;

    for (const [name, value] of Object.entries(options.attributes ?? {})) {
        element.setAttribute(name, String(value));
    }

    for (const child of children) {
        if (child === null || child === undefined) continue;
        element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }

    return element;
}

function makeButton(text, className = '') {
    return createElement('button', {
        type: 'button',
        className,
        text,
    });
}

function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    state.cleanupCallbacks.push(() => target.removeEventListener(type, handler, options));
}

function getHostContext() {
    const getContext = globalThis.SillyTavern?.getContext;
    if (typeof getContext !== 'function') {
        throw new Error('当前 SillyTavern 未提供 getContext()，需要 1.18.0 或更高版本。');
    }

    return getContext();
}

function freshContext() {
    return getHostContext();
}

function currentChatId(context) {
    let currentChatId;
    try {
        currentChatId = typeof context.getCurrentChatId === 'function'
            ? context.getCurrentChatId()
            : context.chatId;
    } catch {
        currentChatId = context.chatId;
    }
    if (currentChatId === undefined) currentChatId = context.chatId;
    return currentChatId;
}

function captureChatPersistenceTarget(context) {
    const character = context?.characters?.[context.characterId];
    return Object.freeze({
        chatId: currentChatId(context),
        groupId: context.groupId,
        characterName: character?.name ?? context.name2 ?? '',
        avatarUrl: character?.avatar ?? context.avatarUrl ?? context.avatar_url ?? '',
    });
}

function chatIdentity(context = freshContext()) {
    const currentId = currentChatId(context);

    let chatInstanceToken = '<no-chat-array>';
    if (context.chat && typeof context.chat === 'object') {
        chatInstanceToken = chatInstanceTokens.get(context.chat);
        if (!chatInstanceToken) {
            chatInstanceSequence += 1;
            chatInstanceToken = `chat-ref-${chatInstanceSequence}`;
            chatInstanceTokens.set(context.chat, chatInstanceToken);
        }
    }

    return buildChatIdentity({
        chatId: currentId,
        groupId: context.groupId,
        characterId: context.characterId,
        characterName: context.name2,
        chatInstanceToken,
    });
}

function assertOriginChat(originIdentity, phase) {
    const context = freshContext();
    if (!originIdentity || chatIdentity(context) !== originIdentity) {
        const error = new Error(`生成期间当前聊天已切换，已停止${phase}。图片仍可预览和下载。`);
        error.code = 'origin_chat_changed';
        throw error;
    }
    return context;
}

function getPendingAttemptStorage() {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

function setPaidRetryConfirmation(message) {
    state.requiresPaidRetryConfirmation = true;
    if (state.elements.confirmPaidRetryButton) state.elements.confirmPaidRetryButton.hidden = false;
    updateEnabledState();
    if (message) setStatus('warning', message);
}

function restorePendingAttemptGuard() {
    const pending = readPendingAttempt(getPendingAttemptStorage());
    if (pending.status === 'empty') return;

    if (pending.status === 'unavailable') {
        setPaidRetryConfirmation('浏览器无法使用本地付费保护存储。为避免重复扣费，扩展不会发起云端请求；请允许本站使用本地存储后重试。');
        return;
    }
    if (pending.status === 'corrupt') {
        setPaidRetryConfirmation('检测到损坏的付费请求保护记录。扩展不会自动重试；请确认没有仍在处理的请求后，点击“确认发起新的付费尝试”。');
        return;
    }

    const time = pending.lock?.timestamp
        ? new Date(pending.lock.timestamp).toLocaleString()
        : '未知时间';
    setPaidRetryConfirmation(`检测到 ${time} 留下的结果未确认请求。它可能已经计费；只有点击“确认发起新的付费尝试”才会替换保护记录并创建新请求。`);
}

function acquirePendingAttemptLock(requestId, allowReplacement) {
    const storage = getPendingAttemptStorage();
    const current = readPendingAttempt(storage);
    if (current.status === 'unavailable') {
        const error = new Error('浏览器无法写入本地付费保护记录，已阻止云端请求。');
        error.code = 'pending_lock_storage_unavailable';
        throw error;
    }
    if (current.status !== 'empty' && !allowReplacement) {
        const error = new Error('存在未确认的付费请求保护记录，必须先明确确认新的付费尝试。');
        error.code = 'pending_lock_confirmation_required';
        throw error;
    }

    const written = writePendingAttempt(storage, requestId);
    if (!written.ok || !verifyPendingAttempt(storage, requestId)) {
        const error = new Error('无法可靠保存付费请求保护记录，已阻止云端请求。');
        error.code = 'pending_lock_write_failed';
        throw error;
    }
    return storage;
}

function releasePendingAttemptLock(storage, requestId) {
    const cleared = clearPendingAttempt(storage, requestId);
    return cleared.ok && (cleared.cleared || cleared.reason === null);
}

function sanitizeSettings(existing) {
    const merged = {
        ...DEFAULT_SETTINGS,
        ...(existing && typeof existing === 'object' ? existing : {}),
    };

    merged.enabled = merged.enabled !== false;
    merged.preset = ALLOWED_PRESETS.includes(merged.preset) ? merged.preset : DEFAULT_SETTINGS.preset;
    merged.customInstructions = String(merged.customInstructions ?? '').slice(0, MAX_CUSTOM_INSTRUCTIONS);
    merged.safeMode = merged.safeMode !== false;
    merged.saveToChat = merged.saveToChat !== false;
    merged.provider = Object.hasOwn(PROVIDER_DEFAULTS, merged.provider) ? merged.provider : DEFAULT_SETTINGS.provider;
    const defaults = PROVIDER_DEFAULTS[merged.provider];
    merged.model = typeof merged.model === 'string' && merged.model.trim()
        ? merged.model.trim().slice(0, 200) : defaults.model;
    try {
        // Validate the ordinary setting without importing or persisting any real key.
        merged.baseUrl = validateProviderConfig({
            provider: merged.provider,
            baseUrl: merged.baseUrl,
            model: defaults.model,
            apiKey: 'configuration-check-only',
        }).baseUrl;
    } catch {
        merged.baseUrl = defaults.baseUrl;
    }
    delete merged.apiKey;
    return merged;
}

function initializeSettings(context) {
    if (!context.extensionSettings || typeof context.extensionSettings !== 'object') {
        throw new Error('当前 SillyTavern 未提供 extensionSettings。');
    }

    const existing = context.extensionSettings[SETTINGS_KEY];
    const settings = sanitizeSettings(existing);
    context.extensionSettings[SETTINGS_KEY] = settings;

    if (JSON.stringify(existing ?? null) !== JSON.stringify(settings)) {
        context.saveSettingsDebounced?.();
    }

    return settings;
}

function saveSettings() {
    let context = state.context;
    try {
        context = freshContext();
    } catch {
        // Keep the mount-time context only as a settings fallback during teardown.
    }
    if (context?.extensionSettings) {
        context.extensionSettings[SETTINGS_KEY] = state.settings;
    }
    context?.saveSettingsDebounced?.();
}

function getRequestHeaders(context = freshContext()) {
    const headers = new Headers();
    if (typeof context?.getRequestHeaders === 'function') {
        const hostHeaders = context.getRequestHeaders();
        new Headers(hostHeaders).forEach((value, key) => headers.set(key, value));
    }
    headers.set('Content-Type', 'application/json');
    return headers;
}

function buildUi() {
    const root = createElement('div', { id: ROOT_ID, className: 'cloud-realify' });
    const fab = makeButton('写实化', 'cloud-realify__fab');
    fab.setAttribute('aria-haspopup', 'dialog');
    fab.setAttribute('aria-controls', 'cloud-realify-dialog');

    const overlay = createElement('div', {
        className: 'cloud-realify__overlay',
        hidden: true,
        attributes: { 'aria-hidden': 'true' },
    });
    const dialog = createElement('section', {
        id: 'cloud-realify-dialog',
        className: 'cloud-realify__sheet',
        attributes: {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'cloud-realify-title',
        },
    });

    const title = createElement('h2', {
        id: 'cloud-realify-title',
        className: 'cloud-realify__title',
        text: '云端写实化',
    });
    const closeButton = makeButton('关闭', 'cloud-realify__icon-button');
    closeButton.setAttribute('aria-label', '关闭云端写实化面板');
    const header = createElement('header', { className: 'cloud-realify__header' }, [title, closeButton]);

    const providerStatus = createElement('p', {
        className: 'cloud-realify__provider-status',
        text: '请先填写连接设置和 API Key。',
        attributes: { 'aria-live': 'polite' },
    });

    const connectionDetails = createElement('details', { id: 'cloud-realify-connection', className: 'cloud-realify__connection' });
    connectionDetails.open = !state.apiKey;
    const connectionSummary = createElement('summary', { text: '连接设置' });
    const providerSelect = createElement('select', {
        id: 'cloud-realify-provider',
        className: 'cloud-realify__select',
        attributes: { 'aria-label': '服务商' },
    }, [
        createElement('option', { value: 'venice', text: 'Venice' }),
        createElement('option', { value: 'openai', text: 'OpenAI-compatible' }),
    ]);
    const baseUrlInput = createElement('input', {
        id: 'cloud-realify-base-url',
        type: 'url',
        className: 'cloud-realify__input',
        attributes: { autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: '2048' },
    });
    const modelInput = createElement('input', {
        id: 'cloud-realify-model',
        type: 'text',
        className: 'cloud-realify__input',
        attributes: { autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: '200' },
    });
    const apiKeyInput = createElement('input', {
        id: 'cloud-realify-api-key',
        type: 'password',
        className: 'cloud-realify__input',
        attributes: {
            autocomplete: 'new-password',
            autocapitalize: 'none',
            spellcheck: 'false',
            maxlength: '4096',
            placeholder: '仅当前页面使用，不保存',
            'data-lpignore': 'true',
            'data-1p-ignore': 'true',
        },
    });
    const clearKeyButton = makeButton('清除 Key', 'cloud-realify__secondary-button');
    clearKeyButton.id = 'cloud-realify-clear-key';
    const corsHint = createElement('p', { className: 'cloud-realify__connection-note' });
    const connectionFields = createElement('div', { className: 'cloud-realify__connection-fields' }, [
        createElement('label', { className: 'cloud-realify__field' }, [
            createElement('span', { className: 'cloud-realify__field-title', text: '服务商' }), providerSelect,
        ]),
        createElement('label', { className: 'cloud-realify__field' }, [
            createElement('span', { className: 'cloud-realify__field-title', text: 'HTTPS Base URL' }), baseUrlInput,
        ]),
        createElement('label', { className: 'cloud-realify__field' }, [
            createElement('span', { className: 'cloud-realify__field-title', text: '模型 ID' }), modelInput,
        ]),
        createElement('label', { className: 'cloud-realify__field' }, [
            createElement('span', { className: 'cloud-realify__field-title', text: 'API Key' }), apiKeyInput,
        ]),
        createElement('p', {
            className: 'cloud-realify__connection-note',
            text: '密钥仅用于当前页面，刷新后重新填写。更换服务商或地址会清除密钥。',
        }),
        clearKeyButton,
        corsHint,
        createElement('p', {
            className: 'cloud-realify__connection-note',
            text: '点击生成会将所选图片和风格要求发送到上方地址，并可能计费。仅填写你信任的服务地址；同页其他扩展可能读取页面输入。',
        }),
    ]);
    connectionDetails.append(connectionSummary, connectionFields);

    const sourcePreview = createElement('img', {
        className: 'cloud-realify__source-image',
        hidden: true,
        attributes: { alt: '待写实化的源图' },
    });
    sourcePreview.decoding = 'async';
    sourcePreview.referrerPolicy = 'no-referrer';
    const sourcePlaceholder = createElement('p', {
        className: 'cloud-realify__source-placeholder',
        text: '当前聊天中没有可用图片，可从手机选择文件。',
    });
    const sourceLabel = createElement('p', {
        className: 'cloud-realify__source-label',
        text: '尚未选择源图',
    });
    const latestButton = makeButton('使用聊天最新图片', 'cloud-realify__secondary-button');
    const fileButton = makeButton('从手机选择', 'cloud-realify__secondary-button');
    const fileInput = createElement('input', {
        type: 'file',
        hidden: true,
        attributes: { accept: 'image/png,image/jpeg,image/webp' },
    });
    const sourceActions = createElement('div', { className: 'cloud-realify__button-row' }, [latestButton, fileButton, fileInput]);
    const sourceBlock = createElement('section', { className: 'cloud-realify__source-block' }, [
        sourcePreview,
        sourcePlaceholder,
        sourceLabel,
        sourceActions,
    ]);

    const enabledInput = createElement('input', { type: 'checkbox' });
    const enabledLabel = createElement('label', { className: 'cloud-realify__check-row' }, [
        enabledInput,
        createElement('span', { text: '启用写实化功能' }),
    ]);

    const presetSelect = createElement('select', { className: 'cloud-realify__select' });
    for (const preset of ALLOWED_PRESETS) {
        presetSelect.append(createElement('option', { value: preset, text: PRESET_LABELS[preset] }));
    }
    const presetLabel = createElement('label', { className: 'cloud-realify__field' }, [
        createElement('span', { className: 'cloud-realify__field-title', text: '写实风格' }),
        presetSelect,
    ]);

    const customInput = createElement('textarea', {
        className: 'cloud-realify__textarea',
        attributes: {
            rows: '3',
            maxlength: String(MAX_CUSTOM_INSTRUCTIONS),
            placeholder: '可选，例如：自然室内光、保留人物发型和服装颜色',
        },
    });
    const customLabel = createElement('label', { className: 'cloud-realify__field' }, [
        createElement('span', { className: 'cloud-realify__field-title', text: '附加风格要求' }),
        customInput,
    ]);

    const safeModeInput = createElement('input', { type: 'checkbox' });
    const safeModeLabel = createElement('label', { className: 'cloud-realify__check-row' }, [
        safeModeInput,
        createElement('span', { text: '启用服务商安全模式' }),
    ]);
    const safeModeHint = createElement('p', {
        className: 'cloud-realify__field-hint',
        text: 'Venice 支持随请求提交安全模式设置。',
    });

    const saveToChatInput = createElement('input', { type: 'checkbox' });
    const saveToChatLabel = createElement('label', { className: 'cloud-realify__check-row' }, [
        saveToChatInput,
        createElement('span', { text: '生成后写入当前聊天' }),
    ]);

    const settingsBlock = createElement('section', { className: 'cloud-realify__settings' }, [
        enabledLabel,
        presetLabel,
        customLabel,
        safeModeLabel,
        safeModeHint,
        saveToChatLabel,
    ]);

    const progress = createElement('div', {
        className: 'cloud-realify__progress',
        hidden: true,
        attributes: { role: 'status', 'aria-live': 'polite' },
    });
    const spinner = createElement('span', { className: 'cloud-realify__spinner', attributes: { 'aria-hidden': 'true' } });
    const progressText = createElement('span', { text: '正在处理…' });
    progress.append(spinner, progressText);

    const status = createElement('p', {
        className: 'cloud-realify__status',
        hidden: true,
        attributes: { role: 'status', 'aria-live': 'polite' },
    });

    const generateButton = makeButton('开始写实化', 'cloud-realify__primary-button');
    const confirmPaidRetryButton = makeButton('确认发起新的付费尝试', 'cloud-realify__confirm-paid-button');
    confirmPaidRetryButton.hidden = true;

    const resultImage = createElement('img', {
        className: 'cloud-realify__result-image',
        attributes: { alt: '写实化结果预览' },
    });
    resultImage.decoding = 'async';
    resultImage.referrerPolicy = 'no-referrer';
    const downloadButton = makeButton('下载到手机', 'cloud-realify__secondary-button');
    const shareButton = makeButton('分享到…', 'cloud-realify__secondary-button');
    shareButton.hidden = true;
    const persistButton = makeButton('写入当前聊天', 'cloud-realify__secondary-button');
    persistButton.hidden = true;
    const resultActions = createElement('div', { className: 'cloud-realify__button-row' }, [
        downloadButton,
        shareButton,
        persistButton,
    ]);
    const persistenceNote = createElement('p', {
        className: 'cloud-realify__boundary-note',
        text: '若聊天写入能力不可用，结果仍可预览和下载；本扩展不会伪装成已保存。',
    });
    const resultBlock = createElement('section', { className: 'cloud-realify__result', hidden: true }, [
        createElement('h3', { text: '处理结果' }),
        resultImage,
        resultActions,
        persistenceNote,
    ]);

    const footer = createElement('footer', { className: 'cloud-realify__footer' }, [
        confirmPaidRetryButton,
        generateButton,
    ]);
    dialog.append(header, providerStatus, connectionDetails, sourceBlock, settingsBlock, progress, status, resultBlock, footer);
    overlay.append(dialog);
    root.append(fab, overlay);
    document.body.append(root);

    state.root = root;
    state.elements = {
        fab,
        overlay,
        dialog,
        closeButton,
        providerStatus,
        connectionDetails,
        providerSelect,
        baseUrlInput,
        modelInput,
        apiKeyInput,
        clearKeyButton,
        corsHint,
        sourcePreview,
        sourcePlaceholder,
        sourceLabel,
        latestButton,
        fileButton,
        fileInput,
        enabledInput,
        presetSelect,
        customInput,
        safeModeInput,
        safeModeHint,
        saveToChatInput,
        progress,
        progressText,
        status,
        generateButton,
        confirmPaidRetryButton,
        resultBlock,
        resultImage,
        downloadButton,
        shareButton,
        persistButton,
        persistenceNote,
    };
}

function syncSettingsControls() {
    const { elements, settings } = state;
    if (!settings || !elements.enabledInput) return;
    elements.enabledInput.checked = settings.enabled;
    elements.presetSelect.value = settings.preset;
    elements.customInput.value = settings.customInstructions;
    elements.safeModeInput.checked = settings.safeMode;
    elements.saveToChatInput.checked = settings.saveToChat;
    elements.providerSelect.value = settings.provider;
    elements.baseUrlInput.value = settings.baseUrl;
    elements.modelInput.value = settings.model;
    elements.apiKeyInput.value = state.apiKey;
    renderConnectionStatus();
    refreshInteractionLock();
}

function renderSafeModePolicy() {
    const { safeModeInput, safeModeHint } = state.elements;
    if (!safeModeInput || !safeModeHint) return;
    const supported = state.settings?.provider === 'venice';
    safeModeInput.disabled = !supported || isInteractionBusy();
    safeModeInput.checked = supported && state.settings?.safeMode !== false;
    safeModeHint.textContent = supported
        ? 'Venice 支持随请求提交安全模式设置；仍受上游内容规则限制。'
        : '该适配器遵循上游自身内容策略，扩展无法切换。';
}

function currentProviderConfig() {
    if (!state.elements.baseUrlInput.value.trim() || !state.elements.modelInput.value.trim()) {
        throw new Error('请填写 HTTPS Base URL 和模型 ID。');
    }
    return validateProviderConfig({
        provider: state.settings.provider,
        baseUrl: state.elements.baseUrlInput.value,
        model: state.elements.modelInput.value,
        apiKey: state.apiKey,
    });
}

function clearApiKey() {
    state.apiKey = '';
    if (state.elements.apiKeyInput) state.elements.apiKeyInput.value = '';
    if (state.elements.connectionDetails) state.elements.connectionDetails.open = true;
}

function renderConnectionStatus() {
    const { providerStatus, connectionDetails, corsHint } = state.elements;
    if (!providerStatus || !state.settings) return;
    state.connectionConfigured = false;
    try {
        currentProviderConfig();
        state.connectionConfigured = true;
        providerStatus.textContent = '配置已填写，尚未验证';
        providerStatus.dataset.kind = 'pending';
    } catch (error) {
        providerStatus.textContent = state.apiKey
            ? `连接设置：${friendlyError(error)}` : '请先填写连接设置和 API Key。';
        providerStatus.dataset.kind = 'warning';
        if (!state.apiKey) connectionDetails.open = true;
    }
    corsHint.textContent = state.settings.provider === 'venice'
        ? '浏览器直连 Venice，不需要安装服务端插件。'
        : 'OpenAI-compatible 服务必须允许浏览器跨域（CORS）；不支持时无法直连。';
    renderSafeModePolicy();
    updateEnabledState();
}

function clearPaidRetryConfirmation() {
    state.requiresPaidRetryConfirmation = false;
    state.pendingLockReplacementAuthorized = false;
    if (state.elements.confirmPaidRetryButton) state.elements.confirmPaidRetryButton.hidden = true;
    updateEnabledState();
}

function isInteractionBusy() {
    return state.inFlight || state.persistenceInFlight;
}

function updateEnabledState() {
    if (!state.elements.fab) return;
    const enabled = state.settings?.enabled !== false;
    const busy = isInteractionBusy();
    state.elements.fab.classList.toggle('cloud-realify__fab--disabled', !enabled);
    state.elements.fab.textContent = enabled
        ? state.selectedSource ? '写实化此图' : '写实化'
        : '写实化（已停用）';
    state.elements.generateButton.disabled = !enabled
        || busy
        || !state.selectedSource
        || !state.connectionConfigured
        || state.requiresPaidRetryConfirmation;
    state.elements.confirmPaidRetryButton.disabled = !enabled || busy || !state.selectedSource || !state.connectionConfigured;
    if (state.requiresPaidRetryConfirmation) {
        state.elements.generateButton.textContent = '重试已暂停';
    } else if (state.inFlight) {
        state.elements.generateButton.textContent = '处理中…';
    } else if (state.persistenceInFlight) {
        state.elements.generateButton.textContent = '正在保存…';
    } else if (state.operation && !state.operation.completed) {
        state.elements.generateButton.textContent = '重试（复用原请求）';
    } else if (state.result) {
        state.elements.generateButton.textContent = '再生成一次';
    } else {
        state.elements.generateButton.textContent = '开始写实化';
    }
}

function setStatus(kind, message) {
    const element = state.elements.status;
    if (!element) return;
    if (!message) {
        element.hidden = true;
        element.textContent = '';
        element.removeAttribute('data-kind');
        return;
    }
    element.hidden = false;
    element.dataset.kind = kind;
    element.textContent = String(message).slice(0, 500);
}

function setProgress(visible, message = '正在处理…') {
    if (!state.elements.progress) return;
    state.elements.progress.hidden = !visible;
    state.elements.progressText.textContent = message;
}

function refreshInteractionLock() {
    const busy = isInteractionBusy();
    const disableWhileBusy = [
        state.elements.enabledInput,
        state.elements.latestButton,
        state.elements.fileButton,
        state.elements.presetSelect,
        state.elements.customInput,
        state.elements.safeModeInput,
        state.elements.saveToChatInput,
        state.elements.confirmPaidRetryButton,
        state.elements.providerSelect,
        state.elements.baseUrlInput,
        state.elements.modelInput,
        state.elements.apiKeyInput,
        state.elements.clearKeyButton,
    ];
    for (const element of disableWhileBusy) {
        if (element) element.disabled = busy;
    }
    renderSafeModePolicy();
    updateEnabledState();
}

function setBusy(busy) {
    state.inFlight = busy;
    refreshInteractionLock();
}

function openSheet() {
    if (!state.selectedSource) {
        selectLatestChatImage();
    }
    syncSettingsControls();
    renderSelectedSource();
    state.elements.overlay.hidden = false;
    state.elements.overlay.setAttribute('aria-hidden', 'false');
    state.elements.closeButton.focus({ preventScroll: true });
}

function closeSheet() {
    state.elements.overlay.hidden = true;
    state.elements.overlay.setAttribute('aria-hidden', 'true');
    state.elements.fab.focus({ preventScroll: true });
}

function isEligibleChatImage(image) {
    if (!(image instanceof HTMLImageElement)) return false;
    if (!image.closest('#chat')) return false;
    if (image.closest(`#${ROOT_ID}, .avatar, .mesAvatarWrapper, .avatar-container`)) return false;
    if (!(image.currentSrc || image.getAttribute('src'))) return false;
    if (image.classList.contains('emoji') || image.closest('.emoji')) return false;

    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    return !width || !height || (width >= 64 && height >= 64);
}

function sourceFromMedia(messageIndex, mediaIndex, media, originChatIdentity) {
    if (!media || media.type !== 'image' || typeof media.url !== 'string' || !media.url.trim()) return null;
    const title = typeof media.title === 'string' ? media.title.trim().slice(0, 60) : '';
    return {
        kind: 'media',
        src: media.url,
        identity: `media:${messageIndex}:${mediaIndex}:${media.url}`,
        label: [`消息 ${messageIndex}`, title].filter(Boolean).join(' · '),
        messageIndex,
        mediaIndex,
        originChatIdentity,
    };
}

function findLatestChatSource() {
    const context = freshContext();
    const originChatIdentity = chatIdentity(context);
    const chat = context.chat;
    if (Array.isArray(chat)) {
        for (let messageIndex = chat.length - 1; messageIndex >= 0; messageIndex -= 1) {
            const message = chat[messageIndex];
            try {
                context.ensureMessageMediaIsArray?.(message);
            } catch {
                // A malformed legacy message should not prevent checking earlier messages.
            }
            const mediaEntries = Array.isArray(message?.extra?.media) ? message.extra.media : [];
            for (let mediaIndex = mediaEntries.length - 1; mediaIndex >= 0; mediaIndex -= 1) {
                const source = sourceFromMedia(messageIndex, mediaIndex, mediaEntries[mediaIndex], originChatIdentity);
                if (source) return source;
            }
        }
    }

    const exactImages = Array.from(document.querySelectorAll('#chat .mes .mes_media_container.mes_img_container img.mes_img'));
    const fallbackImages = exactImages.length ? exactImages : Array.from(document.querySelectorAll('#chat img'));
    const image = fallbackImages.filter(isEligibleChatImage).at(-1) ?? null;
    return image ? sourceFromImage(image) : null;
}

function sourceFromImage(image) {
    const context = freshContext();
    const originChatIdentity = chatIdentity(context);
    const src = image.currentSrc || image.getAttribute('src') || '';
    const messageId = image.closest('.mes')?.getAttribute('mesid');
    const mediaIndexValue = image.closest('.mes_media_container')?.getAttribute('data-index');
    const parsedMessageId = Number.parseInt(messageId, 10);
    const parsedMediaIndex = Number.parseInt(mediaIndexValue, 10);
    if (Number.isInteger(parsedMessageId) && Number.isInteger(parsedMediaIndex)) {
        const message = context.chat?.[parsedMessageId];
        try {
            context.ensureMessageMediaIsArray?.(message);
        } catch {
            // Fall back to the rendered image URL below.
        }
        const mapped = sourceFromMedia(
            parsedMessageId,
            parsedMediaIndex,
            message?.extra?.media?.[parsedMediaIndex],
            originChatIdentity,
        );
        if (mapped) return mapped;
    }

    const alt = String(image.getAttribute('alt') ?? '').trim();
    const labelParts = [];
    if (messageId !== null && messageId !== undefined) labelParts.push(`消息 ${messageId}`);
    if (alt) labelParts.push(alt.slice(0, 60));
    return {
        kind: 'element',
        src,
        identity: `element:${src}`,
        label: labelParts.join(' · ') || '聊天图片',
        originChatIdentity,
    };
}

function sourceFromFile(file) {
    return {
        kind: 'file',
        file,
        identity: `file:${file.name}:${file.size}:${file.lastModified}`,
        label: `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`,
    };
}

function selectSource(source) {
    if (isInteractionBusy()) {
        setStatus('info', '当前图片仍在处理或保存，完成后才能切换源图。');
        return false;
    }
    if (!source) return false;

    if (state.selectedPreviewUrl) {
        URL.revokeObjectURL(state.selectedPreviewUrl);
        state.selectedPreviewUrl = null;
    }

    state.selectedSource = source;
    if (!state.requiresPaidRetryConfirmation) state.operation = null;
    clearResult();
    renderSelectedSource();
    updateEnabledState();
    return true;
}

function selectLatestChatImage() {
    const source = findLatestChatSource();
    if (!source) {
        if (state.selectedPreviewUrl) URL.revokeObjectURL(state.selectedPreviewUrl);
        state.selectedPreviewUrl = null;
        state.selectedSource = null;
        if (!state.requiresPaidRetryConfirmation) state.operation = null;
        clearResult();
        renderSelectedSource();
        updateEnabledState();
        return false;
    }
    return selectSource(source);
}

function renderSelectedSource() {
    const { sourcePreview, sourcePlaceholder, sourceLabel } = state.elements;
    if (!sourcePreview) return;

    const source = state.selectedSource;
    if (!source) {
        sourcePreview.hidden = true;
        sourcePreview.removeAttribute('src');
        sourcePlaceholder.hidden = false;
        sourceLabel.textContent = '尚未选择源图';
        return;
    }

    sourcePlaceholder.hidden = true;
    sourceLabel.textContent = source.label;
    if (source.kind === 'file') {
        if (!state.selectedPreviewUrl) state.selectedPreviewUrl = URL.createObjectURL(source.file);
        sourcePreview.src = state.selectedPreviewUrl;
    } else {
        sourcePreview.src = source.src;
    }
    sourcePreview.hidden = false;
}

function findImageForAction(actionButton) {
    const mediaContainer = actionButton.closest('.mes_media_container, .mes_img_container');
    return mediaContainer?.querySelector('img.mes_img, img') ?? null;
}

function decorateChatImages() {
    state.decorateScheduled = false;
    if (!state.active || !state.mounted) return;

    for (const controls of document.querySelectorAll('#chat .mes_img_controls')) {
        if (controls.querySelector('.cloud-realify-image-action')) continue;
        const mediaContainer = controls.closest('.mes_media_container, .mes_img_container');
        const image = mediaContainer?.querySelector('img.mes_img, img');
        if (!isEligibleChatImage(image)) continue;

        const action = makeButton('写实', 'cloud-realify-image-action menu_button');
        action.title = '用 Cloud Realify 写实化此图';
        action.setAttribute('aria-label', '写实化此图');
        controls.append(action);
    }
}

function scheduleDecorateChatImages() {
    if (state.decorateScheduled) return;
    state.decorateScheduled = true;
    queueMicrotask(decorateChatImages);
}

function attachMutationObserver() {
    if (!document.body || state.mutationObserver) return;
    state.mutationObserver = new MutationObserver((records) => {
        const mayContainChatMedia = records.some(record => Array.from(record.addedNodes).some(node => {
            if (!(node instanceof Element)) return false;
            return node.id === 'chat'
                || Boolean(node.closest('#chat'))
                || Boolean(node.querySelector?.('#chat, .mes_img_controls'));
        }));
        if (mayContainChatMedia) scheduleDecorateChatImages();
    });
    state.mutationObserver.observe(document.body, { childList: true, subtree: true });
    scheduleDecorateChatImages();
}

function onDocumentClick(event) {
    if (!(event.target instanceof Element)) return;

    const action = event.target.closest('.cloud-realify-image-action');
    if (action) {
        event.preventDefault();
        event.stopPropagation();
        if (isInteractionBusy()) {
            openSheet();
            setStatus('info', '当前图片仍在处理或保存，完成后才能切换源图。');
            return;
        }
        const image = findImageForAction(action);
        if (isEligibleChatImage(image)) selectSource(sourceFromImage(image));
        openSheet();
        return;
    }

    const image = event.target.closest('#chat img.mes_img, #chat .mes_text img');
    if (isEligibleChatImage(image) && !isInteractionBusy()) {
        selectSource(sourceFromImage(image));
    }
}

function inferMimeType(blob, name = '') {
    const direct = normalizeMimeType(blob.type);
    if (direct) return direct;
    const extension = String(name).toLowerCase().split('.').at(-1);
    if (extension === 'png') return 'image/png';
    if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
    if (extension === 'webp') return 'image/webp';
    return null;
}

function arrayBufferToBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const chunkSize = 0x8000;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

async function blobToDataUrl(blob, name = '', generation = null) {
    if (!(blob instanceof Blob)) throw new Error('无法读取源图片。');
    if (blob.size === 0) throw new Error('图片文件为空。');
    if (blob.size > MAX_INPUT_BYTES) {
        throw new Error(`图片超过 ${Math.floor(MAX_INPUT_BYTES / 1024 / 1024)} MB 上限。`);
    }
    const mimeType = inferMimeType(blob, name);
    if (!mimeType) throw new Error('仅支持 PNG、JPEG 或 WebP 图片。');
    const arrayBuffer = await blob.arrayBuffer();
    if (generation !== null) assertCurrentLifecycle(generation);
    const base64 = arrayBufferToBase64(arrayBuffer);
    const dataUrl = `data:${mimeType};base64,${base64}`;
    parseImageDataUrl(dataUrl);
    return dataUrl;
}

async function readSelectedSource(controller, generation) {
    assertCurrentLifecycle(generation);
    const source = state.selectedSource;
    if (!source) throw new Error('请先选择一张源图。');
    if (source.kind === 'file') {
        const dataUrl = await blobToDataUrl(source.file, source.file.name, generation);
        assertCurrentLifecycle(generation);
        return dataUrl;
    }

    const rawSrc = String(source.src ?? '');
    if (rawSrc.startsWith('data:')) {
        parseImageDataUrl(rawSrc);
        return rawSrc;
    }

    const url = new URL(rawSrc, location.href);
    const isBlob = url.protocol === 'blob:';
    const isSameOriginHttp = (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === location.origin;
    if (!isBlob && !isSameOriginHttp) {
        throw new Error('这张图片来自跨域地址。请先保存到手机，再使用“从手机选择”。');
    }

    const response = await fetch(url.href, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
    });
    assertCurrentLifecycle(generation);
    if (!response.ok) throw new Error(`读取源图片失败（HTTP ${response.status}）。`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_INPUT_BYTES) {
        throw new Error(`图片超过 ${Math.floor(MAX_INPUT_BYTES / 1024 / 1024)} MB 上限。`);
    }
    const blob = await response.blob();
    assertCurrentLifecycle(generation);
    const dataUrl = await blobToDataUrl(blob, url.pathname, generation);
    assertCurrentLifecycle(generation);
    return dataUrl;
}

function operationSignature(source, settings, originChatIdentity) {
    return [
        source.identity,
        originChatIdentity,
        settings.preset,
        settings.customInstructions.trim(),
        settings.safeMode ? 'safe' : 'unfiltered',
        settings.provider,
        settings.baseUrl,
        settings.model,
    ].join('|');
}

function getOrCreateOperation(originChatIdentity, originChatTarget) {
    const signature = operationSignature(state.selectedSource, state.settings, originChatIdentity);
    if (!state.operation || state.operation.signature !== signature || state.operation.completed) {
        state.operation = {
            signature,
            requestId: createRequestId(),
            completed: false,
            originChatIdentity,
            originChatTarget,
        };
    }
    return state.operation;
}

async function parseErrorResponse(response, generation = null) {
    let code = `http_${response.status}`;
    let message = '';
    let outcomeUnknown = false;
    try {
        const payload = await response.json();
        if (generation !== null) assertCurrentLifecycle(generation);
        if (typeof payload?.error?.code === 'string' && payload.error.code.trim()) {
            code = payload.error.code.trim().slice(0, 100);
        }
        const candidate = payload?.error?.message ?? payload?.error ?? payload?.message;
        if (typeof candidate === 'string' && candidate.trim()) message = candidate.trim().slice(0, 400);
        outcomeUnknown = payload?.error?.outcomeUnknown === true || payload?.outcomeUnknown === true;
    } catch (error) {
        if (error?.code === 'lifecycle_stale') throw error;
        // Fall through to the status-only error so an HTML error page is never injected.
    }
    const error = new Error(message || `请求失败（HTTP ${response.status}）。`);
    error.code = code;
    error.httpStatus = response.status;
    error.outcomeUnknown = outcomeUnknown;
    return error;
}

async function performTransform() {
    const generation = state.lifecycleGeneration;
    if (!isCurrentLifecycle(generation) || !state.settings) return;
    if (state.persistenceInFlight) {
        setStatus('info', '当前结果正在写入聊天，完成后才能开始新的付费请求。');
        return;
    }
    if (state.inFlight || state.settings.enabled === false) return;
    const replacementAuthorized = state.pendingLockReplacementAuthorized === true;
    state.pendingLockReplacementAuthorized = false;
    if (state.requiresPaidRetryConfirmation && !replacementAuthorized) {
        setPaidRetryConfirmation('检测到尚未确认的付费请求。为避免重复扣费，请点击“确认发起新的付费尝试”。');
        return;
    }
    if (!state.selectedSource) {
        setStatus('error', '请先选择一张源图。');
        return;
    }
    let providerConfig;
    try {
        // Capture one validated, page-local credential snapshot before any await.
        providerConfig = Object.freeze(currentProviderConfig());
    } catch (error) {
        state.elements.connectionDetails.open = true;
        renderConnectionStatus();
        setStatus('error', friendlyError(error));
        return;
    }
    const settings = {
        preset: state.settings.preset,
        customInstructions: state.settings.customInstructions,
        safeMode: providerConfig.provider === 'venice' && state.settings.safeMode,
        saveToChat: state.settings.saveToChat,
    };

    let originChatIdentity;
    let originChatTarget;
    try {
        const originContext = freshContext();
        originChatIdentity = chatIdentity(originContext);
        originChatTarget = captureChatPersistenceTarget(originContext);
        if (state.selectedSource.originChatIdentity
            && state.selectedSource.originChatIdentity !== originChatIdentity) {
            throw new Error('源图来自之前的聊天。请在当前聊天重新选择图片后再生成。');
        }
    } catch (error) {
        setStatus('error', friendlyError(error));
        return;
    }

    setBusy(true);
    setStatus('', '');
    setProgress(true, '正在读取源图…');
    const operation = getOrCreateOperation(originChatIdentity, originChatTarget);
    const controller = new AbortController();
    state.transformController = controller;
    let requestDispatched = false;
    let pendingStorage = null;
    let pendingLockAcquired = false;
    let lockClearWarning = '';

    try {
        const image = await readSelectedSource(controller, generation);
        assertCurrentLifecycle(generation);
        const payload = buildTransformPayload({
            requestId: operation.requestId,
            image,
            preset: settings.preset,
            customInstructions: settings.customInstructions,
            safeMode: settings.safeMode,
        });

        setProgress(true, '云端模型正在写实化，请勿重复点击…');
        assertOriginChat(operation.originChatIdentity, '付费请求');
        const responsePayload = await withCrossTabPaidLock(globalThis.navigator?.locks, async () => {
            assertCurrentLifecycle(generation);
            assertOriginChat(operation.originChatIdentity, '付费请求');
            pendingStorage = acquirePendingAttemptLock(operation.requestId, replacementAuthorized);
            pendingLockAcquired = true;
            if (!verifyPendingAttempt(pendingStorage, operation.requestId)) {
                const error = new Error('付费保护记录在请求发送前发生变化，已阻止云端请求。');
                error.code = 'pending_lock_changed';
                throw error;
            }
            clearPaidRetryConfirmation();

            // Web Locks makes acquisition atomic across tabs when supported;
            // localStorage read-back remains the fail-closed persistence layer.
            if (!verifyPendingAttempt(pendingStorage, operation.requestId)) {
                const error = new Error('另一页面更改了付费保护记录，已阻止云端请求。');
                error.code = 'pending_lock_changed';
                throw error;
            }
            requestDispatched = true;
            return editImage({
                config: providerConfig,
                payload,
                signal: controller.signal,
            });
        });
        assertCurrentLifecycle(generation);
        let result = extractTransformResult(responsePayload);
        if (result.requestId !== operation.requestId) {
            const error = new Error('返回了不匹配的请求标识，无法确认本次付费结果。');
            error.code = 'response_request_id_mismatch';
            throw error;
        }
        result.requestId = operation.requestId;
        result.originChatIdentity = operation.originChatIdentity;
        result.originChatTarget = operation.originChatTarget;

        if (releasePendingAttemptLock(pendingStorage, operation.requestId)) {
            pendingLockAcquired = false;
            clearPaidRetryConfirmation();
        } else {
            lockClearWarning = '图片已成功返回，但本地付费保护记录未能安全清除；再次生成前需要明确确认新的付费尝试。';
            setPaidRetryConfirmation(lockClearWarning);
        }

        result = showResult(result);
        operation.completed = true;

        if (settings.saveToChat) {
            setProgress(true, '图片已生成，正在写入当前聊天…');
            try {
                await persistCurrentResult(generation);
                assertCurrentLifecycle(generation);
                if (state.result !== result) {
                    const staleResultError = new Error('保存期间当前结果已改变，不再报告旧结果成功。');
                    staleResultError.code = 'result_superseded';
                    throw staleResultError;
                }
                if (lockClearWarning) setStatus('warning', `写实化完成，结果已写入当前聊天。${lockClearWarning}`);
                else setStatus('success', '写实化完成，结果已写入当前聊天。');
            } catch (error) {
                if (!isCurrentLifecycle(generation) || error?.code === 'lifecycle_stale') throw error;
                if (state.elements.persistButton) state.elements.persistButton.hidden = false;
                setStatus('warning', `图片已生成，但未能写入聊天：${friendlyError(error)} 可先下载图片。`);
            }
        } else {
            if (state.elements.persistButton) state.elements.persistButton.hidden = false;
            if (lockClearWarning) setStatus('warning', `写实化完成，可预览或下载。${lockClearWarning}`);
            else setStatus('success', '写实化完成，可预览、下载或手动写入聊天。');
        }
    } catch (error) {
        if (!isCurrentLifecycle(generation) || error?.code === 'lifecycle_stale') return;
        // The adapter can prove that its own validation/abort happened before fetch.
        if (error?.requestDispatched === false) requestDispatched = false;
        const retryNeedsConfirmation = requiresPaidRetryConfirmation({
            requestDispatched,
            code: error?.code,
            outcomeUnknown: error?.outcomeUnknown,
        });
        const isAbort = error?.name === 'AbortError';

        if (pendingLockAcquired && !requestDispatched && !retryNeedsConfirmation) {
            if (releasePendingAttemptLock(pendingStorage, operation.requestId)) {
                pendingLockAcquired = false;
            } else {
                setPaidRetryConfirmation('本次请求未发送到上游，但本地付费保护记录未能安全清除。请确认后再发起新尝试。');
                return;
            }
        }

        if (retryNeedsConfirmation || (pendingLockAcquired && isAbort)) {
            setPaidRetryConfirmation('上一次云端请求的结果无法确认，且可能已经计费。为避免重复扣费，已暂停重试；只有点击“确认发起新的付费尝试”才会创建新请求。');
        } else if (String(error?.code ?? '').startsWith('pending_lock_')) {
            setPaidRetryConfirmation(friendlyError(error));
        } else if (error?.name === 'AbortError') {
            setStatus('warning', '请求在发送到云端前已中止，可以安全重试。');
        } else {
            setStatus('error', friendlyError(error));
        }
    } finally {
        if (isCurrentLifecycle(generation)) {
            if (state.transformController === controller) state.transformController = null;
            setProgress(false);
            setBusy(false);
        }
    }
}

function base64ToBlob(base64, mimeType) {
    const binary = atob(base64);
    const chunks = [];
    const chunkSize = 0x8000;
    for (let offset = 0; offset < binary.length; offset += chunkSize) {
        const slice = binary.slice(offset, offset + chunkSize);
        const bytes = new Uint8Array(slice.length);
        for (let index = 0; index < slice.length; index += 1) bytes[index] = slice.charCodeAt(index);
        chunks.push(bytes);
    }
    return new Blob(chunks, { type: mimeType });
}

function clearResult() {
    if (state.resultObjectUrl) {
        URL.revokeObjectURL(state.resultObjectUrl);
        state.resultObjectUrl = null;
    }
    state.result = null;
    if (!state.elements.resultBlock) return;
    state.elements.resultBlock.hidden = true;
    state.elements.resultImage.removeAttribute('src');
    state.elements.persistButton.hidden = true;
    state.elements.shareButton.hidden = true;
}

function showResult(result) {
    clearResult();
    const blob = base64ToBlob(result.base64, result.mimeType);
    const objectUrl = URL.createObjectURL(blob);
    state.result = { ...result, blob, persisted: false };
    state.resultObjectUrl = objectUrl;
    state.elements.resultImage.src = objectUrl;
    state.elements.resultBlock.hidden = false;
    state.elements.persistButton.hidden = !state.settings.saveToChat;
    state.elements.shareButton.hidden = !canShareBlob(blob, result.mimeType);
    state.elements.persistenceNote.textContent = '若聊天写入能力不可用，结果仍可预览和下载；本扩展不会伪装成已保存。';
    return state.result;
}

function canShareBlob(blob, mimeType) {
    if (typeof navigator.share !== 'function' || typeof File !== 'function') return false;
    try {
        const file = new File([blob], `cloud-realify.${extensionForMimeType(mimeType)}`, { type: mimeType });
        return typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] });
    } catch {
        return false;
    }
}

function downloadCurrentResult() {
    if (!state.result || !state.resultObjectUrl) return;
    const anchor = document.createElement('a');
    anchor.href = state.resultObjectUrl;
    anchor.download = `cloud-realify-${Date.now()}.${extensionForMimeType(state.result.mimeType)}`;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
}

async function shareCurrentResult() {
    const generation = state.lifecycleGeneration;
    if (!isCurrentLifecycle(generation) || !state.result || typeof navigator.share !== 'function') return;
    const result = state.result;
    const extension = extensionForMimeType(result.mimeType);
    const file = new File([result.blob], `cloud-realify-${Date.now()}.${extension}`, { type: result.mimeType });
    try {
        await navigator.share({ files: [file], title: 'Cloud Realify 写实化结果' });
        assertCurrentLifecycle(generation);
    } catch (error) {
        if (isCurrentLifecycle(generation) && error?.name !== 'AbortError') {
            setStatus('error', `无法调用系统分享：${friendlyError(error)}`);
        }
    }
}

function findPersistedMessageIndex(context, requestId) {
    return context.chat.findIndex(message => message?.extra?.cloud_realify?.request_id === requestId);
}

async function uploadResultImage(result, generation, signal) {
    assertCurrentLifecycle(generation);
    const context = assertOriginChat(result.originChatIdentity, '图片上传');
    const extension = extensionForMimeType(result.mimeType);
    const isGroup = context.groupId !== null && context.groupId !== undefined;
    const owner = isGroup ? 'Cloud Realify' : (context.name2 || 'Cloud Realify');
    const filename = `cloud-realify-${Date.now()}-${result.requestId.slice(0, 8)}`;
    const response = await fetch(IMAGE_UPLOAD_ENDPOINT, {
        method: 'POST',
        headers: getRequestHeaders(context),
        credentials: 'same-origin',
        signal,
        body: JSON.stringify({
            image: result.base64,
            format: extension,
            ch_name: owner,
            filename,
        }),
    });
    assertCurrentLifecycle(generation);
    if (!response.ok) {
        const responseError = await parseErrorResponse(response, generation);
        assertCurrentLifecycle(generation);
        throw responseError;
    }
    const payload = await response.json();
    assertCurrentLifecycle(generation);
    if (!payload || typeof payload.path !== 'string' || !payload.path.trim()) {
        throw new Error('SillyTavern 图片上传接口未返回文件路径。');
    }
    const resolved = new URL(payload.path, location.href);
    const safeProtocol = resolved.protocol === 'http:' || resolved.protocol === 'https:';
    if (!safeProtocol || resolved.origin !== location.origin) {
        throw new Error('SillyTavern 返回了不安全的图片路径。');
    }
    return payload.path;
}

async function getMessageTimestamp(generation) {
    try {
        const module = await import('/scripts/RossAscends-mods.js');
        assertCurrentLifecycle(generation);
        if (typeof module.getMessageTimeStamp === 'function') return module.getMessageTimeStamp();
    } catch (error) {
        if (error?.code === 'lifecycle_stale') throw error;
        // Optional compatibility bridge. ISO time is an honest fallback if the internal helper moves.
    }
    return new Date().toISOString();
}

async function savePinnedChatAndVerify(context, result, generation, signal) {
    assertCurrentLifecycle(generation);
    context = assertOriginChat(result.originChatIdentity, '聊天保存');
    const target = result.originChatTarget;
    if (!target) throw new Error('本次结果缺少原聊天保存目标。');
    if (typeof context.saveChat !== 'function') {
        throw new Error('当前版本未提供安全的聊天保存能力。');
    }

    // Reuse SillyTavern's save coordinator so this write is serialized with
    // other saves in the current tab. The host intentionally swallows some
    // transport/integrity errors, so its return is never treated as success;
    // the pinned original target is read back and checked below.
    const readbackRequest = buildChatReadbackRequest(target);
    const headers = getRequestHeaders(context);

    context = assertOriginChat(result.originChatIdentity, '聊天保存');
    await context.saveChat();
    assertCurrentLifecycle(generation);
    context = assertOriginChat(result.originChatIdentity, '聊天保存核验');

    const readbackResponse = await fetch(readbackRequest.endpoint, {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
        body: JSON.stringify(readbackRequest.body),
    });
    assertCurrentLifecycle(generation);
    assertOriginChat(result.originChatIdentity, '聊天回读核验');

    let readbackPayload = null;
    if (readbackResponse.ok) {
        try {
            readbackPayload = await readbackResponse.json();
        } catch {
            assertCurrentLifecycle(generation);
            assertOriginChat(result.originChatIdentity, '聊天回读核验');
            const error = new Error('聊天回读接口返回了无法解析的数据。');
            error.code = 'chat_readback_invalid_json';
            throw error;
        }
        assertCurrentLifecycle(generation);
        assertOriginChat(result.originChatIdentity, '聊天回读核验');
    }

    const verification = verifyChatPersistenceReadback({
        responseOk: readbackResponse.ok,
        status: readbackResponse.status,
        payload: readbackPayload,
        requestId: result.requestId,
    });
    if (!verification.ok) {
        const error = new Error(verification.message);
        error.code = `chat_persistence_${verification.reason}`;
        throw error;
    }
}

async function renderAndSaveExistingMessage(messageIndex, result, generation, signal) {
    assertCurrentLifecycle(generation);
    let context = assertOriginChat(result.originChatIdentity, '聊天写入');
    const message = context.chat[messageIndex];
    if (!message) throw new Error('找不到待保存的聊天消息。');
    const existingDomMessage = document.querySelector(`#chat .mes[mesid="${messageIndex}"]`);
    if (!existingDomMessage) {
        context = assertOriginChat(result.originChatIdentity, '消息事件发送');
        let eventTypes = context.eventTypes ?? context.event_types;
        await context.eventSource.emit(eventTypes.MESSAGE_RECEIVED, messageIndex, 'extension');
        assertCurrentLifecycle(generation);

        context = assertOriginChat(result.originChatIdentity, '消息渲染');
        await context.addOneMessage(message);
        assertCurrentLifecycle(generation);

        context = assertOriginChat(result.originChatIdentity, '消息事件发送');
        eventTypes = context.eventTypes ?? context.event_types;
        await context.eventSource.emit(eventTypes.CHARACTER_MESSAGE_RENDERED, messageIndex, 'extension');
        assertCurrentLifecycle(generation);
    }

    assertCurrentLifecycle(generation);
    context = assertOriginChat(result.originChatIdentity, '聊天保存');
    await savePinnedChatAndVerify(context, result, generation, signal);
    assertCurrentLifecycle(generation);
    context = assertOriginChat(result.originChatIdentity, '聊天保存核验');
    context.scrollOnMediaLoad?.();
}

async function persistCurrentResult(expectedGeneration = state.lifecycleGeneration) {
    const generation = expectedGeneration;
    assertCurrentLifecycle(generation);
    if (!state.result) throw new Error('当前没有可写入聊天的结果。');
    if (state.persistenceInFlight) {
        const error = new Error('另一次聊天写入尚未完成。');
        error.code = 'persistence_busy';
        throw error;
    }
    const result = state.result;
    let context = assertOriginChat(result.originChatIdentity, '聊天写入');

    const eventTypes = context.eventTypes ?? context.event_types;
    const supportsPersistence = Array.isArray(context?.chat)
        && typeof context?.addOneMessage === 'function'
        && typeof context?.saveChat === 'function'
        && typeof context?.eventSource?.emit === 'function'
        && eventTypes?.MESSAGE_RECEIVED
        && eventTypes?.CHARACTER_MESSAGE_RENDERED;
    if (!supportsPersistence) {
        throw new Error('当前版本未提供完整的聊天媒体持久化能力。');
    }

    const controller = new AbortController();
    state.persistenceController = controller;
    state.persistenceInFlight = true;
    refreshInteractionLock();
    try {
        const existingIndex = findPersistedMessageIndex(context, result.requestId);
        if (existingIndex >= 0) {
            await renderAndSaveExistingMessage(existingIndex, result, generation, controller.signal);
            assertCurrentLifecycle(generation);
            if (state.result !== result) throw Object.assign(new Error('保存期间当前结果已改变。'), { code: 'result_superseded' });
            result.persisted = true;
            if (state.elements.persistButton) state.elements.persistButton.hidden = true;
            if (state.elements.persistenceNote) state.elements.persistenceNote.textContent = '此结果已写入当前聊天。';
            return;
        }

        const imagePath = await uploadResultImage(result, generation, controller.signal);
        assertCurrentLifecycle(generation);
        context = assertOriginChat(result.originChatIdentity, '聊天写入');
        const isGroup = context.groupId !== null && context.groupId !== undefined;
        const displayName = isGroup ? 'Cloud Realify' : (context.name2 || 'Cloud Realify');
        const message = {
            name: displayName,
            is_user: false,
            is_system: true,
            send_date: await getMessageTimestamp(generation),
            mes: '写实化结果',
            extra: {
                media: [{
                    url: imagePath,
                    type: 'image',
                    title: '写实化结果',
                    source: 'generated',
                }],
                media_display: 'gallery',
                media_index: 0,
                inline_image: false,
                cloud_realify: {
                    request_id: result.requestId,
                    provider: result.provider,
                    model: result.model,
                },
            },
        };

        assertCurrentLifecycle(generation);
        context = assertOriginChat(result.originChatIdentity, '消息写入');
        context.chat.push(message);
        const messageIndex = context.chat.length - 1;

        context = assertOriginChat(result.originChatIdentity, '消息事件发送');
        let currentEventTypes = context.eventTypes ?? context.event_types;
        await context.eventSource.emit(currentEventTypes.MESSAGE_RECEIVED, messageIndex, 'extension');
        assertCurrentLifecycle(generation);

        context = assertOriginChat(result.originChatIdentity, '消息渲染');
        await context.addOneMessage(message);
        assertCurrentLifecycle(generation);

        context = assertOriginChat(result.originChatIdentity, '消息事件发送');
        currentEventTypes = context.eventTypes ?? context.event_types;
        await context.eventSource.emit(currentEventTypes.CHARACTER_MESSAGE_RENDERED, messageIndex, 'extension');
        assertCurrentLifecycle(generation);

        context = assertOriginChat(result.originChatIdentity, '聊天保存');
        await savePinnedChatAndVerify(context, result, generation, controller.signal);
        assertCurrentLifecycle(generation);
        if (state.result !== result) throw Object.assign(new Error('保存期间当前结果已改变。'), { code: 'result_superseded' });
        context = assertOriginChat(result.originChatIdentity, '聊天保存核验');
        context.scrollOnMediaLoad?.();

        result.persisted = true;
        if (state.elements.persistButton) state.elements.persistButton.hidden = true;
        if (state.elements.persistenceNote) state.elements.persistenceNote.textContent = '此结果已写入当前聊天。';
        scheduleDecorateChatImages();
    } finally {
        if (isCurrentLifecycle(generation) && state.persistenceController === controller) {
            state.persistenceController = null;
            state.persistenceInFlight = false;
            refreshInteractionLock();
        }
    }
}

function friendlyError(error) {
    const message = typeof error?.message === 'string' ? error.message.trim() : '';
    const redacted = state.apiKey ? message.split(state.apiKey).join('[已隐藏密钥]') : message;
    return (redacted || '操作失败，请检查服务配置和网络后重试。').slice(0, 500);
}

function bindUiEvents() {
    listen(state.elements.fab, 'click', openSheet);
    listen(state.elements.closeButton, 'click', closeSheet);
    listen(state.elements.overlay, 'click', event => {
        if (event.target === state.elements.overlay) closeSheet();
    });
    listen(document, 'keydown', event => {
        if (event.key === 'Escape' && !state.elements.overlay.hidden) closeSheet();
    });
    listen(document, 'click', onDocumentClick, true);

    listen(state.elements.providerSelect, 'change', () => {
        if (isInteractionBusy()) return;
        const provider = state.elements.providerSelect.value;
        if (!Object.hasOwn(PROVIDER_DEFAULTS, provider)) return;
        clearApiKey();
        state.settings.provider = provider;
        state.settings.baseUrl = PROVIDER_DEFAULTS[provider].baseUrl;
        state.settings.model = PROVIDER_DEFAULTS[provider].model;
        if (!state.requiresPaidRetryConfirmation) state.operation = null;
        saveSettings();
        syncSettingsControls();
    });
    listen(state.elements.baseUrlInput, 'input', () => {
        if (isInteractionBusy()) return;
        // Clear on the first edit, not only on blur, so a key cannot follow a new endpoint.
        clearApiKey();
        if (!state.requiresPaidRetryConfirmation) state.operation = null;
        try {
            const normalized = validateProviderConfig({
                provider: state.settings.provider,
                baseUrl: state.elements.baseUrlInput.value,
                model: PROVIDER_DEFAULTS[state.settings.provider].model,
                apiKey: 'configuration-check-only',
            });
            // Keep invalid drafts, URL credentials and query strings out of saved settings.
            state.settings.baseUrl = normalized.baseUrl;
            saveSettings();
        } catch {
            // The visible draft is validated again before every paid request.
        }
        renderConnectionStatus();
    });
    listen(state.elements.modelInput, 'input', () => {
        if (isInteractionBusy()) return;
        state.settings.model = state.elements.modelInput.value.trim().slice(0, 200);
        if (!state.requiresPaidRetryConfirmation) state.operation = null;
        saveSettings();
        renderConnectionStatus();
    });
    listen(state.elements.apiKeyInput, 'input', () => {
        if (isInteractionBusy()) return;
        state.apiKey = state.elements.apiKeyInput.value.trim();
        if (!state.requiresPaidRetryConfirmation) state.operation = null;
        renderConnectionStatus();
    });
    listen(state.elements.clearKeyButton, 'click', () => {
        if (isInteractionBusy()) return;
        clearApiKey();
        if (!state.requiresPaidRetryConfirmation) state.operation = null;
        renderConnectionStatus();
    });

    listen(state.elements.latestButton, 'click', () => {
        if (!selectLatestChatImage()) setStatus('error', '当前聊天中没有可用图片。');
        else setStatus('info', '已选择当前聊天中的最新图片。');
    });
    listen(state.elements.fileButton, 'click', () => state.elements.fileInput.click());
    listen(state.elements.fileInput, 'change', () => {
        const file = state.elements.fileInput.files?.[0];
        if (!file) return;
        if (file.size > MAX_INPUT_BYTES) {
            setStatus('error', `图片超过 ${Math.floor(MAX_INPUT_BYTES / 1024 / 1024)} MB 上限。`);
            state.elements.fileInput.value = '';
            return;
        }
        if (!inferMimeType(file, file.name)) {
            setStatus('error', '仅支持 PNG、JPEG 或 WebP 图片。');
            state.elements.fileInput.value = '';
            return;
        }
        selectSource(sourceFromFile(file));
        setStatus('info', '已选择手机图片。');
    });

    listen(state.elements.enabledInput, 'change', () => {
        if (isInteractionBusy()) return;
        state.settings.enabled = state.elements.enabledInput.checked;
        if (!state.settings.enabled) clearApiKey();
        saveSettings();
        renderConnectionStatus();
    });
    listen(state.elements.presetSelect, 'change', () => {
        state.settings.preset = ALLOWED_PRESETS.includes(state.elements.presetSelect.value)
            ? state.elements.presetSelect.value
            : DEFAULT_SETTINGS.preset;
        if (!state.requiresPaidRetryConfirmation) state.operation = null;
        saveSettings();
    });
    listen(state.elements.customInput, 'input', () => {
        state.settings.customInstructions = state.elements.customInput.value.slice(0, MAX_CUSTOM_INSTRUCTIONS);
        if (!state.requiresPaidRetryConfirmation) state.operation = null;
        saveSettings();
    });
    listen(state.elements.safeModeInput, 'change', () => {
        if (state.settings.provider !== 'venice' || isInteractionBusy()) {
            renderSafeModePolicy();
            return;
        }
        state.settings.safeMode = state.elements.safeModeInput.checked;
        if (!state.requiresPaidRetryConfirmation) state.operation = null;
        saveSettings();
    });
    listen(state.elements.saveToChatInput, 'change', () => {
        state.settings.saveToChat = state.elements.saveToChatInput.checked;
        saveSettings();
    });

    listen(state.elements.generateButton, 'click', () => void performTransform());
    listen(state.elements.confirmPaidRetryButton, 'click', () => {
        if (isInteractionBusy() || !state.settings.enabled || !state.connectionConfigured || !state.selectedSource) return;
        state.operation = null;
        state.pendingLockReplacementAuthorized = true;
        setStatus('info', '已确认新的付费尝试，正在创建新请求。');
        void performTransform();
    });
    listen(state.elements.downloadButton, 'click', downloadCurrentResult);
    listen(state.elements.shareButton, 'click', () => void shareCurrentResult());
    listen(state.elements.persistButton, 'click', async () => {
        const generation = state.lifecycleGeneration;
        if (!isCurrentLifecycle(generation)) return;
        const result = state.result;
        try {
            setProgress(true, '正在写入当前聊天…');
            await persistCurrentResult(generation);
            assertCurrentLifecycle(generation);
            if (!result || state.result !== result) {
                const error = new Error('保存期间当前结果已改变。');
                error.code = 'result_superseded';
                throw error;
            }
            setStatus('success', '结果已写入当前聊天。');
        } catch (error) {
            if (isCurrentLifecycle(generation) && error?.code !== 'lifecycle_stale') {
                setStatus('error', `无法写入聊天：${friendlyError(error)}`);
            }
        } finally {
            if (isCurrentLifecycle(generation)) setProgress(false);
        }
    });
}

function mount() {
    if (!state.active || state.mounted || document.getElementById(ROOT_ID)) return;
    try {
        state.context = getHostContext();
        state.settings = initializeSettings(state.context);
        buildUi();
        bindUiEvents();
        state.mounted = true;
        attachMutationObserver();
        syncSettingsControls();
        selectLatestChatImage();
        scheduleDecorateChatImages();
        restorePendingAttemptGuard();
    } catch (error) {
        console.error(`[${EXTENSION_ID}] Failed to mount:`, friendlyError(error));
        state.active = false;
        cleanup();
    }
}

function cleanup() {
    state.lifecycleGeneration += 1;
    state.transformController?.abort();
    state.persistenceController?.abort();
    clearApiKey();
    state.transformController = null;
    state.persistenceController = null;
    state.mutationObserver?.disconnect();
    state.mutationObserver = null;

    for (const callback of state.cleanupCallbacks.splice(0).reverse()) {
        try {
            callback();
        } catch (error) {
            console.warn(`[${EXTENSION_ID}] Cleanup callback failed.`);
        }
    }

    document.querySelectorAll('.cloud-realify-image-action').forEach(element => element.remove());
    state.root?.remove();
    state.root = null;

    if (state.selectedPreviewUrl) URL.revokeObjectURL(state.selectedPreviewUrl);
    if (state.resultObjectUrl) URL.revokeObjectURL(state.resultObjectUrl);
    state.selectedPreviewUrl = null;
    state.resultObjectUrl = null;
    state.elements = Object.create(null);
    state.selectedSource = null;
    state.result = null;
    state.operation = null;
    state.context = null;
    state.settings = null;
    state.decorateScheduled = false;
    state.inFlight = false;
    state.persistenceInFlight = false;
    state.requiresPaidRetryConfirmation = false;
    state.pendingLockReplacementAuthorized = false;
    state.connectionConfigured = false;
    state.mounted = false;
}

function activate() {
    if (state.active) return;
    state.active = true;
    if (document.readyState === 'loading') {
        const onReady = () => mount();
        listen(document, 'DOMContentLoaded', onReady, { once: true });
    } else {
        mount();
    }
}

export function onActivate() {
    activate();
}

export function onEnable() {
    activate();
}

export function onDisable() {
    state.active = false;
    cleanup();
}

export function onClean() {
    state.active = false;
    let context = state.context;
    try {
        context = freshContext();
    } catch {
        // Use the last valid context if clean runs during host teardown.
    }
    removeExtensionSettings(context, SETTINGS_KEY);
    cleanup();
}
