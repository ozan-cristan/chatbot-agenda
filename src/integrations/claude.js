const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Llama a Claude con el system prompt y el historial de mensajes.
 * Retorna el texto de la respuesta (JSON string).
 */
async function askClaude(systemPrompt, messages) {
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages
    });

    const text = response.content[0]?.text || '';
    logger.info('Respuesta de Claude recibida', { tokens: response.usage });
    return text;

  } catch (err) {
    logger.error('Error llamando a Claude', { error: err.message });
    throw err;
  }
}

module.exports = { askClaude };
