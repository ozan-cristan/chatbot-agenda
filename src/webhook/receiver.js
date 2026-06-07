const crypto = require('crypto');
const { processMessage } = require('../conversation/processor');
const logger = require('../utils/logger');

/**
 * GET /webhook — Meta verifica el endpoint con un challenge
 */
function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    logger.info('Webhook verificado por Meta');
    return res.status(200).send(challenge);
  }

  logger.warn('Fallo en verificación de webhook', { mode, token });
  res.sendStatus(403);
}

/**
 * POST /webhook — Mensajes entrantes de Meta
 */
async function handleIncoming(req, res) {
  // Responder 200 inmediatamente (Meta requiere respuesta < 20s)
  res.sendStatus(200);

  try {
    // Validar firma HMAC-SHA256
    if (!isValidSignature(req)) {
      logger.warn('Firma HMAC inválida — mensaje descartado');
      return;
    }

    const body = req.body;

    if (body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Ignorar notificaciones de estado (delivered, read, etc.)
    if (value?.statuses) return;

    const messages = value?.messages;
    if (!messages?.length) return;

    const message = messages[0];
    const phone = message.from;
    const messageId = message.id;

    let text = '';
    if (message.type === 'text') {
      text = message.text.body;
    } else if (message.type === 'interactive') {
      // Usar el id de la respuesta (contiene el dato real: fecha ISO, "SI", "NO")
      // y el title como fallback para compatibilidad
      text = message.interactive?.button_reply?.id
        || message.interactive?.list_reply?.id
        || message.interactive?.button_reply?.title
        || message.interactive?.list_reply?.title
        || '';
    } else {
      logger.info(`Tipo de mensaje no soportado: ${message.type}`, { phone });
      return;
    }

    logger.info(`Mensaje recibido de ${phone}: "${text}"`);
    await processMessage(phone, text, messageId);

  } catch (err) {
    logger.error('Error procesando mensaje entrante', { error: err.message });
  }
}

/**
 * Valida la firma X-Hub-Signature-256 que envía Meta
 */
function isValidSignature(req) {
  // En desarrollo podemos saltar la validación si no hay app secret
  if (process.env.NODE_ENV === 'development' && !process.env.WHATSAPP_APP_SECRET) {
    return true;
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.WHATSAPP_APP_SECRET)
    .update(JSON.stringify(req.body))
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

module.exports = { verifyWebhook, handleIncoming };
