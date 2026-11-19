/**
 * Comic99 — db-service.js
 * Data layer: Firebase Auth + Firestore + Cloudinary images
 *
 * IMAGE STORAGE ARCHITECTURE (swap-ready):
 *   Phase 1 (now)   → Cloudinary (free 25GB, no credit card)
 *   Phase 2 (scale) → Backblaze B2 + Cloudflare CDN (cheapest at scale)
 *   Phase 3 (own)   → Self-hosted Supabase Storage
 *
 *   To swap storage: change STORAGE_PROVIDER below + update the
 *   uploadToStorage() function. Zero changes needed in HTML files.
 *
 * DATABASE MIGRATION PATH:
 *   Phase 1 → Firestore (now)
 *   Phase 2 → Supabase Cloud  (replace this file)
 *   Phase 3 → Self-hosted Supabase (change one URL line)
 *   All function names stay the same — zero changes in HTML files.
 */

// ============================================================
// FIREBASE CONFIG
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
// CLOUDINARY CONFIG
// ⚠️  REPLACE YOUR_CLOUD_NAME with your actual Cloudinary cloud name
//     (found on your Cloudinary dashboard after signing up at cloudinary.com)
//     Example: if your cloud name is "comic99app", set it below.
//
//     UPLOAD PRESET: Create an UNSIGNED upload preset in Cloudinary:
//     Cloudinary Dashboard → Settings → Upload → Upload presets → Add preset
//     Set signing mode to "Unsigned" → name it "comic99_upload"
// ============================================================
const CLOUDINARY_CONFIG = {
  cloudName: 'ub2tzqxm',              // Cloudinary cloud name
  uploadPreset: 'comic99_upload',     // ← unsigned upload preset name
  apiBase: function() {
    return `https://api.cloudinary.com/v1_1/${this.cloudName}/image/upload`;
  }
};

// ============================================================
// STORAGE PROVIDER — swap here when migrating
// Options: 'cloudinary' | 'backblaze' | 'supabase'
// ============================================================
const STORAGE_PROVIDER = 'cloudinary';

// ============================================================
// CLOUDINARY — image upload with auto-optimization
// ============================================================

/**
 * Upload an image to Cloudinary with automatic optimization.
 * @param {File} file - image file
 * @param {string} folder - cloudinary folder e.g. 'comic99/avatars'
 * @param {object} options - { maxWidth, quality, publicId }
 * @param {function} onProgress - optional callback(percent)
 * @returns {string} - secure CDN URL
 */
async function uploadToCloudinary(file, folder, options = {}, onProgress = null) {
  if (!CLOUDINARY_CONFIG.cloudName || CLOUDINARY_CONFIG.cloudName === 'YOUR_CLOUD_NAME') {
    throw new Error('Cloudinary not configured. Please set your cloud name in db-service.js');
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', CLOUDINARY_CONFIG.uploadPreset);
  formData.append('folder', folder);

  // Auto-optimization transformations
  const transformation = [];
  if (options.maxWidth) transformation.push(`w_${options.maxWidth},c_limit`);
  transformation.push('q_auto:good');   // auto compress
  transformation.push('f_auto');         // auto format (WebP when supported)
  if (transformation.length) {
    formData.append('eager', transformation.join(','));
  }

  if (options.publicId) {
    formData.append('public_id', options.publicId);
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', CLOUDINARY_CONFIG.apiBase(), true);

    if (onProgress) {
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100));
      };
    }

    xhr.onload = () => {
      if (xhr.status === 200) {
        const res = JSON.parse(xhr.responseText);
        // Use eager URL (optimized) if available, else secure_url
        const url = (res.eager && res.eager[0]) ? res.eager[0].secure_url : res.secure_url;
        resolve(url);
      } else {
        reject(new Error('Cloudinary upload failed: ' + xhr.responseText));
      }
    };
    xhr.onerror = () => reject(new Error('Cloudinary upload network error'));
    xhr.send(formData);
  });
}

/**
 * Unified storage upload — routes to correct provider.
 * Swap STORAGE_PROVIDER above to change storage without touching HTML.
 */
