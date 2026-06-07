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
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let timeMin, timeMax;

  if (!preference || preference === 'mañana') {
    timeMin = new Date(today); timeMin.setDate(timeMin.getDate() + 1);
    timeMax = new Date(timeMin); timeMax.setDate(timeMax.getDate() + 1);
  } else if (preference === 'esta semana') {
    timeMin = new Date(today);
    timeMax = new Date(today); timeMax.setDate(timeMax.getDate() + 7);
  } else if (preference === 'próxima semana') {
    timeMin = new Date(today); timeMin.setDate(timeMin.getDate() + 7);
    timeMax = new Date(timeMin); timeMax.setDate(timeMax.getDate() + 7);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(preference)) {
    timeMin = new Date(preference);
    timeMax = new Date(preference); timeMax.setDate(timeMax.getDate() + 1);
  } else {
    timeMin = new Date(today);
    timeMax = new Date(today); timeMax.setDate(timeMax.getDate() + 5);
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
