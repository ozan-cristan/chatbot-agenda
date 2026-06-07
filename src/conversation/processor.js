const { getState, setState, appendHistory } = require('./stateManager');
const { buildSystemPrompt, buildMessages, buildContextMessage } = require('./prompt');
const { askClaude } = require('../integrations/claude');
const { getAvailableSlots, createEvent, cancelEvent } = require('../integrations/googleCalendar');
const { createAppointment, cancelAppointment, getPatientAppointments, upsertPatient, getPatient } = require('../services/appointmentService');
const { sendText, sendList, sendButtons } = require('../webhook/sender');
const logger = require('../utils/logger');

/**
 * Punto de entrada principal: procesa cada mensaje entrante
 */
async function processMessage(phone, text, messageId) {
  try {
    // 1. Leer estado actual
    const { state, context } = await getState(phone);

    // 2. Upsert del paciente en BD y recuperar nombre y turnos si ya existe
    await upsertPatient(phone);
    if (!context.patient_name) {
      const patient = await getPatient(phone);
      if (patient && patient.name) {
        context.patient_name = patient.name;
      }
    }
    // Siempre cargar los turnos próximos del paciente para que Claude pueda informarlos
    const upcomingAppointments = await getPatientAppointments(phone);
    if (upcomingAppointments.length > 0) {
      context.upcoming_appointments = upcomingAppointments.map(a => ({
        id: a.id,
        datetime: a.datetime,
        status: a.status
      }));
    } else {
      context.upcoming_appointments = [];
    }

    // 3. Si el paciente saluda y hay un estado previo activo, resetear para empezar de cero
    if (state !== 'idle' && isGreeting(text)) {
      await setState(phone, 'idle', { patient_name: context.patient_name });
      context.slots = null;
      context.selected_datetime = null;
      context.history = [];
    }

    // 4. Si el paciente está eligiendo un slot, manejar directamente sin Claude
    if (state === 'selecting_slot' && context.slots && context.slots.length) {

      // Modo selecting_hour: paciente eligió día, ahora elige hora
      if (context.slot_mode === 'selecting_hour' && context.day_slots) {
        // Si viene un ISO datetime (respuesta de lista interactiva), usar directo
        if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
          const matched = context.day_slots.find(s => s === text || s.startsWith(text.slice(0, 16)));
          if (matched) return await confirmSlot(phone, matched, context);
        }
        // Fallback: texto libre con hora numérica
        const hourMatch = text.match(/\b(\d{1,2})\b/);
        if (hourMatch) {
          const requestedH = parseInt(hourMatch[1]);
          const matched = context.day_slots.find(s => {
            const h = new Date(s.endsWith('Z') ? s : s + 'Z').getUTCHours() - 3;
            return h === requestedH;
          });
          if (matched) return await confirmSlot(phone, matched, context);
        }
        // No se entendió — reenviar lista de horas
        await sendHoursList(phone, context.day_slots, context.patient_name, context.day_label);
        return;
      }

      // Modo selecting_day: paciente elige el día
      if (context.slot_mode === 'selecting_day' && context.day_groups) {
        // Si viene un dateKey YYYY-MM-DD (respuesta de lista interactiva)
        let group = null;
        if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
          group = context.day_groups.find(g => g.dateKey === text);
        }
        // Fallback: número
        if (!group) {
          const dayIndex = resolveSlotSelection(text, context.day_groups.length);
          if (dayIndex !== null) group = context.day_groups[dayIndex];
        }
        if (group) {
          await setState(phone, 'selecting_slot', {
            ...context,
            slot_mode: 'selecting_hour',
            day_slots: group.slots,
            day_label: group.label
          });
          await sendHoursList(phone, group.slots, context.patient_name, group.label);
          return;
        }
      }

      // Resolución por texto natural: "quiero el lunes a las 16", "martes 9hs", etc.
      const naturalSlot = resolveSlotFromNaturalText(text, context.slots);
      if (naturalSlot) {
        return await confirmSlot(phone, naturalSlot, context);
      }

      // Filtro por franja horaria (tarde/mañana)
      const filterResult = filterSlotsByTime(text, context.slots);
      if (filterResult !== null) {
        const endH = parseInt((process.env.WORKING_HOURS_END || '18:00').split(':')[0]);
        const startH = parseInt((process.env.WORKING_HOURS_START || '09:00').split(':')[0]);
        if (filterResult.outOfRange) {
          await sendText(phone, `Lo siento${context.patient_name ? ', ' + context.patient_name : ''}, el consultorio atiende de ${startH}:00 a ${endH}:00 hs. ¿Te ofrezco dentro de ese horario?`);
          return;
        }
        if (!filterResult.slots.length) {
          await sendText(phone, `${context.patient_name ? context.patient_name + ', no' : 'No'} hay horarios en esa franja. ¿Querés que busque en otro día?`);
          return;
        }
        const filtered = filterResult.slots.filter(s => new Date(s).getUTCMinutes() === 0);
        const { dayGroups } = formatSlotsByDay(filtered);
        await setState(phone, 'selecting_slot', { ...context, slots: filtered, slot_mode: 'selecting_day', day_groups: dayGroups });
        await sendList(
          phone,
          `Estos son los días disponibles${context.patient_name ? ', ' + context.patient_name : ''}:`,
          [{ title: 'Días disponibles', rows: dayGroups.map(g => ({ id: g.dateKey, title: g.label.substring(0, 24) })) }],
          'Ver días'
        );
        return;
      }
    }

    // 4. Construir prompt y mensajes para Claude
    // NO pasamos la lista de slots a Claude — la selección siempre la maneja el código.
    // Solo le indicamos el modo actual para que pueda guiar al paciente.
    const systemPrompt = buildSystemPrompt();
    const slotModeHint = context.slot_mode === 'selecting_day'
      ? 'El paciente está eligiendo un día de la lista que ya se le mostró. Pedile que responda con el número del día.'
      : context.slot_mode === 'selecting_hour'
      ? 'El paciente está eligiendo una hora de la lista que ya se le mostró. Pedile que escriba la hora directamente (ej: 9, 14, 16).'
      : null;
    const contextNote = buildContextMessage(state, context, null, slotModeHint);
    const fullUserMessage = contextNote ? `${contextNote}\n\nMensaje del paciente: ${text}` : text;
    const messages = buildMessages(fullUserMessage, context);

    // 5. Llamar a Claude
    const claudeResponse = await askClaude(systemPrompt, messages);

    // 6. Parsear respuesta JSON de Claude (limpiando posibles bloques markdown)
    let parsed;
    try {
      // Intentar extraer JSON aunque haya texto antes o después
      let clean = claudeResponse
        .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

      // Si no empieza con {, buscar el primer { del string
      if (!clean.startsWith('{')) {
        const jsonStart = clean.indexOf('{');
        const jsonEnd = clean.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
          clean = clean.slice(jsonStart, jsonEnd + 1);
        }
      }

      parsed = JSON.parse(clean);
    } catch {
      logger.error('Claude no devolvió JSON válido', { raw: claudeResponse });
      await sendText(phone, 'Disculpá, tuve un problema interno. ¿Podés repetir tu mensaje?');
      return;
    }

    const { response, intent, next_state, action, action_params } = parsed;

    // 7. Ejecutar acción si corresponde
    let updatedContext = { ...context };
    let finalResponse = response;

    if (action) {
      try {
        const result = await executeAction(action, action_params, phone, context, response);
        finalResponse = result.response;
        if (result.slots) updatedContext.slots = result.slots;
        if (result.dayGroups) updatedContext.day_groups = result.dayGroups;
        if (result.slot_mode) updatedContext.slot_mode = result.slot_mode;
        if (action === 'create_appointment') {
          updatedContext.appointment_datetime = action_params.datetime;
          updatedContext.slots = null;
        }
        if (action === 'cancel_appointment') {
          updatedContext.confirmation_type = 'cancel';
        }
        if (action === 'reschedule_appointment') {
          updatedContext.confirmation_type = 'reschedule';
        }
      } catch (actionErr) {
        logger.error(`Error ejecutando acción ${action}`, { error: actionErr.message });
        finalResponse = 'Tuve un problema al procesar tu solicitud. Por favor intentá de nuevo en unos minutos.';
      }
    }

    // Guardar tipo de confirmación según intent
    if (next_state === 'awaiting_confirmation') {
      if (intent === 'cancel') {
        updatedContext.confirmation_type = 'cancel';
      } else if (intent === 'reschedule') {
        updatedContext.confirmation_type = 'reschedule';
      } else {
        updatedContext.confirmation_type = 'create';
      }
    }

    // Guardar nombre si lo capturamos
    if ((intent === 'collect_name' || next_state === 'collecting_reason') && text && state === 'collecting_name') {
      updatedContext.patient_name = text.trim();
      await upsertPatient(phone, text.trim());
    }

    // Guardar motivo
    if (intent === 'collect_reason' && next_state === 'selecting_slot') {
      updatedContext.reason = text.trim();
    }

    // 8. Actualizar historial
    updatedContext = appendHistory(updatedContext, 'user', text);
    updatedContext = appendHistory(updatedContext, 'assistant', finalResponse);

    // 9. Guardar nuevo estado
    const newState = next_state || state;
    // Limpiar historial al completar o volver a idle para no arrastrar contexto viejo
    if (newState === 'completed' || (newState === 'idle' && state !== 'idle')) {
      updatedContext.history = [];
    }
    await setState(phone, newState, updatedContext);

    // 10. Enviar respuesta al paciente (null = ya se envió un mensaje interactivo)
    if (finalResponse) {
      await sendText(phone, finalResponse);
    }

    logger.info(`Procesado OK — phone: ${phone}, intent: ${intent}, state: ${newState}`);

  } catch (err) {
    logger.error('Error crítico en processMessage', { phone, error: err.message, stack: err.stack });
    try {
      await sendText(phone, 'Lo siento, tuve un error inesperado. Por favor contactate directamente con el consultorio.');
    } catch {
      // silenciar error de envío
    }
  }
}

