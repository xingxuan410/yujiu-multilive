// modules/diag-chat.js — 全屏→收起评论区 全链路诊断（--diag <roomId> 模式）
// 走 Viewer 的真实生产路径（did-finish-load 定时器 → 双击全屏/CSS 兜底 → 全屏确认 → 点击收起 → 验证），
// 只负责观测：定时探测页面状态 + 截图，最后输出汇总。用于无人值守自测。
'use strict';

const { BrowserWindow, app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Viewer } = require('./viewer');
const { log } = require('./applog');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE_JS = `(() => {
  const out = { vw: window.innerWidth, vh: window.innerHeight, href: location.href.slice(0, 90) };
  const b = document.body;
  out.fsClass = b ? b.classList.contains('player-full-win') : null;
  const a = document.querySelector('.aside-area');
  out.aside = 'not-mounted';
  if (a) {
    const rc = a.getBoundingClientRect();
    out.asideRect = [Math.round(rc.left), Math.round(rc.top), Math.round(rc.width), Math.round(rc.height)];
    out.aside = (rc.width <= 0 || rc.height <= 0) ? 'hidden' : 'visible';
  }
  const btnEl = document.querySelector('button[class~="restore-btn"]');
  out.btn = null;
  if (btnEl) {
    const rc = btnEl.getBoundingClientRect();
    out.btn = { rect: [Math.round(rc.left), Math.round(rc.top), Math.round(rc.width), Math.round(rc.height)], dpNone: btnEl.classList.contains('dp-none'), cls: String(btnEl.className).slice(0, 70) };
  }
  const p = document.querySelector('.player-ctnr') || document.querySelector('#player-ctnr');
  out.player = null;
  if (p) {
    const rc = p.getBoundingClientRect();
    out.player = [Math.round(rc.left), Math.round(rc.top), Math.round(rc.width), Math.round(rc.height)];
  }
  out.allRestoreBtns = [...document.querySelectorAll('button')].filter((x) => /restore/i.test(String(x.className || ''))).map((x) => String(x.className).slice(0, 60));
  out.videos = [...document.querySelectorAll('video')].map((v) => ({ paused: v.paused, w: v.videoWidth }));
  return out;
})()`;

async function runDiag(roomId) {
  roomId = String(roomId || '').trim();
  if (!roomId) { console.error('DIAG:FATAL 缺少房间号'); return 1; }
  const outDir = path.join(app.getPath('userData'), '..', 'diag');
  fs.mkdirSync(outDir, { recursive: true });
  log('DIAG', '开始', roomId, 'userData=' + app.getPath('userData'));

  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 960, minHeight: 600, show: true,
    title: 'diag - 全屏收起评论区诊断', backgroundColor: '#14141a',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.setPosition(60, 60);

  const viewer = new Viewer(win, { sidebarW: 280 });
  viewer.openRoom(roomId, { unmute: true });
  const r = viewer.rooms.get(roomId);
  const wc = r.view.webContents;

  // 等待页面加载完成
  await Promise.race([
    new Promise((res) => wc.once('did-finish-load', res)),
    sleep(30000),
  ]);
  log('DIAG', '页面加载完成', roomId, 'isLoading=' + wc.isLoading());

  // 定时探测：t 秒为加载完成后的相对时间
  const probeAt = [1, 3, 5, 8, 12, 16, 20, 25, 30, 35, 40];
  for (const t of probeAt) {
    await sleep((t - (probeAt[probeAt.indexOf(t) - 1] || 0)) * 1000);
    let data = null;
    try { data = await wc.executeJavaScript(PROBE_JS, true); } catch (e) { data = { error: String(e && e.message || e) }; }
    const rec = viewer.rooms.get(roomId) || {};
    log('DIAG', roomId, 't=' + t, JSON.stringify(data), 'flags=' + JSON.stringify({ webFullscreen: rec.webFullscreen, trueFullscreen: rec.trueFullscreen, chatHidden: rec.chatHidden, chatAutoTries: rec.chatAutoTries, chatUserToggled: rec.chatUserToggled }));
    if ([8, 16, 30, 40].includes(t)) {
      try {
        const img = await wc.capturePage();
        fs.writeFileSync(path.join(outDir, `diag-${roomId}-t${t}.png`), img.toPNG());
        log('DIAG', '截图已保存', roomId, 't=' + t);
      } catch (e) { log('DIAG', '截图失败 t=' + t, String(e && e.message || e)); }
    }
  }

  const finalRec = viewer.rooms.get(roomId) || {};
  let finalState = null;
  try { finalState = await wc.executeJavaScript(PROBE_JS, true); } catch {}
  log('DIAG', '汇总', roomId, JSON.stringify({ rec: finalRec, page: finalState }));
  try { fs.writeFileSync(path.join(outDir, 'DONE.txt'), 'DONE ' + new Date().toISOString() + '\n'); } catch {}
  viewer.destroyAll();
  win.destroy();
  return 0;
}

module.exports = { runDiag };
