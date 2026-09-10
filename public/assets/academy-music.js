(() => {
  const audio = document.getElementById('academy-study-audio');
  const toggle = document.getElementById('academy-music-toggle');
  const slider = document.getElementById('academy-music-volume');
  const status = document.getElementById('academy-music-status');
  if (!audio || !toggle || !slider || !status) return;

  const tracks = [
    { title: 'Rainy Night Jazz', src: '/assets/music/01-rainy-night-jazz.mp3' },
    { title: 'Study Session', src: '/assets/music/02-study-session.mp3' },
    { title: 'Chillhop Jazz', src: '/assets/music/03-chillhop-jazz.mp3' },
    { title: 'Cosmic Focus 432Hz', src: '/assets/music/04-cosmic-focus.mp3' }
  ];

  const K_VOL='ae_study_music_volume', K_MUTE='ae_study_music_muted', K_TRACK='ae_study_music_track';
  const savedVol = Number(localStorage.getItem(K_VOL));
  let volume = Number.isFinite(savedVol) && savedVol >= 0 && savedVol <= 100 ? savedVol : 10;
  let muted = localStorage.getItem(K_MUTE) === '1';
  let index = Number(localStorage.getItem(K_TRACK));
  if (!Number.isInteger(index) || index < 0 || index >= tracks.length) index = 0;

  // Add a compact NEXT button without changing course structure.
  const next = document.createElement('button');
  next.type = 'button';
  next.id = 'academy-music-next';
  next.setAttribute('aria-label','Siguiente canción');
  next.textContent = '›';
  slider.before(next);

  function loadTrack(autoplay=false) {
    audio.src = tracks[index].src;
    localStorage.setItem(K_TRACK, String(index));
    if (autoplay && !muted && volume > 0) tryStart();
    paint();
  }

  function paint() {
    slider.value = String(volume);
    audio.volume = volume / 100;
    audio.muted = muted;
    const silent = muted || volume === 0;
    toggle.textContent = silent ? '♩' : '♫';
    toggle.setAttribute('aria-pressed', String(!silent));
    status.textContent = silent ? 'Música en pausa' : `${tracks[index].title} · ${volume}%`;
  }

  async function tryStart() {
    if (muted || volume === 0) return paint();
    try { await audio.play(); paint(); }
    catch { status.textContent = 'Toca la pantalla para iniciar'; }
  }

  function advance() {
    index = (index + 1) % tracks.length;
    loadTrack(true);
  }

  audio.addEventListener('ended', advance);
  next.addEventListener('click', advance);

  toggle.addEventListener('click', async () => {
    muted = !muted;
    localStorage.setItem(K_MUTE, muted ? '1' : '0');
    audio.muted = muted;
    if (!muted) await tryStart();
    paint();
  });

  slider.addEventListener('input', async () => {
    volume = Number(slider.value);
    audio.volume = volume / 100;
    muted = volume === 0;
    audio.muted = muted;
    localStorage.setItem(K_VOL, String(volume));
    localStorage.setItem(K_MUTE, muted ? '1' : '0');
    if (!muted && audio.paused) await tryStart();
    paint();
  });

  // iOS/Safari: unlock audio on first user gesture.
  const unlock = () => {
    tryStart();
    document.removeEventListener('pointerdown', unlock, true);
    document.removeEventListener('keydown', unlock, true);
  };
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);

  loadTrack(false);
})();