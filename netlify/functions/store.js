'use strict';

const { getStore, connectLambda } = require('@netlify/blobs');
const { hasValidSession } = require('./_lib/session');

const STORE_NAME = 'attendance-tracker';

function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(extraHeaders || {}),
    },
    body: JSON.stringify(body),
  };
}

function isValidKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 200 && !/[\s/\\'"]/.test(key);
}

exports.handler = async (event) => {
  let store;
  try {
    // Classic (Lambda-compatible) Netlify Functions handlers don't get the
    // Blobs execution context injected automatically — it has to be wired
    // up explicitly from the incoming event before calling getStore().
    // Without this line every read/write throws MissingBlobsEnvironmentError,
    // which was silently swallowed by the frontend's error handling (hence
    // "nothing saves" even though no error appeared to the user).
    connectLambda(event);
    store = getStore(STORE_NAME);
  } catch (err) {
    console.error('Could not open Netlify Blobs store', err);
    return json(500, { error: 'Storage is not available on this deployment.' });
  }

  const method = event.httpMethod;

  try {
    // ---- READ ----------------------------------------------------------
    if (method === 'GET') {
      const key = event.queryStringParameters && event.queryStringParameters.key;
      if (!isValidKey(key)) return json(400, { error: 'A valid "key" query parameter is required.' });

      const value = await store.get(key, { type: 'text' });
      return json(200, { key, value: value === undefined ? null : value });
    }

    // ---- WRITE / DELETE --------------------------------------------------
    if (method === 'POST' || method === 'DELETE') {
      let payload = {};
      try {
        payload = event.body ? JSON.parse(event.body) : {};
      } catch (err) {
        return json(400, { error: 'Invalid JSON body.' });
      }

      const { key, value } = payload;
      const isProtected = !!payload.protected;

      if (!isValidKey(key)) return json(400, { error: 'A valid "key" field is required.' });

      // Sensitive operations (roster uploads/clears, reconciliation report
      // uploads, and editing/deleting leave or attendance history) are
      // flagged by the client as `protected`. Those are re-verified here
      // against the signed admin session cookie — the browser cannot forge
      // this without first passing the real password check in /admin.
      if (isProtected && !hasValidSession(event)) {
        return json(401, { error: 'Admin authentication required.' });
      }

      const wantsDelete = method === 'DELETE';

      if (wantsDelete) {
        await store.delete(key);
        return json(200, { key, deleted: true });
      }

      if (value === undefined || value === null) {
        return json(400, { error: 'A "value" field is required to set a key.' });
      }

      await store.set(key, String(value));
      return json(200, { key, ok: true });
    }

    return json(405, { error: 'Method not allowed.' });
  } catch (err) {
    console.error('store function error', err);
    return json(500, { error: 'Internal storage error.' });
  }
};
