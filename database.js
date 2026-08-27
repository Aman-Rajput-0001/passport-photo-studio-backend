const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
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
  CREATE TABLE IF NOT EXISTS api_usage (
    service TEXT PRIMARY KEY,
    usage_month TEXT NOT NULL,
    request_count INTEGER NOT NULL,
    reserved_count INTEGER NOT NULL DEFAULT 0
  );
`);
const columns = db.prepare('PRAGMA table_info(photo_uploads)').all().map(column => column.name);
if (!columns.includes('photo_width_mm')) db.exec('ALTER TABLE photo_uploads ADD COLUMN photo_width_mm REAL');
if (!columns.includes('photo_height_mm')) db.exec('ALTER TABLE photo_uploads ADD COLUMN photo_height_mm REAL');
const apiUsageColumns = db.prepare('PRAGMA table_info(api_usage)').all().map(column => column.name);
if (!apiUsageColumns.includes('reserved_count')) db.exec('ALTER TABLE api_usage ADD COLUMN reserved_count INTEGER NOT NULL DEFAULT 0');
db.exec(`
  CREATE TABLE IF NOT EXISTS user_wallets (
    device_id TEXT PRIMARY KEY,
    free_uses_remaining INTEGER NOT NULL DEFAULT 5,
    balance_paise INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage_records (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    status TEXT NOT NULL,
    amount_paise INTEGER NOT NULL DEFAULT 0,
    free_use INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(device_id, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS idx_usage_records_device ON usage_records(device_id, created_at);
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    razorpay_order_id TEXT NOT NULL UNIQUE,
    razorpay_payment_id TEXT,
    amount_paise INTEGER NOT NULL,
    status TEXT NOT NULL,
    signature TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_payment_id ON payments(razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;
`);
const initialUsageMonth = new Date().toISOString().slice(0, 7);
db.prepare(`
  INSERT INTO api_usage (service, usage_month, request_count, reserved_count)
  VALUES ('remove.bg', ?, ?, 0)
  ON CONFLICT(service) DO NOTHING
`).run(initialUsageMonth, Number(process.env.REMOVE_BG_INITIAL_USAGE || 4));

const FREE_USES = 5;
const CHARGE_PAISE = 500;
function nowIso() { return new Date().toISOString(); }

function ensureWallet(deviceId) {
  const now = nowIso();
  db.prepare(`
    INSERT INTO user_wallets (device_id, free_uses_remaining, balance_paise, created_at, updated_at)
    VALUES (?, ?, 0, ?, ?)
    ON CONFLICT(device_id) DO NOTHING
  `).run(deviceId, FREE_USES, now, now);
  return db.prepare('SELECT device_id, free_uses_remaining, balance_paise, created_at, updated_at FROM user_wallets WHERE device_id = ?').get(deviceId);
}

function getWallet(deviceId) {
  return ensureWallet(deviceId);
}

function walletSummary(deviceId) {
  const wallet = getWallet(deviceId);
  return {
    freeUsesRemaining: wallet.free_uses_remaining,
    balancePaise: wallet.balance_paise,
    balanceRupees: wallet.balance_paise / 100,
    chargePaise: CHARGE_PAISE,
  };
}

function reserveUsage(deviceId, operation, idempotencyKey, supervisor = false) {
  if (!deviceId || !['remove_bg', 'word_download'].includes(operation)) {
    return { allowed: false, code: 'INVALID_USAGE_REQUEST' };
  }
  const existing = idempotencyKey
    ? db.prepare('SELECT * FROM usage_records WHERE device_id = ? AND idempotency_key = ?').get(deviceId, idempotencyKey)
    : null;
  if (existing) {
    return {
      allowed: existing.status !== 'void',
      alreadyProcessed: true,
      usageId: existing.id,
      chargedPaise: existing.amount_paise,
      freeUse: existing.free_use === 1,
      status: existing.status,
      wallet: walletSummary(deviceId),
    };
  }

  ensureWallet(deviceId);
  db.exec('BEGIN IMMEDIATE');
  try {
    const wallet = db.prepare('SELECT free_uses_remaining, balance_paise FROM user_wallets WHERE device_id = ?').get(deviceId);
    let amountPaise = 0;
    let freeUse = 0;
    if (!supervisor && wallet.free_uses_remaining > 0) {
      freeUse = 1;
      db.prepare('UPDATE user_wallets SET free_uses_remaining = free_uses_remaining - 1, updated_at = ? WHERE device_id = ?').run(nowIso(), deviceId);
    } else if (!supervisor) {
      amountPaise = CHARGE_PAISE;
      if (wallet.balance_paise < amountPaise) {
        db.exec('ROLLBACK');
        return { allowed: false, code: 'INSUFFICIENT_BALANCE', wallet: walletSummary(deviceId) };
      }
      db.prepare('UPDATE user_wallets SET balance_paise = balance_paise - ?, updated_at = ? WHERE device_id = ?').run(amountPaise, nowIso(), deviceId);
    }
    const usageId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO usage_records (id, device_id, operation, status, amount_paise, free_use, idempotency_key, created_at)
      VALUES (?, ?, ?, 'reserved', ?, ?, ?, ?)
    `).run(usageId, deviceId, operation, amountPaise, freeUse, idempotencyKey || null, nowIso());
    db.exec('COMMIT');
    return { allowed: true, usageId, chargedPaise: amountPaise, freeUse: freeUse === 1, wallet: walletSummary(deviceId) };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    if (String(error.message).includes('UNIQUE')) {
      return reserveUsage(deviceId, operation, idempotencyKey, supervisor);
    }
    throw error;
  }
}

function completeUsage(usageId) {
  db.prepare(`
    UPDATE usage_records SET status = 'completed', completed_at = ?
    WHERE id = ? AND status = 'reserved'
  `).run(nowIso(), usageId);
}

function voidUsage(usageId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const record = db.prepare('SELECT device_id, amount_paise, free_use, status FROM usage_records WHERE id = ?').get(usageId);
    if (!record || record.status !== 'reserved') {
      db.exec('COMMIT');
      return;
    }
    if (record.free_use === 1) {
      db.prepare('UPDATE user_wallets SET free_uses_remaining = free_uses_remaining + 1, updated_at = ? WHERE device_id = ?').run(nowIso(), record.device_id);
    } else if (record.amount_paise > 0) {
      db.prepare('UPDATE user_wallets SET balance_paise = balance_paise + ?, updated_at = ? WHERE device_id = ?').run(record.amount_paise, nowIso(), record.device_id);
    }
    db.prepare('UPDATE usage_records SET status = ? WHERE id = ? AND status = ?').run('void', usageId, 'reserved');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
}

function creditPayment({ deviceId, orderId, paymentId, amountPaise, signature, status = 'captured' }) {
  const now = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    let payment = db.prepare('SELECT * FROM payments WHERE razorpay_order_id = ?').get(orderId);
    if (!payment) {
      if (!deviceId) {
        db.exec('COMMIT');
        return null;
      }
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO payments (id, device_id, razorpay_order_id, razorpay_payment_id, amount_paise, status, signature, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, deviceId, orderId, paymentId || null, amountPaise, status, signature || null, now, now);
      payment = { id, device_id: deviceId, amount_paise: amountPaise, status };
    } else if (payment.status !== 'captured' && status === 'captured') {
      db.prepare(`
        UPDATE payments SET razorpay_payment_id = COALESCE(?, razorpay_payment_id),
          status = 'captured', signature = COALESCE(?, signature), updated_at = ?
        WHERE razorpay_order_id = ?
      `).run(paymentId || null, signature || null, now, orderId);
      db.prepare('UPDATE user_wallets SET balance_paise = balance_paise + ?, updated_at = ? WHERE device_id = ?')
        .run(payment.amount_paise, now, payment.device_id);
      payment.status = 'captured';
    }
    db.exec('COMMIT');
    return db.prepare('SELECT * FROM payments WHERE razorpay_order_id = ?').get(orderId);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
}

function createPayment(deviceId, orderId, amountPaise) {
  ensureWallet(deviceId);
  const now = nowIso();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO payments (id, device_id, razorpay_order_id, amount_paise, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'created', ?, ?)
  `).run(id, deviceId, orderId, amountPaise, now, now);
}

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

function getApiUsage(limit = 50) {
  const usageMonth = new Date().toISOString().slice(0, 7);
  const row = db.prepare('SELECT usage_month, request_count, reserved_count FROM api_usage WHERE service = ?').get('remove.bg');
  if (!row || row.usage_month !== usageMonth) {
    db.prepare('UPDATE api_usage SET usage_month = ?, request_count = 0, reserved_count = 0 WHERE service = ?').run(usageMonth, 'remove.bg');
    return { used: 0, limit, remaining: limit };
  }
  return { used: row.request_count, limit, remaining: Math.max(0, limit - row.request_count), reserved: row.reserved_count || 0 };
}

function reserveApiRequest(limit = 50) {
  const usage = getApiUsage(limit);
  if (usage.used + usage.reserved >= limit) return { allowed: false, ...usage };
  db.prepare('UPDATE api_usage SET reserved_count = reserved_count + 1 WHERE service = ?').run('remove.bg');
  return { allowed: true, ...getApiUsage(limit) };
}

function completeApiRequest() {
  db.prepare('UPDATE api_usage SET reserved_count = MAX(0, reserved_count - 1), request_count = request_count + 1 WHERE service = ?').run('remove.bg');
}

function releaseApiRequest() {
  db.prepare('UPDATE api_usage SET reserved_count = MAX(0, reserved_count - 1) WHERE service = ?').run('remove.bg');
}

module.exports = {
  uploadsDir, createUpload, completeUpload, failUpload, listUploads, getApiUsage,
  reserveApiRequest, completeApiRequest, releaseApiRequest, getWallet, walletSummary,
  reserveUsage, completeUsage, voidUsage, createPayment, creditPayment,
};
