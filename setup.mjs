#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/Azure-Samples/ExternalPhoneProvider-AzureFunction-Sample.git';
const COMMIT = 'a568485f841329f30a78a88ecfa29e97c15fb50f';

const here = path.dirname(fileURLToPath(import.meta.url));
const dest = path.resolve(process.argv[2] || path.join(here, 'ExternalPhoneProvider-AzureFunction-Sample'));

if (existsSync(dest)) {
    console.error(`${dest} already exists. Delete it, or pass a different folder: node setup.mjs <folder>`);
    process.exit(1);
}

const git = (...args) => execFileSync('git', args, { cwd: dest, stdio: 'inherit' });

mkdirSync(dest, { recursive: true });
console.log(`Fetching Microsoft's sample at ${COMMIT.slice(0, 7)} into ${dest}`);
git('init', '--quiet');
git('remote', 'add', 'origin', REPO);
git('fetch', '--quiet', '--depth', '1', 'origin', COMMIT);
git('checkout', '--quiet', 'FETCH_HEAD');

console.log('Registering the Twilio adapter');
const registry = path.join(dest, 'javascript', 'src', 'functions', 'providers', 'index.js');
let source = readFileSync(registry, 'utf8');
for (const [before, after] of [
    ["const telesign = require('./telesign');", "const telesign = require('./telesign');\nconst twilio = require('./twilio');"],
    ["        case 'telesign': return telesign;", "        case 'telesign': return telesign;\n        case 'twilio': return twilio;"],
    ['soprano, telesign };', 'soprano, telesign, twilio };'],
]) {
    if (source.split(before).length !== 2) {
        console.error(`Could not register the Twilio adapter: expected text not found in ${registry}`);
        process.exit(1);
    }
    source = source.replace(before, after);
}
writeFileSync(registry, source);
cpSync(path.join(here, 'adapter', 'javascript'), path.join(dest, 'javascript'), { recursive: true });

console.log('\nDone. Next:');
console.log(`  cd ${path.join(dest, 'javascript')} && npm install && npm test`);
