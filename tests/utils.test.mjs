import assert from 'node:assert/strict';
import test from 'node:test';

import {
    base64ByteLength,
    buildChatIdentity,
    buildChatReadbackRequest,
    buildTransformPayload,
    extensionForMimeType,
    extractTransformResult,
    normalizeMimeType,
    parseImageDataUrl,
    requiresPaidRetryConfirmation,
    isLifecycleGenerationCurrent,
    getSafeModeUiState,
    resolveSafeModePolicy,
    verifyChatPersistenceReadback,
    clearPendingAttempt,
    readPendingAttempt,
    removeExtensionSettings,
    verifyPendingAttempt,
    withCrossTabPaidLock,
    writePendingAttempt,
} from '../utils.mjs';

class MemoryStorage {
    constructor() {
        this.values = new Map();
    }

    getItem(key) {
        return this.values.has(key) ? this.values.get(key) : null;
    }

    setItem(key, value) {
        this.values.set(key, String(value));
    }

    removeItem(key) {
        this.values.delete(key);
    }
}

test('Web Locks rejects a simultaneous cross-tab paid dispatch instead of queueing it', async () => {
    let held = false;
    let releaseFirst;
    const gate = new Promise(resolve => { releaseFirst = resolve; });
    const lockManager = {
        async request(name, options, callback) {
            assert.equal(name, 'cloud-realify:paid-provider-dispatch');
            assert.deepEqual(options, { mode: 'exclusive', ifAvailable: true });
            if (held) return callback(null);
            held = true;
            try {
                return await callback({ name });
            } finally {
                held = false;
            }
        },
    };

    const first = withCrossTabPaidLock(lockManager, async () => {
        await gate;
        return 'first';
    });
    await assert.rejects(
        withCrossTabPaidLock(lockManager, async () => 'second'),
        error => error?.code === 'cross_tab_paid_busy',
    );
    releaseFirst();
    assert.equal(await first, 'first');
});

test('paid dispatch remains available when Web Locks is unsupported', async () => {
    assert.equal(await withCrossTabPaidLock(null, async () => 'fallback'), 'fallback');
});

const ONE_PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('normalizes only supported image MIME types', () => {
    assert.equal(normalizeMimeType('IMAGE/JPG'), 'image/jpeg');
    assert.equal(normalizeMimeType('image/webp'), 'image/webp');
    assert.equal(normalizeMimeType('image/svg+xml'), null);
});

test('parses a valid image data URL and rejects active SVG content', () => {
    const parsed = parseImageDataUrl(ONE_PIXEL_PNG);
    assert.equal(parsed.mimeType, 'image/png');
    assert.ok(parsed.bytes > 0);
    assert.throws(
        () => parseImageDataUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='),
        /仅支持 PNG、JPEG 或 WebP/,
    );
});

test('computes padded base64 byte lengths', () => {
    assert.equal(base64ByteLength('TQ=='), 1);
    assert.equal(base64ByteLength('TWE='), 2);
    assert.equal(base64ByteLength('TWFu'), 3);
});

test('builds the exact allowlisted transform payload', () => {
    const payload = buildTransformPayload({
        requestId: 'test-request-12345',
        image: ONE_PIXEL_PNG,
        preset: 'cinematic',
        customInstructions: '  natural window light  ',
        safeMode: true,
        apiKey: 'must-not-leak',
    });
    assert.deepEqual(payload, {
        requestId: 'test-request-12345',
        image: ONE_PIXEL_PNG,
        preset: 'cinematic',
        customInstructions: 'natural window light',
        safeMode: true,
    });
    assert.equal('apiKey' in payload, false);
});

test('rejects unknown presets before a provider request', () => {
    assert.throws(
        () => buildTransformPayload({
            requestId: 'test-request-12345',
            image: ONE_PIXEL_PNG,
            preset: 'arbitrary-provider-model',
            customInstructions: '',
            safeMode: false,
        }),
        /预设无效/,
    );
});

test('extracts only a validated raster result', () => {
    const result = extractTransformResult({
        ok: true,
        requestId: 'test-request-12345',
        imageDataUrl: ONE_PIXEL_PNG,
        provider: 'mock',
        model: 'mock-edit',
        cached: true,
    });
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.provider, 'mock');
    assert.equal(result.cached, true);
    assert.equal(extensionForMimeType(result.mimeType), 'png');
    assert.throws(() => extractTransformResult({
        ok: true,
        imageDataUrl: ONE_PIXEL_PNG,
    }), /请求标识无效/);
});

