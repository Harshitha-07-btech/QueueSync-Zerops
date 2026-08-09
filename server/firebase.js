const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

let app;
let db;

try {
  let serviceAccount;

  // Zerops / production
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    );
  } 
  // Local development
  else {
    const path = require("path");

    serviceAccount = require(
      path.join(__dirname, "..", "serviceAccountKey.json")
    );
  }

  app = initializeApp({
    credential: cert(serviceAccount),
  });

  db = getFirestore(app);

  console.log("Firestore: CONNECTED");
} catch (error) {
  console.error("Firestore initialization failed:", error);
}

module.exports = {
  app,
  db,
};