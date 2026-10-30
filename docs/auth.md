# Authentication API

Base URL: `https://api.breedx.org/api/v1/auth`
Local: `http://localhost:5000/api/v1/auth`

Users can sign up and log in with email and password, or with Google. See [Google sign-in](#14-google-sign-in).

## Signup flow

Manual signup takes three steps. The user only gets a password (and a session) after proving they own the email address.

```
1. POST /register        { firstName, lastName, email, country }
        │  6-digit code emailed (valid 10 min)
        ▼
2. POST /verify-otp      { email, otp }
        │  returns setupToken (valid 15 min)
        ▼
3. POST /set-password    { setupToken, password }
        │  returns accessToken + user  → user is logged in
        ▼
   Later: POST /login    { email, password }  → see "Login flow"
```

If the user drops off before step 3, they can call `/register` again (or `/resend-otp`) to get a new code and continue. Their details are updated with whatever they submit the second time.

## Login flow

Each account can have **2 registered devices**. A device is one browser or installed PWA. Login has up to three steps:

```
POST /login  { email, password }
   ├─ 200  known device: logged in
   └─ 202  new device: code emailed
             └─ POST /device/verify  { challengeToken, code }
                   ├─ 200  logged in
                   └─ 409  already 2 devices
                         └─ POST /device/replace  { swapToken, sessionId }
                               └─ 200  logged in, old device signed out at once
```

Rules:

- Replacing or removing a device is limited to **3 times in 30 days**.
- **Logging out does not free a device slot.** Otherwise people could share by taking turns logging out.
- A device that hasn't been used for 30 days frees its slot automatically.
- A replaced or removed device needs an emailed code to sign in again.

## Response format

Every response has the same envelope.

**Success**
```json
{
  "success": true,
  "message": "Login successful",
  "data": { }
}
```

**Error**
```json
{
  "success": false,
  "message": "Invalid email or password"
}
```

Show `message` to the user — it is written to be user-facing. Some errors also carry a machine-readable `code` (`DEVICE_LIMIT`, `DEVICE_SWAP_LIMIT`), and `DEVICE_LIMIT` carries `data`.

## Authentication

Protected endpoints need the access token in the `Authorization` header:

```
Authorization: Bearer <accessToken>
```

| Token | Where it lives | Lifetime | Used for |
| --- | --- | --- | --- |
| `accessToken` | JavaScript memory only. Never `localStorage` | 15 minutes | All protected endpoints |
| Refresh token | `breedx_refresh` `httpOnly` cookie, set by the server | 30 days, changes on every refresh | `/refresh` and `/logout` |
| Device ID | `breedx_device` `httpOnly` cookie, set by the server | 1 year | Recognising the device |
| `setupToken` | Signup flow only | 15 minutes, single use | `/set-password` |
| `challengeToken` | Login flow only | 10 minutes | `/device/verify`, `/device/resend` |
| `swapToken` | Login flow only | 5 minutes | `/device/replace` |

Protected endpoints check the session on every request, so a removed device is cut off immediately. The cookies are `Secure`, `HttpOnly` and `SameSite=Strict`, and JavaScript can't read them.

### Frontend requirements

- **Send cookies.** Every auth request needs `credentials: 'include'` with `fetch`, or `withCredentials: true` with axios.
- **Restore the session on load.** The access token is lost on reload, so call `POST /refresh` when the app starts. A `401` means show the login screen.
- **Refresh on expiry.** When a request returns `401`, call `/refresh` once and retry. If `/refresh` also returns `401`, go to login.
- **Refresh from one tab at a time.** Wrap the call in `navigator.locks.request('breedx-refresh', ...)`. The server tolerates two tabs for 30 seconds, but the lock avoids relying on that.
- **Never cache authenticated API responses in the service worker.** Otherwise removed or expired users could still read paid content offline. Clear the caches on logout.
- **Ask iPhone users to install the PWA first.** On iOS, Safari and the installed app don't share cookies, so using both takes up both device slots.

## The user object

Returned by `/set-password`, `/login` and `/me`. Never includes the password or OTP.

```json
{
  "id": "6720f1c2a9b3e4d5f6a7b8c9",
  "name": "Ada Lovelace",
  "firstName": "Ada",
  "lastName": "Lovelace",
  "email": "ada@example.com",
  "country": "Nigeria",
  "role": "user",
  "authProvider": "local",
  "isVerified": true,
  "onboardingStatus": "pending",
  "academicProfile": {},
  "learningStyle": {},
  "createdAt": "2026-10-30T09:15:00.000Z"
}
```

- `onboardingStatus` is `pending` or `complete`. See [onboarding.md](onboarding.md).
- `email` is always stored and returned in lowercase.
- `role` is `user` or `admin`.
- `authProvider` is `local` (email & password) or `google`.

---

## Endpoints

### 1. Register

`POST /register`

Starts signup and emails a 6-digit verification code.

**Body**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `firstName` | string | yes | |
| `lastName` | string | yes | |
| `email` | string | yes | Case-insensitive, trimmed |
| `country` | string | yes | Stored as sent (e.g. `"Nigeria"` or `"NG"` — pick one convention on the frontend) |

```json
{
  "firstName": "Ada",
  "lastName": "Lovelace",
  "email": "ada@example.com",
  "country": "Nigeria"
}
```

**Responses**

| Status | When | `message` |
| --- | --- | --- |
| `201` | New account created, code sent | Registration successful. Please check your email for verification code. |
| `200` | Email already started signup but never finished — details updated, new code sent | Verification code sent. Please check your email. |
| `400` | A field is missing | First name, last name, email and country are required |
| `400` | Email format invalid | Please provide a valid email address |
| `409` | Email already has a finished account | Email is already registered |
| `409` | Email belongs to a Google account | This email is registered with Google. Please sign in with Google |
| `429` | A code was sent less than 60 seconds ago | Please wait a minute before requesting a new code |

`201` / `200` data:
```json
{ "email": "ada@example.com" }
```

---

### 2. Verify OTP

`POST /verify-otp`

Checks the emailed code. On success, returns a short-lived `setupToken` for step 3.

**Body**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `email` | string | yes | |
| `otp` | string | yes | The 6-digit code, e.g. `"482913"` |

**Responses**

| Status | When | `message` |
| --- | --- | --- |
| `200` | Code correct | Email verified. Please set your password |
| `400` | Missing field | Email and OTP are required |
| `400` | Wrong code, expired code, or unknown email | Invalid or expired OTP |
| `400` | Account already finished signup | Account is already set up. Please log in |
| `429` | 5 wrong attempts on this code | Too many incorrect attempts. Please request a new code |

`200` data:
```json
{ "setupToken": "eyJhbGciOi..." }
```

A code allows **5 attempts**. After that, the user must request a new code via `/resend-otp`.

---

### 3. Resend OTP

`POST /resend-otp`

Sends a new code and invalidates the previous one. Use for "Didn't get a code?" buttons, and when the `setupToken` expired before the user set a password.

**Body**

| Field | Type | Required |
| --- | --- | --- |
| `email` | string | yes |

**Responses**

| Status | When | `message` |
| --- | --- | --- |
| `200` | New code sent | New verification code sent to your email |
| `400` | Missing email | Email is required |
| `400` | Account already finished signup | Account is already set up. Please log in |
| `404` | No manual signup for this email | User not found |
| `429` | Previous code sent under 60 seconds ago | Please wait a minute before requesting a new code |

`200` data: `null`

---

### 4. Set password

`POST /set-password`

Completes signup. Sets the password, registers this browser as the first device and logs the user in. No extra device code is needed, because the email was just verified.

**Body**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `setupToken` | string | yes | From `/verify-otp` |
| `password` | string | yes | Min 8 characters, at least one special character |

```json
{
  "setupToken": "eyJhbGciOi...",
  "password": "Passw0rd!"
}
```

**Responses**

| Status | When | `message` |
| --- | --- | --- |
| `201` | Password set, user logged in | Account setup complete |
| `400` | Missing field | Setup token and password are required |
| `400` | Password too weak | Password must be at least 8 characters and include a special character |
| `400` | Password was already set (token reused) | Password is already set. Please log in |
| `401` | Token invalid or older than 15 minutes | Setup link is invalid or has expired. Please verify your email again |

On `401`, send the user back to request a new code (`/resend-otp`) and verify again.

`201` data:
```json
{
  "accessToken": "eyJhbGciOi...",
  "user": { "id": "...", "firstName": "Ada", "...": "see The user object" }
}
```

---

### 5. Login

`POST /login`

Checks the password, then applies the device rules. The result depends on the device, so handle all three success paths.

**Body**

| Field | Type | Required |
| --- | --- | --- |
| `email` | string | yes |
| `password` | string | yes |

**Responses**

| Status | When | `message` |
| --- | --- | --- |
| `200` | Known device: logged in | Login successful |
| `202` | New device: code emailed | Enter the code we sent to your email to verify this device |
| `400` | Missing field | Email and password are required |
| `400` | Account uses Google sign-in | This account uses Google sign-in. Please sign in with Google |
| `401` | Wrong email or password | Invalid email or password |
| `403` | Signup not finished | Please finish signing up: verify your email and set a password |
| `429` | 10 attempts in 15 minutes from one IP | Too many attempts. Please try again later |

On `403`, take the user to the verify step and call `/resend-otp`.

`200` data:
```json
{
  "accessToken": "eyJhbGciOi...",
  "user": { "id": "...", "firstName": "Ada", "...": "see The user object" }
}
```

`202` data:
```json
{
  "status": "DEVICE_VERIFICATION_REQUIRED",
  "challengeToken": "eyJhbGciOi..."
}
```

---

### 6. Verify device

`POST /device/verify`

Checks the code emailed for a new device. Must be called from the same browser that called `/login`.

**Body**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `challengeToken` | string | yes | From `/login` |
| `code` | string | yes | The 6-digit code |

**Responses**

| Status | When | `message` |
| --- | --- | --- |
| `200` | Code correct: logged in, same data as login | Device verified |
| `400` | Missing field | Challenge token and code are required |
| `400` | Wrong or expired code | Invalid or expired code |
| `401` | Token expired, or sent from a different browser | Verification has expired. Please log in again |
| `409` | Account already has 2 devices | Your plan allows 2 devices. Replace one to continue |
| `429` | 5 wrong attempts | Too many incorrect attempts. Please request a new code |

`409` body:
```json
{
  "success": false,
  "message": "Your plan allows 2 devices. Replace one to continue",
  "code": "DEVICE_LIMIT",
  "data": {
    "swapToken": "eyJhbGciOi...",
    "swapsRemaining": 3,
    "devices": [
      {
        "id": "6720f1c2a9b3e4d5f6a7b8c9",
        "deviceName": "Chrome on Mac",
        "lastSeenAt": "2026-10-30T09:15:00.000Z",
        "createdAt": "2026-10-01T10:00:00.000Z",
        "current": false
      }
    ]
  }
}
```

Show `devices` so the user can pick one to replace, then call `/device/replace`.

---

### 7. Resend device code

`POST /device/resend`

**Body:** `{ "challengeToken": "..." }`

| Status | When | `message` |
| --- | --- | --- |
| `200` | New code sent | New verification code sent to your email |
| `401` | Token expired, or sent from a different browser | Verification has expired. Please log in again |
| `429` | Previous code sent under 60 seconds ago | Please wait a minute before requesting a new code |

---

### 8. Replace a device

`POST /device/replace`

Removes one registered device and logs in on this one. The removed device is signed out immediately. Counts toward the limit of 3 changes in 30 days.

**Body**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `swapToken` | string | yes | From the `409` response |
| `sessionId` | string | yes | The `id` of the device to remove |

| Status | When | `message` |
| --- | --- | --- |
| `200` | Replaced: logged in, same data as login | Device replaced |
| `400` | Missing field | Swap token and session ID are required |
| `401` | Token expired, or sent from a different browser | This request has expired. Please log in again |
| `404` | Device isn't on this account | Device not found |
| `429` | 3 changes already used (`code: DEVICE_SWAP_LIMIT`) | You can only change devices 3 times in 30 days. Please contact support |

---

### 9. Refresh

`POST /refresh`

Issues a new access token using the `breedx_refresh` cookie, and replaces the cookie. No body.

| Status | When | `message` |
| --- | --- | --- |
| `200` | Session valid | Token refreshed |
| `401` | No valid session: show the login screen | Session has expired. Please log in again |

`200` data:
```json
{ "accessToken": "eyJhbGciOi..." }
```

If an old refresh token is used more than 30 seconds after it was replaced, the server treats it as stolen and ends the session. That device then needs an emailed code to sign in again.

---

### 10. Logout

`POST /logout`

Ends this device's session and clears the refresh cookie. No body. Always returns `200` with `Logged out`. The device keeps its slot, and it can log back in without a code.

---

### 11. List devices

`GET /sessions` — **protected**

Returns the account's registered devices, most recently used first, for a "manage my devices" screen. `current` marks this device.

`200` data: an array of device objects (see the `409` body above). Devices that have logged out are included, because they still hold a slot.

---

### 12. Remove a device

`DELETE /sessions/:id` — **protected**

Signs out and removes another device. Counts toward the limit of 3 changes in 30 days.

| Status | When | `message` |
| --- | --- | --- |
| `200` | Removed | Device removed |
| `400` | Trying to remove this device | Use logout to sign out of this device |
| `404` | Device isn't on this account | Device not found |
| `429` | 3 changes already used (`code: DEVICE_SWAP_LIMIT`) | You can only change devices 3 times in 30 days. Please contact support |

---

### 13. Get current user

`GET /me` — **protected**

Returns the logged-in user.

**Headers**
```
Authorization: Bearer <accessToken>
```

**Responses**

| Status | When | `message` |
| --- | --- | --- |
| `200` | Token valid | User fetched successfully |
| `401` | No token | Unauthorized — no token |
| `401` | Token invalid, expired, or a `setupToken` | Unauthorized — invalid or expired token |
| `404` | Account was deleted | User not found |

`200` data: the user object.

---

### 14. Google sign-in

`POST /google`

Signs a user up or logs them in with a Google ID token. The same endpoint handles both.

**Body**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `credential` | string | yes | The ID token from Google Identity Services (`response.credential`) |
| `country` | string | for new users | Send it from the Google sign-up flow. Ignored for existing accounts |

**Responses**

| Status | When | `message` |
| --- | --- | --- |
| `201` | New account created and logged in, same data as login | Account created |
| `200` | Known device: logged in | Login successful |
| `202` | New device: code emailed. Continue with `/device/verify` | Enter the code we sent to your email to verify this device |
| `400` | Missing credential | Google credential is required |
| `400` | New user with no country (`code: COUNTRY_REQUIRED`) | Please select your country to continue |
| `401` | Token invalid, expired, for another app, or email unverified | Google sign-in failed. Please try again |
| `409` | Email belongs to a different Google account | This email is linked to a different Google account |
| `503` | `GOOGLE_CLIENT_ID` isn't set | Google sign-in is not available right now |

Rules:

- **Device rules are the same as password login.** A new device needs an emailed code, and the 2-device limit and swap limit apply. A brand-new account's first device needs no code.
- **Existing password accounts are linked.** If the email already has a finished account, Google signs in to it, and the password keeps working.
- **Unfinished manual signups are taken over.** Google proves the email, so its name replaces what was entered and any pending code stops working.
- **Google-only accounts have no password.** `/login` tells them to use Google.

### Frontend setup

Load the Google script, then render Google's button once the user has picked a country. The token only comes from Google's own button, not a custom one.

```html
<script src="https://accounts.google.com/gsi/client" async></script>
```

```js
google.accounts.id.initialize({
  client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
  callback: async ({ credential }) => {
    const res = await fetch('https://api.breedx.org/api/v1/auth/google', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential, country }),
    });
    // 200/201: logged in. 202: show the code screen. 409: show the device list.
  },
});

google.accounts.id.renderButton(buttonElement, { theme: 'outline', size: 'large', shape: 'pill' });
```

---

### 15. Forgot password

Three steps: request a code, verify it, then set a new password.

```
POST /forgot-password     { email }
     │  6-digit code emailed (valid 10 min)
     ▼
POST /verify-reset-code   { email, code }
     │  returns resetToken (valid 15 min)
     ▼
POST /reset-password      { resetToken, password }
     │  all devices signed out
     ▼
POST /login
```

**`POST /forgot-password`**

| Status | When | `message` |
| --- | --- | --- |
| `200` | Code sent | Reset code sent to your email |
| `400` | Email format invalid | Please provide a valid email address |
| `400` | Google-only account | This account uses Google sign-in. Please sign in with Google |
| `403` | Signup not finished | Please finish signing up: verify your email and set a password |
| `404` | No account with this email | No account found with this email |
| `429` | Code sent under 60 seconds ago | Please wait a minute before requesting a new code |
| `429` | 10 requests in 15 minutes from one IP | Too many attempts. Please try again later |

**`POST /verify-reset-code`**

| Status | When | `message` |
| --- | --- | --- |
| `200` | Code correct. Data: `{ "resetToken": "..." }` | Code verified. Please choose a new password |
| `400` | Missing field | Email and code are required |
| `400` | Wrong or expired code, or unknown email | Invalid or expired code |
| `429` | 5 wrong attempts | Too many incorrect attempts. Please request a new code |

**`POST /reset-password`**

| Status | When | `message` |
| --- | --- | --- |
| `200` | Password changed | Password updated. Please log in |
| `400` | Missing field | Reset token and password are required |
| `400` | Password too weak | Password must be at least 8 characters and include a special character |
| `401` | Token invalid, expired or already used | This reset has expired. Please request a new code |

A reset signs out every device and removes them from the account. Logging in afterwards needs an emailed new-device code, but it doesn't count as a device swap.

---

## Rate limits

Limits apply per IP address over 15 minutes.

| Endpoints | Limit |
| --- | --- |
| `/login`, `/google`, `/forgot-password` | 10 requests |
| `/register`, `/verify-otp`, `/resend-otp`, `/set-password`, `/verify-reset-code`, `/reset-password`, `/device/*` | 30 requests |
| `/refresh`, `/logout` | 300 requests |

## Try it with curl

`-c` and `-b` keep the cookies in a file, which acts as one browser.

```bash
BASE=http://localhost:5000/api/v1/auth

curl -X POST $BASE/register -H "Content-Type: application/json" \
  -d '{"firstName":"Ada","lastName":"Lovelace","email":"ada@example.com","country":"Nigeria"}'

curl -X POST $BASE/verify-otp -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","otp":"482913"}'

curl -c jar -b jar -X POST $BASE/set-password -H "Content-Type: application/json" \
  -d '{"setupToken":"<setupToken>","password":"Passw0rd!"}'

curl -c jar -b jar -X POST $BASE/login -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","password":"Passw0rd!"}'

curl -c jar -b jar -X POST $BASE/refresh

curl $BASE/me -H "Authorization: Bearer <accessToken>"
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` | OAuth client ID from Google Auth Platform. Without it, `/google` returns `503`. The client secret isn't used |
| `JWT_SECRET` | **Required**: the app won't start without it. Signs all tokens. Use `openssl rand -hex 32` |
| `CLIENT_ORIGINS` | Comma-separated frontends allowed to call the API with cookies. Defaults to `https://breedx.org`. Use `http://localhost:3000` in development |
| `RESEND_API_KEY` | Sends the OTP emails |
| `MAIL_FROM` | Sender address. Defaults to `BreedX <info@breedx.org>`. The domain must be verified in Resend, or emails will fail to send |
