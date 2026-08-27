const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'passport-photo.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS photo_uploads (
    id TEXT PRIMARY KEY,
    firebase_uid TEXT,
    user_email TEXT,
    original_name TEXT NOT NULL,
    original_path TEXT NOT NULL,
    processed_path TEXT,
    mime_type TEXT NOT NULL,
    original_bytes INTEGER NOT NULL,
    processed_bytes INTEGER,
    background_color TEXT,
    quantity INTEGER,
    status TEXT NOT NULL,
    error_message TEXT,
    created_at TEXT NOT NULL,
    processed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_photo_uploads_created_at ON photo_uploads(created_at);
  CREATE INDEX IF NOT EXISTS idx_photo_uploads_firebase_uid ON photo_uploads(firebase_uid);
`);
const columns = db.prepare('PRAGMA table_info(photo_uploads)').all().map(column => column.name);
if (!columns.includes('photo_width_mm')) db.exec('ALTER TABLE photo_uploads ADD COLUMN photo_width_mm REAL');
if (!columns.includes('photo_height_mm')) db.exec('ALTER TABLE photo_uploads ADD COLUMN photo_height_mm REAL');

function createUpload(record) {
  db.prepare(`
    INSERT INTO photo_uploads (
      id, firebase_uid, user_email, original_name, original_path,
      mime_type, original_bytes, background_color, quantity, photo_width_mm, photo_height_mm, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.firebaseUid || null,
    record.userEmail || null,
    record.originalName,
    record.originalPath,
    record.mimeType,
    record.originalBytes,
    record.backgroundColor || null,
    record.quantity || null,
    record.photoWidthMm || null,
    record.photoHeightMm || null,
    'processing',
    record.createdAt
  );
}

function completeUpload(id, processedPath, processedBytes) {
  db.prepare(`
    UPDATE photo_uploads
    SET processed_path = ?, processed_bytes = ?, status = 'completed', processed_at = ?
    WHERE id = ?
  `).run(processedPath, processedBytes, new Date().toISOString(), id);
}

function failUpload(id, message) {
  db.prepare(`
    UPDATE photo_uploads
    SET status = 'failed', error_message = ?, processed_at = ?
    WHERE id = ?
  `).run(message, new Date().toISOString(), id);
}

function listUploads(limit = 100) {
  return db.prepare(`
    SELECT id, firebase_uid, user_email, original_name, mime_type,
           original_bytes, processed_bytes, background_color, quantity, photo_width_mm, photo_height_mm,
           status, error_message, created_at, processed_at
    FROM photo_uploads
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

module.exports = { uploadsDir, createUpload, completeUpload, failUpload, listUploads };
