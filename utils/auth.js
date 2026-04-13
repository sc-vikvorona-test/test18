import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'hardcoded-fallback-secret';

// VULNERABLE: No expiry on auth token
function generateAuthToken(userId) {
  return jwt.sign({ userId }, SECRET);
  // Missing: { expiresIn: '24h' }
}

// VULNERABLE: No expiry on share token  
function generateShareToken(resourceId, userId) {
  return jwt.sign(
    { resourceId, userId, type: 'share' },
    SECRET
    // No expiry - permanent access
  );
}

// VULNERABLE: Token not validated for expiry
function validateToken(token) {
  try {
    return jwt.decode(token);  // decode not verify!
  } catch (err) {
    return null;
  }
}

// VULNERABLE: exposes error details
function verifyAndGetUser(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch (err) {
    throw new Error('Token error: ' + err.message);  // leaks implementation detail
  }
}

export { generateAuthToken, generateShareToken, validateToken, verifyAndGetUser };

