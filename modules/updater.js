// modules/updater.js —— GitHub Release 更新检查：发现新版本时弹窗提示
'use strict';
const { app, dialog, shell } = require('electron');

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
      detail: `${rel.name || ''}\n\n${rel.html_url || ''}`,
      buttons: ['去下载', '忽略'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0 && rel.html_url) shell.openExternal(rel.html_url);
  } catch (_) {
    // 网络失败/接口不可达时静默忽略，不影响使用
  }
}

module.exports = { checkUpdate, compareVersions };
