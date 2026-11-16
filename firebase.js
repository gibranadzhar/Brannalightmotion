import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import admin from 'firebase-admin';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getDatabase } from 'firebase-admin/database';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class FirebaseManager {
  constructor() {
    this.isInitialized = false;
    this.firestore = null;
    this.rtdb = null;
    this.projectId = null;
    this.databaseURL = null;
    this.app = null;
    this.init();
  }

  init(customConfig = null) {
    const existingApps = admin.getApps ? admin.getApps() : [];
    if (existingApps.length > 0) {
      this.app = existingApps[0];
      try { this.firestore = getFirestore(this.app); } catch (e) {}
      try { this.rtdb = getDatabase(this.app); } catch (e) {}
      this.isInitialized = true;
      return;
    }

    let serviceAccount = null;
    let databaseURL = process.env.FIREBASE_DATABASE_URL || null;

    if (customConfig && customConfig.serviceAccount) {
      serviceAccount = customConfig.serviceAccount;
      if (customConfig.databaseURL) databaseURL = customConfig.databaseURL;
    }

    // 1. Check local file candidates
    if (!serviceAccount) {
      const candidateFiles = [
        path.join(__dirname, 'serviceAccountKey.json'),
        path.join(__dirname, 'firebase-service-account.json'),
        path.join(__dirname, 'firebase-key.json'),
        path.join(__dirname, 'data', 'serviceAccountKey.json'),
        path.join(process.cwd(), 'serviceAccountKey.json'),
        path.join('/data', 'serviceAccountKey.json')
      ];

      for (const filePath of candidateFiles) {
        if (fs.existsSync(filePath)) {
          try {
            const raw = fs.readFileSync(filePath, 'utf8');
            serviceAccount = JSON.parse(raw);
            console.log(`🔥 [Firebase] Loading Service Account from: ${filePath}`);
            break;
          } catch (e) {
            console.warn(`⚠️ [Firebase] Failed to parse key file ${filePath}:`, e.message);
          }
        }
      }
    }

    // 2. Check environment variable FIREBASE_SERVICE_ACCOUNT (JSON string or base64)
    if (!serviceAccount && process.env.FIREBASE_SERVICE_ACCOUNT) {
      try {
        const val = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
        if (val.startsWith('{')) {
          serviceAccount = JSON.parse(val);
        } else {
          const decoded = Buffer.from(val, 'base64').toString('utf8');
          serviceAccount = JSON.parse(decoded);
        }
        console.log('🔥 [Firebase] Loading Service Account from FIREBASE_SERVICE_ACCOUNT environment variable');
      } catch (e) {
        console.warn('⚠️ [Firebase] Failed to parse FIREBASE_SERVICE_ACCOUNT env var:', e.message);
      }
    }

    // 3. Check individual environment variables
    if (!serviceAccount && process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
      serviceAccount = {
        project_id: process.env.FIREBASE_PROJECT_ID,
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      };
      console.log('🔥 [Firebase] Loading Service Account from individual FIREBASE_* env variables');
    }

    if (!serviceAccount) {
      console.log('ℹ️ [Firebase] Belum ada kredensial FIREBASE_SERVICE_ACCOUNT. Mode local database aktif.');
      this.isInitialized = false;
      return;
    }

    try {
      this.projectId = serviceAccount.project_id || 'unknown';
      this.databaseURL = databaseURL || (this.projectId ? `https://${this.projectId}-default-rtdb.firebaseio.com/` : null);

      const appConfig = {
        credential: admin.credential.cert(serviceAccount)
      };
      if (this.databaseURL) {
        appConfig.databaseURL = this.databaseURL;
      }

      this.app = admin.initializeApp(appConfig);

      try {
        this.firestore = getFirestore(this.app);
      } catch (e) {
        console.warn('⚠️ [Firebase] Firestore initialization warning:', e.message);
      }

      try {
        if (this.databaseURL) {
          this.rtdb = getDatabase(this.app);
        }
      } catch (e) {
        // Realtime DB optional
      }

      this.isInitialized = true;
      console.log(`✅ [Firebase] Berhasil terhubung ke Cloud Firestore! Project: ${this.projectId}`);
    } catch (err) {
      console.error('❌ [Firebase] Inisialisasi Firebase gagal:', err.message);
      this.isInitialized = false;
    }
  }

  isReady() {
    return this.isInitialized && (this.firestore !== null || this.rtdb !== null);
  }

  /* ==========================================================================
     USERS CLOUD STORAGE (NO MORE LOCAL JSON LOSS!)
     ========================================================================== */
  async saveUsers(users) {
    if (!this.isReady()) return false;
    let saved = false;

    if (this.firestore) {
      try {
        const docRef = this.firestore.collection('app_data').doc('users');
        await docRef.set({
          list: users,
          count: Array.isArray(users) ? users.length : 0,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        saved = true;
      } catch (e) {
        console.warn('⚠️ [Firebase] Gagal menyimpan users ke Firestore:', e.message);
      }
    }

    if (this.rtdb) {
      try {
        await this.rtdb.ref('app_data/users').set({
          list: users,
          updatedAt: Date.now()
        });
        saved = true;
      } catch (e) {}
    }

    return saved;
  }

  async loadUsers() {
    if (!this.isReady()) return null;

    if (this.firestore) {
      try {
        const docRef = this.firestore.collection('app_data').doc('users');
        const snap = await docRef.get();
        if (snap.exists) {
          const data = snap.data();
          if (Array.isArray(data.list)) {
            console.log(`☁️ [Firebase] Berhasil memulihkan ${data.list.length} pengguna dari Cloud Firestore!`);
            return data.list;
          }
        }
      } catch (e) {
        console.warn('⚠️ [Firebase] Gagal memuat users dari Firestore:', e.message);
      }
    }

    if (this.rtdb) {
      try {
        const snap = await this.rtdb.ref('app_data/users').once('value');
        if (snap.exists()) {
          const data = snap.val();
          if (Array.isArray(data.list)) {
            console.log(`☁️ [Firebase] Berhasil memulihkan ${data.list.length} pengguna dari Realtime Database!`);
            return data.list;
          }
        }
      } catch (e) {}
    }

    return null;
  }

  /* ==========================================================================
     CONFIG / SETTINGS CLOUD STORAGE
     ========================================================================== */
  async saveConfig(config) {
    if (!this.isReady()) return false;
    let saved = false;

    if (this.firestore) {
      try {
        const docRef = this.firestore.collection('app_data').doc('config');
        await docRef.set({
          ...config,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        saved = true;
      } catch (e) {
        console.warn('⚠️ [Firebase] Gagal menyimpan config ke Firestore:', e.message);
      }
    }

    if (this.rtdb) {
      try {
        await this.rtdb.ref('app_data/config').set({
          ...config,
          updatedAt: Date.now()
        });
        saved = true;
      } catch (e) {}
    }

    return saved;
  }

  async loadConfig() {
    if (!this.isReady()) return null;

    if (this.firestore) {
      try {
        const docRef = this.firestore.collection('app_data').doc('config');
        const snap = await docRef.get();
        if (snap.exists) {
          console.log('☁️ [Firebase] Konfigurasi server berhasil dipulihkan dari Cloud Firestore!');
          return snap.data();
        }
      } catch (e) {
        console.warn('⚠️ [Firebase] Gagal memuat config dari Firestore:', e.message);
      }
    }

    if (this.rtdb) {
      try {
        const snap = await this.rtdb.ref('app_data/config').once('value');
        if (snap.exists()) {
          console.log('☁️ [Firebase] Konfigurasi server berhasil dipulihkan dari Realtime Database!');
          return snap.val();
        }
      } catch (e) {}
    }

    return null;
  }

  /* ==========================================================================
     LOGS CLOUD STORAGE
     ========================================================================== */
  async saveLogs(logs) {
    if (!this.isReady()) return false;
    if (this.firestore) {
      try {
        const docRef = this.firestore.collection('app_data').doc('logs');
        await docRef.set({
          list: Array.isArray(logs) ? logs.slice(0, 150) : [],
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        return true;
      } catch (e) {}
    }
    return false;
  }

  async loadLogs() {
    if (!this.isReady()) return null;
    if (this.firestore) {
      try {
        const docRef = this.firestore.collection('app_data').doc('logs');
        const snap = await docRef.get();
        if (snap.exists) {
          const data = snap.data();
          if (Array.isArray(data.list)) {
            console.log(`☁️ [Firebase] Memulihkan ${data.list.length} log riwayat dari Cloud Firestore!`);
            return data.list;
          }
        }
      } catch (e) {}
    }
    return null;
  }

  /* ==========================================================================
     TOKENS & APIKEYS CLOUD STORAGE (FOR GOPAY / MERCHANT)
     ========================================================================== */
  async saveTokens(tokens) {
    if (!this.isReady()) return false;
    if (this.firestore) {
      try {
        const docRef = this.firestore.collection('gopay_config').doc('tokens');
        await docRef.set({
          ...tokens,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        return true;
      } catch (e) {}
    }
    return false;
  }

  async loadTokens() {
    if (!this.isReady()) return null;
    if (this.firestore) {
      try {
        const docRef = this.firestore.collection('gopay_config').doc('tokens');
        const snap = await docRef.get();
        if (snap.exists) {
          return snap.data();
        }
      } catch (e) {}
    }
    return null;
  }

  async saveApiKeys(keys) {
    if (!this.isReady()) return false;
    if (this.firestore) {
      try {
        const docRef = this.firestore.collection('gopay_config').doc('apikeys');
        await docRef.set({
          keys,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        return true;
      } catch (e) {}
    }
    return false;
  }

  async loadApiKeys() {
    if (!this.isReady()) return null;
    if (this.firestore) {
      try {
        const docRef = this.firestore.collection('gopay_config').doc('apikeys');
        const snap = await docRef.get();
        if (snap.exists) {
          const data = snap.data();
          if (Array.isArray(data.keys)) {
            return data.keys;
          }
        }
      } catch (e) {}
    }
    return null;
  }
}

const firebaseManager = new FirebaseManager();
export default firebaseManager;
