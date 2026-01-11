export default class PolyModePlugin {
  constructor(api) {
    this.api = api;
    this.activeMode = 'SCULPT'; 
    this.selection = new Set();
    this.topology = null;
    this._originalStart = null;
  }

  init() {
    this._injectStyles();
    this._buildTopBar();
    this._addMenuToSidebar();
    this._patchSculptManager();

    // Usamos pointerdown para máxima compatibilidad con Apple Pencil y dedos
    const canvas = this.api.getCanvas();
    if (canvas) {
      canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e), true);
    }
    
    console.log("PolyMode: Listo. Toca caras para verlas en VERDE.");
  }

  // --- 1. COORDINACIÓN PRECISA PARA IPAD (RETINA) ---
  _getRetinaCoords(e) {
    const main = this.api.main;
    const canvas = main._canvas;
    const rect = canvas.getBoundingClientRect();
    
    // Obtenemos el factor de densidad de píxeles real del dispositivo (2x o 3x en iPad)
    const pr = window.devicePixelRatio || 1.0;

    // Calculamos la posición relativa al canvas en píxeles físicos
    // (clientX es la posición del dedo en la pantalla)
    const x = (e.clientX - rect.left) * pr;
    const y = (e.clientY - rect.top) * pr;

    return { x, y };
  }

  // --- 2. INTERACCIÓN Y SELECCIÓN ---
  _onPointerDown(e) {
    if (this.activeMode === 'SCULPT') return;

    const main = this.api.main;
    const mesh = this.api.getMesh();
    if (!mesh) return;

    // Usamos nuestra nueva función de coordenadas de alta precisión
    const coords = this._getRetinaCoords(e);

    const picking = this.api.getPicking();
    
    // Lanzamos el rayo en la coordenada exacta
    if (picking.intersectionMouse(mesh, coords.x, coords.y)) {
      const faceIdx = picking._idId; // ID del triángulo tocado

      if (this.activeMode === 'FACE') {
        // Lógica de alternar (Toggle)
        if (this.selection.has(faceIdx)) {
          this.selection.delete(faceIdx);
        } else {
          this.selection.add(faceIdx);
        }
      }
      
      // Actualizamos el color a VERDE
      this._updateColorVisuals(mesh);
      
      // Bloqueamos la cámara y el zoom nativos
      e.stopPropagation();
      e.preventDefault();
    }
  }

  // --- 3. VISUALIZACIÓN: PINTAR DE VERDE ---
  _updateColorVisuals(mesh) {
    if (!mesh) return;
    
    const colors = mesh.getColors(); // Array [r, g, b, r, g, b...]
    const faces = mesh.getFaces();
    const nbFaces = mesh.getNbFaces();

    // Color Base: Blanco (o el que prefieras como "no seleccionado")
    // Resetear todo a blanco primero (opcional, si quieres limpiar selección previa visualmente)
    // colors.fill(1.0); 
    // NOTA: Si reseteamos todo aquí, borraremos la pintura previa. 
    // Para este ejemplo, solo pintaremos de verde lo seleccionado y blanco lo deseleccionado.

    // Recorremos la selección para pintar
    // Verde Brillante: R=0, G=1, B=0
    
    // Primero, una pasada rápida para restaurar a blanco lo que YA NO está en la selección
    // (Esto es costoso en mallas gigantes, para optimizar solo iteraríamos cambios, 
    // pero para probar funcionalidad hagámoslo simple: repintar selección)
    
    // Estrategia más segura: Pintar la selección sobre el color actual
    this.selection.forEach(fIdx => {
      const v1 = faces[fIdx * 3];
      const v2 = faces[fIdx * 3 + 1];
      const v3 = faces[fIdx * 3 + 2];

      // Vértice 1
      colors[v1 * 3] = 0.0;     // R
      colors[v1 * 3 + 1] = 1.0; // G (Verde a tope)
      colors[v1 * 3 + 2] = 0.0; // B

      // Vértice 2
      colors[v2 * 3] = 0.0;
      colors[v2 * 3 + 1] = 1.0;
      colors[v2 * 3 + 2] = 0.0;

      // Vértice 3
      colors[v3 * 3] = 0.0;
      colors[v3 * 3 + 1] = 1.0;
      colors[v3 * 3 + 2] = 0.0;
    });

    // Importante: Avisar a SculptGL que actualice los buffers de color en la GPU
    if (mesh.updateColor) mesh.updateColor();
    else if (mesh.updateBuffers) mesh.updateBuffers();
    
    this.api.render();
  }

  // --- 4. PATCH (EL CÓDIGO QUE YA FUNCIONA) ---
  _patchSculptManager() {
    const main = this.api.main;
    const sculptManager = main.getSculptManager();
    if (!this._originalStart) this._originalStart = sculptManager.start.bind(sculptManager);

    sculptManager.start = (elem) => {
      if (this.activeMode !== 'SCULPT') return false;
      return this._originalStart(elem);
    };
  }

  _buildTopBar() {
    if (document.getElementById('pm-toolbar')) return;
    const topBar = document.querySelector('.gui-topbar');
    if (!topBar) return;

    const container = document.createElement('div');
    container.id = 'pm-toolbar';
    container.style = "display: inline-flex; align-items: center; margin-left: 10px; padding-left: 10px; border-left: 1px solid #666; height: 100%;";
    
    this._createBtn(container, 'SCULPT', '🖌️ Sculpt', true);
    this._createBtn(container, 'FACE', '🟩 Face', false);

    topBar.appendChild(container);
  }

  _createBtn(parent, id, label, active) {
    const btn = document.createElement('button');
    btn.id = `pm-btn-${id}`;
    btn.innerText = label;
    btn.className = `pm-btn ${active ? 'active' : ''}`;
    btn.onclick = () => this._setMode(id);
    parent.appendChild(btn);
  }

  _setMode(mode) {
    this.activeMode = mode;
    document.querySelectorAll('.pm-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`pm-btn-${mode}`).classList.add('active');
    
    const main = this.api.main;
    if (mode === 'SCULPT') main.setCanvasCursor('default');
    else main.setCanvasCursor('crosshair');
  }
  
  _addMenuToSidebar() {
    this.api.addGuiAction('PolyMode', 'Limpiar Selección', () => {
      this.selection.clear();
      // Restaurar color blanco (o gris) al limpiar
      const mesh = this.api.getMesh();
      if(mesh) {
          const colors = mesh.getColors();
          colors.fill(1.0); // Rellenar de blanco
          if (mesh.updateColor) mesh.updateColor();
          this.api.render();
      }
    });
  }

  _injectStyles() {
    if (document.getElementById('pm-style')) return;
    const s = document.createElement('style');
    s.id = 'pm-style';
    s.innerHTML = `.pm-btn { background: #222; border: 1px solid #444; color: #aaa; padding: 5px 10px; margin: 0 2px; border-radius: 4px; cursor: pointer; font-weight: bold; } .pm-btn.active { background: #00d000; color: #000; border-color: #00ff00; }`;
    document.head.appendChild(s);
  }
}
