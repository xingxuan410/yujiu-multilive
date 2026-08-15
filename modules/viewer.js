// modules/viewer.js — 多直播间 WebContentsView 网格管理（主控实现）
const { WebContentsView, shell } = require('electron');
const path = require('node:path');
const { computeRects, SIDEBAR_W } = require('./layout');
const { log } = require('./applog');

// 礼物框开关 CSS：hide 时移除礼物框，并把直播画面/评论区扩展占满原礼物区域。
// 注意：不强制拉伸 video，保持页面原有的固定画面比例（0.1.1 行为）。
const GIFT_HIDE_CSS = `
.gift-control-section, [class*="gift-control-section"], [class*="gift-menu-root"], [class*="gift-panel"] { display: none !important; }
.live-room-app { height: 100vh !important; }
.live-room-app .app-content { height: 100% !important; box-sizing: border-box !important; }
.live-room-app .app-body { height: 100% !important; box-sizing: border-box !important; }
.live-room-app .player-and-aside-area { height: 100% !important; box-sizing: border-box !important; }
.live-room-app .player-ctnr { height: 100% !important; box-sizing: border-box !important; }
.live-room-app .aside-area { height: 100% !important; box-sizing: border-box !important; }
`;

class Viewer {
  constructor(win, opts = {}) {
    this.win = win;
    this.sidebarW = opts.sidebarW || SIDEBAR_W;
    this.rooms = new Map(); // roomId -> { view, muted, ... }
    this.pool = new Map(); // 最近关闭的直播间缓存（页面保持加载，重开秒开）
    this.overlay = false; // 渲染层弹窗打开时，暂时隐藏画面
    this.onActive = opts.onActive || null; // 画面获得焦点回调（用于快捷开关定位目标直播间）
    this.onStateChange = opts.onStateChange || null; // 自动收起/全屏状态变化回调（用于同步渲染层）
    this.autoCollapse = opts.autoCollapse !== false; // 自动收起总开关（实验模式可关）
    this.opQueue = Promise.resolve(); // 注入操作串行队列：多房间并发时避免互相抢焦点导致事件投递失败
    this.lastUserInputAt = 0; // 最近一次用户真实输入时间：注入前等用户停手，避免和用户抢焦点
    try {
      if (this.win && this.win.webContents && !this.win.webContents.isDestroyed()) {
        let lastMainInputLog = 0;
        this.win.webContents.on('before-input-event', (_e, input) => {
          this.lastUserInputAt = Date.now();
          if (input && (input.type === 'mouseDown' || input.type === 'mouseUp') && Date.now() - lastMainInputLog > 400) {
            lastMainInputLog = Date.now();
            log('USERINPUT', 'main', input.type, 'x=' + input.x, 'y=' + input.y);
          }
        });
      }
    } catch {}
  }

