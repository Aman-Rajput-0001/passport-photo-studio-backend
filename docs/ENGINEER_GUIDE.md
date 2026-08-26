# Passport Photo Studio - Engineer-Level Guide

This guide explains what was built, where each part lives, how deployment
works, and how to debug the system without depending on an AI response.

## 1. What the product does

The user uploads a photo, chooses a quantity and background, and downloads an
A4 Word document containing correctly sized passport photos.

There are two processing locations:

- **Browser:** crop, preview, brightness/contrast/saturation, sharpness,
  local Studio Clarity enhancement, and DOCX generation.
- **Backend:** secure API calls to remove.bg and optional AI providers, upload
  metadata, admin authentication, logs, maintenance state, and developer
  messages.

The browser never receives API keys.

## 2. What was pushed where

### GitHub repository

The source code is in:

`Aman-Rajput-0001/passport-photo-studio-backend`

The `main` branch contains:

```text
server.js                         Backend entry point
database.js                       SQLite setup and upload queries
admin/router.js                   Admin API and authentication
admin/index.html                  Admin dashboard HTML
admin/app.js                      Admin dashboard browser logic
admin/style.css                   Admin dashboard styles
passport-photo-word-generator.html Main application UI and browser pipeline
docs/                             Architecture and learning guides
package.json                      Dependencies and npm scripts
.env.example                     Configuration template without secrets
.gitignore                        Files excluded from Git
```

The local `.env`, `data/`, database, uploaded images, sessions, and
`node_modules/` are intentionally not pushed.

### Render

Render watches the GitHub `main` branch and runs:

```text
npm install
npm start
```

`npm start` runs `node server.js`. Render injects environment variables and
provides the `PORT` value. The live backend is:

`https://passport-photo-studio-backend.onrender.com`

### GitHub Pages

GitHub Pages publishes the repository root as static files. The public
frontend is:

`https://aman-rajput-0001.github.io/passport-photo-studio-backend/passport-photo-word-generator.html`

The frontend's `BACKEND_URL` points to the Render backend, so the browser
connects Pages -> Render -> external providers.

## 3. Complete request flow

### Normal photo flow

```text
User selects file
  -> handleFile()
  -> optional POST /api/ai-enhance
  -> optional POST /api/remove-bg
  -> processUploadedFile()
  -> canvas crop and local adjustments
  -> generate DOCX in the browser
  -> download file
```

### Background removal flow

1. The frontend creates `FormData` and appends the file as `image`.
2. `multer` validates the MIME type and enforces the 12 MB limit.
3. `server.js` creates an upload record in SQLite.
4. The backend sends multipart data to
   `https://api.remove.bg/v1.0/removebg`.
5. The response PNG is saved under `data/uploads/` and returned to the browser.
6. SQLite is updated as completed or failed.

The API key is read from `process.env.REMOVE_BG_API_KEY`, never from frontend
code.

### AI flow

1. The frontend calls `POST /api/ai-enhance`.
2. If `HF_API_TOKEN` exists, Hugging Face is tried first.
3. Gemini is tried only when Hugging Face fails and `GEMINI_API_KEY` exists.
4. If both providers fail, the frontend catches the error and continues with
   the original image plus local Studio Clarity.

The configured Swin2SR model is not supported by Hugging Face's free
`hf-inference` provider. That is a provider compatibility issue, not a
frontend upload issue.

## 4. Backend concepts in `server.js`

- `require(...)`: loads Node and installed packages.
- `dotenv.config()`: loads local `.env` before configuration is read.
- `express()`: creates the HTTP application.
- `app.use(...)`: registers middleware, such as CORS and request logging.
- `multer.memoryStorage()`: keeps an uploaded file in RAM temporarily.
- `app.get(...)` / `app.post(...)`: define HTTP endpoints.
- `req`: incoming request, including file and form data.
- `res`: outgoing response; `res.status(...).json(...)` sends an error or JSON.
- `fetch(...)`: calls an external HTTP API.
- `Buffer`: binary image data in Node.js.
- `async/await`: waits for external API and file operations.

