# Learning and Debugging Guide

Use this project as a learning lab. Change one small thing at a time, run the
server, and inspect the logs before making the next change.

## First concepts to learn

1. **JavaScript basics:** variables, functions, objects, arrays, promises,
   `async/await`, and modules.
2. **Node.js:** `require`, `process.env`, filesystem access, and `Buffer`.
3. **Express:** routes, middleware, request/response objects, and status codes.
4. **HTTP:** methods, headers, JSON, multipart form data, and `200/400/401/403/503`.
5. **Frontend JavaScript:** DOM events, `fetch`, `File`, `Blob`, and canvas.
6. **Database basics:** tables, rows, primary keys, and parameterized queries.
7. **Security basics:** environment secrets, password hashing, sessions, CSRF,
   upload limits, and privacy of passport photos.

## How to run safely

```powershell
npm install
npm run dev
```

In another terminal:

```powershell
Invoke-WebRequest http://localhost:8787/health
Invoke-WebRequest http://localhost:8787/api/status
```

`node --check server.js` checks syntax without starting the server.

## How to read a feature

For any feature, trace it in this order:

1. Find the UI button or event in `passport-photo-word-generator.html`.
2. Find the `fetch(...)` call and note the URL and form field names.
3. Find the matching `app.get(...)` or `app.post(...)` route in `server.js`.
4. Follow validation and external API calls.
5. Check the response handling in the browser.
6. Check the terminal log for the same request.

Example: for background removal, search for `remove-bg` in both the HTML and
`server.js`, then follow the request from the browser to remove.bg and back.

## Debugging checklist

When an error appears:

1. Copy the exact HTTP status and message.
2. Check the terminal log entry immediately before the error.
3. Decide whether the failure is browser, backend, configuration, or provider.
4. Check `.env` variable names and restart the server after changing `.env`.
5. Test `/health` to separate server problems from provider problems.
6. Test the failing route with one small image.
7. Fix the root cause; do not hide the error with an unconditional fallback.

### Common statuses

- `400`: request data is missing or invalid.
- `401`: admin authentication is missing or invalid.
- `403`: authenticated but not allowed, often CSRF protection.
- `404`: route or external model does not exist.
- `429`: provider quota or rate limit.
- `503`: feature is unavailable, maintenance mode is active, or a provider is
  not configured.

## Safe feature workflow

Before coding:

1. Write the user-visible behavior in one sentence.
2. Identify the frontend, route, service, and data files involved.
3. Decide what happens when a dependency is unavailable.

While coding:

1. Make the smallest coherent change.
2. Keep secrets server-side.
3. Add a useful log message at an external API boundary.
4. Preserve the existing local fallback.

After coding:

```powershell
node --check server.js
npm run dev
```

Then manually test the changed path and one existing path, such as
`/health` or background removal.

## Current AI limitation

The configured Swin2SR model is not supported by Hugging Face's free
`hf-inference` serverless provider. This is a provider/model compatibility
problem, not a JavaScript syntax problem. The current safe behavior is to show
the provider error in logs and continue with local Studio Clarity processing.
