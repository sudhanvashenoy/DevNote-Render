const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const DEFAULT_DEV_SECRET = 'knowbase-super-secret-change-in-prod';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('\n❌ JWT_SECRET environment variable is not set.');
  console.error('   Set a strong, random JWT_SECRET before running in production (see .env.example).\n');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_DEV_SECRET;

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    req.user = verifyToken(auth.slice(7));
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 12);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

// Check if app is initialized
function isSetup() {
  const config = db.config.get();
  return !!config.masterHash;
}

module.exports = { generateToken, authMiddleware, hashPassword, verifyPassword, isSetup };
