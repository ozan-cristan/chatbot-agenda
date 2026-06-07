const { supabase } = require('../integrations/supabase');
const logger = require('../utils/logger');

/**
 * Obtiene o crea el estado de conversación para un número de teléfono
 */
async function getState(phone) {
  const { data, error } = await supabase
    .from('conversation_state')
    .select('*')
    .eq('phone', phone)
    .single();

  if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
    logger.error('Error leyendo estado', { phone, error: error.message });
    throw error;
  }

  if (!data) {
    return { state: 'idle', context: {} };
  }

  return { state: data.state, context: data.context || {} };
}

/**
 * Guarda/actualiza el estado de conversación
 */
async function setState(phone, state, context = {}) {
  const { error } = await supabase
    .from('conversation_state')
    .upsert({
      phone,
      state,
      context,
      updated_at: new Date().toISOString()
    }, { onConflict: 'phone' });

  if (error) {
    logger.error('Error guardando estado', { phone, error: error.message });
    throw error;
  }
}

/**
 * Agrega un turno al historial de conversación en el contexto
 * (máximo 10 turnos para no inflar el contexto de Claude)
 */
function appendHistory(context, role, content) {
  const history = context.history || [];
  history.push({ role, content });

  // Mantener solo los últimos 6 mensajes (3 turnos)
  if (history.length > 6) {
    history.splice(0, history.length - 6);
  }

  return { ...context, history };
}

/**
 * Resetea el estado a idle (fin de conversación o timeout)
 */
async function resetState(phone) {
  await setState(phone, 'idle', {});
  logger.info(`Estado reseteado para ${phone}`);
}

module.exports = { getState, setState, appendHistory, resetState };
