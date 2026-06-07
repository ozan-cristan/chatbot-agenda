require('dotenv').config();
const express = require('express');
const { verifyWebhook, handleIncoming } = require('./webhook/receiver');
const { startReminderJob } = require('./services/reminderService');
const logger = require('./utils/logger');

const app = express();
app.use(express.json());

// GET — verificación del webhook por Meta
app.get('/webhook', verifyWebhook);

// POST — mensajes entrantes
app.post('/webhook', handleIncoming);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Servidor corriendo en puerto ${PORT}`);
  startReminderJob();
});
