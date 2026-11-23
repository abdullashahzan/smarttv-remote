(() => {
  'use strict';
  const storageKey = 'smarttv-remote-v1';
  function localURL(value) {
    try {
      const url = new URL(value);
      const host = url.hostname;
      const octets = host.split('.').map(Number);
      const privateIPv4 = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
        (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
         (octets[0] === 192 && octets[1] === 168));
      if (url.protocol === 'http:' && url.pathname === '/remote' && !url.username && !url.password &&
          !url.search && !url.hash && (privateIPv4 || /^\[f[cd][a-f\d]{2}:/i.test(host))) return url;
    } catch { /* Not a TV's LAN address. */ }
    return null;
  }
  const handoff = new URLSearchParams(location.hash.slice(1));
  const handoffTV = localURL(handoff.get('tv'));
  let ticket = handoffTV && /^[\w-]{43}$/.test(handoff.get('ticket') || '') ? handoff.get('ticket') : '';
  if (location.hash) history.replaceState(null, '', location.pathname);
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(storageKey)) || {}; } catch { /* Storage is optional. */ }
  const tv = ticket ? handoffTV : localURL(stored.tv);
  let token = typeof stored.token === 'string' && tv?.href === stored.tv ? stored.token : '';

  function fetchTV(path, body, keepalive=false, signal) {
    if (!tv || !path.startsWith('/api/')) return Promise.reject(Error('Scan the TV’s QR code to connect.'));
    const url = new URL('/phone-app/' + path.slice(5), tv.origin);
    const pairing = path === '/api/pair';
    const headers = {'Authorization': 'Bearer ' + (pairing ? ticket : token)};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(url, {method:body === undefined ? 'GET' : 'POST', headers, keepalive, signal,
      body:body === undefined ? undefined : JSON.stringify(body), credentials:'omit', redirect:'error',
      targetAddressSpace:'local', referrerPolicy:'no-referrer'});
  }

  function stream(path) {
    const controller = new AbortController();
    let timer;
    const connection = {
      readyState: 0,
      close() { clearTimeout(timer); controller.abort(); this.readyState = 2; }
    };
    async function listen() {
      try {
        const response = await fetchTV(path, undefined, false, controller.signal);
        if (response.status === 403) { connection.close(); connection.onunauthorized?.(); return; }
        if (!response.ok || !response.body) throw Error('The TV is unavailable.');
        connection.readyState = 1;
        connection.onopen?.();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const {value, done} = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, {stream:true});
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const data = buffer.slice(0, end).split('\n').filter(line => line.startsWith('data: '))
              .map(line => line.slice(6)).join('\n');
            buffer = buffer.slice(end + 2);
            if (data) connection.onmessage?.({data});
          }
        }
      } catch { /* Retry the stream, never a button press. */ }
      if (controller.signal.aborted) return;
      connection.readyState = 0;
      connection.onerror?.();
      timer = setTimeout(listen, 2000);
    }
    void listen();
    return connection;
  }

  window.smartTVApp = {
    tv: tv?.href,
    fresh: Boolean(ticket),
    fetch: fetchTV,
    stream,
    canConnect: () => Boolean(tv && (ticket || token)),
    forget() {
      ticket = token = '';
      try { localStorage.removeItem(storageKey); } catch { /* Storage is optional. */ }
    },
    async connect(request) {
      if (!ticket) return request('/api/bootstrap');
      const result = await request('/api/pair', {});
      token = result.token;
      ticket = '';
      try { localStorage.setItem(storageKey, JSON.stringify({tv:tv.href, token})); } catch { /* Storage is optional. */ }
      return result;
    }
  };
})();
