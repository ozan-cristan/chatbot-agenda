const { google } = require('googleapis');
const logger = require('../utils/logger');

// Configurar cliente OAuth2
function getCalendarClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth });
}

/**
 * Retorna slots disponibles según la preferencia de fecha.
 * Si existe AVAILABILITY_CALENDAR_ID, lee ventanas desde ese calendario.
 * Si no, usa las variables de entorno como fallback.
 */
async function getAvailableSlots(datePreference) {
  try {
    const calendar = getCalendarClient();
    const { timeMin, timeMax } = parseDatePreference(datePreference);
    const appointmentsCalendarId = process.env.APPOINTMENTS_CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID || 'primary';

    // Eventos de citas existentes (para detectar turnos ya ocupados)
    const { data: apptData } = await calendar.events.list({
      calendarId: appointmentsCalendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });
    const busySlots = (apptData.items || [])
      .filter(e => !e.summary?.toUpperCase().includes('DISPONIBLE'))
      .map(e => ({
        start: new Date(e.start.dateTime || e.start.date),
        end: new Date(e.end.dateTime || e.end.date)
      }));

    // Leer ventanas de disponibilidad
    let availabilityWindows = null;
    if (process.env.AVAILABILITY_CALENDAR_ID) {
      availabilityWindows = await getAvailabilityWindows(calendar, timeMin, timeMax);
    }

    // Generar slots
    return generateAvailableSlots(timeMin, timeMax, busySlots, availabilityWindows);

  } catch (err) {
    logger.error('Error consultando Google Calendar', { error: err.message });
    throw err;
  }
}

/**
 * Lee los eventos "DISPONIBLE" del calendario de disponibilidad.
 * Retorna array de { start: Date, end: Date } por cada ventana encontrada.
 */
async function getAvailabilityWindows(calendar, timeMin, timeMax) {
  try {
    const { data } = await calendar.events.list({
      calendarId: process.env.AVAILABILITY_CALENDAR_ID,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    const windows = (data.items || [])
      .filter(e => e.summary?.toUpperCase().includes('DISPONIBLE'))
      .map(e => ({
        start: new Date(e.start.dateTime || e.start.date),
        end: new Date(e.end.dateTime || e.end.date)
      }));

    if (windows.length > 0) {
      logger.info(`Ventanas de disponibilidad leídas desde calendario: ${windows.length}`);
    } else {
      logger.warn('No se encontraron eventos DISPONIBLE en el calendario de disponibilidad — usando fallback de .env');
    }

    return windows.length > 0 ? windows : null;

  } catch (err) {
    logger.warn('Error leyendo calendario de disponibilidad, usando fallback de .env', { error: err.message });
    return null;
  }
}

/**
 * Crea un evento en Google Calendar para la cita.
 * Retorna el ID del evento creado.
 */
async function createEvent(datetime, patientName, reason) {
  try {
    const calendar = getCalendarClient();
    const calendarId = process.env.APPOINTMENTS_CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID || 'primary';
    const duration = parseInt(process.env.APPOINTMENT_DURATION_MINUTES || '60');

    const start = new Date(datetime);
    const end = new Date(start.getTime() + duration * 60 * 1000);

    const { data } = await calendar.events.insert({
      calendarId,
      requestBody: {
        summary: `Turno — ${patientName}`,
        description: `Motivo: ${reason}`,
        start: { dateTime: start.toISOString(), timeZone: 'America/Argentina/Buenos_Aires' },
        end: { dateTime: end.toISOString(), timeZone: 'America/Argentina/Buenos_Aires' },
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 60 },
            { method: 'popup', minutes: 30 }
          ]
        }
      }
    });

    logger.info(`Evento creado en Google Calendar: ${data.id}`);
    return data.id;

  } catch (err) {
    logger.error('Error creando evento en Google Calendar', { error: err.message });
    throw err;
  }
}

/**
 * Cancela (elimina) un evento de Google Calendar
 */
