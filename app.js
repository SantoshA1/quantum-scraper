import express from 'express';

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Quantum Scraper v2 is alive and listening' });
});

app.post('/run', async (req, res) => {
  console.log('Manual scrape triggered via /run');
  res.send('Scrape started — check Railway logs for progress');
  // TODO: full scraper logic will go here
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Quantum Scraper listening on http://0.0.0.0:${PORT}`);
});

console.log('Quantum Scraper minimal server started');