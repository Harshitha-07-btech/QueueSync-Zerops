const { db } = require('./firebase');

// -----------------------------------------------------------------------------
// QueueSync configuration
// -----------------------------------------------------------------------------

const TIME_ZONE = 'Asia/Kolkata';

const AVG_SERVICE_SECONDS = {
  aadhaar_new: 8 * 60,
  aadhaar_update_bio: 5 * 60,
  aadhaar_update_demo: 4 * 60,
  aadhaar_dob: 6 * 60,
  general: 5 * 60,
};

const SERVICE_LABELS = {
  aadhaar_new: 'New Aadhaar Enrolment',
  aadhaar_update_bio: 'Biometric Update (photo/fingerprint)',
  aadhaar_update_demo: 'Demographic Update (name/address)',
  aadhaar_dob: 'Date of Birth Update',
  general: 'General Service',
};

const CHECKLISTS = {
  aadhaar_new: [
    'Proof of Identity (original) — Passport / PAN / Voter ID',
    'Proof of Address (original) — utility bill / bank passbook',
    'One self-attested photocopy of each document',
    'Registered mobile phone (for OTP)',
  ],

  aadhaar_update_bio: [
    'Original Aadhaar card / e-Aadhaar printout',
    'Registered mobile phone (for OTP)',
    'Update fee via UPI / card / cash',
  ],

  aadhaar_update_demo: [
    'Original Aadhaar card',
    'Proof supporting the change (name/address/gender)',
    'One self-attested photocopy',
    'Registered mobile phone (for OTP)',
  ],

  aadhaar_dob: [
    'Original Birth Certificate (or Passport / recognized School Leaving Certificate)',
    'One self-attested photocopy of the certificate',
    'Original Aadhaar card',
    'Registered mobile phone (for OTP)',
  ],

  general: [
    'Original of the primary ID document being updated',
    'Registered mobile phone (for OTP)',
    'Payment method (UPI / card / cash) for any fees',
  ],
};

// -----------------------------------------------------------------------------
// DATE HELPERS
// -----------------------------------------------------------------------------

function getDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const values = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function addDaysToDateKey(dateKey, days) {
  const [year, month, day] =
    dateKey.split('-').map(Number);

  const date = new Date(
    Date.UTC(year, month - 1, day + days)
  );

  return date.toISOString().slice(0, 10);
}

// -----------------------------------------------------------------------------
// FIRESTORE SAFETY
// -----------------------------------------------------------------------------
//
// Firestore does not accept undefined.
// This removes undefined values recursively before writing.
//

function cleanForFirestore(value) {
  if (value === undefined) {
    return null;
  }

  if (value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map(cleanForFirestore);
  }

  if (
    typeof value === 'object' &&
    !(value instanceof Date)
  ) {
    const cleaned = {};

    for (const [key, val] of Object.entries(value)) {
      if (val !== undefined) {
        cleaned[key] =
          cleanForFirestore(val);
      }
    }

    return cleaned;
  }

  return value;
}

// -----------------------------------------------------------------------------
// QUEUE ORDER
// -----------------------------------------------------------------------------
//
// Priority citizens come before normal citizens.
//
// Example:
//
// P1
// P2
// P3
// #1
// #2
// #3
//
// Priority order is based on priorityNumber.
// Normal order is based on token number.
//

