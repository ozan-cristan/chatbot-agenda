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
 * Envía botones de respuesta rápida (máx 3).
 * buttons: array de { id, title } o strings (usa title como id)
 */
async function sendButtons(phone, bodyText, buttons) {
  const buttonList = buttons.map((b) => ({
    type: 'reply',
    reply: {
      id: typeof b === 'string' ? b : b.id,
      title: typeof b === 'string' ? b : b.title
    }
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
 * Envía una lista interactiva (máx 10 opciones por sección).
 * sections: [{ title: string, rows: [{ id, title, description? }] }]
 * buttonText: texto del botón que abre la lista (máx 20 chars)
 */
async function sendList(phone, bodyText, sections, buttonText = 'Ver opciones') {
  return callApi({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: buttonText.substring(0, 20),
        sections: sections.map(s => ({
          title: s.title.substring(0, 24),
          rows: s.rows.map(r => ({
            id: String(r.id).substring(0, 200),
            title: String(r.title).substring(0, 24),
            ...(r.description ? { description: String(r.description).substring(0, 72) } : {})
          }))
        }))
      }
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

module.exports = { sendText, sendButtons, sendList, sendReminderTemplate };
