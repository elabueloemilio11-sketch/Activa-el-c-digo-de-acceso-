(() => {
  const audio=document.getElementById('academy-study-audio');
  const control=document.getElementById('academy-music-control');
  const toggle=document.getElementById('academy-music-toggle');
  const slider=document.getElementById('academy-music-volume');
  const status=document.getElementById('academy-music-status');
  if(!audio||!control||!toggle||!slider||!status)return;

  const tracks=[
    {title:'Rainy Night Jazz',src:'/assets/music/01-rainy-night-jazz.mp3'},
    {title:'Study Session',src:'/assets/music/02-study-session.mp3'},
    {title:'Chillhop Jazz',src:'/assets/music/03-chillhop-jazz.mp3'},
    {title:'Cosmic Focus 432Hz',src:'/assets/music/04-cosmic-focus.mp3'}
  ];
  const K_VOL='ae_study_music_volume',K_MUTE='ae_study_music_muted',K_TRACK='ae_study_music_track',K_OPEN='ae_music_mobile_open',K_VER='ae_music_player_v5';
  if(localStorage.getItem(K_VER)!=='1'){
    localStorage.setItem(K_VOL,'10'); localStorage.setItem(K_MUTE,'0'); localStorage.setItem(K_OPEN,'0'); localStorage.setItem(K_VER,'1');
  }
  let volume=Number(localStorage.getItem(K_VOL));
  if(!Number.isFinite(volume)||volume<0||volume>100)volume=10;
  let muted=localStorage.getItem(K_MUTE)==='1';
  let index=Number(localStorage.getItem(K_TRACK)); if(!Number.isInteger(index)||index<0||index>=tracks.length)index=0;
  let mobileOpen=localStorage.getItem(K_OPEN)==='1';
  let unlocked=false;

  let next=document.getElementById('academy-music-next');
  if(!next){next=document.createElement('button');next.id='academy-music-next';next.type='button';next.setAttribute('aria-label','Siguiente canción');next.textContent='›';slider.before(next);}
  let close=document.getElementById('academy-music-close');
  if(!close){close=document.createElement('button');close.id='academy-music-close';close.type='button';close.setAttribute('aria-label','Minimizar reproductor');close.textContent='×';control.append(close);}

  const mobile=()=>window.matchMedia('(max-width:700px)').matches;
  function setOpen(v){mobileOpen=!!v;control.classList.toggle('music-open',mobileOpen);localStorage.setItem(K_OPEN,mobileOpen?'1':'0');}
  function paint(){slider.value=String(volume);slider.style.setProperty('--music-fill',`${volume}%`);audio.volume=Math.max(0,Math.min(1,volume/100));audio.muted=muted;toggle.textContent=muted||volume===0?'♪':'♫';status.textContent=muted||volume===0?'Música en pausa':`${tracks[index].title} · ${Math.round(volume)}%`;}
  async function play(){if(muted||volume===0)return;try{await audio.play();unlocked=true;}catch(_){}paint();}
  function load(auto=false){audio.src=tracks[index].src;localStorage.setItem(K_TRACK,String(index));paint();if(auto)void play();}
  function advance(){index=(index+1)%tracks.length;muted=false;localStorage.setItem(K_MUTE,'0');load(true);}

  toggle.addEventListener('click',async e=>{e.preventDefault();e.stopPropagation();if(mobile()&&!mobileOpen){setOpen(true);if(!muted&&volume>0&&audio.paused)await play();return;}if(muted||volume===0){muted=false;if(volume===0)volume=10;localStorage.setItem(K_VOL,String(volume));localStorage.setItem(K_MUTE,'0');await play();}else if(audio.paused){await play();}else{muted=true;localStorage.setItem(K_MUTE,'1');paint();}});
  close.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();setOpen(false);});
  next.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();advance();});
  slider.addEventListener('input',async e=>{e.stopPropagation();volume=Math.max(0,Math.min(100,Number(slider.value)||0));muted=volume===0;localStorage.setItem(K_VOL,String(volume));localStorage.setItem(K_MUTE,muted?'1':'0');paint();if(!muted&&audio.paused&&unlocked)await play();});
  audio.addEventListener('ended',advance);
  const unlock=e=>{if(control.contains(e.target))return;if(!unlocked&&!muted&&volume>0)void play();};
  document.addEventListener('pointerdown',unlock,{capture:true,passive:true});
  document.addEventListener('touchend',unlock,{capture:true,passive:true});
  window.addEventListener('resize',()=>{if(!mobile())control.classList.remove('music-open');else setOpen(mobileOpen);});
  load(false); setOpen(mobile()?mobileOpen:true);
})();
