// modules/updater.js —— GitHub Release 更新检查：发现新版本弹窗，点击“更新”直接下载并显示进度
'use strict';
const { app, dialog, shell, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { log } = require('./applog');

const REPO_API_DIRECT = 'https://api.github.com/repos/xingxuan410/yujiu-multilive/releases/latest';
const API_URLS = [
  REPO_API_DIRECT,
  'https://ghfast.top/' + REPO_API_DIRECT,
  'https://gh-proxy.com/' + REPO_API_DIRECT,
  'https://ghproxy.net/' + REPO_API_DIRECT,
];
const DOWNLOAD_PROXIES = ['https://ghfast.top/', 'https://gh-proxy.com/', 'https://ghproxy.net/'];

function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((x) => parseInt(x || '0', 10));
  const pb = String(b || '').replace(/^v/i, '').split('.').map((x) => parseInt(x || '0', 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function createProgressWindow() {
  const win = new BrowserWindow({
    width: 400, height: 140, frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, '..', 'resource', 'update-progress.html'));
  return win;
}

function updateProgress(win, pct, doneBytes, totalBytes, mirror) {
  try {
    if (win && !win.isDestroyed()) {
      const doneKB = doneBytes == null ? null : Math.round(doneBytes / 1024);
      const totalKB = totalBytes == null ? null : Math.round(totalBytes / 1024);
      win.webContents.executeJavaScript(`window.setProgress(${pct === null ? 'null' : pct}, ${doneKB == null ? 'null' : doneKB}, ${totalKB == null ? 'null' : totalKB}, ${JSON.stringify(mirror || '')})`);
    }
  } catch (_) {}
}

async function downloadToFile(url, dest, win, totalBytes, mirror) {
  const res = await fetch(url, { headers: { 'User-Agent': 'yujiu-ultilive' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const contentLength = Number(res.headers.get('content-length')) || totalBytes || 0;
  const reader = Readable.fromWeb(res.body);
  const out = fs.createWriteStream(dest);
  let done = 0;
  let lastPct = -1;
  reader.on('data', (chunk) => {
    done += chunk.length;
    const pct = contentLength ? Math.min(1, done / contentLength) : null;
    if (pct === null || Math.floor(pct * 50) !== lastPct) {
      lastPct = pct === null ? 0 : Math.floor(pct * 50);
      updateProgress(win, pct, done, contentLength, mirror);
    }
  });
  await pipeline(reader, out);
  updateProgress(win, 1, done, contentLength, mirror);
}

async function downloadUpdate(rel, mainWin) {
  const asset = (rel.assets || []).find((a) => /portable\.exe$/i.test(a.name || ''));
  if (!asset) {
    const { response } = await dialog.showMessageBox(mainWin, {
      type: 'warning',
      title: '暂无可下载的便携包',
      message: '新版本已发布，但便携包还没上传完成',
      detail: '请稍后重新启动应用再试。',
      buttons: ['打开发布页面', '关闭'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) shell.openExternal(rel.html_url);
    return;
  }
  const exeDir = app.isPackaged
    ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath))
    : path.dirname(process.execPath);
  const dest = path.join(exeDir, asset.name);
  const win = createProgressWindow();
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive();
    // 屏幕右下角显示
    try {
      const { screen } = require('electron');
      const wa = screen.getPrimaryDisplay().workArea;
      win.setPosition(wa.x + wa.width - 400, wa.y + wa.height - 140);
    } catch (_) {}
  });
  try {
    log('UPDATE', '开始下载', asset.name, asset.size || 'unknown', asset.browser_download_url);
    const sources = [{ label: '直连 GitHub', url: asset.browser_download_url }];
    const proxyLabels = ['ghfast 镜像', 'gh-proxy 镜像', 'ghproxy.net 镜像'];
    DOWNLOAD_PROXIES.forEach((p, i) => sources.push({ label: proxyLabels[i] || '代理镜像', url: p + asset.browser_download_url }));
    let lastErr = null;
    for (let i = 0; i < sources.length; i++) {
      try {
        updateProgress(win, null, 0, asset.size || 0, '正在连接：' + sources[i].label);
        await downloadToFile(sources[i].url, dest, win, asset.size, sources[i].label);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        log('UPDATE', '下载源失败，尝试下一个', i + 1 + '/' + sources.length, sources[i].url, String((e && e.message) || e));
      }
    }
    if (lastErr) throw lastErr;
    log('UPDATE', '下载完成', dest);
    if (!win.isDestroyed()) win.close();
    const { response } = await dialog.showMessageBox(mainWin, {
      type: 'info',
      title: '新版本已下载',
      message: `已下载：${asset.name}`,
      detail: `保存在：${dest}\n\n请退出当前程序后双击新版本运行（旧版本可删除）。`,
      buttons: ['打开所在文件夹', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) shell.openPath(exeDir);
  } catch (e) {
    log('UPDATE', '下载失败', String((e && e.message) || e));
    if (!win.isDestroyed()) win.close();
    const { response } = await dialog.showMessageBox(mainWin, {
      type: 'error',
      title: '下载失败',
      message: '自动下载失败',
      detail: `错误：${String((e && e.message) || e)}\n\n可手动前往下载：${rel.html_url}`,
      buttons: ['打开下载页面', '关闭'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) shell.openExternal(rel.html_url);
  }
}

async function checkUpdate(mainWin) {
  try {
    let rel = null;
    for (const url of API_URLS) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'yujiu-ultilive', Accept: 'application/vnd.github+json' },
        });
        if (res.ok) { rel = await res.json(); break; }
      } catch (_) { /* 换下一个镜像 */ }
    }
    if (!rel) return;
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    const current = app.getVersion();
    if (!latest || compareVersions(latest, current) <= 0) return;
    if (mainWin && mainWin.isDestroyed()) mainWin = null;
    const { response } = await dialog.showMessageBox(mainWin, {
      type: 'info',
      title: '发现新版本',
      message: `发现新版本 v${latest}（当前 v${current}）`,
      detail: `${rel.name || ''}\n\n点击“更新”将直接下载新版便携版到当前目录（带进度显示）。`,
      buttons: ['更新', '忽略'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) await downloadUpdate(rel, mainWin);
  } catch (_) {
    // 网络失败/接口不可达时静默忽略，不影响使用
  }
}

module.exports = { checkUpdate, compareVersions };