  // 等用户停止操作（默认 1.2 秒无输入）再开始注入；最长等 timeoutMs，超时也继续
  async _waitUserIdle(idleMs = 1200, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - this.lastUserInputAt < idleMs) {
      if (Date.now() - start > timeoutMs) return false;
      await new Promise((res) => setTimeout(res, 200));
    }
    return true;
  }

  // 所有"强制聚焦 + sendInputEvent"操作串行执行：上一个房间的注入完成后，下一个才开始。
  _enqueueOp(fn) {
    const run = this.opQueue.then(fn, fn);
    this.opQueue = run.then(() => {}, () => {});
    return run;
  }

  // CDP 鼠标注入：Input.dispatchMouseEvent 直接进渲染进程，不依赖窗口焦点路由。
  // 真实使用中发现 sendInputEvent 的 mouseDown/mouseUp 会被丢弃（mousemove 能到），CDP 可稳定送达。
  async _cdpInput(roomId, events) {
    const r = this.rooms.get(String(roomId)) || this.pool.get(String(roomId));
    if (!r || r.view.webContents.isDestroyed()) return false;
    const wc = r.view.webContents;
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      for (const ev of events) {
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', ev);
      }
      return true;
    } catch (e) {
      log('VIEW', 'cdp-input', roomId, '失败', String((e && e.message) || e));
      return false;
    }
  }

  // 注入一次完整“移动到(x,y) → 按下 → 抬起”：优先 CDP，失败退回 sendInputEvent
  async _injectClick(roomId, x, y, clickCount = 1) {
    const ok = await this._cdpInput(roomId, [
      { type: 'mouseMoved', x, y },
      { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount },
      { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount },
    ]);
    if (ok) return true;
    // 兜底：老注入方式
    const r = this.rooms.get(String(roomId));
    if (!r || r.view.webContents.isDestroyed()) return false;
    const wc = r.view.webContents;
    try {
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount });
      return true;
    } catch (e) {
      log('VIEW', 'inject-click', roomId, 'sendInputEvent 兜底失败', String((e && e.message) || e));
      return false;
    }
  }

  // 注入一次“移动到(x,y)”（悬停用）
  async _injectMove(roomId, x, y) {
    const ok = await this._cdpInput(roomId, [{ type: 'mouseMoved', x, y }]);
    if (ok) return true;
    const r = this.rooms.get(String(roomId));
    if (!r || r.view.webContents.isDestroyed()) return false;
    try { r.view.webContents.sendInputEvent({ type: 'mouseMove', x, y }); return true; }
    catch (e) { return false; }
  }

  _isBili(url) {
    try {
      const h = new URL(url).hostname.toLowerCase();
      return h === 'bilibili.com' || h.endsWith('.bilibili.com') || h === 'b23.tv';
    } catch { return false; }
  }

  openRoom(roomId, opts = {}) {
    roomId = String(roomId);
    if (!roomId) return { skipped: true };
    // 注入输入（全屏双击/收起点击）只有在窗口可见且聚焦时才被 Chromium 投递；程序自动打开（弹窗点击/启动自测）时补一次焦点
    try {
      if (this.win && !this.win.isDestroyed() && !this.win.isFocused()) this.win.focus();
    } catch {}
    if (this.rooms.has(roomId)) {
      this.focusRoom(roomId);
      return { alreadyOpen: true };
    }
    log('ROOM', 'openRoom 开始:', roomId);
    // 缓存池命中：直接挂回，秒开
    const cached = this.pool.get(roomId);
    if (cached) {
      this.pool.delete(roomId);
      if (cached.prewarmed) {
        cached.muted = opts.unmute ? false : this.rooms.size > 0;
        delete cached.prewarmed;
      }
      this.rooms.set(roomId, cached);
      if (!this.overlay) this.win.contentView.addChildView(cached.view);
      // 恢复播放与静音状态（之前进池时暂停+静音）
      cached.view.webContents.setAudioMuted(cached.muted);
      cached.view.webContents.executeJavaScript(
        'document.querySelectorAll("video").forEach((v) => { if (v.paused) v.play().catch(() => {}); })', true
      ).catch(() => {});
      this.layout();
      if (cached.trueFullscreen) {
        this._autoWebFullscreen(roomId); // 池中若自动刷新过，重新确保网页全屏
      } else {
        // 池中已提前打上全屏 class（预热即全屏）：保留状态，尽快进入收起流程
        cached.fsRetries = 0; // 重新打开：重置真实全屏重试预算
        if (cached.fsRetryTimer) { clearTimeout(cached.fsRetryTimer); cached.fsRetryTimer = null; }
        setTimeout(() => this._autoWebFullscreen(roomId), 120);
      }
      if (cached.pauseTimers) { // 取消预热时安排的暂停（否则打开后会被自动暂停）
        cached.pauseTimers.forEach(clearTimeout);
        cached.pauseTimers = [];
      }
      if (!cached.chatUserToggled) {
        // 前台打开：尽快收起（池中已全屏，打开后直接从悬停开始）
        cached.chatHidden = false;
        cached.chatAutoTries = 0;
        setTimeout(() => this._autoCollapseChat(roomId), 50);
      }
      setTimeout(() => this._autoHideGift(roomId), 400); // 默认自动隐藏礼物框（可点 🎁 打开）
      log('ROOM', '复用缓存视图（秒开）:', roomId);
      return { alreadyOpen: false, cached: true };
    }
    const view = this._createView(roomId);
    const wc = view.webContents;
    const muted = opts.unmute ? false : this.rooms.size > 0;
    wc.setAudioMuted(muted);
    this.rooms.set(roomId, { view, muted, webFullscreen: false, fsProbed: false, chatHidden: false, chatUserToggled: false, giftHidden: false });
    if (!this.overlay) this.win.contentView.addChildView(view);
    wc.loadURL(`https://live.bilibili.com/${roomId}`);
    setTimeout(() => this._autoHideGift(roomId), 800); // 默认自动隐藏礼物框（可点 🎁 打开）
    this.layout();
    log('ROOM', 'openRoom 完成:', roomId, 'muted=', muted);
    return { alreadyOpen: false, muted };
  }

  // 创建直播间视图并挂载公共事件
  _createView(roomId) {
    const view = new WebContentsView({
      webPreferences: {
        partition: 'persist:bili', // 共享登录会话
        contextIsolation: true,
        sandbox: true,
        autoplayPolicy: 'no-user-gesture-required',
        preload: path.join(__dirname, '..', 'room-preload.js'), // document-start 拦截浮层与站头（等效不加载）
      },
    });
    try {
      if (typeof view.setBackgroundColor === 'function') view.setBackgroundColor('#14141a'); // 深色底，避免白屏刺眼
    } catch {}
    const wc = view.webContents;
    try { wc.debugger.attach('1.3'); } catch {} // 预连接 CDP：注入鼠标事件时不再有首次连接开销
    wc.on('error', (err) => { log('VIEW', 'webContents error', roomId, String((err && err.message) || err)); });
    try {
      let lastUserLogAt = 0;
      wc.on('before-input-event', (_e, input) => {
        this.lastUserInputAt = Date.now();
        if (input && (input.type === 'mouseDown' || input.type === 'mouseUp') && Date.now() - lastUserLogAt > 400) {
          lastUserLogAt = Date.now();
          log('USERINPUT', roomId, input.type, 'x=' + input.x, 'y=' + input.y);
        }
      });
    } catch {}
    wc.on('focus', () => {
      try { if (this.onActive) this.onActive(roomId); } catch {}
    });
    wc.on('console-message', (_e, _level, message) => {
      if (message && message.includes('[app]')) log('PAGE', roomId, message);
    });
    wc.on('did-fail-load', (_e, code, desc, url) => {
      log('VIEW', 'did-fail-load', roomId, code, desc, url);
    });
    wc.on('render-process-gone', (_e, details) => {
      log('VIEW', 'render-process-gone', roomId, JSON.stringify(details));
    });
    wc.on('did-finish-load', () => {
      // 页面挂载后自动进入“网页全屏”：加类 + 页面内 MutationObserver 即时补回（无闪烁）
      [150, 1000, 3000].forEach((ms) => setTimeout(() => this._autoWebFullscreen(roomId), ms));
      // 页面加载完成后重新按格子宽度缩放一次（避免横向裁切）
      setTimeout(() => { try { if (this.rooms.has(roomId)) this.layout(); } catch (_) {} }, 1200);
      // 收起评论区只在房间真正打开（前台）时执行；池中的视图不渲染，测量不可靠
      if (this.rooms.has(roomId)) {
        setTimeout(() => this._autoCollapseChat(roomId), 800);
      } else {
        // 激进提速：预热池里先把虚拟光标预悬停到评论区左边缘，打开后可直接点击
        setTimeout(() => { try { this._prehoverPool(roomId); } catch (_) {} }, 2500);
      }
    });
    // 拦截页面请求的原生全屏（避免格子里全屏后又弹出覆盖整个应用的全屏）
    wc.on('enter-html-full-screen', () => {
      log('VIEW', '拦截原生全屏', roomId);
      wc.executeJavaScript('if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen()').catch(() => {});
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      if (!this._isBili(url)) { e.preventDefault(); shell.openExternal(url); }
    });
    return view;
  }

  // 预热：后台加载直播间页面进缓存池（不显示、静音、加载后暂停视频）
  prewarmRoom(roomId) {
    roomId = String(roomId);
    if (!roomId || this.rooms.has(roomId) || this.pool.has(roomId)) return false;
    if (this.pool.size >= 9) return false; // 池上限：全量预热9位主播
    log('ROOM', '预热开始:', roomId);
    try {
      const view = this._createView(roomId);
      const wc = view.webContents;
      wc.setAudioMuted(true);
      const rec = { view, muted: true, webFullscreen: false, fsProbed: false, chatHidden: false, chatUserToggled: false, prewarmed: true, pauseTimers: [], giftHidden: false };
      this.pool.set(roomId, rec);
      wc.loadURL(`https://live.bilibili.com/${roomId}`);
      // 播放器起来后暂停视频，降低后台开销；仅当仍在池中才执行（被打开后取消）
      const stop = () => {
        if (this.pool.get(roomId) !== rec) return; // 已被调到前台，不再暂停
        try {
          wc.executeJavaScript('document.querySelectorAll("video").forEach((v) => v.pause())').catch(() => {});
        } catch {}
      };
      rec.pauseTimers.push(setTimeout(stop, 10000));
      rec.pauseTimers.push(setTimeout(stop, 20000));
      log('ROOM', '预热入池:', roomId);
      return true;
    } catch (e) {
      log('VIEW', '预热失败', roomId, String((e && e.message) || e));
      return false;
    }
  }

  // 激进提速：预热池里把虚拟光标（CDP）预悬停到评论区左边缘。
  // 打开房间时页面热区状态已就绪，收起时无需再等悬停淡入。
  async _prehoverPool(roomId) {
    const r = this.pool.get(String(roomId));
    if (!r || r.view.webContents.isDestroyed()) return;
    try {
      const rect = await r.view.webContents.executeJavaScript(`(() => {
        const a = document.querySelector('.aside-area');
        if (!a) return null;
        const rc = a.getBoundingClientRect();
        if (rc.width <= 0 || rc.height <= 0) return null;
        return { x: Math.max(0, Math.round(rc.left) - 2), y: Math.round(rc.top + Math.min(rc.height / 2, 300)) };
      })()`).catch(() => null);
      if (!rect) return;
      await this._cdpInput(roomId, [{ type: 'mouseMoved', x: rect.x, y: rect.y }]);
      r.prehovered = true;
      log('ROOM', '预热悬停就位', roomId, JSON.stringify(rect));
    } catch (e) {
      log('VIEW', '预热悬停失败', roomId, String((e && e.message) || e));
    }
  }

  // 自动触发直播间页面的“网页全屏”（bak 原版体验）：
  // 立即给页面加 player-full-win/over-hidden（含预热池），一点开就是全屏；
  // 不再做任何后台双击升级/重试（用户确认初始状态悬停即可收起，不需要折腾原生全屏）。
  async _autoWebFullscreen(roomId) {
    const r = this.rooms.get(String(roomId)) || this.pool.get(String(roomId));
    if (!r || r.view.webContents.isDestroyed()) return;
    if (r.trueFullscreen || r.chatUserToggled || r.chatHidden || r.webFullscreen) return;
    const wc = r.view.webContents;
    // 立即兜底（含预热池）：一点开就是全屏
    const js = `(() => {
      if (window.__appFsObserver) return { ok: true, how: 'observer-already' };
      const ensure = () => {
        const b = document.body;
        if (!b) return;
        if (!b.classList.contains('player-full-win')) b.classList.add('player-full-win');
        if (!b.classList.contains('over-hidden')) b.classList.add('over-hidden');
      };
      ensure();
      const mo = new MutationObserver(ensure);
      mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      window.__appFsObserver = mo;
      setTimeout(() => { mo.disconnect(); window.__appFsObserver = null; }, 25000);
      return { ok: true, how: 'observer' };
    })()`;
    let res = null;
    try { res = await wc.executeJavaScript(js, true); }
    catch (e) { log('VIEW', '网页全屏兜底执行失败（忽略，窗口可能已销毁）', roomId, String((e && e.message) || e)); }
    if (res && res.ok) {
      r.webFullscreen = true;
      log('ROOM', '网页全屏已触发（CSS 兜底，即时全屏）', roomId, res.how || '');
      this._autoCollapseChat(roomId);
    }
  }

  // 真实双击播放器触发原生网页全屏；成功判定：页面原生收起评论区（aside 可见 → 隐藏）。
  // 关键：注入输入只投递给有焦点的视图 → 每次先强制“窗口可见+窗口聚焦+视图聚焦”，并确认页面 hasFocus。
  // 通过 _enqueueOp 串行执行，避免多房间并发互相抢焦点。
  _tryDoubleClickFullscreen(roomId) {
    return this._enqueueOp(async () => {
      const r = this.rooms.get(String(roomId)) || this.pool.get(String(roomId));
      if (!r || r.view.webContents.isDestroyed()) return false;
      return this._tryDoubleClickFullscreenInner(roomId);
    });
  }

  async _tryDoubleClickFullscreenInner(roomId) {
    const r = this.rooms.get(String(roomId)) || this.pool.get(String(roomId));
    if (!r || r.view.webContents.isDestroyed()) return false;
    const wc = r.view.webContents;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    try {
      // 0) 强制聚焦（注入事件只投递给有焦点的视图）
      try {
        if (this.win && !this.win.isDestroyed()) {
          if (!this.win.isVisible()) this.win.show();
          this.win.focus();
        }
      } catch {}
      wc.focus();
      await sleep(120);
      let hasFocus = await wc.executeJavaScript(`document.hasFocus()`).catch(() => false);
      if (!hasFocus) {
        try { if (this.win && !this.win.isDestroyed()) this.win.focus(); } catch {}
        await sleep(100);
        wc.focus();
        await sleep(120);
        hasFocus = await wc.executeJavaScript(`document.hasFocus()`).catch(() => false);
      }
      log('VIEW', 'fs-debug', roomId, JSON.stringify({
        hasFocus,
        winFocused: !!(this.win && !this.win.isDestroyed() && this.win.isFocused()),
        winVisible: !!(this.win && !this.win.isDestroyed() && this.win.isVisible()),
      }));
      // 等用户停手再注入（注入事件现在不会被屏蔽守卫误拦，等待缩短到 250ms）
      await this._waitUserIdle(250, 1200);
      try { if (this.win && !this.win.isDestroyed()) this.win.focus(); } catch {}
      wc.focus();
      await sleep(100);
      const rect = await wc.executeJavaScript(
        `(() => { const p = document.querySelector('.player-ctnr') || document.querySelector('#player-ctnr'); if (!p) return null; const rc = p.getBoundingClientRect(); if (rc.width <= 0 || rc.height <= 0) return null; return { x: Math.round(rc.left + rc.width / 2), y: Math.round(rc.top + Math.min(rc.height / 2, 300)) }; })()`
      ).catch(() => null);
      if (!rect) return false;
      // 双击前记录评论区状态与全屏 class：仅当「评论可见→隐藏 且 body 出现 player-full-win」才算原生全屏
      const before = await wc.executeJavaScript(
        `(() => { const a = document.querySelector('.aside-area'); if (!a) return 'not-mounted'; const rc = a.getBoundingClientRect(); if (rc.width <= 0 || rc.height <= 0) return 'hidden'; return 'visible'; })()`
      ).catch(() => 'visible');
      const fsBefore = await wc.executeJavaScript(
        `document.body ? document.body.classList.contains('player-full-win') : false`
      ).catch(() => false);
      if (fsBefore) {
        // 页面已带全屏 class：可能是兜底（r.webFullscreen=true）或用户自己在画面里双击过。
        // 兜底不冒充原生全屏，让周期重试继续尝试真实双击升级。
        if (!r.webFullscreen) {
          r.trueFullscreen = true;
        }
        r.webFullscreen = true;
        log('ROOM', '网页全屏已确认（页面已有全屏状态）', roomId, 'native=' + r.trueFullscreen);
        this._autoCollapseChat(roomId);
        return true;
      }
      for (let attempt = 1; attempt <= 2; attempt++) {
        await this._shieldRealCursor(wc, rect.x, rect.y); // 双击期间屏蔽真实光标
        const cdpOk = await this._cdpInput(roomId, [
          { type: 'mouseMoved', x: rect.x, y: rect.y },
          { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 },
          { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1 },
          { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 2 },
          { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 2 },
        ]);
        if (!cdpOk) {
          // CDP 不可用：退回老注入方式
          wc.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y });
          await sleep(200);
          wc.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
          await sleep(60);
          wc.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
          await sleep(120);
          wc.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 2 });
          await sleep(60);
          wc.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 2 });
        }
        await sleep(800);
        // 校验：原生全屏 = 页面收起评论区（aside 可见→隐藏）且页面自己加了 player-full-win
        const st = await wc.executeJavaScript(
          `(() => { const a = document.querySelector('.aside-area'); if (!a) return 'not-mounted'; const rc = a.getBoundingClientRect(); if (rc.width <= 0 || rc.height <= 0) return 'hidden'; return 'visible'; })()`
        ).catch(() => 'visible');
        const fsAfter = await wc.executeJavaScript(
          `document.body ? document.body.classList.contains('player-full-win') : false`
        ).catch(() => false);
        log('VIEW', 'fs-debug', roomId, '双击后', JSON.stringify({ attempt, before, after: st, fsBefore, fsAfter }));
        if (fsAfter && !fsBefore) {
          // 成功判定：页面自己加上了 player-full-win（原生网页全屏状态机已切换）。
          // 当前版本双击全屏后评论区可能仍可见，交给后面的原生按钮点击收起（用户要求的分步流程）。
          r.webFullscreen = true;
          r.trueFullscreen = true;
          log('ROOM', '网页全屏已触发（真实双击，原生状态）', roomId, 'aside=' + st);
          this._autoCollapseChat(roomId);
          return true;
        }
        if (st === 'hidden' && before === 'visible' && !fsAfter) {
          // 页面只隐藏了评论区、没有进入网页全屏：初态已变，同轮继续点会状态错乱，交给周期重试
          log('VIEW', 'fs-debug', roomId, '只隐藏了评论区，未进入网页全屏（等待重试）');
          return false;
        }
        await sleep(600); // 第一次没反应，稍后再试一次
      }
      return false;
    } catch (e) {
      log('VIEW', '双击全屏失败', roomId, String((e && e.message) || e));
      return false;
    }
  }

  // 自动收起评论区：原生逻辑——网页全屏（含即时兜底）后，通过悬停淡出的原生按钮点击收起。
  // 只在真正打开（前台）的直播间执行：池中视图不收起。
  async _autoCollapseChat(roomId) {
    if (!this.autoCollapse) return; // 实验/诊断模式下关闭自动收起
    if (!this.rooms.has(String(roomId))) return; // 池中不收起，也不判定
    const r = this.rooms.get(String(roomId));
    if (!r || r.view.webContents.isDestroyed()) return;
    if (r.chatUserToggled) return; // 用户已手动干预过，不再自动
    if (r.chatHidden) return;
    if (r.chatBusy) return; // 上一轮还在进行（多来源触发会重叠，瞬间耗尽重试预算）
    r.chatBusy = true;
    try { await this._autoCollapseChatInner(roomId, r); }
    catch (e) { log('VIEW', 'chat', '自动收起异常（忽略，窗口可能已销毁）', roomId, String((e && e.message) || e)); }
    finally { r.chatBusy = false; }
  }

  async _autoCollapseChatInner(roomId, r) {
    const tries = (r.chatAutoTries = (r.chatAutoTries || 0) + 1);
    const maxTries = 40;
    const interval = 800;
    const wc = r.view.webContents;
    // 1) 前置条件 + 评论区状态一次问完（省一次渲染进程通信）
    let fsClass = !!(r.trueFullscreen || r.webFullscreen);
    let state = 'visible';
    if (!fsClass) {
      const probeRes = await wc.executeJavaScript(`(() => {
        const b = document.body;
        const fs = b ? b.classList.contains('player-full-win') : false;
        const a = document.querySelector('.aside-area');
        let aside = 'not-mounted';
        if (a) { const rc = a.getBoundingClientRect(); const cs = getComputedStyle(a); const vw = window.innerWidth, vh = window.innerHeight; const vis = rc.width > 0 && rc.height > 0 && cs.display !== 'none' && rc.right > 0 && rc.left < vw && rc.bottom > 0 && rc.top < vh; aside = vis ? 'visible' : 'hidden'; }
        return { fs, aside };
      })()`).catch(() => null);
      fsClass = !!(probeRes && probeRes.fs);
      state = (probeRes && probeRes.aside) || 'visible';
      if (!fsClass) {
        log('VIEW', 'chat-debug', roomId, JSON.stringify({ tries, step: 'wait-fullscreen', trueFullscreen: r.trueFullscreen }));
        if (tries < maxTries) setTimeout(() => this._autoCollapseChat(roomId), interval);
        else log('VIEW', 'chat', roomId, '等待网页全屏超时（重试' + maxTries + '次）');
        return;
      }
      log('ROOM', '网页全屏已具备（原生或兜底），进入原生收起流程', roomId);
    } else {
      try {
        state = await wc.executeJavaScript(
          `(() => { const a = document.querySelector('.aside-area'); if (!a) return 'not-mounted'; const rc = a.getBoundingClientRect(); const cs = getComputedStyle(a); const vw = window.innerWidth, vh = window.innerHeight; const vis = rc.width > 0 && rc.height > 0 && cs.display !== 'none' && rc.right > 0 && rc.left < vw && rc.bottom > 0 && rc.top < vh; return vis ? 'visible' : 'hidden'; })()`
        ).catch(() => 'error');
      } catch {}
    }
    // 2) 三态检查评论区：not-mounted → 重试；hidden → 成功；visible → 原生按钮点击
    log('VIEW', 'chat-debug', roomId, JSON.stringify({
      tries, state, trueFullscreen: r.trueFullscreen,
      win: { visible: this.win.isVisible(), focused: this.win.isFocused(), minimized: this.win.isMinimized() },
    }));
    if (state === 'hidden') {
      r.chatHidden = true;
      log('ROOM', 'chat', roomId, '评论区已隐藏（全屏态原生）');
      this._notifyState(roomId);
      return;
    }
    if (state === 'not-mounted') {
      if (tries < maxTries) setTimeout(() => this._autoCollapseChat(roomId), interval);
      else log('VIEW', 'chat', roomId, '评论区一直未挂载（重试' + maxTries + '次）');
      return;
    }
    // 3) 全屏后原生收起：悬停左侧边缘淡出的按钮 + 真实鼠标点击
    const ok = await this._nativeChatToggle(roomId, true);
    if (ok) {
      // 点击后复查：aside 真隐藏才算成功（点击可能被页面忽略，或收起动画未完成）
      await new Promise((res) => setTimeout(res, 300));
      let after = 'visible';
      try {
        after = await wc.executeJavaScript(
          `(() => { const a = document.querySelector('.aside-area'); if (!a) return 'not-mounted'; const rc = a.getBoundingClientRect(); const cs = getComputedStyle(a); const vw = window.innerWidth, vh = window.innerHeight; const vis = rc.width > 0 && rc.height > 0 && cs.display !== 'none' && rc.right > 0 && rc.left < vw && rc.bottom > 0 && rc.top < vh; return vis ? 'visible' : 'hidden'; })()`
        ).catch(() => 'visible');
      } catch {}
      if (after === 'hidden') {
        r.chatHidden = true;
        r.chatAutoTries = 0;
        log('ROOM', 'chat', roomId, '评论区已自动收起（原生按钮点击，验证通过）');
        this._notifyState(roomId);
        return;
      }
      log('VIEW', 'chat', roomId, '原生点击未生效（复查=' + after + '），继续重试');
    }
    if (tries < maxTries) setTimeout(() => this._autoCollapseChat(roomId), interval);
    else log('VIEW', 'chat', roomId, '评论区自动收起失败（重试' + maxTries + '次）');
  }

  // 原生评论区切换：悬停评论区左侧边缘让页面原生淡出按钮，再真实鼠标点击。
  // 只在网页全屏后调用（原生逻辑：先全屏、再收起/展开）。强制聚焦窗口+视图，保证注入事件到达页面。
  // 通过 _enqueueOp 串行执行，避免多房间并发互相抢焦点。
  _nativeChatToggle(roomId, isAuto) {
    return this._enqueueOp(async () => {
      // 执行时再查状态：排队期间可能已被收起/用户干预，过期自动任务直接跳过
      const r = this.rooms.get(String(roomId)) || this.pool.get(String(roomId));
      if (!r || r.view.webContents.isDestroyed()) return false;
      if (isAuto && (r.chatHidden || r.chatUserToggled)) return false;
      return this._nativeChatToggleInner(roomId, isAuto);
    });
  }

  async _nativeChatToggleInner(roomId, isAuto) {
    const r = this.rooms.get(String(roomId)) || this.pool.get(String(roomId));
    if (!r || r.view.webContents.isDestroyed()) return false;
    const wc = r.view.webContents;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const probe = () => wc.executeJavaScript(`(() => {
      const out = { aside: null, tg: null, sl: null, rs: null, fsClass: false };
      const vw = window.innerWidth, vh = window.innerHeight;
      const a = document.querySelector('.aside-area');
      if (a) {
        const ar = a.getBoundingClientRect(); const cs = getComputedStyle(a);
        out.aside = {
          x: Math.round(ar.left), y: Math.round(ar.top), w: Math.round(ar.width), h: Math.round(ar.height),
          display: cs.display,
          visible: ar.width > 0 && ar.height > 0 && cs.display !== 'none' && ar.right > 0 && ar.left < vw && ar.bottom > 0 && ar.top < vh,
        };
      }
      const reg = (key, sel) => {
        const els = Array.from(document.querySelectorAll(sel));
        for (const el of els) {
          const rc = el.getBoundingClientRect();
          if (rc.width <= 0 || rc.height <= 0) continue; // restore-btn 存在两个：跳过 0 尺寸的假按钮
          out[key] = { sel, x: Math.round(rc.left + rc.width / 2), y: Math.round(rc.top + rc.height / 2), w: Math.round(rc.width), h: Math.round(rc.height), dpNone: el.classList.contains('dp-none') };
          return;
        }
      };
      reg('tg', 'div[class~="aside-area-toggle-btn"]');
      reg('sl', 'div[class~="btn-slider"]');
      reg('rs', 'button[class~="restore-btn"]');
      out.fsClass = document.body ? document.body.classList.contains('player-full-win') : false;
      return out;
    })()`).catch(() => null);
    const pick = (list, o) => { if (o && o.w > 0 && o.h > 0) list.push(o); };
    try {
      // CDP 注入直达渲染进程，不需要窗口焦点；仅给用户停手留 150ms 空隙
      await this._waitUserIdle(150, 600);
      // 1) 悬停评论区左边缘，让页面原生淡入按钮
      let p0 = await probe();
      if (!p0) { log('VIEW', 'chat', '原生按钮探测失败', roomId); return false; }
      if (p0.aside && p0.aside.visible) {
        const edge = { x: Math.max(0, p0.aside.x - 2), y: p0.aside.y + Math.max(10, p0.aside.h / 2) };
        await this._shieldRealCursor(wc, edge.x, edge.y);
        await this._injectMove(roomId, edge.x, edge.y);
        // 预热池已预悬停过：只等 60ms 稳定状态；否则等 300ms 让热区淡入
        await sleep(r.prehovered ? 60 : 300);
        // 必须：亮出 restore-btn 并抬到最上层（否则点不到真实热区）
        await wc.executeJavaScript(`(() => {
          const els = Array.from(document.querySelectorAll('button[class~="restore-btn"]'));
          let target = null;
          for (const el of els) {
            if (el.classList.contains('dp-none')) { el.classList.remove('dp-none'); el.classList.remove('a-fade-in'); }
            const rc = el.getBoundingClientRect();
            if (!target && rc.width > 0 && rc.height > 0) target = el;
          }
          if (!target) target = els[0];
          if (!target) return false;
          target.style.setProperty('z-index', '99999', 'important');
          target.style.setProperty('pointer-events', 'auto', 'important');
          return true;
        })()`).catch(() => {});
        await sleep(100);
      }
      // 2) 取点击点：与用户成功的手动操作完全一致——
      //    评论区可见 → 点它左边缘（悬停已让热区淡出，同一点直接点）；
      //    评论区隐藏 → 点画面右边缘的展开按钮位置。
      const vp = await wc.executeJavaScript(`({ vw: window.innerWidth, vh: window.innerHeight })`).catch(() => null);
      let btn;
      if (p0.aside && p0.aside.visible) {
        btn = { sel: 'edge-left', x: Math.max(0, p0.aside.x - 2), y: Math.round(p0.aside.y + Math.max(10, p0.aside.h / 2)) };
      } else {
        btn = { sel: 'edge-right', x: vp ? Math.max(0, vp.vw - 10) : 0, y: vp ? Math.round(vp.vh / 2) : 0 };
      }
      // 3) 视口校验 + 真实点击
      if (vp && (btn.x < 0 || btn.y < 0 || btn.x > vp.vw || btn.y > vp.vh)) {
        // 网格小窗里 B 站会把按钮布局到视口外（页面内容溢出渲染区）：
        // 合成 click 已试过会被页面忽略，这里直接按按钮 DOM 坐标注入真实鼠标事件试一次。
        log('VIEW', 'chat', '原生按钮在视口外，直接注入点击尝试', roomId, JSON.stringify({ btn, vp }));
        await wc.executeJavaScript(`(() => { if (!window.__appIc) { window.__appIc = true; window.__appMm = 0; window.__appMc = 0; window.addEventListener('mousemove', () => window.__appMm++); window.addEventListener('click', () => window.__appMc++); } })()`).catch(() => {});
        await this._shieldRealCursor(wc, btn.x, btn.y);
        await this._injectClick(roomId, btn.x, btn.y);
        const cnt = await wc.executeJavaScript(`({ mm: window.__appMm, mc: window.__appMc })`).catch(() => null);
        log('VIEW', 'chat 视口外注入计数', roomId, JSON.stringify(cnt));
        return true;
      }
      log('ROOM', 'chat 按钮坐标', roomId, JSON.stringify({ btn, fsClass: p0.fsClass }));
      // 注入后检查投递计数：事件没进页面（用户操作导致焦点闪断）就重新聚焦再试
      let lastCnt = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        await wc.executeJavaScript(`(() => { if (!window.__appIc) { window.__appIc = true; window.__appMm = 0; window.__appMc = 0; window.addEventListener('mousemove', () => window.__appMm++); window.addEventListener('click', () => window.__appMc++); } })()`).catch(() => {});
        await this._shieldRealCursor(wc, btn.x, btn.y);
        await this._injectClick(roomId, btn.x, btn.y);
        lastCnt = await wc.executeJavaScript(`({ mm: window.__appMm, mc: window.__appMc })`).catch(() => null);
        log('VIEW', 'chat 输入投递计数', roomId, JSON.stringify({ attempt, ...lastCnt }));
        if (lastCnt && lastCnt.mc > 0) break; // 必须 click 事件真的送达页面才算一次有效点击
        try { if (this.win && !this.win.isDestroyed()) this.win.focus(); } catch {}
        wc.focus();
        await sleep(300);
      }
      log('ROOM', 'chat', roomId, isAuto ? '自动收起（原生按钮，真实鼠标）' : '手动切换（原生按钮，真实鼠标）');
      return true;
    } catch (e) {
      log('VIEW', 'chat 原生切换失败', roomId, String((e && e.message) || e));
      return false;
    }
  }

  // 手动切换评论栏（chip 上的 💬 按钮）：
  // - 页面已有全屏状态（原生或兜底）→ 直接点原生边缘热区按钮切换；
  // - 完全没全屏 → 先双击进全屏；若双击后评论已被页面原生收起，就不再二次切换。
  async toggleChat(roomId) {
    const r = this.rooms.get(String(roomId));
    if (!r || r.view.webContents.isDestroyed()) return { chatHidden: null };
    r.chatUserToggled = true;
    const wc = r.view.webContents;
    const state = () => wc.executeJavaScript(`(() => { const a = document.querySelector('.aside-area'); if (!a) return 'not-mounted'; const rc = a.getBoundingClientRect(); const cs = getComputedStyle(a); const vw = window.innerWidth, vh = window.innerHeight; const vis = rc.width > 0 && rc.height > 0 && cs.display !== 'none' && rc.right > 0 && rc.left < vw && rc.bottom > 0 && rc.top < vh; return vis ? 'visible' : 'hidden'; })()`).catch(() => 'error');
    const before = await state();
    const fsClass = await wc.executeJavaScript(`document.body ? document.body.classList.contains('player-full-win') : false`).catch(() => false);
    if (!r.trueFullscreen && !fsClass) {
      const ok = await this._tryDoubleClickFullscreen(roomId);
      if (!ok) {
        const s = await state();
        log('ROOM', 'chat-toggle', roomId, '未进入网页全屏，保持现状', JSON.stringify({ state: s }));
        r.chatHidden = s === 'hidden';
        this._notifyState(roomId);
        return { chatHidden: r.chatHidden };
      }
      const after = await state();
      if (before === 'visible' && after === 'hidden') {
        // 双击全屏后页面自己把评论收起了，用户预期就是“收起”
        r.chatHidden = true;
        log('ROOM', 'chat-toggle', roomId, '已进入网页全屏，页面原生收起评论', JSON.stringify({ before, after }));
        this._notifyState(roomId);
        return { chatHidden: true };
      }
      if (after === 'visible' || before === 'hidden') {
        // 评论状态未随全屏改变：继续走下面的原生切换
        log('ROOM', 'chat-toggle', roomId, '已进入网页全屏，继续原生切换', JSON.stringify({ before, after }));
      }
    }
    // 已在全屏（原生或兜底）：原生按钮切换
    log('ROOM', 'chat-toggle', roomId, '原生切换开始', JSON.stringify({ before, trueFullscreen: r.trueFullscreen, fsClass }));
    const ok = await this._nativeChatToggle(roomId, false);
    await new Promise((res) => setTimeout(res, 700));
    const after = await state();
    r.chatHidden = after === 'hidden';
    const fsAfter = await wc.executeJavaScript(`document.body ? document.body.classList.contains('player-full-win') : false`).catch(() => false);
    log('ROOM', 'chat-toggle', roomId, '结果', JSON.stringify({ ok, before, after, chatHidden: r.chatHidden, fsAfter }));
    this._notifyState(roomId);
    return { chatHidden: r.chatHidden };
  }

  // 礼物框开关：像评论区一样可以打开/关闭；关闭时画面与评论区扩展占满原礼物区域
  async toggleGift(roomId) {
    const r = this.rooms.get(String(roomId));
    if (!r || r.view.webContents.isDestroyed()) return { giftHidden: null };
    const hide = !r.giftHidden;
    const js = hide
      ? `(() => {
          if (!document.getElementById('__app-gift-hide')) {
            const s = document.createElement('style');
            s.id = '__app-gift-hide';
            s.textContent = ${JSON.stringify(GIFT_HIDE_CSS)};
            (document.head || document.documentElement).appendChild(s);
          }
          const sels = ['.gift-control-section', '[class*="gift-control-section"]', '[class*="gift-menu-root"]', '[class*="gift-panel"]'];
          for (const sel of sels) {
            document.querySelectorAll(sel).forEach((el) => el.style.setProperty('display', 'none', 'important'));
          }
          return true;
        })()`
      : `(() => {
          const el = document.getElementById('__app-gift-hide');
          if (el) el.remove();
          const sels = ['.gift-control-section', '[class*="gift-control-section"]', '[class*="gift-menu-root"]', '[class*="gift-panel"]'];
          for (const sel of sels) {
            document.querySelectorAll(sel).forEach((e) => e.style.removeProperty('display'));
          }
          return true;
        })()`;
    try {
      await r.view.webContents.executeJavaScript(js, true);
    } catch (e) {
      log('VIEW', 'gift-toggle', roomId, '执行失败', String((e && e.message) || e));
    }
    r.giftHidden = hide;
    log('ROOM', 'gift-toggle', roomId, hide ? '已隐藏' : '已显示');
    this._notifyState(roomId);
    return { giftHidden: r.giftHidden };
  }

  // 打开直播间后默认自动隐藏礼物框（和评论区自动收起保持一致，可点 🎁 再打开）
  _autoHideGift(roomId) {
    const r = this.rooms.get(String(roomId));
    if (!r || r.giftHidden) return;
    this.toggleGift(roomId).catch(() => {});
  }

  closeRoom(roomId) {
    roomId = String(roomId);
    const r = this.rooms.get(roomId);
    if (!r) return false;
    this.win.contentView.removeChildView(r.view);
    this.rooms.delete(roomId);
    // 不销毁：进缓存池（暂停视频+静音，重开秒开）
    try {
      r.view.webContents.setAudioMuted(true);
      r.view.webContents.executeJavaScript(
        'document.querySelectorAll("video").forEach((v) => v.pause())'
      ).catch(() => {});
    } catch {}
    this.pool.set(roomId, r);
    while (this.pool.size > 9) { // 池上限：淘汰最旧
      const k = this.pool.keys().next().value;
      const p = this.pool.get(k);
      this.pool.delete(k);
      try { p.view.webContents.close(); } catch {}
    }
    this.layout();
    return true;
  }

  setMute(roomId, muted) {
    const r = this.rooms.get(String(roomId));
    if (!r) return;
    r.muted = !!muted;
    r.view.webContents.setAudioMuted(!!muted);
  }

  focusRoom(roomId) {
    const r = this.rooms.get(String(roomId));
    if (!r) return;
    this.win.contentView.removeChildView(r.view);
    if (!this.overlay) this.win.contentView.addChildView(r.view);
  }

  // 渲染层打开弹窗时临时摘除画面（弹窗在 webContents 层，会被原生视图盖住）
  setOverlay(on) {
    on = !!on;
    if (on === this.overlay) return;
    this.overlay = on;
    try {
      if (on) {
        for (const { view } of this.rooms.values()) this.win.contentView.removeChildView(view);
      } else {
        for (const { view } of this.rooms.values()) this.win.contentView.addChildView(view);
        this.layout();
      }
    } catch (e) {
      log('VIEW', 'setOverlay 失败', String((e && e.message) || e));
    }
  }

  layout() {
    if (!this.win || this.win.isDestroyed()) return;
    const n = this.rooms.size;
    if (n === 0) return;
    const [W, H] = this.win.getContentSize();
    if (!W || !H) return;
    const rects = computeRects(n, W, H, this.sidebarW);
    const list = [...this.rooms.entries()];
    list.forEach(([roomId, r], i) => {
      const b = rects[i];
      r.view.setBounds({
        x: Math.round(b.x), y: Math.round(b.y),
        width: Math.round(b.w), height: Math.round(b.h),
      });
      this._fitZoom(r, b, roomId); // 按格子宽度自动缩放页面，避免横向裁切
    });
  }

  // B 站页面有最小布局宽度：格子比页面窄时按比例缩小 zoom，保证横向内容完整可见
  _fitZoom(r, b, roomId) {
    const wc = r.view.webContents;
    if (!r.pageWidth) {
      wc.executeJavaScript(
        `Math.max(document.documentElement.scrollWidth || 0, document.documentElement.clientWidth || 0, 1000)`
      ).then((pw) => {
        r.pageWidth = Math.max(Number(pw) || 1000, 1000);
        this._applyZoom(r, b, roomId);
      }).catch(() => {});
      return;
    }
    this._applyZoom(r, b, roomId);
  }

  _applyZoom(r, b, roomId) {
    const pw = r.pageWidth;
    if (!pw) return;
    let f = b.w / pw;
    f = Math.min(1, Math.max(0.5, f)); // 只缩小，不放大；最小 0.5 防止文字过小
    f = Math.round(f * 100) / 100;
    if (Math.abs(f - (r.zoomFactor || 1)) > 0.02) {
      r.zoomFactor = f;
      try { r.view.webContents.setZoomFactor(f); } catch (_) {}
      log('VIEW', 'zoom', roomId, 'cell=' + Math.round(b.w), 'page=' + pw, 'factor=' + f);
    }
  }

  // 屏蔽真实光标：注入操作期间，捕获阶段拦截与注入目标不符的鼠标/指针事件。
  // 页面状态机只看到我们的注入序列，不被用户真实光标干扰（操作结束 5 秒自动失效）。
  async _shieldRealCursor(wc, x, y) {
    try {
      await wc.executeJavaScript(`(() => {
        let t = window.__appShield;
        if (!t) { t = { x: null, y: null, until: 0 }; window.__appShield = t; }
        if (!t.__installed) {
          t.__installed = true;
          const types = ['mousemove','mousedown','mouseup','click','pointermove','pointerdown','pointerup','dblclick'];
          const guard = (e) => {
            if (Date.now() > t.until) return;
            if (!e.isTrusted) return; // 注入事件（isTrusted=false）直接放行；只屏蔽会干扰注入的真实鼠标事件
            const dx = t.x == null ? 999 : Math.abs(e.clientX - t.x);
            const dy = t.y == null ? 999 : Math.abs(e.clientY - t.y);
            if (dx > 30 || dy > 30) {
              e.stopImmediatePropagation();
              if (e.cancelable) e.preventDefault();
            }
          };
          for (const ty of types) window.addEventListener(ty, guard, true);
        }
        t.x = ${x}; t.y = ${y}; t.until = Date.now() + 5000;
        return true;
      })()`);
    } catch {}
  }

  _notifyState(roomId) {
    try { if (this.onStateChange) this.onStateChange(roomId); } catch {}
  }

  snapshot() {
    return [...this.rooms.entries()].map(([roomId, r]) => ({ roomId, muted: r.muted, chatHidden: r.chatHidden, giftHidden: !!r.giftHidden }));
  }

  destroyAll() {
    for (const roomId of [...this.rooms.keys()]) this.closeRoom(roomId);
    for (const [k, p] of this.pool) {
      try { p.view.webContents.close(); } catch {}
    }
    this.pool.clear();
  }
}

module.exports = { Viewer, SIDEBAR_W };
