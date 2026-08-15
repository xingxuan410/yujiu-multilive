// room-preload.js — 直播间视图的 document-start 预加载脚本
// 在页面脚本执行前就拦截公告/荣誉/简介浮层与顶部站头（等效不加载）。
// 评论区收起由主进程用真实鼠标注入（sendInputEvent）完成，本脚本不负责。
(function () {
  'use strict';

  const SELECTOR = [
    '#biliMainHeader',
    '#bili-header-container',
    '.bili-header',
    '.bili-header__bar',
    '[class*="bili-header"]',
    '.header-channel',
    '[class*="head-info-section"]',
    '[class*="announce"]',
    '[class*="Announce"]',
    '[class*="honor"]',
    '[class*="Honor"]',
    '[class*="intro"]',
    '[class*="Intro"]',
    '[class*="anchor-"]',
    '[class*="Anchor-"]',
  ].join(',');

  const hide = function (el) {
    try {
      if (el && el.style) el.style.setProperty('display', 'none', 'important');
    } catch (_) {}
  };

  // 文本级兜底：顶部站头（bilibili直播 logo 所在容器）
  const sweepByText = function () {
    try {
      for (const el of document.querySelectorAll('div,header,section,nav')) {
        let own = '';
        try {
          own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
        } catch (_) {}
        if (!own || own.length > 40) continue;
        if (!/^(bilibili直播|哔哩哔哩直播)/.test(own)) continue;
        let node = el;
        for (let i = 0; i < 5 && node && node !== document.body; i++) {
          const rc = node.getBoundingClientRect();
          if (rc.top >= 0 && rc.top < 90 && rc.width > 100 && rc.width < 2400) { hide(node); break; }
          node = node.parentElement;
        }
      }
    } catch (_) {}
  };

  const sweep = function (root) {
    try {
      if (!root || !root.querySelectorAll) return;
      root.querySelectorAll(SELECTOR).forEach(hide);
    } catch (_) {}
  };

  const observer = new MutationObserver(function (muts) {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (!n || n.nodeType !== 1) continue;
        try {
          if (n.matches && n.matches(SELECTOR)) hide(n);
        } catch (_) {}
        sweep(n);
      }
    }
    sweepByText();
  });

  let probed = false;
  const probeTop = function () {
    if (probed) return;
    probed = true;
    try {
      const els = document.querySelectorAll('header, [class*="header"], [class*="Header"], [id*="header"]');
      const out = [];
      for (const el of els) {
        const rc = el.getBoundingClientRect();
        if (rc.width > 50 && rc.height > 10 && rc.top < 100) {
          out.push(el.tagName + '|' + String(el.className || '').slice(0, 70) + '|' + Math.round(rc.width) + 'x' + Math.round(rc.height) + '@' + Math.round(rc.top));
        }
        if (out.length >= 10) break;
      }
      if (out.length) console.log('[app] TOPBAR: ' + out.join(' ; '));
    } catch (_) {}
  };

  const boot = function () {
    if (observer.__started) return;
    observer.__started = true;
    try {
      const s = document.createElement('style');
      s.textContent = SELECTOR + ' { display: none !important; }';
      (document.head || document.documentElement).appendChild(s);
    } catch (_) {}
    try {
      sweep(document);
      sweepByText();
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
    // 用户操作捕获：记录你在直播间页面里的点击坐标、命中的元素、评论区可见性，
    // 用于从真实操作中定位“真正能收起评论区”的方法。
    let lastClickLog = 0;
    document.addEventListener('click', function (e) {
      try {
        const now = Date.now();
        if (now - lastClickLog < 400) return;
        lastClickLog = now;
        const els = document.elementsFromPoint(e.clientX, e.clientY).slice(0, 5)
          .map(function (el) { return el.tagName + '|' + String(el.className || '').slice(0, 45); }).join(' ; ');
        const a = document.querySelector('.aside-area');
        const asideVis = !a ? 'not-mounted' : (a.getBoundingClientRect().width > 0 ? 'visible' : 'hidden');
        console.log('[app] USERCLICK x=' + Math.round(e.clientX) + ' y=' + Math.round(e.clientY) + ' aside=' + asideVis + ' els=' + els);
      } catch (_) {}
    }, true);
    setTimeout(probeTop, 5000);
    setTimeout(sweepByText, 6000);
    startStateProbe();
  };

  /* ===== 状态探针：记录 localStorage 快照与评论区可见性变化（找“收起状态”的持久化键） ===== */
  let lastAsideVis = null;
  const dumpLS = function () {
    try {
      const out = [];
      for (let i = 0; i < localStorage.length && out.length < 40; i++) {
        const k = localStorage.key(i);
        try {
          const v = localStorage.getItem(k) || '';
          if (v && v.length < 300) out.push(k + '=' + v);
        } catch (_) {}
      }
      console.log('[app] LS: ' + out.join(' ; '));
    } catch (_) {}
  };
  const checkAside = function () {
    try {
      const a = document.querySelector('.aside-area');
      const vis = !!(a && a.getBoundingClientRect().width > 0);
      if (vis !== lastAsideVis) {
        lastAsideVis = vis;
        console.log('[app] ASIDE vis=' + vis);
        dumpLS(); // 可见性变化时（如手动收起/展开）记录一次快照
      }
    } catch (_) {}
  };
  const startStateProbe = function () {
    try { dumpLS(); } catch (_) {}
    setTimeout(dumpLS, 20000);
    setInterval(checkAside, 2000);
    try {
      const mo = new MutationObserver(checkAside);
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    } catch (_) {}
  };

  if (document.documentElement) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
