// modules/updater.js —— GitHub Release 更新检查：发现新版本弹窗，点击“更新”自动下载新版便携版 exe
'use strict';
const { app, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { log } = require('./applog');

const REPO_API = 'https://api.github.com/repos/xingxuan410/yujiu-multilive/releases/latest';

function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((x) => parseInt(x || '0', 10));
  const pb = String(b || '').replace(/^v/i, '').split('.').map((x) => parseInt(x || '0', 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function fetchBytes(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'yujiu-ultilive' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    log('UPDATE', '直连下载失败，尝试代理', url, String((e && e.message) || e));
    const proxied = 'https://ghfast.top/' + url;
    const res = await fetch(proxied, { headers: { 'User-Agent': 'yujiu-ultilive' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return Buffer.from(await res.arrayBuffer());
  }
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
  try {
    log('UPDATE', '开始下载', asset.name, asset.size || 'unknown', asset.browser_download_url);
    const buf = await fetchBytes(asset.browser_download_url);
    fs.writeFileSync(dest, buf);
    log('UPDATE', '下载完成', dest, buf.length + ' bytes');
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
    await dialog.showMessageBox(mainWin, {
      type: 'error',
      title: '下载失败',
      message: '自动下载失败',
      detail: `错误：${String((e && e.message) || e)}\n\n可手动前往下载：${rel.html_url}`,
      buttons: ['打开下载页面', '关闭'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => { if (response === 0) shell.openExternal(rel.html_url); });
  }
}

async function checkUpdate(mainWin) {
  try {
    const res = await fetch(REPO_API, {
      headers: { 'User-Agent': 'yujiu-ultilive', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return;
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    const current = app.getVersion();
    if (!latest || compareVersions(latest, current) <= 0) return;
    if (mainWin && mainWin.isDestroyed()) mainWin = null;
    const { response } = await dialog.showMessageBox(mainWin, {
      type: 'info',
      title: '发现新版本',
      message: `发现新版本 v${latest}（当前 v${current}）`,
      detail: `${rel.name || ''}\n\n点击“更新”将自动下载新版便携版到当前目录。`,
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
