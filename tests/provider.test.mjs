import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { editImage, MAX_OUTPUT_BYTES, validateProviderConfig } from '../provider.mjs';
import { buildTransformPayload, extractTransformResult } from '../utils.mjs';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const PNG = Uint8Array.from(atob(PNG_BASE64), char => char.charCodeAt(0));
const KEY = 'test-only-not-a-real-api-key';
const CONFIG = { provider: 'venice', apiKey: KEY };
const PAYLOAD = buildTransformPayload({
    requestId: 'test-request-id-0001',
    image: `data:image/png;base64,${PNG_BASE64}`,
    preset: 'photoreal',
    customInstructions: 'Keep the original blue coat.',
    safeMode: true,
});
const binaryResponse = (bytes = PNG, mime = 'image/png') => new Response(bytes, { headers: { 'content-type': mime } });
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('configuration defaults and normalization are explicit, frozen, and local', () => {
    const config = validateProviderConfig({ provider: ' VENICE ', apiKey: ` ${KEY} ` });
    assert.deepEqual(config, { provider: 'venice', apiKey: KEY, baseUrl: 'https://api.venice.ai', model: 'qwen-edit-uncensored' });
    assert.ok(Object.isFrozen(config));
    assert.deepEqual(validateProviderConfig({ provider: 'openai', apiKey: KEY }), {
        provider: 'openai', apiKey: KEY, baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1',
    });
});

test('missing keys and invalid key values are pre-dispatch failures without secret echo', () => {
    for (const apiKey of [undefined, '', '   ']) {
        assert.throws(() => validateProviderConfig({ apiKey }), error => {
            assert.equal(error.code, 'provider_not_configured');
            assert.equal(error.outcomeUnknown, false);
            assert.equal(error.requestDispatched, false);
            return true;
        });
    }
    for (const apiKey of [`${KEY}\r\n`, `\n${KEY}`, `one two`, 123, '密钥', `${KEY}\0`]) {
        assert.throws(() => validateProviderConfig({ apiKey }), error => {
            assert.equal(error.code, 'invalid_provider_config');
            assert.ok(!error.message.includes(KEY));
            return true;
        });
    }
});

test('URL validation rejects insecure protocols, secrets, queries, fragments, and ambiguous syntax', () => {
    for (const baseUrl of [
        'http://example.com', 'file:///private', '/relative', 'https://u:p@example.com', 'https://@example.com',
        'https://example.com?api_key=secret', 'https://example.com?', 'https://example.com#fragment',
        'https://example.com#', 'https://example.com/a\nb', 'https://example.com\\path', 'https:example.com',
    ]) {
        assert.throws(() => validateProviderConfig({ ...CONFIG, baseUrl }), { code: 'invalid_provider_config' });
    }
    assert.equal(validateProviderConfig({ ...CONFIG, baseUrl: 'https://EXAMPLE.com/proxy/v1///' }).baseUrl, 'https://example.com/proxy/v1');
});

test('unsupported providers and models do not fall through to a different provider', () => {
    assert.throws(() => validateProviderConfig({ ...CONFIG, provider: 'novelai' }), { code: 'invalid_provider_config' });
    for (const model of ['bad model', 'bad\nmodel', '/', 5, 'x'.repeat(121)]) {
        assert.throws(() => validateProviderConfig({ ...CONFIG, model }), { code: 'invalid_provider_config' });
    }
});

