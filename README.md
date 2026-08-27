# Passport Photo — Background Removal Backend

Chhota sa backend jo remove.bg API (`/v1.0/removebg`) se background remove karwata hai, aur tera
API key secret rakhta hai (browser mein kabhi expose nahi hota).

## 1. remove.bg API key lo

1. https://www.remove.bg/api par account banao
2. API key create karke copy kar lo

## 2. Local setup

```bash
cd backend
npm install
cp .env.example .env
# .env file kholo aur REMOVE_BG_API_KEY=... wali line mein apna API key daalo
npm start
```

Backend `http://localhost:8787` par chalega. Check karne ke liye:
`http://localhost:8787/health` → `{"ok":true}` dikhna chahiye.

## 3. Secure admin panel

The panel is hidden behind `ADMIN_PATH_SECRET`; there is no public admin route
or arbitrary API proxy. Set these values in `.env`:

```text
ADMIN_USERNAME=your-admin-name
ADMIN_PASSWORD_HASH=...
ADMIN_PATH_SECRET=a-long-random-url-safe-secret
```

Generate a scrypt password hash (the password is never stored by the server):

```bash
node admin/generate-password-hash.js "use-a-long-unique-password"
```

Generate a random URL-safe path secret:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Copy both outputs into `.env`, then open `/<ADMIN_PATH_SECRET>/` to sign in.
Use HTTPS in production and set `ADMIN_COOKIE_SECURE=true`; local HTTP
development may use `ADMIN_COOKIE_SECURE=false`. Login attempts are rate
limited and locked after repeated failures. Sessions are server-side and use
HttpOnly/SameSite cookies, and all admin mutations require CSRF protection.

The panel can view upload metadata (never stored photo paths), recent request
logs, and publish a visitor message or maintenance overlay. Visitors read the
small public state response at `GET /api/status`.

## 4. Upload database

Server pehli baar start hote hi `data/passport-photo.sqlite` database aur
`data/uploads/` folder bana dega. Har upload ka metadata, original photo aur
remove.bg se bani processed photo save hoti hai. `data/` ko GitHub par commit
mat karna; production backup, access control aur retention/deletion policy
zaroor set karna. Passport photos sensitive personal data hain—users ko clear
consent/privacy notice dikhaye bina long-term storage mat rakhein.

Abhi login nahi hone par `firebase_uid` aur `user_email` blank rahenge. Firebase
Google Login add karne ke baad frontend se Firebase ID token backend ko dena
hoga; Firebase Admin SDK se token verify karke hi user identity database mein
save karni chahiye. Client ke bheje hue email/UID ko blindly trust na karein.

## Optional AI enhancement (Hugging Face first, Gemini fallback)

Hugging Face ko current provider banane ke liye backend ke `.env` mein ye
configuration add करें:

```text
HF_API_TOKEN=your_huggingface_token_here
HF_ENHANCE_MODEL=caidas/swin2SR-classical-sr-x2-64
```

Gemini ko future fallback ke liye optional rakhein:

```text
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-flash-image
```

Upload के बाद **Enhance with AI** button दबाएँ. Provider से आई image पर
existing background removal, crop और passport-size processing फिर से लागू होती
है. ध्यान दें: `caidas/swin2SR-classical-sr-x2-64` Hugging Face के free
`hf-inference` serverless provider पर currently supported नहीं है, इसलिए इसे
चलाने के लिए dedicated Inference Endpoint चाहिए. जब तक endpoint उपलब्ध न हो,
frontend अपने local Studio Clarity enhancement पर fallback करता है. Keys
frontend में कभी न रखें.

## 5. Frontend ko backend se connect karo

## 6. Wallet, manual UPI payments and Supervisor Mode

Every browser receives an opaque, HttpOnly device cookie. The server stores five
free uses and the wallet balance in SQLite; client-side counters are never trusted.
After the free uses, each successful background removal or Word download costs
₹5. Users pay your UPI ID outside the app and submit a claim with the UTR.
Claims remain pending until an authenticated administrator verifies them; only
approval credits the wallet, and duplicate UTRs are rejected.

Set these public payment details in `.env`:

```text
UPI_ID=your-upi-id@bank
UPI_QR_IMAGE_URL=https://example.com/upi-qr.png
PAYMENT_RECEIVER_NAME=Your name
```

The browser reads these values only from the small public
`GET /api/payment-config` response. No Firebase account is required: the
existing opaque HttpOnly device cookie identifies a wallet and payment claim.
Set `COOKIE_SECURE=true` (and use HTTPS) when the frontend and backend are on
different sites. Admin claim review actions are session-authenticated and
CSRF-protected.

Supervisor Mode is intended only for the father/developer and bypasses wallet
charges and app quotas for the current device session. Generate a scrypt hash
without putting the code in source control:

```bash
node admin/generate-supervisor-hash.js "your-long-private-code"
```

Copy the output to `SUPERVISOR_CODE_HASH` for the first deployment. The
authenticated admin panel can subsequently set, replace, or disable the code;
the current value is stored as a scrypt hash in SQLite and takes effect without
a restart. Failed attempts are rate limited and temporarily locked. Never
expose the code or hash to the frontend.

## Project samajhne aur debug karne ke guides

- [Architecture guide](./docs/ARCHITECTURE.md): request flow, file
  responsibilities, and future module structure.
- [Learning and debugging guide](./docs/LEARNING_GUIDE.md): concepts,
  commands, status codes, and a repeatable debugging process.
- [Engineer guide](./docs/ENGINEER_GUIDE.md): deployment map, request flow,
  configuration, admin panel, database, and feature development workflow.

`passport-photo-word-generator.html` file mein ye line dhundo (upar, script
ke shuru mein):

```js
const BACKEND_URL = ''; // e.g. 'https://your-app.onrender.com'
```

Ismein apne backend ka URL daal do:
- Local testing ke liye: `'http://localhost:8787'`
- Production ke liye: jahan deploy karoge wahan ka URL (deployment section dekho)

## 7. Free deployment (production ke liye)

Ye backend kisi bhi free Node hosting par chal jaayega. Sabse aasaan:

**Render.com (free tier)**
1. Is `backend/` folder ko ek GitHub repo mein push karo
2. Render.com par "New Web Service" → apna repo select karo
3. Build command: `npm install`, Start command: `npm start`
4. Environment tab mein `REMOVE_BG_API_KEY` aur `ALLOWED_ORIGINS` add karo
5. Deploy hone ke baad mila URL frontend ke `BACKEND_URL` mein daal do

Railway.app aur Fly.io bhi isi tarah free tier par kaam karte hain.

## Notes

- remove.bg API usage account ke credits/rate limits par depend karti hai.
- Manual payment claims require administrator verification before credits are
  added to a wallet.
