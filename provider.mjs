import {
    base64ByteLength,
    buildTransformPayload,
    extensionForMimeType,
    normalizeMimeType,
    parseImageDataUrl,
} from './utils.mjs';

export const MAX_OUTPUT_BYTES = 30 * 1024 * 1024;
const MAX_JSON_BYTES = Math.ceil(MAX_OUTPUT_BYTES * 4 / 3) + 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;

// Kept identical to the original server adapter's neutral image-edit presets.
const PRESETS = Object.freeze({
    photoreal: [
        'Transform the source image into a convincing photorealistic photograph.',
        'Preserve the subject identity, pose, expression, composition, framing, clothing design, colors, and background layout.',
        'Replace illustrated rendering with natural anatomy, skin, hair, fabric, materials, lighting, depth, and camera detail.',
        'Do not add text, watermarks, borders, extra limbs, or extra subjects.',
    ].join(' '),
    cinematic: [
        'Transform the source image into a cinematic live-action still with physically plausible details and lighting.',
        'Preserve the subject identity, pose, expression, composition, framing, wardrobe design, palette, and scene layout.',
        'Use realistic anatomy, skin, hair, fabric, materials, lens depth, and restrained film color grading.',
        'Do not add text, watermarks, borders, extra limbs, or extra subjects.',
    ].join(' '),
    'soft-portrait': [
        'Transform the source image into a natural realistic portrait photographed with soft flattering light.',
        'Preserve the subject identity, facial expression, pose, framing, hairstyle, clothing design, colors, and background layout.',
        'Use believable anatomy, skin texture, hair strands, fabric, materials, and camera depth without plastic-looking skin.',
        'Do not add text, watermarks, borders, extra limbs, or extra subjects.',
    ].join(' '),
});

class ProviderError extends Error {
    constructor(code, message, outcomeUnknown) {
        super(message);
        this.code = code;
        this.outcomeUnknown = outcomeUnknown;
        this.requestDispatched = outcomeUnknown;
    }
}

function providerError(code, message, outcomeUnknown = false) {
    return new ProviderError(code, message, outcomeUnknown);
}

export function validateProviderConfig(config = {}) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw providerError('invalid_provider_config', '图片 API 配置无效。');
    }
    const provider = String(config.provider ?? 'venice').trim().toLowerCase();
    if (!['venice', 'openai'].includes(provider)) {
        throw providerError('invalid_provider_config', '请选择 Venice 或 OpenAI 兼容图片编辑接口。');
    }

    const rawKey = config.apiKey ?? '';
    if (typeof rawKey !== 'string' || /[\r\n]/.test(rawKey)) {
        throw providerError('invalid_provider_config', 'API Key 格式无效，不能包含换行。');
    }
    const apiKey = rawKey.trim();
    if (!apiKey) throw providerError('provider_not_configured', '请先在扩展设置中填写图片 API Key。');
    if (!/^[\x21-\x7e]{1,4096}$/.test(apiKey)) {
        throw providerError('invalid_provider_config', 'API Key 包含不支持的字符或长度过长。');
    }

    const baseUrlValue = config.baseUrl || (provider === 'venice'
        ? 'https://api.venice.ai'
        : 'https://api.openai.com/v1');
    if (typeof baseUrlValue !== 'string') {
        throw providerError('invalid_provider_config', 'API 地址必须是 HTTPS 网址。');
    }
    const baseUrl = baseUrlValue.trim();
    let parsed;
    try {
        parsed = new URL(baseUrl);
    } catch {
        throw providerError('invalid_provider_config', 'API 地址必须是有效的 HTTPS 网址。');
    }
    if (parsed.protocol !== 'https:' || /[\u0000-\u0020\u007f\\?#]/.test(baseUrl)
        || !/^https:\/\//i.test(baseUrl) || parsed.username || parsed.password
        || baseUrl.split('/')[2]?.includes('@')) {
        throw providerError('invalid_provider_config', 'API 地址仅支持 HTTPS，且不能包含账号密码、查询参数或片段。');
    }
    const modelValue = config.model || (provider === 'venice' ? 'qwen-edit-uncensored' : 'gpt-image-1');
    if (typeof modelValue !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,119}$/.test(modelValue.trim())) {
        throw providerError('invalid_provider_config', '图片编辑模型名称无效。');
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return Object.freeze({
        provider,
        baseUrl: parsed.toString().replace(/\/$/, ''),
        model: modelValue.trim(),
        apiKey,
    });
}

