import express from 'express';

const app = express();
const PORT = process.env.PORT || 8080;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Quantum Scraper v2 is alive' });
});

app.post('/run', async (req, res) => {
  res.send('Scrape started — check Railway logs for progress');
  console.log('Manual scrape triggered via /run');
  // TODO: scraper logic will go here after we confirm server works
});

app.listen(PORT, () => {
  console.log(`Quantum Scraper listening on port ${PORT}`);
});

console.log('Quantum Scraper v2 minimal server started');