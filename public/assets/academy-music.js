(() => {
  const audio = document.getElementById('academy-study-audio');
  const toggle = document.getElementById('academy-music-toggle');
  const slider = document.getElementById('academy-music-volume');
  const status = document.getElementById('academy-music-status');
  const percent = document.getElementById('academy-music-percent');
  const control = document.getElementById('academy-music-control');

  if (!audio || !toggle || !slider || !status || !percent || !control) return;

  const tracks = [
    { title: 'Rainy Night Jazz', src: '/assets/music/01-rainy-night-jazz.mp3' },
    { title: 'Study Session', src: '/assets/music/02-study-session.mp3' },
    { title: 'Chillhop Jazz', src: '/assets/music/03-chillhop-jazz.mp3' },
    { title: 'Cosmic Focus 432Hz', src: '/assets/music/04-cosmic-focus.mp3' }
  ];

  const K_VOL = 'ae_study_music_volume';
  const K_MUTE = 'ae_study_music_muted';
  const K_TRACK = 'ae_study_music_track';
  const K_COLLAPSED = 'ae_study_music_collapsed';
  const DEFAULT_VOL = 15;

  const storedVol = localStorage.getItem(K_VOL);
  let volume = storedVol === null ? DEFAULT_VOL : Number(storedVol);
  if (!Number.isFinite(volume) || volume < 0 || volume > 100) volume = DEFAULT_VOL;

  let muted = localStorage.getItem(K_MUTE) === '1';
  if (storedVol === null) {
    muted = false;
    localStorage.setItem(K_VOL, String(DEFAULT_VOL));
    localStorage.setItem(K_MUTE, '0');
  }

  let collapsed = localStorage.getItem(K_COLLAPSED) === '1';
  let index = Number(localStorage.getItem(K_TRACK));
  if (!Number.isInteger(index) || index < 0 || index >= tracks.length) index = 0;

  let unlocked = false;
  let audioContext = null;
  let sourceNode = null;
  let gainNode = null;

  function gainFor(v) {
    const x = Math.max(0, Math.min(1, v / 100));
    return Math.pow(x, 1.7);
  }

  async function ensureAudioGraphFromGesture() {
    if (gainNode && audioContext) {
      if (audioContext.state === 'suspended') {
        try { await audioContext.resume(); } catch (_) {}
      }
      return true;
    }

    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;

      audioContext = new Ctx();
      sourceNode = audioContext.createMediaElementSource(audio);
      gainNode = audioContext.createGain();
      sourceNode.connect(gainNode);
      gainNode.connect(audioContext.destination);

      if (audioContext.state === 'suspended') {
        try { await audioContext.resume(); } catch (_) {}
      }
      return true;
    } catch (_) {
      audioContext = null;
      sourceNode = null;
      gainNode = null;
      return false;
    }
  }

  function applyVolume() {
    const target = muted ? 0 : gainFor(volume);

    if (gainNode && audioContext) {
      try {
        const now = audioContext.currentTime;
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.setTargetAtTime(target, now, 0.015);
        audio.muted = false;
        audio.volume = 1;
        return;
      } catch (_) {}
    }

    // Fallback for browsers where media element volume is supported.
    try {
      audio.muted = muted;
      audio.volume = muted ? 0 : Math.max(0, Math.min(1, volume / 100));
    } catch (_) {}
  }

  let next = document.getElementById('academy-music-next');
  if (!next) {
    next = document.createElement('button');
    next.type = 'button';
    next.id = 'academy-music-next';
    next.className = 'academy-music-next';
    next.setAttribute('aria-label', 'Siguiente canción');
    next.textContent = '›';
    control.append(next);
  }

  let minimize = document.getElementById('academy-music-minimize');
  if (!minimize) {
    minimize = document.createElement('button');
    minimize.type = 'button';
    minimize.id = 'academy-music-minimize';
    minimize.className = 'academy-music-minimize';
    minimize.setAttribute('aria-label', 'Minimizar reproductor');
    minimize.textContent = '—';
    control.append(minimize);
  }

  function setCollapsed(value) {
    collapsed = Boolean(value);
    control.classList.toggle('is-collapsed', collapsed);
    minimize.textContent = collapsed ? '⌃' : '—';
    minimize.setAttribute('aria-label', collapsed ? 'Abrir reproductor' : 'Minimizar reproductor');
    localStorage.setItem(K_COLLAPSED, collapsed ? '1' : '0');
  }

  function paint() {
    slider.value = String(volume);
    slider.style.setProperty('--music-fill', `${volume}%`);
    percent.textContent = `${Math.round(volume)}%`;
    applyVolume();

    const silent = muted || volume === 0;
    toggle.textContent = silent ? '♪' : '♫';
    toggle.setAttribute('aria-pressed', String(!silent));

    if (silent) status.textContent = 'Música en pausa';
    else if (audio.paused) status.textContent = unlocked ? tracks[index].title : 'Toca para iniciar';
    else status.textContent = tracks[index].title;
  }

  async function playNow() {
    if (muted || volume === 0) return;

    await ensureAudioGraphFromGesture();
    applyVolume();

    try {
      await audio.play();
      unlocked = true;
    } catch (_) {}

    paint();
  }

  function loadTrack(autoplay = false) {
    audio.src = tracks[index].src;
    localStorage.setItem(K_TRACK, String(index));
    paint();
    if (autoplay) void playNow();
  }

  function advance() {
    index = (index + 1) % tracks.length;
    loadTrack(true);
  }

  toggle.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();

    await ensureAudioGraphFromGesture();

    if (muted || volume === 0) {
      muted = false;
      if (volume === 0) volume = DEFAULT_VOL;
      localStorage.setItem(K_VOL, String(volume));
      localStorage.setItem(K_MUTE, '0');
      paint();
      await playNow();
      return;
    }

    if (audio.paused) {
      muted = false;
      localStorage.setItem(K_MUTE, '0');
      paint();
      await playNow();
    } else {
      muted = true;
      localStorage.setItem(K_MUTE, '1');
      applyVolume();
      paint();
    }
  });

  next.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await ensureAudioGraphFromGesture();
    muted = false;
    localStorage.setItem(K_MUTE, '0');
    advance();
  });

  minimize.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setCollapsed(!collapsed);
  });

  const changeVolume = async (event) => {
    event.stopPropagation();

    await ensureAudioGraphFromGesture();

    const newVolume = Number(slider.value);
    volume = Number.isFinite(newVolume) ? Math.max(0, Math.min(100, newVolume)) : DEFAULT_VOL;
    muted = volume === 0;

    localStorage.setItem(K_VOL, String(volume));
    localStorage.setItem(K_MUTE, muted ? '1' : '0');

    applyVolume();
    paint();

    if (!muted && audio.paused && unlocked) {
      try { await audio.play(); } catch (_) {}
    }
  };

  slider.addEventListener('input', changeVolume);
  slider.addEventListener('change', changeVolume);
  slider.addEventListener('pointerdown', (event) => event.stopPropagation());
  slider.addEventListener('touchstart', (event) => event.stopPropagation(), { passive: true });

  audio.addEventListener('ended', advance);

  const unlockFromCourse = async (event) => {
    if (control.contains(event.target)) return;
    if (muted || volume === 0 || !audio.paused) return;
    await ensureAudioGraphFromGesture();
    void playNow();
  };

  document.addEventListener('pointerdown', unlockFromCourse, { capture: true, passive: true });
  document.addEventListener('touchend', unlockFromCourse, { capture: true, passive: true });
  document.addEventListener('click', unlockFromCourse, true);

  // On mobile, collapse when the learner moves forward.
  document.addEventListener('click', (event) => {
    if (!window.matchMedia('(max-width: 700px)').matches) return;
    const btn = event.target.closest('button,a');
    if (btn && /SIGUIENTE|NEXT|CONTINUAR/i.test((btn.textContent || '').trim())) {
      setCollapsed(true);
    }
  }, true);

  setCollapsed(collapsed);
  loadTrack(false);
})();