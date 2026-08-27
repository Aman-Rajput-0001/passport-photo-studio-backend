const crypto = require('node:crypto');

const code = process.argv[2];
if (!code || code.length < 8) {
  process.stderr.write('Usage: node admin/generate-supervisor-hash.js "strong-supervisor-code"\n');
  process.exit(1);
}

const N = 16384;
const r = 8;
const p = 1;
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(code, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
process.stdout.write(`scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}\n`);
