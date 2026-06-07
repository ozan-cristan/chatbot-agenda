const { supabase } = require('../integrations/supabase');
const logger = require('../utils/logger');

/**
 * Obtiene un paciente por teléfono (retorna null si no existe)
 */
async function getPatient(phone) {
  const { data } = await supabase
    .from('patients')
    .select('id, name, phone')
    .eq('phone', phone)
    .single();
  return data || null;
}

/**
 * Crea o actualiza un paciente por número de teléfono
 */
async function upsertPatient(phone, name = null) {
  const payload = {
    phone,
    last_contact: new Date().toISOString()
  };
  if (name) payload.name = name;

  const { error } = await supabase
    .from('patients')
    .upsert(payload, { onConflict: 'phone' });

  if (error) {
    logger.error('Error en upsertPatient', { phone, error: error.message });
  }
}

/**
 * Guarda una nueva cita en Supabase
 */
async function createAppointment(phone, googleEventId, datetime, reason) {
  // Obtener patient_id
  const { data: patient, error: pErr } = await supabase
    .from('patients')
    .select('id')
    .eq('phone', phone)
    .single();

  if (pErr || !patient) {
    logger.error('Paciente no encontrado al crear cita', { phone });
    throw new Error('Paciente no encontrado');
  }

  const { data, error } = await supabase
    .from('appointments')
    .insert({
      patient_id: patient.id,
      google_event_id: googleEventId,
      datetime,
      reason,
      status: 'confirmed'
    })
    .select()
    .single();

  if (error) {
    logger.error('Error creando cita', { error: error.message });
    throw error;
  }

  logger.info(`Cita creada: ${data.id}`);
  return data;
}

/**
 * Retorna los turnos activos (confirmados) de un paciente, ordenados por fecha
 */
async function getPatientAppointments(phone) {
  const { data: patient } = await supabase
    .from('patients')
    .select('id')
    .eq('phone', phone)
    .single();

  if (!patient) return [];

  const { data, error } = await supabase
    .from('appointments')
    .select('*')
    .eq('patient_id', patient.id)
    .eq('status', 'confirmed')
    .gte('datetime', new Date().toISOString())
    .order('datetime', { ascending: true });

  if (error) {
    logger.error('Error obteniendo citas', { error: error.message });
    return [];
  }

  return data || [];
}

/**
 * Marca una cita como cancelada
 */
async function cancelAppointment(appointmentId) {
  const { error } = await supabase
    .from('appointments')
    .update({ status: 'cancelled' })
    .eq('id', appointmentId);

  if (error) {
    logger.error('Error cancelando cita', { appointmentId, error: error.message });
    throw error;
  }
}

/**
 * Obtiene citas que requieren recordatorio (24hs antes, no enviado aún)
 */
async function getAppointmentsForReminder(hoursBeforeAppointment = 24) {
  const now = new Date();
  const windowStart = new Date(now.getTime() + (hoursBeforeAppointment - 1) * 60 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + (hoursBeforeAppointment + 1) * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from('appointments')
    .select(`
      *,
      patients (phone, name)
    `)
    .eq('status', 'confirmed')
    .eq('reminder_sent', false)
    .gte('datetime', windowStart.toISOString())
    .lte('datetime', windowEnd.toISOString());

  if (error) {
    logger.error('Error obteniendo citas para recordatorio', { error: error.message });
    return [];
  }

  return data || [];
}

/**
 * Marca el recordatorio como enviado
 */
async function markReminderSent(appointmentId) {
  await supabase
    .from('appointments')
    .update({ reminder_sent: true })
    .eq('id', appointmentId);
}

module.exports = {
  getPatient,
  upsertPatient,
  createAppointment,
  getPatientAppointments,
  cancelAppointment,
  getAppointmentsForReminder,
  markReminderSent
};
