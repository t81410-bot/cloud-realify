export const ALLOWED_IMAGE_MIME_TYPES = Object.freeze([
    'image/png',
    'image/jpeg',
    'image/webp',
]);

export const ALLOWED_PRESETS = Object.freeze([
    'photoreal',
    'cinematic',
    'soft-portrait',
]);

export const MAX_INPUT_BYTES = 15 * 1024 * 1024;
export const MAX_CUSTOM_INSTRUCTIONS = 600;
export const PENDING_ATTEMPT_STORAGE_KEY = 'cloud-realify:pending-paid-attempt:v1';
export const PENDING_ATTEMPT_VERSION = 1;
export const PENDING_ATTEMPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const PROVEN_PRE_DISPATCH_ERROR_CODES = Object.freeze([
    'provider_not_configured',
    'busy',
    'rate_limited',
    'invalid_request_id',
    'invalid_request',
    'invalid_json',
    'request_too_large',
    'invalid_model',
    'invalid_preset',
    'model_not_allowed',
    'safe_mode_locked',
    'unsupported_field',
    'request_id_conflict',
    'plugin_stopped',
]);

export async function withCrossTabPaidLock(lockManager, callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    if (!lockManager || typeof lockManager.request !== 'function') return callback();

    return lockManager.request(
        'cloud-realify:paid-provider-dispatch',
        { mode: 'exclusive', ifAvailable: true },
        async lock => {
            if (!lock) {
                const error = new Error('另一个 SillyTavern 页面正在发起付费图像请求，已阻止本次操作。');
                error.code = 'cross_tab_paid_busy';
                throw error;
            }
            return callback();
        },
    );
}

export function normalizeMimeType(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'image/jpg') {
        return 'image/jpeg';
    }

    return ALLOWED_IMAGE_MIME_TYPES.includes(normalized) ? normalized : null;
}

export function base64ByteLength(base64) {
    const normalized = String(base64 ?? '');
    if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
        throw new Error('图片 Base64 数据无效。');
    }

    const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
    return (normalized.length / 4) * 3 - padding;
}

export function parseImageDataUrl(value, maxBytes = MAX_INPUT_BYTES) {
    const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(String(value ?? ''));
    if (!match) {
        throw new Error('仅支持 PNG、JPEG 或 WebP 图片。');
    }

    const mimeType = normalizeMimeType(match[1]);
    if (!mimeType) {
        throw new Error('不支持此图片格式。');
    }

    const base64 = match[2];
    const bytes = base64ByteLength(base64);
    if (bytes > maxBytes) {
        throw new Error(`图片超过 ${Math.floor(maxBytes / 1024 / 1024)} MB 上限。`);
    }

    return { mimeType, base64, bytes };
}

export function buildTransformPayload({ requestId, image, preset, customInstructions, safeMode }) {
    const normalizedRequestId = String(requestId ?? '').trim();
    if (!/^[A-Za-z0-9_-]{12,80}$/.test(normalizedRequestId)) {
        throw new Error('请求标识无效。');
    }

    parseImageDataUrl(image);

    const normalizedPreset = String(preset ?? 'photoreal');
    if (!ALLOWED_PRESETS.includes(normalizedPreset)) {
        throw new Error('写实化预设无效。');
    }

    const normalizedInstructions = String(customInstructions ?? '').trim();
    if (normalizedInstructions.length > MAX_CUSTOM_INSTRUCTIONS) {
        throw new Error(`附加要求不能超过 ${MAX_CUSTOM_INSTRUCTIONS} 个字符。`);
    }

    return {
        requestId: normalizedRequestId,
        image,
        preset: normalizedPreset,
        customInstructions: normalizedInstructions,
        safeMode: Boolean(safeMode),
    };
}

