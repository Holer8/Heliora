/* The worker never reads clinical records or authentication tokens. It only
 * wakes an open app tab, where the authenticated page decrypts and syncs its
 * own IndexedDB outbox. */
self.addEventListener('sync', (event) => {
  if (event.tag !== 'heliora-clinical-outbox') return;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({ type: 'heliora-sync-outbox' });
      }
    })(),
  );
});
