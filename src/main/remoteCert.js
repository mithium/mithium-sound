const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function derLen(length) {
  if (length < 128) return Buffer.from([length]);
  const bytes = [];
  let n = length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag, content) {
  const body = Array.isArray(content) ? Buffer.concat(content) : content;
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
}

function derSeq(items) {
  return der(0x30, items);
}

function derSet(items) {
  return der(0x31, items);
}

function derInt(buf) {
  let body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (body.length && (body[0] & 0x80)) body = Buffer.concat([Buffer.from([0x00]), body]);
  return der(0x02, body);
}

function derOid(oid) {
  const parts = String(oid).split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f];
    let n = part >> 7;
    while (n > 0) {
      stack.unshift((n & 0x7f) | 0x80);
      n >>= 7;
    }
    bytes.push(...stack);
  }
  return der(0x06, Buffer.from(bytes));
}

function derUtf8(value) {
  return der(0x0c, Buffer.from(String(value)));
}

function derBitString(buf) {
  return der(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
}

function derOctet(buf) {
  return der(0x04, buf);
}

function derUtc(date) {
  const p = (n) => String(n).padStart(2, '0');
  const text = `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(text));
}

function derExplicit(tag, content) {
  return der(0xa0 + tag, content);
}

function algorithmId() {
  return derSeq([derOid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00])]);
}

function directoryName(commonName) {
  return derSeq([
    derSet([
      derSeq([derOid('2.5.4.3'), derUtf8(commonName)]),
    ]),
  ]);
}

function extension(oid, value, critical) {
  const parts = [derOid(oid)];
  if (critical) parts.push(Buffer.from([0x01, 0x01, 0xff]));
  parts.push(derOctet(value));
  return derSeq(parts);
}

function sanExtension(dnsNames, ips) {
  const names = [];
  for (const dns of dnsNames) {
    names.push(der(0x82, Buffer.from(dns)));
  }
  for (const ip of ips) {
    const parts = String(ip).split('.').map(Number);
    if (parts.length === 4 && parts.every((n) => n >= 0 && n <= 255)) {
      names.push(der(0x87, Buffer.from(parts)));
    }
  }
  return extension('2.5.29.17', derSeq(names), false);
}

function pemEncode(label, derBytes) {
  const b64 = derBytes.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

function createSelfSignedCert({ dnsNames = ['localhost'], ips = ['127.0.0.1'], days = 825 } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const subject = directoryName('mithium-sound');
  const now = new Date();
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const serial = crypto.randomBytes(8);
  if (serial[0] === 0) serial[0] = 1;
  const keyUsage = extension('2.5.29.15', der(0x03, Buffer.from([0x05, 0xa0])), true);
  const extKeyUsage = extension('2.5.29.37', derSeq([derOid('1.3.6.1.5.5.7.3.1')]), false);
  const basic = extension('2.5.29.19', derSeq([Buffer.from([0x01, 0x01, 0xff])]), true);
  const tbs = derSeq([
    derExplicit(0, derInt(Buffer.from([0x02]))),
    derInt(serial),
    algorithmId(),
    subject,
    derSeq([derUtc(now), derUtc(until)]),
    subject,
    spki,
    derExplicit(3, derSeq([basic, keyUsage, extKeyUsage, sanExtension(dnsNames, ips)])),
  ]);
  const signature = crypto.createSign('RSA-SHA256').update(tbs).sign(privateKey);
  const cert = derSeq([
    tbs,
    algorithmId(),
    derBitString(signature),
  ]);
  return {
    cert: pemEncode('CERTIFICATE', cert),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function loadOrCreate(dir, ips) {
  const dnsNames = ['localhost'];
  const uniqueIps = Array.from(new Set(['127.0.0.1', ...(ips || [])].filter(Boolean)));
  const stamp = uniqueIps.slice().sort().join(',');
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  const stampPath = path.join(dir, 'sans.txt');
  try {
    if (fs.existsSync(certPath) && fs.existsSync(keyPath) && fs.readFileSync(stampPath, 'utf8') === stamp) {
      return {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
      };
    }
  } catch {
    /* regenerate */
  }
  const created = createSelfSignedCert({ dnsNames, ips: uniqueIps });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(certPath, created.cert);
  fs.writeFileSync(keyPath, created.key, { mode: 0o600 });
  fs.writeFileSync(stampPath, stamp);
  return { cert: created.cert, key: created.key };
}

module.exports = {
  createSelfSignedCert,
  loadOrCreate,
};
