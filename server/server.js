const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const {
  QueueStore,
} = require('./queue');

const {
  parseIntent,
  explainWait,
  aiEnabled,
} = require('./ai');

const store = new QueueStore();

const app = express();

app.use(express.json());

app.use(
  express.static(
    path.join(__dirname, '..', 'public')
  )
);

const server = http.createServer(app);

const wss =
  new WebSocketServer({
    server,
  });

// -----------------------------------------------------------------------------
// WebSocket live sync
// -----------------------------------------------------------------------------

function broadcastCenter(centerId) {
  const center =
    store.getCenter(centerId);

  if (!center) return;

  const payload =
    JSON.stringify({
      type: 'center_update',

      center:
        store.centerSummary(center),

      nowServing:
        center.nowServing
          ? center.nowServing.number
          : null,

      waiting:
        center
          .waitingTokens()
          .sort(compareWaitingTokens)
          .map((t) => ({
            id: t.id,
            number: t.number,
            service: t.service,
            source: t.source,
            priority: Boolean(t.priority),
            priorityNumber:
              t.priorityNumber || null,
            tokenId: t.id,
          })),
    });

  wss.clients.forEach(
    (client) => {
      if (
        client.readyState === 1 &&
        client.centerId === centerId
      ) {
        client.send(payload);
      }
    }
  );
}

// Keep priority tokens before normal tokens
// in WebSocket updates as well.
function compareWaitingTokens(a, b) {
  const aPriority =
    Boolean(a.priority);

  const bPriority =
    Boolean(b.priority);

  if (aPriority && !bPriority) {
    return -1;
  }

  if (!aPriority && bPriority) {
    return 1;
  }

  if (aPriority && bPriority) {
    return (
      (Number(a.priorityNumber) || 0) -
      (Number(b.priorityNumber) || 0)
    );
  }

  return (
    (Number(a.number) || 0) -
    (Number(b.number) || 0)
  );
}

wss.on(
  'connection',
  (ws) => {
    ws.on(
      'message',
      (raw) => {
        try {
          const msg =
            JSON.parse(raw);

          if (
            msg.type === 'subscribe' &&
            msg.centerId
          ) {
            ws.centerId =
              msg.centerId;

            const center =
              store.getCenter(
                msg.centerId
              );

            if (center) {
              ws.send(
                JSON.stringify({
                  type:
                    'center_update',

                  center:
                    store.centerSummary(
                      center
                    ),

                  nowServing:
                    center.nowServing
                      ? center
                          .nowServing
                          .number
                      : null,

                  waiting:
                    center
                      .waitingTokens()
                      .sort(
                        compareWaitingTokens
                      )
                      .map((t) => ({
                        id: t.id,
                        number:
                          t.number,
                        service:
                          t.service,
                        source:
                          t.source,
                        priority:
                          Boolean(
                            t.priority
                          ),
                        priorityNumber:
                          t.priorityNumber ||
                          null,
                        tokenId:
                          t.id,
                      })),
                })
              );
            }
          }
        } catch (_) {
          // Ignore malformed WebSocket messages.
        }
      }
    );
  }
);

// -----------------------------------------------------------------------------
// REST API
// -----------------------------------------------------------------------------

app.get(
  '/api/health',
  (_req, res) => {
    res.json({
      ok: true,
      aiEnabled: aiEnabled(),
      firestore: true,
    });
  }
);

app.get(
  '/api/centers',
  (_req, res) => {
    res.json(
      store.listCenters()
    );
  }
);

// -----------------------------------------------------------------------------
// Multilingual intake
// -----------------------------------------------------------------------------

app.post(
  '/api/intake',
  async (req, res) => {
    const { text } =
      req.body || {};

    if (!text) {
      return res
        .status(400)
        .json({
          error:
            'text required',
        });
    }

    const intent =
      await parseIntent(text);

    res.json(intent);
  }
);

// -----------------------------------------------------------------------------
// Issue token
// -----------------------------------------------------------------------------

app.post(
  '/api/centers/:id/tokens',
  async (req, res) => {
    try {
      const {
        service,
        name,
        phone,
        source,
      } = req.body || {};

      const {
        token,
        position,
      } =
        await store.issueToken(
          req.params.id,
          {
            service,
            name,
            phone,
            source,
          }
        );

      const center =
        store.getCenter(
          req.params.id
        );

      const estimateWaitSeconds =
        store.estimateWaitSeconds(
          center,
          token
        );

      const message =
        await explainWait({
          language:
            req.body.language,

          position,

          estimateWaitSeconds,

          serviceLabel:
            token.serviceLabel,

          centerName:
            center.name,
        });

      broadcastCenter(
        req.params.id
      );

      res.json({
        token,
        position,
        estimateWaitSeconds,
        message,
      });
    } catch (e) {
      res
        .status(400)
        .json({
          error: e.message,
        });
    }
  }
);

