import express from 'express';

const app = express();
const PORT = process.env.PORT || 8080;

app.get('/health', (req, res) => {
  res.send('OK');
});

app.post('/run', (req, res) => {
  console.log('=== MANUAL SCRAPE TRIGGERED ===');
  res.send('Scrape started — check Railway logs');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});

console.log('Minimal Express server started');