The route is the controller: it validates input, calls the service provider,
records the result, and creates the HTTP response.

## 5. Admin panel flow

The admin path is configured by `ADMIN_PATH_SECRET`. For example:

```text
https://passport-photo-studio-backend.onrender.com/admin2008/
```

`server.js` mounts `admin/router.js` at that secret path. The router:

1. Serves the admin HTML, JavaScript, and CSS.
2. Verifies the username and scrypt password hash.
3. Creates a server-side session in memory.
4. Uses an HttpOnly/SameSite cookie.
5. Protects mutations with CSRF validation.
6. Exposes authenticated APIs for uploads, logs, maintenance, and messages.

If the page returns `404`, check Render logs for:

```text
[ADMIN] Panel enabled at configured secret path
```

If it says panel disabled, `ADMIN_PATH_SECRET` is missing or invalid.

## 6. Database and storage

`database.js` creates:

```text
data/passport-photo.sqlite
data/uploads/<id>-original.<ext>
data/uploads/<id>-processed.png
data/site-state.json
```

SQLite stores metadata, not the image bytes. The original and processed images
are files. `site-state.json` stores maintenance mode and the current developer
message.

Render's free filesystem is ephemeral. A restart or redeploy can remove these
files. For production, replace SQLite with managed PostgreSQL and local files
with object storage such as S3, Cloudinary, or Supabase Storage.

## 7. Configuration map

| Variable | Used for |
| --- | --- |
| `PORT` | HTTP port; Render supplies this |
| `REMOVE_BG_API_KEY` | remove.bg authentication |
| `ALLOWED_ORIGINS` | CORS policy |
| `HF_API_TOKEN` | optional Hugging Face authentication |
| `HF_ENHANCE_MODEL` | Hugging Face model name |
| `GEMINI_API_KEY` | optional Gemini fallback |
| `GEMINI_MODEL` | Gemini model name |
| `ADMIN_USERNAME` | admin login name |
| `ADMIN_PASSWORD_HASH` | scrypt password hash |
| `ADMIN_PATH_SECRET` | hidden admin URL path |
| `ADMIN_COOKIE_SECURE` | HTTPS-only admin cookie in production |

After changing a Render variable, use **Save, rebuild, and deploy**. A local
server must be restarted after changing `.env`.

## 8. Debugging method

Always identify the failing layer:

1. **Frontend:** Did the button event run? Check browser DevTools Console.
2. **Network:** Did the request go to the correct URL? Check status and payload.
3. **Backend:** Did Render logs show `[EVENT]` and `[REQUEST]`?
4. **Configuration:** Is the variable present and spelled exactly?
5. **Provider:** Is the external API returning 400, 401, 404, or 429?
6. **Storage:** Did SQLite/file writing fail?

Useful tests:

```powershell
node --check server.js
Invoke-WebRequest https://passport-photo-studio-backend.onrender.com/health
```

Interpret common statuses:

- `400`: invalid upload or missing form field.
- `401`: admin is not logged in.
- `403`: CSRF or permission failure.
- `404`: wrong route or unsupported external model.
- `429`: provider quota/rate limit.
- `503`: maintenance mode or provider unavailable.

Read the first meaningful error, not only the final browser message. For
example, `AI enhancement failed` is generic; the backend log containing
`Model not supported by provider` is the root cause.

## 9. How to add a feature

Use this repeatable process:

1. Write the desired behavior in one sentence.
2. Locate the UI event in the HTML.
3. Decide whether processing belongs in browser or backend.
4. Add or update the backend route if a secret or database is involved.
5. Validate input and define an error response.
6. Add a useful event log at the external boundary.
7. Test success, missing input, provider failure, and maintenance mode.
8. Update the relevant documentation.
9. Commit and push to `main`; Render and Pages redeploy automatically.

Never put a secret in frontend JavaScript, GitHub, screenshots, or chat.