/**
 * Agrupa slots por día.
 * Retorna { dayGroups } donde dayGroups es array de { label, dateKey, slots }.
 * dateKey es "YYYY-MM-DD" y se usa como id en la lista interactiva.
 */
function formatSlotsByDay(slots) {
  const byDay = {};

  for (const s of slots) {
    const raw = s.endsWith('Z') ? s : s + 'Z';
    const dt = new Date(raw);
    // Clave de fecha en Argentina
    const argDate = new Date(dt.getTime() - 3 * 60 * 60 * 1000);
    const dateKey = argDate.toISOString().slice(0, 10); // YYYY-MM-DD
    const dayLabel = dt.toLocaleDateString('es-AR', {
      weekday: 'long', day: 'numeric', month: 'long',
      timeZone: 'America/Argentina/Buenos_Aires'
    });
    if (!byDay[dateKey]) byDay[dateKey] = { label: dayLabel, slots: [] };
    byDay[dateKey].slots.push(s);
  }

  const dayGroups = Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dateKey, { label, slots: daySlots }]) => ({
      label,
      dateKey,
      slots: daySlots
    }));

  return { dayGroups };
}

/**
 * Envía la lista interactiva de horas disponibles para un día.
 */
async function sendHoursList(phone, daySlots, patientName, dayLabel) {
  const rows = daySlots.map(s => {
    const raw = s.endsWith('Z') ? s : s + 'Z';
    const h = new Date(raw).getUTCHours() - 3;
    return {
      id: s,                    // ISO datetime completo como id
      title: `${h}:00 hs`
    };
  });

  await sendList(
    phone,
    `Perfecto${patientName ? ', ' + patientName : ''}. Horarios disponibles para el ${dayLabel || 'día seleccionado'}:`,
    [{ title: 'Horarios', rows }],
    'Ver horarios'
  );
}

