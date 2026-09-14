import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expected = new Set([
    'LICENSE', 'README.md', 'VERIFICATION.md', 'package.json', 'manifest.json',
    'index.js', 'utils.mjs', 'provider.mjs', 'style.css', 'capability-contract.json',
    'scripts/verify-release.mjs', 'tests/utils.test.mjs', 'tests/provider.test.mjs',
]);
const actual = [];
function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (directory === root && entry.name === '.git') continue;
        const absolute = path.join(directory, entry.name);
        assert(!entry.isSymbolicLink(), `Unexpected symbolic link: ${entry.name}`);
        if (entry.isDirectory()) walk(absolute);
        else actual.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
}
walk(root);
assert.deepEqual([...actual].sort(), [...expected].sort(), 'Release file list differs');
const text = name => fs.readFileSync(path.join(root, name), 'utf8');
const manifest = JSON.parse(text('manifest.json'));
const pkg = JSON.parse(text('package.json'));
assert.equal(manifest.version, pkg.version);
assert.equal(pkg.type, 'module');
assert.equal(manifest.minimum_client_version, '1.18.0');
assert.equal(manifest.js, 'index.js');
assert.equal(manifest.css, 'style.css');
assert.equal(manifest.auto_update, false);

for (const filename of actual.filter(name => /\.(?:m?js|json|md|css)$/.test(name))) {
    const source = text(filename);
    assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(source), `Private key in ${filename}`);
    assert(!/\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{25,}|sk-[A-Za-z0-9_-]{35,})\b/.test(source), `Possible credential in ${filename}`);
    if (/\.(?:m?js)$/.test(filename)) {
        for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
            const absolute = path.resolve(root, path.dirname(filename), match[1]);
            assert(absolute.startsWith(root + path.sep), `Import escapes release: ${filename}`);
            assert(fs.existsSync(absolute), `Missing import: ${filename} -> ${match[1]}`);
        }
    }
}

const ui = text('index.js');
for (const hook of Object.values(manifest.hooks)) {
    assert(new RegExp(`export\\s+(?:async\\s+)?function\\s+${hook}\\b`).test(ui), `Missing lifecycle hook: ${hook}`);
}
assert(!/\/api\/plugins\/cloud-realify/.test(ui), 'UI still depends on Server Plugin');
assert(!/CLOUD_REALIFY_API_KEY/.test(ui), 'UI still expects a server environment');
assert(/await\s+context\.saveChat\s*\(\s*\)/.test(ui), 'Chat save coordinator missing');
assert(!/buildChatSaveRequest|fetch\s*\(\s*['"]\/api\/chats\/(?:group\/)?save/.test(ui), 'Unsafe direct chat overwrite');
assert(/withCrossTabPaidLock/.test(ui), 'Paid request lock missing');
assert(!/sessionStorage/.test(ui), 'Key must not be stored in sessionStorage');
assert(!/settings\.apiKey\s*=|extensionSettings\.[^\n]*apiKey\s*=/.test(ui), 'Key must not be persisted in settings');

console.log(JSON.stringify({ pass: true, version: manifest.version, filesChecked: actual.length, manifestAtRoot: true }, null, 2));
