const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { QueueStore } = require('./queue');
const { parseIntent, explainWait, aiEnabled } = require('./ai');

const store = new QueueStore().seed();
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- WebSocket live sync -----------------------------------------------------
// Clients subscribe to a center. Any queue change broadcasts fresh state so
// every citizen's phone and the operator dashboard update instantly.
function broadcastCenter(centerId) {
  const center = store.getCenter(centerId);
  if (!center) return;
  const payload = JSON.stringify({
    type: 'center_update',
    center: store.centerSummary(center),
    nowServing: center.nowServing ? center.nowServing.number : null,
    waiting: center
      .waitingTokens()
      .sort((a, b) => a.number - b.number)
      .map((t) => ({ number: t.number, service: t.service, source: t.source })),
  });
  wss.clients.forEach((c) => {
    if (c.readyState === 1 && c.centerId === centerId) c.send(payload);
  });
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'subscribe' && msg.centerId) {
        ws.centerId = msg.centerId;
        const center = store.getCenter(msg.centerId);
        if (center) {
          ws.send(
            JSON.stringify({
              type: 'center_update',
              center: store.centerSummary(center),
              nowServing: center.nowServing ? center.nowServing.number : null,
              waiting: center
                .waitingTokens()
                .sort((a, b) => a.number - b.number)
                .map((t) => ({ number: t.number, service: t.service, source: t.source })),
            })
          );
        }
      }
    } catch (_) {
      /* ignore malformed */
    }
  });
});

// --- REST API ----------------------------------------------------------------

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, aiEnabled: aiEnabled() })
);

app.get('/api/centers', (_req, res) => res.json(store.listCenters()));

// Multilingual intake: free text (typed or from speech-to-text) -> service.
app.post('/api/intake', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  const intent = await parseIntent(text);
  res.json(intent);
});

// Issue a token to a citizen.
app.post('/api/centers/:id/tokens', async (req, res) => {
  try {
    const { service, name, phone, source } = req.body || {};
    const { token, position } = store.issueToken(req.params.id, {
      service,
      name,
      phone,
      source,
    });
    const center = store.getCenter(req.params.id);
    const estimateWaitSeconds = store.estimateWaitSeconds(center, token);
    const message = await explainWait({
      language: req.body.language,
      position,
      estimateWaitSeconds,
      serviceLabel: token.serviceLabel,
      centerName: center.name,
    });
    broadcastCenter(req.params.id);
    res.json({ token, position, estimateWaitSeconds, message });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Live status for a citizen's token.
app.get('/api/tokens/:id', (req, res) => {
  const status = store.getTokenStatus(req.params.id);
  if (!status) return res.status(404).json({ error: 'Token not found' });
  res.json(status);
});

// One-tap push-back if the citizen will miss their turn.
app.post('/api/tokens/:id/pushback', (req, res) => {
  try {
    const status = store.pushBack(req.params.id, req.body?.spots || 3);
    broadcastCenter(status.centerId);
    res.json(status);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Operator: advance to next token.
app.post('/api/centers/:id/advance', (req, res) => {
  try {
    const nowServing = store.advance(req.params.id);
    broadcastCenter(req.params.id);
    res.json({ nowServing: nowServing ? nowServing.number : null });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Operator: register a walk-in (hybrid queue — synced same as digital tokens).
app.post('/api/centers/:id/walkin', (req, res) => {
  try {
    const { token, position } = store.issueToken(req.params.id, {
      service: req.body?.service || 'general',
      name: req.body?.name || 'Walk-in',
      source: 'walkin',
    });
    broadcastCenter(req.params.id);
    res.json({ token, position });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`QueueSync running on http://localhost:${PORT}`);
  console.log(`  Citizen app: http://localhost:${PORT}/`);
  console.log(`  Operator:    http://localhost:${PORT}/operator.html`);
  console.log(`  Gemini AI:   ${aiEnabled() ? 'ENABLED' : 'fallback mode (set GEMINI_API_KEY)'}`);
});
