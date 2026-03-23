import 'dotenv/config';
import express from 'express';
import { config } from './config';
import { connectRedis } from './memory/redis';
import { chatRouter } from './routes/chat';
import { stagesRouter } from './routes/stages';
import { sendExternalRouter } from './routes/sendExternal';
import { typingRouter } from './routes/typing';

const app = express();

app.use(express.json({ limit: '5mb' }));

// Routes
app.use('/api/chat', chatRouter);
app.use('/api/stages', stagesRouter);
app.use('/api/send-external', sendExternalRouter);
app.use('/api/typing', typingRouter);

// Root health
app.get('/', (_req, res) => res.json({ service: 'fast-agent-api', status: 'ok' }));

// Start
async function start() {
  try {
    await connectRedis();
    app.listen(config.port, () => {
      console.log(`[Server] Running on port ${config.port}`);
      console.log(`[Server] POST http://localhost:${config.port}/api/chat`);
    });
  } catch (err) {
    console.error('[Server] Failed to start:', err);
    process.exit(1);
  }
}

start();
