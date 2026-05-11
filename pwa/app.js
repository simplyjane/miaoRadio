(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const root = document.documentElement;
  const state = {
    queue: [],
    idx: 0,
    ytReady: false,
    player: null,
    pendingPlay: false,
    progressTimer: null,
    volume: 80,
  };

  /* ───── theme toggle ───── */
  const savedTheme = localStorage.getItem('miao.theme') || 'dark';
  setTheme(savedTheme);
  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.addEventListener('click', () => setTheme(btn.dataset.theme));
  });
  function setTheme(theme) {
    root.setAttribute('data-theme', theme);
    localStorage.setItem('miao.theme', theme);
    document.querySelectorAll('.theme-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.theme === theme);
    });
  }

  /* ───── clock ticker ───── */
  function tickClock() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    $('clock').textContent = `${hh}:${mm}`;
    const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
    const dd = String(now.getDate()).padStart(2, '0');
    const mon = now.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
    const yy = now.getFullYear();
    $('weekday').textContent = weekday;
    $('ymd').textContent = `${dd} · ${mon} · ${yy}`;
  }
  tickClock();
  setInterval(tickClock, 1000 * 15);
  setInterval(() => {
    const s = new Date().getSeconds();
    if (s < 15) tickClock();
  }, 1000);

  /* ───── YouTube IFrame ───── */
  window.onYouTubeIframeAPIReady = () => {
    state.player = new YT.Player('iframeContainer', {
      height: '100%',
      width: '100%',
      playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => {
          state.ytReady = true;
          state.player.setVolume(state.volume);
          if (state.pendingPlay) {
            state.pendingPlay = false;
            playCurrent();
          }
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.ENDED) {
            stopProgress();
            playNext();
          }
          if (e.data === YT.PlayerState.PLAYING) {
            setAir(true);
            setNowState('PLAYING');
            setIcon('pause');
            setBars(true);
            startProgress();
          }
          if (e.data === YT.PlayerState.PAUSED) {
            setNowState('PAUSED');
            setIcon('play');
            setBars(false);
            stopProgress();
          }
          if (e.data === YT.PlayerState.BUFFERING) {
            setNowState('BUFFERING');
          }
        },
        onError: () => {
          setNowState('YT ERROR · SKIPPING');
          setTimeout(playNext, 700);
        },
      },
    });
  };

  /* ───── playback control buttons ───── */
  $('btnToggle').addEventListener('click', () => {
    if (!state.player) return;
    const s = state.player.getPlayerState?.();
    if (s === YT.PlayerState.PLAYING) state.player.pauseVideo();
    else state.player.playVideo();
  });
  $('btnNext').addEventListener('click', playNext);
  $('btnPrev').addEventListener('click', playPrev);
  $('btnStop').addEventListener('click', () => {
    state.player?.stopVideo();
    setAir(false);
    setNowState('IDLE');
    setIcon('pause');
    setBars(false);
    stopProgress();
    resetProgress();
  });
  $('btnHide').addEventListener('click', () => {
    const wrap = $('iframeWrap');
    const hidden = wrap.classList.toggle('hidden');
    $('btnHide').textContent = hidden ? 'SHOW' : 'HIDE';
  });

  /* ───── volume ───── */
  $('volSlider').addEventListener('input', (e) => {
    state.volume = Number(e.target.value);
    state.player?.setVolume(state.volume);
  });

  /* ───── chat form ───── */
  $('chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('chatInput');
    const message = input.value.trim();
    if (!message) return;
    input.value = '';
    const send = $('sendBtn');
    send.disabled = true;
    setNowState('THINKING');
    setDjText('…', false);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setDjText(data.say || '(silent)', false);
      state.queue = data.play || [];
      state.idx = 0;
      renderQueue();
      renderMeta(data);

      if (data.sayAudioUrl) {
        setNowState('DJ ON AIR');
        setDjBars(true);
        await playDjPatter(data.sayAudioUrl);
        setDjBars(false);
      }
      if (state.queue.length) playCurrent();
      else { setNowState('IDLE'); setAir(false); }
    } catch (err) {
      setDjText('ERROR · ' + err.message, true);
      setNowState('ERROR');
      setAir(false);
    } finally {
      send.disabled = false;
      input.focus();
    }
  });

  /* ───── queue rendering ───── */
  function renderQueue() {
    const el = $('queue');
    $('trackCount').textContent = `${state.queue.length} TRACK${state.queue.length === 1 ? '' : 'S'}`;
    if (!state.queue.length) {
      el.innerHTML = '<li class="queue-empty">— nothing queued —</li>';
      return;
    }
    el.innerHTML = state.queue.map((s, i) => `
      <li class="${i === state.idx ? 'current' : ''}">
        <span class="qidx">${String(i + 1).padStart(2, '0')}</span>
        <span class="qtitle">${esc(s.title || s.query || '?')}</span>
        <span class="qartist">${esc(s.artist || '')}</span>
      </li>
    `).join('');
  }

  function renderMeta(data) {
    const lines = [];
    if (data.reason) lines.push(`reason · ${data.reason}`);
    if (data.segue) lines.push(`segue · ${data.segue}`);
    if (data.misses?.length) lines.push(`misses · ${data.misses.map((m) => m.query).join(' | ')}`);
    $('meta').textContent = lines.join('\n');
  }

  /* ───── playback navigation ───── */
  function playCurrent() {
    const song = state.queue[state.idx];
    if (!song) { setNowState('IDLE'); setAir(false); setBars(false); return; }
    $('nowTitle').textContent = `${song.title || song.query || '?'} · ${song.artist || ''}`;
    renderQueue();
    if (!state.ytReady || !state.player?.loadVideoById) {
      state.pendingPlay = true;
      return;
    }
    state.player.loadVideoById(song.videoId);
    reportPlay(song);
  }

  function playNext() {
    if (state.idx + 1 < state.queue.length) {
      state.idx++;
      playCurrent();
    } else {
      setNowState('END OF QUEUE');
      setAir(false);
      setBars(false);
      stopProgress();
    }
  }

  function playPrev() {
    if (state.idx > 0) {
      state.idx--;
      playCurrent();
    }
  }

  function reportPlay(song) {
    fetch('/api/played', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: song.videoId,
        title: song.title,
        artist: song.artist,
        query: song.query,
      }),
    }).catch((err) => console.warn('[played]', err));
  }

  /* ───── DJ patter playback (hidden audio) ───── */
  function playDjPatter(url) {
    return new Promise((resolve) => {
      const audio = $('djAudio');
      audio.src = url;
      const done = () => {
        audio.removeEventListener('ended', done);
        audio.removeEventListener('error', done);
        resolve();
      };
      audio.addEventListener('ended', done);
      audio.addEventListener('error', done);
      audio.play().catch(() => done());
    });
  }

  /* ───── progress polling ───── */
  function startProgress() {
    stopProgress();
    state.progressTimer = setInterval(updateProgress, 500);
    updateProgress();
  }
  function stopProgress() {
    if (state.progressTimer) { clearInterval(state.progressTimer); state.progressTimer = null; }
  }
  function updateProgress() {
    if (!state.player) return;
    const cur = state.player.getCurrentTime?.() ?? 0;
    const dur = state.player.getDuration?.() ?? 0;
    $('curTime').textContent = fmtTime(cur);
    $('totalTime').textContent = fmtTime(dur);
    const pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;
    $('trackFill').style.width = pct + '%';
  }
  function resetProgress() {
    $('curTime').textContent = '0:00';
    $('totalTime').textContent = '0:00';
    $('trackFill').style.width = '0%';
  }
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  /* ───── visual state helpers ───── */
  function setAir(on) { $('airStatus').classList.toggle('on', !!on); }
  function setNowState(t) { $('nowState').textContent = t; }
  function setBars(playing) { $('bars').classList.toggle('playing', !!playing); }
  function setDjBars(playing) { $('djBars').classList.toggle('playing', !!playing); }
  function setIcon(which) {
    $('iconPlay').style.display = which === 'play' ? '' : 'none';
    $('iconPause').style.display = which === 'pause' ? '' : 'none';
  }
  function setDjText(text, isError) {
    const el = $('djSay');
    const txt = $('djSayText');
    el.classList.toggle('error', !!isError);
    if (isError) {
      el.innerHTML = '';
      el.textContent = text;
    } else {
      // restore quote marks if they got stripped earlier
      if (!el.querySelector('#djSayText')) {
        el.innerHTML = '<span class="quote-mark">&ldquo;</span><span id="djSayText"></span><span class="quote-mark">&rdquo;</span>';
      }
      document.getElementById('djSayText').textContent = text;
    }
  }
})();
