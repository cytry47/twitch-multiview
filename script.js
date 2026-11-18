(function(){
  "use strict";

  /* =====================================================================
     CONFIGURACIÓN — edita estas dos constantes con los datos de tu app
     registrada en https://dev.twitch.tv/console

     - CLIENT_ID: el Client ID de tu app de Twitch.
     - REDIRECT_URI: debe ser EXACTAMENTE igual (incluyendo protocolo,
       sin barra final si no la pusiste al registrar) a la URL donde
       sirves esta página en GitHub Pages, por ejemplo:
       "https://tu-usuario.github.io/tu-repo/"
       y tiene que estar dada de alta tal cual en el panel de Twitch
       en "OAuth Redirect URLs".
     ===================================================================== */
  const CLIENT_ID = "m13brzygevbk4qrnhg32eimd6awkvc";
  const REDIRECT_URI = window.location.origin + window.location.pathname;

  // El IRC siempre es anónimo (solo lectura); para escribir se usa el chat
  // nativo de Twitch de cada pestaña. "user:read:follows" prepara la
  // lista de canales seguidos (ronda 3).
  const OAUTH_SCOPES = "user:read:follows";

  const STORAGE_KEY = "twitch-multiview.channels";
  const LAYOUT_KEY_PREFIX = "twitch-multiview.layout.";
  const AUTH_KEY = "twitch-multiview.auth";
  const OAUTH_STATE_KEY = "twitch-multiview.oauthState";   // sessionStorage
  const CHAT_OPEN_KEY = "twitch-multiview.chatPanelOpen";
  const CHAT_TAB_KEY = "twitch-multiview.chatTab";
  // Claves de versiones anteriores (chat por tile / compartido / unificado).
  const OLD_KEYS = [
    "twitch-multiview.sharedChatMode",
    "twitch-multiview.sharedChatActive",
    "twitch-multiview.unifiedChatMode"
  ];

  const DEFAULT_CHAT_PANEL_WIDTH = 340;          // px, panel a la derecha del grid
  const DEFAULT_CHAT_PANEL_HEIGHT_MOBILE = 260;  // px, panel debajo del grid
  const NARROW_BREAKPOINT = 700;                 // px

  const ALL_TAB = "__all__";
  const MAX_MESSAGES = 500;

  // Dominio actual, exigido por Twitch como parámetro "parent" en los
  // embeds. Si la página corriera desde un archivo local (file://) o sin
  // hostname, usamos "localhost" como fallback razonable para pruebas.
  const PARENT = window.location.hostname || "localhost";

  /* =====================================================================
     ESTADO
     ===================================================================== */
  // channels: [{ name }]
  let channels = loadChannels();

  // Preferencias de layout — se guardan por resolución de pantalla, así
  // que cada monitor (ej. 1080p vs 1440p) recuerda su propio acomodo.
  let layoutPrefs = loadLayoutPrefs();

  // Panel de chat único: pestaña "Todos" (feed IRC mezclado, solo lectura)
  // + una pestaña por canal con el chat NATIVO de Twitch (ahí se escribe).
  let chatPanelOpen = loadChatPanelOpen();
  let activeTab = ALL_TAB;
  try{ activeTab = localStorage.getItem(CHAT_TAB_KEY) || ALL_TAB; }catch(e){ activeTab = ALL_TAB; }

  // iframes de chat nativo ya creados (se ocultan, no se destruyen, para
  // que cambiar de pestaña sea instantáneo). name -> iframe
  const chatFrames = new Map();

  // El feed "Todos" sigue el final salvo que el usuario haya subido.
  let feedFollow = true;

  const CHANNEL_PALETTE = ["#f2a93b","#5aa9e6","#7ed6a5","#e07be0","#ff8a65","#8d9eff","#ffd54f","#4dd0e1"];
  function channelColor(name){
    let hash = 0;
    for(let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return CHANNEL_PALETTE[hash % CHANNEL_PALETTE.length];
  }

  // Autenticación — el token y su vencimiento se guardan en localStorage
  // (clave twitch-multiview.auth) para sobrevivir a la recarga; al cargar
  // se valida con id.twitch.tv/oauth2/validate y se borra si no sirve.
  let authToken = null;
  let authUsername = null;
  let authValidateTimer = null;

  // IRC anónimo (justinfanXXXXX) para el feed "Todos".
  let ircSocket = null;
  let ircConnected = false;
  let ircWantOpen = false;
  let ircReconnectTimer = null;
  let ircReconnectDelay = 2000;

  // Emotes de terceros y badges.
  const roomIds = new Map();          // canal -> room-id
  const channelEmotes = new Map();    // canal -> { stv: Map, bttv: Map, ffz: Map }
  const globalEmotes = { stv: new Map(), bttv: new Map(), ffz: new Map() };
  let globalEmotesRequested = false;
  const globalBadges = new Map();     // "set/version" -> url
  const channelBadges = new Map();    // canal -> Map("set/version" -> url)
  let globalBadgesRequested = false;

  /* =====================================================================
     PERSISTENCIA — canales
     ===================================================================== */
  function loadChannels(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return [];
      const parsed = JSON.parse(raw);
      if(!Array.isArray(parsed)) return [];
      const seen = new Set();
      return parsed
        .filter(c => c && typeof c.name === "string")
        .map(c => ({ name: c.name.toLowerCase() }))
        .filter(c => /^[a-z0-9_]{2,25}$/.test(c.name) && !seen.has(c.name) && seen.add(c.name));
    }catch(e){
      console.warn("No se pudo leer la lista de canales guardada:", e);
      return [];
    }
  }

  function saveChannels(){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify(channels.map(c => ({ name: c.name }))));
    }catch(e){
      console.warn("No se pudo guardar la lista de canales:", e);
    }
  }

  /* =====================================================================
     PERSISTENCIA — layout (por resolución de pantalla)
     ===================================================================== */
  function getScreenKey(){
    return (window.screen && window.screen.width && window.screen.height)
      ? `${window.screen.width}x${window.screen.height}`
      : "default";
  }

  function defaultLayoutPrefs(){
    return {
      colsOverride: null,
      colFr: null,
      rowFr: null,
      dimsKey: null,
      chatPanelWidth: DEFAULT_CHAT_PANEL_WIDTH,
      chatPanelHeightMobile: DEFAULT_CHAT_PANEL_HEIGHT_MOBILE
    };
  }

  function loadLayoutPrefs(){
    const fallback = defaultLayoutPrefs();
    try{
      const raw = localStorage.getItem(LAYOUT_KEY_PREFIX + getScreenKey());
      if(!raw) return fallback;
      const parsed = JSON.parse(raw);
      const num = (v) => typeof v === "number" && isFinite(v) ? v : null;
      return {
        colsOverride: num(parsed.colsOverride),
        colFr: Array.isArray(parsed.colFr) ? parsed.colFr : null,
        rowFr: Array.isArray(parsed.rowFr) ? parsed.rowFr : null,
        dimsKey: parsed.dimsKey || null,
        // se acepta el tamaño del viejo "chat compartido" como punto de partida
        chatPanelWidth: num(parsed.chatPanelWidth) || num(parsed.sharedChatWidth) || DEFAULT_CHAT_PANEL_WIDTH,
        chatPanelHeightMobile: num(parsed.chatPanelHeightMobile) || num(parsed.sharedChatHeightMobile) || DEFAULT_CHAT_PANEL_HEIGHT_MOBILE
      };
    }catch(e){
      console.warn("No se pudo leer las preferencias de layout:", e);
      return fallback;
    }
  }

  function saveLayoutPrefs(){
    try{
      localStorage.setItem(LAYOUT_KEY_PREFIX + getScreenKey(), JSON.stringify(layoutPrefs));
    }catch(e){
      console.warn("No se pudo guardar el layout:", e);
    }
  }

  function loadChatPanelOpen(){
    try{ return localStorage.getItem(CHAT_OPEN_KEY) !== "0"; }
    catch(e){ return true; }
  }
  function saveChatPanelOpen(){
    try{ localStorage.setItem(CHAT_OPEN_KEY, chatPanelOpen ? "1" : "0"); }
    catch(e){ /* noop */ }
  }
  function saveActiveTab(){
    try{ localStorage.setItem(CHAT_TAB_KEY, activeTab); }
    catch(e){ /* noop */ }
  }

  function cleanupOldStorage(){
    try{ OLD_KEYS.forEach(k => localStorage.removeItem(k)); }
    catch(e){ /* noop */ }
  }

  /* =====================================================================
     DOM refs
     ===================================================================== */
  const grid = document.getElementById("grid");
  const emptyState = document.getElementById("empty-state");
  const addForm = document.getElementById("add-form");
  const channelInput = document.getElementById("channel-input");
  const addError = document.getElementById("add-error");

  const loginBtn = document.getElementById("login-btn");
  const userChip = document.getElementById("user-chip");
  const userNameEl = document.getElementById("user-name");
  const logoutBtn = document.getElementById("logout-btn");
  const authWarning = document.getElementById("auth-warning");

  const colsSelect = document.getElementById("cols-select");
  const resetLayoutBtn = document.getElementById("reset-layout-btn");
  const dragOverlay = document.getElementById("drag-overlay");

  const chatPanelToggleBtn = document.getElementById("chat-panel-toggle");
  const chatPanelEl = document.getElementById("chat-panel");
  const chatResizerEl = document.getElementById("chat-resizer");
  const chatTabsEl = document.getElementById("chat-tabs");
  const chatFeedWrapEl = document.getElementById("chat-feed-wrap");
  const chatFeedEl = document.getElementById("chat-feed");
  const chatFeedEmptyEl = document.getElementById("chat-feed-empty");
  const chatNewPillEl = document.getElementById("chat-new-pill");
  const chatFramesEl = document.getElementById("chat-frames");

  /* =====================================================================
     VALIDACIÓN DE NOMBRES DE CANAL
     ===================================================================== */
  const CHANNEL_RE = /^[a-zA-Z0-9_]{2,25}$/;

  function normalizeChannelName(raw){
    return raw.trim().replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "").replace(/\/.*$/, "").toLowerCase();
  }

  /* =====================================================================
     OVERLAY DE ARRASTRE
     (evita que los iframes de Twitch "roben" los eventos del mouse
     mientras se está redimensionando algo)
     ===================================================================== */
  function beginDrag(cursor){
    if(dragOverlay){
      dragOverlay.style.cursor = cursor;
      dragOverlay.classList.add("active");
    }
  }
  function endDrag(){
    if(dragOverlay) dragOverlay.classList.remove("active");
  }

  /* =====================================================================
     RENDER: GRID / LAYOUT
     ===================================================================== */
  function isNarrow(){
    return window.innerWidth < NARROW_BREAKPOINT;
  }

  function getGridDims(n){
    if(n === 0) return { cols: 0, rows: 0, narrow: false };
    if(isNarrow()) return { cols: 1, rows: n, narrow: true };
    let cols = layoutPrefs.colsOverride || Math.ceil(Math.sqrt(n));
    cols = Math.max(1, Math.min(cols, n));
    const rows = Math.ceil(n / cols);
    return { cols, rows, narrow: false };
  }

  function ensureFrArrays(dims){
    const key = dims.cols + "x" + dims.rows;
    const colOk = Array.isArray(layoutPrefs.colFr) && layoutPrefs.colFr.length === dims.cols;
    const rowOk = Array.isArray(layoutPrefs.rowFr) && layoutPrefs.rowFr.length === dims.rows;
    if(layoutPrefs.dimsKey !== key || !colOk || !rowOk){
      layoutPrefs.colFr = new Array(dims.cols).fill(1);
      layoutPrefs.rowFr = new Array(dims.rows).fill(1);
      layoutPrefs.dimsKey = key;
    }
  }

  function applyGridTemplate(dims){
    grid.style.gridTemplateColumns = layoutPrefs.colFr.map(f => Number(f).toFixed(4) + "fr").join(" ");
    grid.style.gridTemplateRows = layoutPrefs.rowFr.map(f => Number(f).toFixed(4) + "fr").join(" ");
  }

  function clearGridHandles(){
    grid.querySelectorAll(".grid-resize-col, .grid-resize-row").forEach(h => h.remove());
  }

  function positionGridHandles(dims){
    clearGridHandles();
    if(dims.narrow) return;

    const tiles = Array.from(grid.children).filter(el => el.classList.contains("tile"));
    if(tiles.length === 0) return;
    const gridRect = grid.getBoundingClientRect();

    // divisores verticales entre columnas (basados en la primera fila)
    for(let c = 0; c < dims.cols - 1; c++){
      if(c + 1 >= tiles.length) break;
      const rect = tiles[c].getBoundingClientRect();
      const handle = document.createElement("div");
      handle.className = "grid-resize-col";
      handle.style.left = (rect.right - gridRect.left - 5) + "px";
      handle.addEventListener("mousedown", (e) => startColResize(e, c, dims));
      grid.appendChild(handle);
    }

    // divisores horizontales entre filas (basados en la primera columna)
    for(let r = 0; r < dims.rows - 1; r++){
      const idx = r * dims.cols;
      const nextIdx = (r + 1) * dims.cols;
      if(nextIdx >= tiles.length) break;
      const rect = tiles[idx].getBoundingClientRect();
      const handle = document.createElement("div");
      handle.className = "grid-resize-row";
      handle.style.top = (rect.bottom - gridRect.top - 5) + "px";
      handle.addEventListener("mousedown", (e) => startRowResize(e, r, dims));
      grid.appendChild(handle);
    }
  }

  function startColResize(e, colIndex, dims){
    e.preventDefault();
    const gridRect = grid.getBoundingClientRect();
    const startX = e.clientX;
    const startFr = layoutPrefs.colFr.slice();
    const totalFr = startFr.reduce((a, b) => a + b, 0);
    const minFr = totalFr / (startFr.length * 4);
    const gridWidth = gridRect.width;

    beginDrag("col-resize");

    function onMove(ev){
      const dx = ev.clientX - startX;
      const frDelta = (dx / gridWidth) * totalFr;
      let a = startFr[colIndex] + frDelta;
      let b = startFr[colIndex + 1] - frDelta;
      if(a < minFr){ b -= (minFr - a); a = minFr; }
      if(b < minFr){ a -= (minFr - b); b = minFr; }
      layoutPrefs.colFr[colIndex] = a;
      layoutPrefs.colFr[colIndex + 1] = b;
      applyGridTemplate(dims);
      positionGridHandles(dims);
    }
    function onUp(){
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      endDrag();
      saveLayoutPrefs();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function startRowResize(e, rowIndex, dims){
    e.preventDefault();
    const gridRect = grid.getBoundingClientRect();
    const startY = e.clientY;
    const startFr = layoutPrefs.rowFr.slice();
    const totalFr = startFr.reduce((a, b) => a + b, 0);
    const minFr = totalFr / (startFr.length * 4);
    const gridHeight = gridRect.height;

    beginDrag("row-resize");

    function onMove(ev){
      const dy = ev.clientY - startY;
      const frDelta = (dy / gridHeight) * totalFr;
      let a = startFr[rowIndex] + frDelta;
      let b = startFr[rowIndex + 1] - frDelta;
      if(a < minFr){ b -= (minFr - a); a = minFr; }
      if(b < minFr){ a -= (minFr - b); b = minFr; }
      layoutPrefs.rowFr[rowIndex] = a;
      layoutPrefs.rowFr[rowIndex + 1] = b;
      applyGridTemplate(dims);
      positionGridHandles(dims);
    }
    function onUp(){
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      endDrag();
      saveLayoutPrefs();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function updateGridLayout(){
    const n = channels.length;
    clearGridHandles();

    if(n === 0){
      grid.style.display = "none";
      emptyState.style.display = "block";
      return;
    }
    grid.style.display = "grid";
    emptyState.style.display = "none";

    const dims = getGridDims(n);

    if(dims.narrow){
      grid.style.gridTemplateColumns = "1fr";
      grid.style.gridTemplateRows = `repeat(${n}, minmax(200px, 1fr))`;
      return;
    }

    ensureFrArrays(dims);
    applyGridTemplate(dims);
    requestAnimationFrame(() => positionGridHandles(dims));
  }

  window.addEventListener("resize", () => {
    applyChatPanelSize();
    updateGridLayout();
  });

  /* =====================================================================
     PANEL DE CHAT (pestañas: Todos + un chat nativo por canal)
     ===================================================================== */
  function applyChatPanelSize(){
    if(isNarrow()){
      chatPanelEl.style.width = "";
      chatPanelEl.style.height = (layoutPrefs.chatPanelHeightMobile || DEFAULT_CHAT_PANEL_HEIGHT_MOBILE) + "px";
    }else{
      chatPanelEl.style.height = "";
      chatPanelEl.style.width = (layoutPrefs.chatPanelWidth || DEFAULT_CHAT_PANEL_WIDTH) + "px";
    }
  }

  function applyChatPanelOpen(){
    chatPanelToggleBtn.classList.toggle("active", chatPanelOpen);
    chatPanelEl.hidden = !chatPanelOpen;
    chatResizerEl.hidden = !chatPanelOpen;
    applyChatPanelSize();
    updateGridLayout();
    if(chatPanelOpen && activeTab === ALL_TAB && feedFollow) scrollFeedToBottom();
  }

  chatPanelToggleBtn.addEventListener("click", () => {
    chatPanelOpen = !chatPanelOpen;
    saveChatPanelOpen();
    applyChatPanelOpen();
  });

  function renderChatTabs(){
    chatTabsEl.textContent = "";

    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "chat-tab";
    allBtn.dataset.tab = ALL_TAB;
    allBtn.textContent = "Todos";
    allBtn.title = "Mensajes de todos los canales mezclados (solo lectura)";
    allBtn.addEventListener("click", () => selectTab(ALL_TAB));
    chatTabsEl.appendChild(allBtn);

    channels.forEach(ch => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chat-tab";
      btn.dataset.tab = ch.name;
      btn.title = "Chat de " + ch.name + " (aquí puedes escribir)";
      const dot = document.createElement("span");
      dot.className = "dd-dot";
      dot.style.background = channelColor(ch.name);
      const label = document.createElement("span");
      label.textContent = ch.name;
      btn.appendChild(dot);
      btn.appendChild(label);
      btn.addEventListener("click", () => selectTab(ch.name));
      chatTabsEl.appendChild(btn);
    });

    // quitar iframes de canales que ya no están
    Array.from(chatFrames.keys()).forEach(name => {
      if(!channels.some(c => c.name === name)){
        const f = chatFrames.get(name);
        if(f) f.remove();
        chatFrames.delete(name);
      }
    });

    selectTab(activeTab, true);
  }

  function selectTab(name, silent){
    if(name !== ALL_TAB && !channels.some(c => c.name === name)) name = ALL_TAB;
    activeTab = name;
    if(!silent) saveActiveTab();

    chatTabsEl.querySelectorAll(".chat-tab").forEach(b => {
      const on = b.dataset.tab === name;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      if(on && !silent) b.scrollIntoView({ block: "nearest", inline: "nearest" });
    });

    const isAll = name === ALL_TAB;
    chatFeedWrapEl.hidden = !isAll;
    chatFramesEl.hidden = isAll;

    if(!isAll && !chatFrames.has(name)){
      const iframe = document.createElement("iframe");
      iframe.src = `https://www.twitch.tv/embed/${encodeURIComponent(name)}/chat?parent=${encodeURIComponent(PARENT)}&darkpopout`;
      iframe.dataset.channel = name;
      iframe.title = "Chat de " + name;
      chatFramesEl.appendChild(iframe);
      chatFrames.set(name, iframe);
    }
    chatFrames.forEach((f, n) => { f.hidden = (n !== name); });

    if(isAll && feedFollow) scrollFeedToBottom();
  }

  chatResizerEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const narrow = isNarrow();
    const startX = e.clientX;
    const startY = e.clientY;
    const rect = chatPanelEl.getBoundingClientRect();
    const startWidth = rect.width;
    const startHeight = rect.height;

    chatResizerEl.classList.add("dragging");
    beginDrag(narrow ? "row-resize" : "col-resize");

    function onMove(ev){
      if(narrow){
        const dy = startY - ev.clientY; // arrastrar hacia arriba agranda el chat
        let h = startHeight + dy;
        h = Math.max(140, Math.min(h, Math.round(window.innerHeight * 0.75)));
        chatPanelEl.style.height = h + "px";
        layoutPrefs.chatPanelHeightMobile = Math.round(h);
      }else{
        const dx = startX - ev.clientX; // arrastrar hacia la izquierda agranda el chat
        let w = startWidth + dx;
        w = Math.max(220, Math.min(w, 700));
        chatPanelEl.style.width = w + "px";
        layoutPrefs.chatPanelWidth = Math.round(w);
      }
    }
    function onUp(){
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      chatResizerEl.classList.remove("dragging");
      endDrag();
      saveLayoutPrefs();
      updateGridLayout();
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  });

  /* ---- feed "Todos" ---- */
  function isFeedAtBottom(){
    const el = chatFeedEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }
  function scrollFeedToBottom(){
    chatFeedEl.scrollTop = chatFeedEl.scrollHeight;
    feedFollow = true;
    chatNewPillEl.hidden = true;
  }

  chatFeedEl.addEventListener("scroll", () => {
    if(chatFeedEl.clientHeight === 0) return; // pestaña oculta
    feedFollow = isFeedAtBottom();
    if(feedFollow) chatNewPillEl.hidden = true;
  });
  chatNewPillEl.addEventListener("click", scrollFeedToBottom);

  function updateFeedEmpty(){
    const hasMsgs = chatFeedEl.childElementCount > 0;
    chatFeedEmptyEl.hidden = hasMsgs;
    if(!hasMsgs){
      chatFeedEmptyEl.textContent = channels.length === 0
        ? "Agrega un canal para ver sus mensajes aquí."
        : "Esperando mensajes…";
    }
  }

  function removeFeedMessages(predicate){
    Array.from(chatFeedEl.children).forEach(el => { if(predicate(el)) el.remove(); });
    updateFeedEmpty();
  }

  /* =====================================================================
     EMOTES Y BADGES
     Todo valor externo (texto de chat, nombres, respuestas de API) se
     mete al DOM con textContent / setAttribute; nunca innerHTML. Las URLs
     de imágenes se ARMAN aquí a partir de un id validado, así que solo
     pueden apuntar a los hosts conocidos.
     ===================================================================== */
  const TWITCH_EMOTE_ID_RE = /^[A-Za-z0-9_]{1,80}$/;
  const ALNUM_ID_RE = /^[A-Za-z0-9]{1,64}$/;
  const NUM_ID_RE = /^[0-9]{1,12}$/;
  const BADGE_HOST = "https://static-cdn.jtvnw.net/";

  function twitchEmoteUrl(id){ return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0`; }
  function stvEmoteUrl(id){ return `https://cdn.7tv.app/emote/${id}/1x.webp`; }
  function bttvEmoteUrl(id){ return `https://cdn.betterttv.net/emote/${id}/1x`; }
  function ffzEmoteUrl(id){ return `https://cdn.frankerfacez.com/emote/${id}/1`; }

  function fetchJson(url, options){
    return fetch(url, options)
      .then(res => res.ok ? res.json() : null)
      .catch(() => null);
  }

  function addEmote(map, name, id, idRe, urlFn){
    if(typeof name !== "string" || !name || name.length > 100 || /\s/.test(name)) return;
    id = String(id);
    if(!idRe.test(id)) return;
    map.set(name, urlFn(id));
  }

  function parse7tvSet(set, map){
    if(!set || !Array.isArray(set.emotes)) return;
    set.emotes.forEach(e => { if(e) addEmote(map, e.name, e.id, ALNUM_ID_RE, stvEmoteUrl); });
  }
  function parseBttvList(list, map){
    if(!Array.isArray(list)) return;
    list.forEach(e => { if(e) addEmote(map, e.code, e.id, ALNUM_ID_RE, bttvEmoteUrl); });
  }
  function parseFfzSets(sets, map){
    if(!sets || typeof sets !== "object") return;
    Object.keys(sets).forEach(k => {
      const s = sets[k];
      if(!s || !Array.isArray(s.emoticons)) return;
      s.emoticons.forEach(e => { if(e) addEmote(map, e.name, e.id, NUM_ID_RE, ffzEmoteUrl); });
    });
  }

  function loadGlobalEmotes(){
    if(globalEmotesRequested) return;
    globalEmotesRequested = true;
    fetchJson("https://7tv.io/v3/emote-sets/global").then(d => parse7tvSet(d, globalEmotes.stv));
    fetchJson("https://api.betterttv.net/3/cached/emotes/global").then(d => parseBttvList(d, globalEmotes.bttv));
    fetchJson("https://api.frankerfacez.com/v1/set/global").then(d => {
      if(!d || !d.sets) return;
      const defaults = Array.isArray(d.default_sets) ? d.default_sets.map(String) : Object.keys(d.sets);
      const picked = {};
      defaults.forEach(id => { if(d.sets[id]) picked[id] = d.sets[id]; });
      parseFfzSets(picked, globalEmotes.ffz);
    });
  }

  function loadChannelEmotes(channel, roomId){
    if(channelEmotes.has(channel)) return;
    const sets = { stv: new Map(), bttv: new Map(), ffz: new Map() };
    channelEmotes.set(channel, sets);
    const id = encodeURIComponent(roomId);
    fetchJson(`https://7tv.io/v3/users/twitch/${id}`).then(d => { if(d) parse7tvSet(d.emote_set, sets.stv); });
    fetchJson(`https://api.betterttv.net/3/cached/users/twitch/${id}`).then(d => {
      if(!d) return;
      parseBttvList(d.channelEmotes, sets.bttv);
      parseBttvList(d.sharedEmotes, sets.bttv);
    });
    fetchJson(`https://api.frankerfacez.com/v1/room/id/${id}`).then(d => { if(d) parseFfzSets(d.sets, sets.ffz); });
  }

  function lookupThirdPartyEmote(channel, word){
    const ch = channelEmotes.get(channel);
    if(ch){
      const u = ch.stv.get(word) || ch.bttv.get(word) || ch.ffz.get(word);
      if(u) return u;
    }
    return globalEmotes.stv.get(word) || globalEmotes.bttv.get(word) || globalEmotes.ffz.get(word) || null;
  }

  function setRoomId(channel, roomId){
    if(!roomId || !NUM_ID_RE.test(roomId)) return;
    if(!channels.some(c => c.name === channel)) return;
    if(roomIds.get(channel) === roomId) return;
    roomIds.set(channel, roomId);
    loadChannelEmotes(channel, roomId);
    if(authToken) loadChannelBadges(channel, roomId);
  }

  function parseBadgeResponse(d, map){
    if(!d || !Array.isArray(d.data)) return;
    d.data.forEach(set => {
      if(!set || typeof set.set_id !== "string" || !Array.isArray(set.versions)) return;
      set.versions.forEach(v => {
        if(!v || typeof v.image_url_1x !== "string") return;
        if(!v.image_url_1x.startsWith(BADGE_HOST)) return;
        map.set(set.set_id + "/" + v.id, { url: v.image_url_1x, title: typeof v.title === "string" ? v.title : set.set_id });
      });
    });
  }

  function helixHeaders(){
    return { "Authorization": "Bearer " + authToken, "Client-Id": CLIENT_ID };
  }

  function loadGlobalBadges(){
    if(globalBadgesRequested || !authToken) return;
    globalBadgesRequested = true;
    fetchJson("https://api.twitch.tv/helix/chat/badges/global", { headers: helixHeaders() })
      .then(d => parseBadgeResponse(d, globalBadges));
  }

  function loadChannelBadges(channel, roomId){
    if(!authToken || channelBadges.has(channel)) return;
    const map = new Map();
    channelBadges.set(channel, map);
    fetchJson(`https://api.twitch.tv/helix/chat/badges?broadcaster_id=${encodeURIComponent(roomId)}`, { headers: helixHeaders() })
      .then(d => parseBadgeResponse(d, map));
  }

  function loadAllBadges(){
    loadGlobalBadges();
    roomIds.forEach((id, ch) => loadChannelBadges(ch, id));
  }

  function clearBadges(){
    globalBadges.clear();
    channelBadges.clear();
    globalBadgesRequested = false;
  }

  function makeImg(cls, url, name){
    const img = document.createElement("img");
    img.className = cls;
    img.src = url;
    img.alt = name;
    img.title = name;
    img.loading = "lazy";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    return img;
  }

  function parseTwitchEmotes(tag){
    const out = [];
    if(!tag) return out;
    tag.split("/").forEach(part => {
      const c = part.indexOf(":");
      if(c < 1) return;
      const id = part.slice(0, c);
      if(!TWITCH_EMOTE_ID_RE.test(id)) return;
      part.slice(c + 1).split(",").forEach(r => {
        const m = r.match(/^(\d+)-(\d+)$/);
        if(!m) return;
        const start = parseInt(m[1], 10), end = parseInt(m[2], 10);
        if(end >= start) out.push({ start, end, id });
      });
    });
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  // Texto sin emotes de Twitch: se parte por espacios y cada palabra que
  // coincide con un emote de 7TV/BTTV/FFZ se vuelve <img>.
  function appendWords(container, str, channel){
    if(!str) return;
    let buf = "";
    str.split(/(\s+)/).forEach(tok => {
      const url = tok && !/^\s+$/.test(tok) ? lookupThirdPartyEmote(channel, tok) : null;
      if(url){
        if(buf){ container.appendChild(document.createTextNode(buf)); buf = ""; }
        container.appendChild(makeImg("emote", url, tok));
      }else{
        buf += tok;
      }
    });
    if(buf) container.appendChild(document.createTextNode(buf));
  }

  function renderMessageContent(container, text, emotesTag, channel){
    // los índices de Twitch cuentan code points, no unidades UTF-16
    const chars = Array.from(text);
    let pos = 0;
    parseTwitchEmotes(emotesTag).forEach(e => {
      if(e.start < pos || e.end >= chars.length) return;
      appendWords(container, chars.slice(pos, e.start).join(""), channel);
      container.appendChild(makeImg("emote", twitchEmoteUrl(e.id), chars.slice(e.start, e.end + 1).join("")));
      pos = e.end + 1;
    });
    appendWords(container, chars.slice(pos).join(""), channel);
  }

  function renderBadges(container, badgesTag, channel){
    if(!authToken || !badgesTag) return;
    const chMap = channelBadges.get(channel);
    badgesTag.split(",").forEach(b => {
      if(!b) return;
      const info = (chMap && chMap.get(b)) || globalBadges.get(b);
      if(info) container.appendChild(makeImg("badge", info.url, info.title));
    });
  }

  /* ---- un mensaje del feed ---- */
  function buildMessageEl(m){
    const div = document.createElement("div");
    div.className = "chat-msg" + (m.action ? " action" : "");
    div.dataset.channel = m.channel;
    if(m.msgId) div.dataset.msgId = m.msgId;
    if(m.userId) div.dataset.userId = m.userId;
    if(m.login) div.dataset.login = m.login;

    const chanTag = document.createElement("button");
    chanTag.type = "button";
    chanTag.className = "msg-channel";
    chanTag.textContent = m.channel;
    chanTag.title = "Abrir el chat de " + m.channel;
    chanTag.style.background = channelColor(m.channel);
    chanTag.addEventListener("click", () => selectTab(m.channel));
    div.appendChild(chanTag);

    const badgesSpan = document.createElement("span");
    badgesSpan.className = "msg-badges";
    renderBadges(badgesSpan, m.badges, m.channel);
    if(badgesSpan.childElementCount) div.appendChild(badgesSpan);

    const userSpan = document.createElement("span");
    userSpan.className = "msg-user";
    userSpan.textContent = m.user;
    if(m.color && /^#[0-9a-fA-F]{6}$/.test(m.color)) userSpan.style.color = m.color;
    div.appendChild(userSpan);

    const sep = document.createElement("span");
    sep.className = "msg-sep";
    sep.textContent = m.action ? " " : ": ";
    div.appendChild(sep);

    const textSpan = document.createElement("span");
    textSpan.className = "msg-text";
    if(m.action && m.color && /^#[0-9a-fA-F]{6}$/.test(m.color)) textSpan.style.color = m.color;
    renderMessageContent(textSpan, m.text, m.emotes, m.channel);
    div.appendChild(textSpan);
    return div;
  }

  function addChatMessage(m){
    if(!channels.some(c => c.name === m.channel)) return; // canal ya quitado
    const visible = chatFeedEl.clientHeight > 0;
    const follow = visible ? (feedFollow = isFeedAtBottom()) : feedFollow;
    chatFeedEl.appendChild(buildMessageEl(m));
    while(chatFeedEl.childElementCount > MAX_MESSAGES){
      chatFeedEl.removeChild(chatFeedEl.firstElementChild);
    }
    chatFeedEmptyEl.hidden = true;
    if(follow){
      if(visible) scrollFeedToBottom();
    }else{
      chatNewPillEl.hidden = false;
    }
  }

  /* =====================================================================
     CONTROLES DE LAYOUT (columnas manuales + reset)
     ===================================================================== */
  function syncColsSelect(){
    colsSelect.value = layoutPrefs.colsOverride ? String(layoutPrefs.colsOverride) : "auto";
  }

  colsSelect.addEventListener("change", () => {
    const v = colsSelect.value;
    layoutPrefs.colsOverride = (v === "auto") ? null : parseInt(v, 10);
    // los tamaños guardados ya no aplican a la nueva cantidad de columnas
    layoutPrefs.colFr = null;
    layoutPrefs.rowFr = null;
    layoutPrefs.dimsKey = null;
    saveLayoutPrefs();
    updateGridLayout();
  });

  resetLayoutBtn.addEventListener("click", () => {
    layoutPrefs = defaultLayoutPrefs();
    syncColsSelect();
    saveLayoutPrefs();
    applyChatPanelSize();
    updateGridLayout();
  });

  /* =====================================================================
     RENDER: TILES (solo video)
     ===================================================================== */
  function renderChannels(){
    grid.textContent = "";
    channels.forEach(ch => {
      grid.appendChild(buildTile(ch));
    });
    updateGridLayout();
    renderChatTabs();
    updateFeedEmpty();
  }

  function buildTile(ch){
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.dataset.channel = ch.name;
    tile.draggable = true;

    /* ---- reordenar canales arrastrando ---- */
    tile.addEventListener("dragstart", (e) => {
      if(!e.target.closest(".drag-handle")){
        e.preventDefault();
        return;
      }
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", ch.name);
      requestAnimationFrame(() => tile.classList.add("dragging"));
    });
    tile.addEventListener("dragend", () => tile.classList.remove("dragging"));
    tile.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      tile.classList.add("drag-over");
    });
    tile.addEventListener("dragleave", () => tile.classList.remove("drag-over"));
    tile.addEventListener("drop", (e) => {
      e.preventDefault();
      tile.classList.remove("drag-over");
      const draggedName = e.dataTransfer.getData("text/plain");
      if(draggedName && draggedName !== ch.name) reorderChannels(draggedName, ch.name);
    });

    // header
    const header = document.createElement("div");
    header.className = "tile-header";

    const dragHandle = document.createElement("span");
    dragHandle.className = "icon-btn drag-handle";
    dragHandle.title = "Arrastrar para reordenar";
    dragHandle.textContent = "⠿";

    const dot = document.createElement("span");
    dot.className = "dd-dot";
    dot.style.background = channelColor(ch.name);

    const nameEl = document.createElement("div");
    nameEl.className = "channel-name";
    nameEl.textContent = ch.name;
    nameEl.title = ch.name;

    const chatBtn = document.createElement("button");
    chatBtn.className = "icon-btn";
    chatBtn.title = "Abrir el chat de este canal en el panel";
    chatBtn.textContent = "💬";
    chatBtn.addEventListener("click", () => {
      if(!chatPanelOpen){
        chatPanelOpen = true;
        saveChatPanelOpen();
        applyChatPanelOpen();
      }
      selectTab(ch.name);
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "icon-btn remove";
    removeBtn.title = "Quitar canal";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => removeChannel(ch.name));

    header.appendChild(dragHandle);
    header.appendChild(dot);
    header.appendChild(nameEl);
    header.appendChild(chatBtn);
    header.appendChild(removeBtn);

    // body
    const body = document.createElement("div");
    body.className = "tile-body";

    const videoWrap = document.createElement("div");
    videoWrap.className = "tile-video-wrap";
    const videoFrame = document.createElement("iframe");
    videoFrame.src = `https://player.twitch.tv/?channel=${encodeURIComponent(ch.name)}&parent=${encodeURIComponent(PARENT)}&muted=true`;
    videoFrame.allowFullscreen = true;
    videoFrame.setAttribute("allow", "autoplay; fullscreen");
    videoWrap.appendChild(videoFrame);

    body.appendChild(videoWrap);
    tile.appendChild(header);
    tile.appendChild(body);
    return tile;
  }

  /* =====================================================================
     AGREGAR / QUITAR / REORDENAR CANALES
     ===================================================================== */
  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    addError.textContent = "";

    const name = normalizeChannelName(channelInput.value);
    if(!name){
      addError.textContent = "Escribe un nombre de canal.";
      return;
    }
    if(!CHANNEL_RE.test(name)){
      addError.textContent = "Nombre de canal inválido.";
      return;
    }
    if(channels.some(c => c.name === name)){
      addError.textContent = "Ese canal ya está en la lista.";
      return;
    }

    channels.push({ name });
    saveChannels();
    renderChannels();
    channelInput.value = "";

    if(ircSocket && ircSocket.readyState === WebSocket.OPEN){
      ircJoin(name);
    }else if(!ircSocket || ircSocket.readyState !== WebSocket.CONNECTING){
      // si se está conectando, el handler "open" une a todos los canales
      // presentes en ese momento, así que no hace falta nada más.
      connectIrc();
    }
  });

  function removeChannel(name){
    channels = channels.filter(c => c.name !== name);
    roomIds.delete(name);
    channelEmotes.delete(name);
    channelBadges.delete(name);
    saveChannels();
    if(ircConnected) ircPart(name);
    removeFeedMessages(el => el.dataset.channel === name);
    renderChannels();
    if(channels.length === 0) closeIrc();
  }

  function reorderChannels(draggedName, targetName){
    const fromIdx = channels.findIndex(c => c.name === draggedName);
    const toIdx = channels.findIndex(c => c.name === targetName);
    if(fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    const [moved] = channels.splice(fromIdx, 1);
    channels.splice(toIdx, 0, moved);
    saveChannels();
    renderChannels();
  }

  /* =====================================================================
     AUTENTICACIÓN — OAuth Implicit Grant de Twitch
     El token se guarda en localStorage (twitch-multiview.auth) junto con
     su vencimiento; se valida al cargar y cada hora mientras está activo.
     ===================================================================== */
  function readStoredAuth(){
    try{
      const raw = localStorage.getItem(AUTH_KEY);
      if(!raw) return null;
      const a = JSON.parse(raw);
      if(!a || typeof a.token !== "string" || !a.token) return null;
      return a;
    }catch(e){ return null; }
  }
  function writeStoredAuth(a){
    try{ localStorage.setItem(AUTH_KEY, JSON.stringify(a)); }catch(e){ /* noop */ }
  }
  function clearStoredAuth(){
    try{ localStorage.removeItem(AUTH_KEY); }catch(e){ /* noop */ }
  }

  function randomState(){
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, "0")).join("");
  }

  function buildAuthorizeUrl(state){
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "token",
      scope: OAUTH_SCOPES,
      state
    });
    return `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
  }

  loginBtn.addEventListener("click", () => {
    if(!CLIENT_ID || CLIENT_ID === "TU_CLIENT_ID_AQUI"){
      alert("Todavía no configuraste tu CLIENT_ID. Edita la constante CLIENT_ID al principio de script.js con el Client ID de tu app registrada en dev.twitch.tv/console.");
      return;
    }
    const state = randomState();
    try{ sessionStorage.setItem(OAUTH_STATE_KEY, state); }catch(e){ /* noop */ }
    window.location.href = buildAuthorizeUrl(state);
  });

  logoutBtn.addEventListener("click", () => {
    logout(true);
  });

  function logout(revoke){
    const token = authToken || (readStoredAuth() || {}).token;
    authToken = null;
    authUsername = null;
    clearStoredAuth();
    clearBadges();
    if(authValidateTimer){ clearInterval(authValidateTimer); authValidateTimer = null; }
    if(revoke && token){
      fetch("https://id.twitch.tv/oauth2/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: CLIENT_ID, token }).toString()
      }).catch(() => { /* el token se borra igual */ });
    }
    refreshAuthUI();
  }

  function refreshAuthUI(){
    if(authToken && authUsername){
      loginBtn.hidden = true;
      userChip.hidden = false;
      userNameEl.textContent = authUsername;
    }else{
      loginBtn.hidden = false;
      userChip.hidden = true;
      userNameEl.textContent = "";
    }
  }

  // Pregunta a Twitch si el token sigue sirviendo.
  //   "ok"      -> { login, user_id, expires_in }
  //   "invalid" -> el token ya no sirve (se borra)
  //   "error"   -> no se pudo preguntar (red caída): no se borra nada
  function validateToken(token){
    return fetch("https://id.twitch.tv/oauth2/validate", {
      headers: { "Authorization": "OAuth " + token }
    })
    .then(res => {
      if(res.status === 401) return { status: "invalid" };
      if(!res.ok) return { status: "error" };
      return res.json().then(d => (d && typeof d.login === "string")
        ? { status: "ok", data: d }
        : { status: "invalid" });
    })
    .catch(() => ({ status: "error" }));
  }

  function applyValidatedAuth(token, data){
    authToken = token;
    authUsername = data.login;
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 0;
    writeStoredAuth({
      token,
      login: data.login,
      userId: typeof data.user_id === "string" ? data.user_id : null,
      expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : null
    });
    refreshAuthUI();
    loadAllBadges();
    if(!authValidateTimer){
      // Twitch pide validar cada hora mientras la sesión está abierta
      authValidateTimer = setInterval(() => {
        if(!authToken) return;
        const t = authToken;
        validateToken(t).then(r => {
          if(r.status === "invalid" && authToken === t) logout(false);
        });
      }, 60 * 60 * 1000);
    }
  }

  function startSessionWithToken(token){
    return validateToken(token).then(r => {
      if(r.status === "ok") applyValidatedAuth(token, r.data);
      else if(r.status === "invalid"){ clearStoredAuth(); refreshAuthUI(); }
      else refreshAuthUI(); // sin red: se queda guardado para el próximo intento
      return r.status;
    });
  }

  // Al cargar: si venimos de la redirección de Twitch, el token llega en
  // el fragmento de la URL (#access_token=...&state=...). Si no, se
  // intenta con el token guardado.
  function restoreAuth(){
    const hash = window.location.hash ? window.location.hash.replace(/^#/, "") : "";
    if(hash){
      const params = new URLSearchParams(hash);
      const token = params.get("access_token");
      if(token || params.get("error")){
        // limpiar la URL para no dejar el token visible
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      if(token){
        let expected = null;
        try{
          expected = sessionStorage.getItem(OAUTH_STATE_KEY);
          sessionStorage.removeItem(OAUTH_STATE_KEY);
        }catch(e){ expected = null; }
        if(expected && params.get("state") === expected){
          return startSessionWithToken(token);
        }
        console.warn("Inicio de sesión descartado: el parámetro state no coincide.");
      }
    }

    const stored = readStoredAuth();
    if(!stored) return Promise.resolve("none");
    if(typeof stored.expiresAt === "number" && stored.expiresAt <= Date.now()){
      clearStoredAuth();
      return Promise.resolve("expired");
    }
    return startSessionWithToken(stored.token);
  }

  /* =====================================================================
     IRC sobre WebSocket (anónimo, solo lectura)
     ===================================================================== */
  // Nos conectamos con un nick anónimo ("justinfanXXXXX") para leer y
  // mezclar los mensajes de todos los canales en la pestaña "Todos".
  // Para escribir se usa el chat nativo de cada pestaña de canal.
  function connectIrc(){
    if(channels.length === 0) return;
    closeIrc();
    ircWantOpen = true;
    loadGlobalEmotes();

    const sock = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    ircSocket = sock;
    const nick = "justinfan" + Math.floor(10000 + Math.random() * 89999);

    sock.addEventListener("open", () => {
      sock.send("CAP REQ :twitch.tv/commands twitch.tv/tags");
      sock.send("NICK " + nick);
      if(channels.length) sock.send("JOIN " + channels.map(c => "#" + c.name).join(","));
    });

    sock.addEventListener("message", (event) => {
      if(sock !== ircSocket) return;
      String(event.data).split("\r\n").filter(Boolean).forEach(handleIrcLine);
    });

    sock.addEventListener("close", () => {
      if(sock !== ircSocket) return;
      ircConnected = false;
      ircSocket = null;
      scheduleIrcReconnect();
    });

    sock.addEventListener("error", () => {
      if(sock !== ircSocket) return;
      console.warn("Error de WebSocket IRC; se reintenta en unos segundos.");
      ircConnected = false;
    });
  }

  function scheduleIrcReconnect(){
    if(!ircWantOpen || channels.length === 0 || ircReconnectTimer) return;
    ircReconnectTimer = setTimeout(() => {
      ircReconnectTimer = null;
      if(ircWantOpen && channels.length > 0) connectIrc();
    }, ircReconnectDelay);
    ircReconnectDelay = Math.min(ircReconnectDelay * 2, 30000);
  }

  function parseIrcTags(tagStr){
    const tags = Object.create(null);
    tagStr.split(";").forEach(pair => {
      const idx = pair.indexOf("=");
      if(idx === -1) return;
      const key = pair.slice(0, idx);
      const val = pair.slice(idx + 1)
        .replace(/\\s/g, " ")
        .replace(/\\:/g, ";")
        .replace(/\\\\/g, "\\");
      tags[key] = val;
    });
    return tags;
  }

  function handleIrcLine(line){
    let rest = String(line);
    let tags = Object.create(null);

    if(rest.startsWith("@")){
      const sp = rest.indexOf(" ");
      if(sp === -1) return;
      tags = parseIrcTags(rest.slice(1, sp));
      rest = rest.slice(sp + 1);
    }

    if(rest.startsWith("PING")){
      if(ircSocket && ircSocket.readyState === WebSocket.OPEN) ircSocket.send("PONG :tmi.twitch.tv");
      return;
    }

    const match = rest.match(/^:(\S+)\s+(\S+)\s*(.*)$/);
    if(!match) return;

    const prefix = match[1];
    const command = match[2];
    const params = match[3];

    if(command === "001"){
      ircConnected = true;
      ircReconnectDelay = 2000;
      return;
    }

    if(command === "RECONNECT"){
      if(ircSocket) try{ ircSocket.close(); }catch(e){ /* noop */ }
      return;
    }

    if(command === "ROOMSTATE"){
      const m = params.match(/^#(\S+)/);
      if(m) setRoomId(m[1].toLowerCase(), tags["room-id"]);
      return;
    }

    if(command === "CLEARMSG"){
      const target = tags["target-msg-id"];
      if(target) removeFeedMessages(el => el.dataset.msgId === target);
      return;
    }

    if(command === "CLEARCHAT"){
      const m = params.match(/^#(\S+)(?:\s+:(\S+))?/);
      if(!m) return;
      const ch = m[1].toLowerCase();
      const uid = tags["target-user-id"];
      const login = m[2] ? m[2].toLowerCase() : null;
      // sin usuario = /clear de todo el chat de ese canal
      removeFeedMessages(el => el.dataset.channel === ch && ((!uid && !login) ||
        (uid && el.dataset.userId === uid) || (login && el.dataset.login === login)));
      return;
    }

    if(command === "PRIVMSG"){
      const chanMatch = params.match(/^#(\S+)\s+:([\s\S]*)$/);
      if(!chanMatch) return;
      const channelName = chanMatch[1].toLowerCase();
      let text = chanMatch[2];
      let action = false;
      const am = text.match(/^\u0001ACTION ([\s\S]*)\u0001$/);
      if(am){ text = am[1]; action = true; }
      setRoomId(channelName, tags["room-id"]);
      const login = prefix.split("!")[0].toLowerCase();
      addChatMessage({
        channel: channelName,
        user: tags["display-name"] || login,
        login,
        userId: tags["user-id"] || "",
        msgId: tags["id"] || "",
        color: tags["color"] || "",
        badges: tags["badges"] || "",
        emotes: tags["emotes"] || "",
        text,
        action
      });
    }
  }

  function closeIrc(){
    ircWantOpen = false;
    if(ircReconnectTimer){ clearTimeout(ircReconnectTimer); ircReconnectTimer = null; }
    const sock = ircSocket;
    ircSocket = null;
    ircConnected = false;
    if(sock){
      try{ sock.close(); }catch(e){ /* noop */ }
    }
  }

  function ircJoin(name){
    if(ircSocket && ircSocket.readyState === WebSocket.OPEN){
      ircSocket.send("JOIN #" + name);
    }
  }

  function ircPart(name){
    if(ircSocket && ircSocket.readyState === WebSocket.OPEN){
      ircSocket.send("PART #" + name);
    }
  }

  /* =====================================================================
     AVISO SI FALTA CONFIGURAR EL CLIENT ID
     ===================================================================== */
  function checkConfigWarning(){
    if(!CLIENT_ID || CLIENT_ID === "TU_CLIENT_ID_AQUI"){
      authWarning.hidden = false;
      authWarning.textContent = "";
      authWarning.appendChild(document.createTextNode("Configura "));
      const code = document.createElement("code");
      code.textContent = "CLIENT_ID";
      authWarning.appendChild(code);
      authWarning.appendChild(document.createTextNode(" en script.js para poder iniciar sesión."));
    }
  }

  /* =====================================================================
     INIT
     ===================================================================== */
  function init(){
    cleanupOldStorage();
    if(channels.length) saveChannels(); // reescribe sin campos viejos (chatOpen, etc.)
    checkConfigWarning();
    refreshAuthUI();
    restoreAuth();
    syncColsSelect();
    renderChannels();
    applyChatPanelOpen();
    if(channels.length > 0) connectIrc();
  }

  // Ganchos para pruebas desde la consola / navegador headless.
  window.twitchMultiviewDebug = Object.freeze({
    handleIrcLine: (line) => handleIrcLine(line),
    restoreAuth: () => restoreAuth(),
    state: () => ({
      channels: channels.map(c => c.name),
      activeTab,
      chatPanelOpen,
      ircConnected,
      loggedIn: !!(authToken && authUsername),
      roomIds: Object.fromEntries(roomIds),
      emoteCounts: {
        global: { stv: globalEmotes.stv.size, bttv: globalEmotes.bttv.size, ffz: globalEmotes.ffz.size },
        channels: Object.fromEntries(Array.from(channelEmotes, ([k, v]) => [k, { stv: v.stv.size, bttv: v.bttv.size, ffz: v.ffz.size }]))
      },
      badgeCounts: { global: globalBadges.size, channels: Object.fromEntries(Array.from(channelBadges, ([k, v]) => [k, v.size])) }
    })
  });

  init();
})();
