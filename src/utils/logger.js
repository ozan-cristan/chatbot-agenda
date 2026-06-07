/**
 * Logger simple con niveles y timestamp.
 * En producción se podría reemplazar por winston o pino.
 */
const logger = {
  info(message, meta = {}) {
    console.log(JSON.stringify({ level: 'INFO', ts: new Date().toISOString(), message, ...meta }));
  },
  warn(message, meta = {}) {
    console.warn(JSON.stringify({ level: 'WARN', ts: new Date().toISOString(), message, ...meta }));
  },
  error(message, meta = {}) {
    console.error(JSON.stringify({ level: 'ERROR', ts: new Date().toISOString(), message, ...meta }));
  }
};

module.exports = logger;
