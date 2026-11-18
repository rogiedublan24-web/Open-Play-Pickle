window.APP_CONFIG = {
  API_BASE: location.hostname.endsWith('.vercel.app')
    ? 'https://ANG-API-MO.vercel.app/api'
    : 'http://' + location.hostname + ':3000/api',
  POLL_MS: 5000
};