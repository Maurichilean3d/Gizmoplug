export default class PolyModePlugin {
  constructor(api) {
    this.api = api;
    this.activeMode = 'SCULPT';
    this.selection = new Set();
    this.topology = null;
    this.pluginName = 'PolyMode Ultra';
  }

  init() {
    // Intentar inicializar la UI. Si falla, esperar un momento (SculptGL carga la GUI dinámicamente)
    if (this.api.main && this.api.main._gui) {
      this._setupAll();
    } else {
      setTimeout(() => this._setupAll(), 500);
    }
  }

  _setupAll() {
    this._injectStyles();
    this._buildTopBar();
    this._addMenuToTools();
    this._setupInteraction();
    console.log(`${this.pluginName} integrado correctamente.`);
  }

  // 1. MODIFICAR EL MENÚ DE LA DERECHA (TOOLS)
  _addMenuToTools() {
    const api = this.api;
    // Creamos una carpeta dedicada en el menú de la derecha
    // Nota: 'PolyMode' será el nombre de la sección en la barra lateral
    api.addGuiAction('PolyMode', '--- MODO SELECCIÓN ---', () => {});
    api.addGuiAction('PolyMode', 'Expandir Selección (+)', () => this._modifySelection('GROW'));
    api.addGuiAction('PolyMode', 'Seleccionar Isla (L)', () => this._modifySelection('ISLAND'));
    api.addGuiAction('PolyMode', 'Limpiar Todo', () => {
      this.selection.clear();
      this._updateVisuals();
    });
    
    // Forzamos a la GUI a actualizarse si es posible
    if (this.api.main._gui) this.api.main._gui.updateDisplay();
  }

  // 2. MODIFICAR LA BARRA SUPERIOR (TOP BAR)
  _buildTopBar() {
    const topBar = document.querySelector('.gui-topbar');
    if (!topBar) return;

    // Evitar duplicados si se recarga el plugin
    if (document.getElementById('poly-mode-toolbar')) return;

    const container = document.createElement('div');
    container.id = 'poly-mode-toolbar';
    container.style = "display: inline-flex; align-items: center; margin-left: 15px; border-left: 1px solid #444; padding-left: 10px; height: 100%;";
    
    const modes = [
      { id: 'SCULPT', icon: '🖌️', label: 'Sculpt' },
      { id: 'FACE', icon: '🟦', label: 'Face' },
      { id: 'VERT', icon: '⚫', label: 'Vert' }
    ];

    modes.forEach(m => {
      const btn = document.createElement('button');
      btn.id = `pm-btn-${m.id}`;
      btn.innerHTML = `${m.icon} ${m.label}`;
      btn.className = 'poly-mode-btn' + (m.id === 'SCULPT' ? ' active' : '');
      btn.onclick = () => this._switchMode(m.id);
      container.appendChild(btn);
    });

    topBar.appendChild(container);
  }

  _switchMode(mode) {
    this.activeMode = mode;
    // Actualizar visual de botones
    document.querySelectorAll('.poly-mode-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`pm-btn-${mode}`).classList.add('active');

    const sculptMgr = this.api.main.getSculptManager();
    if (mode !== 'SCULPT') {
      sculptMgr._currentTool = -1; // Desactiva la herramienta actual de escultura
      this.api.main.setCursor('crosshair');
    } else {
      this.api.main.setCursor('default');
    }
  }

  // 3. INTERVENCIÓN DE CLIC PARA SELECCIÓN POLIGONAL
  _setupInteraction() {
    const main = this.api.main;
    const canvas = main._canvas;

    canvas.addEventListener('mousedown', (e) => {
      if (this.activeMode === 'SCULPT') return;

      const mesh = main.getSelectedMeshes()[0];
      if (!mesh) return;

      const picking = main.getPicking();
      // Usar el sistema de picking nativo de SculptGL (como en Gizmo.js)
      if (picking.intersectionMouse(mesh, e.pageX, e.pageY)) {
        const faceIdx = picking._idId; 
        
        if (e.shiftKey) {
          this.selection.has(faceIdx) ? this.selection.delete(faceIdx) : this.selection.add(faceIdx);
        } else {
          this.selection.clear();
          this.selection.add(faceIdx);
        }
        this._updateVisuals(mesh);
      }
    }, true);
  }

  _updateVisuals(mesh = this.api.main.getSelectedMeshes()[0]) {
    if (!mesh) return;
    const mask = mesh.getMaskArray();
    const faces = mesh.getFaces();
    
    // Usamos el sistema de Máscaras para resaltar (estética roja)
    mask.fill(0.0);
    this.selection.forEach(fIdx => {
      mask[faces[fIdx * 3]] = 1.0;
      mask[faces[fIdx * 3 + 1]] = 1.0;
      mask[faces[fIdx * 3 + 2]] = 1.0;
    });

    mesh.updateGeometry();
    this.api.render();
  }

  // 4. ESTILOS PARA LA INTERFAZ INYECTADA
  _injectStyles() {
    if (document.getElementById('poly-mode-styles')) return;
    const style = document.createElement('style');
    style.id = 'poly-mode-styles';
    style.innerHTML = `
      .poly-mode-btn {
        background: #222;
        border: 1px solid #444;
        color: #aaa;
        padding: 4px 10px;
        margin: 0 2px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 11px;
        transition: all 0.2s;
      }
      .poly-mode-btn:hover { background: #333; color: #fff; }
      .poly-mode-btn.active {
        background: #008170;
        color: #fff;
        border-color: #00ffcc;
        box-shadow: 0 0 5px rgba(0,255,204,0.3);
      }
    `;
    document.head.appendChild(style);
  }

  // Lógica de topología (Simplificada para rendimiento)
  _modifySelection(type) {
    const mesh = this.api.main.getSelectedMeshes()[0];
    if (!mesh || this.selection.size === 0) return;

    const faces = mesh.getFaces();
    if (!this.topology) {
        this.topology = Array.from({ length: mesh.getNbVertices() }, () => []);
        for (let i = 0; i < faces.length / 3; i++) {
          this.topology[faces[i * 3]].push(i);
          this.topology[faces[i * 3 + 1]].push(i);
          this.topology[faces[i * 3 + 2]].push(i);
        }
    }

    let nextSel = new Set(this.selection);
    if (type === 'GROW') {
      this.selection.forEach(fIdx => {
        for (let i = 0; i < 3; i++) {
          const vIdx = faces[fIdx * 3 + i];
          this.topology[vIdx].forEach(adj => nextSel.add(adj));
        }
      });
    }
    this.selection = nextSel;
    this._updateVisuals(mesh);
  }
}
