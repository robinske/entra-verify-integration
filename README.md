# Send Microsoft Entra ID MFA codes with Twilio Verify

Use Twilio Verify to deliver SMS and voice one-time passcodes (OTPs) for Microsoft Entra ID multifactor authentication.

Entra ID calls an Azure Function that you host. The Function hands each code to Twilio Verify, which delivers it by SMS or voice call. Microsoft publishes an open-source Azure Function that receives these requests from Entra ID and passes them to a phone provider: the [External Phone Provider sample](https://github.com/Azure-Samples/ExternalPhoneProvider-AzureFunction-Sample). This guide calls it **the Microsoft sample**. It doesn't include Twilio, so this repository adds a Twilio Verify adapter to it. The repository contains only the Twilio pieces, plus a script (`setup.mjs`) that downloads the Microsoft sample and applies the adapter.

> **Reference implementation.** You deploy and operate the Function in your own Azure subscription. Validate it in a non-production tenant before turning it on for users.

## How it works

```
Entra ID --> Easy Auth --> Azure Function (SendOtp) --> Twilio Verify --> user's phone
```

1. Entra ID sends the Function an encrypted request containing the phone number and the code it generated.
2. Azure Easy Auth confirms the caller is Microsoft. The Function decrypts the request.
3. The Twilio adapter asks Verify to deliver Entra's code by SMS or voice, using Verify's `CustomCode` parameter. Verify delivers the code but does not generate or check it. Entra does that.
4. The Function returns `200` to Entra once Verify accepts the request. Acceptance is not proof the handset received the message.

The adapter is `adapter/javascript/src/functions/providers/twilio.js` in this repository. `setup.mjs` copies it into the Microsoft sample. It only builds the Verify request and interprets the response. Caller authentication, decryption, evaluation mode, and logging stay in the Microsoft sample's shared handler.

## What your users receive

Verify sends its standard message for the channel, translated for the destination country. In English the SMS reads:

> Your *\<service friendly name\>* verification code is: *\<code\>*

- Verify does not accept custom message text, so Entra's own message wording is not used.
- The friendly name is your Verify Service's name (up to 32 characters). Name it something your users recognize, such as your company name.
- This adapter does not use Verify custom templates. If you want your own wording, see [Verify templates](https://www.twilio.com/docs/verify/api/templates) and add a `TemplateSid` to the request in `createRequest`.

## Prerequisites

- A Twilio account (upgraded from trial if you want to message numbers you haven't verified).
- A Microsoft Entra ID tenant, an Azure subscription, and the roles described in Microsoft's [deployment guide](https://github.com/Azure-Samples/ExternalPhoneProvider-AzureFunction-Sample/blob/a568485f841329f30a78a88ecfa29e97c15fb50f/docs/GETTING-STARTED.md#1-get-ready).
- Access to the External Phone Provider feature and Microsoft's approved test and activation process. See Microsoft's [access and support](https://github.com/Azure-Samples/ExternalPhoneProvider-AzureFunction-Sample/blob/a568485f841329f30a78a88ecfa29e97c15fb50f/docs/ONBOARDING.md#before-purchasing-or-deploying) notes.
- Node.js 22+, PowerShell 7+ (for packaging), and the [Twilio CLI](https://www.twilio.com/docs/twilio-cli/quickstart) (optional).

## Quick start

### 1. Get the code

```bash
git clone https://github.com/twilio-samples/entra-verify-integration.git
cd entra-verify-integration
node setup.mjs
```

`setup.mjs` downloads the Microsoft sample at a pinned, tested commit into a new `ExternalPhoneProvider-AzureFunction-Sample/` folder, registers the Twilio adapter in it, and adds the adapter's tests. It needs Node.js 22+ and Git. Pass a folder name to download it somewhere else: `node setup.mjs ./my-folder`.

Then install dependencies and run the tests:

```bash
cd ExternalPhoneProvider-AzureFunction-Sample/javascript
npm install
npm test
```

### 2. Create a Verify Service

The service must allow custom codes and must not require key presses on voice calls.

```bash
twilio api:verify:v2:services:create \
  --friendly-name "Your Company" \
  --custom-code-enabled \
  --no-dtmf-input-required
```

Or in the Console: **Verify > Services > Create new**, then on the **General** tab enable **Custom Verification Code** and make sure **DTMF input required** is off. A service created through the API or CLI has DTMF input required **on** by default, so set it explicitly.

Note the Service SID (starts with `VA`). Also check the service's geo permissions and Fraud Guard settings for the countries you send to.

### 3. Create a restricted API key

A restricted key limits what the credentials can do if they leak. This one can only start and update verifications.

```bash
twilio api:iam:v1:keys:create \
  --account-sid ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  --friendly-name "entra-verify" \
  --key-type restricted \
  --policy '{"allow":["/twilio/verify/verification/create","/twilio/verify/verification/update"]}'
```

Or in the Console: go to **Settings > Account settings > API keys & auth tokens > Create API key**, choose **Restricted**, and under **Permissions** select the Verify permissions for creating and updating verifications.

Copy the key SID (`SK...`) and the secret. The secret is shown only once. See [Restricted API keys](https://www.twilio.com/docs/iam/api-keys/restricted-api-keys).

Your Account SID is only needed to create the key. Verify requests authenticate with the key SID and secret alone.

### 4. Try it from your computer

This runs the real Function handler and Twilio adapter locally against your Verify service, with no Azure resources. It builds an encrypted request like the one Entra sends, then sends a real SMS or voice call to your phone.

```bash
cd local-test
cp .env.example .env     # then fill in your key SID, secret, Service SID, and your phone number
node --env-file=.env e2e-verify.js sms      # or: voice
```

The script prints what Entra would receive and Twilio's raw response, asks you to type the code you got, then marks the verification as approved in Verify. Type `r` at the prompt to resend with a new code. Set `OTP=012345` in `.env` to pin the code, for example to check leading zeros.

### 5. Deploy the Function

Deploy the Function with the following steps:

1. **Package the Function** from the root of the downloaded Microsoft sample (`ExternalPhoneProvider-AzureFunction-Sample/`). The package includes the Twilio adapter. Don't deploy Microsoft's unchanged public release, which doesn't contain it.

   ```powershell
   cd ExternalPhoneProvider-AzureFunction-Sample
   pwsh -File ./package-javascript.ps1      # creates artifacts/epp-javascript.zip
   ```

2. **Create the Azure resources and trust configuration** following Microsoft's [custom deployment](https://github.com/Azure-Samples/ExternalPhoneProvider-AzureFunction-Sample/blob/a568485f841329f30a78a88ecfa29e97c15fb50f/docs/ONBOARDING.md#optional-local-development-and-manual-deployment) guide: the Function App, Key Vault with an encryption certificate, the application registration, and Easy Auth. Use the [Easy Auth checklist](https://github.com/Azure-Samples/ExternalPhoneProvider-AzureFunction-Sample/blob/a568485f841329f30a78a88ecfa29e97c15fb50f/docs/ONBOARDING.md#manual-deployment-trust-checklist) exactly, and keep Easy Auth enabled on `SendOtp`.

3. **Add the Twilio settings** from the [configuration reference](#configuration-reference) below.

4. **Deploy the ZIP** to the Function App.

### 6. Validate, then activate

Follow Microsoft's [validation checklist](https://github.com/Azure-Samples/ExternalPhoneProvider-AzureFunction-Sample/blob/a568485f841329f30a78a88ecfa29e97c15fb50f/docs/ONBOARDING.md#validate-the-deployed-endpoint):

1. A request with no token is rejected (`401`).
2. An authorized **evaluation** request returns `200` without contacting Twilio.
3. One controlled **live** request per channel, to a number you own, arrives as an SMS or call.
4. Logs appear in Application Insights, and the verification appears in your [Twilio Verify logs](https://www.twilio.com/docs/verify/viewing-logs-with-twilio-console).

When validation passes, an Authentication Policy Administrator activates the endpoint using Microsoft's [activation procedure](https://github.com/Azure-Samples/ExternalPhoneProvider-AzureFunction-Sample/blob/a568485f841329f30a78a88ecfa29e97c15fb50f/setup/docs/README.md#step-3---manually-validate-and-activate-policy). Save the existing policy first so you can roll back.

## Configuration reference

### Function app settings

All values are strings.

| Setting | Value |
| --- | --- |
| `EPP_PROVIDER_NAME` | `twilio` |
| `EPP_PROVIDER_AUTH_MODE` | `apiKey` |
| `EPP_PROVIDER_SMS_ENDPOINT` | `https://verify.twilio.com` |
| `EPP_PROVIDER_VOICE_ENDPOINT` | `https://verify.twilio.com` |
| `TWILIO_VERIFY_SERVICE_SID` | Your Verify Service SID (`VA...`) |
| `KEY_VAULT_URL` | The Key Vault that holds the Twilio secrets |
| `EPP_PROVIDER_TIMEOUT_MS` | Optional. Defaults to `1500`, maximum `2500` |

The Function also needs Microsoft's own settings, such as `EPP_DECRYPTION_KEY_PEM`. See the [settings reference](https://github.com/Azure-Samples/ExternalPhoneProvider-AzureFunction-Sample/blob/a568485f841329f30a78a88ecfa29e97c15fb50f/TECHNICAL.md#configure-environment-variables).

### Key Vault secrets

Create these two secrets with exactly these names, and give the Function's managed identity the **Key Vault Secrets User** role. The Function reads them on each live request.

| Secret name | Value |
| --- | --- |
| `twilio-api-key-sid` | Your API key SID (`SK...`) |
| `twilio-api-key-secret` | Your API key secret |

Keep credentials out of source control, logs, and screenshots.

## How Verify responses map to Entra

| Verify response | Function returns to Entra |
| --- | --- |
| `201` with a `sid` and `status: pending` | `200` accepted |
| Fraud Guard block (60410) or Geo Permissions block (60605) | `422` `provider_blocked` |
| `429` | `429` |
| Any other `4xx`, including bad credentials or a service without custom codes enabled | `400` |
| `5xx`, invalid JSON, missing `sid`, or an unrecognized status | `502` |
| No response within the timeout | `504` |

Check a `504` before retrying: Verify may already have sent the message.

The adapter refuses to send, and returns `502`, if the request has no OTP, the OTP isn't 4 to 10 digits, the phone number isn't E.164, or the Service SID is invalid. The 422 mapping follows Twilio's documented error codes and has been tested with example error bodies, not live responses.

## Monitoring

- **Function logs.** Application Insights records each request the Function handles and any failure, without phone numbers, codes, or credentials. See Microsoft's [monitoring guide](https://github.com/Azure-Samples/ExternalPhoneProvider-AzureFunction-Sample/blob/a568485f841329f30a78a88ecfa29e97c15fb50f/docs/MONITORING.md).
- **Verify logs in the Console.** Go to **Monitor > Logs > Verify**. On the **Verifications** tab, search by verification ID or phone number and filter by service, status, channel, country, and date. Open a verification to see its lifecycle and any error codes. The **Blocked Verifications** tab lists verifications stopped by Fraud Guard or Geo Permissions, which the Function returns to Entra as `422`. See [Viewing Verify logs with Twilio Console](https://www.twilio.com/docs/verify/viewing-logs-with-twilio-console).
- **Verify Events.** To stream Verify activity to a webhook or Amazon Kinesis in near real time, set up [Verify Events](https://www.twilio.com/docs/verify/verify-events). The [message status stream](https://www.twilio.com/docs/verify/message-status) reports each delivery outcome (`SENT`, `DELIVERED`, `UNDELIVERED`, `FAILED`).

## Customizing the adapter

| To change | Edit |
| --- | --- |
| Request fields, channels, authentication | `createRequest` in `providers/twilio.js` |
| Response and error mapping | `interpretResponse` in `providers/twilio.js` |
| Key Vault secret names | `credentialSpec` in `providers/twilio.js` |

Edit the files under `adapter/` in this repository, not the downloaded Microsoft sample. `adapter/` holds `providers/twilio.js` and `test/twilio.test.js`. `setup.mjs` copies them in and adds the `twilio` entry to Microsoft's `providers/index.js`. After changing anything, delete the downloaded `ExternalPhoneProvider-AzureFunction-Sample/` folder and run `node setup.mjs` again, then run the tests:

```bash
cd ExternalPhoneProvider-AzureFunction-Sample/javascript
npm install
npm test
```

## References

- [Verify custom codes](https://www.twilio.com/docs/verify/api/customization-options)
- [Verify API](https://www.twilio.com/docs/verify/api)
- [Viewing Verify logs with Twilio Console](https://www.twilio.com/docs/verify/viewing-logs-with-twilio-console)
- [Verify Events](https://www.twilio.com/docs/verify/verify-events)
- [Message status stream](https://www.twilio.com/docs/verify/message-status)
- [Restricted API keys](https://www.twilio.com/docs/iam/api-keys/restricted-api-keys)
- [Microsoft External Phone Provider sample](https://github.com/Azure-Samples/ExternalPhoneProvider-AzureFunction-Sample)
