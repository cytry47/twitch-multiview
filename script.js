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

  // Dominio actual, exigido por Twitch como parámetro "parent" en los
  // embeds. Si la página corriera desde un archivo local (file://) o sin
  // hostname, usamos "localhost" como fallback razonable para pruebas.
  const PARENT = window.location.hostname || "localhost";

  /* =====================================================================
     ESTADO
     ===================================================================== */
  // channels: [{ name: "algunusuario", chatOpen: true|false }]
  let channels = loadChannels();

  // Estado de autenticación — SOLO EN MEMORIA, nunca en localStorage.
  let authToken = null;
  let authUsername = null;
  let ircSocket = null;
  let ircConnected = false;

  /* =====================================================================
     PERSISTENCIA (solo lista de canales, nunca el token)
     ===================================================================== */
  function loadChannels(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return [];
      const parsed = JSON.parse(raw);
      if(!Array.isArray(parsed)) return [];
      return parsed
        .filter(c => c && typeof c.name === "string")
        .map(c => ({ name: c.name.toLowerCase(), chatOpen: !!c.chatOpen }));
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

  /* =====================================================================
     VALIDACIÓN DE NOMBRES DE CANAL
     ===================================================================== */
  const CHANNEL_RE = /^[a-zA-Z0-9_]{2,25}$/;

  function normalizeChannelName(raw){
    return raw.trim().replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "").replace(/\/.*$/, "").toLowerCase();
  }

  /* =====================================================================
     RENDER: GRID / LAYOUT
     ===================================================================== */
  function updateGridLayout(){
    const n = channels.length;
    if(n === 0){
      grid.style.display = "none";
      emptyState.style.display = "block";
      return;
    }
    grid.style.display = "grid";
    emptyState.style.display = "none";

    const narrow = window.innerWidth < 700;
    let cols;
    if(narrow){
      cols = 1;
    }else{
      cols = Math.ceil(Math.sqrt(n));
    }
    const rows = Math.ceil(n / cols);

    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  }

  window.addEventListener("resize", updateGridLayout);

  /* =====================================================================
     RENDER: TILES
     ===================================================================== */
  function renderChannels(){
    grid.innerHTML = "";

    channels.forEach(ch => {
      grid.appendChild(buildTile(ch));
    });

    updateGridLayout();
    updateAllChatInputsState();
  }

  function buildTile(ch){
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.dataset.channel = ch.name;

    // header
    const header = document.createElement("div");
    header.className = "tile-header";

    const nameEl = document.createElement("div");
    nameEl.className = "channel-name";
    nameEl.textContent = ch.name;
    nameEl.title = ch.name;

    const chatToggle = document.createElement("button");
    chatToggle.className = "icon-btn" + (ch.chatOpen ? " active" : "");
    chatToggle.title = "Mostrar / ocultar chat";
    chatToggle.textContent = "💬";
    chatToggle.addEventListener("click", () => {
      ch.chatOpen = !ch.chatOpen;
      saveChannels();
      chatToggle.classList.toggle("active", ch.chatOpen);
      chatPanel.classList.toggle("hidden", !ch.chatOpen);
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "icon-btn remove";
    removeBtn.title = "Quitar canal";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => removeChannel(ch.name));

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

    const chatPanel = document.createElement("div");
    chatPanel.className = "chat-panel" + (ch.chatOpen ? "" : " hidden");

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

    body.appendChild(videoWrap);
    body.appendChild(chatPanel);

    tile.appendChild(header);
    tile.appendChild(body);

    // guardar refs para poder actualizar estado de auth luego
    tile._sendInput = sendInput;
    tile._sendBtn = sendBtn;

    return tile;
  }

  function updateAllChatInputsState(){
    const inputs = grid.querySelectorAll('[data-role="chat-input"]');
    const btns = grid.querySelectorAll('[data-role="chat-send-btn"]');
    inputs.forEach(inp => {
      inp.disabled = !authToken;
      inp.placeholder = authToken ? "Enviar mensaje…" : "Inicia sesión para chatear";
    });
    btns.forEach(b => { b.disabled = !authToken; });
  }

  /* =====================================================================
     AGREGAR / QUITAR CANALES
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

    channels.push({ name, chatOpen: false });
    saveChannels();
    renderChannels();
    channelInput.value = "";

    if(ircConnected) ircJoin(name);
  });

  function removeChannel(name){
    channels = channels.filter(c => c.name !== name);
    saveChannels();
    renderChannels();
    if(ircConnected) ircPart(name);
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
     IRC sobre WebSocket (para enviar mensajes de chat autenticados)
     ===================================================================== */
  function connectIrc(){
    if(!authToken || !authUsername) return;
    closeIrc();

    ircSocket = new WebSocket("wss://irc-ws.chat.twitch.tv:443");

    ircSocket.addEventListener("open", () => {
      ircSocket.send("PASS oauth:" + authToken);
      ircSocket.send("NICK " + authUsername);
      ircSocket.send("CAP REQ :twitch.tv/commands twitch.tv/tags");
      channels.forEach(c => ircJoin(c.name));
    });

    ircSocket.addEventListener("message", (event) => {
      const lines = event.data.split("\r\n").filter(Boolean);
      lines.forEach(line => {
        if(line.startsWith("PING")){
          ircSocket.send("PONG :tmi.twitch.tv");
        }
        if(line.includes("Login authentication failed") || line.includes("Improperly formatted auth")){
          console.error("Falló la autenticación IRC:", line);
        }
        if(/\s001\s/.test(line)){
          ircConnected = true;
        }
      });
    });

    ircSocket.addEventListener("close", () => {
      ircConnected = false;
    });

    ircSocket.addEventListener("error", (err) => {
      console.error("Error de WebSocket IRC:", err);
      ircConnected = false;
    });
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
    renderChannels();
  }

  init();
})();