/**
 * Detecta si el mensaje es un saludo para resetear la conversación
 */
function isGreeting(text) {
  const greetings = ['hola', 'hol', 'buen dia', 'buenos dias', 'buenas', 'buenas tardes', 'buenas noches', 'hey', 'hi', 'ola', 'good morning', 'hello'];
  const lower = text.toLowerCase().trim();
  return greetings.some(g => lower === g || lower.startsWith(g + ' '));
}

/**
 * Filtra slots por franja horaria o hora específica según el texto del paciente.
 * Retorna { slots: [...], outOfRange: bool } o null si el texto no aplica.
 */
function filterSlotsByTime(text, allSlots) {
  const lower = text.toLowerCase();
  const endH = parseInt((process.env.WORKING_HOURS_END || '18:00').split(':')[0]);
  const startH = parseInt((process.env.WORKING_HOURS_START || '09:00').split(':')[0]);

  // Detectar hora específica: "después de las 18", "a partir de las 17", "antes de las 10"
  const afterMatch = lower.match(/despu[eé]s\s+de\s+(?:las\s+)?(\d{1,2})/);
  const fromMatch = lower.match(/a\s+partir\s+de\s+(?:las\s+)?(\d{1,2})/);
  const beforeMatch = lower.match(/antes\s+de\s+(?:las\s+)?(\d{1,2})/);

  if (afterMatch || fromMatch) {
    const requestedH = parseInt((afterMatch || fromMatch)[1]);
    if (requestedH >= endH) {
      return { slots: [], outOfRange: true, requestedH };
    }
    return { slots: allSlots.filter(s => new Date(s).getHours() >= requestedH), outOfRange: false };
  }

  if (beforeMatch) {
    const requestedH = parseInt(beforeMatch[1]);
    if (requestedH <= startH) {
      return { slots: [], outOfRange: true, requestedH };
    }
    return { slots: allSlots.filter(s => new Date(s).getHours() < requestedH), outOfRange: false };
  }

  // Franjas genéricas
  if (lower.includes('tarde') || lower.includes('despues') || lower.includes('después')) {
    return { slots: allSlots.filter(s => new Date(s).getHours() >= 13), outOfRange: false };
  }
  if (lower.includes('mañana') || lower.includes('manana') || lower.includes('por la ma')) {
    return { slots: allSlots.filter(s => new Date(s).getHours() < 13), outOfRange: false };
  }

  return null; // No es un filtro de franja
}

