// In-memory queue store. Maps cleanly to Firestore collections later:
//   centers/{centerId}/tokens/{tokenId}  and  centers/{centerId} (nowServing, stats)
// Swap this module for a Firestore-backed one without touching the API/WebSocket layer.

const AVG_SERVICE_SECONDS = {
  // Rough per-service service times (seconds). Used for wait-time estimates and
  // as the Gemini predictor's baseline / fallback.
  aadhaar_new: 8 * 60,
  aadhaar_update_bio: 5 * 60,
  aadhaar_update_demo: 4 * 60,
  aadhaar_dob: 6 * 60,
  general: 5 * 60,
};

// Document checklists per service (the "Smart Pre-Arrival Checklist" feature).
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

const SERVICE_LABELS = {
  aadhaar_new: 'New Aadhaar Enrolment',
  aadhaar_update_bio: 'Biometric Update (photo/fingerprint)',
  aadhaar_update_demo: 'Demographic Update (name/address)',
  aadhaar_dob: 'Date of Birth Update',
  general: 'General Service',
};

class Center {
  constructor(id, name, location) {
    this.id = id;
    this.name = name;
    this.location = location; // { lat, lng, address }
    this.tokens = []; // ordered queue of active tokens
    this.nowServing = null; // token object currently at the counter
    this.lastTokenNumber = 0;
    this.serviceDurations = []; // observed service durations (seconds) for learning
    this.counters = 1;
  }

  nextTokenNumber() {
    this.lastTokenNumber += 1;
    return this.lastTokenNumber;
  }

  // Average observed service time, falling back to configured baseline.
  avgServiceSeconds(service) {
    if (this.serviceDurations.length >= 3) {
      const sum = this.serviceDurations.reduce((a, b) => a + b, 0);
      return Math.round(sum / this.serviceDurations.length);
    }
    return AVG_SERVICE_SECONDS[service] || AVG_SERVICE_SECONDS.general;
  }

  waitingTokens() {
    return this.tokens.filter((t) => t.status === 'waiting');
  }
}

class QueueStore {
  constructor() {
    this.centers = new Map();
    this.tokenIndex = new Map(); // tokenId -> centerId, for quick lookup
  }

  seed() {
    const demo = [
      {
        id: 'ask-hyd-01',
        name: 'Aadhaar Seva Kendra — Ameerpet, Hyderabad',
        location: { lat: 17.4374, lng: 78.4487, address: 'Ameerpet, Hyderabad' },
      },
      {
        id: 'ask-hyd-02',
        name: 'Aadhaar Seva Kendra — Kukatpally, Hyderabad',
        location: { lat: 17.4849, lng: 78.4138, address: 'Kukatpally, Hyderabad' },
      },
    ];
    for (const c of demo) {
      this.centers.set(c.id, new Center(c.id, c.name, c.location));
    }
    // Pre-fill the first center with a few waiting tokens so the demo looks alive.
    const c = this.centers.get('ask-hyd-01');
    ['aadhaar_update_bio', 'aadhaar_dob', 'general'].forEach((svc, i) => {
      this._createToken(c, { service: svc, name: `Demo Citizen ${i + 1}`, phone: '' });
    });
    return this;
  }

  getCenter(centerId) {
    return this.centers.get(centerId);
  }

  listCenters() {
    return [...this.centers.values()].map((c) => this.centerSummary(c));
  }

  centerSummary(center) {
    const waiting = center.waitingTokens();
    return {
      id: center.id,
      name: center.name,
      location: center.location,
      nowServing: center.nowServing ? center.nowServing.number : null,
      waitingCount: waiting.length,
      avgServiceSeconds: center.avgServiceSeconds('general'),
      counters: center.counters,
    };
  }

  _createToken(center, { service, name, phone, source = 'web' }) {
    const svc = SERVICE_LABELS[service] ? service : 'general';
    const token = {
      id: `${center.id}-${center.nextTokenNumber()}`,
      number: center.lastTokenNumber,
      service: svc,
      serviceLabel: SERVICE_LABELS[svc],
      name: name || 'Citizen',
      phone: phone || '',
      status: 'waiting', // waiting | serving | done | skipped
      source, // web | qr | whatsapp | walkin
      createdAt: Date.now(),
      pushBacks: 0,
      checklist: CHECKLISTS[svc],
    };
    center.tokens.push(token);
    this.tokenIndex.set(token.id, center.id);
    return token;
  }

  // Public: issue a token to a citizen.
  issueToken(centerId, payload) {
    const center = this.getCenter(centerId);
    if (!center) throw new Error('Center not found');
    const token = this._createToken(center, payload);
    return { token, position: this._positionOf(center, token) };
  }

  _positionOf(center, token) {
    // Number of waiting tokens ahead of this one.
    return center.waitingTokens().filter((t) => t.number < token.number).length;
  }

  // Estimated wait for a token: (people ahead) * avg service time / counters.
  estimateWaitSeconds(center, token) {
    const ahead = this._positionOf(center, token);
    const avg = center.avgServiceSeconds(token.service);
    return Math.round((ahead * avg) / Math.max(1, center.counters));
  }

  getTokenStatus(tokenId) {
    const centerId = this.tokenIndex.get(tokenId);
    if (!centerId) return null;
    const center = this.getCenter(centerId);
    const token = center.tokens.find((t) => t.id === tokenId);
    if (!token) return null;
    return {
      token,
      centerId,
      centerName: center.name,
      nowServing: center.nowServing ? center.nowServing.number : null,
      position: this._positionOf(center, token),
      estimateWaitSeconds: this.estimateWaitSeconds(center, token),
    };
  }

  // Operator action: advance to the next waiting token.
  advance(centerId) {
    const center = this.getCenter(centerId);
    if (!center) throw new Error('Center not found');

    // Record service duration of the token we're finishing with (for learning).
    if (center.nowServing && center.nowServing.startedAt) {
      const dur = Math.round((Date.now() - center.nowServing.startedAt) / 1000);
      if (dur > 30 && dur < 60 * 60) center.serviceDurations.push(dur);
      center.nowServing.status = 'done';
    }

    const next = center.waitingTokens().sort((a, b) => a.number - b.number)[0];
    if (next) {
      next.status = 'serving';
      next.startedAt = Date.now();
      center.nowServing = next;
    } else {
      center.nowServing = null;
    }
    return center.nowServing;
  }

  // Citizen isn't present when called: push back by N spots instead of cancelling.
  pushBack(tokenId, spots = 3) {
    const centerId = this.tokenIndex.get(tokenId);
    if (!centerId) throw new Error('Token not found');
    const center = this.getCenter(centerId);
    const token = center.tokens.find((t) => t.id === tokenId);
    if (!token || token.status !== 'waiting') throw new Error('Token not waiting');

    // Move this token behind the next `spots` waiting tokens by renumbering.
    const waiting = center.waitingTokens().sort((a, b) => a.number - b.number);
    const idx = waiting.indexOf(token);
    const target = waiting[Math.min(idx + spots, waiting.length - 1)];
    if (target && target !== token) {
      const tmp = token.number;
      token.number = target.number;
      target.number = tmp;
    }
    token.pushBacks += 1;
    return this.getTokenStatus(tokenId);
  }
}

module.exports = {
  QueueStore,
  SERVICE_LABELS,
  CHECKLISTS,
  AVG_SERVICE_SECONDS,
};
