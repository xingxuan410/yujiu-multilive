// main.js — 《宇宙人的监控室》主进程装配
const { app, BrowserWindow, ipcMain, Menu, Notification, Tray, nativeImage, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const Store = require('./modules/store');
const { Poller, fetchRoomInfo, fetchUname, parseRoomId } = require('./modules/poller');
const Notifier = require('./modules/notifier');
const { Viewer, SIDEBAR_W } = require('./modules/viewer');

// 托盘图标（16x16 粉色圆点）
const TRAY_ICON_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANklEQVR4nGP4XTSTgRKMS+I/DkzQAFwacRpEjmYUQ6hmAKma4YaMGkBFAwY+HVAlKVMlM5GMAcf+qXvinyHQAAAAAElFTkSuQmCC';

const isSmoke = process.argv.includes('--smoke');
const isDiag = process.argv.includes('--diag');
const isTestOpen = process.argv.includes('--test-open');
const isTestClick = process.argv.includes('--test-click');
const isTestChat = process.argv.includes('--test-chat');
if (process.argv.includes('--no-gpu')) app.disableHardwareAcceleration();
app.setAppUserModelId('com.local.bilimultilive');

// 数据目录：开发模式在项目目录内；打包后的便携版放在你双击的 exe 旁边（electron-builder
// 会解压到临时目录运行，只有 PORTABLE_EXECUTABLE_DIR 才指向 exe 真实位置，登录状态才能保存）
const portableDataRoot = app.isPackaged
  ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath))
  : __dirname;
if (isSmoke) {
  app.setPath('userData', path.join(__dirname, 'smoke-profile'));
} else if (isDiag) {
  // 诊断模式：使用真实资料目录（登录会话），避免匿名会话触发 B 站风控验证码
  app.setPath('userData', process.env.BILI_MULTILIVE_DATA || path.join(portableDataRoot, 'data'));
} else if (isTestOpen || isTestClick || isTestChat) {
  // 自测模式：使用 data 的副本（带登录 Cookie 避开验证码，又不与正在运行的应用抢 profile 锁）
  const tdir = process.env.BILI_MULTILIVE_DATA || path.join(__dirname, 'test-data');
  try {
    if (!fs.existsSync(tdir)) fs.cpSync(path.join(portableDataRoot, 'data'), tdir, { recursive: true });
  } catch (e) { console.error('TEST: profile 副本失败', e); }
  app.setPath('userData', tdir);
} else {
  app.setPath('userData', process.env.BILI_MULTILIVE_DATA || path.join(portableDataRoot, 'data'));
}

// 日志：所有错误写入 data/app.log，便于排查
const { log: appLog } = require('./modules/applog');
process.on('uncaughtException', (err) => { appLog('UNCAUGHT', err); });
process.on('unhandledRejection', (reason) => { appLog('UNHANDLED', reason); });

