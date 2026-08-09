const path = require('path');
const fs = require('fs');

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.log('Using Firebase credentials from environment variable');

  serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  );
} else {
  const localKeyPath = path.join(
    __dirname,
    '..',
    'serviceAccountKey.json'
  );

  if (!fs.existsSync(localKeyPath)) {
    throw new Error(
      'Firebase service account credentials not found'
    );
  }

  console.log('Using local serviceAccountKey.json');

  serviceAccount = require(localKeyPath);
}

const app = initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore(app);

module.exports = {
  app,
  db,
};