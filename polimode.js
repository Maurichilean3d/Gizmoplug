export default class PolyModePlugin {
  constructor(api) {
    this.api = api;
    this.activeMode = 'SCULPT'; 
    this.selection = new Set();
    this.topology = null;
    this._subscribed = false;
  }

  init() {
    // Retraso para asegurar que SculptGL haya montado la escena y la GUI
    setTimeout(() => {
      this._injectStyles();
      this._buildTopBar();
      this._addMenuToSidebar();
      this._bindEvents();
      console.log("PolyMode: Sistema de selección activado.");
    }, 800);
  }

  // --- INTERFAZ: MENÚ LATERAL ---
  _addMenuToSidebar() {
    const add = this.api.addGuiAction.bind(this.api);
    // Estos comandos aparecerán en la pestaña "PolyMode" del menú derecho
    add('PolyMode', 'CRECER Selección (+)', () => this._modifySelection('GROW'));
    add('PolyMode', 'Seleccionar Isla (L)', () => this._modifySelection('ISLAND'));
    add('PolyMode', 'Borrar Caras', () => this._deleteSelectedFaces());
    add('PolyMode', 'Limpiar Selección', () => this._clearAll());
  }

  // --- INTERFAZ: BARRA SUPERIOR (TOPBAR) ---
  _buildTopBar() {
    const topBar = document.querySelector('.gui-topbar');
    if (!topBar || document.getElementById('pm-toolbar')) return;

    const container = document.createElement('div');
    container.id = 'pm-toolbar';
    container.className = 'pm-container';
    
    const modes = [
      { id: 'SCULPT', icon: '🖌️', label: 'Sculpt' },
      { id: 'FACE',   icon: '🟦', label: 'Face' },
      { id: 'VERT',   icon: '⚫', label: 'Vert' }
    ];

    modes.forEach(m => {
      const btn = document.createElement('button');
      btn.innerHTML = `${m.icon} ${m.label}`;
      btn.className = `pm-btn ${m.id === 'SCULPT' ? 'active' : ''}`;
      btn.id = `btn-${m.id.toLowerCase()}`;
      btn.onclick = () => this._setMode(m.id);
      container.appendChild(btn);
    });

    topBar.appendChild(container);
  }

  _setMode(mode) {
    this.activeMode = mode;
    document.querySelectorAll('.pm-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`btn-${mode.toLowerCase()}`).classList.add('active');

    const main = this.api.main;
    if (mode !== 'SCULPT') {
      main.getSculptManager()._currentTool = -1; // Desactivar pincel activo
      main.setCursor('crosshair');
    } else {
      main.setCursor('default');
    }
  }

  // --- LÓGICA DE INTERACCIÓN (PICKING REAL) ---
  _bindEvents() {
    if (this._subscribed) return;
    const canvas = this.api.main._canvas;

    canvas.addEventListener('mousedown', (e) => {
      if (this.activeMode === 'SCULPT') return;

      const main = this.api.main;
      const mesh = main.getSelectedMeshes()[0];
      if (!mesh) return;

      const picking = main.getPicking();
      // 'intersectionMouse' es el método clave de SculptGL para saber qué tocamos
      if (picking.intersectionMouse(mesh, e.pageX, e.pageY)) {
        const faceIdx = picking._idId; // Obtenemos el ID de la cara bajo el ratón

        if (this.activeMode === 'FACE') {
          if (e.shiftKey) {
            this.selection.has(faceIdx) ? this.selection.delete(faceIdx) : this.selection.add(faceIdx);
          } else {
            this.selection.clear();
            this.selection.add(faceIdx);
          }
        }
        this._updateVisuals(mesh);
      }
    }, true);
    this._subscribed = true;
  }

  // --- VISUALIZACIÓN MEDIANTE MÁSCARA ---
  _updateVisuals(mesh = this.api.main.getSelectedMeshes()[0]) {
    if (!mesh) return;
    const mask = mesh.getMaskArray();
    const faces = mesh.getFaces();
    
    mask.fill(0.0); // Resetear máscara
    this.selection.forEach(fIdx => {
      // Pintar los 3 vértices de la cara seleccionada
      mask[faces[fIdx * 3]] = 1.0;
      mask[faces[fIdx * 3 + 1]] = 1.0;
      mask[faces[fIdx * 3 + 2]] = 1.0;
    });

    mesh.updateGeometry();
    this.api.render();
  }

  // --- ESTILOS CSS ---
  _injectStyles() {
    if (document.getElementById('pm-styles')) return;
    const s = document.createElement('style');
    s.id = 'pm-styles';
    s.innerHTML = `
      .pm-container { display: flex; margin-left: 20px; align-items: center; gap: 5px; }
      .pm-btn { 
        background: #333; color: #fff; border: 1px solid #555; 
        padding: 4px 10px; cursor: pointer; border-radius: 4px; font-size: 12px;
      }
      .pm-btn.active { background: #006655; border-color: #00ffcc; color: #00ffcc; }
      .pm-btn:hover { background: #444; }
    `;
    document.head.appendChild(s);
  }

  _clearAll() {
    this.selection.clear();
    this._updateVisuals();
  }
}
