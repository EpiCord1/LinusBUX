import { getDatabase, ref, update } from "firebase/database";
import { getAuth } from "firebase/auth";

// Call this function when the user clicks "Start Heist"
async function startHeist() {
    const auth = getAuth();
    const user = auth.currentUser;

    if (!user) {
        console.error("User not logged in.");
        return;
    }

    const uid = user.uid;
    const db = getDatabase();

    // 1. Define the data to be written to multiple paths in a single update.
    const updates = {};
    const heistCost = 100;
    
    // Path 1: Update the user's balance
    // We assume the user's current balance is already known by the client
    // and is stored in a variable, e.g., `currentUserBalance`.
    // The security rule will verify the deduction server-side.
    updates[`/users/${uid}/balance`] = currentUserBalance - heistCost;

    // Path 2: Change the bank status to "in progress"
    updates['/linusHub/bank/status'] = 'in progress';

    // Path 3: Add the user to the heist players list
    updates[`/linusHub/bankHeist/players/${uid}`] = {
        status: 'playing',
        payout: 0
    };

    // 2. Perform the atomic, multi-location update
    try {
        await update(ref(db), updates);
        console.log("Heist started successfully!");
        // Update your UI to reflect the new state (e.g., show heist countdown)
        return { success: true, message: "Heist initiated successfully. Good luck!" };
    } catch (error) {
        console.error("Failed to start heist:", error);
        // The error will be "permission_denied" if the security rules rejected the write
        // (e.g., another heist is in progress, or balance is too low).
        alert("Failed to start heist. Check your balance or if another heist is in progress.");
        return { success: false, message: "Heist could not be started." };
    }
}
