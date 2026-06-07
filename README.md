# WhatsApp Appointment Bot

Bot conversacional para agendamiento de turnos médicos vía WhatsApp.

## Arranque rápido (local)

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
# Editar .env con tus credenciales
```

### 3. Crear tablas en Supabase

1. Ir a [supabase.com](https://supabase.com) → tu proyecto → SQL Editor
2. Copiar y ejecutar el contenido de `supabase/schema.sql`

### 4. Obtener Google Refresh Token (una sola vez)

1. Ir a [OAuth2 Playground](https://developers.google.com/oauthplayground)
2. Clic en ⚙️ → tildar "Use your own OAuth credentials"
3. Ingresar `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`
4. Buscar "Google Calendar API v3" → scope `https://www.googleapis.com/auth/calendar`
5. Autorizar → Exchange authorization code for tokens
6. Copiar `refresh_token` → pegar en `.env`

### 5. Iniciar el servidor

```bash
npm run dev
```

### 6. Exponer con ngrok

```bash
# En otra terminal
ngrok http 3000
# Copiar la URL https://xxxx.ngrok.io
```

### 7. Configurar webhook en Meta

1. Meta for Developers → tu App → WhatsApp → Configuration
2. Webhook URL: `https://xxxx.ngrok.io/webhook`
3. Verify Token: el valor de `VERIFY_TOKEN` en tu `.env`
4. Suscribirse al campo **messages**

---

## Estructura

```
src/
├── index.js                  # Servidor Express
├── webhook/
│   ├── receiver.js           # Recibe mensajes de Meta
│   └── sender.js             # Envía mensajes a Meta
├── conversation/
│   ├── processor.js          # Orquesta el flujo
│   ├── stateManager.js       # Estado en Supabase
│   └── prompt.js             # Prompt para Claude
├── integrations/
│   ├── claude.js             # Claude API
│   ├── googleCalendar.js     # Google Calendar
│   └── supabase.js           # Cliente Supabase
├── services/
│   ├── appointmentService.js # Lógica de citas
│   └── reminderService.js    # Recordatorios automáticos
└── utils/
    └── logger.js
```

## Notas

- `WHATSAPP_TOKEN` debe ser un **System User Token** permanente, no el temporal de la consola
- La ventana de mensajería de Meta es de **24 horas** desde el último mensaje del usuario
- Para recordatorios fuera de esa ventana se necesita un Message Template aprobado por Meta
