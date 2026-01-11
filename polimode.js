export default class PolyModePlugin {
  constructor(api) {
    this.api = api;
    this.activeMode = 'SCULPT'; 
    this.selection = new Set();
    this.topology = null;
    this._originalStart = null; // Guardaremos la función original aquí
  }

  init() {
    // 1. Interfaz
    this._injectStyles();
    this._buildTopBar();
    this._addMenuToSidebar();

    // 2. EL SECRETO: Sobrescribir el método start() del SculptManager
    this._patchSculptManager();

    // 3. Escuchar clics para nuestra selección
    const canvas = this.api.getCanvas();
    if (canvas) {
      canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e), true);
    }
    
    console.log("PolyMode: Motor de escultura intervenido correctamente.");
  }

  // --- NÚCLEO: INTERVENCIÓN DEL SISTEMA (PATCH) ---
  _patchSculptManager() {
    const main = this.api.main;
    const sculptManager = main.getSculptManager();

    // Guardamos la función original de SculptGL para no romper nada
    if (!this._originalStart) {
      this._originalStart = sculptManager.start.bind(sculptManager);
    }

    // Reemplazamos la función 'start' con nuestra lógica
    sculptManager.start = (elem) => {
      // Si estamos en modo FACE o VERT, PROHIBIMOS que SculptGL arranque
      if (this.activeMode !== 'SCULPT') {
        return false; // "Falso" significa: no esculpas, no hagas nada.
      }
      // Si estamos en modo SCULPT, dejamos pasar la llamada original
      return this._originalStart(elem);
    };
  }

  // --- LÓGICA DE SELECCIÓN (SOLO SI NO ES SCULPT) ---
  _onPointerDown(e) {
    if (this.activeMode === 'SCULPT') return;

    const main = this.api.main;
    const mesh = this.api.getMesh();
    if (!mesh) return;

    // Forzamos a SculptGL a calcular la posición del mouse/dedo
    // Esto es vital en iPad para que coincida el lugar del toque
    if (main.setMousePosition) {
      main.setMousePosition({ 
        pageX: e.pageX, 
        pageY: e.pageY, 
        clientX: e.clientX, 
        clientY: e.clientY 
      });
    }

    // Usamos las coordenadas internas ya calculadas
    const mx = main._mouseX;
    const my = main._mouseY;

    // Ejecutamos el Raycast (Picking)
    const picking = this.api.getPicking();
    if (picking.intersectionMouse(mesh, mx, my)) {
      const faceIdx = picking._idId;

      if (this.activeMode === 'FACE') {
        if (this.selection.has(faceIdx)) {
          this.selection.delete(faceIdx);
        } else {
          this.selection.add(faceIdx);
        }
      }
      
      this._updateVisuals(mesh);
    }
  }

  // --- VISUALIZACIÓN ---
  _updateVisuals(mesh) {
    if (!mesh) return;
    const mask = mesh.getMaskArray();
    const faces = mesh.getFaces();
    
    // Reseteamos y pintamos
    mask.fill(0.0);
    this.selection.forEach(fIdx => {
      mask[faces[fIdx * 3]] = 1.0;
      mask[faces[fIdx * 3 + 1]] = 1.0;
      mask[faces[fIdx * 3 + 2]] = 1.0;
    });

    // Forzamos actualización de buffers gráficos
    mesh.updateGeometry(); 
    this.api.render();
  }

  // --- UI Y ESTILOS ---
  _setMode(mode) {
    this.activeMode = mode;
    
    // Actualizar botones UI
    document.querySelectorAll('.pm-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`pm-btn-${mode}`).classList.add('active');

    // Cambiar cursor para feedback visual
    const main = this.api.main;
    if (mode === 'SCULPT') {
      main.setCanvasCursor('default');
    } else {
      main.setCanvasCursor('crosshair'); 
    }
  }

  _buildTopBar() {
    if (document.getElementById('pm-toolbar')) return;
    const topBar = document.querySelector('.gui-topbar');
    if (!topBar) return;

    const container = document.createElement('div');
    container.id = 'pm-toolbar';
    container.style = "display: inline-flex; align-items: center; margin-left: 10px; padding-left: 10px; border-left: 1px solid #666; height: 100%;";
    
    this._createBtn(container, 'SCULPT', '🖌️ Sculpt', true);
    this._createBtn(container, 'FACE', '🟥 Face', false);

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

  _addMenuToSidebar() {
    this.api.addGuiAction('PolyMode', 'Limpiar Selección', () => {
      this.selection.clear();
      this._updateVisuals(this.api.getMesh());
    });
  }

  _injectStyles() {
    if (document.getElementById('pm-style')) return;
    const s = document.createElement('style');
    s.id = 'pm-style';
    s.innerHTML = `
      .pm-btn { background: #222; border: 1px solid #444; color: #aaa; padding: 5px 10px; margin: 0 2px; border-radius: 4px; cursor: pointer; font-weight: bold; }
      .pm-btn.active { background: #d00; color: white; border-color: #f00; }
    `;
    document.head.appendChild(s);
  }
}