async function cancelEvent(eventId) {
  const calendar = getCalendarClient();
  const calendarsToTry = [
    process.env.APPOINTMENTS_CALENDAR_ID,
    process.env.GOOGLE_CALENDAR_ID || 'primary'
  ].filter(Boolean);

  for (const calendarId of calendarsToTry) {
    try {
      await calendar.events.delete({ calendarId, eventId });
      logger.info(`Evento eliminado de Google Calendar: ${eventId} (calendario: ${calendarId})`);
      return;
    } catch (err) {
      if (err.message?.includes('Not Found') || err.code === 404) {
        continue; // Intentar en el siguiente calendario
      }
      logger.error('Error eliminando evento de Google Calendar', { error: err.message });
      throw err;
    }
  }
  logger.warn(`Evento ${eventId} no encontrado en ningún calendario — puede haber sido eliminado manualmente`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDatePreference(preference) {
  const now = new Date();
  // Calcular "hoy" en timezone Argentina (UTC-3) para no incluir fechas pasadas
  const nowAR = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const today = new Date(nowAR.getFullYear(), nowAR.getMonth(), nowAR.getDate());

  let timeMin, timeMax;

  // Nombres de meses en español (índice 0 = enero)
  const MONTH_NAMES = {
    'enero': 0, 'febrero': 1, 'marzo': 2, 'abril': 3,
    'mayo': 4, 'junio': 5, 'julio': 6, 'agosto': 7,
    'septiembre': 8, 'setiembre': 8, 'octubre': 9,
    'noviembre': 10, 'diciembre': 11
  };

  const lower = (preference || '').toLowerCase().trim();

  if (!preference || lower === 'mañana') {
    timeMin = new Date(today); timeMin.setDate(timeMin.getDate() + 1);
    timeMax = new Date(timeMin); timeMax.setDate(timeMax.getDate() + 1);
  } else if (lower === 'esta semana') {
    timeMin = new Date(today);
    timeMax = new Date(today); timeMax.setDate(timeMax.getDate() + 7);
  } else if (lower === 'próxima semana' || lower === 'proxima semana') {
    timeMin = new Date(today); timeMin.setDate(timeMin.getDate() + 7);
    timeMax = new Date(timeMin); timeMax.setDate(timeMax.getDate() + 7);
  } else if (lower === 'el mes que viene' || lower === 'próximo mes' || lower === 'proximo mes') {
    timeMin = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    timeMax = new Date(timeMin); timeMax.setDate(timeMax.getDate() + 7);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(preference)) {
    timeMin = new Date(preference + 'T00:00:00');
    timeMax = new Date(timeMin); timeMax.setDate(timeMax.getDate() + 1);
  } else if (/^\d{4}-\d{2}$/.test(preference)) {
    // Formato YYYY-MM → primeras dos semanas de ese mes
    const [year, month] = preference.split('-').map(Number);
    timeMin = new Date(year, month - 1, 1);
    timeMax = new Date(timeMin); timeMax.setDate(timeMax.getDate() + 14);
  } else {
    // Detectar nombre de mes con expresiones de período
    let matchedMonth = null;
    let matchedYear = today.getFullYear();

    for (const [name, idx] of Object.entries(MONTH_NAMES)) {
      if (lower.includes(name)) {
        matchedMonth = idx;
        const yearMatch = lower.match(/\b(20\d{2})\b/);
        if (yearMatch) matchedYear = parseInt(yearMatch[1]);
        break;
      }
    }

    if (matchedMonth !== null) {
      const hasExplicitYear = /\b(20\d{2})\b/.test(lower);
      const firstDay = new Date(matchedYear, matchedMonth, 1);
      const lastDay = new Date(matchedYear, matchedMonth + 1, 0); // último día del mes

      // Si el mes ya terminó completamente y no hay año explícito → próximo año
      if (lastDay < today && !hasExplicitYear) {
        matchedYear++;
        firstDay.setFullYear(matchedYear);
        lastDay.setFullYear(matchedYear);
      }

      // Detectar expresiones de período dentro del mes
      const isLastWeek = lower.includes('última semana') || lower.includes('ultima semana') ||
                         lower.includes('últimos días') || lower.includes('ultimos dias');
      const isFirstWeek = lower.includes('primera semana') || lower.includes('principios') ||
                          lower.includes('comienzo') || lower.includes('inicio del mes');
      const isMidMonth = lower.includes('mediados') || lower.includes('mitad del mes');
      const isEndOfMonth = lower.includes('fines de') || lower.includes('fin de mes') ||
                           lower.includes('a fin de') || lower.includes('final del mes');

      if (isLastWeek) {
        // Última semana del mes: últimos 7 días
        timeMin = new Date(lastDay); timeMin.setDate(timeMin.getDate() - 6);
        timeMax = new Date(lastDay); timeMax.setDate(timeMax.getDate() + 1);
        logger.info(`parseDatePreference: "última semana" de mes ${matchedMonth + 1}/${matchedYear} → ${timeMin.toDateString()} a ${timeMax.toDateString()}`);
      } else if (isFirstWeek) {
        timeMin = new Date(firstDay);
        timeMax = new Date(firstDay); timeMax.setDate(timeMax.getDate() + 7);
      } else if (isMidMonth) {
        // Días 11 al 20
        timeMin = new Date(matchedYear, matchedMonth, 11);
        timeMax = new Date(matchedYear, matchedMonth, 21);
      } else if (isEndOfMonth) {
        // Últimos 10 días del mes
        timeMin = new Date(lastDay); timeMin.setDate(timeMin.getDate() - 9);
        timeMax = new Date(lastDay); timeMax.setDate(timeMax.getDate() + 1);
      } else {
        // Nombre de mes genérico: buscar en todo el mes restante
        const isCurrentMonth = matchedMonth === today.getMonth() && matchedYear === today.getFullYear();
        timeMin = isCurrentMonth ? new Date(today) : new Date(firstDay);
        timeMax = new Date(lastDay); timeMax.setDate(timeMax.getDate() + 1);
      }
    } else {
      // Fallback: próximos 5 días
      timeMin = new Date(today);
      timeMax = new Date(today); timeMax.setDate(timeMax.getDate() + 5);
    }
  }

  // Seguridad: nunca buscar en el pasado
  if (timeMin < today) {
    logger.warn(`parseDatePreference: timeMin (${timeMin.toDateString()}) era anterior a hoy — ajustado a hoy`);
    timeMin = new Date(today);
  }

  return { timeMin, timeMax };
}

/**
 * Genera slots disponibles.
 * Si availabilityWindows está definido, solo genera slots dentro de esas ventanas.
 * Si no, usa WORKING_HOURS_START/END del .env como fallback.
 */
function generateAvailableSlots(timeMin, timeMax, busySlots, availabilityWindows) {
  const slots = [];
  const duration = parseInt(process.env.APPOINTMENT_DURATION_MINUTES || '60');
  const now = new Date();

  const MAX_SLOTS_TOTAL = 100; // Alto porque mostramos rangos, no slots individuales
  const MAX_SLOTS_PER_DAY = 20; // Hasta 20hs por día (8:00-20:00 con turnos de 1h = 12 slots)

  if (availabilityWindows && availabilityWindows.length > 0) {
    // Agrupar ventanas por día
    const windowsByDay = {};
    for (const window of availabilityWindows) {
      const dayKey = window.start.toISOString().slice(0, 10);
      if (!windowsByDay[dayKey]) windowsByDay[dayKey] = [];
      windowsByDay[dayKey].push(window);
    }

    for (const dayKey of Object.keys(windowsByDay).sort()) {
      let slotsThisDay = 0;
      for (const window of windowsByDay[dayKey]) {
        const current = new Date(window.start);
        while (current < window.end && slotsThisDay < MAX_SLOTS_PER_DAY && slots.length < MAX_SLOTS_TOTAL) {
          if (current > now) {
            const slotEnd = new Date(current.getTime() + duration * 60 * 1000);
            if (slotEnd <= window.end) {
              const isBusy = busySlots.some(b => current < b.end && slotEnd > b.start);
              if (!isBusy) { slots.push(current.toISOString()); slotsThisDay++; }
            }
          }
          current.setMinutes(current.getMinutes() + duration);
        }
      }
      if (slots.length >= MAX_SLOTS_TOTAL) break;
    }
  } else {
    // Modo fallback: usar variables de entorno
    const workingDays = (process.env.WORKING_DAYS || '1,2,3,4,5')
      .split(',').map(d => parseInt(d.trim()));
    const [startH, startM] = (process.env.WORKING_HOURS_START || '09:00').split(':').map(Number);
    const [endH, endM] = (process.env.WORKING_HOURS_END || '18:00').split(':').map(Number);

    const current = new Date(timeMin);
    current.setHours(startH, startM, 0, 0);
    const limit = new Date(timeMax);
    let lastDay = -1;
    let slotsThisDay = 0;

    while (current < limit && slots.length < MAX_SLOTS_TOTAL) {
      const dayOfWeek = current.getDay();
      const dayKey = current.toDateString();

      if (!workingDays.includes(dayOfWeek)) {
        current.setDate(current.getDate() + 1);
        current.setHours(startH, startM, 0, 0);
        slotsThisDay = 0;
        continue;
      }
      if (dayKey !== lastDay) { lastDay = dayKey; slotsThisDay = 0; }
      if (slotsThisDay >= MAX_SLOTS_PER_DAY) {
        current.setDate(current.getDate() + 1);
        current.setHours(startH, startM, 0, 0);
        slotsThisDay = 0;
        continue;
      }
      if (current <= now) { current.setMinutes(current.getMinutes() + duration); continue; }

      const endOfDay = new Date(current);
      endOfDay.setHours(endH, endM, 0, 0);
      if (current >= endOfDay) {
        current.setDate(current.getDate() + 1);
        current.setHours(startH, startM, 0, 0);
        slotsThisDay = 0;
        continue;
      }

      const slotEnd = new Date(current.getTime() + duration * 60 * 1000);
      const isBusy = busySlots.some(b => current < b.end && slotEnd > b.start);
      if (!isBusy) { slots.push(current.toISOString()); slotsThisDay++; }
      current.setMinutes(current.getMinutes() + duration);
    }
  }

  return slots;
}

module.exports = { getAvailableSlots, createEvent, cancelEvent };