/**
 * Resuelve si el texto del paciente es una selección numérica de slot.
 * Retorna el índice (0-based) o null si no es una selección válida.
 */
function resolveSlotSelection(text, totalSlots) {
  const trimmed = text.trim();
  const num = parseInt(trimmed);
  if (!isNaN(num) && num >= 1 && num <= totalSlots) {
    return num - 1;
  }
  return null;
}

/**
 * Intenta resolver un slot desde texto libre cuando el paciente menciona
 * un día y/o una hora (ej: "quiero el lunes a las 16", "martes 9hs").
 * Retorna el ISO string del slot encontrado, o null si no puede resolverlo.
 */
function resolveSlotFromNaturalText(text, slots) {
  if (!slots || !slots.length) return null;

  const lower = text.toLowerCase();

  const DAY_NAMES = {
    'lunes': 1, 'martes': 2, 'miércoles': 3, 'miercoles': 3,
    'jueves': 4, 'viernes': 5, 'sábado': 6, 'sabado': 6, 'domingo': 0
  };

  // Detectar día mencionado
  let targetDay = null;
  for (const [name, dayNum] of Object.entries(DAY_NAMES)) {
    if (lower.includes(name)) { targetDay = dayNum; break; }
  }

  // Detectar hora mencionada: "16hs", "las 16", "a las 9", "16:00", "16h"
  let targetHour = null;
  const hourMatch = lower.match(/(?:a\s+las?\s+|las?\s+)?(\d{1,2})(?:\s*(?:hs?|:00))?/);
  if (hourMatch) {
    const h = parseInt(hourMatch[1]);
    if (h >= 0 && h <= 23) targetHour = h;
  }

  if (targetDay === null && targetHour === null) return null;

  // Filtrar slots que coincidan
  const candidates = slots.filter(s => {
    const raw = s.endsWith('Z') ? s : s + 'Z';
    const dt = new Date(raw);
    // Convertir a hora Argentina (UTC-3)
    const argHour = (dt.getUTCHours() - 3 + 24) % 24;
    const argDay = new Date(dt.getTime() - 3 * 60 * 60 * 1000).getUTCDay();

    const dayOk = targetDay === null || argDay === targetDay;
    const hourOk = targetHour === null || argHour === targetHour;
    return dayOk && hourOk;
  });

  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1 && targetHour !== null) return candidates[0]; // si hay varias del mismo día+hora, tomar la primera
  return null;
}

/**
 * Confirma el slot seleccionado: pide confirmación al paciente antes de crear
 */
