(() => {
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

  const state = {
    queue: [],
    idx: 0,
    ytReady: false,
    player: null,
    pendingPlay: false,
  };

  window.onYouTubeIframeAPIReady = () => {
    state.player = new YT.Player('iframeContainer', {
      height: '100%',
      width: '100%',
      playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => {
          state.ytReady = true;
          if (state.pendingPlay) {
            state.pendingPlay = false;
            playCurrent();
          }
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.ENDED) playNext();
          if (e.data === YT.PlayerState.PLAYING) setStatus('on air');
          if (e.data === YT.PlayerState.PAUSED) setStatus('paused');
        },
        onError: (e) => {
          console.warn('[yt error]', e.data);
          setStatus('yt error → 跳下一首');
          setTimeout(playNext, 800);
        },
      },
    });
  };

  $('chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('chatInput');
    const message = input.value.trim();
    if (!message) return;
    input.value = '';
    const button = e.target.querySelector('button');
    button.disabled = true;
    setStatus('thinking…');
    $('djSay').innerHTML = '<em>…</em>';

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      $('djSay').textContent = data.say || '(silent)';
      state.queue = data.play || [];
      state.idx = 0;
      renderQueue();
      renderMeta(data);

      if (data.sayAudioUrl) {
        await playDjPatter(data.sayAudioUrl);
      }
      if (state.queue.length) playCurrent();
      else setStatus('idle');
    } catch (err) {
      console.error(err);
      $('djSay').textContent = '出错了：' + err.message;
      setStatus('error');
    } finally {
      button.disabled = false;
      input.focus();
    }
  });

  function renderQueue() {
    const el = $('queue');
    if (!state.queue.length) {
      el.innerHTML = '<li class="empty">尚无曲目</li>';
      return;
    }
    el.innerHTML = state.queue.map((s, i) => `
      <li class="${i === state.idx ? 'current' : ''}">
        <span class="idx">${String(i + 1).padStart(2, '0')}</span>
        <span class="title">${escapeHtml(s.title || s.query || '?')}</span>
        <span class="artist">${escapeHtml(s.artist || '')}</span>
      </li>
    `).join('');
  }

  function renderMeta(data) {
    const lines = [];
    if (data.reason) lines.push(`reason: ${data.reason}`);
    if (data.segue) lines.push(`segue: ${data.segue}`);
    if (data.misses?.length) {
      lines.push(`misses: ${data.misses.map((m) => m.query).join(' | ')}`);
    }
    $('meta').textContent = lines.join('\n');
  }

  function playCurrent() {
    const song = state.queue[state.idx];
    if (!song) { setStatus('idle'); return; }
    $('now').textContent = `▶  ${song.title || song.query} — ${song.artist || ''}`;
    renderQueue();

    if (!state.ytReady || !state.player?.loadVideoById) {
      state.pendingPlay = true;
      return;
    }
    state.player.loadVideoById(song.videoId);
    reportPlay(song);
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

  function playNext() {
    if (state.idx + 1 < state.queue.length) {
      state.idx++;
      playCurrent();
    } else {
      $('now').textContent = '(队列结束)';
      setStatus('idle');
    }
  }

  function setStatus(s) { $('status').textContent = s; }

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
      setStatus('on air · DJ');
      audio.play().catch(() => done());
    });
  }
})();