test('chat identity separates characters, groups, duplicate IDs, and null IDs', () => {
    const base = {
        chatId: null,
        groupId: null,
        characterId: 3,
        characterName: 'Alice',
        chatInstanceToken: 'chat-ref-1',
    };
    const first = buildChatIdentity(base);
    assert.notEqual(first, buildChatIdentity({ ...base, characterId: 4 }));
    assert.notEqual(first, buildChatIdentity({ ...base, groupId: 'group-3' }));
    assert.notEqual(first, buildChatIdentity({ ...base, chatInstanceToken: 'chat-ref-2' }));
    assert.notEqual(
        buildChatIdentity({ ...base, chatId: 'duplicate', chatInstanceToken: 'chat-ref-1' }),
        buildChatIdentity({ ...base, chatId: 'duplicate', chatInstanceToken: 'chat-ref-2' }),
    );
});

test('chat readback requests and verification cover 5xx, missing, and success', () => {
    assert.deepEqual(buildChatReadbackRequest({
        chatId: 'character-chat',
        groupId: null,
        characterName: 'Alice',
        avatarUrl: 'alice.png',
    }), {
        endpoint: '/api/chats/get',
        body: {
            ch_name: 'Alice',
            file_name: 'character-chat',
            avatar_url: 'alice.png',
        },
    });
    assert.deepEqual(buildChatReadbackRequest({
        chatId: 'group-chat',
        groupId: 'group-1',
        characterName: '',
        avatarUrl: '',
    }), {
        endpoint: '/api/chats/group/get',
        body: { id: 'group-chat' },
    });

    assert.deepEqual(verifyChatPersistenceReadback({
        responseOk: false,
        status: 500,
        payload: null,
        requestId: 'request-123456',
    }), {
        ok: false,
        reason: 'http_500',
        message: '聊天回读失败（HTTP 500）。',
    });
    assert.equal(verifyChatPersistenceReadback({
        responseOk: true,
        status: 200,
        payload: [{ mes: 'another message' }],
        requestId: 'request-123456',
    }).reason, 'message_missing');
    assert.deepEqual(verifyChatPersistenceReadback({
        responseOk: true,
        status: 200,
        payload: [{ extra: { cloud_realify: { request_id: 'request-123456' } } }],
        requestId: 'request-123456',
    }), { ok: true, reason: null, message: '' });
});

test('paid retry protection defaults every post-dispatch failure to unknown', () => {
    assert.equal(requiresPaidRetryConfirmation({ requestDispatched: true, code: 'result_url_not_allowed' }), true);
    assert.equal(requiresPaidRetryConfirmation({ requestDispatched: true, code: 'invalid_image' }), true);
    assert.equal(requiresPaidRetryConfirmation({ requestDispatched: true, code: 'unsupported_image_type' }), true);
    assert.equal(requiresPaidRetryConfirmation({ requestDispatched: true, code: 'image_too_large' }), true);
    assert.equal(requiresPaidRetryConfirmation({ requestDispatched: true, code: 'image_type_mismatch' }), true);
    assert.equal(requiresPaidRetryConfirmation({ requestDispatched: true, code: undefined }), true);
});

test('paid retry protection exempts only proven pre-dispatch errors', () => {
    for (const code of [
        'provider_not_configured',
        'busy',
        'rate_limited',
        'invalid_request',
        'safe_mode_locked',
        'model_not_allowed',
        'request_id_conflict',
        'plugin_stopped',
    ]) {
        assert.equal(requiresPaidRetryConfirmation({ requestDispatched: true, code }), false, code);
    }
    assert.equal(requiresPaidRetryConfirmation({ requestDispatched: false, code: 'invalid_image' }), false);
    assert.equal(requiresPaidRetryConfirmation({
        requestDispatched: false,
        code: 'request_outcome_unknown',
    }), true);
    assert.equal(requiresPaidRetryConfirmation({
        requestDispatched: true,
        code: 'provider_not_configured',
        outcomeUnknown: true,
    }), true);
});

test('lifecycle generation rejects stale or unmounted asynchronous work', () => {
    assert.equal(isLifecycleGenerationCurrent({
        capturedGeneration: 4,
        currentGeneration: 4,
        active: true,
        mounted: true,
    }), true);
    assert.equal(isLifecycleGenerationCurrent({
        capturedGeneration: 4,
        currentGeneration: 5,
        active: true,
        mounted: true,
    }), false);
    assert.equal(isLifecycleGenerationCurrent({
        capturedGeneration: 4,
        currentGeneration: 4,
        active: false,
        mounted: true,
    }), false);
    assert.equal(isLifecycleGenerationCurrent({
        capturedGeneration: 4,
        currentGeneration: 4,
        active: true,
        mounted: false,
    }), false);
});

