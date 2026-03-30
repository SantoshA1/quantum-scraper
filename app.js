import express from 'express';

const app = express();
const PORT = process.env.PORT || 8080;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is alive' });
});

app.post('/run', (req, res) => {
  res.send('Scrape started — check Railway logs');
  console.log('Manual scrape triggered');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

console.log('Quantum Scraper minimal server started');