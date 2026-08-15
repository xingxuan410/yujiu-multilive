// modules/smoke-headless.js — 无头冒烟自检（纯 Node，不依赖 Electron GUI）
// 覆盖：存储层 / 房间号解析 / B站接口 / 轮询事件 / 布局算法 / 弹窗堆叠算法
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const Store = require('./store');
const { Poller, fetchRoomInfo, fetchUname, parseRoomId } = require('./poller');
const { computeRects, computePopupPositions } = require('./layout');

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function step(name) { console.log(`HEADLESS:STEP ${name}`); }
function result(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`HEADLESS:RESULT ${name} ${pass ? 'PASS' : 'FAIL'} ${detail}`);
}

async function main() {
  const profile = path.join(__dirname, '..', 'smoke-profile');
  fs.mkdirSync(profile, { recursive: true });

  // 1) 存储层
  step('store-basics');
  try {
    const store = new Store(path.join(profile, 'data.json'));
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
    const store2 = new Store(path.join(profile, 'data.json'));
    const ok3 = store2.data.groups.some((x) => x.name === '测试分组');
    result('store-basics', ok1 && ok2 && ok3, `ok1=${ok1} ok2=${ok2} ok3=${ok3}`);
  } catch (e) {
    result('store-basics', false, String(e.message || e));
  }

  // 2) 房间号解析
  step('parse-roomid');
  const p1 = parseRoomId('https://live.bilibili.com/12345?x=1');
  const p2 = parseRoomId(' 67890 ');
  const p3 = parseRoomId('abc');
  result('parse-roomid', p1 === '12345' && p2 === '67890' && p3 === null, `p1=${p1} p2=${p2} p3=${p3}`);

  // 3) B站接口（get_info 主接口 + Master/info 主播名）
  step('api-fetch');
  let roomInfo = null;
  try {
    roomInfo = await fetchRoomInfo('6', { timeoutMs: 15000 });
    const okRoom = typeof roomInfo.liveStatus === 'number' && roomInfo.roomId === '6';
    const uname = await fetchUname(roomInfo.uid, { timeoutMs: 8000 });
    const okUname = typeof uname === 'string' && uname.length > 0;
    result('api-fetch', okRoom && okUname, `uname=${uname} live=${roomInfo.liveStatus} title=${(roomInfo.title || '').slice(0, 12)}`);
  } catch (e) {
    result('api-fetch', false, String(e.message || e));
  }

  // 4) 轮询全链路（上升沿/下降沿事件）
  step('poller-cycle');
  try {
    const store = new Store(path.join(profile, 'poller-data.json'));
    const s = store.addStreamer({ roomId: '6', name: '测试', groupId: null });
    const events = [];
    const poller = new Poller(store, { intervalMs: 60000, timeoutMs: 8000, staggerMs: 10 });
    poller.on('wentLive', () => events.push('wentLive'));
    poller.on('wentOffline', () => events.push('wentOffline'));
    poller.on('error', (_s, msg) => events.push('error:' + msg));
    await poller.pollNow();
    const after = store.data.streamers[0];
    const liveOk = after.liveStatus >= 0 && after.liveStatus <= 2 && (after.isLive === (after.liveStatus === 1));
    const stateOk = after.isLive ? after.liveTitle.length > 0 : true;
    result('poller-cycle', liveOk && stateOk && events.length >= 0,
      `liveStatus=${after.liveStatus} isLive=${after.isLive} events=[${events.join(',')}] title=${(after.liveTitle || '').slice(0, 12)}`);
    store.removeStreamer(s.id);
  } catch (e) {
    result('poller-cycle', false, String(e.message || e));
  }

  // 5) 布局算法（1/2/3/4/5/6 路网格）
  step('layout-math');
  try {
    const W = 1280, H = 800, SW = 280;
    const cw = W - SW; // 1000
    const n1 = computeRects(1, W, H, SW);
    const n2 = computeRects(2, W, H, SW);
    const n3 = computeRects(3, W, H, SW);
    const n4 = computeRects(4, W, H, SW);
    const n5 = computeRects(5, W, H, SW);
    const n6 = computeRects(6, W, H, SW);
    const ok1 = n1.length === 1 && n1[0].x === SW && n1[0].w === cw && n1[0].h === H;
    const ok2 = n2.length === 2 && n2[0].w === cw / 2 && n2[1].x === SW + cw / 2 && n2[0].h === H;
    const ok3 = n3.length === 3 && n3[0].w === cw / 2 && n3[0].h === H
      && n3[1].x === SW + cw / 2 && n3[1].y === 0 && n3[1].h === H / 2
      && n3[2].x === SW + cw / 2 && n3[2].y === H / 2 && n3[2].h === H / 2;
    const ok4 = n4.length === 4 && n4[0].w === cw / 2 && n4[0].h === H / 2 && n4[2].x === SW && n4[2].y === H / 2;
    const ok5 = n5.length === 5 && n5[4].x === SW + (cw / 3) && n5[4].y === H / 2; // 3x2 网格最后一行第2格
    const ok6 = n6.length === 6 && n6[5].x === SW + 2 * (cw / 3) && n6[5].y === H / 2;
    result('layout-math', ok1 && ok2 && ok3 && ok4 && ok5 && ok6,
      `n3=${JSON.stringify(n3.map(r => [r.x, r.y, r.w, r.h]))} n5cols=3`);
  } catch (e) {
    result('layout-math', false, String(e.message || e));
  }

  // 6) 弹窗堆叠算法（右下角、向上堆叠）
  step('popup-math');
  try {
    const wa = { x: 0, y: 0, width: 1920, height: 1040 };
    const p1 = computePopupPositions(1, wa);
    const p2 = computePopupPositions(2, wa);
    const p3 = computePopupPositions(3, wa);
    const okCorner = p1[0].x === 1920 - 340 - 12 && p1[0].y === 1040 - 104 - 12;
    const okStack = p2[0].y === 1040 - 104 - 12 - 114 && p2[1].y === 1040 - 104 - 12
      && p3[0].y === 1040 - 104 - 12 - 228 && p3[2].y === 1040 - 104 - 12;
    result('popup-math', okCorner && okStack, `p2=${JSON.stringify(p2)} p3=${JSON.stringify(p3)}`);
  } catch (e) {
    result('popup-math', false, String(e.message || e));
  }

  // 7) 汇总
  const allPass = results.every((r) => r.pass);
  console.log('HEADLESS:DONE ' + JSON.stringify({ allPass, results }, null, 2));
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('HEADLESS:FATAL', e); process.exit(1); });
