export default class PolyModePlugin {
  constructor(api) {
    this.api = api;
    this.activeMode = 'SCULPT';
    this.selection = new Set();
    this.topology = null;
  }

  init() {
    this._injectStyles();
    this._buildTopBar();
    this._addMenuToSidebar();
    
    const canvas = this.api.getCanvas();
    if (canvas) {
      // Usamos 'pointerdown' para capturar tanto Apple Pencil como dedos y mouse en iPad
      canvas.addEventListener('pointerdown', (e) => this._handleInteraction(e), true);
    }
  }

  _addMenuToSidebar() {
    this.api.addGuiAction('PolyMode', 'CRECER Selección (+)', () => this._modifySelection('GROW'));
    this.api.addGuiAction('PolyMode', 'Limpiar Todo', () => {
      this.selection.clear();
      this._updateVisuals();
    });
  }

  _handleInteraction(e) {
    if (this.activeMode === 'SCULPT') return;

    const main = this.api.main;
    const mesh = this.api.getMesh();
    if (!mesh) return;

    // Lógica vital para iPad: offset + pixelRatio
    // SculptGL usa internamente estas variables para sus cálculos
    const pr = main._pixelRatio || window.devicePixelRatio || 1;
    const rect = main._canvas.getBoundingClientRect();
    
    // Calculamos la posición exacta del toque en el espacio de WebGL
    const mouseX = (e.clientX - rect.left) * pr;
    const mouseY = (e.clientY - rect.top) * pr;

    const picking = this.api.getPicking();
    
    // Forzamos el picking en la posición del toque
    if (picking.intersectionMouse(mesh, mouseX, mouseY)) {
      const faceIdx = picking._idId;

      if (this.activeMode === 'FACE') {
        // En iPad, como no hay Shift, podemos alternar selección con cada toque
        if (this.selection.has(faceIdx)) {
          this.selection.delete(faceIdx);
        } else {
          this.selection.add(faceIdx);
        }
      }
      
      this._updateVisuals(mesh);
      
      // Detenemos la propagación para que el iPad no mueva la cámara al tocar
      e.stopPropagation();
      e.preventDefault();
    }
  }

  _updateVisuals(mesh = this.api.getMesh()) {
    if (!mesh) return;
    const mask = mesh.getMaskArray();
    const faces = mesh.getFaces();
    
    mask.fill(0.0);
    this.selection.forEach(fIdx => {
      mask[faces[fIdx * 3]] = 1.0;
      mask[faces[fIdx * 3 + 1]] = 1.0;
      mask[faces[fIdx * 3 + 2]] = 1.0;
    });

    mesh.updateGeometry();
    this.api.render();
  }

  _switchMode(mode) {
    this.activeMode = mode;
    document.querySelectorAll('.pm-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`pm-btn-${mode}`).classList.add('active');

    if (mode !== 'SCULPT') {
      this.api.main.getSculptManager()._currentTool = -1;
      this.api.main.setCanvasCursor('crosshair');
    } else {
      this.api.main.setCanvasCursor('default');
    }
  }

  _buildTopBar() {
    const topBar = document.querySelector('.gui-topbar');
    if (!topBar || document.getElementById('pm-toolbar')) return;

    const container = document.createElement('div');
    container.id = 'pm-toolbar';
    container.style = "display: inline-flex; align-items: center; margin-left: 10px; height: 100%; border-left: 1px solid #444; padding-left: 10px;";
    
    const modes = [
      { id: 'SCULPT', icon: '🖌️', label: 'Sculpt' },
      { id: 'FACE', icon: '🟦', label: 'Face' }
    ];

    modes.forEach(m => {
      const btn = document.createElement('button');
      btn.id = `pm-btn-${m.id}`;
      btn.innerHTML = `${m.icon} ${m.label}`;
      btn.className = 'pm-btn' + (m.id === 'SCULPT' ? ' active' : '');
      btn.onclick = () => this._switchMode(m.id);
      container.appendChild(btn);
    });

    topBar.appendChild(container);
  }

  _injectStyles() {
    if (document.getElementById('pm-styles')) return;
    const s = document.createElement('style');
    s.id = 'pm-styles';
    s.innerHTML = `
      .pm-btn { background: #333; color: #fff; border: 1px solid #555; padding: 6px 12px; margin: 0 4px; cursor: pointer; font-size: 14px; border-radius: 5px; }
      .pm-btn.active { border-color: #00ffcc; color: #00ffcc; background: #222; }
    `;
    document.head.appendChild(s);
  }

  _modifySelection(type) {
    const mesh = this.api.getMesh();
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

    let next = new Set(this.selection);
    this.selection.forEach(fIdx => {
      for (let i = 0; i < 3; i++) {
        this.topology[faces[fIdx * 3 + i]].forEach(adj => next.add(adj));
      }
    });
    this.selection = next;
    this._updateVisuals(mesh);
  }
}
