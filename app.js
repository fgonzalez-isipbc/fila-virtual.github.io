const API_URL = 'https://script.google.com/macros/s/AKfycbwccDnDEJAQSs2v-IfZBJNLuCN_gDtdgLS7FSZ-6XpWpkkjti_UCJ5mcOfQPwYKlh4W/exec';

let currentUser = null;
let pollingInterval = null;
let countdownInterval = null;
let targetEndTime = null;
let currentActiveTxId = null;

// Petición genérica a Apps Script (evita problemas de CORS usando text/plain)
async function callBackend(payload) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  });
  const json = await response.json();
  if (json.status === 'error') throw new Error(json.message);
  return json.data;
}

// 1. Manejo de Login
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('btn-login');
  const correo = document.getElementById('email-input').value;
  
  btn.disabled = true;
  btn.textContent = 'Verificando...';

  try {
    const res = await callBackend({ action: 'login', correo });
    if (!res.exists) {
      showModal('modal-error', 'El correo ingresado no existe en la tabla dbo_usuarios.');
      return;
    }

    currentUser = res.usuario;
    initSession();
  } catch (err) {
    showModal('modal-error', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Ingresar';
  }
});

function initSession() {
  document.getElementById('view-login').classList.add('hidden');
  
  if (currentUser.tipo === 'RECURSO') {
    document.getElementById('view-resource').classList.remove('hidden');
    document.getElementById('resource-name').textContent = `Servidor: ${currentUser.nombre}`;
  } else {
    document.getElementById('view-student').classList.remove('hidden');
    document.getElementById('student-name').textContent = `Hola, ${currentUser.nombre}`;
    document.getElementById('student-email').textContent = currentUser.id;
  }

  refreshData();
  // Consultar actualizaciones cada 8 segundos
  pollingInterval = setInterval(refreshData, 8000);
}

// 2. Sincronización de estado
async function refreshData() {
  if (!currentUser) return;
  try {
    const data = await callBackend({ action: 'getStatus', id_usuario: currentUser.id });
    if (currentUser.tipo === 'RECURSO') {
      renderResourceView(data);
    } else {
      renderStudentView(data);
    }
  } catch (err) {
    console.error('Error sincronizando:', err);
  }
}

// 3. Renderizado Vista Estudiante
function renderStudentView(data) {
  // Llenar trámites una sola vez
  const select = document.getElementById('select-tramite');
  if (select.options.length === 0 && data.tramites.length > 0) {
    data.tramites.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.tipo;
      select.appendChild(opt);
    });
  }

  // Estado del Servidor
  const pill = document.getElementById('server-status-badge');
  const desc = document.getElementById('server-status-desc');
  const btnEnqueue = document.getElementById('btn-enqueue');

  if (data.servidorOcupado) {
    pill.textContent = 'Ocupado';
    pill.className = 'status-pill busy';
    desc.textContent = 'El recurso está atendiendo a otro usuario. Puedes formarte en la fila virtual.';
    btnEnqueue.textContent = 'Formarse en la Fila';
  } else {
    pill.textContent = 'Disponible';
    pill.className = 'status-pill available';
    desc.textContent = 'El recurso está disponible. Puedes reservar tu turno ahora.';
    btnEnqueue.textContent = 'Reservar Cita / Atenderme';
  }

  // Estado del usuario en la fila
  const { enFila, posicion, tiempoEstimadoMinutos, transaccion } = data.miEstado;
  
  if (!enFila) {
    document.getElementById('not-in-queue-msg').classList.remove('hidden');
    document.getElementById('in-queue-stats').classList.add('hidden');
    btnEnqueue.disabled = false;
    stopCountdown();
    return;
  }

  btnEnqueue.disabled = true;
  document.getElementById('not-in-queue-msg').classList.add('hidden');
  document.getElementById('in-queue-stats').classList.remove('hidden');

  if (transaccion.estatus === 'EN_ATENCION') {
    document.getElementById('stat-position').textContent = '¡Tu turno!';
    document.getElementById('stat-estimated').textContent = 'En atención';
    document.getElementById('stat-countdown').textContent = '00:00';
    stopCountdown();
  } else {
    document.getElementById('stat-position').textContent = `#${posicion}`;
    document.getElementById('stat-estimated').textContent = `${tiempoEstimadoMinutos} min`;
    startOrUpdateCountdown(tiempoEstimadoMinutos);
  }
}

