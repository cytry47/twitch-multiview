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
  const HIDE_OFFLINE_KEY = "twitch-multiview.hideOffline";
  const VOLUMES_KEY = "twitch-multiview.volumes";      // { canal: 0-100 }
  const AUDIO_KEY = "twitch-multiview.audio";          // { solo, muted }
  const SETUPS_KEY = "twitch-multiview.setups";        // [{ name, channels, cols, focus, chat }]
  const MAX_SHARED_CHANNELS = 16;                       // máx. canales en un link ?c=
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

  const EMBED_API_URL = "https://player.twitch.tv/js/embed/v1.js";
  const STREAMS_POLL_MS = 60 * 1000;
  const DEFAULT_VOLUME = 50;   // 0-100
  const TILE_HEADER_PX = 34;   // alto aprox. del header de un tile

  // Dominio actual, exigido por Twitch como parámetro "parent" en los
  // embeds. Si la página corriera desde un archivo local (file://) o sin
  // hostname, usamos "localhost" como fallback razonable para pruebas.
  const PARENT = window.location.hostname || "localhost";

  /* =====================================================================
     ESTADO
     ===================================================================== */
  // channels: [{ name }]
  let channels = loadChannels();
  // Vista compartida (?c=...): mientras esté activa no se guardan canales,
  // diseño ni audio, para no pisar la lista propia del usuario.
  let sharedView = false;

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

  // Tiles de video ya creados. Se reutilizan (no se recrean) al reordenar,
  // cambiar el foco u ocultar desconectados, así el reproductor no se recarga.
  // name -> { name, tile, host, player, ready, els: {...} }
  const tiles = new Map();

  // Estado en vivo:
  //  - eventStatus: lo que dicen los eventos ONLINE/OFFLINE del reproductor
  //  - helixStatus: respuesta de /helix/streams (solo con sesión iniciada);
  //    name -> { live, viewers, title, game }. null = sin datos de Helix.
  const eventStatus = new Map();
  let helixStatus = null;
  let helixTimer = null;
  let helixSeq = 0;

  let hideOffline = false;
  try{ hideOffline = localStorage.getItem(HIDE_OFFLINE_KEY) === "1"; }catch(e){ hideOffline = false; }

  // Audio: un solo canal "solo" suena; los demás quedan silenciados.
  // Tras recargar el navegador arranca en silencio: el solo guardado queda
  // "armado" (toca para activar) hasta el primer clic / tecla M.
  let volumes = loadVolumes();
  let soloChannel = null;
  let soloMuted = false;
  let audioArmed = false;
  (function loadAudio(){
    try{
      const a = JSON.parse(localStorage.getItem(AUDIO_KEY) || "null");
      if(a && typeof a.solo === "string" && /^[a-z0-9_]{2,25}$/.test(a.solo)){
        soloChannel = a.solo;
        soloMuted = !!a.muted;
        audioArmed = !soloMuted;
      }
    }catch(e){ /* noop */ }
  })();

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
  let authUserId = null;
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

  function loadVolumes(){
    const out = {};
    try{
      const raw = JSON.parse(localStorage.getItem(VOLUMES_KEY) || "{}");
      if(raw && typeof raw === "object"){
        Object.keys(raw).forEach(k => {
          const v = raw[k];
          if(/^[a-z0-9_]{2,25}$/.test(k) && typeof v === "number" && isFinite(v)) out[k] = Math.max(0, Math.min(100, Math.round(v)));
        });
      }
    }catch(e){ /* noop */ }
    return out;
  }
  function saveVolumes(){
    try{ localStorage.setItem(VOLUMES_KEY, JSON.stringify(volumes)); }catch(e){ /* noop */ }
  }
  function saveAudio(){
    if(sharedView) return;
    try{ localStorage.setItem(AUDIO_KEY, JSON.stringify({ solo: soloChannel, muted: soloMuted })); }catch(e){ /* noop */ }
  }

  function saveChannels(){
    if(sharedView) return;
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
      focusMode: false,
      focusChannel: null,
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
        focusMode: parsed.focusMode === true,
        focusChannel: (typeof parsed.focusChannel === "string" && /^[a-z0-9_]{2,25}$/.test(parsed.focusChannel)) ? parsed.focusChannel : null,
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
    if(sharedView) return;
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
  const hideOfflineBtn = document.getElementById("hide-offline-btn");
  const allHiddenMsg = document.getElementById("all-hidden-msg");
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

    if(isFocusMode()) return; // en Foco no hay divisores
    const tiles = visibleChannels().map(n => tileOf(n).tile);
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

  function tileOf(name){ return tiles.get(name); }

  function isFocusMode(){ return !!layoutPrefs.focusMode; }

  // Un tile se oculta del grid si "Ocultar desconectados" está activo y
  // se sabe que el canal está desconectado (si aún no se sabe, se muestra).
  function isHiddenOffline(name){
    if(!hideOffline) return false;
    const st = getStatus(name);
    return !!st && !st.live;
  }

  function visibleChannels(){
    return channels.map(c => c.name).filter(n => tiles.has(n) && !isHiddenOffline(n));
  }

  // Canal que va en grande en modo Foco (el guardado si está visible).
  function effectiveFocus(visible){
    if(!visible.length) return null;
    return visible.includes(layoutPrefs.focusChannel) ? layoutPrefs.focusChannel : visible[0];
  }

  function clearTilePlacement(){
    tiles.forEach(rec => {
      rec.tile.style.gridColumn = "";
      rec.tile.style.gridRow = "";
      rec.tile.classList.remove("is-focus");
    });
  }

  function applyFocusLayout(visible){
    const focus = effectiveFocus(visible);
    const others = visible.filter(n => n !== focus);
    const narrow = isNarrow();
    grid.classList.toggle("focus-narrow", narrow);

    tiles.forEach((rec, name) => rec.tile.classList.toggle("is-focus", name === focus));

    if(others.length === 0){
      grid.style.gridTemplateColumns = "1fr";
      grid.style.gridTemplateRows = narrow ? `${Math.round(grid.clientWidth * 9 / 16) + TILE_HEADER_PX}px` : "1fr";
      tileOf(focus).tile.style.gridColumn = "1";
      tileOf(focus).tile.style.gridRow = "1";
      return;
    }

    if(narrow){
      // grande arriba, el resto en una cuadrícula debajo
      const cols = Math.min(2, others.length);
      const gap = 8;
      const w = grid.clientWidth || window.innerWidth;
      const bigH = Math.round(w * 9 / 16) + TILE_HEADER_PX;
      const smallW = (w - gap * (cols - 1)) / cols;
      const smallH = Math.round(smallW * 9 / 16) + TILE_HEADER_PX;
      const rows = Math.ceil(others.length / cols);
      grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
      grid.style.gridTemplateRows = `${bigH}px repeat(${rows}, ${smallH}px)`;
      tileOf(focus).tile.style.gridColumn = "1 / -1";
      tileOf(focus).tile.style.gridRow = "1";
      others.forEach((n, i) => {
        tileOf(n).tile.style.gridColumn = String((i % cols) + 1);
        tileOf(n).tile.style.gridRow = String(Math.floor(i / cols) + 2);
      });
    }else{
      // grande a la izquierda (~75 %), el resto apilado a la derecha
      grid.style.gridTemplateColumns = "minmax(0, 3fr) minmax(0, 1fr)";
      grid.style.gridTemplateRows = `repeat(${others.length}, minmax(0, 1fr))`;
      tileOf(focus).tile.style.gridColumn = "1";
      tileOf(focus).tile.style.gridRow = `1 / span ${others.length}`;
      others.forEach((n, i) => {
        tileOf(n).tile.style.gridColumn = "2";
        tileOf(n).tile.style.gridRow = String(i + 1);
      });
    }
  }

  function updateGridLayout(){
    clearGridHandles();
    clearTilePlacement();
    grid.classList.remove("focus-narrow");

    const visible = visibleChannels();
    const n = visible.length;
    lastVisibleKey = visible.join(",");
    tiles.forEach((rec, name) => rec.tile.classList.toggle("hidden-offline", isHiddenOffline(name)));
    grid.classList.toggle("focus-mode", isFocusMode() && n > 0);

    if(channels.length === 0){
      grid.style.display = "none";
      allHiddenMsg.hidden = true;
      emptyState.style.display = "block";
      return;
    }
    emptyState.style.display = "none";
    if(n === 0){
      // todos ocultos por "Ocultar desconectados"
      grid.style.display = "none";
      allHiddenMsg.hidden = false;
      return;
    }
    allHiddenMsg.hidden = true;
    grid.style.display = "grid";

    if(isFocusMode()){
      applyFocusLayout(visible);
      return;
    }

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
      const live = document.createElement("span");
      live.className = "live-dot";
      live.title = "En vivo";
      live.hidden = true;
      btn.appendChild(dot);
      btn.appendChild(label);
      btn.appendChild(live);
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
    channels.forEach(ch => updateStatusUI(ch.name));
    updateTabArrows();
  }

  /* ---- pestañas que no caben: flechas + degradado en los bordes ---- */
  const chatTabsWrap = document.getElementById("chat-tabs-wrap");
  const tabsLeftBtn = document.getElementById("tabs-left");
  const tabsRightBtn = document.getElementById("tabs-right");
  function updateTabArrows(){
    const max = chatTabsEl.scrollWidth - chatTabsEl.clientWidth;
    const x = chatTabsEl.scrollLeft;
    const canL = max > 1 && x > 1;
    const canR = max > 1 && x < max - 1;
    tabsLeftBtn.hidden = !canL;
    tabsRightBtn.hidden = !canR;
    chatTabsWrap.classList.toggle("can-left", canL);
    chatTabsWrap.classList.toggle("can-right", canR);
  }
  function scrollTabs(dir){
    const step = Math.max(80, Math.round(chatTabsEl.clientWidth * 0.7));
    chatTabsEl.scrollBy({ left: dir * step, behavior: "smooth" });
  }
  tabsLeftBtn.addEventListener("click", () => scrollTabs(-1));
  tabsRightBtn.addEventListener("click", () => scrollTabs(1));
  chatTabsEl.addEventListener("scroll", updateTabArrows, { passive: true });
  // la rueda del mouse (vertical) mueve las pestañas de lado
  chatTabsEl.addEventListener("wheel", (e) => {
    if(Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    if(chatTabsEl.scrollWidth <= chatTabsEl.clientWidth) return;
    e.preventDefault();
    chatTabsEl.scrollLeft += e.deltaY;
  }, { passive: false });
  if(window.ResizeObserver) new ResizeObserver(updateTabArrows).observe(chatTabsEl);
  window.addEventListener("resize", updateTabArrows);

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
    colsSelect.value = isFocusMode() ? "focus"
      : (layoutPrefs.colsOverride ? String(layoutPrefs.colsOverride) : "auto");
  }

  function setFocus(name){
    layoutPrefs.focusMode = true;
    if(name) layoutPrefs.focusChannel = name;
    else if(!channels.some(c => c.name === layoutPrefs.focusChannel)){
      layoutPrefs.focusChannel = channels.length ? channels[0].name : null;
    }
    syncColsSelect();
    saveLayoutPrefs();
    updateGridLayout();
  }

  colsSelect.addEventListener("change", () => {
    const v = colsSelect.value;
    if(v === "focus"){
      setFocus(null);
      return;
    }
    layoutPrefs.focusMode = false;
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
    const note = document.getElementById("reset-status");
    if(note) note.textContent = "Diseño restablecido.";
  });

  function syncHideOfflineBtn(){
    hideOfflineBtn.classList.toggle("active", hideOffline);
    hideOfflineBtn.setAttribute("aria-pressed", hideOffline ? "true" : "false");
  }
  hideOfflineBtn.addEventListener("click", () => {
    hideOffline = !hideOffline;
    try{ localStorage.setItem(HIDE_OFFLINE_KEY, hideOffline ? "1" : "0"); }catch(e){ /* noop */ }
    syncHideOfflineBtn();
    updateGridLayout();
  });

  /* =====================================================================
     RENDER: TILES (solo video)
     Los tiles existentes se reutilizan; el orden visual va por CSS
     "order" para no mover (y recargar) los iframes del reproductor.
     ===================================================================== */
  function renderChannels(){
    tiles.forEach((rec, name) => {
      if(!channels.some(c => c.name === name)){
        rec.tile.remove();
        tiles.delete(name);
        eventStatus.delete(name);
        if(helixStatus) helixStatus.delete(name);
      }
    });
    channels.forEach((ch, i) => {
      let rec = tiles.get(ch.name);
      if(!rec){
        rec = buildTile(ch);
        tiles.set(ch.name, rec);
        grid.appendChild(rec.tile);
        createPlayer(rec);
      }
      rec.tile.style.order = String(i);
    });
    if(soloChannel && !channels.some(c => c.name === soloChannel)){
      soloChannel = null; soloMuted = false; audioArmed = false;
      saveAudio();
    }
    updateGridLayout();
    renderChatTabs();
    updateFeedEmpty();
    tiles.forEach(rec => updateSpeakerUI(rec));
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

    // estado en vivo: punto + texto, espectadores, título, juego
    const statusEl = document.createElement("span");
    statusEl.className = "live-status";
    statusEl.hidden = true;
    const statusDot = document.createElement("span");
    statusDot.className = "status-dot";
    const statusText = document.createElement("span");
    statusText.className = "status-text";
    statusEl.appendChild(statusDot);
    statusEl.appendChild(statusText);

    const viewersEl = document.createElement("span");
    viewersEl.className = "viewers";
    viewersEl.hidden = true;

    const metaEl = document.createElement("div");
    metaEl.className = "tile-meta";
    const titleEl = document.createElement("span");
    titleEl.className = "stream-title";
    const gameEl = document.createElement("span");
    gameEl.className = "stream-game";
    metaEl.appendChild(titleEl);
    metaEl.appendChild(gameEl);

    // audio: botón "Escuchar" (solo) + volumen
    const audioEl = document.createElement("div");
    audioEl.className = "tile-audio";
    const speakerBtn = document.createElement("button");
    speakerBtn.type = "button";
    speakerBtn.className = "icon-btn speaker-btn";
    speakerBtn.setAttribute("aria-label", "Escuchar");
    speakerBtn.addEventListener("click", () => onSpeakerClick(ch.name));
    const volSlider = document.createElement("input");
    volSlider.type = "range";
    volSlider.min = "0";
    volSlider.max = "100";
    volSlider.step = "1";
    volSlider.className = "vol-slider";
    volSlider.title = "Volumen";
    volSlider.setAttribute("aria-label", "Volumen de " + ch.name);
    volSlider.value = String(getVolume(ch.name));
    volSlider.addEventListener("input", () => setChannelVolume(ch.name, parseInt(volSlider.value, 10)));
    audioEl.appendChild(speakerBtn);
    audioEl.appendChild(volSlider);

    const focusBtn = document.createElement("button");
    focusBtn.type = "button";
    focusBtn.className = "icon-btn focus-btn";
    focusBtn.title = "Ver en grande (Foco)";
    focusBtn.setAttribute("aria-label", "Ver " + ch.name + " en grande (Foco)");
    focusBtn.textContent = "⤢ Foco";
    focusBtn.addEventListener("click", () => setFocus(ch.name));

    const chatBtn = document.createElement("button");
    chatBtn.type = "button";
    chatBtn.setAttribute("aria-label", "Chat de " + ch.name);
    chatBtn.className = "icon-btn chat-btn";
    chatBtn.title = "Abrir el chat de este canal en el panel";
    // ícono de globo (SVG fijo, sin datos del usuario)
    const svgNS = "http://www.w3.org/2000/svg";
    const chatSvg = document.createElementNS(svgNS, "svg");
    chatSvg.setAttribute("viewBox", "0 0 24 24");
    chatSvg.setAttribute("width", "13");
    chatSvg.setAttribute("height", "13");
    chatSvg.setAttribute("aria-hidden", "true");
    const chatPath = document.createElementNS(svgNS, "path");
    chatPath.setAttribute("d", "M4 5h16v11H9l-5 4V5z");
    chatPath.setAttribute("fill", "none");
    chatPath.setAttribute("stroke", "currentColor");
    chatPath.setAttribute("stroke-width", "2");
    chatPath.setAttribute("stroke-linejoin", "round");
    chatSvg.appendChild(chatPath);
    chatBtn.appendChild(chatSvg);
    chatBtn.addEventListener("click", () => {
      if(!chatPanelOpen){
        chatPanelOpen = true;
        saveChatPanelOpen();
        applyChatPanelOpen();
      }
      selectTab(ch.name);
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.setAttribute("aria-label", "Quitar " + ch.name);
    removeBtn.className = "icon-btn remove";
    removeBtn.title = "Quitar canal";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => removeChannel(ch.name));

    // controles: en escritorio aparecen al pasar el mouse / con foco de
    // teclado; en pantallas táctiles siempre visibles (ver style.css)
    const controlsEl = document.createElement("div");
    controlsEl.className = "tile-controls";
    controlsEl.appendChild(dragHandle);
    controlsEl.appendChild(audioEl);
    controlsEl.appendChild(focusBtn);
    controlsEl.appendChild(chatBtn);
    controlsEl.appendChild(removeBtn);

    header.appendChild(dot);
    header.appendChild(nameEl);
    header.appendChild(statusEl);
    header.appendChild(viewersEl);
    header.appendChild(metaEl);
    header.appendChild(controlsEl);

    // body
    const body = document.createElement("div");
    body.className = "tile-body";

    const videoWrap = document.createElement("div");
    videoWrap.className = "tile-video-wrap";
    const host = document.createElement("div");
    host.className = "player-host";
    host.id = "player-" + ch.name;
    videoWrap.appendChild(host);

    body.appendChild(videoWrap);
    tile.appendChild(header);
    tile.appendChild(body);

    const rec = {
      name: ch.name, tile, host, player: null, ready: false,
      els: { statusEl, statusText, viewersEl, metaEl, titleEl, gameEl, speakerBtn, volSlider, focusBtn }
    };
    updateSpeakerUI(rec);
    return rec;
  }

  /* =====================================================================
     REPRODUCTOR — Twitch Embed JS API (se carga una sola vez)
     ===================================================================== */
  let embedApiPromise = null;
  function loadEmbedApi(){
    if(embedApiPromise) return embedApiPromise;
    embedApiPromise = new Promise(resolve => {
      if(window.Twitch && window.Twitch.Player){ resolve(true); return; }
      const sc = document.createElement("script");
      sc.src = EMBED_API_URL;
      sc.async = true;
      sc.onload = () => resolve(!!(window.Twitch && window.Twitch.Player));
      sc.onerror = () => {
        console.warn("No se pudo cargar la API del reproductor de Twitch; se usa el reproductor simple (sin control de audio ni estado en vivo).");
        resolve(false);
      };
      document.head.appendChild(sc);
    });
    return embedApiPromise;
  }

  function createPlayer(rec){
    loadEmbedApi().then(ok => {
      if(tiles.get(rec.name) !== rec || rec.player || rec.host.firstChild) return; // canal quitado o ya creado
      if(!ok){
        // respaldo: iframe simple como antes
        const f = document.createElement("iframe");
        f.src = `https://player.twitch.tv/?channel=${encodeURIComponent(rec.name)}&parent=${encodeURIComponent(PARENT)}&muted=true`;
        f.allowFullscreen = true;
        f.setAttribute("allow", "autoplay; fullscreen");
        rec.host.appendChild(f);
        return;
      }
      let p;
      try{
        p = new window.Twitch.Player(rec.host.id, {
          channel: rec.name,
          parent: [PARENT],
          muted: true,
          autoplay: true,
          width: "100%",
          height: "100%"
        });
      }catch(e){
        console.warn("No se pudo crear el reproductor de " + rec.name + ":", e);
        return;
      }
      rec.player = p;
      const P = window.Twitch.Player;
      // El reproductor restaura su propio volumen guardado al cargar el
      // stream (después de READY), así que el audio se vuelve a aplicar
      // en cada evento de carga y un par de veces tras READY.
      p.addEventListener(P.READY, () => {
        rec.ready = true;
        applyAudio(rec);
        [1500, 4000].forEach(ms => setTimeout(() => { if(tiles.get(rec.name) === rec) applyAudio(rec); }, ms));
      });
      p.addEventListener(P.PLAYING, () => { rec.ready = true; setEventStatus(rec.name, true); applyAudio(rec); });
      if(P.PLAY) p.addEventListener(P.PLAY, () => applyAudio(rec));
      if(P.PLAYBACK_BLOCKED) p.addEventListener(P.PLAYBACK_BLOCKED, () => applyAudio(rec));
      p.addEventListener(P.ONLINE, () => { setEventStatus(rec.name, true); applyAudio(rec); });
      p.addEventListener(P.OFFLINE, () => setEventStatus(rec.name, false));
    });
  }

  /* =====================================================================
     ESTADO EN VIVO (eventos del reproductor / Helix con sesión)
     ===================================================================== */
  function getStatus(name){
    if(authToken && helixStatus && helixStatus.has(name)) return helixStatus.get(name);
    if(eventStatus.has(name)) return { live: eventStatus.get(name) };
    return null; // todavía no se sabe
  }

  function setEventStatus(name, live){
    if(eventStatus.get(name) === live) return;
    eventStatus.set(name, live);
    onStatusChanged([name]);
  }

  // Refresca headers/pestañas; rehace el grid solo si cambió qué se ve.
  let lastVisibleKey = "";
  function onStatusChanged(names){
    names.forEach(updateStatusUI);
    const now = visibleChannels().join(",");
    if(now !== lastVisibleKey){
      lastVisibleKey = now;
      updateGridLayout();
    }
  }

  function formatViewers(n){
    if(n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + " M";
    if(n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + " mil";
    return String(n);
  }

  function updateStatusUI(name){
    const st = getStatus(name);
    const rec = tiles.get(name);
    if(rec){
      const e = rec.els;
      const known = !!st;
      const live = known && st.live;
      rec.tile.classList.toggle("offline", known && !live);
      rec.tile.classList.toggle("live", live);
      rec.tile.classList.toggle("hidden-offline", isHiddenOffline(name));
      e.statusEl.hidden = !known;
      e.statusEl.classList.toggle("is-live", live);
      e.statusText.textContent = live ? "EN VIVO" : "Desconectado";
      const rich = live && typeof st.viewers === "number";
      e.viewersEl.hidden = !rich;
      e.viewersEl.textContent = rich ? formatViewers(st.viewers) : "";
      e.viewersEl.title = rich ? st.viewers.toLocaleString("es-MX") + " espectadores" : "";
      const title = live && st.title ? st.title : "";
      const game = live && st.game ? st.game : "";
      e.titleEl.textContent = title;
      e.gameEl.textContent = game;
      e.titleEl.title = title;
      e.metaEl.title = [title, game].filter(Boolean).join(" · ");
    }
    const tabDot = chatTabsEl.querySelector(`.chat-tab[data-tab="${name}"] .live-dot`);
    if(tabDot) tabDot.hidden = !(st && st.live);
  }

  function refreshAllStatus(){
    onStatusChanged(channels.map(c => c.name));
  }

  // Helix: una sola petición con todos los canales.
  function pollStreams(){
    if(!authToken) return;
    const names = channels.map(c => c.name).slice(0, 100);
    const token = authToken;
    const seq = ++helixSeq;
    if(names.length === 0){
      helixStatus = new Map();
      return;
    }
    const qs = names.map(n => "user_login=" + encodeURIComponent(n)).join("&");
    fetch("https://api.twitch.tv/helix/streams?first=100&" + qs, { headers: helixHeaders() })
      .then(res => {
        if(res.status === 401){
          if(authToken === token) logout(false); // token vencido: se cierra la sesión
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then(d => {
        if(!d || seq !== helixSeq || authToken !== token || !Array.isArray(d.data)) return;
        const m = new Map();
        names.forEach(n => m.set(n, { live: false }));
        d.data.forEach(s => {
          if(!s || typeof s.user_login !== "string") return;
          const login = s.user_login.toLowerCase();
          if(!m.has(login)) return;
          if(s.type && s.type !== "live") return;
          m.set(login, {
            live: true,
            viewers: (typeof s.viewer_count === "number" && isFinite(s.viewer_count)) ? Math.max(0, Math.round(s.viewer_count)) : null,
            title: typeof s.title === "string" ? s.title.slice(0, 300) : "",
            game: typeof s.game_name === "string" ? s.game_name.slice(0, 100) : ""
          });
        });
        helixStatus = m;
        refreshAllStatus();
      })
      .catch(() => { /* sin red: se reintenta en el siguiente ciclo */ });
  }

  function startStreamsPolling(){
    pollStreams();
    if(!helixTimer) helixTimer = setInterval(pollStreams, STREAMS_POLL_MS);
  }
  function stopStreamsPolling(){
    if(helixTimer){ clearInterval(helixTimer); helixTimer = null; }
    helixSeq++;
    helixStatus = null;
  }

  /* =====================================================================
     AUDIO — solo de un canal + volumen por canal
     ===================================================================== */
  function getVolume(name){
    return typeof volumes[name] === "number" ? volumes[name] : DEFAULT_VOLUME;
  }

  function isAudible(name){
    return name === soloChannel && !soloMuted && !audioArmed;
  }

  function applyAudio(rec){
    if(!rec.player || !rec.ready) return;
    // El reproductor ignora setVolume mientras está silenciado: primero se
    // quita el silencio y después se pone el volumen guardado.
    try{
      if(isAudible(rec.name)){
        rec.player.setMuted(false);
        rec.player.setVolume(getVolume(rec.name) / 100);
      }else{
        rec.player.setVolume(getVolume(rec.name) / 100);
        rec.player.setMuted(true);
      }
    }catch(e){ /* reproductor aún no listo */ }
  }

  function updateSpeakerUI(rec){
    const b = rec.els.speakerBtn;
    const audible = isAudible(rec.name);
    const armed = audioArmed && rec.name === soloChannel;
    b.classList.toggle("active", audible);
    b.classList.toggle("armed", armed);
    if(armed){
      b.textContent = "🔈 toca para activar";
      b.title = "El navegador empieza en silencio: toca para activar el audio";
    }else if(audible){
      b.textContent = "🔊";
      b.title = "Silenciar (tecla M)";
    }else{
      b.textContent = "🔇";
      b.title = "Escuchar este canal (silencia los demás)";
    }
    b.setAttribute("aria-pressed", audible ? "true" : "false");
  }

  function applyAllAudio(){
    tiles.forEach(rec => { applyAudio(rec); updateSpeakerUI(rec); });
  }

  function onSpeakerClick(name){
    if(name === soloChannel && !soloMuted && !audioArmed){
      soloMuted = true; // segundo clic en el solo: silenciar
    }else{
      soloChannel = name;
      soloMuted = false;
      audioArmed = false;
    }
    saveAudio();
    applyAllAudio();
  }

  function toggleSoloMute(){
    if(!soloChannel || !tiles.has(soloChannel)) return;
    if(audioArmed){ audioArmed = false; soloMuted = false; }
    else soloMuted = !soloMuted;
    saveAudio();
    applyAllAudio();
  }

  function setChannelVolume(name, v){
    if(!isFinite(v)) return;
    volumes[name] = Math.max(0, Math.min(100, v));
    saveVolumes();
    const rec = tiles.get(name);
    if(rec && rec.player && rec.ready){
      try{ rec.player.setVolume(volumes[name] / 100); }catch(e){ /* noop */ }
    }
  }

  /* =====================================================================
     TECLADO: M = silenciar/activar el solo · 1-9 = foco (solo en modo
     Foco) · F = pantalla completa del tile en foco
     ===================================================================== */
  function isTypingTarget(el){
    if(!el) return false;
    const tag = el.tagName;
    if(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return !!el.isContentEditable;
  }

  document.addEventListener("keydown", (e) => {
    if(e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if(isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    const k = e.key;
    if(k === "m" || k === "M"){
      toggleSoloMute();
      e.preventDefault();
      return;
    }
    if(!isFocusMode()) return;
    if(/^[1-9]$/.test(k)){
      const name = visibleChannels()[parseInt(k, 10) - 1];
      if(name){ setFocus(name); e.preventDefault(); }
      return;
    }
    if(k === "f" || k === "F"){
      if(document.fullscreenElement){
        document.exitFullscreen().catch(() => {});
      }else{
        const focus = effectiveFocus(visibleChannels());
        const rec = focus && tiles.get(focus);
        if(rec && rec.tile.requestFullscreen) rec.tile.requestFullscreen().catch(() => {});
      }
      e.preventDefault();
    }
  });

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
    pollStreams();

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
    pollStreams();
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
    authUserId = null;
    clearStoredAuth();
    clearBadges();
    if(authValidateTimer){ clearInterval(authValidateTimer); authValidateTimer = null; }
    stopStreamsPolling();
    refreshAllStatus(); // vuelve a los eventos del reproductor
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
      userNameEl.title = authUsername;
    }else{
      loginBtn.hidden = false;
      userChip.hidden = true;
      userNameEl.textContent = "";
    }
    syncFollowsBtn();
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
    authUserId = typeof data.user_id === "string" ? data.user_id : null;
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 0;
    writeStoredAuth({
      token,
      login: data.login,
      userId: typeof data.user_id === "string" ? data.user_id : null,
      expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : null
    });
    refreshAuthUI();
    loadAllBadges();
    startStreamsPolling();
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
     SETUPS GUARDADOS + LINK PARA COMPARTIR (ronda 3a)
     Un setup = lista de canales + diseño (columnas / Foco + canal en
     foco) + panel de chat visible u oculto. Se guardan en localStorage
     (twitch-multiview.setups). El link ?c=a,b,c (+ &foco=b) abre una
     "vista compartida" que NO toca la lista guardada hasta que el usuario
     toca «Guardar como mi lista» (o carga uno de sus setups).
     ===================================================================== */
  const setupsWrap = document.getElementById("setups-wrap");
  const setupsBtn = document.getElementById("setups-btn");
  const setupsMenu = document.getElementById("setups-menu");
  const setupsList = document.getElementById("setups-list");
  const setupsEmpty = document.getElementById("setups-empty");
  const setupsSaveBtn = document.getElementById("setups-save-btn");
  const setupsSaveForm = document.getElementById("setups-save-form");
  const setupsSaveInput = document.getElementById("setups-save-input");
  const setupsSaveCancel = document.getElementById("setups-save-cancel");
  const setupsError = document.getElementById("setups-error");
  const shareCopyBtn = document.getElementById("share-copy-btn");
  const shareUrlInput = document.getElementById("share-url");
  const shareStatus = document.getElementById("share-status");
  const sharedBar = document.getElementById("shared-bar");
  const sharedSaveBtn = document.getElementById("shared-save-btn");
  const sharedExitBtn = document.getElementById("shared-exit-btn");

  const SETUP_NAME_MAX = 40;
  const SETUPS_MAX = 50;

  function cleanSetupName(raw){
    return String(raw || "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, SETUP_NAME_MAX);
  }

  // Valida una lista de nombres con las mismas reglas que «Agregar canal».
  function validNameList(list, max){
    if(!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    list.forEach(raw => {
      if(typeof raw !== "string") return;
      const n = normalizeChannelName(raw);
      if(CHANNEL_RE.test(n) && !seen.has(n) && out.length < max){ seen.add(n); out.push(n); }
    });
    return out;
  }

  function loadSetups(){
    try{
      const parsed = JSON.parse(localStorage.getItem(SETUPS_KEY) || "[]");
      if(!Array.isArray(parsed)) return [];
      const out = [];
      parsed.forEach(s => {
        if(!s || typeof s !== "object") return;
        const name = cleanSetupName(s.name);
        if(!name) return;
        const chs = validNameList(s.channels, 100);
        const cols = (s.cols === "focus" || s.cols === "auto") ? s.cols
          : (Number.isInteger(s.cols) && s.cols >= 1 && s.cols <= 6 ? s.cols : "auto");
        const focus = (typeof s.focus === "string" && chs.includes(s.focus)) ? s.focus : null;
        out.push({ name, channels: chs, cols, focus, chat: s.chat !== false });
      });
      return out.slice(0, SETUPS_MAX);
    }catch(e){
      return [];
    }
  }
  function saveSetups(list){
    try{ localStorage.setItem(SETUPS_KEY, JSON.stringify(list)); return true; }
    catch(e){ console.warn("No se pudieron guardar los setups:", e); return false; }
  }

  function currentSetup(name){
    const focus = isFocusMode();
    return {
      name,
      channels: channels.map(c => c.name),
      cols: focus ? "focus" : (layoutPrefs.colsOverride || "auto"),
      focus: focus ? effectiveFocus(channels.map(c => c.name)) : null,
      chat: chatPanelOpen
    };
  }

  // Reemplaza la lista de canales completa (cargar setup / volver a mi
  // lista). Reutiliza los tiles que siguen y ajusta el IRC.
  function replaceChannels(names){
    const old = channels.map(c => c.name);
    channels = names.map(n => ({ name: n }));
    const gone = old.filter(n => !names.includes(n));
    const added = names.filter(n => !old.includes(n));
    gone.forEach(n => {
      roomIds.delete(n);
      channelEmotes.delete(n);
      channelBadges.delete(n);
      removeFeedMessages(el => el.dataset.channel === n);
    });
    saveChannels();
    renderChannels();
    pollStreams();
    if(channels.length === 0){ closeIrc(); return; }
    if(ircSocket && ircSocket.readyState === WebSocket.OPEN){
      gone.forEach(ircPart);
      added.forEach(ircJoin);
    }else if(!ircSocket || ircSocket.readyState !== WebSocket.CONNECTING){
      connectIrc();
    }
  }

  function applyLayoutChoice(cols, focus){
    layoutPrefs.colFr = null;
    layoutPrefs.rowFr = null;
    layoutPrefs.dimsKey = null;
    if(cols === "focus"){
      layoutPrefs.focusMode = true;
      layoutPrefs.focusChannel = focus || (channels.length ? channels[0].name : null);
    }else{
      layoutPrefs.focusMode = false;
      layoutPrefs.colsOverride = (cols === "auto") ? null : cols;
    }
    syncColsSelect();
    saveLayoutPrefs();
  }

  function loadSetup(s){
    if(sharedView) leaveSharedView(false);
    replaceChannels(s.channels.slice());
    applyLayoutChoice(s.cols, s.focus);
    chatPanelOpen = !!s.chat;
    saveChatPanelOpen();
    applyChatPanelOpen();   // también vuelve a calcular el grid
  }

  // --- menú ---
  let setupsEditing = null;    // índice en modo renombrar
  let setupsConfirm = null;    // índice esperando confirmación de borrar

  function setupsMenuOpen(){ return !setupsMenu.hidden; }
  function openSetupsMenu(){
    setupsEditing = null; setupsConfirm = null;
    setupsError.textContent = "";
    shareStatus.textContent = "";
    document.getElementById("reset-status").textContent = "";
    shareUrlInput.hidden = true;
    hideSaveForm();
    renderSetupsMenu();
    // en pantallas angostas el menú es fixed, pegado debajo del botón
    setupsMenu.style.top = isNarrow() ? Math.round(setupsBtn.getBoundingClientRect().bottom + 6) + "px" : "";
    setupsMenu.hidden = false;
    setupsBtn.setAttribute("aria-expanded", "true");
    setupsBtn.classList.add("active");
  }
  function closeSetupsMenu(){
    setupsMenu.hidden = true;
    setupsBtn.setAttribute("aria-expanded", "false");
    setupsBtn.classList.remove("active");
  }
  setupsBtn.addEventListener("click", () => { if(setupsMenuOpen()) closeSetupsMenu(); else openSetupsMenu(); });
  document.addEventListener("mousedown", (e) => {
    if(setupsMenuOpen() && !setupsWrap.contains(e.target)) closeSetupsMenu();
  });
  setupsMenu.addEventListener("keydown", (e) => {
    if(e.key !== "Escape") return;
    e.stopPropagation();
    if(setupsEditing !== null || setupsConfirm !== null){ setupsEditing = null; setupsConfirm = null; renderSetupsMenu(); }
    else if(!setupsSaveForm.hidden) hideSaveForm();
    else { closeSetupsMenu(); setupsBtn.focus(); }
  });

  function channelCountText(n){ return n === 1 ? "1 canal" : n + " canales"; }

  function mkBtn(cls, text){
    const b = document.createElement("button");
    b.type = "button"; b.className = cls; b.textContent = text;
    return b;
  }

  function renderSetupsMenu(){
    const list = loadSetups();
    setupsList.textContent = "";
    setupsEmpty.hidden = list.length > 0;
    list.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "setup-row";
      row.dataset.index = String(i);

      if(setupsEditing === i){
        const form = document.createElement("form");
        form.className = "setup-rename";
        const inp = document.createElement("input");
        inp.type = "text"; inp.maxLength = SETUP_NAME_MAX; inp.value = s.name;
        inp.setAttribute("aria-label", "Nuevo nombre");
        const ok = mkBtn("btn btn-accent", "Guardar"); ok.type = "submit";
        const cancel = mkBtn("btn", "Cancelar");
        cancel.addEventListener("click", () => { setupsEditing = null; setupsError.textContent = ""; renderSetupsMenu(); });
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          const name = cleanSetupName(inp.value);
          if(!name){ setupsError.textContent = "Escribe un nombre."; return; }
          const all = loadSetups();
          if(all.some((o, j) => j !== i && o.name.toLowerCase() === name.toLowerCase())){
            setupsError.textContent = "Ya tienes un setup con ese nombre."; return;
          }
          if(!all[i]) return;
          all[i].name = name;
          saveSetups(all);
          setupsEditing = null; setupsError.textContent = "";
          renderSetupsMenu();
        });
        form.appendChild(inp); form.appendChild(ok); form.appendChild(cancel);
        row.appendChild(form);
        setupsList.appendChild(row);
        setTimeout(() => { inp.focus(); inp.select(); }, 0);
        return;
      }

      if(setupsConfirm === i){
        const q = document.createElement("span");
        q.className = "setup-confirm-text";
        q.textContent = "¿Borrar «" + s.name + "»?";
        const yes = mkBtn("btn btn-danger setup-confirm-yes", "Sí, borrar");
        yes.addEventListener("click", () => {
          const all = loadSetups();
          all.splice(i, 1);
          saveSetups(all);
          setupsConfirm = null;
          renderSetupsMenu();
        });
        const no = mkBtn("btn setup-confirm-no", "No");
        no.addEventListener("click", () => { setupsConfirm = null; renderSetupsMenu(); });
        row.classList.add("confirming");
        row.appendChild(q); row.appendChild(yes); row.appendChild(no);
        setupsList.appendChild(row);
        setTimeout(() => no.focus(), 0);
        return;
      }

      const load = mkBtn("setup-load", "");
      load.title = s.channels.length ? "Cargar: " + s.channels.join(", ") : "Cargar (sin canales)";
      const nm = document.createElement("span");
      nm.className = "setup-name";
      nm.textContent = s.name;
      const cnt = document.createElement("span");
      cnt.className = "setup-count";
      cnt.textContent = channelCountText(s.channels.length) + (s.cols === "focus" ? " · Foco" : "");
      load.appendChild(nm); load.appendChild(cnt);
      load.addEventListener("click", () => { loadSetup(s); closeSetupsMenu(); });

      const ren = mkBtn("icon-btn setup-rename-btn", "✎");
      ren.title = "Renombrar"; ren.setAttribute("aria-label", "Renombrar " + s.name);
      ren.addEventListener("click", () => { setupsEditing = i; setupsConfirm = null; setupsError.textContent = ""; renderSetupsMenu(); });

      const del = mkBtn("icon-btn remove setup-delete-btn", "×");
      del.title = "Borrar"; del.setAttribute("aria-label", "Borrar " + s.name);
      del.addEventListener("click", () => { setupsConfirm = i; setupsEditing = null; renderSetupsMenu(); });

      row.appendChild(load); row.appendChild(ren); row.appendChild(del);
      setupsList.appendChild(row);
    });
    const none = channels.length === 0;
    setupsSaveBtn.disabled = none;
    setupsSaveBtn.title = none ? "Agrega canales primero" : "";
    shareCopyBtn.disabled = none;
    shareCopyBtn.title = none ? "Agrega canales primero" : "Copia un link con estos canales";
  }

  function hideSaveForm(){
    setupsSaveForm.hidden = true;
    setupsSaveBtn.hidden = false;
  }
  setupsSaveBtn.addEventListener("click", () => {
    setupsError.textContent = "";
    setupsSaveBtn.hidden = true;
    setupsSaveForm.hidden = false;
    setupsSaveInput.value = "";
    setupsSaveInput.focus();
  });
  setupsSaveCancel.addEventListener("click", () => { hideSaveForm(); setupsError.textContent = ""; });
  setupsSaveForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = cleanSetupName(setupsSaveInput.value);
    if(!name){ setupsError.textContent = "Escribe un nombre."; return; }
    const all = loadSetups();
    if(all.some(o => o.name.toLowerCase() === name.toLowerCase())){
      setupsError.textContent = "Ya tienes un setup con ese nombre."; return;
    }
    if(all.length >= SETUPS_MAX){ setupsError.textContent = "Llegaste al máximo de " + SETUPS_MAX + " setups."; return; }
    all.push(currentSetup(name));
    if(!saveSetups(all)){ setupsError.textContent = "No se pudo guardar."; return; }
    setupsError.textContent = "";
    hideSaveForm();
    renderSetupsMenu();
  });

  // --- link para compartir ---
  function buildShareUrl(){
    const names = channels.map(c => c.name).slice(0, MAX_SHARED_CHANNELS);
    let url = window.location.origin + window.location.pathname + "?c=" + names.map(encodeURIComponent).join(",");
    if(isFocusMode()){
      const f = effectiveFocus(names);
      if(f) url += "&foco=" + encodeURIComponent(f);
    }
    return url;
  }
  shareCopyBtn.addEventListener("click", () => {
    if(!channels.length) return;
    const url = buildShareUrl();
    shareUrlInput.value = url;
    shareUrlInput.hidden = false;
    const fallback = () => {
      shareUrlInput.focus();
      shareUrlInput.select();
      let ok = false;
      try{ ok = document.execCommand("copy"); }catch(e){ ok = false; }
      shareStatus.textContent = ok ? "Link copiado." : "Copia el link de arriba.";
    };
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(url).then(() => { shareStatus.textContent = "Link copiado."; }, fallback);
    }else{
      fallback();
    }
  });

  // --- vista compartida (?c=) ---
  function readSharedQuery(){
    let params;
    try{ params = new URLSearchParams(window.location.search); }catch(e){ return null; }
    if(!params.has("c")) return null;
    const names = validNameList(String(params.get("c") || "").split(","), MAX_SHARED_CHANNELS);
    let foco = null;
    if(params.has("foco")){
      const f = normalizeChannelName(String(params.get("foco") || ""));
      if(names.includes(f)) foco = f;
    }
    return { names, foco };
  }

  function cleanQueryFromUrl(){
    try{ window.history.replaceState(null, "", window.location.pathname + window.location.hash); }
    catch(e){ /* noop */ }
  }

  // Se llama al iniciar, antes del primer render.
  function enterSharedViewFromUrl(){
    const q = readSharedQuery();
    if(!q) return;
    if(!q.names.length){ cleanQueryFromUrl(); return; }  // link sin canales válidos: se ignora
    sharedView = true;
    channels = q.names.map(n => ({ name: n }));
    layoutPrefs.colFr = null; layoutPrefs.rowFr = null; layoutPrefs.dimsKey = null;
    if(q.foco){
      layoutPrefs.focusMode = true;
      layoutPrefs.focusChannel = q.foco;
    }else{
      layoutPrefs.focusMode = false;
    }
    sharedBar.hidden = false;
  }

  // save=true: la vista compartida pasa a ser «mi lista».
  function leaveSharedView(save){
    sharedView = false;
    sharedBar.hidden = true;
    cleanQueryFromUrl();
    if(save){
      saveChannels();
      saveLayoutPrefs();
      saveAudio();
    }
  }
  sharedSaveBtn.addEventListener("click", () => leaveSharedView(true));
  sharedExitBtn.addEventListener("click", () => {
    leaveSharedView(false);
    layoutPrefs = loadLayoutPrefs();
    syncColsSelect();
    applyChatPanelSize();
    replaceChannels(loadChannels().map(c => c.name));
  });

  /* =====================================================================
     AGREGAR DE MIS SEGUIDOS (ronda 3b)
     Solo con sesión iniciada (scope user:read:follows). Pide la lista de
     canales seguidos (100 por página, máx. 500) y luego /helix/streams
     por user_id (100 por petición) para poner primero los que están en
     vivo, ordenados por espectadores.
     ===================================================================== */
  const followsWrap = document.getElementById("follows-wrap");
  const followsBtn = document.getElementById("follows-btn");
  const followsMenu = document.getElementById("follows-menu");
  const followsSearch = document.getElementById("follows-search");
  const followsStatus = document.getElementById("follows-status");
  const followsRetry = document.getElementById("follows-retry");
  const followsList = document.getElementById("follows-list");
  const followsCount = document.getElementById("follows-count");
  const followsAddBtn = document.getElementById("follows-add-btn");

  const FOLLOWS_MAX = 500;
  const FOLLOWS_PAGE = 100;
  let followsItems = [];          // [{ login, display, id, live, viewers, game }]
  let followsTruncated = false;
  let followsSelected = new Set();
  let followsSeq = 0;
  let followsLoading = false;

  function isLoggedIn(){ return !!(authToken && authUsername); }

  function syncFollowsBtn(){
    if(isLoggedIn()){
      followsBtn.textContent = "＋ Agregar de mis seguidos";
      followsBtn.title = "Elegir canales de la lista de canales que sigues en Twitch";
    }else{
      followsBtn.textContent = "Inicia sesión para ver tus seguidos";
      followsBtn.title = "Inicia sesión con Twitch para agregar canales que sigues";
      if(followsMenuOpen()) showFollowsLoggedOut();
    }
  }

  function followsMenuOpen(){ return !followsMenu.hidden; }

  function setFollowsStatus(text, isError){
    followsStatus.textContent = text || "";
    followsStatus.classList.toggle("setups-error", !!isError);
  }

  function showFollowsLoggedOut(){
    followsSeq++;
    followsLoading = false;
    followsItems = [];
    followsSelected = new Set();
    followsList.textContent = "";
    followsSearch.hidden = true;
    followsRetry.hidden = true;
    setFollowsStatus("Tu sesión no está iniciada o venció. Inicia sesión para ver tus seguidos.", true);
    updateFollowsFooter();
  }

  function openFollowsMenu(){
    if(!setupsMenu.hidden) closeSetupsMenu();
    followsSearch.value = "";
    followsSelected = new Set();
    followsMenu.style.top = isNarrow() ? Math.round(followsBtn.getBoundingClientRect().bottom + 6) + "px" : "";
    followsMenu.hidden = false;
    followsBtn.setAttribute("aria-expanded", "true");
    followsBtn.classList.add("active");
    loadFollows();
    if(!followsSearch.hidden) followsSearch.focus();
  }
  function closeFollowsMenu(){
    followsMenu.hidden = true;
    followsBtn.setAttribute("aria-expanded", "false");
    followsBtn.classList.remove("active");
  }

  followsBtn.addEventListener("click", () => {
    if(!isLoggedIn()){ loginBtn.click(); return; }
    if(followsMenuOpen()) closeFollowsMenu(); else openFollowsMenu();
  });
  document.addEventListener("mousedown", (e) => {
    if(followsMenuOpen() && !followsWrap.contains(e.target)) closeFollowsMenu();
  });
  followsMenu.addEventListener("keydown", (e) => {
    if(e.key !== "Escape") return;
    e.stopPropagation();
    closeFollowsMenu();
    followsBtn.focus();
  });
  followsSearch.addEventListener("input", renderFollowsList);
  followsRetry.addEventListener("click", loadFollows);

  // Lee una respuesta de Helix: "auth" en 401, null si falla, el JSON si no.
  function helixGet(url){
    return fetch(url, { headers: helixHeaders() }).then(res => {
      if(res.status === 401) return "auth";
      return res.ok ? res.json() : null;
    });
  }

  function loadFollows(){
    if(!isLoggedIn()){ showFollowsLoggedOut(); return; }
    const token = authToken;
    const userId = authUserId;
    const seq = ++followsSeq;
    const stale = () => seq !== followsSeq || authToken !== token;
    followsLoading = true;
    followsItems = [];
    followsTruncated = false;
    followsList.textContent = "";
    followsSearch.hidden = false;
    followsRetry.hidden = true;
    setFollowsStatus("Cargando tus seguidos…");
    updateFollowsFooter();
    if(!userId || !NUM_ID_RE.test(userId)){
      followsLoading = false;
      setFollowsStatus("No se pudo leer tu usuario de Twitch. Cierra sesión y vuelve a entrar.", true);
      return;
    }

    const items = [];
    const seen = new Set();
    const onAuthFail = () => {
      if(seq !== followsSeq) return;
      if(authToken === token) logout(false);   // token vencido: se cierra la sesión
      showFollowsLoggedOut();
    };
    const onFail = () => {
      if(stale()) return;
      followsLoading = false;
      setFollowsStatus("No se pudo cargar tu lista de seguidos. Intenta de nuevo.", true);
      followsRetry.hidden = false;
      updateFollowsFooter();
    };

    function page(cursor){
      let url = "https://api.twitch.tv/helix/channels/followed?user_id=" + encodeURIComponent(userId) + "&first=" + FOLLOWS_PAGE;
      if(cursor) url += "&after=" + encodeURIComponent(cursor);
      return helixGet(url).then(d => {
        if(stale()) return;
        if(d === "auth") return onAuthFail();
        if(!d || !Array.isArray(d.data)) return onFail();
        d.data.forEach(f => {
          if(!f || typeof f.broadcaster_login !== "string" || items.length >= FOLLOWS_MAX) return;
          const login = normalizeChannelName(f.broadcaster_login);
          if(!CHANNEL_RE.test(login) || seen.has(login)) return;
          seen.add(login);
          const display = (typeof f.broadcaster_name === "string" && f.broadcaster_name.trim()) ? f.broadcaster_name.trim().slice(0, 40) : login;
          const id = (typeof f.broadcaster_id === "string" && NUM_ID_RE.test(f.broadcaster_id)) ? f.broadcaster_id : null;
          items.push({ login, display, id, live: false, viewers: null, game: "" });
        });
        const next = (d.pagination && typeof d.pagination.cursor === "string" && d.pagination.cursor) ? d.pagination.cursor : null;
        if(next && items.length < FOLLOWS_MAX && d.data.length > 0) return page(next);
        followsTruncated = !!next && items.length >= FOLLOWS_MAX;
        return streams();
      });
    }

    function streams(){
      const withId = items.filter(i => i.id);
      const byId = new Map(withId.map(i => [i.id, i]));
      const batches = [];
      for(let i = 0; i < withId.length; i += 100) batches.push(withId.slice(i, i + 100).map(x => x.id));
      let authFailed = false;
      return Promise.all(batches.map(b => {
        const url = "https://api.twitch.tv/helix/streams?first=100&" + b.map(id => "user_id=" + encodeURIComponent(id)).join("&");
        return helixGet(url).then(d => {
          if(d === "auth"){ authFailed = true; return; }
          if(!d || !Array.isArray(d.data)) return;
          d.data.forEach(s => {
            if(!s || typeof s.user_id !== "string") return;
            const it = byId.get(s.user_id);
            if(!it || (s.type && s.type !== "live")) return;
            it.live = true;
            it.viewers = (typeof s.viewer_count === "number" && isFinite(s.viewer_count)) ? Math.max(0, Math.round(s.viewer_count)) : null;
            it.game = typeof s.game_name === "string" ? s.game_name.slice(0, 100) : "";
          });
        }).catch(() => { /* sin datos en vivo: la lista se muestra igual */ });
      })).then(() => {
        if(stale()) return;
        if(authFailed) return onAuthFail();
        items.sort((a, b) => {
          if(a.live !== b.live) return a.live ? -1 : 1;
          if(a.live) return (b.viewers || 0) - (a.viewers || 0);
          return a.display.toLowerCase().localeCompare(b.display.toLowerCase());
        });
        followsItems = items;
        followsLoading = false;
        renderFollowsList();
      });
    }

    page(null).catch(onFail);
  }

  function renderFollowsList(){
    followsList.textContent = "";
    if(followsLoading || !isLoggedIn()){ updateFollowsFooter(); return; }
    if(followsItems.length === 0){
      setFollowsStatus("Todavía no sigues a ningún canal.");
      updateFollowsFooter();
      return;
    }
    const q = followsSearch.value.trim().toLowerCase();
    const added = new Set(channels.map(c => c.name));
    const shown = q ? followsItems.filter(i => i.login.includes(q) || i.display.toLowerCase().includes(q)) : followsItems;
    if(shown.length === 0) setFollowsStatus("Ningún canal coincide con la búsqueda.");
    else if(followsTruncated) setFollowsStatus("Se muestran los primeros " + FOLLOWS_MAX + " canales que sigues.");
    else setFollowsStatus("");
    shown.forEach(it => {
      const isAdded = added.has(it.login);
      const row = document.createElement("label");
      row.className = "follow-row" + (isAdded ? " is-added" : "") + (it.live ? " is-live" : "");
      row.dataset.login = it.login;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = it.login;
      cb.checked = isAdded || followsSelected.has(it.login);
      cb.disabled = isAdded;
      cb.addEventListener("change", () => {
        if(cb.checked) followsSelected.add(it.login); else followsSelected.delete(it.login);
        updateFollowsFooter();
      });
      const dot = document.createElement("span");
      dot.className = "follow-dot";
      const nameEl = document.createElement("span");
      nameEl.className = "follow-name";
      nameEl.textContent = it.display;
      if(it.display.toLowerCase() !== it.login) nameEl.title = it.login;
      row.append(cb, dot, nameEl);
      if(it.live){
        const v = document.createElement("span");
        v.className = "follow-viewers";
        v.textContent = it.viewers === null ? "en vivo" : formatViewers(it.viewers);
        if(it.game) v.title = it.game;
        row.appendChild(v);
      }
      if(isAdded){
        const tag = document.createElement("span");
        tag.className = "follow-added";
        tag.textContent = "ya agregado";
        row.appendChild(tag);
      }
      followsList.appendChild(row);
    });
    updateFollowsFooter();
  }

  function pendingFollows(){
    const added = new Set(channels.map(c => c.name));
    return followsItems.map(i => i.login).filter(n => followsSelected.has(n) && !added.has(n));
  }

  function updateFollowsFooter(){
    const n = pendingFollows().length;
    followsAddBtn.disabled = n === 0;
    followsAddBtn.textContent = n > 0 ? "Agregar seleccionados (" + n + ")" : "Agregar seleccionados";
    const live = followsItems.filter(i => i.live).length;
    followsCount.textContent = (followsLoading || followsItems.length === 0) ? ""
      : (followsItems.length + " seguidos · " + live + " en vivo");
  }

  followsAddBtn.addEventListener("click", () => {
    const names = pendingFollows();
    if(names.length === 0) return;
    replaceChannels(channels.map(c => c.name).concat(names));
    followsSelected = new Set();
    closeFollowsMenu();
    followsBtn.focus();
  });

  /* =====================================================================
     INIT
     ===================================================================== */
  function init(){
    cleanupOldStorage();
    if(channels.length) saveChannels(); // reescribe sin campos viejos (chatOpen, etc.)
    enterSharedViewFromUrl();
    checkConfigWarning();
    refreshAuthUI();
    restoreAuth();
    syncColsSelect();
    syncHideOfflineBtn();
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
      badgeCounts: { global: globalBadges.size, channels: Object.fromEntries(Array.from(channelBadges, ([k, v]) => [k, v.size])) },
      status: Object.fromEntries(channels.map(c => [c.name, getStatus(c.name)])),
      visible: visibleChannels(),
      hideOffline,
      focusMode: isFocusMode(),
      focusChannel: isFocusMode() ? effectiveFocus(visibleChannels()) : null,
      solo: soloChannel, soloMuted, audioArmed,
      sharedView,
      volumes: Object.assign({}, volumes)
    }),
    // lectura directa del reproductor (player.getMuted / getVolume)
    player: (name) => {
      const rec = tiles.get(name);
      if(!rec || !rec.player) return null;
      try{ return { ready: rec.ready, muted: rec.player.getMuted(), volume: rec.player.getVolume() }; }
      catch(e){ return { ready: rec.ready, error: String(e) }; }
    }
  });

  init();
})();
