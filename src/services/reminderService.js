const cron = require('node-cron');
const { getAppointmentsForReminder, markReminderSent } = require('./appointmentService');
const { sendReminderTemplate, sendText } = require('../webhook/sender');
const logger = require('../utils/logger');

/**
 * Inicia el job de recordatorios automáticos.
 * Corre cada hora para buscar citas que necesiten recordatorio.
 */
function startReminderJob() {
  const hours = parseInt(process.env.REMINDER_HOURS_BEFORE || '24');

  // Ejecutar cada hora en el minuto 0
  cron.schedule('0 * * * *', async () => {
    logger.info('Job de recordatorios ejecutando...');
    await sendReminders(hours);
  });

  logger.info(`Job de recordatorios iniciado — envía ${hours}hs antes del turno`);
}

/**
 * Busca citas próximas y envía recordatorios
 */
async function sendReminders(hoursBeforeAppointment) {
  try {
    const appointments = await getAppointmentsForReminder(hoursBeforeAppointment);

    if (!appointments.length) {
      logger.info('No hay recordatorios para enviar');
      return;
    }

    logger.info(`Enviando ${appointments.length} recordatorio(s)`);

    for (const appt of appointments) {
      try {
        const phone = appt.patients.phone;
        const name = appt.patients.name || 'Paciente';
        const dt = new Date(appt.datetime);
        const hour = dt.toLocaleString('es-AR', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'America/Argentina/Buenos_Aires'
        });

        // Intentar con template aprobado; si falla, usar texto simple
        try {
          await sendReminderTemplate(phone, name, hour);
        } catch (templateErr) {
          logger.warn('Template no disponible, usando texto simple', { error: templateErr.message });
          const dateStr = dt.toLocaleString('es-AR', {
            weekday: 'long', day: 'numeric', month: 'long',
            hour: '2-digit', minute: '2-digit',
            timeZone: 'America/Argentina/Buenos_Aires'
          });
          await sendText(
            phone,
            `Hola ${name}, te recordamos que tenés un turno en ${process.env.CLINIC_NAME} mañana a las ${hour} (${dateStr}).\n\nRespondé CONFIRMO para confirmar o CANCELAR para cancelar.`
          );
        }

        await markReminderSent(appt.id);
        logger.info(`Recordatorio enviado a ${phone} para turno ${appt.id}`);

      } catch (err) {
        logger.error(`Error enviando recordatorio para cita ${appt.id}`, { error: err.message });
      }
    }

  } catch (err) {
    logger.error('Error en job de recordatorios', { error: err.message });
  }
}

module.exports = { startReminderJob };
