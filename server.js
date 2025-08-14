// server.js

const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

const app = express();

// --- IMPORTANT: Service Account Configuration ---
// You must get your service account key JSON from Firebase Console
// Project settings > Service accounts > Generate new private key
// DO NOT COMMIT THIS FILE TO GITHUB.
// Instead, use Render's Environment Variables.
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "YOUR_DATABASE_URL" // Replace with your actual Database URL
});

const db = admin.database();

// --- Middleware ---
app.use(cors()); // Allow requests from your frontend
app.use(express.json()); // Allow the server to parse JSON request bodies

// Authentication Middleware to protect routes
const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(403).send('Unauthorized: No token provided.');
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    // Verify the token using the Firebase Admin SDK
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken; // Add the decoded user info to the request object
    next();
  } catch (error) {
    console.error('Error while verifying Firebase ID token:', error);
    res.status(403).send('Unauthorized: Invalid token.');
  }
};


// --- API Routes ---
// All sensitive routes are protected by the verifyFirebaseToken middleware.

app.post("/api/create-code", verifyFirebaseToken, async (req, res) => {
  const uid = req.user.uid; // Get UID from the verified token
  const amount = Number(req.body.amount);

  if (!amount || amount <= 0 || !Number.isInteger(amount)) {
    return res.status(400).json({ error: "A valid, positive amount is required." });
  }

  const userBalanceRef = db.ref(`/users/${uid}/balance`);
  
  try {
    const result = await userBalanceRef.transaction(currentBalance => {
      if (currentBalance < amount) return; // Abort
      return currentBalance - amount;
    });

    if (!result.committed) {
      return res.status(400).json({ error: "Insufficient balance." });
    }

    const code = "LBX-" + Math.random().toString(36).substring(2, 10).toUpperCase();
    await db.ref(`/codes/${code}`).set({ amount: amount, createdBy: uid, isUsed: false });

    res.status(200).json({ code: code });
  } catch (error) {
    console.error("Error creating code:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});


app.post("/api/redeem-code", verifyFirebaseToken, async (req, res) => {
    const uid = req.user.uid;
    const code = req.body.code.trim().toUpperCase();

    // ... (Add the redeem code logic from the previous answer here, using res.status().json() to send responses)
    res.status(501).json({ error: "Not implemented yet." });
});


app.post("/api/spin-wheel", verifyFirebaseToken, async (req, res) => {
    const uid = req.user.uid;
    const bet = Number(req.body.bet);
    
    // ... (Add the spin wheel logic from the previous answer here, using res.status().json() to send responses)
    res.status(501).json({ error: "Not implemented yet." });
});


// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
