# Passport Photo Studio - Architecture

This document explains how the project works without hiding the important
details behind AI-generated code.

## Big picture

```text
Browser (passport-photo-word-generator.html)
        |
        | HTTP: /api/status, /api/remove-bg, /api/ai-enhance
        v
Node + Express (server.js)
        |
        +--> remove.bg API       (background removal)
        +--> Hugging Face API    (optional AI enhancement)
        +--> Gemini API          (optional future fallback)
        +--> SQLite              (upload metadata)
        +--> data/uploads/       (image files)
        |
        +--> admin/router.js     (private admin APIs)
```

## Request lifecycle

### Background removal

1. The browser selects an image.
2. `multer` receives it in memory and checks that it is an image.
3. `server.js` sends the image and background settings to remove.bg.
4. The PNG response is returned to the browser.
5. Upload metadata and original/processed files are saved in `data/`.

### AI enhancement

1. The browser sends the original image to `POST /api/ai-enhance`.
2. The server tries Hugging Face first when `HF_API_TOKEN` exists.
3. Gemini is tried only when Hugging Face fails and Gemini is configured.
4. If both providers fail, the browser keeps the original file and uses its
   local Studio Clarity processing.

The API keys stay in the backend `.env`; they must never be placed in HTML or
browser JavaScript.

## File responsibilities

| File | Responsibility |
| --- | --- |
| `server.js` | Express app, configuration, upload validation, external APIs, logging |
| `database.js` | SQLite setup and upload metadata queries |
| `admin/router.js` | Admin login, sessions, CSRF checks, logs, maintenance state |
| `admin/index.html` | Admin dashboard markup |
| `admin/app.js` | Admin dashboard browser behavior |
| `admin/style.css` | Admin dashboard styles |
| `passport-photo-word-generator.html` | Main UI and local image-processing pipeline |
| `.env` | Local secrets and configuration; never commit it |
| `.env.example` | Safe configuration template |
| `data/` | Runtime database, site state, and uploaded files |

## Important design decisions

- Image uploads use memory storage, which avoids temporary upload files but
  means the 12 MB limit must remain in place.
- Maintenance mode is an application state, not a process shutdown. This keeps
  the admin panel available while public processing endpoints return `503`.
- The browser performs crop, filters, and document generation locally. The
  server is mainly a secure API proxy and metadata store.
- The server logs both HTTP requests and meaningful events so failures can be
  traced from the terminal or admin panel.

## Suggested future structure

When the project grows, split `server.js` gradually:

```text
src/
  config.js              # environment variables and validation
  middleware/
    upload.js             # multer configuration
    logging.js            # request/event logging
  routes/
    health.js
    image.js              # remove-bg and ai-enhance
    status.js
  services/
    remove-bg.js
    ai-enhancement.js
  app.js
  server.js               # only starts the HTTP server
```

Do not do this as a blind move. First understand one route, move it with a
small test, then move the next route.