export function extractTransformResult(payload) {
    if (!payload || payload.ok !== true) {
        throw new Error('图片编辑接口未返回有效结果。');
    }

    const requestId = String(payload.requestId ?? '').trim();
    if (!/^[A-Za-z0-9_-]{12,80}$/.test(requestId)) {
        throw new Error('图片编辑结果中的请求标识无效。');
    }

    const imageDataUrl = typeof payload.imageDataUrl === 'string'
        ? payload.imageDataUrl
        : typeof payload.dataUrl === 'string'
            ? payload.dataUrl
            : null;

    if (!imageDataUrl) {
        throw new Error('图片编辑结果中缺少图片。');
    }

    const parsed = parseImageDataUrl(imageDataUrl, 30 * 1024 * 1024);
    return {
        requestId,
        imageDataUrl,
        mimeType: parsed.mimeType,
        base64: parsed.base64,
        bytes: parsed.bytes,
        provider: typeof payload.provider === 'string' ? payload.provider : '',
        model: typeof payload.model === 'string' ? payload.model : '',
        cached: Boolean(payload.cached),
        deduplicated: Boolean(payload.deduplicated),
    };
}

export function extensionForMimeType(mimeType) {
    switch (normalizeMimeType(mimeType)) {
        case 'image/jpeg': return 'jpg';
        case 'image/webp': return 'webp';
        default: return 'png';
    }
}

export function buildChatIdentity({
    chatId,
    groupId,
    characterId,
    characterName,
    chatInstanceToken,
}) {
    const isGroup = groupId !== null && groupId !== undefined;
    const ownerType = isGroup ? 'group' : 'character';
    const ownerId = isGroup
        ? String(groupId)
        : `${characterId === null || characterId === undefined ? 'none' : String(characterId)}:${String(characterName ?? '')}`;
    const normalizedChatId = chatId === null || chatId === undefined || chatId === ''
        ? '<no-chat-id>'
        : String(chatId);
    const instanceToken = String(chatInstanceToken ?? '<no-chat-instance>');
    return JSON.stringify([ownerType, ownerId, normalizedChatId, instanceToken]);
}

function normalizeChatPersistenceTarget({
    chatId,
    groupId,
    characterName,
    avatarUrl,
}) {
    if ((typeof chatId !== 'string' && typeof chatId !== 'number') || String(chatId).trim() === '') {
        throw new Error('当前聊天缺少可保存的聊天标识。');
    }

    const isGroup = groupId !== null && groupId !== undefined;
    if (!isGroup && !String(characterName ?? '').trim()) {
        throw new Error('当前角色聊天缺少角色名称。');
    }
    if (!isGroup && !String(avatarUrl ?? '').trim()) {
        throw new Error('当前角色聊天缺少角色头像标识。');
    }

    return {
        isGroup,
        chatId,
        characterName: String(characterName ?? ''),
        avatarUrl: String(avatarUrl ?? ''),
    };
}

export function buildChatReadbackRequest({
    chatId,
    groupId,
    characterName,
    avatarUrl,
}) {
    const target = normalizeChatPersistenceTarget({
        chatId,
        groupId,
        characterName,
        avatarUrl,
    });
    return target.isGroup
        ? { endpoint: '/api/chats/group/get', body: { id: target.chatId } }
        : {
            endpoint: '/api/chats/get',
            body: {
                ch_name: target.characterName,
                file_name: target.chatId,
                avatar_url: target.avatarUrl,
            },
        };
}

export function verifyChatPersistenceReadback({
    responseOk,
    status,
    payload,
    requestId,
}) {
    if (responseOk !== true) {
        return {
            ok: false,
            reason: `http_${Number.isInteger(status) ? status : 'error'}`,
            message: `聊天回读失败（HTTP ${Number.isInteger(status) ? status : '未知'}）。`,
        };
    }
    if (!Array.isArray(payload)) {
        return {
            ok: false,
            reason: 'invalid_response',
            message: '聊天回读接口未返回消息数组。',
        };
    }

    const normalizedRequestId = String(requestId ?? '');
    const found = normalizedRequestId !== '' && payload.some(message => (
        message?.extra?.cloud_realify?.request_id === normalizedRequestId
    ));
    return found
        ? { ok: true, reason: null, message: '' }
        : {
            ok: false,
            reason: 'message_missing',
            message: '保存接口已返回，但服务端回读中未找到本次结果。',
        };
}

