// Minimal backend for the Passport Photo tool's background removal.
//
// What it does:
//   - Exposes POST /api/remove-bg
//   - Receives the uploaded photo from the browser
//   - Removes the background using the remove.bg API
//   - Returns a PNG with transparent background

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const FormData = require('form-data');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { uploadsDir, createUpload, completeUpload, failUpload, listUploads } = require('./database');
const { createAdminRouter } = require('./admin/router');

const PORT = process.env.PORT || 8787;
const REMOVE_BG_API_KEY = process.env.REMOVE_BG_API_KEY;
const REMOVE_BG_ENDPOINT = 'https://api.remove.bg/v1.0/removebg';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-image';
const HF_API_TOKEN = process.env.HF_API_TOKEN;
const HF_ENHANCE_MODEL = process.env.HF_ENHANCE_MODEL || 'caidas/swin2SR-classical-sr-x2-64';
const ADMIN_PATH_SECRET = String(process.env.ADMIN_PATH_SECRET || '').replace(/^\/+|\/+$/g, '');

// Comma-separated list of origins allowed to call this backend.
// Use "*" while testing.
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS || '*'
)
  .split(',')
  .map(s => s.trim());

const app = express();
console.log('[SERVER] Developer: Aman Somvanshi');

// -------------------------------
// REQUEST LOGGING
// -------------------------------

const requestLogs = [];
const MAX_REQUEST_LOGS = 500;
function addRequestLog(entry) {
  requestLogs.push({
    time: new Date().toISOString(),
    method: entry.method || 'SYSTEM',
    path: entry.path || '-',
    status: entry.status ?? 200,
    durationMs: entry.durationMs ?? 0,
    ip: entry.ip || '-',
    message: entry.message || 'Completed',
  });
  if (requestLogs.length > MAX_REQUEST_LOGS) requestLogs.shift();
}

function logEvent(message, details = {}) {
  const suffix = details.path ? ` ${details.path}` : '';
  console.log(`[EVENT] ${message}${suffix}`);
  addRequestLog({
    method: 'EVENT',
    path: details.path || '-',
    status: details.status ?? 200,
    message,
  });
}

app.use((req, res, next) => {
  const startedAt = Date.now();
  const requestPath = String(req.originalUrl || req.url).split('?')[0];
  res.on('finish', () => {
    const entry = {
      method: req.method,
      path: requestPath,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      ip: req.ip,
      message: `${req.method} ${requestPath} completed`,
    };
    addRequestLog(entry);
    console.log(`[REQUEST] ${new Date().toISOString()} ${entry.method} ${entry.path} ${entry.status} ${entry.durationMs}ms — ${entry.message}`);
  });
  next();
});

// -------------------------------
// CORS
// -------------------------------

app.use(
  cors({
    origin: ALLOWED_ORIGINS.includes('*')
      ? true
      : ALLOWED_ORIGINS,
  })
);

// -------------------------------
// FILE UPLOAD
// -------------------------------

// Accept images up to 12MB.
// Images are kept in memory.
const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 12 * 1024 * 1024,
  },

  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(
        new Error('Only image uploads are allowed')
      );
    }

    cb(null, true);
  },
});

// -------------------------------
// HEALTH CHECK
// -------------------------------

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// Public, intentionally small status response. It contains no admin or upload data.
const siteStateFile = path.join(__dirname, 'data', 'site-state.json');
let siteState = { maintenance: false, message: '', updatedAt: null };
try {
  const savedState = JSON.parse(fs.readFileSync(siteStateFile, 'utf8'));
  if (savedState && typeof savedState === 'object') {
    siteState = {
      maintenance: savedState.maintenance === true,
      message: typeof savedState.message === 'string' ? savedState.message.slice(0, 500) : '',
      updatedAt: savedState.updatedAt || null,
    };
  }
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error('[STATUS] Could not read saved site state:', error.message);
  }
}

app.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(siteState);
});

