(function(){
  "use strict";

  /* =====================================================================
     CONFIGURACIÓN — editar estas dos constantes con tus propios datos
     de la app registrada en https://dev.twitch.tv/console

     - CLIENT_ID: el Client ID de tu app de Twitch.
     - REDIRECT_URI: debe ser EXACTAMENTE igual (incluyendo protocolo,
       sin barra final si no la pusiste al registrar) a la URL donde
       vas a servir esta página en GitHub Pages, por ejemplo:
       "https://tu-usuario.github.io/tu-repo/"
       y tiene que estar dada de alta tal cual en el panel de Twitch
       en "OAuth Redirect URLs".
     ===================================================================== */
  const CLIENT_ID = "m13brzygevbk4qrnhg32eimd6awkvc";
  const REDIRECT_URI = window.location.origin + window.location.pathname;

  const OAUTH_SCOPES = "chat:read chat:edit";
  const STORAGE_KEY = "twitch-multiview.channels";
  const LAYOUT_KEY_PREFIX = "twitch-multiview.layout.";
  const SHARED_MODE_KEY = "twitch-multiview.sharedChatMode";
  const SHARED_ACTIVE_KEY = "twitch-multiview.sharedChatActive";
  const UNIFIED_MODE_KEY = "twitch-multiview.unifiedChatMode";
  const DEFAULT_SHARED_CHAT_WIDTH = 340;
  const DEFAULT_SHARED_CHAT_HEIGHT_MOBILE = 260;

  const DEFAULT_CHAT_WIDTH = 300;   // px, panel de chat cuando el video y el chat están lado a lado
  const DEFAULT_CHAT_HEIGHT = 240;  // px, panel de chat cuando están apilados (pantallas angostas)
  const NARROW_BREAKPOINT = 700;    // px

  // Dominio actual, exigido por Twitch como parámetro "parent" en los
  // embeds. Si la página corriera desde un archivo local (file://) o sin
  // hostname, usamos "localhost" como fallback razonable para pruebas.
  const PARENT = window.location.hostname || "localhost";

  /* =====================================================================
     ESTADO
     ===================================================================== */
  // channels: [{ name, chatOpen, chatWidth, chatHeightMobile }]
  let channels = loadChannels();

  // Preferencias de layout — se guardan por resolución de pantalla, así
  // que cada monitor (ej. 1080p vs 1440p) recuerda su propio acomodo.
  let layoutPrefs = loadLayoutPrefs();

  // Chat compartido: se ve el chat NATIVO de Twitch (iframe) de un canal
  // a la vez —así se ven bien los emotes, badges y menciones—, y se
  // cambia de canal con el selector. El envío sí puede ir a varios
  // canales a la vez (eso no depende del iframe, va por IRC).
  let sharedChatMode = loadSharedChatMode();
  let sharedChatActive = null;
  try{ sharedChatActive = localStorage.getItem(SHARED_ACTIVE_KEY) || null; }catch(e){ sharedChatActive = null; }

  // A cuáles canales se les manda el mensaje al escribir en el chat
  // compartido. Vive solo en memoria y arranca con todos los canales.
  let sendTargets = new Set(channels.map(c => c.name));

  // Chat unificado: una tile OPCIONAL dentro del grid (independiente del
  // panel de chat compartido de arriba) que muestra un único feed con los
  // mensajes de todos los canales mezclados, leídos por IRC. Convive con
  // el chat compartido — ambos pueden estar activos a la vez.
  let unifiedChatMode = loadUnifiedChatMode();

  // Qué canales se muestran en el feed unificado (filtro de lectura) y a
  // cuáles se les manda el mensaje al escribir ahí (destino de envío).
  // Ambos viven solo en memoria y son independientes de "sendTargets".
  let unifiedVisibleChannels = new Set(channels.map(c => c.name));
  let unifiedSendTargets = new Set(channels.map(c => c.name));

  // Mensajes recibidos por IRC, mezclados de todos los canales.
  let chatMessages = [];
  let msgIdCounter = 0;
  const MAX_MESSAGES = 300;

  // Referencias a los elementos vivos de la tile de chat unificado (se
  // reasignan cada vez que se reconstruye el grid en renderChannels()).
  let unifiedChatMessagesEl = null;
  let unifiedChatSendInputEl = null;
  let unifiedChatSendBtnEl = null;

  const CHANNEL_PALETTE = ["#f2a93b","#5aa9e6","#7ed6a5","#e07be0","#ff8a65","#8d9eff","#ffd54f","#4dd0e1"];
  function channelColor(name){
    let hash = 0;
    for(let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return CHANNEL_PALETTE[hash % CHANNEL_PALETTE.length];
  }

  // Estado de autenticación — SOLO EN MEMORIA, nunca en localStorage.
  let authToken = null;
  let authUsername = null;
  let ircSocket = null;
  let ircConnected = false;

  /* =====================================================================
     PERSISTENCIA — canales (nunca el token)
     ===================================================================== */
  function loadChannels(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return [];
      const parsed = JSON.parse(raw);
      if(!Array.isArray(parsed)) return [];
      return parsed
        .filter(c => c && typeof c.name === "string")
        .map(c => ({
          name: c.name.toLowerCase(),
          chatOpen: !!c.chatOpen,
          chatWidth: typeof c.chatWidth === "number" ? c.chatWidth : null,
          chatHeightMobile: typeof c.chatHeightMobile === "number" ? c.chatHeightMobile : null
        }));
    }catch(e){
      console.warn("No se pudo leer la lista de canales guardada:", e);
      return [];
    }
  }

  function saveChannels(){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify(channels));
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

  function loadLayoutPrefs(){
    const fallback = {
      colsOverride: null,
      colFr: null,
      rowFr: null,
      dimsKey: null,
      chatWidth: DEFAULT_CHAT_WIDTH,
      chatHeightMobile: DEFAULT_CHAT_HEIGHT,
      sharedChatWidth: DEFAULT_SHARED_CHAT_WIDTH,
      sharedChatHeightMobile: DEFAULT_SHARED_CHAT_HEIGHT_MOBILE
    };
    try{
      const raw = localStorage.getItem(LAYOUT_KEY_PREFIX + getScreenKey());
      if(!raw) return fallback;
      const parsed = JSON.parse(raw);
      return {
        colsOverride: (typeof parsed.colsOverride === "number") ? parsed.colsOverride : null,
        colFr: Array.isArray(parsed.colFr) ? parsed.colFr : null,
        rowFr: Array.isArray(parsed.rowFr) ? parsed.rowFr : null,
        dimsKey: parsed.dimsKey || null,
        chatWidth: typeof parsed.chatWidth === "number" ? parsed.chatWidth : DEFAULT_CHAT_WIDTH,
        chatHeightMobile: typeof parsed.chatHeightMobile === "number" ? parsed.chatHeightMobile : DEFAULT_CHAT_HEIGHT,
        sharedChatWidth: typeof parsed.sharedChatWidth === "number" ? parsed.sharedChatWidth : DEFAULT_SHARED_CHAT_WIDTH,
        sharedChatHeightMobile: typeof parsed.sharedChatHeightMobile === "number" ? parsed.sharedChatHeightMobile : DEFAULT_SHARED_CHAT_HEIGHT_MOBILE
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

  function loadSharedChatMode(){
    try{ return localStorage.getItem(SHARED_MODE_KEY) === "1"; }
    catch(e){ return false; }
  }
  function saveSharedChatMode(){
    try{ localStorage.setItem(SHARED_MODE_KEY, sharedChatMode ? "1" : "0"); }
    catch(e){ /* noop */ }
  }
  function saveSharedChatActive(){
    try{
      if(sharedChatActive) localStorage.setItem(SHARED_ACTIVE_KEY, sharedChatActive);
      else localStorage.removeItem(SHARED_ACTIVE_KEY);
    }catch(e){ /* noop */ }
  }
  function loadUnifiedChatMode(){
    try{ return localStorage.getItem(UNIFIED_MODE_KEY) === "1"; }
    catch(e){ return false; }
  }
  function saveUnifiedChatMode(){
    try{ localStorage.setItem(UNIFIED_MODE_KEY, unifiedChatMode ? "1" : "0"); }
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

  const sharedChatToggleBtn = document.getElementById("shared-chat-toggle");
  const unifiedChatToggleBtn = document.getElementById("unified-chat-toggle");
  const sharedChatEl = document.getElementById("shared-chat");
  const sharedChatResizerEl = document.getElementById("shared-chat-resizer");
  const sharedChatSelectEl = document.getElementById("shared-chat-select");
  const sharedChatFrameWrapEl = document.getElementById("shared-chat-frame-wrap");
  const sharedChatTargetsEl = document.getElementById("shared-chat-targets");
  const sharedChatSendForm = document.getElementById("shared-chat-send-form");
  const sharedChatInput = document.getElementById("shared-chat-input");

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
    grid.style.gridTemplateColumns = layoutPrefs.colFr.map(f => f.toFixed(4) + "fr").join(" ");
    grid.style.gridTemplateRows = layoutPrefs.rowFr.map(f => f.toFixed(4) + "fr").join(" ");
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
    // la tile de chat unificado cuenta como una tile más para el cálculo
    // de columnas/filas del grid, igual que un canal cualquiera.
    const n = channels.length + (unifiedChatMode && channels.length > 0 ? 1 : 0);
    clearGridHandles();

    if(channels.length === 0){
      grid.style.display = "none";
      emptyState.style.display = "block";
      return;
    }
    grid.style.display = "grid";
    emptyState.style.display = "none";

    const dims = getGridDims(n);

    if(dims.narrow){
      grid.style.gridTemplateColumns = "1fr";
      grid.style.gridTemplateRows = `repeat(${n}, minmax(240px, 1fr))`;
      return;
    }

    ensureFrArrays(dims);
    applyGridTemplate(dims);
    requestAnimationFrame(() => positionGridHandles(dims));
  }

  window.addEventListener("resize", () => {
    updateGridLayout();
    if(sharedChatMode) applySharedChatWidth();
  });

  /* =====================================================================
     CHAT COMPARTIDO
     ===================================================================== */
  function applySharedChatWidth(){
    if(isNarrow()){
      sharedChatEl.style.width = "";
      sharedChatEl.style.height = (layoutPrefs.sharedChatHeightMobile || DEFAULT_SHARED_CHAT_HEIGHT_MOBILE) + "px";
    }else{
      sharedChatEl.style.height = "";
      sharedChatEl.style.width = (layoutPrefs.sharedChatWidth || DEFAULT_SHARED_CHAT_WIDTH) + "px";
    }
  }

  /* ---- dropdown reutilizable con checkboxes (filtro de lectura / destino de envío) ---- */
  function closeDropdowns(){
    document.querySelectorAll(".chat-dropdown-menu").forEach(m => { m.hidden = true; });
    document.querySelectorAll(".chat-dropdown-btn").forEach(b => b.classList.remove("open"));
  }
  document.addEventListener("click", closeDropdowns);

  function summaryLabel(selectedSet, total){
    if(total === 0) return "—";
    if(selectedSet.size === 0) return "Ninguno";
    if(selectedSet.size === total) return "Todos";
    if(selectedSet.size === 1) return [...selectedSet][0];
    return selectedSet.size + " canales";
  }

  function buildDropdown(containerEl, label, selectedSet, onChange){
    containerEl.innerHTML = "";
    if(channels.length === 0) return;

    const wrap = document.createElement("div");
    wrap.className = "chat-dropdown";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-dropdown-btn";

    const btnLabel = document.createElement("span");
    btnLabel.className = "dd-label";
    btnLabel.textContent = label + ":";

    const btnValue = document.createElement("span");
    btnValue.className = "dd-value";
    btnValue.textContent = summaryLabel(selectedSet, channels.length);

    const caret = document.createElement("span");
    caret.className = "dd-caret";
    caret.textContent = "▾";

    btn.appendChild(btnLabel);
    btn.appendChild(btnValue);
    btn.appendChild(caret);

    const menu = document.createElement("div");
    menu.className = "chat-dropdown-menu";
    menu.hidden = true;
    menu.addEventListener("click", e => e.stopPropagation());

    function syncAllCheckbox(){
      allCb.checked = selectedSet.size === channels.length;
      allCb.indeterminate = selectedSet.size > 0 && selectedSet.size < channels.length;
    }

    const allRow = document.createElement("label");
    allRow.className = "dropdown-item dropdown-item-all";
    const allCb = document.createElement("input");
    allCb.type = "checkbox";
    allCb.addEventListener("change", () => {
      if(allCb.checked) channels.forEach(c => selectedSet.add(c.name));
      else selectedSet.clear();
      menu.querySelectorAll("input[data-channel]").forEach(cb => {
        cb.checked = selectedSet.has(cb.dataset.channel);
      });
      btnValue.textContent = summaryLabel(selectedSet, channels.length);
      onChange();
    });
    allRow.appendChild(allCb);
    allRow.appendChild(document.createTextNode("Todos"));
    menu.appendChild(allRow);

    channels.forEach(ch => {
      const row = document.createElement("label");
      row.className = "dropdown-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.channel = ch.name;
      cb.checked = selectedSet.has(ch.name);
      cb.addEventListener("change", () => {
        if(cb.checked) selectedSet.add(ch.name);
        else selectedSet.delete(ch.name);
        syncAllCheckbox();
        btnValue.textContent = summaryLabel(selectedSet, channels.length);
        onChange();
      });
      const dot = document.createElement("span");
      dot.className = "dd-dot";
      dot.style.background = channelColor(ch.name);
      row.appendChild(cb);
      row.appendChild(dot);
      row.appendChild(document.createTextNode(ch.name));
      menu.appendChild(row);
    });

    syncAllCheckbox();

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = menu.hidden;
      closeDropdowns();
      if(willOpen){
        menu.hidden = false;
        btn.classList.add("open");
      }
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    containerEl.appendChild(wrap);
  }

  /* ---- selector de un solo canal (cuál chat NATIVO se muestra) ---- */
  function buildSingleSelectDropdown(containerEl, label, getActive, setActive, onChange){
    containerEl.innerHTML = "";
    if(channels.length === 0) return;

    const wrap = document.createElement("div");
    wrap.className = "chat-dropdown";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-dropdown-btn";

    const btnLabel = document.createElement("span");
    btnLabel.className = "dd-label";
    btnLabel.textContent = label + ":";

    const btnValue = document.createElement("span");
    btnValue.className = "dd-value";
    btnValue.textContent = getActive() || "—";

    const caret = document.createElement("span");
    caret.className = "dd-caret";
    caret.textContent = "▾";

    btn.appendChild(btnLabel);
    btn.appendChild(btnValue);
    btn.appendChild(caret);

    const menu = document.createElement("div");
    menu.className = "chat-dropdown-menu";
    menu.hidden = true;
    menu.addEventListener("click", e => e.stopPropagation());

    channels.forEach(ch => {
      const row = document.createElement("label");
      row.className = "dropdown-item";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "shared-chat-active-channel";
      radio.checked = getActive() === ch.name;
      radio.addEventListener("change", () => {
        setActive(ch.name);
        btnValue.textContent = ch.name;
        closeDropdowns();
        onChange();
      });
      const dot = document.createElement("span");
      dot.className = "dd-dot";
      dot.style.background = channelColor(ch.name);
      row.appendChild(radio);
      row.appendChild(dot);
      row.appendChild(document.createTextNode(ch.name));
      menu.appendChild(row);
    });

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = menu.hidden;
      closeDropdowns();
      if(willOpen){
        menu.hidden = false;
        btn.classList.add("open");
      }
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    containerEl.appendChild(wrap);
  }

  function renderChannelSelect(){
    if(channels.length === 0){
      sharedChatSelectEl.innerHTML = "";
      return;
    }
    if(!sharedChatActive || !channels.some(c => c.name === sharedChatActive)){
      sharedChatActive = channels[0].name;
      saveSharedChatActive();
    }
    buildSingleSelectDropdown(
      sharedChatSelectEl,
      "Canal",
      () => sharedChatActive,
      (name) => {
        sharedChatActive = name;
        saveSharedChatActive();
        grid.querySelectorAll('[data-role="chat-toggle"]').forEach(b => {
          b.classList.toggle("active", b.dataset.channel === sharedChatActive);
        });
      },
      renderSharedChatFrame
    );
  }

  function renderSharedChatFrame(){
    sharedChatFrameWrapEl.innerHTML = "";
    if(channels.length === 0){
      const empty = document.createElement("div");
      empty.id = "shared-chat-empty";
      empty.textContent = "Agregá un canal para ver su chat acá.";
      sharedChatFrameWrapEl.appendChild(empty);
      return;
    }
    if(!sharedChatActive) return;
    const iframe = document.createElement("iframe");
    iframe.src = `https://www.twitch.tv/embed/${encodeURIComponent(sharedChatActive)}/chat?parent=${encodeURIComponent(PARENT)}&darkpopout`;
    sharedChatFrameWrapEl.appendChild(iframe);
  }

  function renderChatTargets(){
    buildDropdown(sharedChatTargetsEl, "Enviar a", sendTargets, () => {
      updateAllChatInputsState();
    });
  }

  function renderSharedChatPanel(){
    renderChannelSelect();
    renderSharedChatFrame();
    renderChatTargets();
  }

  /* =====================================================================
     CHAT UNIFICADO (tile opcional dentro del grid)
     ===================================================================== */
  function isUnifiedFeedScrolledToBottom(){
    if(!unifiedChatMessagesEl) return true;
    const el = unifiedChatMessagesEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }
  function scrollUnifiedFeedToBottom(){
    if(unifiedChatMessagesEl) unifiedChatMessagesEl.scrollTop = unifiedChatMessagesEl.scrollHeight;
  }

  function buildUnifiedMessageEl(m){
    const div = document.createElement("div");
    div.className = "chat-msg";

    const chanTag = document.createElement("span");
    chanTag.className = "msg-channel";
    chanTag.textContent = m.channel;
    chanTag.style.background = channelColor(m.channel);

    const userSpan = document.createElement("span");
    userSpan.className = "msg-user";
    userSpan.textContent = m.user;
    if(m.color) userSpan.style.color = m.color;

    const textSpan = document.createElement("span");
    textSpan.className = "msg-text";
    textSpan.textContent = ": " + m.text;

    div.appendChild(chanTag);
    div.appendChild(userSpan);
    div.appendChild(textSpan);
    return div;
  }

  function renderUnifiedChatFeed(){
    if(!unifiedChatMessagesEl) return;
    if(channels.length === 0){
      unifiedChatMessagesEl.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "unified-chat-empty";
      empty.textContent = "Agregá un canal para ver sus mensajes acá.";
      unifiedChatMessagesEl.appendChild(empty);
      return;
    }
    const atBottom = isUnifiedFeedScrolledToBottom();
    unifiedChatMessagesEl.innerHTML = "";
    const visible = chatMessages.filter(m => unifiedVisibleChannels.has(m.channel));
    if(visible.length === 0){
      const empty = document.createElement("div");
      empty.className = "unified-chat-empty";
      empty.textContent = "Todavía no hay mensajes para mostrar acá.";
      unifiedChatMessagesEl.appendChild(empty);
      return;
    }
    visible.forEach(m => unifiedChatMessagesEl.appendChild(buildUnifiedMessageEl(m)));
    if(atBottom) scrollUnifiedFeedToBottom();
  }

  function appendUnifiedMessageToFeed(m){
    if(!unifiedChatMessagesEl) return;
    if(!unifiedVisibleChannels.has(m.channel)) return;
    const emptyEl = unifiedChatMessagesEl.querySelector(".unified-chat-empty");
    if(emptyEl) unifiedChatMessagesEl.innerHTML = "";
    const atBottom = isUnifiedFeedScrolledToBottom();
    unifiedChatMessagesEl.appendChild(buildUnifiedMessageEl(m));
    while(unifiedChatMessagesEl.children.length > MAX_MESSAGES){
      unifiedChatMessagesEl.removeChild(unifiedChatMessagesEl.firstChild);
    }
    if(atBottom) scrollUnifiedFeedToBottom();
  }

  /* ---- construcción de la tile que se agrega al grid ---- */
  function buildUnifiedChatTile(){
    const tile = document.createElement("div");
    tile.className = "tile unified-chat-tile";

    const header = document.createElement("div");
    header.className = "tile-header";

    const nameEl = document.createElement("div");
    nameEl.className = "tile-title";
    nameEl.textContent = "🧩 Chat unificado";
    nameEl.title = "Mensajes combinados de todos los canales";

    const closeBtn = document.createElement("button");
    closeBtn.className = "icon-btn remove";
    closeBtn.title = "Cerrar chat unificado";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => {
      unifiedChatMode = false;
      saveUnifiedChatMode();
      unifiedChatToggleBtn.classList.remove("active");
      if(!authToken) closeIrc();
      renderChannels();
    });

    header.appendChild(nameEl);
    header.appendChild(closeBtn);

    const body = document.createElement("div");
    body.className = "tile-body unified-chat-body";

    const filtersRow = document.createElement("div");
    filtersRow.className = "chat-dropdown-row unified-row-top";

    const messagesEl = document.createElement("div");
    messagesEl.className = "unified-chat-messages";

    const targetsRow = document.createElement("div");
    targetsRow.className = "chat-dropdown-row unified-row-bottom";

    const sendForm = document.createElement("form");
    sendForm.className = "chat-send-form";
    const sendInput = document.createElement("input");
    sendInput.type = "text";
    sendInput.maxLength = 500;
    const sendBtn = document.createElement("button");
    sendBtn.type = "submit";
    sendBtn.textContent = "➤";
    sendForm.appendChild(sendInput);
    sendForm.appendChild(sendBtn);

    sendForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = sendInput.value.trim();
      if(!text || unifiedSendTargets.size === 0) return;
      let anyOk = false;
      unifiedSendTargets.forEach(name => { if(sendChatMessage(name, text)) anyOk = true; });
      if(anyOk) sendInput.value = "";
    });

    body.appendChild(filtersRow);
    body.appendChild(messagesEl);
    body.appendChild(targetsRow);
    body.appendChild(sendForm);

    tile.appendChild(header);
    tile.appendChild(body);

    // referencias vivas, usadas por addChatMessage() y updateAllChatInputsState()
    unifiedChatMessagesEl = messagesEl;
    unifiedChatSendInputEl = sendInput;
    unifiedChatSendBtnEl = sendBtn;

    buildDropdown(filtersRow, "Mostrar", unifiedVisibleChannels, () => {
      renderUnifiedChatFeed();
    });
    buildDropdown(targetsRow, "Enviar a", unifiedSendTargets, () => {
      updateAllChatInputsState();
    });

    renderUnifiedChatFeed();

    return tile;
  }

  function applySharedChatMode(){
    sharedChatToggleBtn.classList.toggle("active", sharedChatMode);
    sharedChatEl.hidden = !sharedChatMode;
    sharedChatResizerEl.hidden = !sharedChatMode;
    applySharedChatWidth();
    renderChannels();
  }

  sharedChatToggleBtn.addEventListener("click", () => {
    sharedChatMode = !sharedChatMode;
    saveSharedChatMode();
    applySharedChatMode();
  });

  unifiedChatToggleBtn.addEventListener("click", () => {
    unifiedChatMode = !unifiedChatMode;
    saveUnifiedChatMode();
    unifiedChatToggleBtn.classList.toggle("active", unifiedChatMode);
    if(unifiedChatMode){
      channels.forEach(c => { unifiedVisibleChannels.add(c.name); unifiedSendTargets.add(c.name); });
      connectIrc();
    }else if(!authToken){
      closeIrc();
    }
    renderChannels();
  });

  sharedChatSendForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = sharedChatInput.value.trim();
    if(!text || sendTargets.size === 0) return;
    let anyOk = false;
    sendTargets.forEach(name => { if(sendChatMessage(name, text)) anyOk = true; });
    if(anyOk) sharedChatInput.value = "";
  });

  sharedChatResizerEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const narrow = isNarrow();
    const startX = e.clientX;
    const startY = e.clientY;
    const rect = sharedChatEl.getBoundingClientRect();
    const startWidth = rect.width;
    const startHeight = rect.height;

    sharedChatResizerEl.classList.add("dragging");
    beginDrag(narrow ? "row-resize" : "col-resize");

    function onMove(ev){
      if(narrow){
        const dy = startY - ev.clientY;
        let h = startHeight + dy;
        h = Math.max(140, Math.min(h, Math.round(window.innerHeight * 0.75)));
        sharedChatEl.style.height = h + "px";
        layoutPrefs.sharedChatHeightMobile = h;
      }else{
        const dx = startX - ev.clientX;
        let w = startWidth + dx;
        w = Math.max(220, Math.min(w, 700));
        sharedChatEl.style.width = w + "px";
        layoutPrefs.sharedChatWidth = w;
      }
    }
    function onUp(){
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      sharedChatResizerEl.classList.remove("dragging");
      endDrag();
      saveLayoutPrefs();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

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
    layoutPrefs = {
      colsOverride: null,
      colFr: null,
      rowFr: null,
      dimsKey: null,
      chatWidth: DEFAULT_CHAT_WIDTH,
      chatHeightMobile: DEFAULT_CHAT_HEIGHT,
      sharedChatWidth: DEFAULT_SHARED_CHAT_WIDTH,
      sharedChatHeightMobile: DEFAULT_SHARED_CHAT_HEIGHT_MOBILE
    };
    channels.forEach(c => { c.chatWidth = null; c.chatHeightMobile = null; });
    syncColsSelect();
    saveLayoutPrefs();
    saveChannels();
    applySharedChatWidth();
    renderChannels();
  });

  /* =====================================================================
     RENDER: TILES
     ===================================================================== */
  function renderChannels(){
    grid.innerHTML = "";
    unifiedChatMessagesEl = null;
    unifiedChatSendInputEl = null;
    unifiedChatSendBtnEl = null;

    channels.forEach(ch => {
      grid.appendChild(buildTile(ch));
    });

    if(unifiedChatMode && channels.length > 0){
      grid.appendChild(buildUnifiedChatTile());
    }

    updateGridLayout();
    updateAllChatInputsState();
    if(sharedChatMode) renderSharedChatPanel();
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

    const nameEl = document.createElement("div");
    nameEl.className = "channel-name";
    nameEl.textContent = ch.name;
    nameEl.title = ch.name;

    const chatToggle = document.createElement("button");
    const chatToggleIsActive = sharedChatMode ? (sharedChatActive === ch.name) : ch.chatOpen;
    chatToggle.className = "icon-btn" + (chatToggleIsActive ? " active" : "");
    chatToggle.title = sharedChatMode ? "Ver el chat de este canal en el panel compartido" : "Mostrar / ocultar chat";
    chatToggle.textContent = "💬";
    chatToggle.dataset.role = "chat-toggle";
    chatToggle.dataset.channel = ch.name;

    const removeBtn = document.createElement("button");
    removeBtn.className = "icon-btn remove";
    removeBtn.title = "Quitar canal";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => removeChannel(ch.name));

    header.appendChild(dragHandle);
    header.appendChild(nameEl);
    header.appendChild(chatToggle);
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

    // divisor arrastrable entre video y chat
    const showOwnChat = !sharedChatMode && ch.chatOpen;

    const resizer = document.createElement("div");
    resizer.className = "tile-resizer";
    resizer.hidden = !showOwnChat;

    const chatPanel = document.createElement("div");
    chatPanel.className = "chat-panel" + (showOwnChat ? "" : " hidden");
    applyChatSize(ch, chatPanel);

    const chatFrame = document.createElement("iframe");
    chatFrame.src = `https://www.twitch.tv/embed/${encodeURIComponent(ch.name)}/chat?parent=${encodeURIComponent(PARENT)}&darkpopout`;
    chatPanel.appendChild(chatFrame);

    const sendForm = document.createElement("form");
    sendForm.className = "chat-send-form";
    const sendInput = document.createElement("input");
    sendInput.type = "text";
    sendInput.maxLength = 500;
    sendInput.dataset.role = "chat-input";
    const sendBtn = document.createElement("button");
    sendBtn.type = "submit";
    sendBtn.textContent = "➤";
    sendBtn.dataset.role = "chat-send-btn";

    sendForm.appendChild(sendInput);
    sendForm.appendChild(sendBtn);
    sendForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = sendInput.value.trim();
      if(!text) return;
      const ok = sendChatMessage(ch.name, text);
      if(ok) sendInput.value = "";
    });

    chatPanel.appendChild(sendForm);

    chatToggle.addEventListener("click", () => {
      if(sharedChatMode){
        sharedChatActive = ch.name;
        saveSharedChatActive();
        renderChannelSelect();
        renderSharedChatFrame();
        grid.querySelectorAll('[data-role="chat-toggle"]').forEach(b => {
          b.classList.toggle("active", b.dataset.channel === sharedChatActive);
        });
        return;
      }
      ch.chatOpen = !ch.chatOpen;
      saveChannels();
      chatToggle.classList.toggle("active", ch.chatOpen);
      chatPanel.classList.toggle("hidden", !ch.chatOpen);
      resizer.hidden = !ch.chatOpen;
    });

    attachChatResizer(resizer, ch, chatPanel);

    body.appendChild(videoWrap);
    body.appendChild(resizer);
    body.appendChild(chatPanel);

    tile.appendChild(header);
    tile.appendChild(body);

    return tile;
  }

  function applyChatSize(ch, chatPanel){
    if(isNarrow()){
      const h = ch.chatHeightMobile || layoutPrefs.chatHeightMobile || DEFAULT_CHAT_HEIGHT;
      chatPanel.style.height = h + "px";
      chatPanel.style.width = "";
    }else{
      const w = ch.chatWidth || layoutPrefs.chatWidth || DEFAULT_CHAT_WIDTH;
      chatPanel.style.width = w + "px";
      chatPanel.style.height = "";
    }
  }

  /* ---- arrastrar para cambiar el tamaño del chat vs. el video ---- */
  function attachChatResizer(resizerEl, ch, chatPanel){
    resizerEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const narrow = isNarrow();
      const startX = e.clientX;
      const startY = e.clientY;
      const startRect = chatPanel.getBoundingClientRect();
      const startWidth = startRect.width;
      const startHeight = startRect.height;

      resizerEl.classList.add("dragging");
      beginDrag(narrow ? "row-resize" : "col-resize");

      function onMove(ev){
        if(narrow){
          const dy = startY - ev.clientY; // arrastrar hacia arriba agranda el chat
          let h = startHeight + dy;
          h = Math.max(120, Math.min(h, Math.round(window.innerHeight * 0.7)));
          chatPanel.style.height = h + "px";
          ch.chatHeightMobile = h;
        }else{
          const dx = startX - ev.clientX; // arrastrar hacia la izquierda agranda el chat
          let w = startWidth + dx;
          w = Math.max(180, Math.min(w, 700));
          chatPanel.style.width = w + "px";
          ch.chatWidth = w;
        }
      }
      function onUp(){
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        resizerEl.classList.remove("dragging");
        endDrag();
        // recordar el último tamaño usado como default para canales nuevos
        if(narrow){
          layoutPrefs.chatHeightMobile = ch.chatHeightMobile;
        }else{
          layoutPrefs.chatWidth = ch.chatWidth;
        }
        saveLayoutPrefs();
        saveChannels();
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function updateAllChatInputsState(){
    const inputs = grid.querySelectorAll('[data-role="chat-input"]');
    const btns = grid.querySelectorAll('[data-role="chat-send-btn"]');
    inputs.forEach(inp => {
      inp.disabled = !authToken;
      inp.placeholder = authToken ? "Enviar mensaje…" : "Inicia sesión para chatear";
    });
    btns.forEach(b => { b.disabled = !authToken; });

    const noTargets = sendTargets.size === 0;
    sharedChatInput.disabled = !authToken || noTargets;
    sharedChatInput.placeholder = !authToken
      ? "Inicia sesión para chatear"
      : (noTargets ? "Elegí a quién enviar arriba…" : "Enviar mensaje…");
    const sharedSendBtn = sharedChatSendForm.querySelector("button");
    if(sharedSendBtn) sharedSendBtn.disabled = !authToken || noTargets;

    if(unifiedChatSendInputEl){
      const noUnifiedTargets = unifiedSendTargets.size === 0;
      unifiedChatSendInputEl.disabled = !authToken || noUnifiedTargets;
      unifiedChatSendInputEl.placeholder = !authToken
        ? "Inicia sesión para chatear"
        : (noUnifiedTargets ? "Elegí a quién enviar arriba…" : "Enviar mensaje…");
      if(unifiedChatSendBtnEl) unifiedChatSendBtnEl.disabled = !authToken || noUnifiedTargets;
    }
  }

  /* =====================================================================
     AGREGAR / QUITAR / REORDENAR CANALES
     ===================================================================== */
  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    addError.textContent = "";

    const name = normalizeChannelName(channelInput.value);
    if(!name){
      addError.textContent = "Escribí un nombre de canal.";
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

    channels.push({ name, chatOpen: false, chatWidth: null, chatHeightMobile: null });
    sendTargets.add(name);
    unifiedVisibleChannels.add(name);
    unifiedSendTargets.add(name);
    saveChannels();
    renderChannels();
    channelInput.value = "";

    if(ircSocket && (ircConnected || ircSocket.readyState === WebSocket.CONNECTING)){
      if(ircConnected) ircJoin(name);
      // si todavía se está conectando, el handler "open" une a todos los
      // canales presentes en ese momento, así que no hace falta nada más.
    }else if(authToken || unifiedChatMode){
      connectIrc();
    }
  });

  function removeChannel(name){
    channels = channels.filter(c => c.name !== name);
    sendTargets.delete(name);
    unifiedVisibleChannels.delete(name);
    unifiedSendTargets.delete(name);
    chatMessages = chatMessages.filter(m => m.channel !== name);
    if(sharedChatActive === name){
      sharedChatActive = channels.length ? channels[0].name : null;
      saveSharedChatActive();
    }
    saveChannels();
    renderChannels();
    if(ircConnected) ircPart(name);
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
     ===================================================================== */
  function buildAuthorizeUrl(){
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "token",
      scope: OAUTH_SCOPES
    });
    return `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
  }

  loginBtn.addEventListener("click", () => {
    if(!CLIENT_ID || CLIENT_ID === "TU_CLIENT_ID_AQUI"){
      alert("Todavía no configuraste tu CLIENT_ID. Editá la constante CLIENT_ID al principio de script.js con el Client ID de tu app registrada en dev.twitch.tv/console.");
      return;
    }
    window.location.href = buildAuthorizeUrl();
  });

  logoutBtn.addEventListener("click", () => {
    logout();
  });

  function logout(){
    authToken = null;
    authUsername = null;
    closeIrc();
    // reconectar en modo anónimo: se pierde la capacidad de enviar, pero
    // el chat unificado sigue mostrando los mensajes de los canales.
    if(unifiedChatMode && channels.length > 0) connectIrc();
    refreshAuthUI();
    updateAllChatInputsState();
  }

  function refreshAuthUI(){
    if(authToken && authUsername){
      loginBtn.hidden = true;
      userChip.hidden = false;
      userNameEl.textContent = authUsername;
    }else{
      loginBtn.hidden = false;
      userChip.hidden = true;
    }
  }

  // al cargar: si venimos de la redirección de Twitch, el token llega
  // en el fragmento de la URL (#access_token=...&...)
  function handleOAuthRedirect(){
    if(!window.location.hash) return;
    const hash = window.location.hash.startsWith("#")
      ? window.location.hash.substring(1)
      : window.location.hash;
    const params = new URLSearchParams(hash);
    const token = params.get("access_token");
    if(!token) return;

    authToken = token;

    // limpiar la URL para no dejar el token visible ni persistido
    const cleanUrl = window.location.pathname + window.location.search;
    window.history.replaceState(null, "", cleanUrl);

    fetchAuthenticatedUser();
  }

  function fetchAuthenticatedUser(){
    fetch("https://api.twitch.tv/helix/users", {
      headers: {
        "Authorization": "Bearer " + authToken,
        "Client-Id": CLIENT_ID
      }
    })
    .then(res => {
      if(!res.ok) throw new Error("No se pudo validar el token (" + res.status + ")");
      return res.json();
    })
    .then(data => {
      const user = data && data.data && data.data[0];
      if(!user) throw new Error("Respuesta de usuario vacía");
      authUsername = user.login;
      refreshAuthUI();
      updateAllChatInputsState();
      connectIrc();
    })
    .catch(err => {
      console.error("Error obteniendo el usuario autenticado:", err);
      logout();
    });
  }

  /* =====================================================================
     IRC sobre WebSocket
     ===================================================================== */
  // Con sesión iniciada nos conectamos con el nick real + token, lo que
  // permite enviar mensajes. Si no hay sesión pero el chat unificado está
  // activo, igual nos conectamos con un nick anónimo de solo lectura
  // ("justinfanXXXXX") para poder leer y mezclar los mensajes en el feed
  // — no permite enviar, pero sí ver el chat de todos los canales.
  function connectIrc(){
    const authed = !!(authToken && authUsername);
    if(!authed && !(unifiedChatMode && channels.length > 0)) return;
    closeIrc();

    ircSocket = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    const anon = !authed;
    const nick = anon ? ("justinfan" + Math.floor(10000 + Math.random() * 89999)) : authUsername;

    ircSocket.addEventListener("open", () => {
      if(!anon) ircSocket.send("PASS oauth:" + authToken);
      ircSocket.send("NICK " + nick);
      ircSocket.send("CAP REQ :twitch.tv/commands twitch.tv/tags");
      channels.forEach(c => ircJoin(c.name));
    });

    ircSocket.addEventListener("message", (event) => {
      const lines = event.data.split("\r\n").filter(Boolean);
      lines.forEach(handleIrcLine);
    });

    ircSocket.addEventListener("close", () => {
      ircConnected = false;
    });

    ircSocket.addEventListener("error", (err) => {
      console.error("Error de WebSocket IRC:", err);
      ircConnected = false;
    });
  }

  function parseIrcTags(tagStr){
    const tags = {};
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
    let rest = line;
    let tags = {};

    if(rest.startsWith("@")){
      const sp = rest.indexOf(" ");
      if(sp === -1) return;
      tags = parseIrcTags(rest.slice(1, sp));
      rest = rest.slice(sp + 1);
    }

    if(rest.startsWith("PING")){
      ircSocket.send("PONG :tmi.twitch.tv");
      return;
    }

    const match = rest.match(/^:(\S+)\s+(\S+)\s+(.*)$/);
    if(!match){
      if(/^:tmi\.twitch\.tv 001\b/.test(rest) || /\s001\s/.test(rest)) ircConnected = true;
      return;
    }

    const prefix = match[1];
    const command = match[2];
    const params = match[3];

    if(command === "001"){
      ircConnected = true;
      return;
    }

    if(command === "NOTICE"){
      if(params.includes("Login authentication failed") || params.includes("Improperly formatted")){
        console.error("Falló la autenticación IRC:", params);
      }
      return;
    }

    if(command === "PRIVMSG"){
      const chanMatch = params.match(/^#(\S+)\s+:(.*)$/);
      if(!chanMatch) return;
      const channelName = chanMatch[1];
      const text = chanMatch[2];
      const user = tags["display-name"] || prefix.split("!")[0];
      const color = tags["color"] || "";
      addChatMessage(channelName, user, color, text);
    }
  }

  function addChatMessage(channelName, user, color, text){
    const msg = { id: msgIdCounter++, channel: channelName, user, color, text, ts: Date.now() };
    chatMessages.push(msg);
    if(chatMessages.length > MAX_MESSAGES) chatMessages.shift();
    if(unifiedChatMode) appendUnifiedMessageToFeed(msg);
  }

  function closeIrc(){
    if(ircSocket){
      try{ ircSocket.close(); }catch(e){ /* noop */ }
    }
    ircSocket = null;
    ircConnected = false;
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

  function sendChatMessage(channelName, text){
    if(!authToken){
      return false;
    }
    if(!ircSocket || ircSocket.readyState !== WebSocket.OPEN){
      alert("La conexión de chat todavía no está lista. Probá de nuevo en un segundo.");
      return false;
    }
    const safeText = text.replace(/[\r\n]/g, " ").slice(0, 500);
    ircSocket.send(`PRIVMSG #${channelName} :${safeText}`);
    return true;
  }

  /* =====================================================================
     AVISO SI FALTA CONFIGURAR EL CLIENT ID
     ===================================================================== */
  function checkConfigWarning(){
    if(!CLIENT_ID || CLIENT_ID === "TU_CLIENT_ID_AQUI"){
      authWarning.hidden = false;
      authWarning.innerHTML = `Configurá <code>CLIENT_ID</code> en script.js para poder iniciar sesión.`;
    }
  }

  /* =====================================================================
     INIT
     ===================================================================== */
  function init(){
    checkConfigWarning();
    handleOAuthRedirect();
    refreshAuthUI();
    syncColsSelect();
    sharedChatToggleBtn.classList.toggle("active", sharedChatMode);
    sharedChatEl.hidden = !sharedChatMode;
    sharedChatResizerEl.hidden = !sharedChatMode;
    applySharedChatWidth();
    unifiedChatToggleBtn.classList.toggle("active", unifiedChatMode);
    renderChannels();
    if(unifiedChatMode && channels.length > 0) connectIrc();
  }

  init();
})();
