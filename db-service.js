/**
 * Comic99 — db-service.js
 * Data layer: Firebase (default) or Supabase (swap this file to migrate)
 *
 * To switch to Supabase:
 *   1. Replace this file with db-service-supabase.js
 *   2. Update firebaseConfig with your Supabase URL and anon key
 *   3. All function names stay the same — zero changes in HTML files
 *
 * Firebase services used:
 *   - Firebase Auth  : Phone OTP + Google Sign-In
 *   - Firestore      : User profiles, posts, comics
 *   - Firebase Storage: Profile pictures, comic pages, cosplay photos
 *
 * SETUP:
 *   1. Create a Firebase project at https://console.firebase.google.com
 *   2. Enable: Authentication > Sign-in methods > Phone + Google
 *   3. Enable: Firestore Database (start in test mode)
 *   4. Enable: Storage
 *   5. Replace the config below with your project's config
 *      (Project Settings > Your apps > Firebase SDK snippet > Config)
 */

// ============================================================
// FIREBASE CONFIG — replace with your own config
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyBPCjT0Ash3QF8llsGBjKJWQlVi7GlnGGE",
  authDomain: "comic99-2b964.firebaseapp.com",
  projectId: "comic99-2b964",
  storageBucket: "comic99-2b964.firebasestorage.app",
  messagingSenderId: "639760602278",
  appId: "1:639760602278:web:a107e375ed36e02341d067",
  measurementId: "G-TY6N1243MR"
};

// ============================================================
// FIREBASE SDK — loaded from CDN in each HTML page
// (add these before db-service.js in your <head>)
//
//   <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
//   <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js"></script>
//   <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js"></script>
//   <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-storage-compat.js"></script>
//   <script src="db-service.js"></script>
// ============================================================

// Init Firebase (only once)
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const auth    = firebase.auth();
const db      = firebase.firestore();
const storage = firebase.storage();

// ============================================================
// AUTH — Phone OTP
// ============================================================

/**
 * Step 1: Send OTP to phone number.
 * @param {string} phoneNumber - e.g. "+60123456789"
 * @param {string} recaptchaContainerId - id of a div in the page for reCAPTCHA
 * @returns {firebase.auth.ConfirmationResult}
 */
async function sendPhoneOTP(phoneNumber, recaptchaContainerId) {
  window._recaptchaVerifier = new firebase.auth.RecaptchaVerifier(recaptchaContainerId, {
    size: 'invisible',
    callback: () => {}
  });
  const confirmationResult = await auth.signInWithPhoneNumber(phoneNumber, window._recaptchaVerifier);
  window._confirmationResult = confirmationResult;
  return confirmationResult;
}

/**
 * Step 2: Verify OTP code entered by user.
 * @param {string} code - 6-digit OTP from SMS
 * @returns {firebase.auth.UserCredential}
 */
async function verifyPhoneOTP(code) {
  if (!window._confirmationResult) throw new Error('No OTP session. Call sendPhoneOTP first.');
  const result = await window._confirmationResult.confirm(code);
  return result;
}

// ============================================================
// AUTH — Google Sign-In
// ============================================================

/**
 * Sign in with Google popup.
 * @returns {firebase.auth.UserCredential}
 */
async function signInWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.addScope('profile');
  provider.addScope('email');
  const result = await auth.signInWithPopup(provider);
  return result;
}

// ============================================================
// AUTH — Logout
// ============================================================

async function signOut() {
  await auth.signOut();
  try { localStorage.removeItem('c99_user'); } catch(e) {}
}

// ============================================================
// AUTH — State observer
// ============================================================

/**
 * Subscribe to auth state changes.
 * @param {function} callback - called with Firebase User or null
 */
function onAuthStateChanged(callback) {
  return auth.onAuthStateChanged(callback);
}

/**
 * Get current signed-in user (or null).
 */
function getCurrentUser() {
  return auth.currentUser;
}

// ============================================================
// USER PROFILE — Firestore
// ============================================================

/**
 * Create or update a user profile in Firestore.
 * Called after sign-up or first login.
 * @param {string} uid - Firebase UID
 * @param {object} profileData - { name, role, handle, bio, specialty, privacy, ... }
 */