async function confirmSlot(phone, datetime, context) {
  const raw = datetime.endsWith('Z') ? datetime : datetime + 'Z';
  const dt = new Date(raw);
  const formatted = dt.toLocaleString('es-AR', {
    weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'America/Argentina/Buenos_Aires'
  });

  const nombre = context.patient_name ? `, ${context.patient_name}` : '';
  const confirmMsg = `Perfecto${nombre}. Confirmás el turno para:\n📅 ${formatted}\n📍 ${process.env.CLINIC_NAME}\n\nRespondé *SI* para confirmar o *NO* para elegir otro horario.`;

  // Guardar el datetime seleccionado en contexto y pasar a awaiting_confirmation
  const updatedContext = {
    ...context,
    selected_datetime: datetime,
    confirmation_type: 'create'  // Siempre resetear al confirmar un slot
  };
  updatedContext.history = (context.history || []);

  await setState(phone, 'awaiting_confirmation', updatedContext);
  await sendText(phone, confirmMsg);

  logger.info(`Slot seleccionado para ${phone}: ${datetime}`);
}

/**
 * Ejecuta la acción indicada por Claude.
 * Retorna { response, slots? }
 */
async function executeAction(action, params, phone, context, defaultResponse) {
  switch (action) {

    case 'fetch_slots': {
      const allSlots = await getAvailableSlots(params.date_preference);
      if (!allSlots.length) {
        return { response: 'No encontré horarios disponibles para esa fecha. ¿Querés que busque en otra semana?' };
      }

      // Solo slots en punto (:00)
      const slots = allSlots.filter(s => new Date(s).getUTCMinutes() === 0);
      if (!slots.length) {
        return { response: 'No encontré horarios disponibles para esa fecha. ¿Querés que busque en otra semana?' };
      }

      const { dayGroups } = formatSlotsByDay(slots);

      // Enviar lista interactiva de días (no texto)
      await sendList(
        phone,
        `Estos son los días disponibles${context.patient_name ? ', ' + context.patient_name : ''}:`,
        [{
          title: 'Días disponibles',
          rows: dayGroups.map(g => ({ id: g.dateKey, title: g.label.substring(0, 24) }))
        }],
        'Ver días'
      );

      return {
        response: null, // ya enviamos el mensaje interactivo
        slots,
        dayGroups,
        slot_mode: 'selecting_day'
      };
    }

    case 'create_appointment': {
      // Usar selected_datetime del contexto si no viene en params
      const datetime = params.datetime || context.selected_datetime;
      const reason = 'Consulta médica';

      const eventId = await createEvent(datetime, context.patient_name || phone, reason);
      await createAppointment(phone, eventId, datetime, reason);

      const dt = new Date(datetime);
      const formatted = dt.toLocaleString('es-AR', {
        weekday: 'long', day: 'numeric', month: 'long',
        hour: '2-digit', minute: '2-digit',
        timeZone: 'America/Argentina/Buenos_Aires'
      });

      return { response: `✅ ¡Turno confirmado!\n\n📅 ${formatted}\n📍 ${process.env.CLINIC_NAME}\n\nTe vamos a recordar 24hs antes. ¡Hasta entonces!` };
    }

    case 'cancel_appointment': {
      const appointments = await getPatientAppointments(phone);
      if (!appointments.length) {
        return { response: 'No encontré turnos activos para tu número. ¿Querés agendar uno nuevo?' };
      }

      const appt = appointments[0];
      await cancelEvent(appt.google_event_id);
      await cancelAppointment(appt.id);

      return { response: '✅ Tu turno fue cancelado. ¿Querés agendar otro?' };
    }

    case 'notify_doctor': {
      logger.warn(`Escalado a humano — phone: ${phone}, reason: ${params.reason}`);
      return { response: 'Entendido. Voy a avisar al consultorio para que te contacten directamente. ¡Gracias por tu paciencia!' };
    }

    default:
      return { response: defaultResponse };
  }
}

// Manejar la confirmación SI/NO cuando state es awaiting_confirmation
const originalProcessMessage = processMessage;

