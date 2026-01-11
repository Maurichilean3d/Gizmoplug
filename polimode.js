export default class PolyModeCore {
  constructor(api) {
    this.api = api;
    this.active = false; // Estado del modo selección
    this.selection = new Set();
  }

  init() {
    // Esperamos 500ms para asegurar que SculptGL inició completamente
    setTimeout(() => {
      this._installUI();
      this._overrideEngine(); // <--- Aquí ocurre la magia
      console.log("PolyMode Core: Motor intervenido exitosamente.");
    }, 500);
  }

  // =================================================================
  // 1. OVERRIDE DEL MOTOR (La clave para que funcione en iPad)
  // =================================================================
  _overrideEngine() {
    const main = this.api.main;
    
    // Guardamos la función original de SculptGL para no romper nada
    const originalOnDeviceDown = main.onDeviceDown.bind(main);

    // Reemplazamos el manejador de input de SculptGL con el nuestro
    main.onDeviceDown = (event) => {
      
      // Si el modo Poly está ACTIVO, tomamos el control total
      if (this.active) {
        // 1. Le pedimos a SculptGL que calcule la posición del mouse/dedo
        // Esto usa su variable interna _pixelRatio (vital para iPad)
        main.setMousePosition(event);
        
        // 2. Usamos las coordenadas ya corregidas por el motor
        const mx = main._mouseX;
        const my = main._mouseY;
        const mesh = main.getMesh();

        if (mesh) {
          const picking = main.getPicking();
          // 3. Ejecutamos el Raycast interno
          if (picking.intersectionMouse(mesh, mx, my)) {
            const faceIdx = picking._idId; // ID del triángulo tocado
            this._toggleFace(mesh, faceIdx);
            
            // IMPORTANTE: Detenemos aquí. No llamamos a originalOnDeviceDown.
            // Esto evita que rote la cámara o esculpa.
            return; 
          }
        }
      }

      // Si NO está activo, dejamos que SculptGL funcione normal
      originalOnDeviceDown(event);
    };
  }

  // =================================================================
  // 2. LÓGICA DE GEOMETRÍA (Pintar en GPU)
  // =================================================================
  _toggleFace(mesh, faceIdx) {
    // Gestión del Set de selección
    if (this.selection.has(faceIdx)) {
      this.selection.delete(faceIdx);
    } else {
      this.selection.add(faceIdx);
    }

    this._updateVisuals(mesh);
  }

  _updateVisuals(mesh) {
    const colors = mesh.getColors(); // Float32Array directo del buffer
    const faces = mesh.getFaces();
    
    // 1. Limpieza rápida: Poner todo en Gris Claro (0.8)
    // (Para optimizar en mallas grandes, solo deberíamos despintar lo previo, 
    // pero para asegurar que se ve, pintamos todo)
    colors.fill(0.8); 

    // 2. Pintar selección de VERDE (0, 1, 0)
    this.selection.forEach(fIdx => {
      // Un triángulo tiene 3 vértices
      const v1 = faces[fIdx * 3];
      const v2 = faces[fIdx * 3 + 1];
      const v3 = faces[fIdx * 3 + 2];

      // Pintamos los 3 vértices
      const r = 0.0, g = 1.0, b = 0.0;
      
      colors[v1 * 3]     = r; colors[v1 * 3 + 1]     = g; colors[v1 * 3 + 2]     = b;
      colors[v2 * 3]     = r; colors[v2 * 3 + 1]     = g; colors[v2 * 3 + 2]     = b;
      colors[v3 * 3]     = r; colors[v3 * 3 + 1]     = g; colors[v3 * 3 + 2]     = b;
    });

    // 3. ¡GOLPE A LA GPU! Forzamos la actualización
    // Intentamos los dos métodos posibles según la versión de SculptGL
    if (mesh.updateColor) mesh.updateColor();
    else if (mesh.updateBuffers) mesh.updateBuffers();
    
    // Renderizamos la escena
    this.api.render();
  }

  // =================================================================
  // 3. INTERFAZ DE USUARIO (Barra Superior)
  // =================================================================
  _installUI() {
    // Estilos CSS
    if (!document.getElementById('pm-css')) {
      const style = document.createElement('style');
      style.id = 'pm-css';
      style.innerHTML = `
        .pm-btn { 
          background: #333; color: #ddd; border: 1px solid #555; 
          padding: 6px 12px; margin-left: 10px; border-radius: 4px; 
          font-weight: bold; cursor: pointer; display: inline-block;
        }
        .pm-btn.active { 
          background: #00AA00; color: #fff; border-color: #00FF00; 
          box-shadow: 0 0 8px rgba(0,255,0,0.4); 
        }
      `;
      document.head.appendChild(style);
    }

    // Inyección en la barra superior
    const topBar = document.querySelector('.gui-topbar');
    if (topBar && !document.getElementById('pm-toggle')) {
      const btn = document.createElement('button');
      btn.id = 'pm-toggle';
      btn.className = 'pm-btn';
      btn.innerText = '🖌️ Sculpt Mode';
      
      btn.onclick = () => {
        this.active = !this.active;
        if (this.active) {
          btn.innerText = '🟩 SELECT MODE';
          btn.classList.add('active');
          // Limpiamos selección previa al entrar
          this.selection.clear();
          this.api.main.setCanvasCursor('crosshair');
        } else {
          btn.innerText = '🖌️ Sculpt Mode';
          btn.classList.remove('active');
          // Restauramos color al salir
          const mesh = this.api.main.getMesh();
          if(mesh) {
            mesh.getColors().fill(1.0); // Blanco
            if(mesh.updateColor) mesh.updateColor();
            this.api.render();
          }
          this.api.main.setCanvasCursor('default');
        }
      };
      
      // Insertar después del logo o al principio
      topBar.appendChild(btn);
    }
    
    // Acción en menú Tools para limpiar
    this.api.addGuiAction('PolyMode', 'Limpiar Selección', () => {
      this.selection.clear();
      if (this.api.main.getMesh()) this._updateVisuals(this.api.main.getMesh());
    });
  }
}
