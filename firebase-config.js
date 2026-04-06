// ============================================================
// STEP 1: Replace these values with YOUR Firebase project config
// Go to: https://console.firebase.google.com
// Create project → Add web app → Copy the config below
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyCmv4HclcfpagNPnrHqLErOPccu4SQPLDA",
  authDomain: "pilotmanager-b61e9.firebaseapp.com",
  projectId: "pilotmanager-b61e9",
  storageBucket: "pilotmanager-b61e9.firebasestorage.app",
  messagingSenderId: "70053375652",
  appId: "1:70053375652:web:28524d7c4940e562adc031",
  measurementId: "G-D8H9R12L7K"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

// ============================================================
// DATA HELPERS
// ============================================================

// Users collection: { email, name, role: 'admin'|'editor'|'viewer', createdAt }
// Properties collection: { addr, status, tenant, rent, cmha, tenantPortion, cmhaPaid, tenantPaid, ... }
// Payments subcollection: { propertyId, cmhaPaid, tenantPaid, note, date, recordedBy }

async function getCurrentUser() {
  return new Promise((resolve) => {
    auth.onAuthStateChanged(async (user) => {
      if (!user) { resolve(null); return; }
      const doc = await db.collection('users').doc(user.uid).get();
      resolve(doc.exists ? { uid: user.uid, ...doc.data() } : null);
    });
  });
}

async function getProperties() {
  const snap = await db.collection('properties').orderBy('addr').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function saveProperty(data, id = null) {
  if (id) {
    await db.collection('properties').doc(id).update({ ...data, updatedAt: new Date() });
    return id;
  } else {
    const ref = await db.collection('properties').add({ ...data, createdAt: new Date() });
    return ref.id;
  }
}

async function deleteProperty(id) {
  await db.collection('properties').doc(id).delete();
}

async function recordPayment(propertyId, cmhaPaid, tenantPaid, note, recordedBy) {
  const prop = await db.collection('properties').doc(propertyId).get();
  const d = prop.data();
  const newCmhaPaid = (d.cmhaPaid || 0) + cmhaPaid;
  const newTenantPaid = (d.tenantPaid || 0) + tenantPaid;
  const newCollected = newCmhaPaid + newTenantPaid;
  const newBalance = Math.max(0, (d.rent || 0) - newCollected);
  await db.collection('properties').doc(propertyId).update({
    cmhaPaid: newCmhaPaid, tenantPaid: newTenantPaid,
    collected: newCollected, balance: newBalance, updatedAt: new Date()
  });
  await db.collection('payments').add({
    propertyId, cmhaPaid, tenantPaid, note,
    recordedBy, date: new Date()
  });
}

async function getUsers() {
  const snap = await db.collection('users').get();
  return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}

async function updateUserRole(uid, role) {
  await db.collection('users').doc(uid).update({ role });
}

async function seedInitialData(properties) {
  const batch = db.batch();
  properties.forEach(p => {
    const ref = db.collection('properties').doc();
    batch.set(ref, { ...p, createdAt: new Date() });
  });
  await batch.commit();
}