// -----------------------------------------------------------------------------
// Token status
// -----------------------------------------------------------------------------

app.get(
  '/api/tokens/:id',
  (req, res) => {
    const status =
      store.getTokenStatus(
        req.params.id
      );

    if (!status) {
      return res
        .status(404)
        .json({
          error:
            'Token not found',
        });
    }

    res.json(status);
  }
);

// -----------------------------------------------------------------------------
// Push back
// -----------------------------------------------------------------------------

app.post(
  '/api/tokens/:id/pushback',
  async (req, res) => {
    try {
      const status =
        await store.pushBack(
          req.params.id,
          req.body?.spots || 3
        );

      broadcastCenter(
        status.centerId
      );

      res.json(status);
    } catch (e) {
      res
        .status(400)
        .json({
          error: e.message,
        });
    }
  }
);

// -----------------------------------------------------------------------------
// Reschedule token to next day
// -----------------------------------------------------------------------------

app.post(
  '/api/tokens/:id/reschedule',
  async (req, res) => {
    try {
      const tokenId =
        req.params.id;

      const reason =
        req.body?.reason ||
        'additional_document';

      const result =
        await store.rescheduleToNextDay(
          tokenId,
          reason
        );

      // Update operator/citizen clients
      // with the latest queue state.
      broadcastCenter(
        result.centerId
      );

      // Send a dedicated real-time
      // notification about this token.
      const notification =
        JSON.stringify({
          type: 'token_rescheduled',

          centerId:
            result.centerId,

          centerName:
            result.centerName,

          originalToken:
            result.originalToken,

          priorityToken:
            result.priorityToken,

          fromDate:
            result.fromDate,

          toDate:
            result.toDate,

          priority:
            result.priority,

          reason:
            result.reason,

          message:
            `Your token ${result.originalToken.number} has been rescheduled to ${result.toDate}. Your new priority token is ${result.priorityToken.number}.`,
        });

      wss.clients.forEach(
        (client) => {
          if (
            client.readyState === 1 &&
            client.centerId ===
              result.centerId
          ) {
            client.send(
              notification
            );
          }
        }
      );

      res.json({
        success: true,

        message:
          'Token rescheduled successfully',

        originalToken:
          result.originalToken,

        priorityToken:
          result.priorityToken,

        centerId:
          result.centerId,

        centerName:
          result.centerName,

        fromDate:
          result.fromDate,

        toDate:
          result.toDate,

        priority:
          result.priority,

        reason:
          result.reason,
      });
    } catch (e) {
      res
        .status(400)
        .json({
          success: false,
          error: e.message,
        });
    }
  }
);

// -----------------------------------------------------------------------------
// Operator: advance
// -----------------------------------------------------------------------------

app.post(
  '/api/centers/:id/advance',
  async (req, res) => {
    try {
      const nowServing =
        await store.advance(
          req.params.id
        );

      broadcastCenter(
        req.params.id
      );

      res.json({
        nowServing:
          nowServing
            ? nowServing.number
            : null,
      });
    } catch (e) {
      res
        .status(400)
        .json({
          error: e.message,
        });
    }
  }
);

// -----------------------------------------------------------------------------
// Operator: walk-in
// -----------------------------------------------------------------------------

app.post(
  '/api/centers/:id/walkin',
  async (req, res) => {
    try {
      const {
        token,
        position,
      } =
        await store.issueToken(
          req.params.id,
          {
            service:
              req.body?.service ||
              'general',

            name:
              req.body?.name ||
              'Walk-in',

            source:
              'walkin',
          }
        );

      broadcastCenter(
        req.params.id
      );

      res.json({
        token,
        position,
      });
    } catch (e) {
      res
        .status(400)
        .json({
          error: e.message,
        });
    }
  }
);

// -----------------------------------------------------------------------------
// Start server only after Firestore initialization
// -----------------------------------------------------------------------------

const PORT =
  process.env.PORT || 3000;

async function startServer() {
  try {
    console.log(
      'Connecting QueueSync to Firestore...'
    );

    await store.seed();

    console.log(
      '✅ QueueSync Firestore initialization successful'
    );

    server.listen(
      PORT,
      () => {
        console.log(
          `QueueSync running on http://localhost:${PORT}`
        );

        console.log(
          `  Citizen app: http://localhost:${PORT}/`
        );

        console.log(
          `  Operator:    http://localhost:${PORT}/operator.html`
        );

        console.log(
          `  Gemini AI:   ${
            aiEnabled()
              ? 'ENABLED'
              : 'fallback mode (set GEMINI_API_KEY)'
          }`
        );

        console.log(
          '  Firestore:   CONNECTED'
        );
      }
    );
  } catch (error) {
    console.error(
      '❌ QueueSync failed to initialize'
    );

    console.error(error);

    process.exit(1);
  }
}

startServer();