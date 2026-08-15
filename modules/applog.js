// modules/applog.js — 统一日志：写入 userData/app.log
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

function log(level, ...args) {
  try {
    const line = `[${new Date().toISOString()}] [${level}] ${args
      .map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'object' ? JSON.stringify(a) : String(a)))
      .join(' ')}\n`;
    fs.appendFileSync(path.join(app.getPath('userData'), 'app.log'), line);
  } catch {}
  console.log(`[${level}]`, ...args);
}

module.exports = { log };
