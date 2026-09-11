(() => {
  const audio = document.getElementById('academy-study-audio');
  const panel = document.getElementById('academy-music-control');
  const launcher = document.getElementById('academy-music-launcher');
  const toggle = document.getElementById('academy-music-toggle');
  const next = document.getElementById('academy-music-next');
  const close = document.getElementById('academy-music-close');
  const slider = document.getElementById('academy-music-volume');
  const status = document.getElementById('academy-music-status');
  const percent = document.getElementById('academy-music-percent');
  if (!audio || !panel || !launcher || !toggle || !next || !close || !slider || !status || !percent) return;

  const tracks = [
    { title: 'Rainy Night Jazz', src: '/assets/music/01-rainy-night-jazz.mp3' },
    { title: 'Study Session', src: '/assets/music/02-study-session.mp3' },
    { title: 'Chillhop Jazz', src: '/assets/music/03-chillhop-jazz.mp3' },
    { title: 'Cosmic Focus 432Hz', src: '/assets/music/04-cosmic-focus.mp3' }
  ];

  const K_VOL = 'ae_study_music_volume';
  const K_MUTE = 'ae_study_music_muted';
  const K_TRACK = 'ae_study_music_track';
  const K_MIGRATION = 'ae_music_player_migration_v6';

  // One-time migration so users who previously got 100% are reset to the requested 10%.
  if (localStorage.getItem(K_MIGRATION) !== 'done') {
    localStorage.setItem(K_VOL, '10');
    localStorage.setItem(K_MUTE, '0');
    localStorage.setItem(K_MIGRATION, 'done');
  }

  let volume = Number(localStorage.getItem(K_VOL));
  if (!Number.isFinite(volume) || volume < 0 || volume > 100) volume = 10;
  let muted = localStorage.getItem(K_MUTE) === '1';
  let index = Number(localStorage.getItem(K_TRACK));
  if (!Number.isInteger(index) || index < 0 || index >= tracks.length) index = 3;
  let unlocked = false;

  const isMobile = () => window.matchMedia('(max-width:700px)').matches;
  const clamp = v => Math.max(0, Math.min(100, v));

  function paint() {
    slider.value = String(volume);
    audio.volume = clamp(volume) / 100;
    audio.muted = muted;
    percent.textContent = `${Math.round(volume)}%`;
    status.textContent = tracks[index].title;
    const silent = muted || volume === 0;
    toggle.textContent = silent || audio.paused ? '♫' : '❚❚';
    toggle.setAttribute('aria-pressed', String(!silent && !audio.paused));
  }

  async function playNow() {
    if (muted || volume === 0) return;
    try {
      await audio.play();
      unlocked = true;
    } catch (_) {}
    paint();
  }

  function pauseNow() {
    audio.pause();
    paint();
  }

  function loadTrack(autoplay = false) {
    audio.src = tracks[index].src;
    localStorage.setItem(K_TRACK, String(index));
    paint();
    if (autoplay) void playNow();
  }

  launcher.addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    panel.classList.add('is-open');
    launcher.setAttribute('aria-expanded', 'true');
    if (!muted && volume > 0 && audio.paused) await playNow();
  });

  close.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    panel.classList.remove('is-open');
    launcher.setAttribute('aria-expanded', 'false');
    // Music intentionally keeps playing.
  });

  toggle.addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    if (muted || volume === 0) {
      muted = false;
      if (volume === 0) volume = 10;
      localStorage.setItem(K_VOL, String(volume));
      localStorage.setItem(K_MUTE, '0');
      await playNow();
    } else if (audio.paused) {
      await playNow();
    } else {
      pauseNow();
    }
  });

  next.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    index = (index + 1) % tracks.length;
    muted = false;
    localStorage.setItem(K_MUTE, '0');
    loadTrack(true);
  });

  const changeVolume = async e => {
    e.stopPropagation();
    volume = clamp(Number(slider.value) || 0);
    muted = volume === 0;
    localStorage.setItem(K_VOL, String(volume));
    localStorage.setItem(K_MUTE, muted ? '1' : '0');
    audio.volume = volume / 100;
    audio.muted = muted;
    paint();
    if (!muted && unlocked && audio.paused) await playNow();
  };
  slider.addEventListener('input', changeVolume);
  slider.addEventListener('change', changeVolume);
  slider.addEventListener('pointerdown', e => e.stopPropagation());
  slider.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });

  audio.addEventListener('play', paint);
  audio.addEventListener('pause', paint);
  audio.addEventListener('ended', () => {
    index = (index + 1) % tracks.length;
    loadTrack(true);
  });

  // iOS Safari allows playback only after a user gesture. A course tap can unlock it.
  const unlockFromCourse = e => {
    if (panel.contains(e.target) || launcher.contains(e.target)) return;
    if (!unlocked && !muted && volume > 0 && audio.paused) void playNow();
  };
  document.addEventListener('pointerdown', unlockFromCourse, { capture: true, passive: true });
  document.addEventListener('touchend', unlockFromCourse, { capture: true, passive: true });

  window.addEventListener('resize', () => {
    if (!isMobile()) panel.classList.remove('is-open');
  });

  panel.classList.remove('is-open');
  launcher.setAttribute('aria-expanded', 'false');
  loadTrack(false);
})();
