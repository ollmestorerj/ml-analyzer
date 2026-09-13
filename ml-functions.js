// ─────────────────────────────────────────────────────────────────────────────
// ADICIONE ESTE CÓDIGO AO SEU functions/index.js EXISTENTE
// Antes de fazer deploy, configure o Client Secret:
//   firebase functions:config:set ml.client_secret="SUA_CHAVE_SECRETA_AQUI"
// ─────────────────────────────────────────────────────────────────────────────

// Se ainda não tiver node-fetch no diretório functions, rode:
// cd functions && npm install node-fetch@2

const fetch = require('node-fetch');

const ML_CLIENT_ID = '3936370948601703';
const ML_REDIRECT  = 'https://www.google.com';
const ML_TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';

// ─── mlTokenExchange ─────────────────────────────────────────────────────────
// Chamada pelo frontend quando o mentorado cola o code OAuth do ML.
// Troca o code por access_token + refresh_token e salva no Firestore.
exports.mlTokenExchange = functions
  .region('southamerica-east1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Faça login primeiro');
    }

    const { code } = data;
    if (!code) {
      throw new functions.https.HttpsError('invalid-argument', 'Código de autorização obrigatório');
    }

    const CLIENT_SECRET = functions.config().ml?.client_secret;
    if (!CLIENT_SECRET) {
      throw new functions.https.HttpsError('internal', 'Client Secret não configurado no servidor');
    }

    // Trocar code por token junto ao ML
    const resp = await fetch(ML_TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     ML_CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code:          code,
        redirect_uri:  ML_REDIRECT,
      }).toString(),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new functions.https.HttpsError('internal', `Erro ML ${resp.status}: ${errText}`);
    }

    const tokenData = await resp.json();

    // Salva no Firestore vinculado ao UID do Firebase do mentorado
    await admin.firestore()
      .collection('users')
      .doc(context.auth.uid)
      .collection('mlTokens')
      .doc('main')
      .set({
        access_token:  tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        user_id:       tokenData.user_id,
        expires_at:    admin.firestore.Timestamp.fromMillis(Date.now() + tokenData.expires_in * 1000),
        updated_at:    admin.firestore.FieldValue.serverTimestamp(),
      });

    return { success: true, user_id: tokenData.user_id };
  });


// ─── mlTokenRefresh ──────────────────────────────────────────────────────────
// Renova o access_token quando ele expira (a cada 6h).
// O frontend pode chamar isso ao detectar token expirado.
exports.mlTokenRefresh = functions
  .region('southamerica-east1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Faça login primeiro');
    }

    const CLIENT_SECRET = functions.config().ml?.client_secret;
    if (!CLIENT_SECRET) {
      throw new functions.https.HttpsError('internal', 'Client Secret não configurado');
    }

    // Busca refresh_token do Firestore
    const snap = await admin.firestore()
      .collection('users')
      .doc(context.auth.uid)
      .collection('mlTokens')
      .doc('main')
      .get();

    if (!snap.exists) {
      throw new functions.https.HttpsError('not-found', 'Token não encontrado. Reconecte sua conta ML.');
    }

    const { refresh_token } = snap.data();

    const resp = await fetch(ML_TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     ML_CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: refresh_token,
      }).toString(),
    });

    if (!resp.ok) {
      throw new functions.https.HttpsError('internal', 'Erro ao renovar token. Reconecte sua conta ML.');
    }

    const tokenData = await resp.json();

    await admin.firestore()
      .collection('users')
      .doc(context.auth.uid)
      .collection('mlTokens')
      .doc('main')
      .update({
        access_token:  tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at:    admin.firestore.Timestamp.fromMillis(Date.now() + tokenData.expires_in * 1000),
        updated_at:    admin.firestore.FieldValue.serverTimestamp(),
      });

    return { success: true };
  });
