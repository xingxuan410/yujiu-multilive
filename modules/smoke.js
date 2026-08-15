// modules/smoke.js — 冒烟自检（--smoke 模式）
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const Store = require('./store');
const { fetchRoomInfo, parseRoomId } = require('./poller');
const Notifier = require('./notifier');
const { Viewer } = require('./viewer');

const ROOT = path.join(__dirname, '..');
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function step(name) { console.log(`SMOKE:STEP ${name}`); }
function result(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`SMOKE:RESULT ${name} ${pass ? 'PASS' : 'FAIL'} ${detail}`);
}
function argValue(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

// --offscreen：窗口全程隐藏、弹窗移到屏幕外（调试用，不打扰桌面），截图照常生成
const offscreen = process.argv.includes('--offscreen');

function waitForLoad(wc, timeoutMs = 10000) {
  return new Promise((res) => {
    if (!wc.isLoading()) return res();
    const t = setTimeout(res, timeoutMs);
    wc.once('did-finish-load', () => { clearTimeout(t); res(); });
  });
}

function registerSmokeStubs() {
  const dummy = {
    version: 1,
    groups: [{ id: 'g1', name: '游戏区' }],
    streamers: [
      {
        id: 's1', roomId: '1017', name: '测试主播A', groupId: 'g1',
        isLive: true, liveStatus: 1, liveTitle: '冒烟测试直播间标题', cover: '',
        areaName: '网游 · 英雄联盟', uname: '测试主播A', liveStartTime: Date.now() - 60000,
        notified: false, addedAt: Date.now(),
      },
      {
        id: 's2', roomId: '2', name: '测试主播B', groupId: null,
        isLive: false, liveStatus: 0, liveTitle: '', cover: '',
        areaName: '', uname: '测试主播B', liveStartTime: null,
        notified: false, addedAt: Date.now(),
      },
    ],
    settings: { pollIntervalSec: 60, popupDurationSec: 10, systemNotification: false },
  };
  ipcMain.handle('state:get', () => ({ data: dummy }));
  for (const ch of ['streamer:resolve', 'streamer:add', 'streamer:remove', 'streamer:rename',
    'streamer:move', 'group:add', 'group:remove', 'group:rename', 'settings:set',
    'room:open', 'room:close', 'room:mute', 'room:focus', 'notify:test']) {
    ipcMain.handle(ch, () => ({ ok: true }));
  }
}

async function runSmoke() {
  // 全程看门狗：180 秒内未结束直接判失败退出
  setTimeout(() => { console.log('SMOKE:TIMEOUT'); app.exit(1); }, 180000);

  const outDir = path.join(ROOT, 'smoke');
  fs.mkdirSync(outDir, { recursive: true });
  const profileDir = path.join(ROOT, 'smoke-profile'); // userData 已在 main.js 中提前重定向

  const room1 = argValue('--room1', '6');
  const room2 = argValue('--room2', '1');
  const room3 = argValue('--room3', '2');
  const room4 = argValue('--room4', '3');

  // 1) 存储层 CRUD + 持久化
  step('store-basics');
  try {
    const storePath = path.join(profileDir, 'data.json');
    const store = new Store(storePath);
    const g = store.addGroup('测试分组');
    const s1 = store.addStreamer({ roomId: '12345', name: '测试主播', groupId: g.id });
    store.renameStreamer(s1.id, '改名主播');
    store.updateStreamer(s1.id, { isLive: true, liveStatus: 1, liveTitle: 't' });
    store.moveStreamer(s1.id, null);
    const g2 = store.addGroup('临时组');
    store.renameGroup(g2.id, '临时组2');
    store.removeGroup(g2.id);
    const ok1 = store.data.streamers.length === 1
      && store.data.streamers[0].groupId === null
      && store.data.streamers[0].name === '改名主播'
      && store.data.streamers[0].isLive === true;
    store.removeStreamer(s1.id);
    const ok2 = store.data.streamers.length === 0;
    const store2 = new Store(storePath);
    const ok3 = store2.data.groups.some((x) => x.name === '测试分组');
    result('store-basics', ok1 && ok2 && ok3, `ok1=${ok1} ok2=${ok2} ok3=${ok3}`);
  } catch (e) {
    result('store-basics', false, String(e.message || e));
  }

  // 2) parseRoomId
  step('parse-roomid');
  const p1 = parseRoomId('https://live.bilibili.com/12345?x=1');
  const p2 = parseRoomId(' 67890 ');
  const p3 = parseRoomId('abc');
  result('parse-roomid', p1 === '12345' && p2 === '67890' && p3 === null, `p1=${p1} p2=${p2} p3=${p3}`);

  // 3) B站开播接口连通性
  step('api-fetch');
  let apiInfo = null;
  try {
    apiInfo = await fetchRoomInfo(room1, { timeoutMs: 15000 });
    result('api-fetch',
      typeof apiInfo.liveStatus === 'number' && typeof apiInfo.roomId === 'string',
      JSON.stringify(apiInfo).slice(0, 300));
  } catch (e) {
    result('api-fetch', false, String(e.message || e));
  }

  // 4) 主窗口 + 渲染层
  step('window-open');
  let win = null;
  try {
    registerSmokeStubs();
    win = new BrowserWindow({
      width: 1280, height: 800, show: !offscreen,
      backgroundColor: '#14141a',
      webPreferences: {
        preload: path.join(ROOT, 'preload.js'),
        contextIsolation: true, nodeIntegration: false,
      },
    });
    await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
    await sleep(1500);
    const sidebarCheck = await win.webContents.executeJavaScript(
      '(() => { const sb = document.getElementById("sidebar"); const items = document.querySelectorAll("#groups-list .streamer").length; return { hasSidebar: !!sb, items }; })()'
    );
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'window.png'), img.toPNG());
    result('window-open',
      sidebarCheck && sidebarCheck.hasSidebar && sidebarCheck.items >= 2,
      `${JSON.stringify(sidebarCheck)} bounds=${JSON.stringify(win.getBounds())}`);
  } catch (e) {
    result('window-open', false, String(e.message || e));
  }

  // 5) 多直播间网格布局（1/2/3/4 路）+ 静音默认值 + 页面加载
  const viewer = new Viewer(win, { sidebarW: 280 });
  const layoutLog = [];
  try {
    for (let i = 0; i < 4; i++) {
      const roomId = [room1, room2, room3, room4][i];
      step(`layout-n${i + 1}`);
      viewer.openRoom(roomId, { unmute: i === 0 });
      await sleep(300);
      const wc = viewer.rooms.get(roomId).view.webContents;
      await waitForLoad(wc, 15000);
      await sleep(4500);
      try {
        const vimg = await wc.capturePage();
        fs.writeFileSync(path.join(outDir, `view${i + 1}.png`), vimg.toPNG());
      } catch (e) {
        console.log(`SMOKE:NOTE capture view${i + 1} failed: ${e.message}`);
      }
      const [W, H] = win.getContentSize();
      layoutLog.push({
        n: i + 1,
        contentSize: { W, H },
        sidebarW: viewer.sidebarW,
        bounds: [...viewer.rooms.values()].map((r) => {
          const b = r.view.getBounds();
          return { x: b.x, y: b.y, width: b.width, height: b.height };
        }),
        muted: [...viewer.rooms.values()].map((r) => r.muted),
      });
    }
    fs.writeFileSync(path.join(outDir, 'layout.json'), JSON.stringify(layoutLog, null, 2));

    const [n1, n2, n3, n4] = layoutLog;
    const exp1 = n1.bounds.length === 1
      && n1.bounds[0].x === 280
      && n1.bounds[0].width === n1.contentSize.W - 280
      && n1.bounds[0].height === n1.contentSize.H;
    const exp2 = n2.bounds.length === 2
      && n2.bounds[0].width === n2.bounds[1].width
      && n2.bounds[0].x === 280
      && n2.bounds[1].x === 280 + n2.bounds[0].width;
    const exp3 = n3.bounds.length === 3
      && n3.bounds[0].width === n3.bounds[1].width
      && n3.bounds[0].height === n3.contentSize.H
      && n3.bounds[1].height === n3.bounds[2].height
      && n3.bounds[1].x === n3.bounds[0].x + n3.bounds[0].width
      && n3.bounds[2].y === n3.bounds[1].y + n3.bounds[1].height;
    const exp4 = n4.bounds.length === 4
      && n4.bounds[0].width === n4.bounds[2].width
      && n4.bounds[0].height === n4.bounds[1].height
      && n4.bounds[2].x === 280
      && n4.bounds[2].y === n4.bounds[0].y + n4.bounds[0].height;
    const expMute = n4.muted.length === 4 && n4.muted[0] === false && n4.muted.slice(1).every(Boolean);
    result('layout-grid', exp1 && exp2 && exp3 && exp4, 'n=1..4 布局校验');
    result('layout-mute', expMute, `muted=[${n4.muted}]`);
  } catch (e) {
    result('layout-grid', false, String(e.message || e));
  }

  // 6) 右下角弹窗（含两条堆叠）
  step('popup');
  try {
    const notifier = new Notifier({ offscreen });
    notifier.show({
      roomId: room1, name: '测试主播', title: '这是一条开播弹窗测试',
      area: '网游 · 英雄联盟', cover: '', durationMs: 9000,
    });
    await sleep(600);
    notifier.show({
      roomId: room2, name: '第二位主播', title: '第二条弹窗堆叠测试',
      area: '电台', cover: '', durationMs: 9000,
    });
    await sleep(1200);
    const alive = notifier.popups.filter((p) => !p.win.isDestroyed());
    const wa = screen.getPrimaryDisplay().workArea;
    const corner = { x: wa.x + wa.width - 340 - 12, y: wa.y + wa.height - 104 - 12 };
    const newest = alive[alive.length - 1] && alive[alive.length - 1].win;
    const older = alive[0] && alive[0].win;
    let ok = alive.length === 2 && !newest.isDestroyed();
    if (ok) {
      const pimg = await newest.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, 'popup.png'), pimg.toPNG());
    }
    if (ok && !offscreen) {
      const nb = newest.getBounds();
      const ob = older.getBounds();
      ok = Math.abs(nb.x - corner.x) <= 2
        && Math.abs(nb.y - corner.y) <= 2
        && Math.abs(ob.x - corner.x) <= 2
        && Math.abs(ob.y - (corner.y - 114)) <= 2;
    }
    result('popup', ok,
      `alive=${alive.length} workArea=${JSON.stringify(wa)} ` +
      (ok && newest && !newest.isDestroyed() ? `newest=${JSON.stringify(newest.getBounds())}` : ''));
    notifier.closeAll();
  } catch (e) {
    result('popup', false, String(e.message || e));
  }

  // 7) 汇总退出
  step('done');
  const allPass = results.every((r) => r.pass);
  console.log('SMOKE:DONE ' + JSON.stringify({ allPass, results }, null, 2));
  try { viewer.destroyAll(); } catch {}
  try { if (win && !win.isDestroyed()) win.close(); } catch {}
  return allPass ? 0 : 1;
}

module.exports = { runSmoke };
