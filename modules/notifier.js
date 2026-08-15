const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');
const { computePopupPositions } = require('./layout');

const W = 340;
const H = 104;
const MARGIN = 12;
const GAP = 10;

let instance = null;

class Notifier {
  constructor(opts = {}) {
    if (instance) {
      instance.offscreen = instance.offscreen || !!opts.offscreen;
      return instance;
    }
    instance = this;

    this.offscreen = !!opts.offscreen;
    this.popups = [];
    this.onOpen = null;
    this._senderIds = new Set();

    ipcMain.on('popup:open', (e, roomId) => {
      if (!this._senderIds.has(e.sender.id)) return;
      const fn = this.onOpen;
      this.closeAll();
      if (typeof fn === 'function') fn(String(roomId));
    });

    ipcMain.on('popup:close', (e) => {
      if (!this._senderIds.has(e.sender.id)) return;
      this._closeForSender(e.sender.id);
    });
  }

  show(info) {
    info = info || {};
    const durationMs = Number(info.durationMs) || 10000;

    const win = new BrowserWindow({
      width: W,
      height: H,
      frame: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'popup', 'popup-preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    });

    const senderId = win.webContents.id;
    this._senderIds.add(senderId);

    win.loadFile(path.join(__dirname, '..', 'popup', 'popup.html'), {
      query: {
        roomId: String(info.roomId),
        name: String(info.name || ''),
        title: String(info.title || ''),
        area: String(info.area || ''),
        cover: String(info.cover || ''),
        durationMs: String(info.durationMs || 10000)
      }
    });

    const timer = setTimeout(() => {
      if (!win.isDestroyed()) win.close();
    }, durationMs);

    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      this._stack();
      win.showInactive();
      win.setAlwaysOnTop(true, 'screen-saver');
    });

    win.on('closed', () => {
      clearTimeout(timer);
      this._senderIds.delete(senderId);
      this.popups = this.popups.filter(p => p.win !== win);
      this._stack();
    });

    this.popups.push({ win, timer });
  }

  _stack() {
    // 仅统计存活（未销毁）的弹窗，按加入顺序排列。
    const alive = this.popups.filter(p => !p.win.isDestroyed());
    if (this.offscreen) {
      // 调试模式：全部移到屏幕外，不打扰桌面
      for (const p of alive) p.win.setPosition(-5000, -5000);
      return;
    }
    const wa = screen.getPrimaryDisplay().workArea;
    const positions = computePopupPositions(alive.length, wa, { width: W, height: H, margin: MARGIN, gap: GAP });
    for (let i = 0; i < alive.length; i++) {
      alive[i].win.setPosition(positions[i].x, positions[i].y);
    }
  }

  closeAll() {
    for (const p of this.popups) {
      if (!p.win.isDestroyed()) p.win.close();
    }
  }

  _closeForSender(id) {
    for (const p of this.popups) {
      if (p.win.isDestroyed()) continue;
      try {
        if (p.win.webContents.id === id) {
          p.win.close();
          break;
        }
      } catch { break; }
    }
  }
}

module.exports = Notifier;
