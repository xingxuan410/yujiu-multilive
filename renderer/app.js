/* 宇宙人的监控室 —— 主界面渲染进程 */
'use strict';

(function () {
  let state = { groups: [], streamers: [], settings: {} };
  let rooms = [];
  let lastRoomId = null; // 上一次点击的直播间（收起侧边栏后的快捷开关作用于它）

  /* ================= 通用组件 ================= */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function toast(text, type) {
    if (!text) return;
    const root = document.getElementById('toast-root');
    const t = el('div', 'toast ' + (type === 'error' ? 'error' : 'info'), text);
    root.appendChild(t);
    setTimeout(() => {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, 3000);
  }

  let modalCount = 0;

  function openModal(opts) {
    const root = document.getElementById('modal-root');
    const mask = el('div', 'modal-mask');
    const modal = el('div', 'modal');

    if (opts.title) modal.appendChild(el('div', 'modal-title', opts.title));

    const body = el('div', 'modal-body');
    if (opts.body) body.appendChild(opts.body);
    modal.appendChild(body);

    const foot = el('div', 'modal-foot');
    (opts.buttons || []).forEach(b => {
      const btn = el('button', 'btn ' + (b.cls || ''), b.label);
      btn.addEventListener('click', () => {
        if (b.onClick) b.onClick(close);
      });
      foot.appendChild(btn);
    });
    modal.appendChild(foot);

    mask.appendChild(modal);
    root.appendChild(mask);

    // 弹窗在渲染层，会被直播间原生视图盖住：打开时让主进程暂时隐藏画面
    modalCount++;
    try { api.setOverlay(true); } catch {}

    function close() {
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      modalCount = Math.max(0, modalCount - 1);
      if (modalCount === 0) {
        try { api.setOverlay(false); } catch {}
      }
    }

    mask.addEventListener('click', (e) => {
      if (e.target === mask) close();
    });

    return close;
  }

  function confirmModal(text) {
    return new Promise(resolve => {
      const body = el('div');
      body.appendChild(el('div', 'hint', text));
      openModal({
        title: '确认',
        body,
        buttons: [
          { label: '取消', cls: 'ghost', onClick: (close) => { close(); resolve(false); } },
          { label: '确定', cls: 'primary', onClick: (close) => { close(); resolve(true); } }
        ]
      });
    });
  }

  function ok(r) {
    return !!(r && r.ok);
  }

  function errText(r, err) {
    if (r && r.error) return r.error;
    if (err && err.message) return err.message;
    return String(err || '');
  }

  /* ================= 渲染 ================= */

  function renderAll() {
    renderSidebar();
    renderGroups();
    renderStat();
    renderRoomsPanel();
  }

  function renderSidebar() {
    const collapsed = !!(state.settings && state.settings.sidebarCollapsed);
    document.getElementById('sidebar').classList.toggle('collapsed', collapsed);
    const btn = document.getElementById('btn-toggle-sidebar');
    if (btn) btn.textContent = collapsed ? '»' : '«';
  }

  function renderStat() {
    const total = state.streamers.length;
    const live = state.streamers.filter(s => s.isLive).length;
    document.getElementById('stat').textContent = `关注 ${total} · 直播中 ${live}`;
  }

  function streamerStatusClass(s) {
    if (s.isLive) return 'live';
    if (s.liveStatus === 2) return 'replay';
    return 'off';
  }

  function streamerRow(s) {
    const row = el('div', 'streamer');
    row.dataset.id = s.id;

    const info = el('div', 's-info');
    const line = el('div', 's-line');
    line.appendChild(el('span', 'dot ' + streamerStatusClass(s)));
    line.appendChild(el('span', 's-name', s.name || ('房间' + s.roomId)));
    line.appendChild(el('span', 's-rid', '房间 ' + s.roomId));
    info.appendChild(line);

    const ops = el('div', 'ops');
    ops.appendChild(opButton('✏️', '编辑', () => openEditModal(s)));
    ops.appendChild(opButton('🗑', '删除', async () => {
      const yes = await confirmModal(`确定删除主播「${s.name || s.roomId}」吗？`);
      if (!yes) return;
      try {
        const r = await api.removeStreamer(s.id);
        if (!ok(r)) { toast(errText(r)); return; }
        toast('已删除 ' + (s.name || s.roomId));
      } catch (e) { toast(errText(null, e), 'error'); }
    }));

    row.appendChild(info);
    row.appendChild(ops);

    // 单击直接打开（含未开播），无确认弹窗；双击的第二次点击走 focusRoom，无副作用
    row.addEventListener('click', () => {
      lastRoomId = s.roomId;
      open(s.roomId);
    });

    ops.addEventListener('click', (e) => e.stopPropagation());

    return row;
  }

  function opButton(icon, title, fn) {
    const b = el('button', '', icon);
    b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  }

  // 组内排序：羽啾（房间号固定）永远置顶，其次直播中 → 轮播 → 未开播
  const PINNED_ROOM = '1727074031';
  function sortMembers(arr) {
    return arr.slice().sort((a, b) => {
      const pa = a.roomId === PINNED_ROOM ? 0 : 1;
      const pb = b.roomId === PINNED_ROOM ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const la = a.isLive ? 0 : (a.liveStatus === 2 ? 1 : 2);
      const lb = b.isLive ? 0 : (b.liveStatus === 2 ? 1 : 2);
      return la - lb;
    });
  }

  function renderGroups() {
    const list = document.getElementById('groups-list');
    list.textContent = '';

    state.groups.forEach(g => {
      const members = state.streamers.filter(s => s.groupId === g.id);
      list.appendChild(groupBlock(g, sortMembers(members)));
    });

    const ungrouped = state.streamers.filter(s => !s.groupId);
    list.appendChild(groupBlock(null, sortMembers(ungrouped)));
  }

  function groupBlock(g, members) {
    const liveCount = members.filter(s => s.isLive).length;
    const name = g ? g.name : '未分组';
    const key = g ? g.id : '__ungrouped__';
    const collapsedList = (state.settings && state.settings.collapsedGroups) || [];
    const collapsed = collapsedList.includes(key);

    const block = el('div', 'group');
    block.classList.toggle('collapsed', collapsed);

    const head = el('div', 'group-head');
    const fold = el('button', 'fold-btn', collapsed ? '▸' : '▾');
    fold.title = collapsed ? '展开分组' : '折叠分组';
    fold.addEventListener('click', async (e) => {
      e.stopPropagation();
      const next = collapsedList.slice();
      const i = next.indexOf(key);
      if (i >= 0) next.splice(i, 1); else next.push(key);
      try {
        const r = await api.setSettings({ collapsedGroups: next });
        if (!ok(r)) toast(errText(r));
      } catch (err) { toast(errText(null, err), 'error'); }
    });
    head.appendChild(fold);
    head.appendChild(el('span', 'g-name', name));
    head.appendChild(el('span', 'g-count', `${liveCount}/${members.length}`));

    if (g) {
      const ops = el('div', 'ops');
      ops.appendChild(opButton('✏️', '重命名', () => openRenameGroupModal(g)));
      ops.appendChild(opButton('🗑', '删除', async () => {
        const yes = await confirmModal('删除分组后，该组主播将移到「未分组」，确认删除？');
        if (!yes) return;
        try {
          const r = await api.removeGroup(g.id);
          if (!ok(r)) { toast(errText(r)); return; }
          toast('已删除分组 ' + g.name);
        } catch (e) { toast(errText(null, e), 'error'); }
      }));
      head.appendChild(ops);
    }

    block.appendChild(head);

    if (members.length === 0) {
      const empty = el('div', 'streamer', '');
      empty.style.cursor = 'default';
      const info = el('div', 's-info');
      info.appendChild(el('span', 's-rid', '（空）'));
      empty.appendChild(info);
      block.appendChild(empty);
    } else {
      members.forEach(s => block.appendChild(streamerRow(s)));
    }

    return block;
  }

  function renderRoomsPanel() {
    const panel = document.getElementById('rooms-panel');
    if (!rooms || rooms.length === 0) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const collapsed = !!(state.settings && state.settings.roomsPanelCollapsed);
    panel.classList.toggle('collapsed', collapsed);
    const btn = document.getElementById('btn-toggle-rooms');
    if (btn) btn.textContent = collapsed ? '▸' : '▾';
  }

  function renderRooms() {
    renderRoomsPanel();
    const chips = document.getElementById('rooms-chips');
    chips.textContent = '';

    rooms.forEach(room => {
      const chip = el('div', 'chip');
      chip.appendChild(el('span', 'chip-name', room.name || ('房间' + room.roomId)));

      const muteBtn = el('button', '', room.muted ? '🔇' : '🔊');
      muteBtn.title = room.muted ? '取消静音' : '静音';
      muteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const r = await api.setMute({ roomId: room.roomId, muted: !room.muted });
          if (!ok(r)) toast(errText(r));
        } catch (err) { toast(errText(null, err), 'error'); }
      });
      chip.appendChild(muteBtn);

      const chatBtn = el('button', '', '💬');
      chatBtn.title = room.chatHidden ? '展开评论栏（发弹幕）' : '收起评论栏';
      chatBtn.style.opacity = room.chatHidden ? '0.55' : '1';
      chatBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const r = await api.toggleChat(room.roomId);
          if (!ok(r)) toast(errText(r));
        } catch (err) { toast(errText(null, err), 'error'); }
      });
      chip.appendChild(chatBtn);

      const closeBtn = el('button', '', '✕');
      closeBtn.title = '关闭';
      closeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const r = await api.closeRoom(room.roomId);
          if (!ok(r)) toast(errText(r));
        } catch (err) { toast(errText(null, err), 'error'); }
      });
      chip.appendChild(closeBtn);

      chip.addEventListener('click', () => {
        lastRoomId = room.roomId;
        api.focusRoom(room.roomId).then(r => { if (!ok(r)) toast(errText(r)); }).catch(err => toast(errText(null, err), 'error'));
      });

      chips.appendChild(chip);
    });

    // 收起侧边栏后的快捷开关状态（作用于上一次点击的直播间）
    const target = rooms.find((r) => r.roomId === lastRoomId) || rooms[rooms.length - 1];
    const caChat = document.getElementById('btn-ca-chat');
    if (caChat && target) {
      caChat.style.opacity = target.chatHidden ? '0.55' : '1';
      caChat.title = target.chatHidden ? '展开评论栏（' + (target.name || target.roomId) + '）' : '收起评论栏（' + (target.name || target.roomId) + '）';
    }
  }

  function open(roomId) {
    api.openRoom(roomId).then(r => { if (!ok(r)) toast(errText(r)); }).catch(err => toast(errText(null, err), 'error'));
  }

  /* ================= 模态 ================= */

  // 添加主播
  function openAddStreamerModal() {
    let resolved = null; // 解析结果 info

    const body = el('div');

    const input = document.createElement('input');
    input.className = 'input';
    input.placeholder = '直播间链接或房间号，如 https://live.bilibili.com/12345';
    body.appendChild(input);

    const resolveBtn = el('button', 'btn ghost', '解析');
    body.appendChild(resolveBtn);

    const previewWrap = el('div');
    const groupRow = el('div');
    groupRow.style.display = 'none';
    body.appendChild(previewWrap);
    body.appendChild(groupRow);

    let closeFn;

    const doneBtn = el('button', 'btn primary', '确认添加');
    doneBtn.disabled = true;
    const cancelBtn = el('button', 'btn ghost', '取消');

    function buildGroupSelect(selectedVal) {
      groupRow.textContent = '';
      const field = el('label', 'field');
      field.appendChild(el('span', '', '分组'));
      const sel = document.createElement('select');
      sel.className = 'input';

      const optNone = document.createElement('option');
      optNone.value = '';
      optNone.textContent = '无分组';
      sel.appendChild(optNone);

      state.groups.forEach(g => {
        const o = document.createElement('option');
        o.value = g.id;
        o.textContent = g.name;
        sel.appendChild(o);
      });

      const optNew = document.createElement('option');
      optNew.value = '__new__';
      optNew.textContent = '＋新建分组…';
      sel.appendChild(optNew);

      if (selectedVal) sel.value = selectedVal;

      sel.addEventListener('change', async () => {
        if (sel.value === '__new__') {
          const name = await promptTextModal('新建分组', '分组名称');
          if (!name) { sel.value = selectedVal || ''; return; }
          try {
            const r = await api.addGroup(name);
            if (!ok(r)) { toast(errText(r)); sel.value = selectedVal || ''; return; }
            toast('已新建分组 ' + name);
            const newId = r.group ? r.group.id : (name);
            buildGroupSelect(newId);
          } catch (e) { toast(errText(null, e), 'error'); sel.value = selectedVal || ''; }
        }
      });

      field.appendChild(sel);
      groupRow.appendChild(field);
    }

    resolveBtn.addEventListener('click', async () => {
      const val = input.value.trim();
      if (!val) { toast('请输入直播间链接或房间号', 'error'); return; }
      resolveBtn.disabled = true;
      try {
        const r = await api.resolveRoom(val);
        if (!ok(r)) {
          toast(errText(r), 'error');
          resolveBtn.disabled = false;
          return;
        }
        resolved = r.info || r.data;
        if (!resolved || !resolved.roomId) {
          toast('解析失败：未获取到房间信息', 'error');
          resolveBtn.disabled = false;
          return;
        }
        renderPreview(previewWrap, resolved);
        groupRow.style.display = '';
        buildGroupSelect('');
        doneBtn.disabled = false;
      } catch (e) {
        toast(errText(null, e), 'error');
      } finally {
        resolveBtn.disabled = false;
      }
    });

    function renderPreview(wrap, info) {
      wrap.textContent = '';
      const pv = el('div', 'preview');
      if (info.cover) {
        const img = document.createElement('img');
        img.src = info.cover;
        img.alt = '';
        pv.appendChild(img);
      }
      const pinfo = el('div', 'p-info');
      pinfo.appendChild(el('div', 'p-name', info.name || ('房间' + info.roomId)));
      if (info.title) pinfo.appendChild(el('div', 'p-title', info.title));
      const line = el('div');
      if (info.areaName) line.appendChild(el('span', 'p-area', info.areaName));
      const isLive = info.liveStatus === 1;
      line.appendChild(el('span', 'badge ' + (isLive ? 'live' : 'off'), isLive ? '直播中' : (info.liveStatus === 2 ? '轮播' : '未开播')));
      pinfo.appendChild(line);
      pv.appendChild(pinfo);
      wrap.appendChild(pv);
    }

    doneBtn.addEventListener('click', async () => {
      if (!resolved) return;
      let groupId = '';
      const sel = groupRow.querySelector('select');
      if (sel) groupId = sel.value === '__new__' ? '' : sel.value;
      doneBtn.disabled = true;
      try {
        const r = await api.addStreamer({
          roomId: String(resolved.roomId),
          name: resolved.name || '',
          groupId: groupId || null
        });
        if (!ok(r)) { toast(errText(r), 'error'); doneBtn.disabled = false; return; }
        toast('已添加 ' + (resolved.name || resolved.roomId));
        if (closeFn) closeFn();
      } catch (e) {
        toast(errText(null, e), 'error');
        doneBtn.disabled = false;
      }
    });

    closeFn = openModal({
      title: '添加主播',
      body,
      buttons: [
        { label: '取消', cls: 'ghost', onClick: (close) => close() },
        { label: '确认添加', cls: 'primary', onClick: () => doneBtn.click() }
      ]
    });

    // 同时禁用底部按钮，用自绘按钮统一控制
    doneBtn.style.display = 'none';
    cancelBtn.style.display = 'none';
  }

  // 编辑主播（改名 + 移动分组）
  function openEditModal(s) {
    const body = el('div');

    const nameField = el('label', 'field');
    nameField.appendChild(el('span', '', '主播名'));
    const nameInput = document.createElement('input');
    nameInput.className = 'input';
    nameInput.value = s.name || '';
    nameField.appendChild(nameInput);
    body.appendChild(nameField);

    const groupField = el('label', 'field');
    groupField.appendChild(el('span', '', '分组'));
    const sel = document.createElement('select');
    sel.className = 'input';

    const optNone = document.createElement('option');
    optNone.value = '';
    optNone.textContent = '无分组';
    sel.appendChild(optNone);

    state.groups.forEach(g => {
      const o = document.createElement('option');
      o.value = g.id;
      o.textContent = g.name;
      sel.appendChild(o);
    });

    sel.value = s.groupId || '';
    groupField.appendChild(sel);
    body.appendChild(groupField);

    openModal({
      title: '编辑主播',
      body,
      buttons: [
        { label: '取消', cls: 'ghost', onClick: (close) => close() },
        {
          label: '保存',
          cls: 'primary',
          onClick: async (close) => {
            const name = nameInput.value.trim();
            if (!name) { toast('主播名不能为空', 'error'); return; }
            const groupId = sel.value || null;
            try {
              if (name !== (s.name || '')) {
                const r1 = await api.renameStreamer({ id: s.id, name });
                if (!ok(r1)) { toast(errText(r1)); return; }
              }
              if (groupId !== (s.groupId || null)) {
                const r2 = await api.moveStreamer({ id: s.id, groupId });
                if (!ok(r2)) { toast(errText(r2)); return; }
              }
              close();
            } catch (e) { toast(errText(null, e), 'error'); }
          }
        }
      ]
    });
  }

  // 重命名分组
  function openRenameGroupModal(g) {
    const body = el('div');
    const input = document.createElement('input');
    input.className = 'input';
    input.value = g.name || '';
    body.appendChild(input);

    openModal({
      title: '重命名分组',
      body,
      buttons: [
        { label: '取消', cls: 'ghost', onClick: (close) => close() },
        {
          label: '保存',
          cls: 'primary',
          onClick: async (close) => {
            const name = input.value.trim();
            if (!name) { toast('分组名不能为空', 'error'); return; }
            try {
              const r = await api.renameGroup({ id: g.id, name });
              if (!ok(r)) { toast(errText(r)); return; }
              close();
            } catch (e) { toast(errText(null, e), 'error'); }
          }
        }
      ]
    });
  }

  // 新建分组（输入名称）
  function promptTextModal(title, placeholder) {
    return new Promise(resolve => {
      const body = el('div');
      const input = document.createElement('input');
      input.className = 'input';
      if (placeholder) input.placeholder = placeholder;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') save();
      });
      body.appendChild(input);

      function save() {
        const val = input.value.trim();
        if (!val) { toast('名称不能为空', 'error'); return; }
        close(); resolve(val);
      }

      const close = openModal({
        title: title,
        body,
        buttons: [
          { label: '取消', cls: 'ghost', onClick: (c) => { c(); resolve(''); } },
          { label: '确定', cls: 'primary', onClick: save }
        ]
      });
    });
  }

  // 设置
  function openSettingsModal() {
    const s = state.settings || {};

    const body = el('div');

    const pollField = el('label', 'field');
    pollField.appendChild(el('span', '', '轮询间隔（秒）'));
    const pollInput = document.createElement('input');
    pollInput.type = 'number';
    pollInput.min = '10';
    pollInput.max = '600';
    pollInput.step = '10';
    pollInput.className = 'input';
    pollInput.value = s.pollIntervalSec != null ? s.pollIntervalSec : 60;
    pollField.appendChild(pollInput);
    body.appendChild(pollField);

    const durField = el('label', 'field');
    durField.appendChild(el('span', '', '弹窗停留（秒）'));
    const durInput = document.createElement('input');
    durInput.type = 'number';
    durInput.min = '3';
    durInput.max = '60';
    durInput.step = '1';
    durInput.className = 'input';
    durInput.value = s.popupDurationSec != null ? s.popupDurationSec : 10;
    durField.appendChild(durInput);
    body.appendChild(durField);

    const sysCheck = el('label', 'check');
    const sysInput = document.createElement('input');
    sysInput.type = 'checkbox';
    sysInput.checked = !!s.systemNotification;
    sysCheck.appendChild(sysInput);
    sysCheck.appendChild(el('span', '', '系统通知'));
    body.appendChild(sysCheck);

    const notifyCheck = el('label', 'check');
    const notifyInput = document.createElement('input');
    notifyInput.type = 'checkbox';
    notifyInput.checked = s.enableNotify !== false; // 默认开启
    notifyCheck.appendChild(notifyInput);
    notifyCheck.appendChild(el('span', '', '开播通知（右下角弹窗）'));
    body.appendChild(notifyCheck);

    const trayCheck = el('label', 'check');
    const trayInput = document.createElement('input');
    trayInput.type = 'checkbox';
    trayInput.checked = !!s.minimizeToTray;
    trayCheck.appendChild(trayInput);
    trayCheck.appendChild(el('span', '', '关闭窗口时最小化到托盘'));
    body.appendChild(trayCheck);

    const prewarmCheck = el('label', 'check');
    const prewarmInput = document.createElement('input');
    prewarmInput.type = 'checkbox';
    prewarmInput.checked = s.prewarmOnStartup !== false; // 默认开启
    prewarmCheck.appendChild(prewarmInput);
    prewarmCheck.appendChild(el('span', '', '启动时预热直播间（最近2个+直播中，点开秒开）'));
    body.appendChild(prewarmCheck);

    openModal({
      title: '设置',
      body,
      buttons: [
        {
          label: '测试通知',
          cls: 'ghost',
          onClick: async () => {
            try {
              const r = await api.testNotify();
              if (!ok(r)) toast(errText(r));
            } catch (e) { toast(errText(null, e), 'error'); }
          }
        },
        { label: '取消', cls: 'ghost', onClick: (close) => close() },
        {
          label: '保存',
          cls: 'primary',
          onClick: async (close) => {
            const poll = Number(pollInput.value);
            const dur = Number(durInput.value);
            try {
              const r = await api.setSettings({
                pollIntervalSec: poll,
                popupDurationSec: dur,
                systemNotification: sysInput.checked,
                enableNotify: notifyInput.checked,
                minimizeToTray: trayInput.checked,
                prewarmOnStartup: prewarmInput.checked
              });
              if (!ok(r)) { toast(errText(r)); return; }
              toast('已保存');
              close();
            } catch (e) { toast(errText(null, e), 'error'); }
          }
        }
      ]
    });
  }

  /* ================= 打开全部直播 ================= */

  async function openAll() {
    const live = state.streamers.filter(s => s.isLive);
    if (live.length === 0) {
      toast('当前没有直播中的主播');
      return;
    }
    let firstErr = '';
    for (const s of live) {
      await new Promise(res => setTimeout(res, 120));
      lastRoomId = s.roomId;
      try {
        const r = await api.openRoom(s.roomId);
        if (!ok(r) && !firstErr) firstErr = errText(r);
      } catch (e) {
        if (!firstErr) firstErr = errText(null, e);
      }
    }
    if (firstErr) toast(firstErr, 'error');
  }

  /* ================= 事件绑定 ================= */

  function bindEvents() {
    document.getElementById('btn-add-streamer').addEventListener('click', openAddStreamerModal);
    document.getElementById('btn-open-all').addEventListener('click', openAll);
    document.getElementById('btn-toggle-sidebar').addEventListener('click', async () => {
      const collapsed = !(state.settings && state.settings.sidebarCollapsed);
      // 先立即切换视觉（流畅），再异步持久化
      state.settings = { ...(state.settings || {}), sidebarCollapsed: collapsed };
      renderSidebar();
      try {
        const r = await api.setSettings({ sidebarCollapsed: collapsed });
        if (!ok(r)) toast(errText(r));
      } catch (e) { toast(errText(null, e), 'error'); }
    });
    document.getElementById('btn-toggle-rooms').addEventListener('click', async () => {
      const collapsed = !(state.settings && state.settings.roomsPanelCollapsed);
      state.settings = { ...(state.settings || {}), roomsPanelCollapsed: collapsed };
      renderRoomsPanel();
      try {
        const r = await api.setSettings({ roomsPanelCollapsed: collapsed });
        if (!ok(r)) toast(errText(r));
      } catch (e) { toast(errText(null, e), 'error'); }
    });
    document.getElementById('btn-add-group').addEventListener('click', async () => {
      const name = await promptTextModal('新建分组', '分组名称');
      if (!name) return;
      try {
        const r = await api.addGroup(name);
        if (!ok(r)) { toast(errText(r)); return; }
        toast('已新建分组 ' + name);
      } catch (e) { toast(errText(null, e), 'error'); }
    });
    document.getElementById('btn-settings').addEventListener('click', openSettingsModal);
    document.getElementById('btn-ca-chat').addEventListener('click', async () => {
      const target = rooms.find((r) => r.roomId === lastRoomId) || rooms[rooms.length - 1];
      if (!target) { toast('请先点击一个直播间'); return; }
      try {
        const r = await api.toggleChat(target.roomId);
        if (!ok(r)) toast(errText(r));
      } catch (e) { toast(errText(null, e), 'error'); }
    });
  }

  /* ================= 初始化 ================= */

  async function init() {
    bindEvents();
    renderAll();

    try {
      const st = await api.getState();
      if (st) state = st;
    } catch (e) {
      toast('读取状态失败', 'error');
    }

    renderAll();

    api.onState(d => {
      if (d) {
        state = d;
        renderAll();
      }
    });

    api.onRooms(list => {
      rooms = list || [];
      renderRooms();
    });

    // 点击某一路直播间画面 → 它成为快捷开关的目标
    api.onActiveRoom(rid => {
      if (rid && rooms.some(r => r.roomId === rid)) {
        lastRoomId = rid;
        renderRooms();
      }
    });
  }

  init();
})();