// Optional generative enhancement. The key stays on the server.
app.post('/api/ai-enhance', upload.single('image'), async (req, res) => {
  logEvent('AI enhancement request received', { path: '/api/ai-enhance' });
  if (siteState.maintenance) {
    logEvent('AI enhancement blocked because site is in maintenance mode', { path: '/api/ai-enhance', status: 503 });
    return res.status(503).json({ error: 'Website is under maintenance' });
  }
  if (!req.file) {
    logEvent('AI enhancement rejected because no image was uploaded', { path: '/api/ai-enhance', status: 400 });
    return res.status(400).json({ error: 'No image uploaded (expected field name "image")' });
  }
  const hasHuggingFace = Boolean(HF_API_TOKEN && HF_API_TOKEN !== 'your_huggingface_token_here');
  const hasGemini = Boolean(GEMINI_API_KEY && GEMINI_API_KEY !== 'your_gemini_api_key_here');
  if (!hasHuggingFace && !hasGemini) {
    logEvent('AI enhancement unavailable because no provider is configured', { path: '/api/ai-enhance', status: 503 });
    return res.status(503).json({ error: 'AI enhancement is not configured. Set HF_API_TOKEN or GEMINI_API_KEY in .env.' });
  }

  const prompt = [
    'Enhance this passport photo without changing the person identity.',
    'Do not alter facial features, face shape, eyes, nose, mouth, hair, clothing, pose, or age.',
    'Only improve exposure, white balance, mild denoising, and natural sharpness.',
    'Return an image only, with the same person and composition.',
  ].join(' ');

  try {
    if (hasHuggingFace) {
      logEvent(`Sending image to Hugging Face model ${HF_ENHANCE_MODEL}`, { path: '/api/ai-enhance' });
      const hfResponse = await fetch(`https://router.huggingface.co/hf-inference/models/${HF_ENHANCE_MODEL}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${HF_API_TOKEN}`,
          'Content-Type': req.file.mimetype,
        },
        body: req.file.buffer,
      });
      if (hfResponse.ok) {
        const enhancedImage = Buffer.from(await hfResponse.arrayBuffer());
        if (enhancedImage.length > 0) {
          logEvent(`Hugging Face enhancement succeeded (${enhancedImage.length} bytes)`, { path: '/api/ai-enhance' });
          return res.type(hfResponse.headers.get('content-type') || 'image/png').send(enhancedImage);
        }
      }
      const hfDetails = await hfResponse.text();
      logEvent(`Hugging Face provider returned HTTP ${hfResponse.status}`, { path: '/api/ai-enhance', status: hfResponse.status });
      console.warn('[AI-ENHANCE] Hugging Face response:', hfResponse.status, hfDetails.slice(0, 500));
      if (!hasGemini) {
        if (hfResponse.status === 400 && hfDetails.includes('not supported by provider')) {
          return res.status(503).json({
            error: 'This Hugging Face model is not available on the free serverless provider.',
            details: `Model "${HF_ENHANCE_MODEL}" needs a dedicated Hugging Face Inference Endpoint or a supported provider. Use local Studio Clarity for now.`,
          });
        }
        return res.status(hfResponse.status || 502).json({
          error: 'Hugging Face enhancement failed',
          details: 'The free model may be loading or rate-limited. Try again shortly or use Studio Clarity.',
        });
      }
      logEvent('Hugging Face failed; trying Gemini fallback', { path: '/api/ai-enhance' });
    }

    logEvent(`Sending ${req.file.mimetype} image to Gemini model ${GEMINI_MODEL}`, { path: '/api/ai-enhance' });
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const geminiResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: req.file.mimetype, data: req.file.buffer.toString('base64') } },
          ],
        }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
    });
    const payload = await geminiResponse.json();
    if (!geminiResponse.ok) {
      console.error('[AI-ENHANCE] Gemini request failed:', geminiResponse.status, payload);
      logEvent(`Gemini provider returned HTTP ${geminiResponse.status}`, { path: '/api/ai-enhance', status: geminiResponse.status });
      if (geminiResponse.status === 429) {
        res.set('Retry-After', '60');
        return res.status(429).json({
          error: 'Gemini free quota is exhausted or unavailable for this project.',
          details: 'Use local Studio Clarity, wait for quota reset, or enable billing in Google AI Studio.',
        });
      }
      return res.status(geminiResponse.status).json({ error: 'Gemini enhancement failed', details: payload.error?.message || 'Provider error' });
    }

    const parts = payload.candidates?.flatMap(candidate => candidate.content?.parts || []) || [];
    const imagePart = parts.find(part => part.inlineData?.data || part.inline_data?.data);
    const imageData = imagePart?.inlineData || imagePart?.inline_data;
    if (!imageData?.data) {
      logEvent('Gemini returned no image data', { path: '/api/ai-enhance', status: 502 });
      return res.status(502).json({ error: 'Gemini returned no enhanced image. Use an image-generation model.' });
    }
    const enhancedImage = Buffer.from(imageData.data, 'base64');
    logEvent(`Gemini enhancement succeeded (${enhancedImage.length} bytes)`, { path: '/api/ai-enhance' });
    res.type(imageData.mimeType || imageData.mime_type || 'image/png').send(enhancedImage);
  } catch (error) {
    console.error('[AI-ENHANCE] FAILED:', error);
    logEvent(`Gemini enhancement failed: ${error.message}`, { path: '/api/ai-enhance', status: 502 });
    res.status(502).json({ error: 'Gemini enhancement is unavailable', details: error.message });
  }
});

