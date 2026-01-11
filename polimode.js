export default class PolyModeOverlay {
  constructor(api) {
    this.api = api;
    this.active = false;
    this.selection = new Set();
    this.overlayDiv = null; // La capa transparente
  }

  init() {
    // Retraso de seguridad
    setTimeout(() => {
      this._createUI();
      console.log("PolyMode Overlay: Sistema de Capas listo.");
    }, 1000);
  }

  // =================================================================
  // 1. LA CAPA "ESCUDO" (OVERLAY)
  // =================================================================
  _toggleMode() {
    this.active = !this.active;
    const btn = document.getElementById('pm-main-btn');

    if (this.active) {
      // ACTIVAR MODO SELECCIÓN
      btn.innerText = '🟩 MODO SELECCIÓN (Activo)';
      btn.style.background = '#00AA00';
      btn.style.borderColor = '#00FF00';
      
      // Creamos la capa que bloqueará a SculptGL
      this._createOverlay();
      
    } else {
      // VOLVER A MODO ESCULTURA
      btn.innerText = '🖌️ MODO ESCULTURA';
      btn.style.background = '#333';
      btn.style.borderColor = '#555';
      
      // Destruimos la capa para devolver el control
      this._removeOverlay();
      
      // Limpiamos visuales (opcional)
      this._resetColors();
    }
  }

  _createOverlay() {
    if (this.overlayDiv) return;

    // Buscamos el canvas original para copiar su tamaño y posición
    const canvas = this.api.getCanvas();
    const rect = canvas.getBoundingClientRect();

    // Creamos un DIV transparente que cubre exactamente el canvas
    const div = document.createElement('div');
    div.id = 'pm-overlay-layer';
    div.style.position = 'absolute';
    div.style.top = `${rect.top}px`;
    div.style.left = `${rect.left}px`;
    div.style.width = `${rect.width}px`;
    div.style.height = `${rect.height}px`;
    div.style.zIndex = '9999'; // Muy por encima de todo
    div.style.cursor = 'crosshair';
    div.style.touchAction = 'none'; // Evita scroll/zoom del navegador en iPad

    // ESCUCHAMOS LOS TOQUES EN ESTA CAPA (No en el canvas)
    div.addEventListener('pointerdown', (e) => this._onTouch(e));

    document.body.appendChild(div);
    this.overlayDiv = div;
    
    // Actualizamos posición si se redimensiona la ventana
    window.onresize = () => {
        const r = canvas.getBoundingClientRect();
        div.style.top = `${r.top}px`;
        div.style.left = `${r.left}px`;
        div.style.width = `${r.width}px`;
        div.style.height = `${r.height}px`;
    };
  }

  _removeOverlay() {
    if (this.overlayDiv) {
      this.overlayDiv.remove();
      this.overlayDiv = null;
    }
    window.onresize = null;
  }

  // =================================================================
  // 2. MATEMÁTICA Y SELECCIÓN
  // =================================================================
  _onTouch(e) {
    // Evitamos cualquier gesto nativo del navegador
    e.preventDefault();
    e.stopPropagation();

    const main = this.api.main;
    const mesh = main.getMesh();
    if (!mesh) return;

    // --- CÁLCULO DE COORDENADAS IPAD ---
    // Usamos las coordenadas relativas al DIV overlay, que son idénticas al canvas
    const rect = this.overlayDiv.getBoundingClientRect();
    const pr = window.devicePixelRatio || 1; // Factor Retina (2.0 o 3.0)

    // Coordenada X/Y precisa dentro del buffer WebGL
    const x = (e.clientX - rect.left) * pr;
    const y = (e.clientY - rect.top) * pr;

    // Usamos el picking de SculptGL "a control remoto"
    const picking = main.getPicking();
    
    // intersectionMouse espera coordenadas escaladas por pixelRatio
    if (picking.intersectionMouse(mesh, x, y)) {
      const faceIdx = picking._idId;
      this._handleSelection(mesh, faceIdx);
    }
  }

  _handleSelection(mesh, faceIdx) {
    // Lógica Toggle
    if (this.selection.has(faceIdx)) {
      this.selection.delete(faceIdx);
    } else {
      this.selection.add(faceIdx);
    }
    
    // Actualizar visuales
    this._paintSelection(mesh);
  }

  // =================================================================
  // 3. VISUALIZACIÓN (VERDE)
  // =================================================================
  _paintSelection(mesh) {
    const colors = mesh.getColors(); // Float32Array
    const faces = mesh.getFaces();
    
    // Reset a gris claro para que resalte
    colors.fill(0.9);

    // Pintar seleccionados de VERDE
    this.selection.forEach(fIdx => {
      const i1 = faces[fIdx * 3];
      const i2 = faces[fIdx * 3 + 1];
      const i3 = faces[fIdx * 3 + 2];
      
      // Verde RGB (0, 1, 0)
      colors[i1 * 3] = 0; colors[i1 * 3+1] = 1; colors[i1 * 3+2] = 0;
      colors[i2 * 3] = 0; colors[i2 * 3+1] = 1; colors[i2 * 3+2] = 0;
      colors[i3 * 3] = 0; colors[i3 * 3+1] = 1; colors[i3 * 3+2] = 0;
    });

    // Forzar actualización GPU
    if (mesh.updateColor) mesh.updateColor();
    else if (mesh.updateBuffers) mesh.updateBuffers();
    
    this.api.render();
  }
  
  _resetColors() {
     const mesh = this.api.main.getMesh();
     if(mesh) {
         mesh.getColors().fill(1.0); // Blanco
         if(mesh.updateColor) mesh.updateColor();
         this.api.render();
     }
  }

  // =================================================================
  // 4. INTERFAZ (BOTÓN GRANDE)
  // =================================================================
  _createUI() {
    const topBar = document.querySelector('.gui-topbar');
    if (!topBar) return;
    
    if (document.getElementById('pm-main-btn')) return;

    // Contenedor
    const container = document.createElement('div');
    container.style = "display: inline-block; margin-left: 20px; border-left: 1px solid #666; padding-left: 15px; height: 100%; vertical-align: middle;";

    // Botón Principal
    const btn = document.createElement('button');
    btn.id = 'pm-main-btn';
    btn.innerText = '🖌️ MODO ESCULTURA';
    btn.style = `
      background: #333; color: white; border: 2px solid #555; 
      padding: 8px 15px; border-radius: 6px; font-weight: bold; 
      cursor: pointer; font-size: 13px; transition: all 0.2s;
    `;
    
    btn.onclick = () => this._toggleMode();

    // Botón Limpiar
    const btnClear = document.createElement('button');
    btnClear.innerText = '🗑️';
    btnClear.title = 'Limpiar Selección';
    btnClear.style = "background: #222; border: 1px solid #444; color: #ccc; padding: 8px; margin-left: 5px; border-radius: 6px; cursor: pointer;";
    btnClear.onclick = () => {
        this.selection.clear();
        const mesh = this.api.main.getMesh();
        if(mesh) this._paintSelection(mesh);
    };

    container.appendChild(btn);
    container.appendChild(btnClear);
    topBar.appendChild(container);
  }
}
