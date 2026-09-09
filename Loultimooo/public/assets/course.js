const steps = [
  { title: 'Prepara tu estudio', copy: 'Comprueba el entorno básico antes de crear tu aplicación.', checks: ['Cuenta de GitHub preparada', 'Cuenta de Render preparada', 'Email de trabajo disponible'] },
  { title: 'GitHub', copy: 'Prepara el repositorio que contendrá tu aplicación.', checks: ['Repositorio creado', 'Archivos subidos', 'Rama main verificada'] },
  { title: 'Render', copy: 'Conecta el repositorio y despliega la base de tu aplicación.', checks: ['Servicio conectado', 'Variables configuradas', 'Deploy activo'] },
  { title: 'Conectar APIs', copy: 'Añade las claves mediante variables seguras, nunca dentro del código.', checks: ['Claves guardadas como secretos', 'Conexión comprobada'] },
  { title: 'Configurar voz', copy: 'Elige la voz, velocidad y emoción de tu narrador.', checks: ['Voz seleccionada', 'Prueba de audio realizada'] },
  { title: 'Modelos de vídeo', copy: 'Configura calidad, formato, duración y coste por generación.', checks: ['Modelo seleccionado', 'Formato 9:16 comprobado'] },
  { title: 'Primera generación', copy: 'Realiza una prueba completa y revisa el resultado.', checks: ['Prompt preparado', 'Generación completada', 'Archivo descargado'] },
  { title: 'Tu app está lista', copy: 'Has completado el recorrido inicial de Estudio AudioVisual V2.', checks: ['Acceso verificado', 'Aplicación operativa'] }
];

let index = Number(sessionStorage.getItem('academy-step') || 0);
if (!Number.isInteger(index) || index < 0 || index >= steps.length) index = 0;

function csrfToken() {
  const match = document.cookie.split('; ').find((entry) => entry.split('=')[0].endsWith('ae_csrf'));
  return match ? decodeURIComponent(match.split('=').slice(1).join('=')) : '';
}

function render() {
  const step = steps[index];
  document.querySelector('#course-step-count').textContent = `PASO ${index + 1} DE ${steps.length}`;
  document.querySelector('#course-title').textContent = step.title;
  document.querySelector('#course-copy').textContent = step.copy;
  document.querySelector('#course-progress-bar').style.width = `${((index + 1) / steps.length) * 100}%`;
  const list = document.querySelector('#course-checklist');
  list.replaceChildren();
  step.checks.forEach((text, checkIndex) => {
    const label = document.createElement('label');
    label.className = 'check-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = sessionStorage.getItem(`academy-${index}-${checkIndex}`) === '1';
    input.addEventListener('change', () => sessionStorage.setItem(`academy-${index}-${checkIndex}`, input.checked ? '1' : '0'));
    const span = document.createElement('span');
    span.textContent = text;
    label.append(input, span);
    list.append(label);
  });
  document.querySelector('#course-prev').disabled = index === 0;
  document.querySelector('#course-next').textContent = index === steps.length - 1 ? 'FINALIZAR' : 'CONTINUAR';
  sessionStorage.setItem('academy-step', String(index));
}

document.querySelector('#course-prev').addEventListener('click', () => { if (index > 0) { index -= 1; render(); } });
document.querySelector('#course-next').addEventListener('click', () => { if (index < steps.length - 1) { index += 1; render(); } });

document.querySelector('#course-logout').addEventListener('click', async () => {
  await fetch('/logout', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() },
    body: '{}'
  });
  window.location.assign('/access');
});

document.querySelector('#manage-devices').addEventListener('click', async () => {
  const response = await fetch('/api/devices', { credentials: 'same-origin' });
  const body = await response.json();
  const lines = body.devices?.filter((item) => item.status === 'active').map((item) => `${item.current ? '• ' : ''}${item.label}`).join('\n') || 'Sin dispositivos activos';
  window.alert(`Dispositivos autorizados:\n\n${lines}\n\nPuedes revocarlos desde el panel de acceso cuando autorices un dispositivo nuevo.`);
});

fetch('/api/session', { credentials: 'same-origin' }).then((response) => {
  if (!response.ok) window.location.assign('/access');
});
render();
