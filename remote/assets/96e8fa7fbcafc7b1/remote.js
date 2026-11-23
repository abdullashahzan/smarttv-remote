(() => {
  'use strict';
  const get = id => document.getElementById(id);
  const app = window.smartTVApp;
  const theme = value => {
    if (typeof value==='string' && /^[a-z]+$/.test(value)) document.documentElement.dataset.theme=value;
  };
  const more = get('more-sheet'), toast = get('notice');
  get('open-more').onclick = () => { more.append(toast); more.showModal(); };
  more.addEventListener('close', () => { if (!more.open) document.body.append(toast); });
  document.addEventListener('pointerdown', event => {
    const button = event.target.closest('button');
    if (event.isPrimary && event.button === 0 && button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') navigator.vibrate?.(10);
  }, {passive: true});
  const client = Array.from(crypto.getRandomValues(new Uint32Array(3))).join('-');
  let sequence = 0, csrf = '', state = {}, noticeTimer, keyboardUntil = 0;
  let connection, seeking = false, ringVisible = true, beatTimer = 0;
  const linkDialog = get('link-dialog');
  const zoomDialog = get('zoom-dialog'), zoomButton = get('open-zoom');
  const zoomIn = get('zoom-in'), zoomOut = get('zoom-out'), zoomReset = get('zoom-reset');
  const onWebsite = () => state.mode === 'website' && !state.websiteBackground;
  const websiteZoom = () => onWebsite() && state.browser_epoch != null;
  const canSearchChannels = () => onWebsite() && state.m3uSearch === true;
  const field = () => onWebsite() && state.keyboard ? state.field : '';
  const cursorButton=get('cursor-mode');
  let cursorEpoch=null, cursorLease, cursorSwitching=false, cursorOpeningSeq=0;
  const cursorAvailable=()=>onWebsite() && state.cursorAvailable===true && state.browser_epoch!=null;
  const cursorActive=()=>cursorEpoch!==null;
  const status = get('remote-status');
  const latency = get('remote-latency');
  let beatSequence = 0, latencyUpdated = 0;
  const restartButton = get('restart-service');
  let restartTimer, restartPending = false;
  function clearLatency() {
    ++beatSequence;
    latency.hidden = true;
  }
  function setConnection(label, connected=false) {
    status.textContent = label;
    status.dataset.state = connected ? 'connected' : 'idle';
    if (!connected) clearLatency();
    restartButton.disabled = !connected || restartPending;
  }
  function notice(message) {
    clearTimeout(noticeTimer);
    get('notice').textContent = message;
    get('notice').hidden = false;
    noticeTimer = setTimeout(() => { get('notice').hidden = true; }, 3500);
  }
  async function request(url, body, keepalive=false, signal) {
    const response = app ? await app.fetch(url, body, keepalive, signal) : await fetch(url, body === undefined ? {} : {
      method:'POST', keepalive, signal, headers:{'Content-Type':'application/json','X-CSRFToken':csrf}, body:JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(Error(data.error || 'The TV could not complete this command.'), {status: response.status});
    return data;
  }
  const packet = (name,payload,epoch) => ({name,payload,epoch,client,seq:++sequence});
  const post = (data,keepalive,signal) => request('/api/command',data,keepalive,signal);
  function send(name,payload={}) {
    return post(packet(name,payload,(state.mode === 'website' ? state.browser_epoch : null))).catch(error => notice(error.message));
  }
  let navigationQueue=Promise.resolve();
  function sendNavigation(name) {
    const epoch=state.mode==='website'?state.browser_epoch:null;
    const background=Boolean(state.websiteBackground||state.localBackground);
    const queued=performance.now();
    return navigationQueue=navigationQueue.then(()=>{
      if (performance.now()-queued>350 || (state.mode==='website'?state.browser_epoch:null)!==epoch ||
          Boolean(state.websiteBackground||state.localBackground)!==background) return;
      return post(packet(name,{},epoch),false,AbortSignal.timeout?.(600));
    }).catch(error=>notice(error.message));
  }
  const touchpad = CouchDeckPhoneTouchpad({
    get, packet, post, notice, settings:{touchpadTap:true,touchpadHaptics:true},
    context:() => state.browser_epoch, edge:() => false,
    reason:() => onWebsite() ? '' : 'Open or resume a website to use the touchpad.'
  });
  get('open-buttons').onclick=()=>{
    if (cursorSwitching) return;
    if (cursorActive()) void cursorButton.onclick();
    else touchpad.close();
  };
  get('open-touchpad').onclick=async()=>{
    if (cursorSwitching) return;
    if (cursorActive()) {
      cursorSwitching=true;
      try { await closeCursor(); } finally { cursorSwitching=false; drawCursor(); }
    }
    touchpad.activate();
  };
  function typeHere() {
    if (!get('typing').open) {
      get('text').value = '';
      get('typing').showModal();
    }
    get('text').focus();
  }
  function ok() {
    if (cursorSwitching) return;
    if (cursorActive()) { stopArrow(); void cursorAction('click'); return; }
    keyboardUntil = Date.now() + 2200;
    if (field()) { keyboardUntil = 0; typeHere(); }
    else sendNavigation('ok');
  }
  function adjacency() {
    if (state.mode === 'playing') {
      const at = Number(state.episode_index || 1);
      const count = Number(state.episode_count || 0);
      return {previous: at > 1, next: !count || at < count};
    }
    if (state.mode === 'website') {
      return {previous: state.previousAvailable !== false, next: state.nextAvailable !== false};
    }
    return {previous: false, next: false};
  }
  function render() {
    const player = state;
    const home = document.querySelector('[data-cmd="home"]');
    home.querySelector('span').textContent = state.websiteBackground || state.localBackground ? 'Resume' : 'Home';
    const liveVolume=(state.mode==='playing'||onWebsite())&&player.volumePreference!=null&&player.volumePreference===player.mediaVolume;
    const volume = (liveVolume?player.volume:player.mediaVolume) ?? player.volume ?? .65;
    get('volume-level').textContent = `${player.muted?'Muted':'Volume'} · ${Math.round(volume * 100)}%`;
    const duration = Number(player.duration);
    get('seek').disabled = !(duration > 0 && Number.isFinite(duration)) || player.seekable === false;
    for (const button of document.querySelectorAll('[data-skip]')) button.disabled = get('seek').disabled;
    if (!seeking) get('seek').value = duration > 0 ? 1000 * (player.position || 0) / duration : 0;
    const play = get('play');
    play.querySelector('span').textContent = state.playing ? 'Pause' : 'Play';
    play.querySelector('use').setAttribute('href', state.playing ? '#i-pause' : '#i-play');
    get('reload-page').disabled = !onWebsite();
    get('bookmark-page').disabled = !onWebsite();
    get('open-discover').disabled = onWebsite() || state.mode==='playing'&&!state.localBackground;
    const zoom = state.zoom ?? 1;
    zoomButton.hidden = !websiteZoom();
    get('zoom-level').value = `${Math.round(zoom * 100)}%`;
    zoomIn.disabled = !websiteZoom() || zoom >= 2;
    zoomOut.disabled = !websiteZoom() || zoom <= .5;
    zoomReset.disabled = !websiteZoom() || zoom === 1;
    if (!websiteZoom() && zoomDialog.open) zoomDialog.close();
    const mute = get('mute');
    const canMute = state.mode === 'playing' || state.mode === 'website' && state.browser_epoch != null;
    const muted = canMute && state.muted === true;
    mute.disabled = !canMute;
    mute.setAttribute('aria-pressed', String(muted));
    mute.title = muted ? 'Unmute' : 'Mute';
    mute.querySelector('use').setAttribute('href', muted ? '#i-muted' : '#i-volume');
    get('m3u-search').hidden = !canSearchChannels();
    if (!canSearchChannels() && get('m3u-search-dialog').open) get('m3u-search-dialog').close();
    const autoSkip = get('auto-skip');
    autoSkip.hidden = !onWebsite() || typeof state.autoSkip !== 'boolean';
    autoSkip.setAttribute('aria-pressed', String(state.autoSkip === true));
    const adblock = get('adblock');
    adblock.hidden = !onWebsite() || !state.adblock;
    adblock.setAttribute('aria-pressed', String(state.adblock?.enabled === false));
    adblock.title = state.adblock?.failed ? 'Stands could not load. Tap to retry and reopen the page.' : 'Reopens the current page';
    const adjacent = adjacency();
    for (const name of ['previous', 'next']) {
      document.querySelector(`[data-cmd="${name}"]`).disabled = !adjacent[name];
    }
    if (!linkDialog.open && keyboardUntil > Date.now() && field()) { keyboardUntil = 0; typeHere(); }
    if (cursorActive() && (!cursorAvailable()||cursorEpoch!==state.browser_epoch)) void closeCursor();
    drawCursor();
  }
  function siteMark(site) {
    const name = (site.name || '').toLowerCase();
    const url = (() => { try { return new URL(site.url); } catch { return null; } })();
    const host = url?.hostname || '';
    const mark = (inner) => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      el.setAttribute('viewBox', '0 0 24 24');
      el.setAttribute('width', '44');
      el.setAttribute('height', '44');
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = inner;
      return el;
    };
    const youtube = /youtube/.test(name) || /(^|\.)youtube/.test(host);
    const netflix = /netflix/.test(name) || /(^|\.)netflix/.test(host);
    const prime = /prime|amazon/.test(name) || /(^|\.)amazon/.test(host);
    const disney = /disney/.test(name) || /(^|\.)disney/.test(host);
    if (/^(www\.)?(flixer\.gd|cinejoy\.pk)$/.test(host) && url.pathname==='/') return mark('<g fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16m10-16v16M3 9h4m-4 6h4m10-6h4m-4 6h4"/></g>');
    if (/(^|\.)m3u-ip\.tv$/.test(host)) return mark('<g fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="m8 3 4 4 4-4m0 10h2m-2 3h2"/></g>');
    if (youtube) return mark(`<path fill="#FF0000" d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 4.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-4.814z"/><path fill="#fff" d="M9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>`);
    if (netflix) return mark(`<path fill="#E50914" d="M2.5 3h4.6v18H2.5zM16.9 3h4.6v18h-4.6z"/><path d="M6.8 4.6 16.8 19.4" stroke="#E50914" stroke-width="4.4" stroke-linecap="round"/>`);
    if (prime) return mark(`<text x="12" y="20" text-anchor="middle" fill="#FF9900" font-family="Arial, sans-serif" font-size="23" font-weight="700">A</text>`);
    if (disney) return mark(`<path fill="#00A1DE" d="M12 2.8 14.9 8.6 21.4 9.3 16.4 13.8 17.7 20.6 12 17.2 6.3 20.6 7.6 13.8 2.6 9.3 9.1 8.6z"/>`);
    if (app) {
      const initial = document.createElement('span');
      initial.textContent = (site.name || host || '?').slice(0, 1).toUpperCase();
      return initial;
    }
    const source = /^https?:\/\/[^\/]+\/favicon\.ico$/i.test(site.favicon || '') ? site.favicon.replace(/\/favicon\.ico$/i, '/apple-touch-icon') : (site.favicon || '');
    const custom = source && !/\/(favicon\.ico|apple-touch-icon)$/i.test(source) ? source : '';
    const icon = custom || (host ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host.replace(/^www\./, ''))}&sz=128` : source);
    const mark2 = document.createElement('img');
    mark2.alt = '';
    mark2.setAttribute('aria-hidden','true');
    mark2.loading = 'lazy';
    mark2.src = icon;
    mark2.onerror = () => {
      const fallback = document.createElement('span');
      fallback.textContent = site.name.slice(0,1).toUpperCase();
      fallback.setAttribute('aria-hidden','true');
      mark2.replaceWith(fallback);
    };
    return mark2;
  }
  async function refreshSites() {
    try {
      const {sites} = await request('/api/sites');
      const strip=get('sites'), addButton=get('add-site');
      const position=strip.scrollLeft;
      strip.replaceChildren(...sites.map(site => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'site-tile';
        const icon = document.createElement('span'), label = document.createElement('span');
        icon.className = 'site-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.append(siteMark(site));
        label.className = 'site-name';
        label.textContent = site.name || site.url;
        button.append(icon, label);
        button.title = `${label.textContent} — press and hold to edit`;
        let holdTimer = 0, held = false;
        const stopHold = () => clearTimeout(holdTimer);
        button.onpointerdown = () => {
          held = false;
          holdTimer = setTimeout(() => { held = true; editSite(site); }, 500);
        };
        button.onpointerup = stopHold;
        button.onpointerleave = stopHold;
        button.onpointercancel = stopHold;
        button.oncontextmenu = event => { event.preventDefault(); editSite(site); };
        button.onclick = async () => {
          if (held) { held = false; return; }
          await send('open_site',{id:site.id});
        };
        return button;
      }),addButton);
      strip.scrollLeft=position;
    } catch(error) { notice(error.message); }
  }
  const addSiteDialog=get('add-site-dialog');
  const addSiteForm=get('add-site-form');
  let editingSite=null;
  function siteField(name) { return addSiteForm.elements.namedItem(name); }
  function siteDialog(site) {
    editingSite = site || null;
    addSiteDialog.querySelector('h2').textContent = site ? 'Edit site' : 'Add site';
    addSiteDialog.querySelector('button[type="submit"]').textContent = site ? 'Save changes' : 'Add site';
    siteField('name').value = site ? site.name || '' : '';
    siteField('url').value = site ? site.url || '' : '';
    get('remove-site').hidden = !site;
    get('remove-site').textContent = 'Remove site';
    addSiteDialog.showModal();
  }
  function editSite(site) {
    if (addSiteDialog.open) return;
    siteDialog(site);
  }
  get('add-site').onclick = () => siteDialog(null);
  get('cancel-add-site').onclick = () => addSiteDialog.close();
  get('remove-site').onclick = async () => {
    const site = editingSite, button = get('remove-site');
    if (!site) return;
    if (button.textContent !== 'Confirm remove') { button.textContent = 'Confirm remove'; return; }
    try{
      await request(`/api/sites/${site.id}/delete`,{});
      editingSite = null;
      addSiteForm.reset();
      addSiteDialog.close();
      await refreshSites();
      notice('Site removed.');
    }catch(error){notice(error.message);}
  };
  addSiteForm.onsubmit = async event=>{
    event.preventDefault();
    const values=new FormData(addSiteForm);
    const site = editingSite;
    const payload = {name:values.get('name'), url:values.get('url'), row:site ? site.row : 'streaming'};
    if (site) payload.favicon = /^https?:\/\//i.test(site.favicon) ? site.favicon : '';
    try{
      await request(site ? `/api/sites/${site.id}` : '/api/sites/add', payload);
      editingSite = null;
      addSiteForm.reset();
      addSiteDialog.close();
      await refreshSites();
      notice(site ? 'Site updated.' : 'Site added.');
    }catch(error){notice(error.message);}
  };

  let arrowHold;
  function drawCursor() {
    touchpad.refresh();
    cursorButton.hidden=!cursorAvailable();
    cursorButton.disabled=cursorSwitching;
    cursorButton.setAttribute('aria-pressed',String(cursorActive()));
    if (cursorActive()) get('open-buttons').setAttribute('aria-pressed','false');
    get('ring').disabled=cursorActive();
  }
  function cursorAction(action,dir,epoch=cursorEpoch) {
    return post(packet('cursor_action',dir?{action,dir}:{action},epoch),false,AbortSignal.timeout?.(600)).catch(error=>{
      if (cursorEpoch===epoch) { void closeCursor(); notice(error.message); }
    });
  }
  async function closeCursor(send=true) {
    if (!cursorActive()) return;
    const epoch=cursorEpoch;
    stopArrow();
    stopStick();
    clearInterval(cursorLease);
    cursorOpeningSeq=0;
    cursorEpoch=null;
    drawCursor();
    if (send) await post(packet('cursor_state',{open:false},epoch),true,AbortSignal.timeout?.(800)).catch(()=>{});
  }
  cursorButton.onclick=async()=>{
    if (cursorSwitching||!cursorAvailable()) return;
    const epoch=state.browser_epoch;
    cursorSwitching=true;
    drawCursor();
    try {
      if (cursorActive()) { await closeCursor(); return; }
      if (touchpad.open) await touchpad.close();
      if (!cursorAvailable()||state.browser_epoch!==epoch||document.hidden) return;
      stopArrow();
      stopStick();
      keyboardUntil=0;
      cursorEpoch=epoch;
      drawCursor();
      let pending=false;
      const renew=async(renewal=true)=>{
        if (pending||cursorEpoch!==epoch) return;
        const data=packet('cursor_state',renewal?{open:true,renew:true}:{open:true},epoch);
        if (!renewal) cursorOpeningSeq=data.seq;
        pending=true;
        try { await post(data,false,AbortSignal.timeout?.(650)); }
        catch(error) { if (cursorEpoch===epoch) { await closeCursor(); notice(error.message); } }
        finally { pending=false; }
      };
      cursorLease=setInterval(renew,1200);
      await renew(false);
    } finally { cursorSwitching=false; drawCursor(); }
  };
  function stopArrow(event) {
    if (!arrowHold || (event?.pointerId !== undefined && event.pointerId !== arrowHold.id)) return;
    const hold=arrowHold;
    arrowHold = null;
    clearTimeout(hold.timer);
    if (hold.started) {
      const data=packet('cursor_action',{action:'stop'},hold.epoch);
      void hold.started.then(()=>post(data,true)).catch(()=>{});
    }
  }
  for (const key of document.querySelectorAll('[data-key]')) {
    const direction = key.dataset.key;
    let repeated = false, cursorPress=false;
    key.onpointerdown = event => {
      if (event.button !== 0 || !event.isPrimary) return;
      repeated = false;
      cursorPress=cursorActive()||cursorSwitching;
      if (cursorSwitching) return;
      stopArrow();
      key.setPointerCapture(event.pointerId);
      const hold = arrowHold = {id:event.pointerId};
      if (cursorActive()) {
        hold.epoch=cursorEpoch;
        hold.started=cursorAction('start',direction,hold.epoch);
        const repeat=async()=>{
          if (hold!==arrowHold) return;
          await cursorAction('hold',direction,hold.epoch);
          if (hold===arrowHold) hold.timer=setTimeout(repeat,105);
        };
        void hold.started.then(()=>{if (hold===arrowHold) hold.timer=setTimeout(repeat,105);});
        return;
      }
      const repeat = async () => {
        if (hold !== arrowHold || touchpad.open) return;
        repeated = true;
        await sendNavigation(direction);
        if (hold === arrowHold) hold.timer = setTimeout(repeat, 125);
      };
      hold.timer = setTimeout(repeat, 300);
    };
    key.onpointerup = key.onpointercancel = key.onlostpointercapture = stopArrow;
    key.oncontextmenu = event => event.preventDefault();
    key.onclick = event => {
      if (cursorSwitching || (event.detail!==0 && cursorPress)) return;
      if (cursorActive()) {
        if (event.detail===0) void cursorAction('step',direction);
        return;
      }
      if (event.detail === 0 || !repeated) sendNavigation(direction);
    };
  }
  for (const key of document.querySelectorAll('[data-cmd]')) key.onclick = () => send(key.dataset.cmd);
  for (const key of document.querySelectorAll('[data-skip]')) key.onclick = () => send('skip',{seconds:Number(key.dataset.skip)});
  for (const key of document.querySelectorAll('[data-volume]')) {
    key.onclick = () => send('volume',{step:Number(key.dataset.volume)});
  }
  const stick = document.querySelector('.ok-key');
  let drag, scrollTimer, suppressClick = false;
  function scrollSignal(gesture, dir, phase) {
    if (phase==='hold' && gesture.pending) return;
    const data=packet('scroll',{dir,phase},gesture.epoch);
    if (phase==='hold') gesture.pending=true;
    void post(data,phase==='stop').catch(error=>{
      if (phase==='hold' && drag===gesture && gesture.dir===dir) {
        stopStick();
        notice(error.message);
      }
    }).finally(()=>{
      if (phase!=='hold') return;
      gesture.pending=false;
      if (drag===gesture && gesture.dir && gesture.dir!==dir) scrollSignal(gesture,gesture.dir,'hold');
    });
  }
  function stopStick(event) {
    if (event?.pointerId!==undefined && event.pointerId!==drag?.id) return;
    clearInterval(scrollTimer);
    if (drag?.dir) scrollSignal(drag,drag.dir,'stop');
    drag = null;
    stick.style.transform = '';
  }
  stick.onpointerdown = event => {
    if (cursorSwitching||drag||event.button!==0) return;
    suppressClick = false;
    drag = {x:event.clientX,y:event.clientY,id:event.pointerId,dir:'',
      epoch:state.mode==='website'?state.browser_epoch:null};
    stick.setPointerCapture(event.pointerId);
  };
  stick.onpointermove = event => {
    if (!drag || drag.id !== event.pointerId) return;
    const x = event.clientX-drag.x, y = event.clientY-drag.y, distance = Math.hypot(x,y);
    const scale = Math.min(1,18 / (distance || 1));
    stick.style.transform = 'translate('+x*scale+'px,'+y*scale+'px)';
    const horizontal=Math.abs(x), vertical=Math.abs(y);
    const previous=drag.dir;
    const wasHorizontal=previous==='left'||previous==='right';
    const along=({right:x,left:-x,down:y,up:-y})[previous]||0;
    // Hold a direction through small finger movements near a diagonal or the dead zone.
    const dir=distance<(previous?7:12) ? '' : along>=7 &&
      (wasHorizontal?vertical:horizontal)<along*1.25 ? previous :
      horizontal>vertical ? (x>0?'right':'left') : (y>0?'down':'up');
    if (dir === drag.dir) return;
    clearInterval(scrollTimer);
    drag.dir = dir;
    if (dir) {
      stopArrow();
      suppressClick = true;
      const gesture=drag;
      scrollSignal(gesture,dir,'hold');
      scrollTimer = setInterval(() => scrollSignal(gesture,dir,'hold'),150);
    } else if (previous) scrollSignal(drag,previous,'stop');
  };
  stick.onpointerup = stick.onlostpointercapture = stopStick;
  stick.onpointercancel = event => { suppressClick = true; stopStick(event); };
  window.addEventListener('blur',stopStick);
  window.addEventListener('blur',stopArrow);
  window.addEventListener('pagehide',stopStick);
  window.addEventListener('pagehide',stopArrow);
  window.addEventListener('pagehide',()=>void closeCursor());
  document.addEventListener('visibilitychange',()=>{ if (document.hidden) {stopStick();stopArrow();void closeCursor();} });
  stick.onclick = event => { if (!suppressClick || event.detail === 0) ok(); suppressClick = false; };
  get('seek').oninput = () => { seeking = true; };
  get('seek').onchange = () => { seeking = false; send('seek',{position:Number(get('seek').value)*state.duration/1000}); };
  get('seek').onpointercancel = () => { seeking = false; render(); };
  get('back').onclick = () => send('back');
  zoomButton.onclick = () => { if (websiteZoom() && !zoomDialog.open) zoomDialog.showModal(); };
  let zoomQueue = Promise.resolve();
  function changeZoom(payload) {
    if (!websiteZoom()) return;
    const data = packet('zoom', payload, state.browser_epoch);
    zoomQueue = zoomQueue.then(() => {
      if (websiteZoom() && data.epoch === state.browser_epoch) {
        return post(data, false, AbortSignal.timeout?.(1500));
      }
    }).catch(error => notice(error.message));
  }
  zoomOut.onclick = () => changeZoom({step:-1});
  zoomIn.onclick = () => changeZoom({step:1});
  zoomReset.onclick = () => changeZoom({value:1});
  const linkInput = get('link-url'), linkError = get('link-error');
  const linkForm = get('link-form'), linkSubmit = linkForm.querySelector('[type="submit"]');
  get('open-link').onclick = () => {
    if (linkDialog.open || linkSubmit.disabled) return;
    keyboardUntil = 0;
    linkError.hidden = true;
    linkDialog.showModal();
    linkInput.focus();
  };
  linkInput.oninput = () => { linkError.hidden = true; };
  linkForm.onsubmit = async event => {
    event.preventDefault();
    if (linkSubmit.disabled) return;
    const url = linkInput.value.trim();
    linkError.hidden = true;
    linkSubmit.disabled = linkInput.readOnly = true;
    try {
      await post(packet('open_url',{url},state.mode === 'website' ? state.browser_epoch : null));
      linkInput.value = '';
      linkDialog.close();
    } catch (error) {
      linkError.textContent = error.message;
      linkError.hidden = false;
      if (!linkDialog.open) notice(error.message);
    } finally {
      linkSubmit.disabled = linkInput.readOnly = false;
    }
  };
  const channelDialog = get('m3u-search-dialog');
  const discoverDialog=get('discover-dialog'), discoverInput=get('remote-discover-query');
  const discoverError=get('remote-discover-error'), discoverSubmit=discoverDialog.querySelector('[type="submit"]');
  get('open-discover').onclick=()=>{
    if(discoverDialog.open||discoverSubmit.disabled)return;
    discoverError.hidden=true;
    discoverDialog.showModal();
    discoverInput.focus();
  };
  discoverInput.oninput=()=>{discoverError.hidden=true;};
  discoverDialog.querySelector('form').onsubmit=async event=>{
    event.preventDefault();
    const query=discoverInput.value.trim();
    if(!query||discoverSubmit.disabled)return;
    discoverSubmit.disabled=true;
    try {
      await post(packet('discover_search',{query}));
      discoverDialog.close();
      more.close();
    } catch(error) {
      discoverError.textContent=error.message;
      discoverError.hidden=false;
    } finally {discoverSubmit.disabled=false;}
  };
  get('m3u-search').onclick = () => {
    if (!canSearchChannels() || channelDialog.open) return;
    get('m3u-query').value = '';
    channelDialog.showModal();
  };
  channelDialog.querySelector('form').onsubmit = event => {
    if (canSearchChannels()) {
      const query = event.submitter?.value === 'clear' ? '' : get('m3u-query').value.trim();
      send('m3u_search',{query});
    }
  };
  get('typing').querySelector('form').onsubmit = () => {
    const text = get('text').value;
    if (field()) send('enter',{text,field:field()});
    else notice('Select a text field on the TV.');
  };
  get('ring').onclick = () => {
    ringVisible = !ringVisible;
    get('ring').setAttribute('aria-pressed',String(ringVisible));
    send('focus_ring',{visible:ringVisible});
  };
  get('auto-skip').onclick = () => send('auto_skip',{enabled:!state.autoSkip});
  get('adblock').onclick = async () => {
    const button = get('adblock');
    if (!state.adblock || button.disabled) return;
    button.disabled = true;
    try { await send('adblock',{enabled:!state.adblock.enabled}); }
    finally { button.disabled = false; }
  };
  const installDialog = get('install-dialog');
  let offerInstall;
  if (installDialog) {
    const installButtons = [get('install-app'), get('install-unpaired')];
    const standalone = matchMedia('(display-mode: standalone)');
    const secureButton = get('install-open');
    const confirmInstall = get('install-confirm');
    const httpsPort = Number(installDialog.dataset.httpsPort);
    const appLink = installDialog.dataset.appLink;
    let installPrompt = null, justInstalled = false;
    const refreshInstall = () => {
      for (const button of installButtons) {
        button.hidden = justInstalled || standalone.matches || navigator.standalone === true;
      }
    };
    function describeInstall() {
      const copy = get('install-copy');
      let steps;
      secureButton.hidden = isSecureContext || !httpsPort;
      if (isSecureContext) {
        copy.textContent = 'Install smartTV from Chrome to open the remote without the address bar.';
        steps = ['Open Chrome’s ⋮ menu.', 'Select Add to Home screen, then choose Install if offered.'];
      } else if (httpsPort) {
        copy.textContent = 'Chrome needs a trusted HTTPS address to install the remote.';
        steps = ['Copy browser-runtime/tls/ca.crt directly from your TV computer using a trusted transfer, such as USB.',
                 'In Android Settings, install it as a CA certificate only if you trust this TV.',
                 'Open the secure remote. If Chrome shows a certificate warning, stop and check the setup.'];
      } else {
        copy.textContent = 'Plain HTTP still works for control, but Chrome needs HTTPS to install the app.';
        steps = ['On the TV computer, run ./run.sh --enable-https and restart smartTV.',
                 'Reload this page and tap Install app again.'];
      }
      get('install-steps').replaceChildren(...steps.map(text => {
        const item = document.createElement('li');
        item.textContent = text;
        return item;
      }));
      if (!installDialog.open) installDialog.showModal();
    }
    const openInstall = async event => {
      if (appLink && !isSecureContext) {
        const button = event.currentTarget;
        button.disabled = true;
        try { location.assign((await request(appLink, {})).url); }
        catch(error) { notice(error.message); }
        finally { button.disabled = false; }
        return;
      }
      if (installPrompt) {
        const prompt = installPrompt;
        installPrompt = null;
        confirmInstall.hidden = true;
        try {
          await prompt.prompt();
          return;
        } catch { /* Chrome's menu remains available if its prompt fails. */ }
      }
      describeInstall();
    };
    for (const button of installButtons) button.onclick = openInstall;
    confirmInstall.onclick = openInstall;
    if (app?.fresh && !standalone.matches && navigator.standalone !== true) {
      offerInstall = () => { offerInstall = undefined; if (!justInstalled) describeInstall(); };
    }
    secureButton.onclick = () => {
      const url = new URL('/remote', location.href);
      url.protocol = 'https:';
      url.port = httpsPort;
      location.assign(url);
    };
    addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      installPrompt = event;
      confirmInstall.hidden = false;
    });
    addEventListener('appinstalled', () => {
      installPrompt = null;
      justInstalled = true;
      if (installDialog.open) installDialog.close();
      refreshInstall();
      notice('smartTV installed.');
    });
    standalone.addEventListener('change', refreshInstall);
    refreshInstall();
  }
  for (const dialog of document.querySelectorAll('dialog')) dialog.onclick = event => {
    if (event.target === dialog || event.target.closest('[data-close-dialog]')) dialog.close();
  };
  restartButton.onclick = () => get('restart-dialog').showModal();
  get('restart-form').onsubmit = async event => {
    event.preventDefault();
    get('restart-dialog').close();
    if (restartButton.disabled) return;
    restartPending = true;
    restartButton.disabled = true;
    try {
      await request('/api/remote/restart', {});
      if (!restartPending) return;
      setConnection('Restarting');
      restartTimer = setTimeout(() => {
        restartPending = false;
        const connected = connection?.readyState === EventSource.OPEN;
        setConnection(connected ? 'Connected' : 'Reconnecting', connected);
        notice('The update or restart may still be running. Check the TV if it does not reconnect.');
      }, 180000);
    } catch(error) {
      restartPending = false;
      const connected = connection?.readyState === EventSource.OPEN;
      setConnection(connected ? 'Connected' : 'Reconnecting', connected);
      notice(error.message);
    }
  };
  function presence(action) {
    if (app) return app.fetch('/api/remote/'+action, {client}, true).catch(() => {});
    return fetch('/api/remote/'+action, {method:'POST', keepalive:true,
      headers:{'Content-Type':'application/json','X-CSRFToken':csrf},
      body:JSON.stringify({client})}).catch(() => {});
  }
  async function beat() {
    const started = performance.now();
    if (started - latencyUpdated >= 10000) latency.hidden = true;
    const sample = ++beatSequence;
    const response = await presence('alive');
    if (sample !== beatSequence || status.dataset.state !== 'connected') return;
    if (!response?.ok) { latency.hidden = true; return; }
    latencyUpdated = performance.now();
    const label = `${Math.round(latencyUpdated - started)} ms`;
    if (latency.textContent !== label) latency.textContent = label;
    latency.hidden = false;
  }
  function startBeats() {
    clearInterval(beatTimer);
    beatTimer = setInterval(beat, 5000);
    beat();
  }
  function connect() {
    connection?.close();
    setConnection('Connecting');
    get('pair-panel').inert = true;
    get('pair-panel').classList.add('hidden');
    get('remote-panel').inert = false;
    get('remote-panel').classList.remove('hidden');
    render();
    const streamUrl = '/api/events/remote?'+new URLSearchParams({client,pointer_client:client});
    connection = app ? app.stream(streamUrl) : new EventSource(streamUrl);
    connection.onopen = () => {
      if (restartPending) {
        clearTimeout(restartTimer);
        restartPending = false;
        notice('Service is back online.');
      }
      setConnection('Connected', true);
      beat();
      void refreshSites();
    };
    connection.onerror = () => { stopArrow(); void closeCursor(false); setConnection(restartPending ? 'Restarting' : 'Reconnecting'); };
    if (app) connection.onunauthorized = () => { clearInterval(beatTimer); app.forget(); showPairing(); };
    connection.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.type === 'theme') theme(message.theme);
      if (message.type === 'state') {
        theme(message.state.theme);
        if (state.mode!==message.state.mode || state.browser_epoch!==message.state.browser_epoch ||
            state.websiteBackground!==message.state.websiteBackground || state.localBackground!==message.state.localBackground) {
          stopStick();
          stopArrow();
          for (const id of ['typing','m3u-search-dialog','zoom-dialog','discover-dialog']) if (get(id).open) get(id).close();
        }
        const failed = message.state.adblock?.failed && !state.adblock?.failed;
        const lostCursor=state.cursorOwner===client && message.state.cursorOwner!==client;
        state = message.state;
        if (lostCursor) void closeCursor(false);
        render();
        if (failed) notice('Stands could not load. The site opened without it.');
      }
      if (message.type === 'sites') void refreshSites();
      if (message.type === 'browser_ack' && message.client === client) {
        if (message.error) {
          if (message.seq===cursorOpeningSeq) void closeCursor(false);
          notice(message.error);
        } else if (message.notice) notice(message.notice);
      }
    };
    startBeats();
  }
  addEventListener('pagehide', event => {
    if (!connection) return;
    clearInterval(beatTimer);
    clearLatency();
    // Locking the phone or backgrounding the tab is not a departure.
    if (!event.persisted) presence('leave');
    connection.close();
  });
  addEventListener('offline', () => { stopStick(); stopArrow(); void closeCursor(false); clearLatency(); });
  addEventListener('online', () => { if (connection) { beat(); } });
  addEventListener('pageshow', event => {
    if (event.persisted && connection) connect();
  });
  function showPairing() {
    setConnection('Not connected');
    get('remote-panel').inert = true;
    get('remote-panel').classList.add('hidden');
    get('pair-panel').inert = false;
    get('pair-panel').classList.remove('hidden');
    if (app && !app.canConnect()) {
      get('pair-copy').textContent = 'Scan the QR code on your TV, then tap Install app on the remote to connect.';
      get('pair-form').hidden = true;
    }
  }
  get('pair-form').onsubmit = async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    setConnection('Connecting');
    try {
      const result = app ? await app.connect(request) : await request('/api/pair', {});
      state = result.state;
      theme(state?.theme);
      get('service-actions').hidden = !result.restart_available;
      connect();
      offerInstall?.();
    } catch(error) {
      setConnection('Not connected');
      if (app && error.status === 403) { app.forget(); showPairing(); }
      notice(error.message);
    } finally { button.disabled = false; }
  };
  if (isSecureContext && 'serviceWorker' in navigator) navigator.serviceWorker.register(app ? './sw.js' : '/sw.js').catch(()=>{});
  if (app) get('remote-url').textContent = app.tv || '';
  (app ? (app.canConnect() ? app.connect(request) : Promise.resolve({})) : request('/api/bootstrap')).then(result => {
    csrf = result.csrf; state = result.state || {};
    theme(state.theme);
    get('service-actions').hidden = !result.restart_available;
    if (result.paired) { connect(); offerInstall?.(); }
    else showPairing();
  }).catch(error => {
    if (app) { if (error.status === 403) app.forget(); showPairing(); }
    else setConnection('Offline');
    notice(error.message);
  });
})();
