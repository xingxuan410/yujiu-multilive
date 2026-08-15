'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_DATA = {
  version: 1,
  groups: [],
  streamers: [],
  recentRoomIds: [], // 最近打开的直播间（新→旧，最多8个），启动预热用
  settings: {
    pollIntervalSec: 60,
    popupDurationSec: 10,
    systemNotification: false,
    sidebarCollapsed: false,
    enableNotify: true,
    minimizeToTray: false,
    prewarmOnStartup: true,
  },
};

class Store extends EventEmitter {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this._data = this._load();
  }

  _load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      // 首次启动：加载随仓库发布的默认关注数据（default-data.json）
      const defaultPath = path.join(__dirname, '..', 'default-data.json');
      try {
        if (fs.existsSync(defaultPath)) {
          return JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
        }
      } catch (err) {
        // 默认数据损坏则退回内置空数据
      }
      return structuredClone(DEFAULT_DATA);
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      // 损坏文件：备份后使用默认数据
      try {
        fs.copyFileSync(this.filePath, this.filePath + '.bak');
      } catch (_) {
        // 备份失败不阻断加载
      }
      return structuredClone(DEFAULT_DATA);
    }
  }

  get data() {
    return structuredClone(this._data);
  }

  save() {
    const tmpPath = this.filePath + '.tmp';
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(tmpPath, JSON.stringify(this._data, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.filePath);
    this.emit('change', this.data);
  }

  _findGroup(id) {
    return this._data.groups.find((g) => g.id === id);
  }

  _findStreamer(id) {
    return this._data.streamers.find((s) => s.id === id);
  }

  _validateName(name, message) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error(message);
    }
    return name.trim();
  }

  addGroup(name) {
    const trimmed = this._validateName(name, '分组名不能为空');
    const group = { id: crypto.randomUUID(), name: trimmed };
    this._data.groups.push(group);
    this.save();
    return structuredClone(group);
  }

  removeGroup(id) {
    const group = this._findGroup(id);
    if (!group) throw new Error('未找到该分组');
    this._data.groups = this._data.groups.filter((g) => g.id !== id);
    for (const s of this._data.streamers) {
      if (s.groupId === id) s.groupId = null;
    }
    this.save();
  }

  renameGroup(id, name) {
    const group = this._findGroup(id);
    if (!group) throw new Error('未找到该分组');
    group.name = this._validateName(name, '分组名不能为空');
    this.save();
    return structuredClone(group);
  }

  addStreamer({ roomId, name, groupId } = {}) {
    if (typeof roomId !== 'string' || roomId === '') {
      throw new Error('房间号不能为空');
    }
    const streamer = {
      id: crypto.randomUUID(),
      roomId,
      name: typeof name === 'string' && name.trim() !== '' ? name : `房间${roomId}`,
      groupId: groupId || null,
      isLive: false,
      liveStatus: 0,
      liveTitle: '',
      cover: '',
      areaName: '',
      uname: '',
      liveStartTime: null,
      notified: false,
      addedAt: Date.now(),
    };
    this._data.streamers.push(streamer);
    this.save();
    return structuredClone(streamer);
  }

  removeStreamer(id) {
    const streamer = this._findStreamer(id);
    if (!streamer) throw new Error('未找到该主播');
    this._data.streamers = this._data.streamers.filter((s) => s.id !== id);
    this.save();
  }

  renameStreamer(id, name) {
    const streamer = this._findStreamer(id);
    if (!streamer) throw new Error('未找到该主播');
    streamer.name = this._validateName(name, '主播名不能为空');
    this.save();
    return structuredClone(streamer);
  }

  moveStreamer(id, groupId) {
    const streamer = this._findStreamer(id);
    if (!streamer) throw new Error('未找到该主播');
    streamer.groupId = groupId || null;
    this.save();
    return structuredClone(streamer);
  }

  updateStreamer(id, patch) {
    const streamer = this._findStreamer(id);
    if (!streamer) throw new Error('未找到该主播');
    if (patch && typeof patch === 'object') {
      for (const key of Object.keys(patch)) {
        if (key === 'id') continue;
        streamer[key] = patch[key];
      }
    }
    this.save();
    return structuredClone(streamer);
  }

  getSettings() {
    return structuredClone(this._data.settings);
  }

  // 记录最近打开的直播间（去重置顶，最多保留 8 个）
  touchRecent(roomId) {
    roomId = String(roomId);
    if (!roomId) return;
    const arr = Array.isArray(this._data.recentRoomIds) ? this._data.recentRoomIds.slice() : [];
    const i = arr.indexOf(roomId);
    if (i >= 0) arr.splice(i, 1);
    arr.unshift(roomId);
    this._data.recentRoomIds = arr.slice(0, 8);
    this.save();
  }

  setSettings(patch) {
    if (patch && typeof patch === 'object') {
      Object.assign(this._data.settings, patch);
    }
    this.save();
    return structuredClone(this._data.settings);
  }
}

module.exports = Store;
