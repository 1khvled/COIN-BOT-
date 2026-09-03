/**
 * crypto.js — AES-256-CBC encryption for cookie storage
 *
 * Cookies are stored in SQLite as  iv_hex:ciphertext_hex
 * Key is derived once from ENCRYPT_SECRET via SHA-256.
 */

const crypto = require('crypto');

const ALGO = 'aes-256-cbc';
const IV_LEN = 16;

/** Derive a 32-byte key from the env secret using SHA-256 */
function deriveKey() {
  const secret = process.env.ENCRYPT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('ENCRYPT_SECRET must be at least 16 characters');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

let _key = null;
function getKey() {
  if (!_key) _key = deriveKey();
  return _key;
}

/**
 * Encrypt plaintext → "iv_hex:ciphertext_hex"
 * @param {string} plaintext
 * @returns {string}
 */
function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt "iv_hex:ciphertext_hex" → plaintext
 * @param {string} encrypted
 * @returns {string}
 */
function decrypt(encrypted) {
  const key = getKey();
  const [ivHex, cipherHex] = encrypted.split(':');
  if (!ivHex || !cipherHex) throw new Error('Invalid encrypted format');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = { encrypt, decrypt };
