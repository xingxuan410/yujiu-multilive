'use strict';

const { EventEmitter } = require('node:events');

const HEADERS = {
  Referer: 'https://live.bilibili.com/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseRoomId(input) {
  if (typeof input !== 'string') return null;
  const str = input.trim();
  if (str === '') return null;

  const liveMatch = str.match(/live\.bilibili\.com\/(\d{1,12})/);
  if (liveMatch) return liveMatch[1];

  const numMatch = str.match(/\d{1,12}/);
  if (numMatch) return numMatch[0];

  return null;
}

function extractMain(data) {
  // get_info 接口：短号优先，主播名需另查 Master/info
  const d = data || {};
  let liveStartTime = null;
  if (typeof d.live_start_time === 'number' && d.live_start_time > 0) {
    liveStartTime = d.live_start_time * 1000;
  } else if (typeof d.live_time === 'string' && d.live_time) {
    const t = new Date(d.live_time.replace(' ', 'T') + '+08:00').getTime();
    if (Number.isFinite(t)) liveStartTime = t;
  }
  return {
    roomId: (d.short_id > 0 ? String(d.short_id) : (d.room_id != null ? String(d.room_id) : '')),
    uid: d.uid != null ? d.uid : null,
    name: '',
    title: d.title != null ? d.title : '',
    cover: d.user_cover || d.cover || '',
    liveStatus: Number(d.live_status) || 0,
    liveStartTime,
    areaParts: [d.parent_area_name, d.area_name],
  };
}

function extractFallback(data) {
  const d = data || {};
  return {
    roomId: d.room_id != null ? String(d.room_id) : '',
    uid: d.uid != null ? d.uid : null,
    name: '',
    title: d.title != null ? d.title : '',
    cover: d.cover != null ? d.cover : '',
    liveStatus: Number(d.live_status) || 0,
    liveStartTime: typeof d.live_start_time === 'number' && d.live_start_time > 0 ? d.live_start_time * 1000 : null,
    areaParts: [d.parent_area_name, d.area_name],
  };
}

function normalize(extracted) {
  return {
    roomId: extracted.roomId,
    uid: extracted.uid,
    name: extracted.name || '',
    title: extracted.title || '',
    cover: extracted.cover || '',
    areaName: extracted.areaParts.filter((x) => x).join('·'),
    liveStatus: extracted.liveStatus,
    liveStartTime: extracted.liveStartTime,
  };
}

async function doFetch(url, opts) {
  const res = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  }
  return res.json();
}

async function fetchRoomInfo(roomId, opts = {}) {
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 10000;
  const id = encodeURIComponent(roomId);

  let code = null;
  let status = null;

  // 主接口 get_info（无风控签名要求，实测稳定）
  try {
    const json = await doFetch(
      `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${id}`,
      { timeoutMs }
    );
    if (json && json.code === 0 && json.data) {
      return normalize(extractMain(json.data));
    }
    code = json && json.code != null ? json.code : null;
  } catch (err) {
    status = err && err.status != null ? err.status : status;
  }

  // 回退接口 get_info_by_room
  try {
    const json = await doFetch(
      `https://api.live.bilibili.com/room/v1/Room/get_info_by_room?room_id=${id}`,
      { timeoutMs }
    );
    if (json && json.code === 0 && json.data) {
      return normalize(extractFallback(json.data));
    }
    code = json && json.code != null ? json.code : code;
  } catch (err) {
    status = err && err.status != null ? err.status : status;
  }

  throw new Error(`获取直播间信息失败(code=${code || 'HTTP' + status})`);
}

async function fetchUname(uid, opts = {}) {
  // 主播名（Master/info），尽力而为：失败返回空串，不抛异常
  if (uid == null) return '';
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 4000;
  try {
    const json = await doFetch(
      `https://api.live.bilibili.com/live_user/v1/Master/info?uid=${encodeURIComponent(uid)}`,
      { timeoutMs }
    );
    if (json && json.code === 0 && json.data) {
      const info = json.data.info || json.data;
      return (info && info.uname) || '';
    }
  } catch {}
  return '';
}

class Poller extends EventEmitter {
  constructor(store, { intervalMs = 60000, timeoutMs = 10000, staggerMs = 250 } = {}) {
    super();
    this.on('error', () => {}); // 防御：确保 'error' 始终有监听，避免无监听时 emit('error') 抛未处理异常
    this.store = store;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.staggerMs = staggerMs;
    this.running = false;
    this.timer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  setInterval(ms) {
    this.intervalMs = ms;
    if (this.running && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.tick(), ms);
    }
  }

  pollNow() {
    return this.tick();
  }

  async tick() {
    const streamers = this.store.data.streamers.slice();
    for (const s of streamers) {
      await this.check(s);
      await sleep(this.staggerMs);
    }
  }

  async check(s) {
    try {
      const info = await fetchRoomInfo(s.roomId, { timeoutMs: this.timeoutMs });
      const prevLive = s.isLive === true;
      const nowLive = info.liveStatus === 1;
      this.store.updateStreamer(s.id, {
        isLive: nowLive,
        liveStatus: info.liveStatus,
        liveTitle: info.title,
        cover: info.cover,
        areaName: info.areaName,
        uname: info.name,
        liveStartTime: info.liveStartTime,
      });
      if (!prevLive && nowLive) this.emit('wentLive', s, info);
      if (prevLive && !nowLive) this.emit('wentOffline', s, info);
    } catch (err) {
      this.emit('error', s, String((err && err.message) || err));
    }
  }
}

module.exports = { Poller, fetchRoomInfo, fetchUname, parseRoomId };
