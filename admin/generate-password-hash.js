const crypto = require('node:crypto');

const password = process.argv[2];
if (!password) {
  process.stderr.write('Usage: node admin/generate-password-hash.js "strong-password"\n');
  process.exit(1);
}
const N = 16384;
const r = 8;
const p = 1;
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(password, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
process.stdout.write(`scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}\n`);