test('Venice sends one isolated JSON request with the original preset and body contract', async () => {
    let calls = 0;
    const result = await editImage({ config: CONFIG, payload: PAYLOAD, fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url, 'https://api.venice.ai/api/v1/image/edit');
        assert.equal(options.method, 'POST');
        assert.equal(options.credentials, 'omit');
        assert.equal(options.mode, 'cors');
        assert.equal(options.redirect, 'error');
        assert.equal(options.referrerPolicy, 'no-referrer');
        assert.deepEqual(options.headers, {
            Authorization: `Bearer ${KEY}`,
            Accept: 'image/png,application/json',
            'Content-Type': 'application/json',
        });
        assert.ok(options.signal instanceof AbortSignal);
        const body = JSON.parse(options.body);
        assert.deepEqual(body, {
            model: 'qwen-edit-uncensored',
            prompt: [
                'Transform the source image into a convincing photorealistic photograph.',
                'Preserve the subject identity, pose, expression, composition, framing, clothing design, colors, and background layout.',
                'Replace illustrated rendering with natural anatomy, skin, hair, fabric, materials, lighting, depth, and camera detail.',
                'Do not add text, watermarks, borders, extra limbs, or extra subjects.',
                'Additional instructions: Keep the original blue coat.',
            ].join(' '),
            image: PNG_BASE64,
            safe_mode: true,
            output_format: 'png',
            aspect_ratio: 'auto',
        });
        return binaryResponse();
    } });
    assert.equal(calls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.requestId, PAYLOAD.requestId);
    assert.equal(result.imageDataUrl, PAYLOAD.image);
    assert.equal(extractTransformResult(result).bytes, PNG.length);
    assert.equal(JSON.stringify(result).includes(KEY), false);
});

test('all three preset prompts agree exactly with the previously tested original adapter', async () => {
    // SHA-256 snapshots from the original adapter: tests remain self-contained.
    const originalHashes = {
        photoreal: '5a1ae168717208cda0115f45500a2e6d4fe755789ac3b22666b96aafb31687da',
        cinematic: 'b05b9eca54421a8c4eb676baa021ed11a8bb79e09199fb0eed7785528af69008',
        'soft-portrait': '793e3bdef714f1064a3f64d230825abaddc2db9daf4f8a980e6c8735aff3feae',
    };
    for (const preset of ['photoreal', 'cinematic', 'soft-portrait']) {
        await editImage({ config: CONFIG, payload: { ...PAYLOAD, preset, customInstructions: '' }, fetchImpl: async (_url, options) => {
            const prompt = JSON.parse(options.body).prompt;
            assert.equal(createHash('sha256').update(prompt).digest('hex'), originalHashes[preset]);
            assert.equal(prompt.includes('Additional instructions:'), false);
            return binaryResponse();
        } });
    }
});

test('endpoint composition handles roots, version paths, full endpoints, and proxy prefixes', async () => {
    for (const [provider, baseUrl, endpoint] of [
        ['venice', 'https://example.com/api/v1', 'https://example.com/api/v1/image/edit'],
        ['venice', 'https://example.com/api/v1/image/edit/', 'https://example.com/api/v1/image/edit'],
        ['venice', 'https://example.com/proxy', 'https://example.com/proxy/api/v1/image/edit'],
        ['openai', 'https://example.com', 'https://example.com/v1/images/edits'],
        ['openai', 'https://example.com/v1/', 'https://example.com/v1/images/edits'],
        ['openai', 'https://example.com/proxy/v1/images/edits', 'https://example.com/proxy/v1/images/edits'],
    ]) {
        await editImage({ config: { ...CONFIG, provider, baseUrl }, payload: PAYLOAD, fetchImpl: async (url) => {
            assert.equal(url, endpoint);
            return jsonResponse({ data: [{ b64_json: PNG_BASE64 }] });
        } });
    }
});

