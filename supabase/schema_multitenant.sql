-- ============================================================
-- WhatsApp Appointment Bot — Schema Multi-tenant
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query
-- IMPORTANTE: Ejecutar DESPUÉS del schema.sql original
-- ============================================================

-- ── 1. Tabla tenants ─────────────────────────────────────────
-- Un registro por consultorio/cliente
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,                        -- "Consultorio Dr. García"
    phone_number_id VARCHAR(50) UNIQUE NOT NULL,       -- ID de Meta (PHONE_NUMBER_ID)
    whatsapp_token TEXT NOT NULL,                      -- Token de WhatsApp Cloud API
    verify_token VARCHAR(100),                         -- Token de verificación del webhook
    anthropic_api_key TEXT,                            -- API key de Claude (opcional, puede ser compartida)
    google_client_id TEXT,
    google_client_secret TEXT,
    google_refresh_token TEXT,
    availability_calendar_id TEXT,                     -- Calendario "DISPONIBLE"
    appointments_calendar_id TEXT,                     -- Calendario de turnos
    clinic_address VARCHAR(300),
    appointment_duration_minutes INTEGER DEFAULT 60,
    working_hours_start VARCHAR(5) DEFAULT '09:00',
    working_hours_end VARCHAR(5) DEFAULT '18:00',
    working_days VARCHAR(20) DEFAULT '1,2,3,4,5',
    reminder_hours_before INTEGER DEFAULT 24,
    bot_name VARCHAR(50) DEFAULT 'Sol',                -- Nombre del asistente virtual
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ── 2. Migrar tabla patients ──────────────────────────────────
-- Agregar tenant_id; phone pasa a ser único por tenant (no global)
ALTER TABLE patients
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

-- Eliminar el UNIQUE global en phone y crear uno compuesto
ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_phone_key;
ALTER TABLE patients ADD CONSTRAINT patients_phone_tenant_unique UNIQUE (phone, tenant_id);

-- ── 3. Migrar tabla appointments ──────────────────────────────
-- Agregar tenant_id directo para queries eficientes sin JOIN
ALTER TABLE appointments
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

-- ── 4. Migrar tabla conversation_state ───────────────────────
-- phone deja de ser PK única global; la PK pasa a ser (phone, tenant_id)
ALTER TABLE conversation_state DROP CONSTRAINT IF EXISTS conversation_state_pkey;
ALTER TABLE conversation_state
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE conversation_state
    ADD PRIMARY KEY (phone, tenant_id);

-- ── 5. Índices ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_patients_tenant_id ON patients(tenant_id);
CREATE INDEX IF NOT EXISTS idx_appointments_tenant_id ON appointments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenants_phone_number_id ON tenants(phone_number_id);

-- ── 6. Trigger: updated_at automático en tenants ─────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenants_updated_at ON tenants;
CREATE TRIGGER tenants_updated_at
    BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── 7. Insertar tenant de desarrollo (datos del .env actual) ──
-- Reemplazá los valores con los de tu .env antes de ejecutar
INSERT INTO tenants (
    name,
    phone_number_id,
    whatsapp_token,
    verify_token,
    availability_calendar_id,
    appointments_calendar_id,
    clinic_address,
    appointment_duration_minutes,
    working_hours_start,
    working_hours_end,
    working_days,
    bot_name
) VALUES (
    'Consultorio Dr. Ejemplo',
    '1079050985299009',
    'TU_WHATSAPP_TOKEN',        -- del .env: WHATSAPP_TOKEN
    'itop_verify_2024',
    '35e52b227d97281d4cc1d659a4408dde1ce6a3631886d66cb74e3b77aa693849@group.calendar.google.com',
    'd37519c7dc45b193daee803480eeaa1f8b41b39249948d5f0e4cc0524ff15c10@group.calendar.google.com',
    'Av. Siempreviva 742, Rosario',
    60,
    '09:00',
    '18:00',
    '1,2,3,4,5',
    'Sol'
) ON CONFLICT (phone_number_id) DO NOTHING;
