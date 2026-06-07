-- ============================================================
-- WhatsApp Appointment Bot — Schema Supabase
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- Pacientes
CREATE TABLE IF NOT EXISTS patients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW(),
    last_contact TIMESTAMP
);

-- Citas
CREATE TABLE IF NOT EXISTS appointments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
    google_event_id VARCHAR(200),
    datetime TIMESTAMP NOT NULL,
    reason TEXT,
    status VARCHAR(20) DEFAULT 'confirmed',  -- confirmed | cancelled | rescheduled
    reminder_sent BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Estado de conversación (una fila por número de teléfono activo)
CREATE TABLE IF NOT EXISTS conversation_state (
    phone VARCHAR(20) PRIMARY KEY,
    state VARCHAR(50) DEFAULT 'idle',
    context JSONB DEFAULT '{}',
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Índices útiles
CREATE INDEX IF NOT EXISTS idx_appointments_patient_id ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_appointments_datetime ON appointments(datetime);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_appointments_reminder ON appointments(reminder_sent, datetime) WHERE status = 'confirmed';

-- Row Level Security (opcional pero recomendado)
-- Si usás la Service Key en el backend, RLS no aplica para esas llamadas
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_state ENABLE ROW LEVEL SECURITY;
