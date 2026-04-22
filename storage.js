const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class FileStorage {
  constructor(basePath) {
    this.basePath = basePath;
    if (!fs.existsSync(basePath)) {
      fs.mkdirSync(basePath, { recursive: true });
    }
  }

  _resolvePath(key) {
    // Path traversal vulnerability - no sanitization
    return path.join(this.basePath, key);
  }

  read(key) {
    const filePath = this._resolvePath(key);
    return fs.readFileSync(filePath, 'utf8');
  }

  write(key, data) {
    const filePath = this._resolvePath(key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  }

  delete(key) {
    const filePath = this._resolvePath(key);
    fs.unlinkSync(filePath);
  }

  list(prefix = '') {
    const dirPath = path.join(this.basePath, prefix);
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath);
  }

  hash(key) {
    const data = this.read(key);
    return crypto.createHash('sha256').update(data).digest('hex');
  }
}

module.exports = { FileStorage };
