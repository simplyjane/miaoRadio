(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const root = document.documentElement;
  const state = {
    user: null,           // null | { id, email, name, picture, isGuest, chatsUsed, chatsLimit }
    reactions: new Map(), // videoId → 1 (like) | -1 (dislike)
    queue: [],
    idx: 0,
    ytReady: false,
    player: null,
    pendingPlay: false,
    progressTimer: null,
    volume: 80,
    // Auto-DJ: prefetch the next batch when remaining queue time drops low.
    prefetchInflight: false,
    prefetchToken: 0,         // bumped on manual chat to invalidate stale prefetches
    pendingNext: null,        // { say, sayAudioUrl, play }
    waitingForNext: false,    // queue ended but prefetch hasn't resolved yet
  };

  const PREFETCH_THRESHOLD_SEC = 5 * 60;
  const FALLBACK_TRACK_SEC = 240; // when we can't parse a duration string

  function parseDurationSec(str) {
    if (typeof str !== 'string') return null;
    const parts = str.trim().split(':').map((p) => Number(p));
    if (parts.some((n) => !Number.isFinite(n))) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }
  function trackDur(song) {
    return parseDurationSec(song?.duration) ?? FALLBACK_TRACK_SEC;
  }

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
      playerVars: { autoplay: 1, controls: 1, rel: 0, modestbranding: 1, playsinline: 1 },
      events: {
        onReady: () => {
          state.ytReady = true;
          state.player.setVolume(state.volume);
          if (state.pendingPlay) {
            state.pendingPlay = false;
            playCurrent();
          }
          applyAutoShowIfReady();
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
    // Stopping cancels the upcoming auto-set so we don't surprise the user.
    state.prefetchToken++;
    state.pendingNext = null;
    state.waitingForNext = false;
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
      // Manual chat invalidates any in-flight or stashed prefetch.
      state.prefetchToken++;
      state.pendingNext = null;
      state.waitingForNext = false;

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      if (res.status === 402 && data.error === 'signup_required') {
        openLoginModal({
          lede: `You've used your ${data.chats_limit} trial chats. Sign up to keep going — your taste profile and history carry over.`,
        });
        setNowState('SIGN UP TO CONTINUE');
        setDjText('Trial limit reached.', true);
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.user) renderAuthPill(data.user);
      await loadShow(data);
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
    el.innerHTML = state.queue.map((s, i) => {
      const r = state.reactions.get(s.videoId) || 0;
      return `
        <li class="${i === state.idx ? 'current' : ''}">
          <span class="qidx">${String(i + 1).padStart(2, '0')}</span>
          <span class="qtitle">${esc(s.title || s.query || '?')}</span>
          <span class="qartist">${esc(s.artist || '')}</span>
          <span class="qreact">
            <button class="rx-btn ${r === 1 ? 'on' : ''}" data-vid="${esc(s.videoId)}" data-rxn="1" title="Like" type="button">♥</button>
            <button class="rx-btn ${r === -1 ? 'on bad' : ''}" data-vid="${esc(s.videoId)}" data-rxn="-1" title="Dislike — never play again" type="button">⊘</button>
          </span>
        </li>
      `;
    }).join('');
  }

  // Event delegation: one listener for all thumb buttons (rerender swaps DOM).
  $('queue').addEventListener('click', (e) => {
    const btn = e.target.closest('.rx-btn');
    if (!btn) return;
    const videoId = btn.dataset.vid;
    const clicked = Number(btn.dataset.rxn);
    if (!videoId || !clicked) return;
    const current = state.reactions.get(videoId) || 0;
    // Re-clicking the same reaction clears it; otherwise sets to clicked.
    const next = current === clicked ? 0 : clicked;
    handleReaction(videoId, next);
  });

  async function handleReaction(videoId, reaction) {
    if (reaction === 0) state.reactions.delete(videoId);
    else state.reactions.set(videoId, reaction);

    // Find queue item (for title/artist payload + possible removal).
    const item = state.queue.find((s) => s.videoId === videoId);
    try {
      await fetch('/api/reactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          videoId,
          reaction,
          title: item?.title || null,
          artist: item?.artist || null,
        }),
      });
    } catch (err) {
      console.warn('[reaction]', err);
    }

    if (reaction === -1) {
      applyDislikeToQueue(videoId);
    } else {
      renderQueue();
    }
  }

  function applyDislikeToQueue(videoId) {
    const removeIdx = state.queue.findIndex((s) => s.videoId === videoId);
    if (removeIdx < 0) { renderQueue(); return; }
    state.queue.splice(removeIdx, 1);

    if (state.queue.length === 0) {
      state.idx = 0;
      state.player?.stopVideo?.();
      stopProgress();
      resetProgress();
      setNowState('IDLE');
      setBars(false);
      setAir(false);
      renderQueue();
      return;
    }

    if (removeIdx === state.idx) {
      // Was the currently-playing track. After splice, state.queue[state.idx]
      // is what was the next track — load it. If we removed the last item,
      // fall back to playNext's end-of-queue handling.
      if (state.idx >= state.queue.length) {
        state.idx = state.queue.length; // out of bounds → playNext catches
        playNext();
      } else {
        playCurrent();
      }
    } else if (removeIdx < state.idx) {
      state.idx--;
      renderQueue();
    } else {
      renderQueue();
    }
  }

  /* First user gesture unlocks autoplay. Browsers block media on cold load
     until any pointerdown/keydown happens; we listen for it once anywhere
     on the page and immediately call playVideo() on the YT iframe. */
  let userActivated = false;
  let pendingPatterUrl = null; // patter we couldn't play because no gesture yet

  function onFirstGesture() {
    if (userActivated) return;
    userActivated = true;
    document.removeEventListener('pointerdown', onFirstGesture, true);
    document.removeEventListener('keydown', onFirstGesture, true);
    // Play the queued patter first (if any), then the video.
    const startNow = () => {
      if (state.player?.playVideo) {
        try { state.player.playVideo(); } catch {}
      }
    };
    if (pendingPatterUrl) {
      const url = pendingPatterUrl;
      pendingPatterUrl = null;
      setNowState('DJ ON AIR');
      setDjBars(true);
      playDjPatter(url).then(() => {
        setDjBars(false);
        startNow();
      });
    } else {
      startNow();
    }
  }
  document.addEventListener('pointerdown', onFirstGesture, true);
  document.addEventListener('keydown', onFirstGesture, true);

  async function loadShow(data) {
    setDjText(data.say || '(silent)', false);
    state.queue = data.play || [];
    state.idx = 0;
    renderQueue();
    renderMeta(data);

    if (!userActivated) {
      // Cold load — don't attempt audio yet. Stash patter, load the video into
      // the iframe (which shows the thumbnail), and prompt for any interaction.
      pendingPatterUrl = data.sayAudioUrl || null;
      if (state.queue.length) playCurrent();
      setNowState('▸ TAP ANYWHERE TO START');
      setAir(false);
      return;
    }

    if (data.sayAudioUrl) {
      setNowState('DJ ON AIR');
      setDjBars(true);
      await playDjPatter(data.sayAudioUrl);
      setDjBars(false);
    }
    if (state.queue.length) playCurrent();
    else { setNowState('IDLE'); setAir(false); }
  }

  /* ───── auto-start on load ─────
     Fire the fetch immediately for speed, but only apply the show once the
     YT iframe player is ready — otherwise we'd race YT init and end up with
     a queue but no video. The first track may still need one user click
     because of browser autoplay policies; subsequent transitions are fine. */
  let autoShowPromise = null;
  let autoShowApplied = false;

  function startAutoShowFetch() {
    // Guests can't auto-DJ. Show a welcome state instead.
    if (!state.user || state.user.isGuest) {
      setNowState('IDLE');
      setDjText(state.user?.isGuest
        ? `Welcome — you have ${state.user.chatsLimit - state.user.chatsUsed} trial chats. Tell me what to play.`
        : 'Tell me what to play. A mood, a scene, a song to seed from — anything.',
        false);
      return;
    }
    setNowState('TUNING IN…');
    setDjText('…', false);
    autoShowPromise = fetch('/api/auto-show', { method: 'POST', credentials: 'same-origin' })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
      })
      .catch((err) => {
        console.warn('[auto-start]', err);
        return null;
      });
  }

  async function applyAutoShowIfReady() {
    if (autoShowApplied || !autoShowPromise) return;
    if (!state.ytReady) return;
    // Skip if the user already started something themselves.
    if (state.queue.length || state.pendingNext) return;
    autoShowApplied = true;
    const data = await autoShowPromise;
    autoShowPromise = null;
    if (!data) {
      setNowState('IDLE');
      setDjText('Tell me what to play. A mood, a scene, a song to seed from — anything.', false);
      return;
    }
    if (state.queue.length || state.pendingNext) return; // raced with user
    // Make sure the iframe is visible so the first video isn't hidden.
    $('iframeWrap').classList.remove('hidden');
    $('btnHide').textContent = 'HIDE';
    await loadShow(data);
  }

  // Bootstrap: resolve auth before deciding whether to auto-tune-in.
  bootstrap();

  async function bootstrap() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      const data = await res.json();
      state.user = data.user;
      renderAuthPill(state.user);
    } catch (err) {
      console.warn('[auth/me]', err);
    }
    if (state.user) {
      try {
        const res = await fetch('/api/reactions', { credentials: 'same-origin' });
        if (res.ok) {
          const { reactions } = await res.json();
          state.reactions = new Map(reactions.map((r) => [r.video_id, r.reaction]));
        }
      } catch (err) {
        console.warn('[reactions]', err);
      }
    }
    const params = new URLSearchParams(window.location.search);
    if (params.get('login') === '1') {
      openLoginModal({
        errorCode: params.get('error') || null,
      });
    }
    if (params.get('settings') === '1') {
      const flash = params.get('calendar') === 'ok' ? 'calendar_ok' : null;
      openSettingsModal({ flash });
    }
    if (params.has('login') || params.has('settings') || params.has('error') || params.has('calendar')) {
      const url = new URL(window.location.href);
      ['login', 'settings', 'error', 'calendar'].forEach((k) => url.searchParams.delete(k));
      window.history.replaceState({}, '', url.toString());
    }
    startAutoShowFetch();
  }

  /* ───── auth pill + login modal ─────────────────────────────────────── */
  function renderAuthPill(user) {
    const pill = $('authPill');
    const name = $('authName');
    const btn = $('authBtn');
    const settingsBtn = $('settingsBtn');
    pill.hidden = false;
    if (!user || user.isGuest) {
      const label = user
        ? `GUEST · ${user.chatsLimit - user.chatsUsed}/${user.chatsLimit} CHATS LEFT`
        : 'GUEST';
      name.textContent = label;
      btn.textContent = 'SIGN UP';
      btn.dataset.action = 'open';
      settingsBtn.hidden = true;
    } else {
      name.textContent = (user.email || user.name || 'SIGNED IN').toUpperCase();
      btn.textContent = 'SIGN OUT';
      btn.dataset.action = 'signout';
      settingsBtn.hidden = false;
    }
  }

  $('authBtn').addEventListener('click', async () => {
    const action = $('authBtn').dataset.action;
    if (action === 'signout') {
      await fetch('/api/auth/signout', { method: 'POST', credentials: 'same-origin' });
      window.location.reload();
      return;
    }
    openLoginModal();
  });

  const ERROR_MESSAGES = {
    invalid_code: 'That invitation code is not valid.',
    invalid_invite: 'That invitation code is not valid.',
    invalid_state: 'Sign-in expired. Please try again.',
    missing_params: 'Google did not return the expected parameters. Please retry.',
  };

  function openLoginModal({ lede, errorCode } = {}) {
    const modal = $('loginModal');
    const ledeEl = $('loginLede');
    const errEl = $('loginError');
    if (lede) ledeEl.textContent = lede;
    if (errorCode) {
      errEl.textContent = ERROR_MESSAGES[errorCode] || errorCode;
      errEl.hidden = false;
    } else {
      errEl.hidden = true;
    }
    modal.hidden = false;
    setTimeout(() => $('inviteCode').focus(), 50);
  }

  function closeLoginModal() {
    $('loginModal').hidden = true;
  }

  $('loginClose').addEventListener('click', closeLoginModal);
  $('loginModal').addEventListener('click', (e) => {
    if (e.target.id === 'loginModal') closeLoginModal();
  });

  let codeValidateTimer = null;
  $('inviteCode').addEventListener('input', () => {
    const code = $('inviteCode').value.trim();
    const statusEl = $('inviteStatus');
    const btn = $('googleBtn');
    statusEl.textContent = '';
    statusEl.className = 'invite-status';
    btn.disabled = true;
    if (!code) return;
    clearTimeout(codeValidateTimer);
    codeValidateTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/auth/validate-code?code=${encodeURIComponent(code)}`);
        if (res.ok) {
          statusEl.textContent = '✓ valid';
          statusEl.className = 'invite-status ok';
          btn.disabled = false;
        } else {
          statusEl.textContent = '✗ invalid code';
          statusEl.className = 'invite-status bad';
        }
      } catch {
        statusEl.textContent = '✗ network error';
        statusEl.className = 'invite-status bad';
      }
    }, 250);
  });

  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('inviteCode').value.trim();
    if (!code) return;
    // Full-page navigation to the OAuth start endpoint.
    window.location.href = `/api/auth/start?code=${encodeURIComponent(code)}`;
  });

  /* ───── settings drawer ─────────────────────────────────────────────── */
  $('settingsBtn').addEventListener('click', () => openSettingsModal());
  $('settingsClose').addEventListener('click', closeSettingsModal);
  $('settingsModal').addEventListener('click', (e) => {
    if (e.target.id === 'settingsModal') closeSettingsModal();
  });

  async function openSettingsModal({ flash } = {}) {
    if (!state.user || state.user.isGuest) {
      openLoginModal();
      return;
    }
    $('settingsModal').hidden = false;
    $('settingsError').hidden = true;
    $('settingsOk').hidden = true;
    if (flash === 'calendar_ok') {
      $('settingsOk').textContent = 'Google Calendar connected.';
      $('settingsOk').hidden = false;
    }
    try {
      const [corpusRes, settingsRes] = await Promise.all([
        fetch('/api/me/corpus', { credentials: 'same-origin' }),
        fetch('/api/me/settings', { credentials: 'same-origin' }),
      ]);
      const corpus = await corpusRes.json();
      const settings = await settingsRes.json();
      $('setTaste').value = corpus.taste || '';
      $('setRoutines').value = corpus.routines || '';
      $('setMood').value = corpus.mood_rules || '';
      $('setCity').value = settings.weather_city || '';
      $('setVoice').value = settings.tts_reference_id || '';
      renderCalendarStatus(settings);
    } catch (err) {
      $('settingsError').textContent = 'Failed to load settings: ' + err.message;
      $('settingsError').hidden = false;
    }
  }

  function closeSettingsModal() {
    $('settingsModal').hidden = true;
  }

  function renderCalendarStatus({ calendar_connected, calendar_email }) {
    const statusEl = $('calStatus');
    const connectBtn = $('calConnectBtn');
    const disconnectBtn = $('calDisconnectBtn');
    if (calendar_connected) {
      statusEl.textContent = calendar_email ? `Connected · ${calendar_email}` : 'Connected';
      connectBtn.hidden = true;
      disconnectBtn.hidden = false;
    } else {
      statusEl.textContent = 'Not connected';
      connectBtn.hidden = false;
      disconnectBtn.hidden = true;
    }
  }

  $('calConnectBtn').addEventListener('click', () => {
    window.location.href = '/api/me/calendar/start';
  });

  $('calDisconnectBtn').addEventListener('click', async () => {
    await fetch('/api/me/calendar/disconnect', { method: 'POST', credentials: 'same-origin' });
    renderCalendarStatus({ calendar_connected: false });
  });

  $('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('settingsSaveBtn');
    btn.disabled = true;
    $('settingsError').hidden = true;
    $('settingsOk').hidden = true;
    try {
      const corpusRes = await fetch('/api/me/corpus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          taste: $('setTaste').value,
          routines: $('setRoutines').value,
          mood_rules: $('setMood').value,
        }),
      });
      if (!corpusRes.ok) throw new Error('corpus save failed');
      const settingsRes = await fetch('/api/me/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          weather_city: $('setCity').value,
          tts_reference_id: $('setVoice').value,
        }),
      });
      if (!settingsRes.ok) throw new Error('settings save failed');
      $('settingsOk').textContent = 'Saved.';
      $('settingsOk').hidden = false;
    } catch (err) {
      $('settingsError').textContent = 'Save failed: ' + err.message;
      $('settingsError').hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  function renderMeta(data) {
    const lines = [];
    if (data.reason) lines.push(`reason · ${data.reason}`);
    if (data.segue) lines.push(`segue · ${data.segue}`);
    if (data.misses?.length) lines.push(`misses · ${data.misses.map((m) => m.query).join(' | ')}`);
    const el = $('meta');
    const base = lines.join('\n');
    el.dataset.base = base;
    el.textContent = base;
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
      return;
    }
    // Queue exhausted. If a prefetched continuation is ready, splice it in
    // after speaking the DJ patter. Otherwise wait for the in-flight prefetch.
    if (state.pendingNext) {
      consumePendingNext();
      return;
    }
    if (state.prefetchInflight) {
      state.waitingForNext = true;
      setNowState('WAITING FOR NEXT SET');
      setBars(false);
      stopProgress();
      return;
    }
    setNowState('END OF QUEUE');
    setAir(false);
    setBars(false);
    stopProgress();
  }

  async function consumePendingNext() {
    const next = state.pendingNext;
    state.pendingNext = null;
    state.waitingForNext = false;
    if (!next || !next.play?.length) {
      setNowState('END OF QUEUE');
      setAir(false);
      setBars(false);
      stopProgress();
      return;
    }
    setDjText(next.say || '(silent)', false);
    renderMeta(next);
    if (next.sayAudioUrl) {
      setNowState('DJ ON AIR');
      setAir(true);
      setDjBars(true);
      await playDjPatter(next.sayAudioUrl);
      setDjBars(false);
    }
    state.queue = state.queue.concat(next.play);
    state.idx = state.idx + 1; // step into the first new track
    renderQueue();
    playCurrent();
  }

  function remainingQueueSec() {
    if (!state.queue.length) return 0;
    let total = 0;
    const cur = state.player?.getCurrentTime?.() ?? 0;
    const dur = state.player?.getDuration?.() ?? 0;
    if (dur > 0) total += Math.max(0, dur - cur);
    else total += trackDur(state.queue[state.idx]);
    for (let i = state.idx + 1; i < state.queue.length; i++) {
      total += trackDur(state.queue[i]);
    }
    return total;
  }

  function maybeStartPrefetch() {
    if (state.prefetchInflight || state.pendingNext) return;
    if (!state.queue.length) return;
    if (remainingQueueSec() > PREFETCH_THRESHOLD_SEC) return;
    // Auto-DJ continuation is signed-in-only. Guests get manually-seeded
    // shows; the queue ends in IDLE and they can chat (or sign up).
    if (!state.user || state.user.isGuest) {
      renderPrefetchHint('AUTO-DJ · SIGN IN TO CONTINUE');
      return;
    }
    startPrefetch();
  }

  async function startPrefetch() {
    state.prefetchInflight = true;
    const token = ++state.prefetchToken;
    renderPrefetchHint('PREPARING NEXT SET…');
    try {
      const res = await fetch('/api/auto-show', { method: 'POST', credentials: 'same-origin' });
      const data = await res.json();
      if (token !== state.prefetchToken) return; // invalidated
      if (res.status === 401 || res.status === 403) {
        renderPrefetchHint('AUTO-DJ · SIGN IN TO CONTINUE');
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.play?.length) {
        renderPrefetchHint('AUTO-DJ · NO PICKS');
        return;
      }
      state.pendingNext = data;
      renderPrefetchHint(`NEXT SET READY · ${data.play.length} TRACK${data.play.length === 1 ? '' : 'S'}`);
      // If the queue already ended while we were fetching, splice in now.
      if (state.waitingForNext) consumePendingNext();
    } catch (err) {
      console.warn('[auto-show]', err);
      renderPrefetchHint('AUTO-DJ ERROR · ' + (err.message || 'unknown'));
    } finally {
      state.prefetchInflight = false;
    }
  }

  function renderPrefetchHint(text) {
    const el = document.getElementById('meta');
    if (!el) return;
    const base = (el.dataset.base ?? el.textContent ?? '').replace(/\n?auto · .*/i, '').trim();
    el.dataset.base = base;
    el.textContent = (base ? base + '\n' : '') + 'auto · ' + text;
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
      credentials: 'same-origin',
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
    maybeStartPrefetch();
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
