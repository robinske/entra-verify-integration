'use strict';

const { OUTCOME, ProviderResult, classifyFailure } = require('../providerResult');

const SERVICE_SID = /^VA[0-9a-fA-F]{32}$/;
const E164 = /^\+[1-9][0-9]{1,14}$/;
const CUSTOM_CODE = /^[0-9]{4,10}$/;
const SUCCESS = new Set(['pending']);
const REJECTED = new Set(['failed', 'canceled', 'expired', 'max_attempts_reached', 'deleted', 'approved']);
// 60410: Fraud Guard block. 60605: Geo Permissions block.
const BLOCKED_CODES = new Set([60410, 60605]);

function nonblankString(value) {
    return typeof value === 'string' && value.trim() ? value : null;
}

const provider = Object.freeze({
    name: 'twilio',
    authenticationMode: 'apiKey',
    credentialSpec: Object.freeze({
        mode: 'apiKey',
        keyVaultSecretName: 'twilio-api-key-secret',
        identityKeyVaultSecretName: 'twilio-api-key-sid',
    }),

    createRequest({ channel, endpoint, delivery, credential, env }) {
        if (channel !== 'sms' && channel !== 'voice') throw new Error('unsupported channel');
        const serviceSid = (env.TWILIO_VERIFY_SERVICE_SID || '').trim();
        if (!SERVICE_SID.test(serviceSid)) throw new Error('invalid verify service sid');
        if (!E164.test(delivery.phoneNumber)) throw new Error('invalid recipient');
        // Entra generates the code, so Verify must not generate its own.
        if (!CUSTOM_CODE.test(delivery.otp ?? '')) throw new Error('invalid otp');

        const body = new URLSearchParams({
            To: delivery.phoneNumber,
            Channel: channel === 'voice' ? 'call' : 'sms',
            CustomCode: delivery.otp,
        });
        const basic = Buffer.from(`${credential.identity}:${credential.secret}`).toString('base64');
        return {
            url: `${endpoint.replace(/\/+$/, '')}/v2/Services/${serviceSid}/Verifications`,
            method: 'POST',
            headers: {
                Authorization: `Basic ${basic}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
            },
            body: body.toString(),
        };
    },

    interpretResponse(response) {
        const payload = response.json && typeof response.json === 'object' && !Array.isArray(response.json)
            ? response.json : {};
        const code = Number.isInteger(payload.code) ? payload.code : null;
        if (!response.ok && BLOCKED_CODES.has(code)) {
            return new ProviderResult({
                outcome: OUTCOME.BLOCK,
                statusRecognized: true,
                providerHttpStatus: response.providerHttpStatus,
                providerStatusCode: code,
                failureReason: 'provider_blocked',
            });
        }

        const sid = nonblankString(payload.sid);
        const status = nonblankString(payload.status);
        const recognized = SUCCESS.has(status) || REJECTED.has(status);
        const outcome = response.ok && sid && SUCCESS.has(status) ? OUTCOME.CONTINUE : OUTCOME.FAIL;
        const failureReason = response.validJson && response.ok && !sid
            ? 'missing_provider_message_id'
            : classifyFailure({
                providerHttpStatus: response.providerHttpStatus,
                outcome,
                statusRecognized: recognized,
                validJson: response.validJson,
            });
        return new ProviderResult({
            outcome,
            statusRecognized: recognized,
            providerHttpStatus: response.providerHttpStatus,
            providerMessageId: sid,
            providerStatusName: status,
            failureReason,
        });
    },
});

module.exports = provider;