test('safe mode support is conservative for legacy health responses', () => {
    assert.equal(resolveSafeModePolicy({ provider: 'venice' }).safeModeSupported, true);
    assert.equal(resolveSafeModePolicy({ provider: 'openai' }).safeModeSupported, false);
    assert.equal(resolveSafeModePolicy({ provider: 'custom' }).safeModeSupported, false);
    assert.equal(resolveSafeModePolicy({ provider: 'openai', safeModeSupported: true }).safeModeSupported, true);
    assert.equal(resolveSafeModePolicy({ provider: 'venice', safeModeSupported: false }).safeModeSupported, false);
});

test('unsupported safe mode is forced off and explained without overriding Venice lock semantics', () => {
    const unsupported = getSafeModeUiState({
        policy: resolveSafeModePolicy({ provider: 'openai', safeModeSupported: false }),
        currentValue: true,
        inFlight: false,
    });
    assert.deepEqual(unsupported, {
        disabled: true,
        effectiveValue: false,
        message: '该适配器遵循上游自身内容策略，扩展无法切换。',
    });

    const lockedVenice = getSafeModeUiState({
        policy: resolveSafeModePolicy({
            provider: 'venice',
            safeModeSupported: true,
            safeModeDefault: false,
            safeModeLocked: true,
        }),
        currentValue: true,
        inFlight: false,
    });
    assert.equal(lockedVenice.disabled, true);
    assert.equal(lockedVenice.effectiveValue, false);
    assert.match(lockedVenice.message, /安全模式已锁定为关闭/);
});

test('pending paid lock survives reload and cleanup-like teardown', () => {
    const storage = new MemoryStorage();
    const now = 1_800_000_000_000;
    assert.equal(writePendingAttempt(storage, 'pending-request-123', now).ok, true);

    // A reload or cleanup creates new in-memory state but must not touch localStorage.
    const afterReload = readPendingAttempt(storage, now + 1000);
    assert.equal(afterReload.status, 'pending');
    assert.equal(afterReload.lock.requestId, 'pending-request-123');
    assert.equal(verifyPendingAttempt(storage, 'pending-request-123', now + 1000), true);
});

test('confirmed success and proven pre-dispatch errors clear only a matching lock', () => {
    const now = 1_800_000_000_000;
    for (const terminalReason of ['confirmed-success', 'proven-pre-dispatch']) {
        const storage = new MemoryStorage();
        const requestId = `${terminalReason}-request`;
        assert.equal(writePendingAttempt(storage, requestId, now).ok, true);
        assert.deepEqual(clearPendingAttempt(storage, requestId, now + 1), {
            ok: true,
            cleared: true,
            reason: null,
        });
        assert.equal(readPendingAttempt(storage, now + 1).status, 'empty');
    }

    const storage = new MemoryStorage();
    assert.equal(writePendingAttempt(storage, 'tab-a-request-123', now).ok, true);
    assert.equal(clearPendingAttempt(storage, 'tab-b-request-456', now + 1).ok, false);
    assert.equal(readPendingAttempt(storage, now + 1).lock.requestId, 'tab-a-request-123');
});

test('post-dispatch failure or abort retains the pending paid lock', () => {
    const storage = new MemoryStorage();
    const now = 1_800_000_000_000;
    assert.equal(writePendingAttempt(storage, 'unknown-result-123', now).ok, true);

    // Post-dispatch failure intentionally performs no clear operation.
    assert.equal(readPendingAttempt(storage, now + 5000).status, 'pending');
    assert.equal(verifyPendingAttempt(storage, 'unknown-result-123', now + 5000), true);
});

test('storage failure and failed read-back verification fail closed', () => {
    const throwingStorage = {
        getItem() { throw new Error('blocked'); },
        setItem() { throw new Error('blocked'); },
        removeItem() { throw new Error('blocked'); },
    };
    assert.equal(writePendingAttempt(throwingStorage, 'storage-failure-123').ok, false);
    assert.equal(readPendingAttempt(throwingStorage).status, 'unavailable');

    const overwrittenStorage = new MemoryStorage();
    overwrittenStorage.setItem = function setItem(key) {
        this.values.set(key, '{"version":1,"requestId":"other-tab-request","timestamp":1800000000000}');
    };
    assert.equal(writePendingAttempt(overwrittenStorage, 'our-tab-request-123', 1_800_000_000_000).ok, false);
});

test('clean removes extension settings and schedules persistence without recreating defaults', () => {
    let saves = 0;
    const context = {
        extensionSettings: {
            cloudRealify: { enabled: true },
            unrelated: { keep: true },
        },
        saveSettingsDebounced() { saves += 1; },
    };
    assert.equal(removeExtensionSettings(context, 'cloudRealify'), true);
    assert.equal(Object.hasOwn(context.extensionSettings, 'cloudRealify'), false);
    assert.deepEqual(context.extensionSettings.unrelated, { keep: true });
    assert.equal(saves, 1);
});