// -------------------------------
// BACKGROUND REMOVAL
// -------------------------------

app.post(
  '/api/remove-bg',
  upload.single('image'),

  async (req, res) => {
    console.log('[REMOVE-BG] Endpoint reached');
    logEvent('Background removal request received', { path: '/api/remove-bg' });

    if (siteState.maintenance) {
      return res.status(503).json({
        error: 'Website is under maintenance',
        message: siteState.message || 'Please check back soon.',
      });
    }

    if (!req.file) {
      logEvent('Background removal rejected because no image was uploaded', { path: '/api/remove-bg', status: 400 });
      return res.status(400).json({
        error:
          'No image uploaded (expected field name "image")',
      });
    }

   const uploadId = crypto.randomUUID();
   const originalFileName = `${uploadId}-original${path.extname(req.file.originalname).toLowerCase() || '.bin'}`;
   const originalPath = path.join(uploadsDir, originalFileName);
   fs.writeFileSync(originalPath, req.file.buffer);
   createUpload({
     id: uploadId,
     // Identity stays empty until Firebase Admin verifies an ID token.
     // Never trust a UID or email sent directly by the browser.
     firebaseUid: null,
     userEmail: null,
     originalName: req.file.originalname,
     originalPath: originalFileName,
     mimeType: req.file.mimetype,
     originalBytes: req.file.size,
     backgroundColor: req.body.backgroundColor,
     quantity: req.body.quantity,
     createdAt: new Date().toISOString(),
   });

   try {
     if (!REMOVE_BG_API_KEY || REMOVE_BG_API_KEY === 'your_remove_bg_api_key_here') {
       failUpload(uploadId, 'remove.bg is not configured');
       return res.status(500).json({
         error: 'remove.bg is not configured. Set REMOVE_BG_API_KEY in .env.',
       });
     }

     console.log(
       `[REMOVE-BG] Upload: ` +
       `${req.file.originalname} | ` +
       `${req.file.mimetype} | ` +
       `${req.file.size} bytes`
     );

     console.log('[REMOVE-BG] Sending image to remove.bg...');
     logEvent(`Sending ${req.file.mimetype} image (${req.file.size} bytes) to remove.bg`, { path: '/api/remove-bg' });

     const formData = new FormData();
     formData.append(
       'image_file',
       req.file.buffer,
       {
         filename: req.file.originalname,
         contentType: req.file.mimetype,
       }
     );
     formData.append('size', 'auto');
     formData.append('format', 'png');
     const requestedColor = String(req.body.backgroundColor || '').replace('#', '');
     if (/^[0-9a-fA-F]{6}$/.test(requestedColor)) {
       formData.append('bg_color', requestedColor);
       console.log(`[REMOVE-BG] Background color: #${requestedColor}`);
     }
     const formBody = formData.getBuffer();

     const removeBgResponse = await fetch(REMOVE_BG_ENDPOINT, {
       method: 'POST',
       headers: {
         'X-Api-Key': REMOVE_BG_API_KEY,
         ...formData.getHeaders(),
         'Content-Length': String(formBody.length),
       },
       body: formBody,
     });

     if (!removeBgResponse.ok) {
       const responseText = await removeBgResponse.text();
       console.error('[REMOVE-BG] remove.bg request failed:', removeBgResponse.status, responseText);
       failUpload(uploadId, `remove.bg request failed with status ${removeBgResponse.status}`);
       return res.status(removeBgResponse.status).json({
         error: 'remove.bg background removal failed',
         details: responseText,
       });
     }

     const processedImage = Buffer.from(await removeBgResponse.arrayBuffer());
     const processedFileName = `${uploadId}-processed.png`;
     fs.writeFileSync(path.join(uploadsDir, processedFileName), processedImage);
     completeUpload(uploadId, processedFileName, processedImage.length);

     console.log(
       `[REMOVE-BG] Success | ${processedImage.length} bytes`
     );
     logEvent(`Background removal succeeded (${processedImage.length} bytes)`, { path: '/api/remove-bg' });

     res.type('png').send(processedImage);
   } catch (err) {
     console.error('[REMOVE-BG] FAILED:', err);
     logEvent(`Background removal failed: ${err.message}`, { path: '/api/remove-bg', status: 500 });
     failUpload(uploadId, err.message || 'Background removal failed');

     if (err && err.cause && err.cause.code === 'ENOTFOUND') {
       return res.status(502).json({
         error: 'Cannot resolve the remove.bg API host.',
         details: 'Check your internet, DNS, or VPN settings.',
       });
     }

     res.status(500).json({
       error: 'Background removal failed',
       details: err.message,
     });
   }
  }
);