async function saveProfile(uid, profileData) {
  await db.collection('users').doc(uid).set({
    ...profileData,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

/**
 * Get a user's profile from Firestore.
 * @param {string} uid
 * @returns {object|null}
 */
async function getProfile(uid) {
  const doc = await db.collection('users').doc(uid).get();
  return doc.exists ? { uid, ...doc.data() } : null;
}

// ============================================================
// PROFILE PICTURE — Firebase Storage
// ============================================================

/**
 * Upload a profile picture.
 * @param {string} uid - Firebase UID
 * @param {File} file - image file from <input type="file">
 * @param {function} onProgress - optional callback(percent)
 * @returns {string} - download URL
 */
async function uploadProfilePicture(uid, file, onProgress) {
  const ext = file.name.split('.').pop();
  const ref = storage.ref(`avatars/${uid}/profile.${ext}`);
  const task = ref.put(file);

  if (onProgress) {
    task.on('state_changed', snapshot => {
      const pct = Math.round(snapshot.bytesTransferred / snapshot.totalBytes * 100);
      onProgress(pct);
    });
  }

  await task;
  const url = await ref.getDownloadURL();

  // Save URL to profile
  await db.collection('users').doc(uid).set(
    { avatarUrl: url, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );

  return url;
}

/**
 * Upload a cosplay photo.
 * @param {string} uid - Firebase UID
 * @param {File} file
 * @param {string} postId - unique ID for this post
 * @returns {string} - download URL
 */
async function uploadCosplayPhoto(uid, file, postId) {
  const ext = file.name.split('.').pop();
  const ref = storage.ref(`cosplay/${uid}/${postId}.${ext}`);
  await ref.put(file);
  return await ref.getDownloadURL();
}

/**
 * Upload a comic page.
 * @param {string} uid - artist UID
 * @param {string} seriesId
 * @param {number} chapterNum
 * @param {number} pageNum
 * @param {File} file
 * @returns {string} - download URL
 */
async function uploadComicPage(uid, seriesId, chapterNum, pageNum, file) {
  const ext = file.name.split('.').pop();
  const path = `comics/${uid}/${seriesId}/ch${chapterNum}/p${String(pageNum).padStart(3,'0')}.${ext}`;
  const ref = storage.ref(path);
  await ref.put(file);
  return await ref.getDownloadURL();
}

// ============================================================
// COSPLAY POSTS — Firestore
// ============================================================

/**
 * Create a cosplay post.
 * @param {string} uid
 * @param {object} postData - { imageUrl, caption, tags, privacy }
 */
async function createCosplayPost(uid, postData) {
  const ref = await db.collection('posts').add({
    uid,
    type: 'cosplay',
    ...postData,
    likes: 0,
    comments: 0,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  return ref.id;
}

/**
 * Get recent cosplay posts.
 * @param {number} limit
 * @returns {Array}
 */
async function getCosplayPosts(limit = 20) {
  const snap = await db.collection('posts')
    .where('type', '==', 'cosplay')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Toggle like on a post.
 * @param {string} postId
 * @param {string} uid
 */
async function toggleLikePost(postId, uid) {
  const likeRef = db.collection('likes').doc(`${uid}_${postId}`);
  const likeDoc = await likeRef.get();
  const postRef = db.collection('posts').doc(postId);
  if (likeDoc.exists) {
    await likeRef.delete();
    await postRef.update({ likes: firebase.firestore.FieldValue.increment(-1) });
    return false; // unliked
  } else {
    await likeRef.set({ uid, postId, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    await postRef.update({ likes: firebase.firestore.FieldValue.increment(1) });
    return true; // liked
  }
}

// ============================================================
// COMICS — Firestore
// ============================================================

/**
 * Create a new comic series.
 * @param {string} uid - artist UID
 * @param {object} data - { title, description, genre, artType, watermark }
 */
async function createComicSeries(uid, data) {
  const ref = await db.collection('comics').add({
    uid,
    ...data,
    chapters: 0,
    reads: 0,
    followers: 0,
    status: 'active',
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  return ref.id;
}

/**
 * Get comics by an artist.
 * @param {string} uid
 */
async function getArtistComics(uid) {
  const snap = await db.collection('comics')
    .where('uid', '==', uid)
    .orderBy('createdAt', 'desc')
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ============================================================
// FORUM POSTS — Firestore
// ============================================================

/**
 * Create a forum thread.
 * @param {string} uid
 * @param {object} data - { category, title, body, tags }
 */
async function createForumThread(uid, data) {
  const ref = await db.collection('forum').add({
    uid,
    ...data,
    replies: 0,
    views: 0,
    pinned: false,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  return ref.id;
}

/**
 * Get forum threads by category.
 * @param {string} category
 * @param {number} limit
 */
async function getForumThreads(category, limit = 20) {
  const snap = await db.collection('forum')
    .where('category', '==', category)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ============================================================
// EXPORT (for modules / other pages)
// ============================================================

// If using as ES module, uncomment:
// export { sendPhoneOTP, verifyPhoneOTP, signInWithGoogle, signOut,
//   onAuthStateChanged, getCurrentUser,
//   saveProfile, getProfile,
//   uploadProfilePicture, uploadCosplayPhoto, uploadComicPage,
//   createCosplayPost, getCosplayPosts, toggleLikePost,
//   createComicSeries, getArtistComics,
//   createForumThread, getForumThreads };
