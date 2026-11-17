class AppError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

// Forwards errors from async route handlers to the error middleware
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function notFound(req, res, next) {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
}

// Express recognizes an error handler by its 4 parameters
function errorHandler(err, req, res, next) {
  let status = err.status || 500;
  let message = err.message || 'Something went wrong';
  let details;

  if (err.name === 'ValidationError') {
    // Mongoose schema validation failed
    status = 400;
    message = 'Validation failed';
    details = Object.values(err.errors).map((e) => e.message);
  } else if (err.name === 'CastError') {
    // e.g. a malformed ObjectId in the URL
    status = 400;
    message = `Invalid value for "${err.path}"`;
  } else if (err.type === 'entity.parse.failed') {
    // Malformed JSON in the request body
    status = 400;
    message = 'Invalid JSON body';
  } else if (err.code === 11000) {
    status = 409;
    message = 'Duplicate record';
  }

  if (status >= 500) {
    console.error(err);                 // full details only in the server log
    message = 'Internal server error';  // never leak internals to the client
  }

  res.status(status).json({ message, ...(details && { details }) });
}

module.exports = { AppError, asyncHandler, notFound, errorHandler };