// Interceptar awaiting_confirmation antes de llegar a Claude
async function handleConfirmation(phone, text, context) {
  const answer = text.trim().toUpperCase();
  const confirmationType = context.confirmation_type || 'create'; // 'create' | 'cancel'

  if (answer === 'SI' || answer === 'SÍ' || answer === 'S') {

    if (confirmationType === 'cancel') {
      // Cancelar todos los turnos del paciente
      try {
        const appointments = await getPatientAppointments(phone);
        if (!appointments.length) {
          await setState(phone, 'idle', { patient_name: context.patient_name });
          await sendText(phone, 'No encontré turnos activos para cancelar.');
          return;
        }
        for (const appt of appointments) {
          await cancelEvent(appt.google_event_id);
          await cancelAppointment(appt.id);
        }
        await setState(phone, 'idle', { patient_name: context.patient_name });
        await sendText(phone, `✅ ${context.patient_name ? context.patient_name + ', ' : ''}${appointments.length > 1 ? 'todos los turnos fueron cancelados' : 'tu turno fue cancelado'}. ¿Querés agendar uno nuevo?`);
      } catch (err) {
        logger.error('Error cancelando turnos', { error: err.message });
        await sendText(phone, 'Tuve un problema al cancelar. Por favor intentá de nuevo.');
      }

    } else {
      // Crear el turno
      const datetime = context.selected_datetime;
      if (!datetime) {
        await setState(phone, 'idle', { patient_name: context.patient_name });
        await sendText(phone, 'Perdoná, perdí el horario seleccionado. ¿Querés que busquemos uno de nuevo?');
        return;
      }
      const reason = 'Consulta médica';
      try {
        const eventId = await createEvent(datetime, context.patient_name || phone, reason);
        await createAppointment(phone, eventId, datetime, reason);
        const raw = datetime.endsWith('Z') ? datetime : datetime + 'Z';
        const dt = new Date(raw);
        const formatted = dt.toLocaleString('es-AR', {
          weekday: 'long', day: 'numeric', month: 'long',
          hour: '2-digit', minute: '2-digit',
          timeZone: 'America/Argentina/Buenos_Aires'
        });
        await setState(phone, 'completed', { patient_name: context.patient_name });
        await sendText(phone, `✅ ¡Turno confirmado, ${context.patient_name || ''}!\n\n📅 ${formatted}\n📍 ${process.env.CLINIC_NAME}\n\nTe vamos a recordar 24hs antes. ¡Hasta entonces!`);
      } catch (err) {
        logger.error('Error creando turno en confirmación', { error: err.message });
        await sendText(phone, 'Tuve un problema al crear el turno. Por favor intentá de nuevo.');
      }
    }

  } else if (answer === 'NO' || answer === 'N') {
    if (confirmationType === 'cancel') {
      await setState(phone, 'idle', { patient_name: context.patient_name });
      await sendText(phone, 'Perfecto, no cancelamos nada. ¿En qué más te puedo ayudar?');
    } else if (context.slots && context.slots.length) {
      const slotText = context.slots.map((s, i) => {
        const dt = new Date(s);
        return `${i + 1}. ${dt.toLocaleString('es-AR', {
          weekday: 'long', day: 'numeric', month: 'long',
          hour: '2-digit', minute: '2-digit',
          timeZone: 'America/Argentina/Buenos_Aires'
        })}`;
      }).join('\n');
      await setState(phone, 'selecting_slot', context);
      await sendText(phone, `Sin problema. ¿Cuál preferís?\n\n${slotText}`);
    } else {
      await setState(phone, 'idle', { patient_name: context.patient_name });
      await sendText(phone, '¿En qué más te puedo ayudar?');
    }
  } else {
    const msg = confirmationType === 'cancel'
      ? 'Respondé *SI* para confirmar la cancelación o *NO* para mantener el turno.'
      : 'Respondé *SI* para confirmar el turno o *NO* para elegir otro horario.';
    await sendText(phone, msg);
  }
}

// Sobreescribir processMessage para interceptar awaiting_confirmation
module.exports = {
  processMessage: async function(phone, text, messageId) {
    const { state, context } = await getState(phone);

    // Los saludos siempre resetean el estado, sin importar en qué estado esté
    if (state !== 'idle' && isGreeting(text)) {
      await setState(phone, 'idle', { patient_name: context.patient_name });
      return await processMessage(phone, text, messageId);
    }

    if (state === 'awaiting_confirmation') {
      return await handleConfirmation(phone, text, context);
    }

    return await processMessage(phone, text, messageId);
  }
};
