const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const slotsRoutes = require('./routes/slots');
const registrationsRoutes = require('./routes/registrations');
const settingsRoutes = require('./routes/settings');
const eventRoutes = require('./routes/event');
const { AppError, notFound, errorHandler } = require('./middleware/errors');

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(helmet());

app.use(
  cors({
    origin(origin, callback) {
      // Requests without an Origin header (curl, Postman) are allowed.
      // Browsers always send one, so only listed websites can call the API.
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new AppError('Origin not allowed by CORS', 403));
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-admin-key'],
  })
);

app.use(express.json({ limit: '10kb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api', slotsRoutes);                       // GET /api/slots, GET /api/players
app.use('/api/registrations', registrationsRoutes); // POST public, GET/PATCH/DELETE admin
app.use('/api/settings', settingsRoutes);           // PATCH admin
app.use('/api/event', eventRoutes);                 // GET public, PATCH admin

app.use(notFound);
app.use(errorHandler);

module.exports = app;