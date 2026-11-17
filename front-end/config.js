// Shared settings for the public page (app.js) and the admin page (admin.js).
// Change the API address here only. The event details (venue, fee, date, ...)
// are now edited from the admin page and stored in the database.
window.APP_CONFIG = {
  API_BASE: 'http://localhost:3000/api',
  POLL_MS: 5000, // how often the live slots refresh (milliseconds)


  
};