async function uploadToStorage(file, folder, options = {}, onProgress = null) {
  if (STORAGE_PROVIDER === 'cloudinary') {
    return uploadToCloudinary(file, folder, options, onProgress);
  }
  // Phase 2: Backblaze B2 + Cloudflare
  // if (STORAGE_PROVIDER === 'backblaze') {
  //   return uploadToBackblaze(file, folder, options, onProgress);
  // }
  // Phase 3: Supabase Storage
  // if (STORAGE_PROVIDER === 'supabase') {
  //   return uploadToSupabase(file, folder, options, onProgress);
  // }
  throw new Error('No storage provider configured');
}

// ============================================================
// FIREBASE SDK — Init
// ============================================================
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const auth    = firebase.auth();
const db      = firebase.firestore();

// ============================================================
// AUTH — Phone OTP
// ============================================================

function _resetRecaptcha(containerId) {
  if (window._recaptchaVerifier) {
    try { window._recaptchaVerifier.clear(); } catch(e) {}
    window._recaptchaVerifier = null;
  }
  const container = document.getElementById(containerId);
  if (container) container.innerHTML = '';
}

async function sendPhoneOTP(phoneNumber, recaptchaContainerId) {
  _resetRecaptcha(recaptchaContainerId);

  window._recaptchaVerifier = new firebase.auth.RecaptchaVerifier(recaptchaContainerId, {
    size: 'invisible',
    callback: () => {}
  });

  try {
    const firebaseUser = auth.currentUser;
    let confirmationResult;

    if (firebaseUser) {
      // User already signed in — link phone to existing account
      const provider = new firebase.auth.PhoneAuthProvider();
      const verificationId = await provider.verifyPhoneNumber(
        phoneNumber,
        window._recaptchaVerifier
      );
      window._phoneVerificationId = verificationId;
      window._confirmationResult = null; // using verificationId flow
    } else {
      // No user signed in — sign in with phone directly
      confirmationResult = await auth.signInWithPhoneNumber(phoneNumber, window._recaptchaVerifier);
      window._confirmationResult = confirmationResult;
      window._phoneVerificationId = null;
    }

    return true;
  } catch (err) {
    _resetRecaptcha(recaptchaContainerId);
    throw err;
  }
}

async function verifyPhoneOTP(code) {
  if (window._phoneVerificationId) {
    // Link phone to existing signed-in user
    const credential = firebase.auth.PhoneAuthProvider.credential(
      window._phoneVerificationId,
      code
    );
    const firebaseUser = auth.currentUser;
    if (!firebaseUser) throw new Error('No user signed in');
    return await firebaseUser.linkWithCredential(credential);
  } else if (window._confirmationResult) {
    return await window._confirmationResult.confirm(code);
  } else {
    throw new Error('No OTP session. Call sendPhoneOTP first.');
  }
}

// ============================================================
// AUTH — Google Sign-In
// Using signInWithRedirect (more reliable on GitHub Pages / static hosts).
// Flow: signInWithGoogle() → Google login page → redirects back →
//       onGoogleRedirectResult() fires on page load → user is signed in.
// ============================================================

async function signInWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.addScope('profile');
  provider.addScope('email');
  // Using popup — works correctly now that OAuth client is configured in
  // Google Cloud Console with web3studiotech.github.io as authorized origin.
  return await auth.signInWithPopup(provider);
}

// No-op kept for compatibility — popup doesn't need a redirect result handler
async function onGoogleRedirectResult(onSuccess, onError) {
  // Not used with popup flow — safe to leave empty
}

// ============================================================
// AUTH — Logout / State
// ============================================================

async function signOut() {
  await auth.signOut();
  try { localStorage.removeItem('c99_user'); } catch(e) {}
}

function onAuthStateChanged(callback) {
  return auth.onAuthStateChanged(callback);
}

function getCurrentUser() {
  return auth.currentUser;
}

// ============================================================
// USER PROFILE — Firestore
// ============================================================