function clamp(n, min, max) {
  n = Number(n);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

if (isSmoke) {
  const { runSmoke } = require('./modules/smoke');
  app.whenReady()
    .then(() => runSmoke())
    .then((code) => app.exit(code))
    .catch((err) => { console.error('SMOKE:FATAL', err); app.exit(1); });
} else if (isDiag) {
  const { runDiag } = require('./modules/diag-chat');
  const diagRoom = process.argv[process.argv.indexOf('--diag') + 1] || '';
  app.whenReady()
    .then(() => runDiag(diagRoom))
    .then((code) => app.exit(code))
    .catch((err) => { console.error('DIAG:FATAL', err); app.exit(1); });
} else {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    let store = null, poller = null, notifier = null, mainWin = null, viewer = null, tray = null;
    app.isQuiting = false;

    app.on('second-instance', () => {
      if (mainWin) {
        if (mainWin.isMinimized()) mainWin.restore();
        mainWin.show(); mainWin.focus();
      }
    });

    app.whenReady().then(boot).catch((err) => { console.error('[boot]', err); app.quit(); });
    app.on('window-all-closed', () => app.quit());

    function showMainWin() {
      if (!mainWin) return;
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show(); mainWin.focus();
    }

    function createTray() {
      try {
        const trayIconPath = path.join(__dirname, 'resource', 'tray-icon.png');
        let icon = nativeImage.createFromPath(trayIconPath);
        if (icon.isEmpty()) icon = nativeImage.createFromDataURL(TRAY_ICON_DATA); // 兜底
        tray = new Tray(icon);
        tray.setToolTip('宇宙人的监控室');
        tray.setContextMenu(Menu.buildFromTemplate([
          { label: '显示主界面', click: showMainWin },
          { type: 'separator' },
          { label: '退出', click: () => { app.isQuiting = true; app.quit(); } },
        ]));
        tray.on('double-click', showMainWin);
      } catch (e) {
        appLog('TRAY', '创建托盘失败', e);
      }
    }

    function nameOfRoom(roomId) {
      const s = store.data.streamers.find((x) => x.roomId === roomId);
      return (s && s.name) || `房间${roomId}`;
    }

    function broadcastRooms() {
      if (!mainWin || mainWin.isDestroyed()) return;
      mainWin.webContents.send('rooms:change',
        viewer.snapshot().map((r) => ({ ...r, name: nameOfRoom(r.roomId) })));
    }

    function createMainWindow() {
      mainWin = new BrowserWindow({
        width: 1280, height: 820, minWidth: 960, minHeight: 600,
        title: '宇宙人的监控室', backgroundColor: '#14141a', show: false,
        icon: path.join(__dirname, 'resource', 'app-icon.png'),
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true, nodeIntegration: false,
        },
      });
      mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
      mainWin.once('ready-to-show', () => mainWin.show());
      mainWin.webContents.once('did-finish-load', () => {
        mainWin.webContents.send('state:change', store.data);
        broadcastRooms();
      });
      // 关闭按钮：设置开启时最小化到托盘，否则直接退出
      mainWin.on('close', (e) => {
        const minimizeToTray = !!store.getSettings().minimizeToTray;
        if (minimizeToTray && !app.isQuiting) {
          e.preventDefault();
          mainWin.hide();
        }
      });
      mainWin.on('closed', () => { mainWin = null; viewer = null; });
      mainWin.on('resize', () => { if (viewer) viewer.layout(); });
      viewer = new Viewer(mainWin, {
        sidebarW: store.getSettings().sidebarCollapsed ? 34 : SIDEBAR_W,
        onActive: (roomId) => { // 点击某路画面时通知渲染层（快捷开关作用于该直播间）
          try {
            if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('rooms:active', String(roomId));
          } catch {}
        },
        onStateChange: () => broadcastRooms(), // 自动收起/全屏状态变化 → 同步渲染层（💬 按钮等）
      });
    }

    function notifyWentLive(st, info) {
      const settings = store.getSettings();
      if (settings.enableNotify === false) return; // 开播通知总开关
      notifier.show({
        roomId: st.roomId, name: st.name,
        title: info.title || '开播啦', area: info.areaName || '', cover: info.cover || '',
        durationMs: clamp(settings.popupDurationSec, 3, 60) * 1000,
      });
      if (settings.systemNotification) {
        try {
          new Notification({ title: `${st.name} 开播了`, body: info.title || '' }).show();
        } catch {}
      }
    }

    function registerIpc() {
      const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => {
        try { return { ok: true, ...(await fn(...args)) }; }
        catch (err) { appLog('IPC', ch, err); return { ok: false, error: String((err && err.message) || err) }; }
      });

      handle('state:get', () => ({ data: store.data }));
      handle('streamer:resolve', async (input) => {
        const roomId = parseRoomId(String(input || ''));
        if (!roomId) throw new Error('无法识别直播间号，请输入直播间链接或房间号');
        const info = await fetchRoomInfo(roomId);
        if (info.uid != null) {
          const uname = await fetchUname(info.uid);
          if (uname) info.name = uname;
        }
        return { info };
      });
      handle('streamer:add', (p) => {
        const roomId = String(p.roomId || '').trim();
        if (!roomId) throw new Error('房间号不能为空');
        const streamer = store.addStreamer({
          roomId,
          name: String(p.name || '').trim() || `房间${roomId}`,
          groupId: p.groupId || null,
        });
        // 修复尝试：新增后立即刷新开播状态并补位预热池，避免需要重启才能正常观看
        try { if (poller) poller.pollNow(); } catch (_) {}
        try { refillPool(); } catch (_) {}
        return { streamer };
      });
      handle('streamer:remove', (id) => { store.removeStreamer(id); return {}; });
      handle('streamer:rename', (p) => { store.renameStreamer(p.id, p.name); return {}; });
      handle('streamer:move', (p) => { store.moveStreamer(p.id, p.groupId || null); return {}; });
      handle('group:add', (name) => ({ group: store.addGroup(name) }));
      handle('group:remove', (id) => { store.removeGroup(id); return {}; });
      handle('group:rename', (p) => { store.renameGroup(p.id, p.name); return {}; });
      handle('settings:set', (patch) => { store.setSettings(patch || {}); return { settings: store.getSettings() }; });
      handle('room:open', (roomId) => {
        if (!String(roomId || '')) throw new Error('房间号不能为空');
        const res = viewer.openRoom(String(roomId));
        store.touchRecent(String(roomId)); // 记录最近打开，供下次启动预热
        broadcastRooms();
        if (res && res.cached) refillPool(); // 从池里调到前台 → 自动补位
        return {};
      });
      handle('room:close', (roomId) => { viewer.closeRoom(String(roomId)); broadcastRooms(); return {}; });
      handle('room:mute', (p) => { viewer.setMute(String(p.roomId), !!p.muted); broadcastRooms(); return {}; });
      handle('room:toggle-chat', async (roomId) => {
        const r = await viewer.toggleChat(String(roomId));
        broadcastRooms();
        return r;
      });
      handle('room:focus', (roomId) => { viewer.focusRoom(String(roomId)); return {}; });
      handle('ui:overlay', (show) => { viewer.setOverlay(!!show); return {}; });
      handle('notify:test', () => {
        const s = store.getSettings();
        notifier.show({
          roomId: '', name: '测试主播', title: '这是一条测试开播通知',
          area: '测试分区', cover: '',
          durationMs: clamp(s.popupDurationSec, 3, 60) * 1000,
        });
        return {};
      });
    }

    // —— 预热队列：只预热“直播中”的主播；被调到前台后自动补位下一个 ——
    let prewarmBusy = false;
    const prewarmQueue = [];

    function enqueuePrewarm(rids) {
      for (const rid of rids) {
        const r = String(rid);
        if (r && !prewarmQueue.includes(r)) prewarmQueue.push(r);
      }
      pumpPrewarm();
    }

    function pumpPrewarm() {
      if (prewarmBusy || !viewer) return;
      const next = prewarmQueue.shift();
      if (!next) return;
      if (viewer.rooms.has(next) || viewer.pool.has(next) || viewer.pool.size >= 9) {
        pumpPrewarm();
        return;
      }
      prewarmBusy = true;
      try { viewer.prewarmRoom(next); } catch (e) { appLog('PREWARM', '失败', next, e); }
      setTimeout(() => { prewarmBusy = false; pumpPrewarm(); }, 600); // 错峰
    }

    // 重新计算预热队列：①直播中的优先 ②按左侧列表从上到下排序；羽啾（置顶）始终在列
    function refillPool() {
      try {
        if (store.getSettings().prewarmOnStartup === false || !viewer) return;
        const PINNED_ROOM = '1727074031'; // 羽啾
        const inUse = new Set([...viewer.rooms.keys(), ...viewer.pool.keys()]);
        const sidebarSort = (arr) => arr.slice().sort((a, b) => {
          const pa = a.roomId === PINNED_ROOM ? 0 : 1;
          const pb = b.roomId === PINNED_ROOM ? 0 : 1;
          if (pa !== pb) return pa - pb;
          const la = a.isLive ? 0 : (a.liveStatus === 2 ? 1 : 2);
          const lb = b.isLive ? 0 : (b.liveStatus === 2 ? 1 : 2);
          return la - lb;
        });
        // 侧边栏从上到下的完整顺序（分组顺序 + 未分组最后）
        const ordered = [];
        for (const g of store.data.groups) {
          ordered.push(...sidebarSort(store.data.streamers.filter((s) => s.groupId === g.id)));
        }
        ordered.push(...sidebarSort(store.data.streamers.filter((s) => !s.groupId)));

        const targets = [];
        // 第一轮：直播中的，按侧边栏顺序
        ordered.filter((s) => s.isLive && !inUse.has(s.roomId)).forEach((s) => targets.push(s.roomId));
        // 第二轮：羽啾（未开播也预热，若不在第一轮中）
        if (!targets.includes(PINNED_ROOM) && ordered.some((s) => s.roomId === PINNED_ROOM) && !inUse.has(PINNED_ROOM)) {
          targets.push(PINNED_ROOM);
        }
        if (targets.length) {
          appLog('PREWARM', '补位队列', targets.join(','));
          enqueuePrewarm(targets);
        }
      } catch (e) {
        appLog('PREWARM', '补位调度异常', e);
      }
    }

    function boot() {
      store = new Store(path.join(app.getPath('userData'), 'data.json'));
      const settings = store.getSettings();
      poller = new Poller(store, { intervalMs: clamp(settings.pollIntervalSec, 10, 600) * 1000 });
      notifier = new Notifier();
      notifier.onOpen = (roomId) => { if (viewer && roomId) viewer.openRoom(roomId, { unmute: true }); };
      poller.on('wentLive', (st, info) => {
        store.updateStreamer(st.id, { notified: true });
        enqueuePrewarm([st.roomId]); // 新开播的主播自动排队进池
        notifyWentLive(st, info);
      });
      poller.on('wentOffline', (st) => store.updateStreamer(st.id, { notified: false }));
      poller.on('error', (st, msg) => appLog('POLLER', '轮询异常 房间' + (st && st.roomId), msg));
      store.on('change', (data) => {
        if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('state:change', data);
        poller.setInterval(clamp(data.settings.pollIntervalSec, 10, 600) * 1000);
        if (viewer) {
          const w = data.settings.sidebarCollapsed ? 34 : SIDEBAR_W;
          viewer.sidebarW = w;
          viewer.layout();
          // 防御：渲染层侧边栏宽度有 0.18s 过渡，过渡结束后再重排一次，避免出现黑框残影
          setTimeout(() => { try { viewer.layout(); } catch (_) {} }, 220);
        }
        broadcastRooms();
      });
      Menu.setApplicationMenu(null);
      createTray();
      createMainWindow();
      registerIpc();
      poller.start();
      refillPool(); // 启动即刻预热
      setTimeout(refillPool, 5000); // 轮询首轮完成后补一轮
      if (isTestOpen) {
        // 自测模式：启动后自动打开指定直播间（等价于点击侧边栏），走真实全屏→收起评论区流程
        const rid = process.argv[process.argv.indexOf('--test-open') + 1] || '';
        setTimeout(() => {
          try {
            if (mainWin) {
              const wa = screen.getPrimaryDisplay().workArea;
              mainWin.show();
              mainWin.setSize(3100, 2250); // 复现用户最大化窗口的视口（vw≈2820）
              mainWin.setPosition(wa.x + Math.max(0, wa.width - 1400), wa.y + Math.max(0, wa.height - 850)); // 屏幕右下角（注入输入需要窗口可见+聚焦）
              mainWin.focus();
            }
            appLog('TEST', '自动打开直播间', rid, 'session=' + (process.env.SESSIONNAME || '?'));
            const res = viewer.openRoom(String(rid), { unmute: true });
            broadcastRooms();
            appLog('TEST', '自动打开完成', JSON.stringify(res));
          } catch (e) { appLog('TEST', '自动打开失败', e); }
        }, 2500);
        // 定时探测页面状态（与 diag 同款探针），并写完成标记
        const PROBE_JS = `(() => { const out = { vw: window.innerWidth, vh: window.innerHeight, href: location.href.slice(0, 90) }; const b = document.body; out.fsClass = b ? b.classList.contains('player-full-win') : null; const a = document.querySelector('.aside-area'); out.aside = 'not-mounted'; if (a) { const rc = a.getBoundingClientRect(); out.asideRect = [Math.round(rc.left), Math.round(rc.top), Math.round(rc.width), Math.round(rc.height)]; out.asideCls = String(a.className).slice(0, 80); out.aside = (rc.width <= 0 || rc.height <= 0) ? 'hidden' : 'visible'; out.asideTransform = getComputedStyle(a).transform; } const tg = document.querySelector('div[class~="aside-area-toggle-btn"]'); out.toggleBtn = null; if (tg) { const rc = tg.getBoundingClientRect(); out.toggleBtn = { rect: [Math.round(rc.left), Math.round(rc.top), Math.round(rc.width), Math.round(rc.height)], dpNone: tg.classList.contains('dp-none'), cls: String(tg.className).slice(0, 70) }; } const btnEl = document.querySelector('button[class~="restore-btn"]'); out.btn = null; if (btnEl) { const rc = btnEl.getBoundingClientRect(); out.btn = { rect: [Math.round(rc.left), Math.round(rc.top), Math.round(rc.width), Math.round(rc.height)], dpNone: btnEl.classList.contains('dp-none'), cls: String(btnEl.className).slice(0, 70) }; const cx = Math.round(rc.left + rc.width / 2), cy = Math.round(rc.top + rc.height / 2); out.atBtnPoint = document.elementsFromPoint(cx, cy).slice(0, 8).map((el) => el.tagName + '|' + String(el.className || '').slice(0, 60)); } out.pointerEls = [...document.querySelectorAll('.aside-area *')].filter((el) => { try { return getComputedStyle(el).cursor === 'pointer'; } catch (_) { return false; } }).slice(0, 25).map((el) => { const r = el.getBoundingClientRect(); return el.tagName + '|' + String(el.className || '').slice(0, 55) + '|' + Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.left) + ',' + Math.round(r.top); }); const p = document.querySelector('.player-ctnr') || document.querySelector('#player-ctnr'); out.player = null; if (p) { const rc = p.getBoundingClientRect(); out.player = [Math.round(rc.left), Math.round(rc.top), Math.round(rc.width), Math.round(rc.height)]; } out.videos = [...document.querySelectorAll('video')].map((v) => ({ paused: v.paused, w: v.videoWidth })); out.hasFocus = document.hasFocus(); return out; })()`;
        const probeRoom = async () => {
          try {
            const rec = viewer.rooms.get(String(rid));
            if (!rec || rec.view.webContents.isDestroyed()) return;
            const data = await rec.view.webContents.executeJavaScript(PROBE_JS, true);
            appLog('TEST', 'probe', rid, JSON.stringify(data), 'flags=' + JSON.stringify({ webFullscreen: rec.webFullscreen, trueFullscreen: rec.trueFullscreen, chatHidden: rec.chatHidden, chatAutoTries: rec.chatAutoTries, fsRetries: rec.fsRetries }));
          } catch (e) { appLog('TEST', 'probe失败', String(e && e.message || e)); }
        };
        [6000, 12000, 20000, 30000, 40000].forEach((ms) => setTimeout(probeRoom, ms));
        // 悬停扫描：评论区左边界不同偏移量逐一真实悬停，找出页面「自己」把蓝色按钮淡入（dp-none 消失）的区域
        const hoverSweep = async (tag) => {
          try {
            const rec = viewer.rooms.get(String(rid));
            if (!rec || rec.view.webContents.isDestroyed()) return;
            const wc = rec.view.webContents;
            const edge = await wc.executeJavaScript(`(() => { const a = document.querySelector('.aside-area'); if (!a) return null; const rc = a.getBoundingClientRect(); return { left: Math.round(rc.left), top: Math.round(rc.top), h: Math.round(rc.height) }; })()`).catch(() => null);
            if (!edge || edge.h <= 0) { appLog('TEST', 'hover', tag, 'aside 不可用'); return; }
            const y = edge.top + Math.min(Math.round(edge.h / 2), 500);
            for (const dx of [-10, -6, -4, -2, 0, 2, 6]) {
              const x = edge.left + dx;
              wc.sendInputEvent({ type: 'mouseMove', x, y });
              await new Promise((res) => setTimeout(res, 800));
              const st = await wc.executeJavaScript(`(() => { const btn = document.querySelector('button[class~="restore-btn"]'); const out = { dx: ${dx}, x: ${x}, y: ${y}, els: document.elementsFromPoint(${x}, ${y}).slice(0, 5).map((el) => el.tagName + '|' + String(el.className || '').slice(0, 50)) }; out.btnDpNone = btn ? btn.classList.contains('dp-none') : null; out.btnCls = btn ? String(btn.className).slice(0, 60) : null; out.btnRect = null; if (btn) { const r = btn.getBoundingClientRect(); out.btnRect = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; } return out; })()`).catch(() => null);
              appLog('TEST', 'hover', tag, JSON.stringify(st));
            }
          } catch (e) { appLog('TEST', 'hover失败', tag, String(e && e.message || e)); }
        };
        setTimeout(() => hoverSweep('s1'), 9000);
        setTimeout(() => hoverSweep('s2'), 23000);
        setTimeout(() => {
          try {
            fs.mkdirSync(path.join(__dirname, 'diag'), { recursive: true });
            fs.writeFileSync(path.join(__dirname, 'diag', 'DONE.txt'), 'DONE ' + new Date().toISOString() + '\n');
          } catch {}
        }, 45000);
        setTimeout(() => { try { viewer.destroyAll(); } catch {} app.exit(0); }, 55000); // 自测结束自动退出
      }

      if (isTestClick) {
        // 点击实验模式：关闭自动收起，验证页面自身 el.click() 与注入点击在「原生淡入」状态下能否收起评论区
        const rid2 = process.argv[process.argv.indexOf('--test-click') + 1] || '';
        setTimeout(() => {
          try {
            if (mainWin) {
              const wa = screen.getPrimaryDisplay().workArea;
              mainWin.show();
              mainWin.setPosition(wa.x + Math.max(0, wa.width - 1300), wa.y + Math.max(0, wa.height - 840)); // 屏幕右下角，短暂可见
            }
            viewer.autoCollapse = false; // 关闭自动收起，避免干扰实验
            viewer.openRoom(String(rid2), { unmute: true });
            broadcastRooms();
            appLog('TEST', 'click实验 打开', rid2, 'session=' + (process.env.SESSIONNAME || '?'));
          } catch (e) { appLog('TEST', 'click实验打开失败', String(e && e.message || e)); }
        }, 2500);
        const cSleep = (ms) => new Promise((res) => setTimeout(res, ms));
        const runClickExperiment = async () => {
          try {
            const rec = viewer.rooms.get(String(rid2));
            if (!rec || rec.view.webContents.isDestroyed()) { appLog('TEST', 'click实验 房间不可用'); return; }
            const wc = rec.view.webContents;
            // -1) 输入事件是否到达页面（计数探针）；先给窗口/页面焦点（--test-nofocus 时故意不给）
            if (!process.argv.includes('--test-nofocus')) { try { if (mainWin) { mainWin.show(); mainWin.focus(); } wc.focus(); } catch {} }
            await cSleep(500);
            appLog('TEST', 'click实验 聚焦状态', rid2, JSON.stringify({ winFocused: mainWin ? mainWin.isFocused() : null, pageFocus: await wc.executeJavaScript('document.hasFocus()').catch(() => null) }));
            await wc.executeJavaScript(`(() => { window.__mm = 0; window.__md = 0; window.__mc = 0; window.addEventListener('mousemove', () => window.__mm++); window.addEventListener('mousedown', () => window.__md++); window.addEventListener('click', () => window.__mc++); })()`).catch(() => {});
            wc.sendInputEvent({ type: 'mouseMove', x: 400, y: 400 });
            wc.sendInputEvent({ type: 'mouseDown', x: 400, y: 400, button: 'left', clickCount: 1 });
            wc.sendInputEvent({ type: 'mouseUp', x: 400, y: 400, button: 'left', clickCount: 1 });
            await cSleep(500);
            const counts = await wc.executeJavaScript(`({ mm: window.__mm, md: window.__md, mc: window.__mc })`).catch(() => null);
            appLog('TEST', 'click实验 输入事件计数', rid2, JSON.stringify(counts));
            // 0) Vue 组件树 dump
            const vueDump = await wc.executeJavaScript(`(() => {
              const out = [];
              let el = document.querySelector('.aside-area');
              for (let i = 0; el && i < 6; i++) {
                const v = el.__vue__;
                if (v) {
                  const methods = (v.$options && v.$options.methods) ? Object.keys(v.$options.methods) : [];
                  out.push({ depth: i, name: (v.$options && v.$options.name) || '', tag: el.tagName, cls: String(el.className || '').slice(0, 50), methods: methods.slice(0, 40) });
                }
                el = el.parentElement;
              }
              return out;
            })()`).catch((e) => ({ err: String(e && e.message || e) }));
            appLog('TEST', 'click实验 vue树', rid2, JSON.stringify(vueDump));
            // 1) 悬停触发页面原生淡入
            const edge = await wc.executeJavaScript(`(() => { const a = document.querySelector('.aside-area'); if (!a) return null; const ar = a.getBoundingClientRect(); if (ar.width <= 0) return null; return { x: Math.max(0, Math.round(ar.left - 10)), y: Math.round(ar.top + Math.max(10, ar.height / 2)) }; })()`).catch(() => null);
            if (edge) { wc.sendInputEvent({ type: 'mouseMove', x: edge.x, y: edge.y }); await cSleep(700); }
            const st0 = await wc.executeJavaScript(`(() => { const a = document.querySelector('.aside-area'); const rc = a ? a.getBoundingClientRect() : null; const tg = document.querySelector('div[class~="aside-area-toggle-btn"]'); const sl = document.querySelector('div[class~="btn-slider"]'); return { asideW: rc ? Math.round(rc.width) : null, tg: tg ? { dpNone: tg.classList.contains('dp-none'), w: Math.round(tg.getBoundingClientRect().width), h: Math.round(tg.getBoundingClientRect().height) } : null, sl: sl ? { dpNone: sl.classList.contains('dp-none'), w: Math.round(sl.getBoundingClientRect().width), h: Math.round(sl.getBoundingClientRect().height) } : null }; })()`).catch(() => null);
            appLog('TEST', 'click实验 悬停后', rid2, JSON.stringify(st0));
            // 2) 页面自己的 .click()（非注入）
            const clickRes = await wc.executeJavaScript(`(() => {
              const tg = document.querySelector('div[class~="aside-area-toggle-btn"]');
              if (!tg) return { err: 'no-toggle' };
              const a0 = document.querySelector('.aside-area');
              tg.click();
              const a1 = document.querySelector('.aside-area');
              const rc = a1 ? a1.getBoundingClientRect() : null;
              return { clicked: true, asideWBefore: a0 ? Math.round(a0.getBoundingClientRect().width) : null, asideWAfter: rc ? Math.round(rc.width) : null };
            })()`).catch((e) => ({ err: String(e && e.message || e) }));
            appLog('TEST', 'click实验 el.click', rid2, JSON.stringify(clickRes));
            await cSleep(900);
            const st1 = await wc.executeJavaScript(`(() => { const a = document.querySelector('.aside-area'); const rc = a ? a.getBoundingClientRect() : null; const hp = document.querySelector('.chat-history-panel'); const cp = document.querySelector('.chat-control-panel'); return { asideW: rc ? Math.round(rc.width) : null, asideDisplay: a ? getComputedStyle(a).display : null, historyDisplay: hp ? getComputedStyle(hp).display : null, controlDisplay: cp ? getComputedStyle(cp).display : null, bodyFs: document.body ? document.body.classList.contains('player-full-win') : null }; })()`).catch(() => null);
            appLog('TEST', 'click实验 el.click后', rid2, JSON.stringify(st1));
            // 3) 注入点击 btn-slider 对照
            const sl = await wc.executeJavaScript(`(() => { const el = document.querySelector('div[class~="btn-slider"]'); if (!el) return null; const rc = el.getBoundingClientRect(); return { x: Math.round(rc.left + rc.width / 2), y: Math.round(rc.top + rc.height / 2) }; })()`).catch(() => null);
            if (sl && sl.x > 0 && sl.y > 0) {
              wc.sendInputEvent({ type: 'mouseMove', x: sl.x, y: sl.y });
              await cSleep(250);
              wc.sendInputEvent({ type: 'mouseDown', x: sl.x, y: sl.y, button: 'left', clickCount: 1 });
              await cSleep(80);
              wc.sendInputEvent({ type: 'mouseUp', x: sl.x, y: sl.y, button: 'left', clickCount: 1 });
              await cSleep(900);
              const st2 = await wc.executeJavaScript(`(() => { const a = document.querySelector('.aside-area'); const rc = a ? a.getBoundingClientRect() : null; return { asideW: rc ? Math.round(rc.width) : null }; })()`).catch(() => null);
              appLog('TEST', 'click实验 注入slider后', rid2, JSON.stringify(st2));
            } else { appLog('TEST', 'click实验 slider坐标不可用', rid2, JSON.stringify(sl)); }
            fs.mkdirSync(path.join(__dirname, 'diag'), { recursive: true });
            fs.writeFileSync(path.join(__dirname, 'diag', 'DONE.txt'), 'DONE ' + new Date().toISOString() + '\n');
          } catch (e) { appLog('TEST', 'click实验异常', String(e && e.stack || e)); }
        };
        setTimeout(() => { try { runClickExperiment(); } catch {} }, 9000);
        setTimeout(() => {
          try {
            fs.mkdirSync(path.join(__dirname, 'diag'), { recursive: true });
            fs.writeFileSync(path.join(__dirname, 'diag', 'DONE.txt'), 'DONE ' + new Date().toISOString() + '\n');
          } catch {}
        }, 28000); // 兜底完成标记
        setTimeout(() => { try { viewer.destroyAll(); } catch {} app.exit(0); }, 30000);
      }

      if (isTestChat) {
        // 评论区功能自测（原生逻辑，支持多房间并发场景）：
        // --test-chat <主房间> [更多房间...]
        // ① 同时打开多个直播房间（复现真实使用中并发抢焦点的问题）
        // ② 每个房间都应：原生网页全屏 + 评论区隐藏
        // ③ 主房间验证 💬 手动展开/收起，全程不退出全屏
        const chatArgs = process.argv.slice(process.argv.indexOf('--test-chat') + 1).filter((x) => x && !x.startsWith('--'));
        const rid3 = chatArgs[0] || '';
        const extraRids = chatArgs.slice(1);
        let pass = false;
        const domState = async (rid) => {
          try {
            const rec = viewer.rooms.get(String(rid));
            if (!rec || rec.view.webContents.isDestroyed()) return { aside: 'error', fsClass: false };
            return await rec.view.webContents.executeJavaScript(
              `(() => {
                const a = document.querySelector('.aside-area');
                let aside = 'not-mounted';
                if (a) { const rc = a.getBoundingClientRect(); const cs = getComputedStyle(a); const vw = window.innerWidth, vh = window.innerHeight; aside = (rc.width > 0 && rc.height > 0 && cs.display !== 'none' && rc.right > 0 && rc.left < vw && rc.bottom > 0 && rc.top < vh) ? 'visible' : 'hidden'; }
                return { aside, fsClass: document.body ? document.body.classList.contains('player-full-win') : false };
              })()`
            ).catch((e) => ({ aside: 'error:' + (e && e.message), fsClass: false }));
          } catch (e) { return { aside: 'error:' + (e && e.message), fsClass: false }; }
        };
        const runChatTest = async () => {
          let autoState = { aside: 'pending', fsClass: false };
          let s1 = { aside: 'n/a', fsClass: false };
          let s2 = { aside: 'n/a', fsClass: false };
          const extraStates = {};
          try {
            if (mainWin) { mainWin.show(); mainWin.focus(); }
            const roomIds = [rid3, ...extraRids].filter(Boolean);
            for (const rid of roomIds) {
              const res = viewer.openRoom(String(rid), { unmute: true });
              appLog('CHAT-TEST', '打开房间', rid, JSON.stringify(res));
              await new Promise((r) => setTimeout(r, 600));
            }
            broadcastRooms();
            for (let i = 0; i < 60; i++) {
              await new Promise((r) => setTimeout(r, 1000));
              const rec = viewer.rooms.get(String(rid3));
              if (rec && rec.chatHidden) break;
            }
            await new Promise((r) => setTimeout(r, 3000)); // 等原生全屏过渡完成
            autoState = await domState(rid3);
            appLog('CHAT-TEST', '主房间自动收起结果', JSON.stringify(autoState));
            for (const rid of extraRids) { extraStates[rid] = await domState(rid); }
            appLog('CHAT-TEST', '其余房间自动收起结果', JSON.stringify(extraStates));
            let toggleEnabled = false;
            try {
              const rec = viewer.rooms.get(String(rid3));
              if (rec && !rec.view.webContents.isDestroyed()) {
                const vw = await rec.view.webContents.executeJavaScript('window.innerWidth').catch(() => 0);
                toggleEnabled = vw >= 680; // 小网格里 B 站把评论按钮布局到视口外，原生点击不可达
                appLog('CHAT-TEST', '手动切换可用性', JSON.stringify({ vw, toggleEnabled }));
              }
            } catch (_) {}
            if (toggleEnabled) {
              const t1 = await viewer.toggleChat(String(rid3));
              await new Promise((r) => setTimeout(r, 1500));
              s1 = await domState(rid3);
              appLog('CHAT-TEST', '手动展开', JSON.stringify(t1), 'DOM=' + JSON.stringify(s1));
              const t2 = await viewer.toggleChat(String(rid3));
              await new Promise((r) => setTimeout(r, 3000)); // 等收起动画完成
              s2 = await domState(rid3);
              appLog('CHAT-TEST', '手动收起', JSON.stringify(t2), 'DOM=' + JSON.stringify(s2));
            } else {
              s1 = { aside: 'grid-skip', fsClass: null };
              s2 = { aside: 'grid-skip', fsClass: null };
              appLog('CHAT-TEST', '网格窗口过窄，跳过手动展开/收起验证');
            }
            const extrasOk = extraRids.length === 0 || extraRids.every((rid) => extraStates[rid] && extraStates[rid].aside === 'hidden');
            pass = autoState.aside === 'hidden' && autoState.fsClass === true
              && extrasOk
              && (toggleEnabled
                ? (s1.aside === 'visible' && s1.fsClass === true && s2.aside === 'hidden' && s2.fsClass === true)
                : true);
            appLog('CHAT-TEST', '结论', pass ? 'PASS' : 'FAIL', JSON.stringify({ autoState, extraStates, s1, s2 }));
          } catch (e) {
            appLog('CHAT-TEST', '异常', String((e && e.stack) || e));
          } finally {
            try {
              fs.mkdirSync(path.join(__dirname, 'diag'), { recursive: true });
              fs.writeFileSync(path.join(__dirname, 'diag', 'CHAT-DONE.txt'),
                (pass ? 'PASS' : 'FAIL') + ' ' + new Date().toISOString() +
                ' auto=' + JSON.stringify(autoState) + ' extras=' + JSON.stringify(extraStates) +
                ' expand=' + JSON.stringify(s1) + ' collapse=' + JSON.stringify(s2) + '\n');
            } catch (_) {}
            setTimeout(() => { try { viewer.destroyAll(); } catch (_) {} app.exit(pass ? 0 : 1); }, 2000);
          }
        };
        const openDelay = Number(process.env.CHAT_TEST_OPEN_DELAY_MS) || 2500;
        setTimeout(() => { try { runChatTest(); } catch (_) {} }, openDelay);
        setTimeout(() => { // 兜底：120 秒强制退出，防止页面卡死拖住测试
          try { fs.writeFileSync(path.join(__dirname, 'diag', 'CHAT-DONE.txt'), 'TIMEOUT ' + new Date().toISOString() + '\n'); } catch (_) {}
          try { viewer.destroyAll(); } catch (_) {}
          app.exit(2);
        }, 120000);
      }
    }
  }
}
