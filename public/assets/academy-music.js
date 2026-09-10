(() => {
  const audio = document.getElementById('academy-study-audio');
  const toggle = document.getElementById('academy-music-toggle');
  const slider = document.getElementById('academy-music-volume');
  const status = document.getElementById('academy-music-status');
  const percent = document.getElementById('academy-music-percent');
  if (!audio || !toggle || !slider || !status || !percent) return;

  const tracks = [
    { title: 'Rainy Night Jazz', src: '/assets/music/01-rainy-night-jazz.mp3' },
    { title: 'Study Session', src: '/assets/music/02-study-session.mp3' },
    { title: 'Chillhop Jazz', src: '/assets/music/03-chillhop-jazz.mp3' },
    { title: 'Cosmic Focus 432Hz', src: '/assets/music/04-cosmic-focus.mp3' }
  ];

  const K_VOL='ae_study_music_volume', K_MUTE='ae_study_music_muted', K_TRACK='ae_study_music_track';
  const stored = localStorage.getItem(K_VOL);
  const savedVol = stored === null ? NaN : Number(stored);
  let volume = Number.isFinite(savedVol) && savedVol >= 0 && savedVol <= 100 ? savedVol : 15;
  let muted = localStorage.getItem(K_MUTE) === '1';
  let index = Number(localStorage.getItem(K_TRACK));
  if (!Number.isInteger(index) || index < 0 || index >= tracks.length) index = 0;
  let unlocked = false;

  const next = document.createElement('button');
  next.type = 'button';
  next.id = 'academy-music-next';
  next.className = 'academy-music-next';
  next.setAttribute('aria-label','Siguiente canción');
  next.textContent = '›';
  document.getElementById('academy-music-control').append(next);

  function paint() {
    slider.value = String(volume);
    slider.style.setProperty('--music-fill', `${volume}%`);
    audio.volume = volume / 100;
    audio.muted = muted;
    percent.textContent = `${volume}%`;

    const silent = muted || volume === 0;
    toggle.textContent = silent ? '♩' : '♫';
    toggle.setAttribute('aria-pressed', String(!silent));

    if (silent) status.textContent = 'Música en pausa';
    else if (audio.paused && !unlocked) status.textContent = 'Toca cualquier botón para iniciar';
    else status.textContent = tracks[index].title;
  }

  async function tryStart() {
    if (muted || volume === 0) return paint();
    try {
      await audio.play();
      unlocked = true;
      paint();
    } catch {
      status.textContent = 'Toca cualquier botón para iniciar';
    }
  }

  function loadTrack(autoplay=false) {
    audio.src = tracks[index].src;
    localStorage.setItem(K_TRACK, String(index));
    paint();
    if (autoplay && !muted && volume > 0) void tryStart();
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
    if (!muted && volume === 0) {
      volume = 15;
      localStorage.setItem(K_VOL, String(volume));
    }
    paint();
    if (!muted) await tryStart();
    else audio.pause();
  });

  const onVolume = async () => {
    volume = Number(slider.value);
    muted = volume === 0;
    localStorage.setItem(K_VOL, String(volume));
    localStorage.setItem(K_MUTE, muted ? '1' : '0');
    paint();
    if (!muted && audio.paused) await tryStart();
  };
  slider.addEventListener('input', onVolume);
  slider.addEventListener('change', onVolume);

  const unlock = () => {
    if (!unlocked && !muted && volume > 0) void tryStart();
  };
  document.addEventListener('pointerdown', unlock, { capture:true, passive:true });
  document.addEventListener('touchend', unlock, { capture:true, passive:true });
  document.addEventListener('click', unlock, true);
  document.addEventListener('keydown', unlock, true);

  loadTrack(false);
})();