export function requiresPaidRetryConfirmation({
    requestDispatched,
    code,
    outcomeUnknown,
}) {
    if (outcomeUnknown === true || code === 'request_outcome_unknown') return true;
    if (!requestDispatched) return false;
    return !PROVEN_PRE_DISPATCH_ERROR_CODES.includes(String(code ?? ''));
}

export function isLifecycleGenerationCurrent({
    capturedGeneration,
    currentGeneration,
    active,
    mounted,
}) {
    return Number.isInteger(capturedGeneration)
        && capturedGeneration === currentGeneration
        && active === true
        && mounted === true;
}

export function resolveSafeModePolicy(payload) {
    const provider = String(payload?.provider ?? '').trim().toLowerCase();
    const safeModeSupported = typeof payload?.safeModeSupported === 'boolean'
        ? payload.safeModeSupported
        : provider === 'venice';
    return {
        checked: true,
        provider,
        safeModeSupported,
        safeModeDefault: typeof payload?.safeModeDefault === 'boolean'
            ? payload.safeModeDefault
            : null,
        safeModeLocked: safeModeSupported && payload?.safeModeLocked === true,
    };
}

export function getSafeModeUiState({ policy, currentValue, inFlight }) {
    if (!policy?.checked) {
        return {
            disabled: true,
            effectiveValue: Boolean(currentValue),
            message: '正在读取服务商安全模式设置。',
        };
    }
    if (policy.safeModeSupported !== true) {
        return {
            disabled: true,
            effectiveValue: false,
            message: '该适配器遵循上游自身内容策略，扩展无法切换。',
        };
    }
    if (policy.safeModeLocked) {
        const effectiveValue = typeof policy.safeModeDefault === 'boolean'
            ? policy.safeModeDefault
            : Boolean(currentValue);
        return {
            disabled: true,
            effectiveValue,
            message: `安全模式已锁定为${effectiveValue ? '开启' : '关闭'}。`,
        };
    }
    if (typeof policy.safeModeDefault === 'boolean') {
        return {
            disabled: Boolean(inFlight),
            effectiveValue: Boolean(currentValue),
            message: `服务商支持安全模式，默认${policy.safeModeDefault ? '开启' : '关闭'}；当前使用上方设置。`,
        };
    }
    return {
        disabled: Boolean(inFlight),
        effectiveValue: Boolean(currentValue),
        message: '服务商支持由本扩展提交安全模式设置。',
    };
}

function validatePendingAttempt(value, now, maxAgeMs) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Object.keys(value).sort();
    if (keys.join(',') !== 'requestId,timestamp,version') return null;
    if (value.version !== PENDING_ATTEMPT_VERSION) return null;
    if (!/^[A-Za-z0-9_-]{12,128}$/.test(String(value.requestId ?? ''))) return null;
    if (!Number.isSafeInteger(value.timestamp) || value.timestamp <= 0) return null;
    if (value.timestamp > now + 5 * 60 * 1000) return null;
    return {
        version: PENDING_ATTEMPT_VERSION,
        requestId: String(value.requestId),
        timestamp: value.timestamp,
        expired: now - value.timestamp > maxAgeMs,
    };
}

