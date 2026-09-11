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

  const savedVol = Number(localStorage.getItem(K_VOL));
  let volume = Number.isFinite(savedVol) && savedVol >= 0 && savedVol <= 100 ? savedVol : 15;
  let muted = localStorage.getItem(K_MUTE) === '1';
  let collapsed = localStorage.getItem(K_COLLAPSED) === '1';
  let index = Number(localStorage.getItem(K_TRACK));
  if (!Number.isInteger(index) || index < 0 || index >= tracks.length) index = 0;

  let unlocked = false;
  let audioContext = null;
  let gainNode = null;
  let mediaSource = null;

  function ensureAudioGraph() {
    if (gainNode) return true;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      audioContext = new Ctx();
      mediaSource = audioContext.createMediaElementSource(audio);
      gainNode = audioContext.createGain();
      mediaSource.connect(gainNode);
      gainNode.connect(audioContext.destination);
      audio.volume = 1;
      return true;
    } catch (_) {
      gainNode = null;
      return false;
    }
  }

  function volumeToGain(v) {
    const x = Math.max(0, Math.min(1, v / 100));
    return Math.pow(x, 2.2);
  }

  function applyVolume() {
    const target = muted ? 0 : volumeToGain(volume);
    if (ensureAudioGraph()) {
      try {
        const now = audioContext.currentTime;
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.setTargetAtTime(target, now, 0.02);
        audio.muted = false;
        audio.volume = 1;
        return;
      } catch (_) {}
    }
    audio.muted = muted;
    audio.volume = muted ? 0 : Math.max(0, Math.min(1, volume / 100));
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

  if (!document.getElementById('academy-music-collapse-style')) {
    const style = document.createElement('style');
    style.id = 'academy-music-collapse-style';
    style.textContent = `
      #academy-music-control{position:relative!important;transition:height .2s ease,padding .2s ease,transform .2s ease!important}
      #academy-music-minimize{position:absolute;top:7px;right:8px;z-index:40;width:32px;height:28px;border:1px solid rgba(255,255,255,.18);border-radius:9px;background:rgba(255,255,255,.08);color:#fff;font-size:18px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;-webkit-tap-highlight-color:transparent}
      #academy-music-control.is-collapsed{height:54px!important;min-height:54px!important;max-height:54px!important;padding:7px 46px 7px 10px!important;overflow:hidden!important}
      #academy-music-control.is-collapsed > *:not(#academy-music-toggle):not(#academy-music-status):not(#academy-music-minimize):not(audio){display:none!important}
      #academy-music-control.is-collapsed #academy-music-status{display:block!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;max-width:calc(100vw - 120px)!important;margin:0!important;font-size:12px!important;line-height:40px!important}
      #academy-music-control.is-collapsed #academy-music-toggle{display:flex!important;align-items:center!important;justify-content:center!important;min-width:38px!important;min-height:38px!important}
      #academy-music-control.is-collapsed #academy-music-minimize{top:11px!important}
      @media(max-width:700px){#academy-music-control.is-collapsed{height:52px!important;min-height:52px!important;max-height:52px!important}}
    `;
    document.head.append(style);
  }

  function setCollapsed(value) {
    collapsed = !!value;
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
    else if (audio.paused) status.textContent = unlocked ? tracks[index].title : 'Toca un botón del curso para iniciar';
    else status.textContent = tracks[index].title;
  }

  async function playNow() {
    if (muted || volume === 0) return;
    try {
      ensureAudioGraph();
      if (audioContext && audioContext.state === 'suspended') await audioContext.resume();
      applyVolume();
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
    if (muted || volume === 0) {
      muted = false;
      if (volume === 0) volume = 15;
      localStorage.setItem(K_VOL, String(volume));
      localStorage.setItem(K_MUTE, '0');
      paint();
      await playNow();
    } else if (audio.paused) {
      muted = false;
      localStorage.setItem(K_MUTE, '0');
      paint();
      await playNow();
    } else {
      muted = true;
      localStorage.setItem(K_MUTE, '1');
      paint();
    }
  });

  next.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
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
    volume = Math.max(0, Math.min(100, Number(slider.value) || 0));
    muted = volume === 0;
    localStorage.setItem(K_VOL, String(volume));
    localStorage.setItem(K_MUTE, muted ? '1' : '0');
    applyVolume();
    paint();
    if (!muted && audio.paused && unlocked) await playNow();
  };

  slider.addEventListener('input', changeVolume, { passive: true });
  slider.addEventListener('change', changeVolume, { passive: true });
  slider.addEventListener('pointerdown', (event) => event.stopPropagation());
  slider.addEventListener('touchstart', (event) => event.stopPropagation(), { passive: true });

  audio.addEventListener('ended', advance);

  const unlockFromCourse = (event) => {
    if (control.contains(event.target)) return;
    if (muted || volume === 0 || !audio.paused) return;
    void playNow();
  };

  document.addEventListener('pointerdown', unlockFromCourse, { capture: true, passive: true });
  document.addEventListener('touchend', unlockFromCourse, { capture: true, passive: true });
  document.addEventListener('click', unlockFromCourse, true);
  document.addEventListener('keydown', unlockFromCourse, true);

  document.addEventListener('click', (event) => {
    if (window.matchMedia('(max-width: 700px)').matches) {
      const btn = event.target.closest('button,a');
      if (btn && /SIGUIENTE|NEXT|CONTINUAR/i.test((btn.textContent || '').trim())) setCollapsed(true);
    }
  }, true);

  setCollapsed(collapsed);
  loadTrack(false);
})();