function compareQueueOrder(a, b) {
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

// -----------------------------------------------------------------------------
// CENTER
// -----------------------------------------------------------------------------

class Center {
  constructor(id, name, location) {
    this.id = id;
    this.name = name;
    this.location = location;

    this.queueDate =
      getDateKey();

    this.tokens = [];

    this.nowServing = null;

    this.lastTokenNumber = 0;

    this.lastPriorityNumber = 0;

    this.serviceDurations = [];

    this.counters = 1;
  }

  waitingTokens() {
    return this.tokens
      .filter(
        (token) =>
          token.status === 'waiting'
      )
      .sort(compareQueueOrder);
  }

  avgServiceSeconds(service) {
    if (
      this.serviceDurations.length >= 3
    ) {
      const sum =
        this.serviceDurations.reduce(
          (a, b) => a + b,
          0
        );

      return Math.round(
        sum /
          this.serviceDurations.length
      );
    }

    return (
      AVG_SERVICE_SECONDS[service] ||
      AVG_SERVICE_SECONDS.general
    );
  }
}

// -----------------------------------------------------------------------------
// QUEUE STORE
// -----------------------------------------------------------------------------

class QueueStore {
  constructor() {
    this.centers = new Map();

    this.tokenIndex = new Map();

    this.tokenRecords = new Map();

    this.dailyTokenCache = new Map();
  }

  // ===========================================================================
  // INITIALIZE
  // ===========================================================================

  async seed() {
    const demoCenters = [
      {
        id: 'ask-hyd-01',
        name:
          'Aadhaar Seva Kendra — Ameerpet, Hyderabad',
        location: {
          lat: 17.4374,
          lng: 78.4487,
          address:
            'Ameerpet, Hyderabad',
        },
      },

      {
        id: 'ask-hyd-02',
        name:
          'Aadhaar Seva Kendra — Kukatpally, Hyderabad',
        location: {
          lat: 17.4849,
          lng: 78.4138,
          address:
            'Kukatpally, Hyderabad',
        },
      },
    ];

    // -------------------------------------------------------------------------
    // Load existing centers
    // -------------------------------------------------------------------------

    const snapshot =
      await db
        .collection('centers')
        .get();

    for (
      const doc of snapshot.docs
    ) {
      const data =
        doc.data() || {};

      const center =
        new Center(
          doc.id,
          data.name,
          data.location
        );

      this.centers.set(
        center.id,
        center
      );
    }

    // -------------------------------------------------------------------------
    // Create missing demo centers
    // -------------------------------------------------------------------------

    for (
      const demo of demoCenters
    ) {
      if (
        !this.centers.has(
          demo.id
        )
      ) {
        const center =
          new Center(
            demo.id,
            demo.name,
            demo.location
          );

        this.centers.set(
          center.id,
          center
        );

        await db
          .collection('centers')
          .doc(center.id)
          .set(
            cleanForFirestore({
              name: center.name,
              location:
                center.location,
              createdAt: Date.now(),
            })
          );
      }
    }

    // -------------------------------------------------------------------------
    // Load today's queue
    // -------------------------------------------------------------------------

    for (
      const center of
        this.centers.values()
    ) {
      await this._loadTodayQueue(
        center
      );

      await this._loadHistoricalTokenRecords(
        center
      );
    }

    // -------------------------------------------------------------------------
    // Preserve demo data if first center has no tokens
    // -------------------------------------------------------------------------

    const firstCenter =
      this.centers.get(
        'ask-hyd-01'
      );

    if (
      firstCenter &&
      firstCenter.tokens.length === 0
    ) {
      const demoServices = [
        'aadhaar_update_bio',
        'aadhaar_dob',
        'general',
      ];

      for (
        let i = 0;
        i < demoServices.length;
        i++
      ) {
        await this._createToken(
          firstCenter,
          {
            service:
              demoServices[i],
            name:
              `Demo Citizen ${i + 1}`,
            phone: '',
            source: 'web',
          }
        );
      }
    }

    return this;
  }

  // ===========================================================================
  // LOAD TODAY'S QUEUE
  // ===========================================================================

  async _loadTodayQueue(center) {
    await this._loadQueueForDate(
      center,
      getDateKey(),
      true
    );
  }

  // ===========================================================================
  // LOAD DAILY QUEUE
  // ===========================================================================

  async _loadQueueForDate(
    center,
    dateKey,
    makeCurrent = false
  ) {
    const centerRef =
      db
        .collection('centers')
        .doc(center.id);

    const queueRef =
      centerRef
        .collection('dailyQueues')
        .doc(dateKey);

    let queueSnapshot =
      await queueRef.get();

    let queueData =
      queueSnapshot.exists
        ? queueSnapshot.data() || {}
        : {};

    // -------------------------------------------------------------------------
    // Create daily queue if missing
    // -------------------------------------------------------------------------

    if (!queueSnapshot.exists) {
      await queueRef.set(
        cleanForFirestore({
          date: dateKey,

          lastTokenNumber: 0,

          lastPriorityNumber: 0,

          nowServing: null,

          serviceDurations: [],

          counters:
            center.counters || 1,

          migratedLegacyTokens:
            false,

          createdAt: Date.now(),
        })
      );

      queueSnapshot =
        await queueRef.get();

      queueData =
        queueSnapshot.data() || {};
    }

    // -------------------------------------------------------------------------
    // IMPORTANT:
    //
    // Your previous run created the dailyQueues document and then failed while
    // copying old tokens.
    //
    // Therefore we check migratedLegacyTokens separately even when the daily
    // queue document already exists.
    // -------------------------------------------------------------------------

    if (
      queueData.migratedLegacyTokens !==
      true
    ) {
      const legacySnapshot =
        await centerRef
          .collection('tokens')
          .get();

      if (
        legacySnapshot.size > 0
      ) {
        const legacyTokens = [];

        let maxNormalNumber = 0;

        let maxPriorityNumber = 0;

        for (
          const doc of
            legacySnapshot.docs
        ) {
          const data =
            doc.data() || {};

          const token =
            cleanForFirestore({
              ...data,

              id: doc.id,

              queueDate:
                data.queueDate ||
                dateKey,

              priority:
                Boolean(
                  data.priority
                ),

              priorityNumber:
                data.priorityNumber ||
                null,

              createdAt:
                this._convertFirestoreDate(
                  data.createdAt
                ),

              startedAt:
                this._convertFirestoreDate(
                  data.startedAt
                ),

              checklist:
                data.checklist ||
                CHECKLISTS[
                  data.service
                ] ||
                CHECKLISTS.general,
            });

          if (
            token.priority
          ) {
            maxPriorityNumber =
              Math.max(
                maxPriorityNumber,
                Number(
                  token.priorityNumber
                ) || 0
              );
          } else {
            maxNormalNumber =
              Math.max(
                maxNormalNumber,
                Number(
                  token.number
                ) || 0
              );
          }

          legacyTokens.push(
            token
          );
        }

        // ---------------------------------------------------------------------
        // Copy legacy tokens safely
        // ---------------------------------------------------------------------

        await this._writeTokensInBatches(
          queueRef,
          legacyTokens
        );

        await queueRef.set(
          cleanForFirestore({
            lastTokenNumber:
              Math.max(
                Number(
                  queueData.lastTokenNumber
                ) || 0,
                maxNormalNumber
              ),

            lastPriorityNumber:
              Math.max(
                Number(
                  queueData.lastPriorityNumber
                ) || 0,
                maxPriorityNumber
              ),

            migratedLegacyTokens:
              true,

            migratedAt:
              Date.now(),
          }),
          {
            merge: true,
          }
        );
      } else {
        await queueRef.set(
          {
            migratedLegacyTokens:
              true,

            migratedAt:
              Date.now(),
          },
          {
            merge: true,
          }
        );
      }
    }

    // -------------------------------------------------------------------------
    // Reload queue metadata after migration
    // -------------------------------------------------------------------------

    queueSnapshot =
      await queueRef.get();

    queueData =
      queueSnapshot.data() || {};

    // -------------------------------------------------------------------------
    // Load today's tokens
    // -------------------------------------------------------------------------

    const tokenSnapshot =
      await queueRef
        .collection('tokens')
        .get();

    const tokens = [];

    for (
      const doc of
        tokenSnapshot.docs
    ) {
      const data =
        doc.data() || {};

      const token =
        cleanForFirestore({
          ...data,

          id: doc.id,

          queueDate:
            data.queueDate ||
            dateKey,

          createdAt:
            this._convertFirestoreDate(
              data.createdAt
            ),

          startedAt:
            this._convertFirestoreDate(
              data.startedAt
            ),
        });

      tokens.push(token);

      this.tokenIndex.set(
        token.id,
        center.id
      );

      this.tokenRecords.set(
        token.id,
        {
          token,

          centerId:
            center.id,

          queueDate:
            dateKey,
        }
      );
    }

    tokens.sort(
      compareQueueOrder
    );

    this.dailyTokenCache.set(
      `${center.id}|${dateKey}`,
      tokens
    );

    // -------------------------------------------------------------------------
    // Update live center
    // -------------------------------------------------------------------------

    if (makeCurrent) {
      center.queueDate =
        dateKey;

      center.tokens =
        tokens;

      center.lastTokenNumber =
        queueData.lastTokenNumber ||
        0;

      center.lastPriorityNumber =
        queueData.lastPriorityNumber ||
        0;

      center.nowServing =
        queueData.nowServing ||
        null;

      center.serviceDurations =
        queueData.serviceDurations ||
        [];

      center.counters =
        queueData.counters ||
        1;
    }

    return tokens;
  }

  // ===========================================================================
  // LOAD HISTORICAL / FUTURE TOKENS
  // ===========================================================================

  async _loadHistoricalTokenRecords(
    center
  ) {
    const snapshot =
      await db
        .collection('centers')
        .doc(center.id)
        .collection('dailyQueues')
        .get();

    for (
      const queueDoc of
        snapshot.docs
    ) {
      const dateKey =
        queueDoc.id;

      const cacheKey =
        `${center.id}|${dateKey}`;

      if (
        this.dailyTokenCache.has(
          cacheKey
        )
      ) {
        continue;
      }

      const tokenSnapshot =
        await queueDoc.ref
          .collection('tokens')
          .get();

      const tokens = [];

      for (
        const doc of
          tokenSnapshot.docs
      ) {
        const data =
          doc.data() || {};

        const token =
          cleanForFirestore({
            ...data,

            id: doc.id,

            queueDate:
              data.queueDate ||
              dateKey,

            createdAt:
              this._convertFirestoreDate(
                data.createdAt
              ),

            startedAt:
              this._convertFirestoreDate(
                data.startedAt
              ),
          });

        tokens.push(token);

        this.tokenIndex.set(
          token.id,
          center.id
        );

        this.tokenRecords.set(
          token.id,
          {
            token,

            centerId:
              center.id,

            queueDate:
              dateKey,
          }
        );
      }

      tokens.sort(
        compareQueueOrder
      );

      this.dailyTokenCache.set(
        cacheKey,
        tokens
      );
    }
  }

  // ===========================================================================
  // BATCH WRITE
  // ===========================================================================

  async _writeTokensInBatches(
    queueRef,
    tokens
  ) {
    const chunkSize = 450;

    for (
      let i = 0;
      i < tokens.length;
      i += chunkSize
    ) {
      const chunk =
        tokens.slice(
          i,
          i + chunkSize
        );

      const batch =
        db.batch();

      for (
        const token of chunk
      ) {
        const safeToken =
          cleanForFirestore(
            token
          );

        batch.set(
          queueRef
            .collection('tokens')
            .doc(
              token.id
            ),

          safeToken,

          {
            merge: true,
          }
        );
      }

      await batch.commit();
    }
  }

  // ===========================================================================
  // DATE CONVERTER
  // ===========================================================================

  _convertFirestoreDate(
    value
  ) {
    if (
      value === undefined ||
      value === null
    ) {
      return null;
    }

    if (
      typeof value.toMillis ===
      'function'
    ) {
      return value.toMillis();
    }

    return value;
  }

  // ===========================================================================
  // CENTER METHODS
  // ===========================================================================

  getCenter(centerId) {
    return this.centers.get(
      centerId
    );
  }

  listCenters() {
    return [
      ...this.centers.values(),
    ].map(
      (center) =>
        this.centerSummary(
          center
        )
    );
  }

  centerSummary(center) {
    const waiting =
      center.waitingTokens();

    const priorityWaiting =
      waiting.filter(
        (token) =>
          token.priority
      );

    const normalWaiting =
      waiting.filter(
        (token) =>
          !token.priority
      );

    return {
      id: center.id,

      name: center.name,

      location:
        center.location,

      date:
        center.queueDate,

      nowServing:
        center.nowServing
          ? center.nowServing.number
          : null,

      nowServingTokenId:
        center.nowServing
          ? (
              center.nowServing.tokenId ||
              center.nowServing.id ||
              null
            )
          : null,

      waitingCount:
        waiting.length,

      priorityWaitingCount:
        priorityWaiting.length,

      normalWaitingCount:
        normalWaiting.length,

      avgServiceSeconds:
        center.avgServiceSeconds(
          'general'
        ),

      counters:
        center.counters,
    };
  }

  async _ensureTodayIsLoaded(
    center
  ) {
    const today =
      getDateKey();

    if (
      center.queueDate !==
      today
    ) {
      await this._loadQueueForDate(
        center,
        today,
        true
      );

      await this._loadHistoricalTokenRecords(
        center
      );
    }
  }

  // ===========================================================================
  // CREATE TOKEN
  // ===========================================================================

  async _createToken(
    center,
    {
      service,
      name,
      phone,
      source = 'web',
    }
  ) {
    await this._ensureTodayIsLoaded(
      center
    );

    const svc =
      SERVICE_LABELS[service]
        ? service
        : 'general';

    const dateKey =
      center.queueDate;

    const queueRef =
      db
        .collection('centers')
        .doc(center.id)
        .collection('dailyQueues')
        .doc(dateKey);

    const token =
      await db.runTransaction(
        async (transaction) => {
          const snapshot =
            await transaction.get(
              queueRef
            );

          if (
            !snapshot.exists
          ) {
            throw new Error(
              'Daily queue not found'
            );
          }

          const data =
            snapshot.data() || {};

          const nextNumber =
            (data.lastTokenNumber || 0) +
            1;

          const tokenId =
            `${center.id}-${dateKey}-${nextNumber}`;

          const newToken =
            cleanForFirestore({
              id: tokenId,

              number:
                nextNumber,

              service: svc,

              serviceLabel:
                SERVICE_LABELS[svc],

              name:
                name || 'Citizen',

              phone:
                phone || '',

              status:
                'waiting',

              source:
                source || 'web',

              priority: false,

              priorityNumber:
                null,

              carriedForward:
                false,

              originalTokenId:
                null,

              originalQueueDate:
                null,

              queueDate:
                dateKey,

              createdAt:
                Date.now(),

              pushBacks: 0,

              checklist:
                CHECKLISTS[svc],
            });

          transaction.set(
            queueRef
              .collection('tokens')
              .doc(tokenId),

            newToken
          );

          transaction.update(
            queueRef,
            {
              lastTokenNumber:
                nextNumber,
            }
          );

          return newToken;
        }
      );

    center.lastTokenNumber =
      token.number;

    center.tokens.push(
      token
    );

    center.tokens.sort(
      compareQueueOrder
    );

    this.dailyTokenCache.set(
      `${center.id}|${dateKey}`,
      center.tokens
    );

    this.tokenIndex.set(
      token.id,
      center.id
    );

    this.tokenRecords.set(
      token.id,
      {
        token,

        centerId:
          center.id,

        queueDate:
          dateKey,
      }
    );

    return token;
  }

  // ===========================================================================
  // ISSUE TOKEN
  // ===========================================================================

  async issueToken(
    centerId,
    payload
  ) {
    const center =
      this.getCenter(
        centerId
      );

    if (!center) {
      throw new Error(
        'Center not found'
      );
    }

    const token =
      await this._createToken(
        center,
        payload || {}
      );

    return {
      token,

      position:
        this._positionOf(
          center,
          token
        ),
    };
  }

  // ===========================================================================
  // POSITION
  // ===========================================================================

  _positionOf(
    center,
    token
  ) {
    const waiting =
      center.waitingTokens();

    const index =
      waiting.findIndex(
        (item) =>
          item.id === token.id
      );

    return index === -1
      ? 0
      : index;
  }

  // ===========================================================================
  // WAIT ESTIMATION
  // ===========================================================================

  estimateWaitSeconds(
    center,
    token
  ) {
    const position =
      this._positionOf(
        center,
        token
      );

    const avg =
      center.avgServiceSeconds(
        token.service
      );

    return Math.round(
      (
        position * avg
      ) /
      Math.max(
        1,
        center.counters
      )
    );
  }

  // ===========================================================================
  // TOKEN STATUS
  // ===========================================================================

  getTokenStatus(
    tokenId
  ) {
    const centerId =
      this.tokenIndex.get(
        tokenId
      );

    if (!centerId) {
      return null;
    }

    const center =
      this.getCenter(
        centerId
      );

    if (!center) {
      return null;
    }

    const record =
      this.tokenRecords.get(
        tokenId
      );

    if (!record) {
      return null;
    }

    const token =
      record.token;

    if (
      record.queueDate ===
      center.queueDate
    ) {
      return {
        token,

        centerId,

        centerName:
          center.name,

        queueDate:
          record.queueDate,

        nowServing:
          center.nowServing
            ? center.nowServing.number
            : null,

        position:
          this._positionOf(
            center,
            token
          ),

        estimateWaitSeconds:
          this.estimateWaitSeconds(
            center,
            token
          ),
      };
    }

    const tokens =
      this.dailyTokenCache.get(
        `${center.id}|${record.queueDate}`
      ) || [];

    const waiting =
      tokens
        .filter(
          (item) =>
            item.status ===
            'waiting'
        )
        .sort(
          compareQueueOrder
        );

    const position =
      waiting.findIndex(
        (item) =>
          item.id === tokenId
      );

    return {
      token,

      centerId,

      centerName:
        center.name,

      queueDate:
        record.queueDate,

      nowServing: null,

      position:
        position === -1
          ? 0
          : position,

      estimateWaitSeconds:
        token.priority
          ? 0
          : Math.round(
              (
                Math.max(
                  0,
                  position
                ) *
                (
                  AVG_SERVICE_SECONDS[
                    token.service
                  ] ||
                  AVG_SERVICE_SECONDS.general
                )
              ) /
              Math.max(
                1,
                center.counters
              )
            ),
    };
  }

  // ===========================================================================
  // ADVANCE QUEUE
  // ===========================================================================

  async advance(
    centerId
  ) {
    const center =
      this.getCenter(
        centerId
      );

    if (!center) {
      throw new Error(
        'Center not found'
      );
    }

    await this._ensureTodayIsLoaded(
      center
    );

    const dateKey =
      center.queueDate;

    const queueRef =
      db
        .collection('centers')
        .doc(center.id)
        .collection('dailyQueues')
        .doc(dateKey);

    const current =
      center.nowServing;

    const next =
      center.waitingTokens()[0] ||
      null;

    await db.runTransaction(
      async (transaction) => {
        const snapshot =
          await transaction.get(
            queueRef
          );

        if (!snapshot.exists) {
          throw new Error(
            'Daily queue not found'
          );
        }

        const data =
          snapshot.data() || {};

        const durations = [
          ...(data.serviceDurations ||
            center.serviceDurations ||
            []),
        ];

        if (
          current &&
          current.startedAt
        ) {
          const duration =
            Math.round(
              (
                Date.now() -
                current.startedAt
              ) / 1000
            );

          if (
            duration > 30 &&
            duration < 3600
          ) {
            durations.push(
              duration
            );
          }

          transaction.update(
            queueRef
              .collection('tokens')
              .doc(
                current.id
              ),
            {
              status: 'done',
            }
          );
        }

        if (next) {
          transaction.update(
            queueRef
              .collection('tokens')
              .doc(
                next.id
              ),
            {
              status:
                'serving',

              startedAt:
                Date.now(),
            }
          );

          transaction.update(
            queueRef,
            {
              nowServing: {
                number:
                  next.number,

                tokenId:
                  next.id,

                priority:
                  Boolean(
                    next.priority
                  ),
              },

              serviceDurations:
                durations,
            }
          );
        } else {
          transaction.update(
            queueRef,
            {
              nowServing:
                null,

              serviceDurations:
                durations,
            }
          );
        }
      }
    );

    if (current) {
      current.status =
        'done';
    }

    if (next) {
      next.status =
        'serving';

      next.startedAt =
        Date.now();

      center.nowServing =
        next;
    } else {
      center.nowServing =
        null;
    }

    const updated =
      await queueRef.get();

    center.serviceDurations =
      updated.data()
        ?.serviceDurations ||
      center.serviceDurations;

    center.tokens.sort(
      compareQueueOrder
    );

    return center.nowServing;
  }

  // ===========================================================================
  // PUSH BACK — SAME DAY
  // ===========================================================================

  async pushBack(
    tokenId,
    spots = 3
  ) {
    const centerId =
      this.tokenIndex.get(
        tokenId
      );

    if (!centerId) {
      throw new Error(
        'Token not found'
      );
    }

    const center =
      this.getCenter(
        centerId
      );

    await this._ensureTodayIsLoaded(
      center
    );

    const token =
      center.tokens.find(
        (item) =>
          item.id === tokenId
      );

    if (
      !token ||
      token.status !==
        'waiting'
    ) {
      throw new Error(
        'Token not waiting'
      );
    }

    if (token.priority) {
      throw new Error(
        'Priority token cannot be pushed back'
      );
    }

    const waiting =
      center
        .waitingTokens()
        .filter(
          (item) =>
            !item.priority
        );

    const index =
      waiting.indexOf(
        token
      );

    const target =
      waiting[
        Math.min(
          index +
            Math.max(
              1,
              Number(spots) || 3
            ),
          waiting.length - 1
        )
      ];

    if (
      target &&
      target !== token
    ) {
      const tokenRef =
        db
          .collection('centers')
          .doc(center.id)
          .collection('dailyQueues')
          .doc(center.queueDate)
          .collection('tokens');

      const tokenDoc =
        tokenRef.doc(
          token.id
        );

      const targetDoc =
        tokenRef.doc(
          target.id
        );

      await db.runTransaction(
        async (transaction) => {
          await transaction.get(
            tokenDoc
          );

          await transaction.get(
            targetDoc
          );

          transaction.update(
            tokenDoc,
            {
              number:
                target.number,
            }
          );

          transaction.update(
            targetDoc,
            {
              number:
                token.number,
            }
          );
        }
      );

      const oldNumber =
        token.number;

      token.number =
        target.number;

      target.number =
        oldNumber;
    }

    token.pushBacks =
      (token.pushBacks || 0) + 1;

    await db
      .collection('centers')
      .doc(center.id)
      .collection('dailyQueues')
      .doc(center.queueDate)
      .collection('tokens')
      .doc(token.id)
      .update({
        pushBacks:
          token.pushBacks,
      });

    center.tokens.sort(
      compareQueueOrder
    );

    return this.getTokenStatus(
      tokenId
    );
  }

  // ===========================================================================
  // RESCHEDULE TO NEXT DAY WITH PRIORITY
  // ===========================================================================

  async rescheduleToNextDay(
    tokenId,
    reason =
      'additional_document'
  ) {
    const centerId =
      this.tokenIndex.get(
        tokenId
      );

    if (!centerId) {
      throw new Error(
        'Token not found'
      );
    }

    const center =
      this.getCenter(
        centerId
      );

    await this._ensureTodayIsLoaded(
      center
    );

    const today =
      center.queueDate;

    const tomorrow =
      addDaysToDateKey(
        today,
        1
      );

    const token =
      center.tokens.find(
        (item) =>
          item.id === tokenId
      );

    if (!token) {
      throw new Error(
        "Token not found in today's queue"
      );
    }

    if (
      token.status === 'done' ||
      token.status === 'rescheduled'
    ) {
      throw new Error(
        'Token cannot be rescheduled'
      );
    }

    const centerRef =
      db
        .collection('centers')
        .doc(center.id);

    const todayQueue =
      centerRef
        .collection('dailyQueues')
        .doc(today);

    const tomorrowQueue =
      centerRef
        .collection('dailyQueues')
        .doc(tomorrow);

    const todayToken =
      todayQueue
        .collection('tokens')
        .doc(token.id);

    const result =
      await db.runTransaction(
        async (transaction) => {
          const tokenSnapshot =
            await transaction.get(
              todayToken
            );

          const todaySnapshot =
            await transaction.get(
              todayQueue
            );

          const tomorrowSnapshot =
            await transaction.get(
              tomorrowQueue
            );

          if (
            !tokenSnapshot.exists
          ) {
            throw new Error(
              'Token not found in Firestore'
            );
          }

          if (
            !todaySnapshot.exists
          ) {
            throw new Error(
              "Today's queue not found"
            );
          }

          const tomorrowData =
            tomorrowSnapshot.exists
              ? tomorrowSnapshot.data() || {}
              : {};

          const priorityNumber =
            (
              tomorrowData.lastPriorityNumber ||
              0
            ) + 1;

          const priorityTokenId =
            `${center.id}-${tomorrow}-P${priorityNumber}`;

          const priorityToken =
            cleanForFirestore({
              id:
                priorityTokenId,

              number:
                `P${priorityNumber}`,

              service:
                token.service,

              serviceLabel:
                token.serviceLabel,

              name:
                token.name,

              phone:
                token.phone,

              status:
                'waiting',

              source:
                token.source ||
                'web',

              priority:
                true,

              priorityNumber,

              carriedForward:
                true,

              originalTokenId:
                token.id,

              originalQueueDate:
                today,

              queueDate:
                tomorrow,

              createdAt:
                Date.now(),

              pushBacks: 0,

              checklist:
                token.checklist ||
                CHECKLISTS[
                  token.service
                ] ||
                CHECKLISTS.general,

              rescheduleReason:
                reason,
            });

          transaction.update(
            todayToken,
            {
              status:
                'rescheduled',

              rescheduledTo:
                tomorrow,

              rescheduleReason:
                reason,

              rescheduledAt:
                Date.now(),

              rescheduledTokenId:
                priorityTokenId,
            }
          );

          if (
            !tomorrowSnapshot.exists
          ) {
            transaction.set(
              tomorrowQueue,
              {
                date:
                  tomorrow,

                lastTokenNumber:
                  0,

                lastPriorityNumber:
                  priorityNumber,

                nowServing:
                  null,

                serviceDurations:
                  [],

                counters:
                  center.counters ||
                  1,

                createdAt:
                  Date.now(),
              }
            );
          } else {
            transaction.update(
              tomorrowQueue,
              {
                lastPriorityNumber:
                  priorityNumber,
              }
            );
          }

          transaction.set(
            tomorrowQueue
              .collection('tokens')
              .doc(
                priorityTokenId
              ),

            priorityToken
          );

          const todayData =
            todaySnapshot.data() || {};

          if (
            todayData.nowServing &&
            todayData.nowServing.tokenId ===
              token.id
          ) {
            transaction.update(
              todayQueue,
              {
                nowServing:
                  null,
              }
            );
          }

          return priorityToken;
        }
      );

    // -------------------------------------------------------------------------
    // Update local data
    // -------------------------------------------------------------------------

    token.status =
      'rescheduled';

    token.rescheduledTo =
      tomorrow;

    token.rescheduleReason =
      reason;

    token.rescheduledAt =
      Date.now();

    token.rescheduledTokenId =
      result.id;

    if (
      center.nowServing &&
      (
        center.nowServing.id ===
          token.id ||
        center.nowServing.tokenId ===
          token.id
      )
    ) {
      center.nowServing =
        null;
    }

    this.tokenRecords.set(
      token.id,
      {
        token,

        centerId:
          center.id,

        queueDate:
          today,
      }
    );

    // Add tomorrow's priority token
    this.tokenIndex.set(
      result.id,
      center.id
    );

    this.tokenRecords.set(
      result.id,
      {
        token:
          result,

        centerId:
          center.id,

        queueDate:
          tomorrow,
      }
    );

    const tomorrowKey =
      `${center.id}|${tomorrow}`;

    const tomorrowTokens =
      this.dailyTokenCache.get(
        tomorrowKey
      ) || [];

    tomorrowTokens.push(
      result
    );

    tomorrowTokens.sort(
      compareQueueOrder
    );

    this.dailyTokenCache.set(
      tomorrowKey,
      tomorrowTokens
    );

    // Remove from today's active queue
    center.tokens =
      center.tokens.filter(
        (item) =>
          item.id !== token.id
      );

    this.dailyTokenCache.set(
      `${center.id}|${today}`,
      center.tokens
    );

    return {
      originalToken:
        token,

      priorityToken:
        result,

      centerId:
        center.id,

      centerName:
        center.name,

      fromDate:
        today,

      toDate:
        tomorrow,

      priority:
        true,

      reason,
    };
  }
}

// -----------------------------------------------------------------------------
// EXPORTS
// -----------------------------------------------------------------------------

module.exports = {
  QueueStore,
  SERVICE_LABELS,
  CHECKLISTS,
  AVG_SERVICE_SECONDS,
};