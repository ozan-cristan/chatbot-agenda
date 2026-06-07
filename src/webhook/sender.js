const axios = require('axios');
const logger = require('../utils/logger');

const BASE_URL = 'https://graph.facebook.com/v19.0';

/**
 * Envía un mensaje de texto simple al paciente
 */
async function sendText(phone, text) {
  return callApi({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'text',
    text: { body: text }
  });
}

/**
 * Envía una lista de opciones (botones rápidos, máx 3)
 */
async function sendButtons(phone, bodyText, buttons) {
  const buttonList = buttons.map((b, i) => ({
    type: 'reply',
    reply: { id: `btn_${i}`, title: b }
  }));

  return callApi({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: { buttons: buttonList }
    }
  });
}

/**
 * Envía el template de recordatorio aprobado por Meta
 * Variables: [nombre_paciente, nombre_consultorio, hora_cita]
 */
async function sendReminderTemplate(phone, patientName, hour) {
  return callApi({
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: 'appointment_reminder',
      language: { code: 'es' },
      components: [{
        type: 'body',
        parameters: [
          { type: 'text', text: patientName },
          { type: 'text', text: process.env.CLINIC_NAME },
          { type: 'text', text: hour }
        ]
      }]
    }
  });
}

/**
 * Llamada base a la API de Meta
 */
async function callApi(payload) {
  try {
    const response = await axios.post(
      `${BASE_URL}/${process.env.PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    logger.info(`Mensaje enviado a ${payload.to}`);
    return response.data;
  } catch (err) {
    const detail = err.response?.data || err.message;
    logger.error('Error enviando mensaje a Meta', { detail });
    throw err;
  }
}

module.exports = { sendText, sendButtons, sendReminderTemplate };
