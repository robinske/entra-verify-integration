'use strict';

const Module = require('node:module');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');

const SAMPLE = path.resolve(__dirname, '../ExternalPhoneProvider-AzureFunction-Sample/javascript');
const { CompactEncrypt } = Module.createRequire(path.join(SAMPLE, 'package.json'))('jose');

const channelName = process.argv[2];
if (!['sms', 'voice'].includes(channelName)) {
    console.error('usage: node --env-file=.env e2e-verify.js <sms|voice>');
    process.exit(1);
}
const missing = ['TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_VERIFY_SERVICE_SID', 'TEST_PHONE_NUMBER']
    .filter((key) => !process.env[key]);
if (missing.length) {
    console.error(`missing env vars: ${missing.join(', ')}`);
    process.exit(1);
}
const { TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_VERIFY_SERVICE_SID, TEST_PHONE_NUMBER } = process.env;

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
Object.assign(process.env, {
    EPP_DECRYPTION_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    EPP_PROVIDER_NAME: 'twilio',
    EPP_PROVIDER_AUTH_MODE: 'apiKey',
    EPP_PROVIDER_SMS_ENDPOINT: 'https://verify.twilio.com',
    EPP_PROVIDER_VOICE_ENDPOINT: 'https://verify.twilio.com',
    EPP_PROVIDER_TIMEOUT_MS: process.env.EPP_PROVIDER_TIMEOUT_MS || '2500',
});

let handler;
const originalLoad = Module._load;
Module._load = function load(name, ...args) {
    if (name === '@azure/functions') {
        return {
            app: {
                hook: { appStart() {}, appTerminate() {} },
                http: (_name, options) => { handler = options.handler; },
            },
        };
    }
    return originalLoad.call(this, name, ...args);
};
const { credentialTokenService } = require(path.join(SAMPLE, 'src/functions/credentials'));
credentialTokenService.getCredentials = async () => ({
    mode: 'apiKey', secret: TWILIO_API_KEY_SECRET, identity: TWILIO_API_KEY_SID,
});
require(path.join(SAMPLE, 'src/functions/SendOtp'));
Module._load = originalLoad;

const realFetch = global.fetch;
let capturedVerify;
global.fetch = async (url, init) => {
    const response = await realFetch(url, init);
    capturedVerify = response.clone().text().then((body) => ({ status: response.status, body }));
    return response;
};

const basicAuth = `Basic ${Buffer.from(`${TWILIO_API_KEY_SID}:${TWILIO_API_KEY_SECRET}`).toString('base64')}`;
const newOtp = () => process.env.OTP || String(crypto.randomInt(0, 1000000)).padStart(6, '0');

async function sendThroughHandler(otp) {
    const delivery = {
        nonce: crypto.randomUUID(),
        phoneNumber: TEST_PHONE_NUMBER,
        message: `Your verification code is ${otp}.`,
        otp,
        locale: 'en-US',
    };
    const encryptedDeliveryContext = await new CompactEncrypt(Buffer.from(JSON.stringify(delivery)))
        .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM', kid: 'local-test' })
        .encrypt(publicKey);
    const body = {
        type: 'microsoft.mfa.otpDeliver.v1',
        channel: channelName === 'voice' ? 2 : 1,
        mode: 1,
        ttlSeconds: 60,
        correlationId: crypto.randomUUID(),
        encryptedDeliveryContext,
    };

    capturedVerify = undefined;
    const events = [];
    const sink = (line) => events.push(JSON.parse(line));
    const result = await handler(
        { headers: { get: () => null }, text: async () => JSON.stringify(body) },
        { invocationId: 'local-test', log: sink, warn: sink, error: sink },
    );
    const verify = capturedVerify ? await capturedVerify : null;

    console.log(`\nSent code ${otp} via ${channelName}`);
    console.log(`  Entra would receive: HTTP ${result.status} ${JSON.stringify(result.jsonBody)}`);
    if (verify) console.log(`  Verify responded:    HTTP ${verify.status} ${verify.body}`);
    const failed = events.find((event) => event.eventName === 'request_failed');
    if (failed) console.log(`  Function log:        ${failed.failureStage} / ${failed.failureReason}`);
    if (!verify || result.status !== 200) return null;
    try { return JSON.parse(verify.body).sid || null; } catch { return null; }
}

async function sendFeedback() {
    const response = await realFetch(
        `https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SERVICE_SID}/Verifications/${encodeURIComponent(TEST_PHONE_NUMBER)}`,
        {
            method: 'POST',
            headers: { Authorization: basicAuth, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ Status: 'approved' }).toString(),
        },
    );
    console.log('\nFeedback (Status=approved, addressed by phone number):');
    console.log(`  Verify responded:    HTTP ${response.status} ${await response.text()}`);
}

(async () => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let otp = newOtp();
    for (;;) {
        const sid = await sendThroughHandler(otp);
        if (!sid) break;
        const answer = (await rl.question(
            "\nEnter the code you received, 'r' to resend with a new code, or blank to quit: ",
        )).trim();
        if (answer === 'r') { otp = newOtp(); continue; }
        if (answer) {
            console.log(answer === otp ? 'Code matches what was sent.' : `Mismatch: the handler sent ${otp}.`);
            if (answer === otp) await sendFeedback();
        }
        break;
    }
    rl.close();
})().catch((error) => { console.error(error); process.exit(1); });