test('OpenAI multipart includes a File and n=1, adds response_format only for dall-e-2', async () => {
    for (const model of ['gpt-image-1', 'dall-e-2', 'custom-edit']) {
        await editImage({ config: { ...CONFIG, provider: 'openai', model }, payload: PAYLOAD, fetchImpl: async (_url, options) => {
            assert.equal(options.credentials, 'omit');
            assert.equal(options.mode, 'cors');
            assert.equal(options.redirect, 'error');
            assert.equal(options.referrerPolicy, 'no-referrer');
            assert.deepEqual(options.headers, { Authorization: `Bearer ${KEY}`, Accept: 'application/json' });
            assert.ok(options.body instanceof FormData);
            assert.equal(options.body.get('model'), model);
            assert.equal(options.body.get('n'), '1');
            assert.equal(options.body.get('response_format'), model === 'dall-e-2' ? 'b64_json' : null);
            assert.equal(options.body.has('safe_mode'), false);
            const image = options.body.get('image');
            assert.ok(image instanceof File);
            assert.equal(image.type, 'image/png');
            assert.equal(image.name, 'source.png');
            assert.deepEqual(new Uint8Array(await image.arrayBuffer()), PNG);
            return jsonResponse({ data: [{ b64_json: PNG_BASE64 }] });
        } });
    }
});

test('supported binary MIME signatures are detected and mislabeled images are rejected', async () => {
    const jpeg = new Uint8Array([255, 216, 255, 224, 0, 0]);
    const webp = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]);
    for (const [bytes, mime] of [[PNG, 'image/png'], [jpeg, 'image/jpeg'], [webp, 'image/webp']]) {
        const result = await editImage({ config: CONFIG, payload: PAYLOAD, fetchImpl: async () => binaryResponse(bytes, mime) });
        assert.ok(result.imageDataUrl.startsWith(`data:${mime};base64,`));
    }
    for (const [bytes, mime] of [[PNG, 'image/jpeg'], [new TextEncoder().encode('<svg>unsafe</svg>'), 'image/png']]) {
        await assert.rejects(editImage({ config: CONFIG, payload: PAYLOAD, fetchImpl: async () => binaryResponse(bytes, mime) }), {
            code: 'invalid_upstream_response', outcomeUnknown: true, requestDispatched: true,
        });
    }
});

test('invalid input magic, request ID, preset, or prompt are rejected before fetch', async () => {
    for (const payload of [
        { ...PAYLOAD, image: 'data:image/png;base64,SGVsbG8=' },
        { ...PAYLOAD, requestId: 'short' }, { ...PAYLOAD, preset: 'unknown' },
        { ...PAYLOAD, customInstructions: 'x'.repeat(601) }, { ...PAYLOAD, customInstructions: 'text\0bad' },
    ]) {
        let calls = 0;
        await assert.rejects(editImage({ config: CONFIG, payload, fetchImpl: async () => { calls++; return binaryResponse(); } }), {
            code: 'invalid_request', requestDispatched: false, outcomeUnknown: false,
        });
        assert.equal(calls, 0);
    }
});

test('base64 JSON is decoded by magic without trusting upstream mime metadata', async () => {
    const result = await editImage({ config: { ...CONFIG, provider: 'openai' }, payload: PAYLOAD,
        fetchImpl: async () => jsonResponse({ data: [{ b64_json: PNG_BASE64 }] }) });
    assert.equal(result.imageDataUrl, PAYLOAD.image);
    for (const candidate of [
        { data: [{ b64_json: PNG_BASE64, mime_type: 'image/jpeg' }] },
        { data: [{ b64_json: 'not base64' }] },
        { data: [{ b64_json: btoa('<html>bad</html>') }] },
        { data: [{ b64_json: PNG_BASE64, mime_type: 'image/svg+xml' }] },
    ]) {
        await assert.rejects(editImage({ config: CONFIG, payload: PAYLOAD, fetchImpl: async () => jsonResponse(candidate) }), {
            code: 'invalid_upstream_response', outcomeUnknown: true,
        });
    }
});

test('OpenAI rejects non-b64_json fields and binary responses', async () => {
    for (const response of [jsonResponse({ image: PNG_BASE64 }), binaryResponse()]) {
        await assert.rejects(editImage({ config: { ...CONFIG, provider: 'openai' }, payload: PAYLOAD, fetchImpl: async () => response }), {
            code: 'invalid_upstream_response', outcomeUnknown: true,
        });
    }
});