export function readPendingAttempt(
    storage,
    now = Date.now(),
    maxAgeMs = PENDING_ATTEMPT_MAX_AGE_MS,
) {
    if (!storage || typeof storage.getItem !== 'function') {
        return { status: 'unavailable', lock: null, raw: null };
    }
    let raw;
    try {
        raw = storage.getItem(PENDING_ATTEMPT_STORAGE_KEY);
    } catch {
        return { status: 'unavailable', lock: null, raw: null };
    }
    if (raw === null || raw === undefined || raw === '') {
        return { status: 'empty', lock: null, raw: null };
    }
    try {
        const lock = validatePendingAttempt(JSON.parse(raw), now, maxAgeMs);
        if (!lock) return { status: 'corrupt', lock: null, raw };
        return { status: lock.expired ? 'expired' : 'pending', lock, raw };
    } catch {
        return { status: 'corrupt', lock: null, raw };
    }
}

export function writePendingAttempt(storage, requestId, timestamp = Date.now()) {
    const lock = validatePendingAttempt({
        version: PENDING_ATTEMPT_VERSION,
        requestId,
        timestamp,
    }, timestamp, PENDING_ATTEMPT_MAX_AGE_MS);
    if (!lock) return { ok: false, reason: 'invalid_lock', lock: null };
    const serialized = JSON.stringify({
        version: PENDING_ATTEMPT_VERSION,
        requestId: lock.requestId,
        timestamp: lock.timestamp,
    });
    if (!storage || typeof storage.setItem !== 'function' || typeof storage.getItem !== 'function') {
        return { ok: false, reason: 'storage_unavailable', lock: null };
    }
    try {
        storage.setItem(PENDING_ATTEMPT_STORAGE_KEY, serialized);
        const readBack = storage.getItem(PENDING_ATTEMPT_STORAGE_KEY);
        if (readBack !== serialized) {
            return { ok: false, reason: 'verification_failed', lock: null };
        }
        const verified = readPendingAttempt(storage, timestamp);
        if (verified.status !== 'pending'
            || verified.lock.requestId !== lock.requestId
            || verified.lock.timestamp !== lock.timestamp) {
            return { ok: false, reason: 'verification_failed', lock: null };
        }
        return { ok: true, reason: null, lock: verified.lock };
    } catch {
        return { ok: false, reason: 'storage_unavailable', lock: null };
    }
}

export function verifyPendingAttempt(storage, requestId, now = Date.now()) {
    const current = readPendingAttempt(storage, now);
    return current.status === 'pending' && current.lock.requestId === requestId;
}

export function clearPendingAttempt(storage, requestId, now = Date.now()) {
    const current = readPendingAttempt(storage, now);
    if (current.status === 'empty') return { ok: true, cleared: false, reason: null };
    if (!current.lock || current.lock.requestId !== requestId) {
        return { ok: false, cleared: false, reason: current.status };
    }
    try {
        const readBackBeforeRemove = storage.getItem(PENDING_ATTEMPT_STORAGE_KEY);
        if (readBackBeforeRemove !== current.raw) {
            return { ok: false, cleared: false, reason: 'changed' };
        }
        storage.removeItem(PENDING_ATTEMPT_STORAGE_KEY);
        if (storage.getItem(PENDING_ATTEMPT_STORAGE_KEY) !== null) {
            return { ok: false, cleared: false, reason: 'verification_failed' };
        }
        return { ok: true, cleared: true, reason: null };
    } catch {
        return { ok: false, cleared: false, reason: 'storage_unavailable' };
    }
}

export function removeExtensionSettings(context, settingsKey) {
    if (!context?.extensionSettings || typeof context.extensionSettings !== 'object') return false;
    if (!Object.hasOwn(context.extensionSettings, settingsKey)) return false;
    delete context.extensionSettings[settingsKey];
    context.saveSettingsDebounced?.();
    return true;
}

export function createRequestId(cryptoObject = globalThis.crypto) {
    if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
        return cryptoObject.randomUUID();
    }

    if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
        const bytes = new Uint8Array(16);
        cryptoObject.getRandomValues(bytes);
        return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    }

    const time = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2);
    return `fallback-${time}-${random}`;
}