async function saveProfile(uid, profileData) {
  await db.collection('users').doc(uid).set({
    ...profileData,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

async function getProfile(uid) {
  const doc = await db.collection('users').doc(uid).get();
  return doc.exists ? { uid, ...doc.data() } : null;
}

// ============================================================
// PROFILE PICTURE UPLOAD — Cloudinary → Firestore
// ============================================================

/**
 * Upload a profile picture via Cloudinary.
 * Falls back to base64 localStorage if Cloudinary not configured.
 * @param {string} uid
 * @param {File} file
 * @param {function} onProgress
 * @returns {string} - CDN URL or base64 string
 */
async function uploadProfilePicture(uid, file, onProgress) {
  let avatarUrl;

  try {
    avatarUrl = await uploadToStorage(
      file,
      'comic99/avatars',
      { maxWidth: 400, publicId: `avatar_${uid}` },
      onProgress
    );
  } catch (err) {
    // Fallback: base64 localStorage (works without Cloudinary configured)
    console.warn('Cloudinary upload failed, falling back to base64:', err.message);
    avatarUrl = await new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = e => res(e.target.result);
      reader.onerror = rej;
      reader.readAsDataURL(file);
    });
  }

  // Save URL to Firestore profile
  await db.collection('users').doc(uid).set(
    { avatarUrl, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );

  return avatarUrl;
}

// ============================================================
// COSPLAY PHOTO UPLOAD — Cloudinary
// ============================================================

/**
 * Upload a cosplay post photo via Cloudinary.
 * @param {string} uid
 * @param {File} file
 * @param {string} postId
 * @param {function} onProgress
 * @returns {string} - CDN URL
 */
async function uploadCosplayPhoto(uid, file, postId, onProgress) {
  return await uploadToStorage(
    file,
    'comic99/cosplay',
    { maxWidth: 1200, publicId: `cosplay_${uid}_${postId}` },
    onProgress
  );
}

// ============================================================
// COMIC COVER UPLOAD — Cloudinary
// ============================================================

/**
 * Upload a comic series cover image via Cloudinary.
 * @param {string} uid - artist UID
 * @param {string} seriesId
 * @param {File} file
 * @param {function} onProgress
 * @returns {string} - CDN URL
 */
async function uploadComicCover(uid, seriesId, file, onProgress) {
  return await uploadToStorage(
    file,
    'comic99/covers',
    { maxWidth: 600, publicId: `cover_${uid}_${seriesId}` },
    onProgress
  );
}

// ============================================================
// COMIC PAGE UPLOAD — Cloudinary
// ⚠️  NOTICE: Uploaded images are automatically optimized for web
//     delivery. Original files are NOT stored. Keep your originals
//     on your own device.
// ============================================================

/**
 * Upload a single comic page via Cloudinary.
 * Images are auto-compressed and converted to WebP for fast loading.
 * Original files are NOT stored — keep your originals on your device.
 * @param {string} uid - artist UID
 * @param {string} seriesId
 * @param {number} chapterNum
 * @param {number} pageNum
 * @param {File} file
 * @param {function} onProgress
 * @returns {string} - CDN URL
 */
async function uploadComicPage(uid, seriesId, chapterNum, pageNum, file, onProgress) {
  const pageId = `p${String(pageNum).padStart(3,'0')}`;
  return await uploadToStorage(
    file,
    `comic99/pages/${seriesId}/ch${chapterNum}`,
    { maxWidth: 800, publicId: `${uid}_${seriesId}_ch${chapterNum}_${pageId}` },
    onProgress
  );
}

// ============================================================
// COSPLAY POSTS — Firestore
// ============================================================

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

async function getCosplayPosts(limit = 20) {
  const snap = await db.collection('posts')
    .where('type', '==', 'cosplay')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function toggleLikePost(postId, uid) {
  const likeRef = db.collection('likes').doc(`${uid}_${postId}`);
  const likeDoc = await likeRef.get();
  const postRef = db.collection('posts').doc(postId);
  if (likeDoc.exists) {
    await likeRef.delete();
    await postRef.update({ likes: firebase.firestore.FieldValue.increment(-1) });
    return false;
  } else {
    await likeRef.set({ uid, postId, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    await postRef.update({ likes: firebase.firestore.FieldValue.increment(1) });
    return true;
  }
}

// ============================================================
// COMICS — Firestore
// ============================================================

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

async function getForumThreads(category, limit = 20) {
  const snap = await db.collection('forum')
    .where('category', '==', category)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
