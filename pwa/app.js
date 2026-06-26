(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const root = document.documentElement;
  const state = {
    user: null,           // null | { id, email, name, picture, isGuest, chatsUsed, chatsLimit }
    reactions: new Map(), // videoId → 1 (like) | -1 (dislike)
    loading: false,       // true while waiting for /api/chat or /api/auto-show to return a queue
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

  /* ───── i18n (EN / FR) ───── */
  const STRINGS = {
    en: {
      dark: 'DARK', light: 'LIGHT',
      sign_in: 'SIGN IN', sign_up: 'SIGN UP', sign_out: 'SIGN OUT',
      settings: 'SETTINGS', guest: 'GUEST',
      guest_chats_left: 'GUEST · {remaining}/{limit} CHATS LEFT',
      signed_in: 'SIGNED IN',
      signed_in_as: 'SIGNED IN AS',
      air_on: 'ON AIR', air_off: 'OFF AIR',
      idle: 'IDLE', playing: 'PLAYING', paused: 'PAUSED', buffering: 'BUFFERING',
      thinking: 'THINKING', tuning_in: 'TUNING IN…', dj_on_air: 'DJ ON AIR',
      end_of_queue: 'END OF QUEUE', waiting_for_next: 'WAITING FOR NEXT SET',
      tap_to_start: '▸ TAP ANYWHERE TO START',
      yt_error: 'YT ERROR · SKIPPING',
      sign_up_to_continue: 'SIGN UP TO CONTINUE',
      error_state: 'ERROR',
      vol: 'VOL', hide: 'HIDE', show: 'SHOW',
      queue: 'QUEUE',
      track_count_one: '{n} TRACK', track_count_many: '{n} TRACKS',
      nothing_queued: '— nothing queued —',
      pulling_tracks: 'PULLING TRACKS…',
      like: 'Like', dislike: 'Dislike — never play again',
      welcome_anon: 'Tell me what to play. A mood, a scene, a song to seed from — anything.',
      welcome_guest_one: 'Welcome — you have {n} trial chat. Tell me what to play.',
      welcome_guest_many: 'Welcome — you have {n} trial chats. Tell me what to play.',
      welcome_guest_zero: 'Your {limit} trial chats are used up. Sign up to keep going — your taste and history carry over.',
      reading_the_room: 'Reading the room',
      trial_limit_reached: 'Trial limit reached.',
      error_prefix: 'ERROR · {msg}',
      service_busy_state: 'CLAUDE BUSY · RETRYING…',
      service_busy_text: 'Claude is briefly overloaded. Hold on a moment and I\'ll try again.',
      dj_voice: 'DJ VOICE',
      voice_help: 'Pick the voice the DJ uses between tracks.',
      voice_default: 'System default',
      voice_default_desc: 'Whatever Fish Audio falls back to',
      voice_asmr: 'ASMR Narrator',
      voice_asmr_desc: 'Breathy, intimate, late-night',
      voice_warm_male: 'Warm Male',
      voice_warm_male_desc: 'Mid-tone, conversational, friendly',
      voice_warm_female: 'Warm Female',
      voice_warm_female_desc: 'Soft, lyrical, gentle warmth',
      voice_dramatic: 'Cinematic Narrator',
      voice_dramatic_desc: 'Slow, weighty, film-trailer gravitas',
      voice_bilingual: 'Bilingual Mandarin',
      voice_bilingual_desc: 'Native-sounding Chinese + English',
      song_info_title: 'SONG INFO',
      song_info_loading: 'SEARCHING WIKIPEDIA…',
      song_info_empty: 'No Wikipedia entry found. Try searching the community instead.',
      song_info_wikipedia: 'WIKIPEDIA ↗',
      song_info_reddit: 'DISCUSS ON REDDIT ↗',
      song_info_artist: 'ARTIST',
      song_info_track: 'TRACK',
      chat_placeholder: 'what do you want to hear?', send: 'SEND',
      join: 'JOIN miaoRadio',
      login_lede: 'Enter your invitation code, then sign in with Google.',
      login_lede_chats_used: "You've used your {limit} trial chats. Sign up to keep going — your taste profile and history carry over.",
      invitation_code_label: 'INVITATION CODE',
      sign_in_with_google: 'SIGN IN WITH GOOGLE',
      invite_valid: '✓ valid',
      invite_invalid: '✗ invalid code',
      invite_network_error: '✗ network error',
      err_invalid_code: 'That invitation code is not valid.',
      err_invalid_state: 'Sign-in expired. Please try again.',
      err_missing_params: 'Google did not return the expected parameters. Please retry.',
      react_signup_lede: 'Sign up to save your likes and dislikes — they teach the DJ what to play (and never play) for you.',
      taste_corpus: 'TASTE CORPUS',
      taste_corpus_help: 'Free-form notes the DJ uses to know you. Languages you like, artists, decades, vibes, references.',
      taste: 'TASTE', routines: 'ROUTINES', mood_rules: 'MOOD RULES',
      environment: 'ENVIRONMENT', weather_city: 'WEATHER CITY',
      fish_voice: 'FISH AUDIO REFERENCE ID', google_calendar: 'GOOGLE CALENDAR',
      cal_not_connected: 'Not connected',
      cal_connect: 'CONNECT', cal_disconnect: 'DISCONNECT',
      cal_connected: 'Connected',
      cal_connected_with: 'Connected · {email}',
      save: 'SAVE', saved: 'Saved.',
      save_failed: 'Save failed: {err}',
      calendar_connected_msg: 'Google Calendar connected.',
      load_settings_failed: 'Failed to load settings: {err}',
      taste_placeholder: 'What kinds of music move you?',
      routines_placeholder: 'e.g. 9–12 deep work, 17–22 reading',
      mood_placeholder: 'anxious → ambient · focus → instrumental',
      city_placeholder: 'Montreal',
      voice_placeholder: '(leave blank for default voice)',
      preparing_next: 'PREPARING NEXT SET…',
      next_set_ready_one: 'NEXT SET READY · 1 TRACK',
      next_set_ready_many: 'NEXT SET READY · {n} TRACKS',
      auto_no_picks: 'AUTO-DJ · NO PICKS',
      auto_error: 'AUTO-DJ ERROR · {err}',
    },
    fr: {
      dark: 'SOMBRE', light: 'CLAIR',
      sign_in: 'CONNEXION', sign_up: 'INSCRIPTION', sign_out: 'DÉCONNEXION',
      settings: 'PARAMÈTRES', guest: 'INVITÉ',
      guest_chats_left: 'INVITÉ · {remaining}/{limit} ESSAIS',
      signed_in: 'CONNECTÉ',
      signed_in_as: 'CONNECTÉ EN TANT QUE',
      air_on: 'EN ONDES', air_off: 'HORS ONDES',
      idle: 'INACTIF', playing: 'LECTURE', paused: 'PAUSE', buffering: 'CHARGEMENT',
      thinking: 'RÉFLEXION', tuning_in: 'RECHERCHE…', dj_on_air: 'DJ EN ONDES',
      end_of_queue: 'FIN DE LA FILE', waiting_for_next: 'EN ATTENTE DU PROCHAIN SET',
      tap_to_start: '▸ TOUCHEZ POUR DÉMARRER',
      yt_error: 'ERREUR YT · IGNORÉ',
      sign_up_to_continue: 'INSCRIVEZ-VOUS POUR CONTINUER',
      error_state: 'ERREUR',
      vol: 'VOL', hide: 'CACHER', show: 'AFFICHER',
      queue: 'FILE',
      track_count_one: '{n} TITRE', track_count_many: '{n} TITRES',
      nothing_queued: '— rien en file —',
      pulling_tracks: 'CHARGEMENT DES TITRES…',
      like: "J'aime", dislike: 'Ne plus jamais jouer',
      welcome_anon: "Dites-moi quoi jouer. Une ambiance, une scène, une chanson à partir de laquelle on commence — n'importe quoi.",
      welcome_guest_one: "Bienvenue — il vous reste {n} conversation d'essai. Dites-moi quoi jouer.",
      welcome_guest_many: "Bienvenue — il vous reste {n} conversations d'essai. Dites-moi quoi jouer.",
      welcome_guest_zero: "Vos {limit} conversations d'essai sont épuisées. Inscrivez-vous pour continuer — vos goûts et votre historique seront conservés.",
      reading_the_room: "Je lis l'ambiance",
      trial_limit_reached: "Limite d'essai atteinte.",
      error_prefix: 'ERREUR · {msg}',
      service_busy_state: 'CLAUDE SATURÉ · NOUVELLE TENTATIVE…',
      service_busy_text: "Claude est temporairement saturé. Patiente un instant, je réessaie.",
      dj_voice: 'VOIX DU DJ',
      voice_help: 'Choisissez la voix que le DJ utilise entre les titres.',
      voice_default: 'Voix par défaut',
      voice_default_desc: 'Celle de Fish Audio par défaut',
      voice_asmr: 'Narrateur ASMR',
      voice_asmr_desc: 'Souffle proche, intime, fin de soirée',
      voice_warm_male: 'Voix masculine chaleureuse',
      voice_warm_male_desc: 'Tons moyens, conversationnel, amical',
      voice_warm_female: 'Voix féminine chaleureuse',
      voice_warm_female_desc: 'Douce, lyrique, chaleur tranquille',
      voice_dramatic: 'Narrateur cinématique',
      voice_dramatic_desc: 'Lent, dense, gravité de bande-annonce',
      voice_bilingual: 'Mandarin bilingue',
      voice_bilingual_desc: 'Chinois natif + anglais',
      song_info_title: 'INFO TITRE',
      song_info_loading: 'RECHERCHE DANS WIKIPÉDIA…',
      song_info_empty: 'Aucun article Wikipédia trouvé. Essayez la discussion communautaire.',
      song_info_wikipedia: 'WIKIPÉDIA ↗',
      song_info_reddit: 'EN DISCUTER SUR REDDIT ↗',
      song_info_artist: 'ARTISTE',
      song_info_track: 'TITRE',
      chat_placeholder: 'que voulez-vous entendre ?', send: 'ENVOYER',
      join: 'REJOINDRE miaoRadio',
      login_lede: "Entrez votre code d'invitation, puis connectez-vous avec Google.",
      login_lede_chats_used: "Vous avez utilisé vos {limit} conversations d'essai. Inscrivez-vous pour continuer — votre profil et votre historique seront conservés.",
      invitation_code_label: "CODE D'INVITATION",
      sign_in_with_google: 'SE CONNECTER AVEC GOOGLE',
      invite_valid: '✓ valide',
      invite_invalid: '✗ code invalide',
      invite_network_error: '✗ erreur réseau',
      err_invalid_code: "Ce code d'invitation n'est pas valide.",
      err_invalid_state: 'Connexion expirée. Veuillez réessayer.',
      err_missing_params: "Google n'a pas renvoyé les paramètres attendus. Veuillez réessayer.",
      react_signup_lede: "Inscrivez-vous pour sauvegarder vos préférences — elles apprennent au DJ ce qu'il doit jouer (et ne jamais jouer).",
      taste_corpus: 'CORPUS DE GOÛTS',
      taste_corpus_help: 'Notes libres que le DJ utilise pour vous connaître. Langues préférées, artistes, époques, ambiances, références.',
      taste: 'GOÛTS', routines: 'ROUTINES', mood_rules: "RÈGLES D'HUMEUR",
      environment: 'ENVIRONNEMENT', weather_city: 'VILLE MÉTÉO',
      fish_voice: 'ID DE RÉFÉRENCE FISH AUDIO', google_calendar: 'CALENDRIER GOOGLE',
      cal_not_connected: 'Non connecté',
      cal_connect: 'CONNECTER', cal_disconnect: 'DÉCONNECTER',
      cal_connected: 'Connecté',
      cal_connected_with: 'Connecté · {email}',
      save: 'ENREGISTRER', saved: 'Enregistré.',
      save_failed: "Échec de l'enregistrement : {err}",
      calendar_connected_msg: 'Calendrier Google connecté.',
      load_settings_failed: 'Échec du chargement des paramètres : {err}',
      taste_placeholder: 'Quels styles de musique vous touchent ?',
      routines_placeholder: 'ex. 9h–12h travail concentré, 17h–22h lecture',
      mood_placeholder: 'anxieux → ambient · concentration → instrumental',
      city_placeholder: 'Montréal',
      voice_placeholder: '(laisser vide pour la voix par défaut)',
      preparing_next: 'PRÉPARATION DU PROCHAIN SET…',
      next_set_ready_one: 'PROCHAIN SET PRÊT · 1 TITRE',
      next_set_ready_many: 'PROCHAIN SET PRÊT · {n} TITRES',
      auto_no_picks: 'AUTO-DJ · AUCUN CHOIX',
      auto_error: 'ERREUR AUTO-DJ · {err}',
    },
  };

  let lang = (() => {
    const saved = localStorage.getItem('miao.lang');
    if (saved === 'en' || saved === 'fr') return saved;
    const browser = (navigator.language || 'en').toLowerCase();
    return browser.startsWith('fr') ? 'fr' : 'en';
  })();

  function t(key, params) {
    let s = (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.split('{' + k + '}').join(v);
    return s;
  }

  function localeForLang() { return lang === 'fr' ? 'fr-CA' : 'en-CA'; }

  function applyStaticI18n() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
  }

  function setLang(l) {
    lang = (l === 'fr') ? 'fr' : 'en';
    localStorage.setItem('miao.lang', lang);
    document.documentElement.lang = lang;
    document.querySelectorAll('.lang-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.lang === lang);
    });
    applyStaticI18n();
    // Re-render dynamic state that depends on language.
    renderAuthPill(state.user);
    if (typeof updateVoiceChip === 'function') updateVoiceChip();
    tickClock();
    if (state.queue.length === 0 && !state.loading) {
      // Refresh the queue placeholder if it's currently empty/idle.
      renderQueue();
    }
    // If the IDLE welcome message is showing, refresh it.
    if (!state.queue.length && !state.player?.getPlayerState?.()) {
      const remaining = state.user ? state.user.chatsLimit - state.user.chatsUsed : null;
      let msg;
      if (state.user?.isGuest && remaining <= 0) msg = t('welcome_guest_zero', { limit: state.user.chatsLimit });
      else if (state.user?.isGuest) msg = t(remaining === 1 ? 'welcome_guest_one' : 'welcome_guest_many', { n: remaining });
      else if (!state.user) msg = t('welcome_anon');
      else msg = null;
      if (msg) setDjText(msg, false);
    }
  }

  /* ───── theme toggle ───── */
  const savedTheme = localStorage.getItem('miao.theme') || 'dark';
  setTheme(savedTheme);
  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.addEventListener('click', () => setTheme(btn.dataset.theme));
  });
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => setLang(btn.dataset.lang));
  });
  function setTheme(theme) {
    root.setAttribute('data-theme', theme);
    localStorage.setItem('miao.theme', theme);
    document.querySelectorAll('.theme-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.theme === theme);
    });
  }

  /* ───── iframe visibility (persisted, hidden by default) ───── */
  function setIframeHidden(hidden) {
    const wrap = $('iframeWrap');
    wrap.classList.toggle('hidden', hidden);
    $('btnHide').textContent = hidden ? t('show') : t('hide');
    localStorage.setItem('miao.iframeHidden', hidden ? '1' : '0');
    // When we transition from hidden to visible, force the YT player to
    // redraw at the new wrap dimensions. The player was created while the
    // wrap was 0×0 so its internal state thinks the iframe is invisible —
    // without setSize() it renders as a black rectangle even though the
    // video is playing.
    if (!hidden && state.player?.setSize) {
      requestAnimationFrame(() => {
        try {
          const w = wrap.clientWidth;
          const h = wrap.clientHeight;
          if (w && h) state.player.setSize(w, h);
        } catch {}
      });
    }
  }
  {
    const saved = localStorage.getItem('miao.iframeHidden');
    setIframeHidden(saved == null ? true : saved === '1');
  }

  /* ───── clock ticker ───── */
  function tickClock() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    $('clock').textContent = `${hh}:${mm}`;
    const loc = localeForLang();
    const weekday = now.toLocaleDateString(loc, { weekday: 'long' });
    const dd = String(now.getDate()).padStart(2, '0');
    const mon = now.toLocaleDateString(loc, { month: 'short' }).toUpperCase();
    const yy = now.getFullYear();
    $('weekday').textContent = weekday;
    $('ymd').textContent = `${dd} · ${mon} · ${yy}`;
  }
  applyStaticI18n();
  document.querySelectorAll('.lang-btn').forEach((b) => b.classList.toggle('active', b.dataset.lang === lang));
  document.documentElement.lang = lang;
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
            setNowState(t('playing'));
            setIcon('pause');
            setBars(true);
            startProgress();
          }
          if (e.data === YT.PlayerState.PAUSED) {
            setNowState(t('paused'));
            setIcon('play');
            setBars(false);
            stopProgress();
          }
          if (e.data === YT.PlayerState.BUFFERING) {
            setNowState(t('buffering'));
          }
          // iOS Safari sometimes drops loadVideoById into CUED instead of
          // auto-playing the next track. Nudge it forward.
          if (e.data === YT.PlayerState.CUED) {
            try { state.player.playVideo?.(); } catch {}
          }
        },
        onError: () => {
          setNowState(t('yt_error'));
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
    setNowState(t('idle'));
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
    setIframeHidden(!$('iframeWrap').classList.contains('hidden'));
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
    setNowState(t('thinking'));
    setDjText(t('reading_the_room'), false);
    setLoading(true, t('pulling_tracks'));

    try {
      // Manual chat invalidates any in-flight or stashed prefetch.
      state.prefetchToken++;
      state.pendingNext = null;
      state.waitingForNext = false;

      // Retry transparently on 503 service_busy (Claude API overloaded).
      // Up to 3 attempts with 2s / 4s / 8s backoff. The user sees a calmer
      // "CLAUDE BUSY · RETRYING…" status instead of a hard ERROR.
      let res, data, attempt = 0;
      while (true) {
        res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ message }),
        });
        data = await res.json().catch(() => ({}));
        if (res.status !== 503 || data?.error !== 'service_busy' || attempt >= 3) break;
        attempt++;
        setNowState(t('service_busy_state'));
        setDjText(t('service_busy_text'), false);
        await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
      }
      if (res.status === 402 && data.error === 'signup_required') {
        setLoading(false);
        openLoginModal({
          lede: t('login_lede_chats_used', { limit: data.chats_limit }),
        });
        setNowState(t('sign_up_to_continue'));
        setDjText(t('trial_limit_reached'), true);
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.user) {
        state.user = data.user;
        renderAuthPill(data.user);
      }
      setLoading(false);
      await loadShow(data);
    } catch (err) {
      setLoading(false);
      setDjText(t('error_prefix', { msg: err.message }), true);
      setNowState(t('error_state'));
      setAir(false);
    } finally {
      send.disabled = false;
      input.focus();
    }
  });

  /* ───── queue rendering ───── */
  function renderQueue() {
    const el = $('queue');
    const n = state.queue.length;
    $('trackCount').textContent = t(n === 1 ? 'track_count_one' : 'track_count_many', { n });
    if (!n) {
      el.innerHTML = `<li class="queue-empty">${esc(t('nothing_queued'))}</li>`;
      return;
    }
    const likeLabel = t('like'), dislikeLabel = t('dislike');
    el.innerHTML = state.queue.map((s, i) => {
      const r = state.reactions.get(s.videoId) || 0;
      return `
        <li class="${i === state.idx ? 'current' : ''}" data-vid="${esc(s.videoId)}">
          <span class="qidx">${String(i + 1).padStart(2, '0')}</span>
          <span class="qtitle">${esc(s.title || s.query || '?')}</span>
          <span class="qartist">${esc(s.artist || '')}</span>
          <span class="qreact">
            <button class="rx-btn ${r === 1 ? 'on' : ''}" data-vid="${esc(s.videoId)}" data-rxn="1" title="${esc(likeLabel)}" type="button">♥</button>
            <button class="rx-btn ${r === -1 ? 'on bad' : ''}" data-vid="${esc(s.videoId)}" data-rxn="-1" title="${esc(dislikeLabel)}" type="button">⊘</button>
          </span>
        </li>
      `;
    }).join('');
  }

  function renderLoadingQueue(label) {
    if (label == null) label = t('pulling_tracks');
    const el = $('queue');
    $('trackCount').textContent = label;
    el.innerHTML = Array.from({ length: 5 }, (_, i) => `
      <li class="queue-skeleton">
        <span class="qidx">${String(i + 1).padStart(2, '0')}</span>
        <span class="skel-bar skel-title"></span>
        <span class="skel-bar skel-artist"></span>
        <span class="qreact" aria-hidden="true">
          <span class="skel-bar skel-btn"></span>
          <span class="skel-bar skel-btn"></span>
        </span>
      </li>
    `).join('');
  }

  function setLoading(on, label) {
    state.loading = on;
    const dj = $('djSay');
    dj.classList.toggle('thinking', on);
    if (on) renderLoadingQueue(label);
  }

  // Event delegation on the queue: thumb buttons (existing) PLUS row taps —
  // a row click jumps playback to that track and opens the song-info popup.
  $('queue').addEventListener('click', (e) => {
    // Reaction click — handled first because the buttons are inside the row.
    const btn = e.target.closest('.rx-btn');
    if (btn) {
      if (!state.user || state.user.isGuest) {
        openLoginModal({ lede: t('react_signup_lede') });
        return;
      }
      const videoId = btn.dataset.vid;
      const clicked = Number(btn.dataset.rxn);
      if (!videoId || !clicked) return;
      const current = state.reactions.get(videoId) || 0;
      const next = current === clicked ? 0 : clicked;
      handleReaction(videoId, next);
      return;
    }
    // Row click — play this track + open info modal.
    const row = e.target.closest('.queue li');
    if (!row || row.classList.contains('queue-empty') || row.classList.contains('queue-skeleton')) return;
    const vid = row.dataset.vid;
    if (!vid) return;
    const idx = state.queue.findIndex((s) => s.videoId === vid);
    if (idx < 0) return;
    state.idx = idx;
    playCurrent();
    openSongInfoModal(state.queue[idx]);
  });

  // GSAP-driven row hover: bubble-able mouseover/mouseout so the delegation
  // works on rows rendered after this listener attached. Pointer events
  // covered by the click handler above; no hover affordance on touch
  // devices, which is the intended behavior.
  let hoveredRow = null;
  function settleRow(row) {
    if (!row || !window.gsap) return;
    window.gsap.to(row, { x: 0, duration: 0.28, ease: 'power3.out' });
  }
  $('queue').addEventListener('mouseover', (e) => {
    const row = e.target.closest?.('.queue li');
    if (!row || row === hoveredRow) return;
    if (row.classList.contains('queue-empty') || row.classList.contains('queue-skeleton')) return;
    settleRow(hoveredRow);
    hoveredRow = row;
    if (window.gsap) {
      window.gsap.to(row, { x: 6, duration: 0.24, ease: 'power3.out' });
    }
  });
  $('queue').addEventListener('mouseleave', () => {
    settleRow(hoveredRow);
    hoveredRow = null;
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
      setNowState(t('idle'));
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

  // The server returns the queue as soon as Claude+YT are done, BEFORE TTS
  // finishes. sayAudioUrl is then null and we get a sayAudioPendingId we use
  // to poll a short-lived endpoint for the URL.
  function fetchPatterUrl(data) {
    if (data?.sayAudioUrl) return Promise.resolve(data.sayAudioUrl);
    if (!data?.sayAudioPendingId) return Promise.resolve(null);
    return fetch(`/api/patter/${data.sayAudioPendingId}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j?.sayAudioUrl || null)
      .catch(() => null);
  }

  // How long the client waits for patter before giving up and just starting
  // the music. On warm prod this is plenty; on cold the patter is dropped
  // for this turn so the queue isn't held hostage.
  const PATTER_WAIT_MS = 6000;

  async function loadShow(data) {
    setDjText(data.say || '(silent)', false);
    state.queue = data.play || [];
    state.idx = 0;
    renderQueue();
    renderMeta(data);

    const patterPromise = fetchPatterUrl(data);

    if (!userActivated) {
      // Cold load — don't attempt audio yet. Stash patter URL when it
      // arrives (we'll play it after the first user gesture).
      patterPromise.then((url) => { if (url) pendingPatterUrl = url; });
      if (state.queue.length) playCurrent();
      setNowState(t('tap_to_start'));
      setAir(false);
      return;
    }

    // Race the patter against a budget. If TTS lands quickly, we get the
    // full DJ-talks-then-music experience. If it's slow, we skip the patter
    // for this set so the user hears music sooner.
    const patterUrl = await Promise.race([
      patterPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), PATTER_WAIT_MS)),
    ]);
    if (patterUrl) {
      setNowState(t('dj_on_air'));
      setDjBars(true);
      await playDjPatter(patterUrl);
      setDjBars(false);
    }
    if (state.queue.length) playCurrent();
    else { setNowState(t('idle')); setAir(false); }
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
      setNowState(t('idle'));
      const remaining = state.user ? state.user.chatsLimit - state.user.chatsUsed : null;
      let msg;
      if (state.user?.isGuest && remaining <= 0) {
        msg = t('welcome_guest_zero', { limit: state.user.chatsLimit });
      } else if (state.user?.isGuest) {
        msg = t(remaining === 1 ? 'welcome_guest_one' : 'welcome_guest_many', { n: remaining });
      } else {
        msg = t('welcome_anon');
      }
      setDjText(msg, false);
      return;
    }
    setNowState(t('tuning_in'));
    setDjText(t('reading_the_room'), false);
    setLoading(true, t('tuning_in'));
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
      setLoading(false);
      setNowState(t('idle'));
      setDjText(t('welcome_anon'), false);
      return;
    }
    if (state.queue.length || state.pendingNext) { setLoading(false); return; }
    setLoading(false);
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
      syncVoiceFromServer();
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
        ? t('guest_chats_left', { remaining: user.chatsLimit - user.chatsUsed, limit: user.chatsLimit })
        : t('guest');
      name.textContent = label;
      name.hidden = false;
      btn.textContent = t('sign_up');
      btn.dataset.action = 'open';
      btn.hidden = false;
      settingsBtn.hidden = true;
    } else {
      // Signed-in: topbar is just the SETTINGS button. Identity + sign-out
      // live inside the settings drawer.
      name.textContent = '';
      name.hidden = true;
      btn.hidden = true;
      btn.dataset.action = '';
      settingsBtn.hidden = false;
    }
  }

  $('authBtn').addEventListener('click', () => {
    // The topbar button is now signup-only (sign-out moved into settings).
    openLoginModal();
  });

  $('accountSignOut').addEventListener('click', async () => {
    const btn = $('accountSignOut');
    btn.disabled = true;
    btn.textContent = '…';
    await fetch('/api/auth/signout', { method: 'POST', credentials: 'same-origin' });
    window.location.reload();
  });

  const ERROR_KEYS = {
    invalid_code: 'err_invalid_code',
    invalid_invite: 'err_invalid_code',
    invalid_state: 'err_invalid_state',
    missing_params: 'err_missing_params',
  };

  function openLoginModal({ lede, errorCode } = {}) {
    const modal = $('loginModal');
    const ledeEl = $('loginLede');
    const errEl = $('loginError');
    ledeEl.textContent = lede || t('login_lede');
    if (errorCode) {
      errEl.textContent = ERROR_KEYS[errorCode] ? t(ERROR_KEYS[errorCode]) : errorCode;
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

  /* ───── song info modal ─────────────────────────────────────────────── */
  let songInfoController = null;
  function buildRedditUrl(artist, title) {
    const q = [artist, title].filter(Boolean).join(' ');
    return `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`;
  }
  // Vinyl-record placeholder used whenever a section has no thumbnail —
  // either no Wikipedia thumb AND no YT Music thumb, OR the thumb URL 404s.
  // The placeholder sits underneath the <img>; if the image fails to load,
  // onerror hides the img and the placeholder shows through.
  const THUMB_PLACEHOLDER_SVG = `
    <div class="songinfo-thumb-placeholder" aria-hidden="true">
      <svg viewBox="0 0 60 60" preserveAspectRatio="xMidYMid meet">
        <circle cx="30" cy="30" r="27" fill="none" stroke="currentColor" stroke-width="1"/>
        <circle cx="30" cy="30" r="21" fill="none" stroke="currentColor" stroke-width="0.5" opacity="0.55"/>
        <circle cx="30" cy="30" r="15" fill="none" stroke="currentColor" stroke-width="0.5" opacity="0.55"/>
        <circle cx="30" cy="30" r="9" fill="currentColor" opacity="0.18"/>
        <circle cx="30" cy="30" r="1.6" fill="currentColor"/>
      </svg>
    </div>`;
  function thumbHtml(src) {
    if (!src) {
      // No URL at all — render placeholder solo, sized via .songinfo-thumb.
      return `<div class="songinfo-thumb">${THUMB_PLACEHOLDER_SVG}</div>`;
    }
    // Stack: placeholder underneath, image on top. If the image errors,
    // hide it via onerror so the placeholder shows through.
    return `<div class="songinfo-thumb">
      ${THUMB_PLACEHOLDER_SVG}
      <img class="songinfo-thumb-overlay" src="${esc(src)}" alt="" loading="lazy" onerror="this.style.display='none'">
    </div>`;
  }

  // Artist section — Wikipedia-only; hides if Wikipedia has no entry.
  function renderArtistSection(el, item) {
    if (!item) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const wikiLabel = t('song_info_wikipedia');
    const sectionLabel = t('song_info_artist');
    const thumb = thumbHtml(item.thumbnail);
    const wikiLink = item.wikiUrl
      ? `<a class="songinfo-wiki" href="${esc(item.wikiUrl)}" target="_blank" rel="noopener">${esc(wikiLabel)}</a>`
      : '';
    el.innerHTML = `
      <header class="songinfo-section-head">
        <span class="songinfo-section-label">${esc(sectionLabel)}</span>
        <span class="songinfo-section-name">${esc(item.name || '')}</span>
      </header>
      <div class="songinfo-section-body">
        ${thumb}
        <p class="songinfo-summary">${esc(item.summary || '')}</p>
      </div>
      ${wikiLink}
    `;
  }

  // Track section — ALWAYS shows. Built from the local YT Music metadata
  // (title, artist, album, duration, thumbnail) so the user sees real info
  // even when Wikipedia has no page for the specific song. Wikipedia data,
  // if present, is layered on top as a summary paragraph + link.
  function renderTrackSection(el, song, wiki) {
    el.hidden = false;
    const sectionLabel = t('song_info_track');
    const thumbSrc = wiki?.thumbnail || song.thumbnail || null;
    const thumb = thumbHtml(thumbSrc);
    const metaBits = [];
    if (song.album) metaBits.push(esc(song.album));
    if (song.duration) metaBits.push(esc(song.duration));
    const metaLine = metaBits.length
      ? `<p class="songinfo-meta">${metaBits.join(' · ')}</p>`
      : '';
    const summary = wiki?.summary
      ? `<p class="songinfo-summary">${esc(wiki.summary)}</p>`
      : '';
    const wikiLink = wiki?.wikiUrl
      ? `<a class="songinfo-wiki" href="${esc(wiki.wikiUrl)}" target="_blank" rel="noopener">${esc(t('song_info_wikipedia'))}</a>`
      : '';
    el.innerHTML = `
      <header class="songinfo-section-head">
        <span class="songinfo-section-label">${esc(sectionLabel)}</span>
        <span class="songinfo-section-name">${esc(song.title || song.query || '?')}</span>
        ${song.artist ? `<span class="songinfo-section-sub">${esc(song.artist)}</span>` : ''}
      </header>
      <div class="songinfo-section-body">
        ${thumb}
        <div class="songinfo-section-text">
          ${metaLine}
          ${summary}
        </div>
      </div>
      ${wikiLink}
    `;
  }
  // GSAP-driven entry: the backdrop fades, the card eases up with a tiny
  // scale settle, and the content stagger reveals after the fetch resolves.
  // Falls back to plain hidden toggles if GSAP failed to load (offline CDN).
  const gsapOk = () => typeof window !== 'undefined' && !!window.gsap;
  function revealContent() {
    if (!gsapOk()) return;
    const targets = $('songInfoModal')
      .querySelectorAll('.songinfo-section:not([hidden]), .songinfo-empty:not([hidden]) > *, .songinfo-reddit');
    if (!targets.length) return;
    window.gsap.from(targets, {
      y: 10,
      autoAlpha: 0,
      duration: 0.42,
      ease: 'power3.out',
      stagger: 0.07,
    });
  }
  function openSongInfoModal(song) {
    if (!song) return;
    songInfoController?.abort();
    songInfoController = new AbortController();
    const artist = song.artist || '';
    const title = song.title || song.query || '';
    const redditUrl = buildRedditUrl(artist, title);
    $('songInfoReddit').href = redditUrl;
    $('songInfoRedditFallback').href = redditUrl;
    $('songInfoLoading').hidden = false;
    $('songInfoBody').hidden = true;
    $('songInfoEmpty').hidden = true;
    $('songInfoArtistSection').hidden = true;
    $('songInfoTrackSection').hidden = true;
    const modal = $('songInfoModal');
    modal.hidden = false;
    if (gsapOk()) {
      const card = modal.querySelector('.modal-card');
      window.gsap.fromTo(modal,
        { autoAlpha: 0 },
        { autoAlpha: 1, duration: 0.18, ease: 'power1.out' });
      window.gsap.fromTo(card,
        { y: 24, autoAlpha: 0, scale: 0.97 },
        { y: 0, autoAlpha: 1, scale: 1, duration: 0.36, ease: 'expo.out', delay: 0.04 });
    }
    // Render the track section IMMEDIATELY using local YT Music metadata —
    // no waiting for Wikipedia. That way the title, album, duration and
    // thumbnail are on screen the moment the modal opens. We then layer
    // Wikipedia content on top when the fetch resolves.
    renderTrackSection($('songInfoTrackSection'), song, null);
    $('songInfoBody').hidden = false;
    $('songInfoLoading').hidden = false; // still loading artist info

    const params = new URLSearchParams({ artist, title });
    fetch(`/api/song-info?${params.toString()}`, { signal: songInfoController.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        $('songInfoLoading').hidden = true;
        renderArtistSection($('songInfoArtistSection'), data?.artist || null);
        renderTrackSection($('songInfoTrackSection'), song, data?.song || null);
        if (data?.redditUrl) {
          $('songInfoReddit').href = data.redditUrl;
          $('songInfoRedditFallback').href = data.redditUrl;
        }
        revealContent();
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        $('songInfoLoading').hidden = true;
        // Track section already on screen with local data; nothing to do.
      });
  }
  function closeSongInfoModal() {
    songInfoController?.abort();
    songInfoController = null;
    const modal = $('songInfoModal');
    if (gsapOk()) {
      const card = modal.querySelector('.modal-card');
      window.gsap.to(card, { y: 14, autoAlpha: 0, scale: 0.98, duration: 0.18, ease: 'power2.in' });
      window.gsap.to(modal, {
        autoAlpha: 0, duration: 0.18, ease: 'power2.in',
        onComplete: () => {
          modal.hidden = true;
          window.gsap.set(modal, { clearProps: 'all' });
          window.gsap.set(card, { clearProps: 'all' });
        },
      });
    } else {
      modal.hidden = true;
    }
  }
  $('songInfoClose').addEventListener('click', closeSongInfoModal);
  $('songInfoModal').addEventListener('click', (e) => {
    if (e.target.id === 'songInfoModal') closeSongInfoModal();
  });

  /* ───── DJ voice catalog (curated Fish Audio reference IDs) ───────────
     Each preset = { id, nameKey, descKey }. The `id` empty string means
     "let Fish Audio use whatever it defaults to" (we omit reference_id
     from the synth call). To add a voice: find it on https://fish.audio,
     copy its reference UUID from the URL, append one row here, add the
     two i18n keys for the name + description.
     Note: the IDs below other than ASMR_NARRATOR_ID are placeholders —
     update them with real Fish Audio reference UUIDs to enable. */
  const ASMR_NARRATOR_ID = '1ca7bc02099d47f1ae06b31f26875523';
  const VOICE_PRESETS = [
    { id: '',                    nameKey: 'voice_default',     descKey: 'voice_default_desc' },
    { id: ASMR_NARRATOR_ID,      nameKey: 'voice_asmr',        descKey: 'voice_asmr_desc' },
    // To enable these, replace each `id` with a real Fish Audio reference
    // UUID (32 hex chars). Until then, picking one falls back to Default.
    { id: 'f35dce726f1543239e2031f7f27eb132', nameKey: 'voice_warm_male', descKey: 'voice_warm_male_desc' },
    { id: '217d184dc3d1438c8027839b0cfa4fc8', nameKey: 'voice_warm_female', descKey: 'voice_warm_female_desc' },
    { id: 'dd4525b59d084dd5ace681e43ee7e251', nameKey: 'voice_dramatic',    descKey: 'voice_dramatic_desc' },
    { id: 'ef9e7efbf1c34ebdaeb72353c873650f', nameKey: 'voice_bilingual',   descKey: 'voice_bilingual_desc' },
  ];
  function renderVoiceSelect(currentValue) {
    const sel = $('setVoice');
    // De-dupe by name so unfilled placeholders don't all collapse on the
    // first empty option in the browser's selectedIndex logic.
    sel.innerHTML = VOICE_PRESETS.map((v, i) => {
      const label = t(v.nameKey);
      const desc = t(v.descKey);
      // Use the array index as a stable value so multiple presets with
      // empty `id` are still distinguishable in the <select>.
      const optVal = `__preset_${i}`;
      return `<option value="${esc(optVal)}" data-vid="${esc(v.id)}">${esc(label)} — ${esc(desc)}</option>`;
    }).join('');
    // Select the option whose data-vid matches the saved reference_id.
    // Fall back to the first preset (System default) if no match.
    const target = String(currentValue ?? '');
    let matched = false;
    for (const opt of sel.options) {
      if (opt.dataset.vid === target) {
        sel.value = opt.value;
        matched = true;
        break;
      }
    }
    if (!matched) sel.selectedIndex = 0;
    $('setVoiceHelp').textContent = t('voice_help');
  }
  function readSelectedVoiceId() {
    const opt = $('setVoice').selectedOptions?.[0];
    return opt?.dataset.vid || '';
  }

  /* ───── home-page voice picker (lives in the dj-head) ─────────────────
     Mirrors the same VOICE_PRESETS catalog. Saves instantly on selection
     via /api/me/settings (partial update — doesn't touch weather_city).
     Guests get the signup modal when they tap. */
  let currentVoiceId = '';  // tracks what's saved server-side
  function updateVoiceChip() {
    const labelEl = $('djVoiceLabel');
    const preset = VOICE_PRESETS.find((v) => v.id === currentVoiceId)
      || VOICE_PRESETS.find((v) => v.id === '');
    if (preset) labelEl.textContent = t(preset.nameKey);
  }
  function renderVoicePopover() {
    const pop = $('djVoicePopover');
    pop.innerHTML = VOICE_PRESETS.map((v, i) => {
      const active = v.id === currentVoiceId ? ' active' : '';
      return `
        <button type="button" class="dj-voice-option${active}" role="option"
                data-preset-idx="${i}" data-vid="${esc(v.id)}">
          <span class="dj-voice-option-name">${esc(t(v.nameKey))}</span>
          <span class="dj-voice-option-desc">${esc(t(v.descKey))}</span>
        </button>
      `;
    }).join('');
  }
  function openVoicePopover() {
    renderVoicePopover();
    $('djVoicePopover').hidden = false;
    $('djVoicePicker').classList.add('open');
    $('djVoiceBtn').setAttribute('aria-expanded', 'true');
  }
  function closeVoicePopover() {
    $('djVoicePopover').hidden = true;
    $('djVoicePicker').classList.remove('open');
    $('djVoiceBtn').setAttribute('aria-expanded', 'false');
  }
  async function saveVoice(newId) {
    currentVoiceId = newId;
    updateVoiceChip();
    closeVoicePopover();
    try {
      await fetch('/api/me/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ tts_reference_id: newId }),
      });
    } catch (err) {
      console.warn('[voice save]', err);
    }
  }
  $('djVoiceBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    // Guests can't save server-side preferences — route to signup.
    if (!state.user || state.user.isGuest) {
      openLoginModal({ lede: t('react_signup_lede') });
      return;
    }
    if ($('djVoicePopover').hidden) openVoicePopover();
    else closeVoicePopover();
  });
  $('djVoicePopover').addEventListener('click', (e) => {
    const opt = e.target.closest('.dj-voice-option');
    if (!opt) return;
    const vid = opt.dataset.vid || '';
    if (vid !== currentVoiceId) saveVoice(vid);
    else closeVoicePopover();
  });
  document.addEventListener('click', (e) => {
    if ($('djVoicePopover').hidden) return;
    if (!$('djVoicePicker').contains(e.target)) closeVoicePopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('djVoicePopover').hidden) closeVoicePopover();
  });

  // Fetch the saved voice on bootstrap so the chip reflects truth on load.
  async function syncVoiceFromServer() {
    if (!state.user || state.user.isGuest) {
      currentVoiceId = '';
      updateVoiceChip();
      return;
    }
    try {
      const res = await fetch('/api/me/settings', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      currentVoiceId = data.tts_reference_id || '';
      updateVoiceChip();
    } catch (err) {
      console.warn('[voice sync]', err);
    }
  }

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
          statusEl.textContent = t('invite_valid');
          statusEl.className = 'invite-status ok';
          btn.disabled = false;
        } else {
          statusEl.textContent = t('invite_invalid');
          statusEl.className = 'invite-status bad';
        }
      } catch {
        statusEl.textContent = t('invite_network_error');
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
    $('accountEmail').textContent = state.user.email || state.user.name || '—';
    if (flash === 'calendar_ok') {
      $('settingsOk').textContent = t('calendar_connected_msg');
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
      renderVoiceSelect(settings.tts_reference_id || '');
      renderCalendarStatus(settings);
    } catch (err) {
      $('settingsError').textContent = t('load_settings_failed', { err: err.message });
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
      statusEl.textContent = calendar_email
        ? t('cal_connected_with', { email: calendar_email })
        : t('cal_connected');
      connectBtn.hidden = true;
      disconnectBtn.hidden = false;
    } else {
      statusEl.textContent = t('cal_not_connected');
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

  let savedFlashTimer = null;
  $('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('settingsSaveBtn');
    btn.disabled = true;
    $('settingsError').hidden = true;
    $('settingsOk').hidden = true;
    // If a previous save's flash is still showing, clear it now so the
    // button doesn't get stuck displaying the old "SAVED" state.
    if (savedFlashTimer) { clearTimeout(savedFlashTimer); savedFlashTimer = null; }
    btn.classList.remove('saved-flash');
    const originalLabel = t('save');
    btn.textContent = '…';
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
          tts_reference_id: readSelectedVoiceId(),
        }),
      });
      if (!settingsRes.ok) throw new Error('settings save failed');
      // Visible success right at the cursor: the button itself flashes a
      // checkmark for 2s, and a printer-ticker style status line types
      // itself out below the button so mobile users see confirmation
      // without scrolling.
      btn.textContent = '✓ ' + t('saved').replace(/\.$/, '').toUpperCase();
      btn.classList.add('saved-flash');
      $('settingsOk').textContent = t('saved');
      $('settingsOk').hidden = false;
      const ticker = $('saveTicker');
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      const stamp = `${hh}:${mm}:${ss}`;
      ticker.innerHTML = `<span class="tk-dot"></span><span class="tk-label">${esc(t('saved').replace(/\.$/, '').toUpperCase())}</span><span class="tk-time">${stamp}</span>`;
      ticker.hidden = false;
      // Force restart of the print-out animation if a previous save's
      // animation hadn't finished.
      ticker.classList.remove('ticking');
      void ticker.offsetWidth;
      ticker.classList.add('ticking');
      savedFlashTimer = setTimeout(() => {
        btn.textContent = originalLabel;
        btn.classList.remove('saved-flash');
        $('settingsOk').hidden = true;
        ticker.hidden = true;
        ticker.classList.remove('ticking');
        savedFlashTimer = null;
      }, 2400);
    } catch (err) {
      btn.textContent = originalLabel;
      $('settingsError').textContent = t('save_failed', { err: err.message });
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
    // Belt-and-suspenders for mobile: after loadVideoById, if the player
    // hasn't moved into PLAYING or BUFFERING within 600ms, kick it.
    // YT iframe API on iOS Safari frequently fails to autoplay between
    // videos even when the session is already user-activated.
    setTimeout(() => {
      try {
        const PS = window.YT?.PlayerState;
        if (!PS) return;
        const ps = state.player.getPlayerState?.();
        if (ps !== PS.PLAYING && ps !== PS.BUFFERING) {
          state.player.playVideo?.();
        }
      } catch {}
    }, 600);
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
      setNowState(t('waiting_for_next'));
      setBars(false);
      stopProgress();
      return;
    }
    setNowState(t('end_of_queue'));
    setAir(false);
    setBars(false);
    stopProgress();
  }

  async function consumePendingNext() {
    const next = state.pendingNext;
    state.pendingNext = null;
    state.waitingForNext = false;
    if (!next || !next.play?.length) {
      setNowState(t('end_of_queue'));
      setAir(false);
      setBars(false);
      stopProgress();
      return;
    }
    setDjText(next.say || '(silent)', false);
    renderMeta(next);
    // Prefetch began ~5 min ago; TTS has almost certainly finished by now.
    // Wait briefly if not, then splice in regardless.
    const url = next.sayAudioUrl
      || (next.patterPromise ? await Promise.race([
        next.patterPromise,
        new Promise((r) => setTimeout(() => r(null), 2000)),
      ]) : null);
    if (url) {
      setNowState(t('dj_on_air'));
      setAir(true);
      setDjBars(true);
      await playDjPatter(url);
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
    // Auto-DJ continuation is signed-in-only. Visitors silently let the
    // queue play through to the end; no hint, no fetch, no surprises.
    if (!state.user || state.user.isGuest) return;
    startPrefetch();
  }

  async function startPrefetch() {
    state.prefetchInflight = true;
    const token = ++state.prefetchToken;
    renderPrefetchHint(t('preparing_next'));
    try {
      const res = await fetch('/api/auto-show', { method: 'POST', credentials: 'same-origin' });
      const data = await res.json();
      if (token !== state.prefetchToken) return; // invalidated
      if (res.status === 401 || res.status === 403) return;
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.play?.length) {
        renderPrefetchHint(t('auto_no_picks'));
        return;
      }
      // Kick off patter fetch in background — by the time the user-visible
      // queue actually drains, the TTS URL is likely already resolved.
      data.patterPromise = fetchPatterUrl(data);
      state.pendingNext = data;
      renderPrefetchHint(t(data.play.length === 1 ? 'next_set_ready_one' : 'next_set_ready_many', { n: data.play.length }));
      // If the queue already ended while we were fetching, splice in now.
      if (state.waitingForNext) consumePendingNext();
    } catch (err) {
      console.warn('[auto-show]', err);
      renderPrefetchHint(t('auto_error', { err: err.message || 'unknown' }));
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
      const avatar = $('djAvatar');
      audio.src = url;
      // The kitty's mouth animates only while the patter is audibly
      // playing — CSS does the actual scaleY keyframe; we just toggle
      // the class via the audio element's lifecycle.
      const showTalk = () => avatar?.classList.add('talking');
      const hideTalk = () => avatar?.classList.remove('talking');
      const done = () => {
        hideTalk();
        audio.removeEventListener('playing', showTalk);
        audio.removeEventListener('pause', hideTalk);
        audio.removeEventListener('ended', done);
        audio.removeEventListener('error', done);
        resolve();
      };
      audio.addEventListener('playing', showTalk);
      audio.addEventListener('pause', hideTalk);
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

  // The hero "old radio" face is now pure CSS + SVG (style.css → .radio-face).
  // The previous WebGL2 raymarcher + per-frame audio analyzer were the
  // dominant CPU/GPU cost on mobile; replacing with CSS keyframes drops the
  // hero's compositor work to near-zero while preserving the warm, alive feel.
})();