function endpointFor(config) {
    const endpoint = new URL(config.baseUrl);
    let path = endpoint.pathname.replace(/\/+$/, '');
    if (config.provider === 'venice') {
        if (!path.endsWith('/api/v1/image/edit')) {
            path += path.endsWith('/api/v1') ? '/image/edit' : '/api/v1/image/edit';
        }
    } else if (!path.endsWith('/v1/images/edits')) {
        path += path.endsWith('/v1') ? '/images/edits' : '/v1/images/edits';
    }
    endpoint.pathname = path;
    return endpoint.toString();
}

function detectImageMime(bytes) {
    if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) {
        return 'image/png';
    }
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70
        && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return 'image/webp';
    return null;
}

function decodeBase64(value, maximumBytes) {
    const size = base64ByteLength(value);
    if (size > maximumBytes) throw providerError('upstream_response_too_large', '云端返回的图片超过 30 MB 上限。');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (let index = 0; index < value.length; index += 32768) {
        const chunk = atob(value.slice(index, index + 32768));
        for (let cursor = 0; cursor < chunk.length; cursor++) bytes[offset++] = chunk.charCodeAt(cursor);
    }
    return bytes;
}

function encodeBase64(bytes) {
    const chunks = [];
    // A multiple of three lets each chunk be base64-encoded independently.
    for (let index = 0; index < bytes.length; index += 24576) {
        chunks.push(btoa(String.fromCharCode(...bytes.subarray(index, index + 24576))));
    }
    return chunks.join('');
}

async function cancelBody(response) {
    try { await response.body?.cancel?.(); } catch { /* Keep the original, sanitized error. */ }
}

async function readLimitedBytes(response, maximumBytes, signal) {
    const length = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > maximumBytes) {
        await cancelBody(response);
        throw providerError('upstream_response_too_large', '云端响应超过大小上限，已停止读取。');
    }
    // A browser without streaming responses cannot enforce the memory limit safely.
    if (typeof response.body?.getReader !== 'function') {
        await cancelBody(response);
        throw providerError('invalid_upstream_response', '浏览器未提供可安全限额读取的响应流，请升级浏览器。');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
        while (true) {
            if (signal.aborted) throw providerError('upstream_aborted', '图片请求已中止。');
            const { done, value } = await reader.read();
            if (signal.aborted) throw providerError('upstream_aborted', '图片请求已中止。');
            if (done) break;
            total += value.byteLength;
            if (total > maximumBytes) {
                try { await reader.cancel(); } catch { /* Preserve the deterministic size error. */ }
                throw providerError('upstream_response_too_large', '云端响应超过大小上限，已停止读取。');
            }
            chunks.push(value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes;
    } finally {
        signal.removeEventListener('abort', cancel);
        reader.releaseLock();
    }
}

async function extractImageResponse(response, config, signal) {
    if (!response?.ok) {
        await cancelBody(response ?? {});
        const status = Number.isInteger(response?.status) ? response.status : 0;
        const code = [401, 403].includes(status) ? 'upstream_auth_failed'
            : status === 429 ? 'upstream_rate_limited' : 'upstream_failed';
        // Never parse or surface upstream error bodies, statusText, URLs, or headers.
        throw providerError(code, `图片接口返回 HTTP ${status || '未知'}，请检查 API 设置、额度或服务状态。`);
    }
    const contentType = String(response.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase();
    let bytes;
    let declaredMime = normalizeMimeType(contentType);
    if (contentType === 'application/json' || contentType.endsWith('+json')) {
        const jsonBytes = await readLimitedBytes(response, MAX_JSON_BYTES, signal);
        let json;
        try {
            json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes));
        } catch {
            throw providerError('invalid_upstream_response', '图片接口未返回有效 JSON。');
        }
        let candidate = json?.data?.[0]?.b64_json;
        if (config.provider === 'venice') {
            candidate ??= json?.data?.[0]?.image ?? json?.image
                ?? (typeof json?.images?.[0] === 'string' ? json.images[0] : json?.images?.[0]?.b64_json);
        }
        if (typeof candidate !== 'string') {
            if (json?.data?.[0]?.url || json?.url || json?.images?.[0]?.url) {
                throw providerError('result_url_not_allowed', '接口只返回了远程图片 URL；直连版不下载远程结果，请使用返回 b64_json 的图片编辑接口。');
            }
            throw providerError('invalid_upstream_response', '图片接口响应中缺少 b64_json 图片。');
        }
        try {
            if (candidate.startsWith('data:')) {
                const parsed = parseImageDataUrl(candidate, MAX_OUTPUT_BYTES);
                candidate = parsed.base64;
                declaredMime = parsed.mimeType;
            } else {
                const mimeValue = json?.data?.[0]?.mime_type ?? json?.mime_type;
                declaredMime = mimeValue === undefined ? null : normalizeMimeType(mimeValue);
                if (mimeValue !== undefined && !declaredMime) throw new Error();
            }
            bytes = decodeBase64(candidate, MAX_OUTPUT_BYTES);
        } catch (error) {
            if (error?.code === 'upstream_response_too_large') throw error;
            throw providerError('invalid_upstream_response', '图片接口返回的 Base64 图片无效。');
        }
    } else {
        if (config.provider === 'openai') {
            await cancelBody(response);
            throw providerError('invalid_upstream_response', 'OpenAI 兼容接口必须返回包含 b64_json 的 JSON。');
        }
        bytes = await readLimitedBytes(response, MAX_OUTPUT_BYTES, signal);
    }
    const mimeType = detectImageMime(bytes);
    if (!mimeType || (declaredMime && declaredMime !== mimeType)) {
        throw providerError('invalid_upstream_response', '云端图片内容与格式不符，仅支持 PNG、JPEG 或 WebP。');
    }
    return `data:${mimeType};base64,${encodeBase64(bytes)}`;
}

