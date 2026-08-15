(function () {
  function onReady() {
    const params = new URLSearchParams(location.search);

    // URLSearchParams.get 已完成解码，直接使用即可。
    const name = params.get('name') || '';
    const title = params.get('title') || '';
    const area = params.get('area') || '';
    const cover = params.get('cover') || '';
    const roomId = params.get('roomId') || '';
    const durationRaw = params.get('durationMs');
    const durationMs = Number(durationRaw);
    // 非法或非正的时长回退到默认 10000ms。
    const safeDuration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 10000;

    const nameEl = document.getElementById('name');
    const titleEl = document.getElementById('title');
    const metaEl = document.getElementById('meta');
    const coverImg = document.getElementById('cover');
    const placeholderEl = document.getElementById('placeholder');
    const card = document.getElementById('card');
    const closeBtn = document.getElementById('closeBtn');
    const barFill = document.getElementById('barFill');

    nameEl.textContent = name;
    titleEl.textContent = title;
    metaEl.textContent = area ? area + ' · 点击观看' : '点击观看';

    function showPlaceholder() {
      coverImg.style.display = 'none';
      placeholderEl.style.display = 'flex';
    }

    if (cover) {
      coverImg.onerror = showPlaceholder;
      coverImg.src = cover;
      coverImg.style.display = 'block';
      placeholderEl.style.display = 'none';
    } else {
      showPlaceholder();
    }

    card.addEventListener('click', function () {
      if (window.popup && typeof window.popup.open === 'function') {
        window.popup.open(roomId);
      }
    });

    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (window.popup && typeof window.popup.close === 'function') {
        window.popup.close();
      }
    });

    // 进度条：挂载后下一次绘制前把 transition 时长定为目标值，
    // 再在后续帧把宽度降到 0 触发动画。
    barFill.style.transition = 'width ' + safeDuration + 'ms linear';

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        barFill.style.width = '0';
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})();