test('remote result URLs are rejected, never downloaded, and never echoed', async () => {
    for (const provider of ['venice', 'openai']) {
        let calls = 0;
        await assert.rejects(editImage({ config: { ...CONFIG, provider }, payload: PAYLOAD, fetchImpl: async () => {
            calls++;
            return jsonResponse({ data: [{ url: 'https://private.example/path?token=do-not-echo' }] });
        } }), error => {
            assert.equal(error.code, 'result_url_not_allowed');
            assert.equal(error.outcomeUnknown, true);
            assert.ok(!error.message.includes('do-not-echo'));
            assert.ok(!error.message.includes('private.example'));
            return true;
        });
        assert.equal(calls, 1);
    }
});

test('HTTP failures cancel the body, sanitize output, and stay unknown even for 401/404', async () => {
    for (const status of [401, 403, 404, 429, 500]) {
        let calls = 0;
        let canceled = false;
        const response = new Response(new ReadableStream({ cancel() { canceled = true; } }), { status, statusText: KEY });
        await assert.rejects(editImage({ config: CONFIG, payload: PAYLOAD, fetchImpl: async () => { calls++; return response; } }), error => {
            assert.equal(error.outcomeUnknown, true);
            assert.equal(error.requestDispatched, true);
            assert.ok(!error.message.includes(KEY));
            assert.equal(error.cause, undefined);
            return true;
        });
        assert.equal(calls, 1);
        assert.equal(canceled, true);
    }
});

test('fetch failures including forged error codes never escape unsanitized and never retry', async () => {
    for (const upstream of [new TypeError(KEY), Object.assign(new Error(KEY), { code: 'upstream_failed' })]) {
        let calls = 0;
        await assert.rejects(editImage({ config: CONFIG, payload: PAYLOAD, fetchImpl: async () => { calls++; throw upstream; } }), error => {
            assert.equal(error.code, 'upstream_unreachable');
            assert.equal(error.outcomeUnknown, true);
            assert.equal(error.requestDispatched, true);
            assert.ok(!error.message.includes(KEY));
            assert.equal(error.cause, undefined);
            return true;
        });
        assert.equal(calls, 1);
    }
});

test('malformed JSON never leaks provider contents', async () => {
    await assert.rejects(editImage({ config: CONFIG, payload: PAYLOAD, fetchImpl: async () =>
        new Response(`{"error":"${KEY}`, { headers: { 'content-type': 'application/json' } }) }), error => {
        assert.equal(error.code, 'invalid_upstream_response');
        assert.ok(!error.message.includes(KEY));
        assert.equal(error.cause, undefined);
        return true;
    });
});

test('known oversized Content-Length cancels before reading bytes', async () => {
    assert.equal(MAX_OUTPUT_BYTES, 30 * 1024 * 1024);
    let canceled = false;
    const response = new Response(new ReadableStream({ cancel() { canceled = true; } }), {
        headers: { 'content-type': 'image/png', 'content-length': String(MAX_OUTPUT_BYTES + 1) },
    });
    await assert.rejects(editImage({ config: CONFIG, payload: PAYLOAD, fetchImpl: async () => response }), {
        code: 'upstream_response_too_large', outcomeUnknown: true,
    });
    assert.equal(canceled, true);
});

test('stream limit cancels oversized image without trusting missing or misleading Content-Length', async () => {
    for (const advertisedSize of [undefined, '1']) {
        let canceled = false;
        let pulls = 0;
        const chunk = new Uint8Array(1024 * 1024);
        const headers = { 'content-type': 'image/png' };
        if (advertisedSize) headers['content-length'] = advertisedSize;
        const response = new Response(new ReadableStream({
            pull(controller) { pulls++; controller.enqueue(chunk); },
            cancel() { canceled = true; },
        }), { headers });
        await assert.rejects(editImage({ config: CONFIG, payload: PAYLOAD, fetchImpl: async () => response }), {
            code: 'upstream_response_too_large', outcomeUnknown: true,
        });
        assert.equal(canceled, true);
        assert.ok(pulls <= 32);
    }
});