// Handle upload validation and size-limit errors consistently.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message === 'Only image uploads are allowed') {
   return res.status(400).json({ error: err.message });
  }

  next(err);
});

if (ADMIN_PATH_SECRET && /^[A-Za-z0-9_-]{8,128}$/.test(ADMIN_PATH_SECRET)) {
  const adminBasePath = `/${ADMIN_PATH_SECRET}`;
  app.get(adminBasePath, (req, res) => res.redirect(302, `${adminBasePath}/`));
  app.use(adminBasePath, createAdminRouter({
    basePath: adminBasePath,
    listUploads,
    getLogs: limit => requestLogs.slice(-limit).reverse(),
    getSiteState: () => siteState,
    setSiteState: nextState => {
      siteState = {
        maintenance: nextState.maintenance === true,
        message: String(nextState.message || '').slice(0, 500),
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(siteStateFile, JSON.stringify(siteState, null, 2), { mode: 0o600 });
      return siteState;
    },
    secureCookies: process.env.ADMIN_COOKIE_SECURE === 'true',
  }));
  console.log('[ADMIN] Panel enabled at configured secret path');
} else {
  console.warn('[ADMIN] Panel disabled: set ADMIN_PATH_SECRET to a random 8+ character value.');
}

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof SyntaxError && err.status === 400 && Object.prototype.hasOwnProperty.call(err, 'body')) {
    return res.status(400).json({ error: 'Invalid JSON request body' });
  }
  console.error('[SERVER] Request failed:', err && err.message ? err.message : err);
  res.status(500).json({ error: 'Internal server error' });
});

// -------------------------------
// SERVER START
// -------------------------------

app.listen(PORT, () => {
  console.log(`[CONFIG] Gemini AI: ${GEMINI_API_KEY ? 'configured' : 'not configured (optional)'}`);
  console.log(`[CONFIG] Hugging Face AI: ${HF_API_TOKEN ? `configured (${HF_ENHANCE_MODEL})` : 'not configured (optional)'}`);
  console.log(`[CONFIG] remove.bg: ${REMOVE_BG_API_KEY ? 'configured' : 'not configured'}`);
  console.log(
    `Passport photo backend running on http://localhost:${PORT}`
  );
});