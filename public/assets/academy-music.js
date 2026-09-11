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
  const K_MIGRATION = 'ae_music_player_migration_v8';

  // v8: reset one time to the requested 10%, including users who had 100% saved.
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

  const clamp = v => Math.max(0, Math.min(100, v));
  const mobile = () => window.matchMedia('(max-width:700px)').matches;
  const setImp = (el, prop, value) => el.style.setProperty(prop, value, 'important');

  function applyButtonStyle(btn, size = 36) {
    setImp(btn, 'display', 'flex');
    setImp(btn, 'align-items', 'center');
    setImp(btn, 'justify-content', 'center');
    setImp(btn, 'flex', '0 0 auto');
    setImp(btn, 'width', `${size}px`);
    setImp(btn, 'height', `${size}px`);
    setImp(btn, 'min-width', `${size}px`);
    setImp(btn, 'min-height', `${size}px`);
    setImp(btn, 'padding', '0');
    setImp(btn, 'margin', '0');
    setImp(btn, 'border', '1px solid rgba(243,201,109,.35)');
    setImp(btn, 'border-radius', '11px');
    setImp(btn, 'background', '#111318');
    setImp(btn, 'color', '#f3c96d');
    setImp(btn, 'font-size', '17px');
    setImp(btn, 'line-height', '1');
    setImp(btn, 'box-sizing', 'border-box');
    setImp(btn, 'appearance', 'none');
    setImp(btn, '-webkit-appearance', 'none');
  }

  function enforceStyles() {
    // Launcher: always a small fixed side button on mobile.
    setImp(launcher, 'position', 'fixed');
    setImp(launcher, 'right', '10px');
    setImp(launcher, 'left', 'auto');
    setImp(launcher, 'top', '58%');
    setImp(launcher, 'bottom', 'auto');
    setImp(launcher, 'transform', 'translateY(-50%)');
    setImp(launcher, 'z-index', '2147483646');
    setImp(launcher, 'width', '46px');
    setImp(launcher, 'height', '46px');
    setImp(launcher, 'min-width', '46px');
    setImp(launcher, 'min-height', '46px');
    setImp(launcher, 'padding', '0');
    setImp(launcher, 'margin', '0');
    setImp(launcher, 'border', '1px solid rgba(243,201,109,.45)');
    setImp(launcher, 'border-radius', '999px');
    setImp(launcher, 'background', '#111318');
    setImp(launcher, 'color', '#f3c96d');
    setImp(launcher, 'font-size', '20px');
    setImp(launcher, 'line-height', '1');
    setImp(launcher, 'align-items', 'center');
    setImp(launcher, 'justify-content', 'center');
    setImp(launcher, 'box-shadow', '0 10px 30px rgba(0,0,0,.42)');
    setImp(launcher, 'box-sizing', 'border-box');
    setImp(launcher, 'appearance', 'none');
    setImp(launcher, '-webkit-appearance', 'none');

    // Panel base.
    setImp(panel, 'position', 'fixed');
    setImp(panel, 'z-index', '2147483645');
    setImp(panel, 'align-items', 'center');
    setImp(panel, 'gap', '7px');
    setImp(panel, 'height', 'auto');
    setImp(panel, 'min-height', '56px');
    setImp(panel, 'max-height', '72px');
    setImp(panel, 'padding', '8px');
    setImp(panel, 'margin', '0');
    setImp(panel, 'overflow', 'hidden');
    setImp(panel, 'border', '1px solid rgba(243,201,109,.34)');
    setImp(panel, 'border-radius', '16px');
    setImp(panel, 'background', 'rgba(9,10,13,.98)');
    setImp(panel, 'box-shadow', '0 14px 40px rgba(0,0,0,.42)');
    setImp(panel, 'box-sizing', 'border-box');

    applyButtonStyle(toggle, 34);
    applyButtonStyle(next, 34);
    applyButtonStyle(close, 34);

    const meta = panel.querySelector('.academy-music-meta');
    if (meta) {
      setImp(meta, 'display', 'grid');
      setImp(meta, 'gap', '2px');
      setImp(meta, 'flex', '1 1 auto');
      setImp(meta, 'min-width', '0');
      setImp(meta, 'max-width', '116px');
      setImp(meta, 'margin', '0');
    }
    const metaTitle = meta?.querySelector('b');
    if (metaTitle) {
      setImp(metaTitle, 'font-size', '9px');
      setImp(metaTitle, 'line-height', '1.15');
      setImp(metaTitle, 'letter-spacing', '.10em');
      setImp(metaTitle, 'color', '#f3c96d');
      setImp(metaTitle, 'white-space', 'nowrap');
    }
    const metaLine = meta?.querySelector('span');
    if (metaLine) {
      setImp(metaLine, 'display', 'block');
      setImp(metaLine, 'font-size', '9px');
      setImp(metaLine, 'line-height', '1.2');
      setImp(metaLine, 'color', '#b0b4bd');
      setImp(metaLine, 'white-space', 'nowrap');
      setImp(metaLine, 'overflow', 'hidden');
      setImp(metaLine, 'text-overflow', 'ellipsis');
      setImp(metaLine, 'max-width', '116px');
    }

    // Kill generic global input styles that made the range full-width/tall on iPhone.
    setImp(slider, 'display', 'block');
    setImp(slider, 'flex', '0 0 62px');
    setImp(slider, 'width', '62px');
    setImp(slider, 'min-width', '62px');
    setImp(slider, 'max-width', '62px');
    setImp(slider, 'height', '22px');
    setImp(slider, 'min-height', '22px');
    setImp(slider, 'max-height', '22px');
    setImp(slider, 'padding', '0');
    setImp(slider, 'margin', '0');
    setImp(slider, 'border', '0');
    setImp(slider, 'border-radius', '0');
    setImp(slider, 'background', 'transparent');
    setImp(slider, 'box-shadow', 'none');
    setImp(slider, 'accent-color', '#f3c96d');
    setImp(slider, 'box-sizing', 'border-box');

    if (mobile()) {
      setImp(launcher, 'display', 'flex');
      setImp(panel, 'right', '62px');
      setImp(panel, 'left', 'auto');
      setImp(panel, 'top', '58%');
      setImp(panel, 'bottom', 'auto');
      setImp(panel, 'transform', 'translateY(-50%)');
      setImp(panel, 'width', 'min(300px, calc(100vw - 76px))');
      setImp(panel, 'max-width', '300px');
      setImp(close, 'display', 'flex');
      setImp(panel, 'display', panel.classList.contains('is-open') ? 'flex' : 'none');
    } else {
      setImp(launcher, 'display', 'none');
      setImp(panel, 'display', 'flex');
      setImp(panel, 'right', '18px');
      setImp(panel, 'left', 'auto');
      setImp(panel, 'bottom', '18px');
      setImp(panel, 'top', 'auto');
      setImp(panel, 'transform', 'none');
      setImp(panel, 'width', 'auto');
      setImp(panel, 'max-width', '360px');
      setImp(close, 'display', 'none');
    }
  }

  function paint() {
    volume = clamp(volume);
    slider.value = String(volume);
    audio.volume = volume / 100;
    audio.muted = muted;
    percent.textContent = `${Math.round(volume)}%`;
    status.textContent = tracks[index].title;
    const silent = muted || volume === 0;
    toggle.textContent = silent || audio.paused ? '♫' : '❚❚';
    toggle.setAttribute('aria-pressed', String(!silent && !audio.paused));
    enforceStyles();
  }

  async function playNow() {
    if (muted || volume === 0) return;
    try {
      audio.volume = volume / 100;
      audio.muted = false;
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

  launcher.addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    panel.classList.add('is-open');
    launcher.setAttribute('aria-expanded', 'true');
    enforceStyles();
    if (!muted && volume > 0 && audio.paused) await playNow();
  });

  close.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    panel.classList.remove('is-open');
    launcher.setAttribute('aria-expanded', 'false');
    enforceStyles();
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
      audio.pause();
      paint();
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

  const changeVolume = e => {
    e.stopPropagation();
    volume = clamp(Number(slider.value));
    if (!Number.isFinite(volume)) volume = 10;
    muted = volume === 0;
    localStorage.setItem(K_VOL, String(volume));
    localStorage.setItem(K_MUTE, muted ? '1' : '0');
    audio.volume = volume / 100;
    audio.muted = muted;
    paint();
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

  // iOS permits media playback only after a user gesture.
  const unlockFromCourse = e => {
    if (panel.contains(e.target) || launcher.contains(e.target)) return;
    if (!unlocked && !muted && volume > 0 && audio.paused) void playNow();
  };
  document.addEventListener('pointerdown', unlockFromCourse, { capture: true, passive: true });
  document.addEventListener('touchend', unlockFromCourse, { capture: true, passive: true });

  window.addEventListener('resize', enforceStyles);
  window.addEventListener('orientationchange', () => setTimeout(enforceStyles, 100));

  panel.classList.remove('is-open');
  launcher.setAttribute('aria-expanded', 'false');
  slider.value = String(volume);
  enforceStyles();
  loadTrack(false);
})();
