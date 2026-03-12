'use strict';
const fs   = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', 'logs', 'app.log');

function stamp() { return new Date().toISOString(); }

function write(line) {
  const out = `[${stamp()}] ${line}\n`;
  process.stdout.write(out);
  try { fs.appendFileSync(LOG_FILE, out); } catch {}
}

module.exports = {
  info:  (...a) => write('INFO  ' + a.join(' ')),
  warn:  (...a) => write('WARN  ' + a.join(' ')),
  error: (...a) => write('ERROR ' + a.join(' ')),
  // Express request logger middleware
  middleware: (req, _res, next) => {
    write(`REQ   ${req.method} ${req.path}`);
    next();
  },
};
