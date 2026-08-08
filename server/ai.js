// AI layer for QueueSync.
//
// Two capabilities, both real-Gemini-backed with a local fallback so the app
// runs and demos even before GEMINI_API_KEY is set:
//   1. parseIntent(text)  — multilingual voice/text intake. A citizen says
//      "आधार में जन्मतिथि बदलवानी है" and we return { service, language, name }.
//   2. explainWait(...)   — a short, friendly, localized wait-time message.
//
// Set GEMINI_API_KEY in the environment to enable live calls.

const { SERVICE_LABELS } = require('./queue');

let genAI = null;
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

if (KEY) {
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    genAI = new GoogleGenerativeAI(KEY);
  } catch (e) {
    console.warn('[ai] Gemini SDK unavailable, using fallback:', e.message);
  }
}

const SERVICE_KEYS = Object.keys(SERVICE_LABELS);

// ---- Local heuristic fallback (keyword-based, multilingual-ish) ----

const KEYWORDS = [
  { service: 'aadhaar_dob', words: ['dob', 'date of birth', 'birth date', 'janm', 'जन्म', 'పుట్టిన', 'तारीख'] },
  { service: 'aadhaar_update_bio', words: ['photo', 'fingerprint', 'biometric', 'बायोमेट्रिक', 'फोटो', 'బయోమెట్రిక్'] },
  { service: 'aadhaar_update_demo', words: ['address', 'name', 'पता', 'नाम', 'చిరునామా', 'పేరు'] },
  { service: 'aadhaar_new', words: ['new', 'enrol', 'enroll', 'नया', 'नामांकन', 'కొత్త'] },
];

function detectLanguage(text) {
  if (/[ऀ-ॿ]/.test(text)) return 'hi'; // Devanagari
  if (/[ఀ-౿]/.test(text)) return 'te'; // Telugu
  if (/[஀-௿]/.test(text)) return 'ta'; // Tamil
  return 'en';
}

function fallbackParse(text) {
  const lower = (text || '').toLowerCase();
  let service = 'general';
  for (const k of KEYWORDS) {
    if (k.words.some((w) => lower.includes(w.toLowerCase()))) {
      service = k.service;
      break;
    }
  }
  return {
    service,
    language: detectLanguage(text),
    name: '',
    confidence: service === 'general' ? 0.4 : 0.75,
    source: 'fallback',
  };
}

async function parseIntent(text) {
  if (!genAI) return fallbackParse(text);
  try {
    const model = genAI.getGenerativeModel({ model: MODEL });
    const prompt = `You are the intake assistant for an Aadhaar service center queue system in India.
A citizen wrote (possibly in Hindi, Telugu, Tamil, or English): """${text}"""

Classify their request into exactly one service key from this list:
${SERVICE_KEYS.map((k) => `- ${k}: ${SERVICE_LABELS[k]}`).join('\n')}

Respond with ONLY minified JSON, no markdown:
{"service":"<one key>","language":"<ISO 639-1>","name":"<name if stated else empty>","confidence":<0-1>}`;

    const res = await model.generateContent(prompt);
    const raw = res.response.text().trim().replace(/^```json?|```$/g, '').trim();
    const parsed = JSON.parse(raw);
    if (!SERVICE_KEYS.includes(parsed.service)) parsed.service = 'general';
    return { ...parsed, source: 'gemini' };
  } catch (e) {
    console.warn('[ai] parseIntent fell back:', e.message);
    return fallbackParse(text);
  }
}

function fmtMinutes(seconds) {
  const m = Math.round(seconds / 60);
  if (m <= 0) return 'now';
  return `${m} minute${m === 1 ? '' : 's'}`;
}

async function explainWait({ language, position, estimateWaitSeconds, serviceLabel, centerName }) {
  const mins = fmtMinutes(estimateWaitSeconds);
  const fallback = {
    en: `You are #${position} in line for ${serviceLabel} at ${centerName}. Estimated wait: ${mins}. We'll alert you when you're 5 numbers away — no need to wait at the center.`,
    hi: `${centerName} पर ${serviceLabel} के लिए आपका नंबर ${position} है। अनुमानित प्रतीक्षा: ${mins}। जब आपकी बारी 5 नंबर दूर होगी, हम आपको सूचित करेंगे।`,
    te: `${centerName}లో ${serviceLabel} కోసం మీరు వరుసలో #${position}. అంచనా నిరీక్షణ: ${mins}. మీ వంతు 5 నంబర్ల దూరంలో ఉన్నప్పుడు మేము మీకు తెలియజేస్తాము.`,
  };
  if (!genAI) return fallback[language] || fallback.en;
  try {
    const model = genAI.getGenerativeModel({ model: MODEL });
    const prompt = `Write a short, warm 1-2 sentence status message for a citizen waiting in an Aadhaar center queue.
Language: ${language || 'en'}. They are position #${position} for "${serviceLabel}" at ${centerName}, estimated wait ${mins}.
Reassure them they can wait from home and will be alerted 5 numbers before their turn. Plain text only.`;
    const res = await model.generateContent(prompt);
    return res.response.text().trim();
  } catch (e) {
    console.warn('[ai] explainWait fell back:', e.message);
    return fallback[language] || fallback.en;
  }
}

module.exports = { parseIntent, explainWait, detectLanguage, aiEnabled: () => !!genAI };