// Lógica del contador regresivo y renovación si se vence
function startOrUpdateCountdown(minutosEstimados) {
  const now = Date.now();
  const nuevoObjetivo = now + minutosEstimados * 60000;

  // Si no hay contador activo, o si el tiempo venció, se reinicia/actualiza
  if (!targetEndTime || targetEndTime <= now) {
    targetEndTime = nuevoObjetivo;
  }

  if (countdownInterval) return;

  countdownInterval = setInterval(() => {
    const restante = targetEndTime - Date.now();
    const alertEl = document.getElementById('overtime-alert');

    if (restante <= 0) {
      // Si el tiempo estimado vence, se muestra aviso y se renueva un bloque extra de espera (+2 min)
      alertEl.classList.remove('hidden');
      targetEndTime = Date.now() + 2 * 60000; 
      document.getElementById('stat-estimated').textContent = '+2 min (Actualizado)';
      return;
    }

    alertEl.classList.add('hidden');
    const mins = Math.floor(restante / 60000);
    const secs = Math.floor((restante % 60000) / 1000);
    document.getElementById('stat-countdown').textContent = 
      `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }, 1000);
}

function stopCountdown() {
  clearInterval(countdownInterval);
  countdownInterval = null;
  targetEndTime = null;
}

async function handleEnqueue() {
  const btn = document.getElementById('btn-enqueue');
  btn.disabled = true;
  try {
    // Se envía un tiempo base estimado de 5 minutos por atención
    const data = await callBackend({ action: 'enqueue', id_usuario: currentUser.id, tiempo_estimado: 5 });
    renderStudentView(data);
  } catch (err) {
    showModal('modal-error', err.message);
    btn.disabled = false;
  }
}

// 4. Renderizado Vista Recurso (Tabla FIFO y Modal de Atención)
function renderResourceView(data) {
  const tbody = document.getElementById('fifo-table-body');
  tbody.innerHTML = '';

  // Si el recurso ya tiene a alguien en atención activa, abrir modal automáticamente
  if (data.enAtencion && data.enAtencion.id_recurso === currentUser.id) {
    openAttentionModal(data.enAtencion);
  }

  if (data.colaFIFO.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#6e6e73;">No hay usuarios en espera.</td></tr>';
    return;
  }

  data.colaFIFO.forEach((item, index) => {
    const esPrimero = index === 0; // Disciplina estricta FIFO
    const hora = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>#${index + 1}</strong></td>
      <td>${item.id_transaccion}</td>
      <td>${item.id_usuario}</td>
      <td>${hora}</td>
      <td>${item.tiempo_atencion} min</td>
      <td>
        <button class="btn btn-primary btn-sm" 
          ${!esPrimero || data.servidorOcupado ? 'disabled' : ''} 
          onclick="handleAttendNext('${item.id_transaccion}')">
          ${esPrimero ? 'Atender Siguiente' : 'En espera (FIFO)'}
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function handleAttendNext(id_transaccion) {
  try {
    const data = await callBackend({ 
      action: 'attendNext', 
      id_transaccion, 
      id_recurso: currentUser.id 
    });
    renderResourceView(data);
  } catch (err) {
    showModal('modal-error', err.message);
  }
}

function openAttentionModal(tx) {
  currentActiveTxId = tx.id_transaccion;
  document.getElementById('attending-user-title').textContent = `Atendiendo a: ${tx.id_usuario}`;
  document.getElementById('attending-tx-id').textContent = tx.id_transaccion;
  document.getElementById('modal-attention').classList.remove('hidden');
}

async function handleFinishAttention() {
  if (!currentActiveTxId) return;
  const btn = document.getElementById('btn-finish-attention');
  btn.disabled = true;
  btn.textContent = 'Liberando...';

  try {
    await callBackend({ action: 'finishAttention', id_transaccion: currentActiveTxId });
    currentActiveTxId = null;
    closeModal('modal-attention');
    await refreshData();
  } catch (err) {
    showModal('modal-error', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Liberar Usuario y Continuar';
  }
}

// Utilidades de Modales y Sesión
function showModal(id, msg) {
  if (msg) document.getElementById('modal-error-msg').textContent = msg;
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function logout() {
  clearInterval(pollingInterval);
  stopCountdown();
  currentUser = null;
  location.reload();
}