test('JSON transport also has a streaming size cap', async () => {
    let canceled = false;
    let pulls = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const response = new Response(new ReadableStream({
        pull(controller) { pulls++; controller.enqueue(chunk); },
        cancel() { canceled = true; },
    }), { headers: { 'content-type': 'application/json' } });
    await assert.rejects(editImage({ config: CONFIG, payload: PAYLOAD, fetchImpl: async () => response }), {
        code: 'upstream_response_too_large', outcomeUnknown: true,
    });
    assert.equal(canceled, true);
    assert.ok(pulls <= 43);
});

test('Base64 decoded size is capped even when the JSON transport fits its cap', async () => {
    const tooLargeBase64 = 'A'.repeat(4 * Math.ceil((MAX_OUTPUT_BYTES + 1) / 3) - 2) + '==';
    const response = jsonResponse({ data: [{ b64_json: tooLargeBase64 }] });
    await assert.rejects(editImage({ config: { ...CONFIG, provider: 'openai' }, payload: PAYLOAD, fetchImpl: async () => response }), {
        code: 'upstream_response_too_large', outcomeUnknown: true,
    });
});

test('already aborted signals make zero paid requests', async () => {
    let calls = 0;
    await assert.rejects(editImage({ config: CONFIG, payload: PAYLOAD, signal: AbortSignal.abort(),
        fetchImpl: async () => { calls++; return binaryResponse(); } }), {
        code: 'request_cancelled', outcomeUnknown: false, requestDispatched: false,
    });
    assert.equal(calls, 0);
});

test('external cancellation aborts fetch and keeps the paid outcome unknown', async () => {
    const controller = new AbortController();
    let calls = 0;
    const operation = editImage({ config: CONFIG, payload: PAYLOAD, signal: controller.signal, fetchImpl: async (_url, options) => {
        calls++;
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error(KEY)), { once: true }));
    } });
    controller.abort();
    await assert.rejects(operation, { code: 'upstream_aborted', outcomeUnknown: true, requestDispatched: true });
    assert.equal(calls, 1);
});

test('external cancellation cancels an active response reader', async () => {
    const controller = new AbortController();
    let canceled = false;
    let started;
    const hasReader = new Promise(resolve => { started = resolve; });
    const response = new Response(new ReadableStream({
        pull() { started(); }, cancel() { canceled = true; },
    }), { headers: { 'content-type': 'image/png' } });
    const operation = editImage({ config: CONFIG, payload: PAYLOAD, signal: controller.signal, fetchImpl: async () => response });
    await hasReader;
    await Promise.resolve();
    controller.abort();
    await assert.rejects(operation, { code: 'upstream_aborted', outcomeUnknown: true });
    assert.equal(canceled, true);
});

test('120-second local timeout aborts once without retrying', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    const operation = editImage({ config: CONFIG, payload: PAYLOAD, fetchImpl: async (_url, options) => {
        calls++;
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error(KEY)), { once: true }));
    } });
    t.mock.timers.tick(120_000);
    await assert.rejects(operation, { code: 'upstream_timeout', outcomeUnknown: true, requestDispatched: true });
    assert.equal(calls, 1);
});

test('completed operations remove their timeout and external abort subscription', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    let requestSignal;
    await editImage({ config: CONFIG, payload: PAYLOAD, signal: controller.signal, fetchImpl: async (_url, options) => {
        requestSignal = options.signal;
        return binaryResponse();
    } });
    controller.abort();
    t.mock.timers.tick(120_000);
    assert.equal(requestSignal.aborted, false);
});

test('browser adapter has no Node imports, buffers, storage writes, or host credential helpers', async () => {
    const source = await readFile(new URL('../provider.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bBuffer\b|node:|getRequestHeaders|localStorage|sessionStorage|extensionSettings|\bCookie\b|CSRF/i);
});