export async function editImage({ config, payload, signal, fetchImpl = globalThis.fetch }) {
    const normalizedConfig = validateProviderConfig(config);
    let request;
    let input;
    let inputBytes;
    try {
        request = buildTransformPayload(payload ?? {});
        input = parseImageDataUrl(request.image);
        inputBytes = decodeBase64(input.base64, input.bytes);
        if (detectImageMime(inputBytes) !== input.mimeType) throw new Error();
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(request.customInstructions)) throw new Error();
    } catch {
        throw providerError('invalid_request', '待处理图片或写实化参数无效，请重新选择图片并检查附加要求。');
    }
    if (typeof fetchImpl !== 'function') throw providerError('invalid_provider_config', '当前浏览器不支持 Fetch，请升级浏览器。');
    if (signal?.aborted) throw providerError('request_cancelled', '请求在发送前已取消。');

    const prompt = PRESETS[request.preset]
        + (request.customInstructions ? ` Additional instructions: ${request.customInstructions}` : '');
    const headers = { Authorization: `Bearer ${normalizedConfig.apiKey}` };
    let body;
    if (normalizedConfig.provider === 'venice') {
        headers.Accept = 'image/png,application/json';
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({
            model: normalizedConfig.model,
            prompt,
            image: input.base64,
            safe_mode: request.safeMode,
            output_format: 'png',
            aspect_ratio: 'auto',
        });
    } else {
        headers.Accept = 'application/json';
        body = new FormData();
        body.append('model', normalizedConfig.model);
        body.append('prompt', prompt);
        body.append('n', '1');
        if (normalizedConfig.model === 'dall-e-2') body.append('response_format', 'b64_json');
        body.append('image', new File([inputBytes], `source.${extensionForMimeType(input.mimeType)}`, { type: input.mimeType }));
    }

    const controller = new AbortController();
    let timedOut = false;
    let dispatched = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
        if (signal?.aborted) throw providerError('request_cancelled', '请求在发送前已取消。');
        // This is the single paid dispatch. CORS/network/HTTP failures never retry.
        dispatched = true;
        const response = await fetchImpl(endpointFor(normalizedConfig), {
            method: 'POST',
            credentials: 'omit',
            mode: 'cors',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
            headers,
            body,
            signal: controller.signal,
        });
        const imageDataUrl = await extractImageResponse(response, normalizedConfig, controller.signal);
        if (controller.signal.aborted) throw providerError('upstream_aborted', '图片请求已中止。');
        return {
            ok: true,
            requestId: request.requestId,
            imageDataUrl,
            provider: normalizedConfig.provider,
            model: normalizedConfig.model,
        };
    } catch (error) {
        if (timedOut || controller.signal.aborted) {
            throw providerError(timedOut ? 'upstream_timeout' : 'upstream_aborted',
                timedOut ? '图片请求已超时；云端是否已计费或生成未知，请先检查服务商记录。'
                    : '图片请求已中止；已发送的云端任务不保证撤销，请先检查服务商记录。', dispatched);
        }
        if (error instanceof ProviderError) {
            error.outcomeUnknown = dispatched;
            error.requestDispatched = dispatched;
            throw error;
        }
        // Browser fetch errors may include network details. Do not retain a cause.
        throw providerError('upstream_unreachable', '无法读取图片接口响应；请检查网络和接口 CORS 支持。云端结果与费用可能未知。', dispatched);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}
