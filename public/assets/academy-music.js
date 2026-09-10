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
  const K_PLAYER_VER = 'ae_study_music_player_version';
  const PLAYER_VER = '4';

  // Reset one single time to the new intended default: 10%.
  if (localStorage.getItem(K_PLAYER_VER) !== PLAYER_VER) {
    localStorage.setItem(K_VOL, '15');
    localStorage.setItem(K_MUTE, '0');
    localStorage.setItem(K_PLAYER_VER, PLAYER_VER);
  }

  const savedVol = Number(localStorage.getItem(K_VOL));
  let volume = Number.isFinite(savedVol) && savedVol >= 0 && savedVol <= 100 ? savedVol : 15;
  let muted = localStorage.getItem(K_MUTE) === '1';
  let index = Number(localStorage.getItem(K_TRACK));
  if (!Number.isInteger(index) || index < 0 || index >= tracks.length) index = 0;

  let unlocked = false;

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

  function paint() {
    slider.value = String(volume);
    slider.style.setProperty('--music-fill', `${volume}%`);
    audio.volume = Math.min(1, Math.max(0, volume / 100));
    audio.muted = muted;
    percent.textContent = `${Math.round(volume)}%`;

    const silent = muted || volume === 0;
    toggle.textContent = silent ? '♪' : '♫';
    toggle.setAttribute('aria-pressed', String(!silent));

    if (silent) {
      status.textContent = 'Música en pausa';
    } else if (audio.paused) {
      status.textContent = unlocked ? tracks[index].title : 'Toca un botón del curso para iniciar';
    } else {
      status.textContent = tracks[index].title;
    }
  }

  async function playNow() {
    if (muted || volume === 0) return;
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

  // Player controls: keep them independent from the global iPhone unlock gesture.
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
      audio.pause();
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

  const changeVolume = async (event) => {
    event.stopPropagation();
    volume = Number(slider.value);
    muted = volume === 0;

    localStorage.setItem(K_VOL, String(volume));
    localStorage.setItem(K_MUTE, muted ? '1' : '0');

    paint();

    if (muted) {
      audio.pause();
    } else if (audio.paused && unlocked) {
      await playNow();
    }
  };

  slider.addEventListener('input', changeVolume);
  slider.addEventListener('change', changeVolume);
  slider.addEventListener('pointerdown', (event) => event.stopPropagation());
  slider.addEventListener('touchstart', (event) => event.stopPropagation(), { passive: true });

  audio.addEventListener('ended', advance);

  // iPhone/Safari: start on first interaction OUTSIDE the music player.
  const unlockFromCourse = (event) => {
    if (control.contains(event.target)) return;
    if (muted || volume === 0 || !audio.paused) return;
    void playNow();
  };

  document.addEventListener('pointerdown', unlockFromCourse, { capture: true, passive: true });
  document.addEventListener('touchend', unlockFromCourse, { capture: true, passive: true });
  document.addEventListener('click', unlockFromCourse, true);
  document.addEventListener('keydown', unlockFromCourse, true);

  loadTrack(false);
})();
